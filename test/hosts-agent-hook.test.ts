import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { recordInvocation, readStatsReport, statsPath } from '../src/stats/store.js';
import { homeEnv, tmpRepo } from './helpers.js';

function hook(event: string, input: string, home: string, repo?: string, codexSessionId?: string) {
  const env = {
    ...homeEnv(home), GRAFT_STATS_HOME: home,
    CLAUDE_PROJECT_DIR: repo, CODEX_SESSION_ID: codexSessionId,
  };
  const probe = spawnSync(process.execPath, ['-p', 'require("node:os").homedir()'], {
    encoding: 'utf8', timeout: 10_000, env,
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), home, 'hook subprocess must use the scratch HOME');
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'agent-hook', event], {
    input, encoding: 'utf8', timeout: 10_000,
    env,
  });
}

test('legacy agent-hook events retain Claude/Codex behavior and stdout contract', () => {
  const home = tmpRepo('legacy-agent-hook-home');
  const repo = tmpRepo('legacy-agent-hook-repo');
  mkdirSync(join(repo, 'graft'), { recursive: true });
  writeFileSync(join(repo, 'graft', 'INDEX.md'), '# isolated repo orientation\n');
  const base = { cwd: repo, session_id: 'legacy-session' };
  const cases = [
    ['session-start', base],
    ['prompt', { ...base, prompt: 'yes' }],
    ['tool-savings', { ...base, tool_name: 'Read', tool_response: 'ordinary output' }],
    ['stop', base],
    ['post-model-switch', { ...base, model: 'test-model' }],
    ['post-edit', { ...base, tool_input: { file_path: join(repo, 'src', 'auth.ts') } }],
  ] as const;
  for (const [event, payload] of cases) {
    const result = hook(event, JSON.stringify(payload), home, repo);
    assert.equal(result.status, 0, `${event}: ${result.stderr}`);
    assert.equal(result.stderr, '', `${event}: no CLI chatter on stderr`);
    if (event === 'session-start') {
      const response = JSON.parse(result.stdout);
      assert.equal(response.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(response.hookSpecificOutput.additionalContext, /isolated repo orientation/);
      assert.ok(!result.stdout.endsWith('\n'), 'preserve main() stdout bytes');
    } else {
      assert.equal(result.stdout, '', `${event}: preserve silent legacy hook response`);
    }
  }
  const codex = hook('post-model-switch', JSON.stringify({ ...base, model: 'codex-test-model' }),
    home, repo, 'codex-session');
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(codex.stdout, '');
  assert.equal(codex.stderr, '');
  const db = new DatabaseSync(statsPath(home));
  const events = db.prepare('SELECT event, outcome, repo_path, host FROM hook_runs').all() as any[];
  assert.equal(events.length, cases.length + 1, 'each legacy CLI event reached main()');
  for (const [event] of cases) {
    assert.ok(events.some((row) => row.event === event && row.outcome === 'ok'
      && row.repo_path === repo && row.host === 'claude-code'), event);
  }
  assert.ok(events.some((row) => row.event === 'post-model-switch' && row.host === 'codex'
    && row.outcome === 'ok' && row.repo_path === repo), 'Codex event reached main()');
  db.close();
});

test('global Gemini CLI hook command accepts native AfterTool JSON and emits JSON only', async () => {
  const home = tmpRepo('gemini-agent-hook');
  const id = await recordInvocation({ command: 'graft_find_code', surface: 'mcp', savedTokens: 23 }, home);
  assert.ok(id);
  const event = { hook_event_name: 'AfterTool', session_id: 'global-gemini', cwd: '/repo',
    tool_name: 'mcp_graft_graft_find_code', tool_input: {},
    tool_response: { llmContent: `[graft] invocation_id=${id}\nanswer` } };
  const result = hook('gemini-after-tool', JSON.stringify(event), home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
  const malformed = hook('gemini-after-tool', '{broken', home);
  assert.equal(malformed.status, 0, malformed.stderr);
  assert.equal(malformed.stdout, '{}\n');
  assert.equal(malformed.stderr, '');
  const db = new DatabaseSync(statsPath(home));
  const facts = db.prepare('SELECT invocation_id, session_id FROM tool_observations').all() as any[];
  assert.deepEqual(facts.map((f) => ({ ...f })), [{ invocation_id: id, session_id: 'global-gemini' }]);
  db.close();
  assert.equal((await readStatsReport({ home })).calls, 1, 'agent-hook does not create another invocation');
});

test('global OpenCode plugin can send its native tool event through the CLI adapter', async () => {
  const home = tmpRepo('opencode-agent-hook');
  const id = await recordInvocation({ command: 'graft_find_code', surface: 'mcp', savedTokens: 17 }, home);
  assert.ok(id);
  const payload = { repo: '/repo', input: { tool: 'graft_find_code', sessionID: 'global-opencode', callID: 'call-1', args: {} },
    output: { output: `[graft] invocation_id=${id}\nanswer` } };
  const result = hook('opencode-after-tool', JSON.stringify(payload), home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
  const db = new DatabaseSync(statsPath(home));
  const fact = db.prepare('SELECT invocation_id, session_id, tool_use_id FROM tool_observations').get() as any;
  assert.deepEqual({ ...fact }, { invocation_id: id, session_id: 'global-opencode', tool_use_id: 'call-1' });
  db.close();
});
