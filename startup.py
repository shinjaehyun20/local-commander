"""Current-user login recovery for the approved Local Commander MCP service; no model calls."""
import argparse, ctypes, datetime, hashlib, json, os, pathlib, socket, subprocess, time, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
STATE = pathlib.Path(os.environ.get('LOCAL_COMMANDER_STATE') or (pathlib.Path(os.environ.get('LOCALAPPDATA', HERE)) / 'local-commander'))
SERVICE_NAME = 'local-commander'
PS = str(pathlib.Path(os.environ.get('SystemRoot', 'C:/Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe')

def read_json(file):
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8-sig'))

def identity(record, process, marker):
    """A missing or reused PID is stale; a live owned process must be preserved."""
    if process is None:
        return 'stale'
    command = process.get('commandLine')
    created = process.get('createdAt')
    if not command or not created:
        return 'unknown'
    stamp = datetime.datetime.fromisoformat(record['startedAt'].replace('Z', '+00:00'))
    actual = datetime.datetime.fromisoformat(created.replace('Z', '+00:00'))
    # The runtime timestamp is written shortly after process creation.
    if not -120 <= (actual - stamp).total_seconds() <= 5:
        return 'stale'
    return 'owned' if marker.lower().replace('\\', '/') in command.lower().replace('\\', '/') else 'stale'

def inspect_process(pid):
    if not isinstance(pid, int) or pid <= 0:
        raise ValueError('Invalid recorded PID')
    script = (f'$p=Get-CimInstance Win32_Process -Filter "ProcessId={pid}"; '
              'if($p){@{commandLine=$p.CommandLine;createdAt=$p.CreationDate.ToUniversalTime().ToString("o")}|ConvertTo-Json -Compress}')
    result = subprocess.run([PS, '-NoProfile', '-NonInteractive', '-Command', script], capture_output=True, text=True, timeout=15, creationflags=0x08000000)
    if result.returncode:
        raise RuntimeError('Process identity lookup failed')
    return json.loads(result.stdout) if result.stdout.strip() else None

def health(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{int(port)}/health', timeout=3) as response:
            return json.load(response)
    except Exception:
        return None

def occupied(port):
    with socket.socket() as sock:
        sock.settimeout(1)
        return sock.connect_ex(('127.0.0.1', int(port))) == 0

def archive_stale(file, original):
    """Archive only the unchanged runtime; never modify auth/session files."""
    file = pathlib.Path(file)
    if file.read_bytes() != original:
        raise RuntimeError('Runtime changed during recovery')
    archive = file.with_name(file.name + '.stale-' + hashlib.sha256(original).hexdigest()[:16])
    if archive.exists():
        raise RuntimeError('Stale archive already exists; inspect before recovery')
    file.rename(archive)
    return archive

def prepare_runtime(file, port, service, workspace_id, marker):
    current = health(port)
    if current is not None:
        return 'running' if current.get('service') == service and current.get('workspaceId') == workspace_id else 'port-conflict'
    if occupied(port):
        return 'port-conflict'
    file = pathlib.Path(file)
    if not file.exists():
        return 'stopped'
    original = file.read_bytes()
    record = json.loads(original)
    if record.get('workspaceId') != workspace_id or record.get('port') != port:
        return 'identity-conflict'
    observed = identity(record, inspect_process(record.get('pid')), marker)
    if observed == 'stale':
        archive_stale(file, original)
        return 'stopped'
    return 'unhealthy-owned' if observed == 'owned' else 'identity-unconfirmed'

def companion_ready(config):
    if not config.get('companionState') or not config.get('companionWorkspaceId'):
        return False
    file = pathlib.Path(config['companionState']) / 'tunnels' / (config['companionWorkspaceId'] + '.json')
    if not file.exists():
        return False
    tunnel = read_json(file)
    if tunnel.get('preference') == 'relay':
        return bool(tunnel.get('relayUrl')) and pathlib.Path(tunnel.get('relaySecretFile', '')).is_file()
    credential = pathlib.Path(os.environ.get('TUNNEL_CRED_FILE') or (pathlib.Path.home() / '.cloudflared' / (str(tunnel.get('tunnelId', '')) + '.json')))
    return tunnel.get('preference') == 'named' and bool(tunnel.get('tunnelName')) and bool(tunnel.get('hostname')) and credential.is_file()

def commander_ready(config_path=None):
    config = read_json(config_path or HERE / 'config.json')
    tunnel = config.get('tunnel', {})
    return (tunnel.get('mode') == 'named' and bool(tunnel.get('name')) and bool(tunnel.get('publicUrl'))) or (tunnel.get('mode') == 'relay' and bool(tunnel.get('publicUrl')) and pathlib.Path(tunnel.get('secretFile', '')).is_file())

def recover(config, commander_only=False, allow_quick=False):
    status = {}
    services = [
        ('commander', STATE / 'runtime.json', 48781, SERVICE_NAME, config['commanderWorkspaceId'], 'launch.mjs', commander_ready(config.get('commanderConfig'))),
    ]
    if not commander_only and config.get('companionRoot') and config.get('companionState') and config.get('companionWorkspaceId'):
        services.append(('companion', pathlib.Path(config['companionState']) / 'runtime' / (config['companionWorkspaceId'] + '.json'), int(config.get('companionPort', 48765)), config.get('companionService', 'companion-bridge'), config['companionWorkspaceId'], str(pathlib.Path(config['companionRoot']) / 'dist/cli/index.js').replace('\\', '/'), companion_ready(config)))
    for name, file, port, service, wid, marker, ready in services:
        try:
            observed = prepare_runtime(file, port, service, wid, marker)
            if observed != 'stopped':
                status[name] = observed
                continue
            if not ready and not (name == 'commander' and allow_quick):
                status[name] = 'waiting-for-fixed-domain'
                continue
            runtime_config = pathlib.Path(config.get('commanderConfig') or HERE / 'config.json')
            arguments = [str(HERE / 'launch.mjs'), '--config', str(runtime_config)]
            if read_json(runtime_config).get('tunnel', {}).get('transport') == 'websocket':
                arguments.append('--socket')
            spec = {'executable': config['node'], 'args': arguments, 'cwd': str(HERE)}
            import base64
            encoded = base64.b64encode(json.dumps(spec, ensure_ascii=True).encode()).decode()
            STATE.mkdir(parents=True, exist_ok=True)
            with (STATE / 'service.out.log').open('ab') as out, (STATE / 'service.err.log').open('ab') as err:
                subprocess.Popen([config['python'], str(HERE / 'supervise.py'), encoded], cwd=HERE, stdin=subprocess.DEVNULL, stdout=out, stderr=err, creationflags=0x08000000)
            # Prevent duplicate launch while the tunnel is being established.
            for _ in range(60):
                if file.exists():
                    break
                time.sleep(1)
            if not file.exists():
                raise RuntimeError('Commander startup not confirmed')
            current = health(port)
            status[name] = 'restarted' if current and current.get('workspaceId') == wid and current.get('service') == service else 'startup-not-confirmed'
        except Exception as exc:
            # No command output, runtime tokens or credentials in the public status.
            status[name] = 'recovery-error:' + type(exc).__name__
    return status

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--watch', action='store_true')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--commander-check', action='store_true')
    parser.add_argument('--commander-start', action='store_true')
    args = parser.parse_args()
    if args.commander_check:
        config = read_json(HERE / 'startup-config.json')
        result = prepare_runtime(STATE / 'runtime.json', 48781, SERVICE_NAME, config['commanderWorkspaceId'], 'launch.mjs')
        print(result)
        return 0 if result in ('running', 'stopped') else 1
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    mutex = kernel.CreateMutexW(None, False, 'Local\\LocalCommanderRecovery-' + hashlib.sha256(str(HERE).lower().encode()).hexdigest()[:20])
    if not mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle(mutex)
        print('Recovery is already running')
        return 0
    stop_file = STATE / 'startup-stop.request'
    if args.watch:
        stop_file.unlink(missing_ok=True)
    try:
        while True:
            config = read_json(HERE / 'startup-config.json')
            status = recover(config, commander_only=args.commander_start, allow_quick=args.commander_start)
            STATE.mkdir(parents=True, exist_ok=True)
            receipt = {'pid': os.getpid(), 'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'services': status}
            target = STATE / 'startup-status.json'
            temp = target.with_suffix('.tmp')
            temp.write_text(json.dumps(receipt, ensure_ascii=True, indent=2), encoding='utf-8')
            temp.replace(target)
            if not args.watch:
                print(json.dumps(status, ensure_ascii=True))
                return 1 if any('error' in value or 'unconfirmed' in value or 'not-confirmed' in value or 'conflict' in value for value in status.values()) else 0
            # A failed start gets a bounded retry, without an endless rapid spawn loop.
            interval = 300 if any('error' in value or 'unconfirmed' in value or 'not-confirmed' in value for value in status.values()) else 30
            for _ in range(interval):
                if stop_file.exists():
                    stop_file.unlink(missing_ok=True)
                    return 0
                time.sleep(1)
    finally:
        kernel.CloseHandle(mutex)

if __name__ == '__main__':
    raise SystemExit(main())
