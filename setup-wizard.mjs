#!/usr/bin/env node
/**
 * Local Commander — Interactive & Deterministic Setup Wizard (`npm run setup`)
 * Initializes config.json, optional WebSocket relay secret, startup-config.json,
 * and ready-to-paste MCP client configuration snippets (Claude Desktop, Cursor, Codex CLI).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from './vendor-auth/config/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function computeWorkspaceId(readRoots) {
  const normalized = readRoots.map((r) => path.resolve(r));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 12);
}

export function buildClientSnippets({
  serverPath = path.join(here, 'server.mjs'),
  configPath = path.join(here, 'config.json'),
} = {}) {
  const normServer = path.resolve(serverPath).replace(/\\/g, '/');
  const normConfig = path.resolve(configPath).replace(/\\/g, '/');

  const mcpObject = {
    mcpServers: {
      'local-commander': {
        command: 'node',
        args: [normServer, '--config', normConfig],
      },
    },
  };

  const codexToml = [
    '[mcp_servers.local-commander]',
    'command = "node"',
    `args = ["${normServer}", "--config", "${normConfig}"]`,
  ].join('\n');

  return {
    claudeDesktop: JSON.stringify(mcpObject, null, 2),
    cursor: JSON.stringify(mcpObject, null, 2),
    codexToml,
  };
}

export function runSetupWizard({
  configPath = path.join(here, 'config.json'),
  stateDir = getStateDir(),
  readRoots = [path.join(here, 'workspace')],
  writeRoots = [],
  allowShell = false,
  allowRemoteWrites = false,
  python = 'python',
  mode = 'local',
  publicUrl = '',
  writeStartupConfig = false,
  startupConfigPath = path.join(here, 'startup-config.json'),
  createMissingDirs = true,
} = {}) {
  const resolvedConfigPath = path.resolve(configPath);
  const existing = readJsonIfExists(resolvedConfigPath) || {};

  const resolvedReadRoots = (readRoots.length ? readRoots : [path.join(here, 'workspace')]).map((r) =>
    path.resolve(r)
  );
  const resolvedWriteRoots = writeRoots.map((r) => path.resolve(r));

  if (createMissingDirs) {
    for (const dir of [...resolvedReadRoots, ...resolvedWriteRoots]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  for (const dir of [...resolvedReadRoots, ...resolvedWriteRoots]) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`Configured root directory does not exist: ${dir}`);
    }
  }

  const canonicalReadRoots = resolvedReadRoots.map((dir) => fs.realpathSync.native(dir));
  const canonicalWriteRoots = resolvedWriteRoots.map((dir) => fs.realpathSync.native(dir));

  const workspaceId =
    existing.workspaceId && /^[a-f0-9]{12}$/.test(existing.workspaceId)
      ? existing.workspaceId
      : computeWorkspaceId(canonicalReadRoots);

  const config = {
    name: existing.name || 'Local Commander',
    workspaceId,
    readRoots: canonicalReadRoots,
    writeRoots: canonicalWriteRoots,
    allowShell: Boolean(allowShell),
    allowRemoteWrites: Boolean(allowRemoteWrites),
    python: python || existing.python || 'python',
  };

  let secretFile = null;
  if (mode === 'relay') {
    if (!publicUrl) {
      throw new Error('Relay mode requires --public-url <https://your-relay.example.com>');
    }
    const parsed = new URL(publicUrl);
    if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('publicUrl must be an HTTPS origin without path, query, or hash');
    }
    ensureDir(stateDir);
    secretFile = path.join(stateDir, 'relay.secret');
    if (!fs.existsSync(secretFile) || fs.readFileSync(secretFile, 'utf8').trim().length < 40) {
      const secret = randomBytes(32).toString('hex');
      fs.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
    }
    config.tunnel = {
      mode: 'relay',
      transport: 'websocket',
      publicUrl: parsed.origin,
      secretFile,
    };
  } else if (mode === 'quick') {
    config.tunnel = {
      mode: 'quick',
    };
  } else if (existing.tunnel && mode === 'preserve') {
    config.tunnel = existing.tunnel;
  }

  writeSecureJson(resolvedConfigPath, config);

  let resolvedStartupConfigPath = null;
  if (writeStartupConfig) {
    resolvedStartupConfigPath = path.resolve(startupConfigPath);
    writeSecureJson(resolvedStartupConfigPath, {
      commanderWorkspaceId: workspaceId,
      commanderConfig: resolvedConfigPath,
      node: process.execPath,
      python: config.python,
    });
  }

  const snippets = buildClientSnippets({
    serverPath: path.join(here, 'server.mjs'),
    configPath: resolvedConfigPath,
  });

  return {
    configPath: resolvedConfigPath,
    config,
    secretFile,
    startupConfigPath: resolvedStartupConfigPath,
    snippets,
  };
}

function parseCliArgs(argv) {
  const readRoots = [];
  const writeRoots = [];
  const opts = {
    nonInteractive: false,
    configPath: path.join(here, 'config.json'),
    allowShell: false,
    allowRemoteWrites: false,
    python: process.env.COMMANDER_PYTHON || 'python',
    mode: 'local',
    publicUrl: '',
    writeStartupConfig: false,
    printClients: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--non-interactive' || arg === '-y') opts.nonInteractive = true;
    else if (arg === '--config') opts.configPath = argv[++i];
    else if (arg === '--read-root') readRoots.push(argv[++i]);
    else if (arg === '--write-root') writeRoots.push(argv[++i]);
    else if (arg === '--allow-shell') opts.allowShell = true;
    else if (arg === '--allow-remote-writes') opts.allowRemoteWrites = true;
    else if (arg === '--python') opts.python = argv[++i];
    else if (arg === '--mode') opts.mode = argv[++i];
    else if (arg === '--public-url') opts.publicUrl = argv[++i];
    else if (arg === '--write-startup-config') opts.writeStartupConfig = true;
    else if (arg === '--print-clients') opts.printClients = true;
  }

  if (readRoots.length) opts.readRoots = readRoots;
  if (writeRoots.length) opts.writeRoots = writeRoots;
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  if (!opts.nonInteractive && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const defaultWorkspace = path.join(here, 'workspace');
      const readAns = (await rl.question(`Read root folder [${defaultWorkspace}]: `)).trim();
      opts.readRoots = [readAns || defaultWorkspace];

      const writeAns = (await rl.question('Enable write access to this folder? (y/N): ')).trim().toLowerCase();
      opts.writeRoots = writeAns === 'y' || writeAns === 'yes' ? [...opts.readRoots] : [];

      const shellAns = (await rl.question('Enable local shell process execution? (y/N): ')).trim().toLowerCase();
      opts.allowShell = shellAns === 'y' || shellAns === 'yes';

      const modeAns = (await rl.question('Deployment mode — local / quick / relay [local]: ')).trim().toLowerCase();
      opts.mode = modeAns || 'local';

      if (opts.mode === 'relay') {
        opts.publicUrl = (await rl.question('Fixed HTTPS Relay Origin (e.g. https://commander.example.com): ')).trim();
        const rwAns = (await rl.question('Allow remote authenticated writes? (y/N): ')).trim().toLowerCase();
        opts.allowRemoteWrites = rwAns === 'y' || rwAns === 'yes';
        const watchAns = (await rl.question('Generate startup-config.json for login recovery? (Y/n): ')).trim().toLowerCase();
        opts.writeStartupConfig = watchAns !== 'n' && watchAns !== 'no';
      }
      opts.printClients = true;
    } finally {
      rl.close();
    }
  }

  const result = runSetupWizard(opts);
  console.log(`✔ Wrote Local Commander configuration: ${result.configPath}`);
  console.log(`  • workspaceId : ${result.config.workspaceId}`);
  console.log(`  • readRoots   : ${result.config.readRoots.join(', ')}`);
  console.log(`  • writeRoots  : ${result.config.writeRoots.length ? result.config.writeRoots.join(', ') : '(read-only)'}`);
  console.log(`  • allowShell  : ${result.config.allowShell}`);
  console.log(`  • mode        : ${ opts.mode }`);
  if (result.secretFile) {
    console.log(`  • relaySecret : ${result.secretFile}`);
  }
  if (result.startupConfigPath) {
    console.log(`  • startupCfg  : ${result.startupConfigPath}`);
  }
  if (opts.printClients) {
    console.log('\n── Claude Desktop / Cursor MCP Snippet ──');
    console.log(result.snippets.claudeDesktop);
    console.log('\n── Codex CLI (config.toml) Snippet ──');
    console.log(result.snippets.codexToml);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
