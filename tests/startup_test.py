import importlib.util, json, pathlib, tempfile, unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('startup', pathlib.Path(__file__).resolve().parents[1] / 'startup.py')
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)

class RecoveryTests(unittest.TestCase):
    def test_commander_only_does_not_inspect_companion(self):
        with patch.object(startup, 'commander_ready', return_value=True), patch.object(startup, 'companion_ready', side_effect=AssertionError('unrelated service')), patch.object(startup, 'prepare_runtime', return_value='running'):
            self.assertEqual(startup.recover({'commanderWorkspaceId':'fixture'}, commander_only=True), {'commander':'running'})
    def record(self):
        return {'pid': 456, 'port': 48781, 'workspaceId': 'fixture', 'startedAt': '2026-10-13T03:00:00Z'}
    def process(self):
        return {'commandLine': r'node C:\owned\launch.mjs', 'createdAt': '2026-10-13T02:59:59+00:00'}
    def test_missing_pid_is_stale(self):
        self.assertEqual(startup.identity(self.record(), None, 'launch.mjs'), 'stale')
    def test_reused_pid_is_stale(self):
        process = self.process(); process['createdAt'] = '2026-10-13T04:00:00+00:00'
        self.assertEqual(startup.identity(self.record(), process, 'launch.mjs'), 'stale')
    def test_unrelated_pid_is_stale_without_termination(self):
        process = self.process(); process['commandLine'] = 'unrelated-editor.exe'
        self.assertEqual(startup.identity(self.record(), process, 'launch.mjs'), 'stale')
    def test_unreadable_identity_is_preserved(self):
        self.assertEqual(startup.identity(self.record(), {'commandLine': None}, 'launch.mjs'), 'unknown')
    def test_windows_path_normalization(self):
        self.assertEqual(startup.identity(self.record(), self.process(), 'C:/owned/launch.mjs'), 'owned')
    def test_stale_archive_preserves_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            file = pathlib.Path(folder) / 'runtime.json'; original = json.dumps(self.record()).encode(); file.write_bytes(original)
            archived = startup.archive_stale(file, original)
            self.assertFalse(file.exists()); self.assertEqual(archived.read_bytes(), original)
    def test_changed_record_refuses_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            file = pathlib.Path(folder) / 'runtime.json'; file.write_bytes(b'new owner')
            with self.assertRaises(RuntimeError): startup.archive_stale(file, b'old owner')
            self.assertEqual(file.read_bytes(), b'new owner')
    @patch.object(startup, 'occupied', return_value=False)
    @patch.object(startup, 'health', return_value=None)
    @patch.object(startup, 'inspect_process')
    def test_live_unhealthy_owner_cannot_be_duplicated(self, inspect, health, occupied):
        inspect.return_value = self.process()
        with tempfile.TemporaryDirectory() as folder:
            file = pathlib.Path(folder) / 'runtime.json'; file.write_text(json.dumps(self.record()))
            self.assertEqual(startup.prepare_runtime(file, 48781, 'fixture-service', 'fixture', 'launch.mjs'), 'unhealthy-owned')
            self.assertTrue(file.exists())
    @patch.object(startup, 'health', return_value={'service': 'other', 'workspaceId': 'other'})
    def test_port_conflict_preserves_record(self, health):
        self.assertEqual(startup.prepare_runtime('unused', 48781, 'fixture-service', 'fixture', 'launch.mjs'), 'port-conflict')
    def test_stopped_websocket_service_triggers_supervised_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            state_dir = pathlib.Path(folder)
            cfg_file = state_dir / 'config.json'
            cfg_file.write_text(json.dumps({'tunnel': {'mode': 'relay', 'transport': 'websocket', 'publicUrl': 'https://relay.example.com', 'secretFile': str(cfg_file)}}), encoding='utf-8')
            runtime_file = state_dir / 'runtime.json'
            spawned = []
            def fake_popen(cmd, **kwargs):
                spawned.append(cmd)
                runtime_file.write_text(json.dumps(self.record()), encoding='utf-8')
                class DummyProc: pass
                return DummyProc()
            with patch.object(startup, 'STATE', state_dir), \
                 patch.object(startup, 'prepare_runtime', return_value='stopped'), \
                 patch.object(startup, 'health', return_value={'service': startup.SERVICE_NAME, 'workspaceId': 'fixture'}), \
                 patch('subprocess.Popen', side_effect=fake_popen):
                res = startup.recover({'commanderWorkspaceId': 'fixture', 'commanderConfig': str(cfg_file), 'node': 'node', 'python': 'python'}, commander_only=True)
                self.assertEqual(res, {'commander': 'restarted'})
                self.assertEqual(len(spawned), 1)
                self.assertIn('supervise.py', spawned[0][1])

if __name__ == '__main__': unittest.main()
