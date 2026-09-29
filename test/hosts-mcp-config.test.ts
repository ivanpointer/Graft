import { test } from 'node:test';
import assert from 'node:assert/strict';

// The MCP launch command is resolved from PATH at init time; pin it to the npx
// form so these expectations are the same on every machine.
process.env.GRAFT_MCP_NPX = '1';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcpConfigs, serverEntry } from '../src/hosts/mcp-config.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-mcpcfg-')); }

test('cursor/gemini/kiro get repo-local JSON entries', () => {
  const repo = fresh(); const home = fresh();
  const w = registerMcpConfigs(repo, ['cursor', 'gemini', 'kiro'], { home });
  assert.deepEqual(w.map((x) => x.action), ['created', 'created', 'created']);
  const cursor = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cursor.mcpServers.graft, { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] });
  assert.ok(existsSync(join(repo, '.gemini', 'settings.json')));
  assert.ok(existsSync(join(repo, '.kiro', 'settings', 'mcp.json')));
});

test('existing config keys are preserved; re-run is unchanged', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  registerMcpConfigs(repo, ['cursor'], { home });
  const cfg = JSON.parse(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(cfg.mcpServers.other, 'foreign server preserved');
  assert.ok(cfg.mcpServers.graft);
  const again = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(again.map((x) => x.action), ['unchanged']);
});

test('unparseable JSON is never clobbered', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  writeFileSync(join(repo, '.cursor', 'mcp.json'), '{ not json');
  const w = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(w.map((x) => x.action), ['skipped-unparseable']);
  assert.equal(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'), '{ not json');
});

test('agents id: codex TOML + opencode JSON, gated on home dirs', () => {
  const repo = fresh(); const home = fresh();
  assert.deepEqual(registerMcpConfigs(repo, ['agents'], { home }), [], 'nothing without home dirs');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const w = registerMcpConfigs(repo, ['agents'], { home });
  assert.equal(w.length, 2);
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.graft\]$/m);
  assert.match(toml, /"@nanonets\/graft"/);
  assert.match(toml, /\[mcp_servers\.graft\.env\]\nGRAFT_HARNESS_HOST = "codex"/);
  const oc = JSON.parse(readFileSync(join(repo, 'opencode.json'), 'utf8'));
  assert.equal(oc.mcp.graft.type, 'local');
  const again = registerMcpConfigs(repo, ['agents'], { home });
  assert.deepEqual(again.map((x) => x.action).sort(), ['unchanged', 'unchanged']);
});

test('codex TOML append preserves existing content', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n');
  registerMcpConfigs(repo, ['agents'], { home });
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /model = "o3"/);
  assert.match(toml, /\[mcp_servers\.other\]/);
  assert.match(toml, /\[mcp_servers\.graft\]/);
});

test('Codex harness env patch preserves an existing MCP transport and options', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const path = join(home, '.codex', 'config.toml');
  writeFileSync(path,
    '[mcp_servers.graft]\n' +
    'command = "/custom/graft"\n' +
    'args = ["mcp", "--custom"]\n' +
    'startup_timeout_sec = 42\n\n' +
    '[mcp_servers.graft.env]\n' +
    'OTHER_VAR = "keep"\n\n' +
    '[mcp_servers.other]\nurl = "https://example.test/mcp"\n');

  assert.equal(registerMcpConfigs(repo, ['agents'], { home })[0].action, 'updated');
  const toml = readFileSync(path, 'utf8');
  assert.match(toml, /\[mcp_servers\.graft\]\ncommand = "\/custom\/graft"\nargs = \["mcp", "--custom"\]\nstartup_timeout_sec = 42/);
  assert.match(toml, /\[mcp_servers\.graft\.env\]\nGRAFT_HARNESS_HOST = "codex"\nOTHER_VAR = "keep"/);
  assert.match(toml, /\[mcp_servers\.other\]\nurl = "https:\/\/example\.test\/mcp"/);
  assert.equal(registerMcpConfigs(repo, ['agents'], { home })[0].action, 'unchanged');
});

test('Codex repairs a transport-less MCP entry before its existing env subtable', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const path = join(home, '.codex', 'config.toml');
  writeFileSync(path, '[mcp_servers.graft.env]\nGRAFT_HARNESS_HOST = "codex"\n');
  registerMcpConfigs(repo, ['agents'], { home });
  const toml = readFileSync(path, 'utf8');
  assert.match(toml, /^\[mcp_servers\.graft\]\ncommand = "npx"\nargs = \["-y", "@nanonets\/graft", "mcp"\]/);
  assert.ok(toml.indexOf('[mcp_servers.graft]') < toml.indexOf('[mcp_servers.graft.env]'));
  assert.equal((toml.match(/\[mcp_servers\.graft\]/g) ?? []).length, 1);
});

test('Codex keeps an existing HTTP MCP transport and its options', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const path = join(home, '.codex', 'config.toml');
  const original = '[mcp_servers.graft]\nurl = "https://example.test/mcp"\nenabled = false\n';
  writeFileSync(path, original);
  assert.equal(registerMcpConfigs(repo, ['agents'], { home })[0].action, 'unchanged');
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('Codex leaves an inline env table intact', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const path = join(home, '.codex', 'config.toml');
  const original = '[mcp_servers.graft]\ncommand = "/custom/graft"\nargs = ["mcp"]\n' +
    'env = { GRAFT_HARNESS_HOST = "codex", OTHER_VAR = "keep" }\n';
  writeFileSync(path, original);
  assert.equal(registerMcpConfigs(repo, ['agents'], { home })[0].action, 'unchanged');
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('Codex recognizes MCP table headers with comments', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.codex'), { recursive: true });
  const path = join(home, '.codex', 'config.toml');
  const original = '[mcp_servers.graft] # managed elsewhere\ncommand = "/custom/graft"\nargs = ["mcp"]\n\n' +
    '[mcp_servers.graft.env] # host hint\nGRAFT_HARNESS_HOST = "codex"\n';
  writeFileSync(path, original);
  assert.equal(registerMcpConfigs(repo, ['agents'], { home })[0].action, 'unchanged');
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('grok gets a repo-local TOML MCP section', () => {
  const repo = fresh(); const home = fresh();
  const w = registerMcpConfigs(repo, ['grok'], { home });
  assert.deepEqual(w.map((x) => x.action), ['created']);
  const toml = readFileSync(join(repo, '.grok', 'config.toml'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.graft\]$/m);
  assert.match(toml, /"@nanonets\/graft"/);
  const again = registerMcpConfigs(repo, ['grok'], { home });
  assert.deepEqual(again.map((x) => x.action), ['unchanged']);
});

test('pi gets an eager machine-global MCP entry when its config dir exists', () => {
  const repo = fresh(); const home = fresh();
  assert.deepEqual(registerMcpConfigs(repo, ['pi'], { home }), []);
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });

  const writes = registerMcpConfigs(repo, ['pi'], { home });
  assert.deepEqual(writes.map((x) => x.action), ['created']);
  const config = JSON.parse(readFileSync(join(home, '.pi', 'agent', 'mcp.json'), 'utf8'));
  assert.deepEqual(config.mcpServers.graft, {
    command: 'npx',
    args: ['-y', '@nanonets/graft', 'mcp'],
    lifecycle: 'eager',
  });
  assert.deepEqual(registerMcpConfigs(repo, ['pi'], { home }).map((x) => x.action), ['unchanged']);
});

test('JSON with non-object mcpServers value is skipped', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.cursor'), { recursive: true });
  const badJson = '{"mcpServers": "not-an-object"}';
  writeFileSync(join(repo, '.cursor', 'mcp.json'), badJson);
  const w = registerMcpConfigs(repo, ['cursor'], { home });
  assert.deepEqual(w.map((x) => x.action), ['skipped-unparseable']);
  assert.equal(readFileSync(join(repo, '.cursor', 'mcp.json'), 'utf8'), badJson);
});

// The launch command: bare binary when graft is installed, npx otherwise. Never an
// absolute path — these files are committed and shared between machines.
test('serverEntry prefers the installed binary and falls back to npx', () => {
  const saved = process.env.GRAFT_MCP_NPX;
  delete process.env.GRAFT_MCP_NPX;
  try {
    assert.deepEqual(serverEntry({ onPath: true }), { command: 'graft', args: ['mcp'] });
    assert.deepEqual(serverEntry({ onPath: false }), { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] });
    for (const e of [serverEntry({ onPath: true }), serverEntry({ onPath: false })]) {
      assert.ok(!e.command.startsWith('/'), 'never an absolute path — configs get shared');
    }
  } finally {
    if (saved !== undefined) process.env.GRAFT_MCP_NPX = saved;
  }
});

test('GRAFT_MCP_NPX overrides an installed binary', () => {
  process.env.GRAFT_MCP_NPX = '1';
  assert.equal(serverEntry({ onPath: true }).command, 'npx', 'the escape hatch wins');
});
