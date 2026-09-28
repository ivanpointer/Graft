import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildGraph } from '../src/graph/build.js';
import { statsPath } from '../src/stats/store.js';
import { sumSavingsFooters } from '../src/context/savings.js';

test('CLI emits the recorded command ID without changing its savings footer or JSON output', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'graft-cli-id-repo-'));
  const statsHome = mkdtempSync(join(tmpdir(), 'graft-cli-id-stats-'));
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'math.ts'),
    '/** ' + 'Math module context. '.repeat(300) + ' */\nexport function add(a: number, b: number) { return a + b; }\n');
  await buildGraph(repo);

  const run = (json: boolean) => spawnSync(process.execPath,
    ['--import', 'tsx', 'src/cli.ts', 'map', repo, ...(json ? ['--json'] : [])],
    { encoding: 'utf8', env: { ...process.env, GRAFT_STATS_HOME: statsHome } });
  const plain = run(false);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /\[graft\] tokens saved ≈ [\d,]+/);
  assert.ok(sumSavingsFooters(plain.stdout) > 0);
  const plainId = plain.stderr.match(/^\[graft\] invocation_id=([0-9a-f-]{36})$/im)?.[1];
  assert.ok(plainId);
  assert.equal((plain.stderr.match(/\binvocation_id=/g) ?? []).length, 1);

  const json = run(true);
  assert.equal(json.status, 0, json.stderr);
  assert.ok(Array.isArray(JSON.parse(json.stdout).dirs));
  const jsonId = json.stderr.match(/^\[graft\] invocation_id=([0-9a-f-]{36})$/im)?.[1];
  assert.ok(jsonId);
  assert.notEqual(jsonId, plainId);

  const db = new DatabaseSync(statsPath(statsHome), { readOnly: true });
  const rows = db.prepare('SELECT id, command, surface, saved_tokens FROM invocations ORDER BY rowid').all() as Array<{ id: string; command: string; surface: string; saved_tokens: number }>;
  db.close();
  assert.deepEqual(rows.map((row) => row.id), [plainId, jsonId]);
  assert.deepEqual(rows.map((row) => [row.command, row.surface]), [['map', 'cli'], ['map', 'cli']]);
  assert.equal(rows[0].saved_tokens, sumSavingsFooters(plain.stdout));
});
