import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installOpenCodeAttribution, openCodeAttributionTargets } from '../src/hosts/opencode-attribution.js';
import { observeOpenCodeAfterTool } from '../src/hosts/native-attribution.js';
import { runHostsInit } from '../src/hosts/init.js';
import { recordInvocation, statsPath } from '../src/stats/store.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'graft-opencode-attribution-'));
const plugin = (repo: string) => join(repo, '.opencode', 'plugins', 'graft-attribution.js');

test('OpenCode plugin is repo-local, idempotent, and wired for installed OpenCode', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  assert.equal(openCodeAttributionTargets(repo)[0].scope, 'repo');
  assert.equal(installOpenCodeAttribution(repo)[0].action, 'created');
  assert.equal(installOpenCodeAttribution(repo)[0].action, 'unchanged');
  assert.match(readFileSync(plugin(repo), 'utf8'), /tool\.execute\.after/);
  const initialized = fresh();
  const r = runHostsInit(initialized, { home, agents: ['agents'], mcp: false, global: false });
  assert.ok(r.hooks.some((x) => x.id === 'opencode-attribution-plugin'));
  assert.ok(existsSync(plugin(initialized)));
  const disabled = fresh();
  runHostsInit(disabled, { home, agents: ['agents'], mcp: false, hooks: false });
  assert.ok(!existsSync(plugin(disabled)));
});

test('OpenCode V1 tool result joins exact invocation and callID; unrelated output is ignored', async () => {
  const home = fresh();
  const id = await recordInvocation({ command: 'graft_find_code', surface: 'mcp', savedTokens: 91 }, home);
  assert.ok(id);
  const marker = `[graft] invocation_id=${id}`;
  const input = { tool: 'graft_find_code', sessionID: 'oc-session', callID: 'call-1', args: {} };
  assert.equal(await observeOpenCodeAfterTool(input, { output: `answer\n${marker}` }, '/repo', home), id);
  assert.equal(await observeOpenCodeAfterTool(input, { output: marker }, '/repo', home), id);
  assert.equal(await observeOpenCodeAfterTool({ ...input, tool: 'read' }, { output: marker }, '/repo', home), null);
  assert.equal(await observeOpenCodeAfterTool({ ...input, tool: 'bash', args: { command: 'cat file' } }, { output: marker }, '/repo', home), null);
  assert.equal(await observeOpenCodeAfterTool({ ...input, callID: 'call-2' }, { content: [{ type: 'text', text: marker }] }, '/repo', home), id);

  const db = new DatabaseSync(statsPath(home));
  const facts = db.prepare('SELECT invocation_id, tool_use_id, saved_tokens FROM tool_observations').all() as any[];
  assert.equal(facts.length, 1);
  assert.deepEqual({ ...facts[0] }, { invocation_id: id, tool_use_id: 'call-1', saved_tokens: 0 });
  db.close();
});
