import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetupWizard, buildClientSnippets } from '../setup-wizard.mjs';
import { Commander } from '../core.mjs';
import { makeServer } from '../server.mjs';
import { dependency } from '../deps.mjs';

const { Client } = await dependency('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await dependency('@modelcontextprotocol/sdk/inMemory.js');

test('setup wizard creates valid local config, client snippets, and boots MCP server end-to-end', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-wizard-local-'));
  try {
    const workspaceDir = path.join(tmpDir, 'my-workspace');
    const configPath = path.join(tmpDir, 'config.json');
    const result = runSetupWizard({
      configPath,
      stateDir: path.join(tmpDir, 'state'),
      readRoots: [workspaceDir],
      writeRoots: [workspaceDir],
      allowShell: false,
      mode: 'local',
    });

    assert.equal(fs.existsSync(configPath), true);
    assert.equal(fs.existsSync(workspaceDir), true);
    assert.match(result.config.workspaceId, /^[a-f0-9]{12}$/);
    assert.ok(result.snippets.claudeDesktop.includes('"local-commander"'));
    assert.ok(result.snippets.codexToml.includes('[mcp_servers.local-commander]'));

    const engine = new Commander({
      ...result.config,
      logFile: path.join(tmpDir, 'calls.jsonl'),
    });
    const server = makeServer(engine);
    const client = new Client({ name: 'wizard-verify-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 16);
      const writeRes = await client.callTool({
        name: 'write_file',
        arguments: { path: path.join(workspaceDir, 'hello.txt'), content: 'wizard ok' },
      });
      assert.equal(writeRes.isError, undefined);
      assert.equal(fs.readFileSync(path.join(workspaceDir, 'hello.txt'), 'utf8'), 'wizard ok');
    } finally {
      await client.close();
      await server.close();
      await engine.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('setup wizard relay mode generates 64-hex relay.secret and startup-config.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-wizard-relay-'));
  try {
    const stateDir = path.join(tmpDir, 'state');
    const configPath = path.join(tmpDir, 'config.json');
    const startupConfigPath = path.join(tmpDir, 'startup-config.json');
    const result = runSetupWizard({
      configPath,
      stateDir,
      readRoots: [path.join(tmpDir, 'work')],
      writeRoots: [],
      mode: 'relay',
      publicUrl: 'https://commander.example.com',
      writeStartupConfig: true,
      startupConfigPath,
    });

    assert.equal(result.config.tunnel.mode, 'relay');
    assert.equal(result.config.tunnel.transport, 'websocket');
    assert.equal(result.config.tunnel.publicUrl, 'https://commander.example.com');
    assert.ok(result.secretFile && fs.existsSync(result.secretFile));
    assert.equal(fs.readFileSync(result.secretFile, 'utf8').trim().length, 64);
    assert.ok(result.startupConfigPath && fs.existsSync(result.startupConfigPath));
    const startupCfg = JSON.parse(fs.readFileSync(result.startupConfigPath, 'utf8'));
    assert.equal(startupCfg.commanderWorkspaceId, result.config.workspaceId);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildClientSnippets normalizes Windows backslashes to forward slashes', () => {
  const snippets = buildClientSnippets({
    serverPath: 'C:\\LocalCommander\\server.mjs',
    configPath: 'C:\\LocalCommander\\config.json',
  });
  assert.ok(snippets.claudeDesktop.includes('C:/LocalCommander/server.mjs'));
  assert.ok(snippets.codexToml.includes('C:/LocalCommander/config.json'));
});
