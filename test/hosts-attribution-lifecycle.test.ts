import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHostsInit } from '../src/hosts/init.js';
import { planInit } from '../src/hosts/plan.js';
import { runRetract } from '../src/hosts/retract.js';
import { runUpkeep } from '../src/upkeep-run.js';
import { readStamp, writeStamp } from '../src/upkeep.js';
import { homeEnv, runCli, tmpRepo } from './helpers.js';

function fixture(): { repo: string; home: string } {
  const repo = tmpRepo('attribution-lifecycle');
  const home = tmpRepo('attribution-home');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  return { repo, home };
}

function runIsolatedCli(args: string[], home: string) {
  const probe = spawnSync(process.execPath, ['-p', 'require("node:os").homedir()'], {
    encoding: 'utf8', timeout: 10_000, env: homeEnv(home),
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), home, 'CLI subprocess must use the scratch HOME');
  return runCli(args, { home });
}

test('plan and CLI dry-run name every Gemini/OpenCode attribution write and obey flags', () => {
  const { repo, home } = fixture();
  const paths = planInit(repo, { home, ids: ['gemini', 'agents'] }).flatMap((p) => p.writes.map((w) => w.path));
  for (const rel of [
    join('.gemini', 'settings.json'), join('.gemini', 'hooks', 'graft-attribution.mjs'),
    join('.opencode', 'plugins', 'graft-attribution.js'),
  ]) assert.ok(paths.includes(join(repo, rel)), `${rel} is planned`);

  const dry = runIsolatedCli(['init', repo, '--dry-run', '--agents', 'gemini', 'agents'], home);
  assert.equal(dry.status, 0, dry.describe());
  assert.match(dry.stderr, /\.gemini[\\/]hooks[\\/]graft-attribution\.mjs/);
  assert.match(dry.stderr, /\.opencode[\\/]plugins[\\/]graft-attribution\.js/);
  assert.ok(!existsSync(join(repo, '.gemini')), 'dry-run wrote nothing');

  const limited = planInit(repo, { home, ids: ['gemini', 'agents'], hooks: false, mcp: false, global: false });
  assert.ok(limited.every((p) => p.writes.every((w) => w.kind !== 'hook' && w.kind !== 'mcp' && w.scope === 'repo')));
  const noHooks = runIsolatedCli(['init', repo, '--dry-run', '--agents', 'gemini', 'agents', '--no-hooks', '--no-mcp', '--no-global'], home);
  assert.equal(noHooks.status, 0, noHooks.describe());
  assert.doesNotMatch(noHooks.stderr, /graft-attribution/);

  const absent = planInit(repo, { home: tmpRepo('without-opencode'), ids: ['agents'] })[0];
  assert.ok(absent.writes.every((w) => w.id !== 'opencode-attribution-plugin'));
});

test('retract removes owned shims and only Graft entries from Gemini settings', () => {
  const { repo, home } = fixture();
  runHostsInit(repo, { home, agents: ['gemini', 'agents'], global: false });
  const settings = join(repo, '.gemini', 'settings.json');
  const root = JSON.parse(readFileSync(settings, 'utf8'));
  root.theme = 'custom';
  root.mcpServers.other = { command: 'other' };
  root.hooks.AfterTool.unshift({ matcher: 'read_file', hooks: [{ type: 'command', command: 'foreign.sh' }] });
  root.hooks.AfterTool[1].hooks.push({ type: 'command', command: 'same-group-foreign.sh' });
  writeFileSync(settings, JSON.stringify(root));
  const userPlugin = join(repo, '.opencode', 'plugins', 'user.js');
  writeFileSync(userPlugin, 'export const user = true;\n');

  const result = runRetract(repo, { home, apply: true, global: false });
  const byPath = new Map(result.map((r) => [r.path, r.action]));
  assert.equal(byPath.get(settings), 'removed');
  assert.equal(byPath.get(join(repo, '.gemini', 'hooks', 'graft-attribution.mjs')), 'deleted');
  assert.equal(byPath.get(join(repo, '.opencode', 'plugins', 'graft-attribution.js')), 'deleted');
  const kept = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(kept.theme, 'custom');
  assert.deepEqual(Object.keys(kept.mcpServers), ['other']);
  assert.equal(kept.hooks.AfterTool.length, 2);
  assert.equal(kept.hooks.AfterTool[0].hooks[0].command, 'foreign.sh');
  assert.equal(kept.hooks.AfterTool[1].hooks[0].command, 'same-group-foreign.sh');
  assert.equal(readFileSync(userPlugin, 'utf8'), 'export const user = true;\n');
});

test('version refresh replaces stale Gemini and OpenCode adapters for selected hosts', () => {
  const { repo, home } = fixture();
  runHostsInit(repo, { home, agents: ['gemini', 'agents'], mcp: false, global: false });
  const gemini = join(repo, '.gemini', 'hooks', 'graft-attribution.mjs');
  const openCode = join(repo, '.opencode', 'plugins', 'graft-attribution.js');
  writeFileSync(gemini, 'stale Gemini shim');
  writeFileSync(openCode, 'stale OpenCode plugin');
  writeStamp(repo, '0.0.1', ['gemini', 'agents'], { global: false, mcp: false, hooks: true });

  runUpkeep(repo, '0.0.2', { background: false, home });
  assert.match(readFileSync(gemini, 'utf8'), /mainGeminiHook/);
  assert.match(readFileSync(openCode, 'utf8'), /observeOpenCodeAfterTool/);
  assert.equal(readStamp(repo)?.version, '0.0.2');
});
