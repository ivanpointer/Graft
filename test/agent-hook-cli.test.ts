import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpRepo } from './helpers.js';

function runAgentHook(repo: string, event: string, input: object) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'agent-hook', event],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: JSON.stringify(input),
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
      timeout: 20_000,
    },
  );
}

test('agent-hook exposes the installed hook implementation without a generated shim', () => {
  const repo = tmpRepo('agent-hook-cli');
  const source = join(repo, 'src', 'auth.ts');
  const result = runAgentHook(repo, 'post-edit', { tool_input: { file_path: source } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(repo, 'graft', '.cache', 'stats.json')), true);
});

test('agent-hook rejects unknown events before reading or mutating hook state', () => {
  const repo = tmpRepo('agent-hook-invalid');
  const result = runAgentHook(repo, 'typo', {});

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown agent hook event/);
  assert.equal(existsSync(join(repo, 'graft')), false);
});
