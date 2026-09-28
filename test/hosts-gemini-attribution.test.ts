import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { installGeminiAttribution, geminiAttributionTargets } from '../src/hosts/gemini-attribution.js';
import { observeGeminiAfterTool } from '../src/hosts/native-attribution.js';
import { runHostsInit } from '../src/hosts/init.js';
import { recordInvocation, readStatsReport, statsPath } from '../src/stats/store.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'graft-gemini-attribution-'));
const settings = (repo: string) => join(repo, '.gemini', 'settings.json');

test('Gemini settings merge keeps foreign hooks, replaces own hook, and stays idempotent', () => {
  const repo = fresh();
  mkdirSync(join(repo, '.gemini'));
  writeFileSync(settings(repo), JSON.stringify({ theme: 'custom', hooks: { AfterTool: [
    { matcher: 'read_file', hooks: [{ type: 'command', command: 'other.sh' }] },
    { hooks: [{ type: 'command', command: 'node old/graft-attribution.mjs' }] },
  ] } }));
  assert.equal(geminiAttributionTargets(repo).length, 2);
  installGeminiAttribution(repo);
  const first = JSON.parse(readFileSync(settings(repo), 'utf8'));
  assert.equal(first.theme, 'custom');
  assert.equal(first.hooks.AfterTool.length, 2);
  assert.equal(first.hooks.AfterTool[0].hooks[0].command, 'other.sh');
  assert.match(first.hooks.AfterTool[1].matcher, /mcp_graft_/);
  assert.deepEqual(installGeminiAttribution(repo).map((x) => x.action), ['unchanged', 'unchanged']);
});

test('Gemini never overwrites malformed settings; init respects hook flags', () => {
  const repo = fresh(); const home = fresh();
  mkdirSync(join(repo, '.gemini'));
  writeFileSync(settings(repo), '{ broken');
  assert.equal(installGeminiAttribution(repo)[1].action, 'skipped-unparseable');
  assert.equal(readFileSync(settings(repo), 'utf8'), '{ broken');

  const clean = fresh();
  const r = runHostsInit(clean, { home, agents: ['gemini'], mcp: false, global: false });
  assert.ok(r.hooks.some((x) => x.id === 'gemini-attribution-settings'));
  assert.ok(existsSync(settings(clean)));
  const disabled = fresh();
  runHostsInit(disabled, { home, agents: ['gemini'], mcp: false, hooks: false });
  assert.ok(!existsSync(settings(disabled)));
});

test('Gemini AfterTool links only a Graft result marker; model and effort stay unknown', async () => {
  const home = fresh();
  const id = await recordInvocation({ command: 'graft_find_code', surface: 'mcp', savedTokens: 37 }, home);
  assert.ok(id);
  const base = { hook_event_name: 'AfterTool', session_id: 'gemini-session', cwd: '/repo',
    tool_name: 'mcp_graft_graft_find_code', tool_input: {} };
  const marker = `[graft] invocation_id=${id}`;
  assert.equal(await observeGeminiAfterTool({ ...base, tool_response: {
    llmContent: [{ type: 'text', text: `answer\n${marker}\n` }], returnDisplay: `answer\n${marker}`,
  } }, home), id);
  assert.equal(await observeGeminiAfterTool({ ...base, tool_response: { llmContent: marker } }, home), id);
  assert.equal(await observeGeminiAfterTool({ ...base, tool_name: 'read_file', tool_response: { llmContent: marker } }, home), null);
  assert.equal(await observeGeminiAfterTool({ ...base, tool_response: { llmContent: `quoted ${marker}` } }, home), null);
  assert.equal(await observeGeminiAfterTool({ ...base, tool_response: { llmContent: `${marker}\n[graft] invocation_id=00000000-0000-0000-0000-000000000000` } }, home), null);

  const db = new DatabaseSync(statsPath(home));
  const facts = db.prepare('SELECT invocation_id, saved_tokens, config_snapshot_id FROM tool_observations').all() as any[];
  assert.equal(facts.length, 1, 'same invocation is deduplicated');
  assert.equal(facts[0].invocation_id, id);
  assert.equal(facts[0].saved_tokens, 0, 'savings are owned by the invocation');
  const snap = db.prepare('SELECT domain, harness_model, harness_reasoning_effort FROM config_snapshots WHERE id = ?')
    .get(facts[0].config_snapshot_id) as any;
  assert.deepEqual({ ...snap }, { domain: 'harness', harness_model: 'unknown', harness_reasoning_effort: 'unknown' });
  db.close();
  const report = await readStatsReport({ home });
  assert.equal(report.savedTokens, 37, 'one invocation contributes savings once');
  assert.equal(report.modelEfforts[0].model, 'unknown');
});
