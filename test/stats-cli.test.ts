import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordGraphBuild } from '../src/stats/store.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('stats --machine text and JSON show recent graph build trend and latest size', async () => {
  const home = mkdtempSync(join(tmpdir(), 'graft-stats-cli-'));
  const fact = {
    repo: '/work/alpha', trigger: 'direct' as const, mode: 'incremental' as const,
    graphOnly: false, outcome: 'ok' as const, sourceFileCount: 12, sourceBytes: 4096,
    parsedCount: 2, reusedCount: 10, nodeCount: 80, edgeCount: 94,
    errorCount: 0, durationMs: 25.5, phases: { extract: 8, resolve: 4 },
  };
  await recordGraphBuild({ ...fact, occurredAt: '2020-01-01T00:00:00.000Z', durationMs: 100 }, home);
  await recordGraphBuild({ ...fact, occurredAt: new Date().toISOString() }, home);

  const run = (args: string[]) => spawnSync(process.execPath,
    ['--import', 'tsx', cli, 'stats', '--machine', ...args],
    { encoding: 'utf8', env: { ...process.env, GRAFT_STATS_HOME: home } });
  const plain = run([]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /graph builds \(last 30 days\): 1 attempt \(1 completed, 0 failed\)/);
  assert.match(plain.stdout, /total \/ avg: 25\.5 ms \/ 25\.5 ms/);
  assert.match(plain.stdout, /source: 12 files, 4,096 bytes/);
  assert.match(plain.stdout, /extraction: 2 parsed, 10 reused/);
  assert.match(plain.stdout, /graph: 80 nodes, 94 edges/);
  assert.match(plain.stdout, /duration: 25\.5 ms/);

  const json = run(['--since', '7', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout) as { graphBuilds: {
    sinceDays: number; attempts: number; totalDurationMs: number; avgDurationMs: number;
    latest: { sourceFileCount: number; sourceBytes: number; parsedCount: number;
      reusedCount: number; nodeCount: number; edgeCount: number; durationMs: number;
      phases: { extract: number; resolve: number } };
  } };
  assert.equal(report.graphBuilds.sinceDays, 7);
  assert.equal(report.graphBuilds.attempts, 1);
  assert.equal(report.graphBuilds.totalDurationMs, 25.5);
  assert.equal(report.graphBuilds.avgDurationMs, 25.5);
  assert.deepEqual({
    sourceFileCount: report.graphBuilds.latest.sourceFileCount,
    sourceBytes: report.graphBuilds.latest.sourceBytes,
    parsedCount: report.graphBuilds.latest.parsedCount,
    reusedCount: report.graphBuilds.latest.reusedCount,
    nodeCount: report.graphBuilds.latest.nodeCount,
    edgeCount: report.graphBuilds.latest.edgeCount,
    durationMs: report.graphBuilds.latest.durationMs,
    phases: report.graphBuilds.latest.phases,
  }, { sourceFileCount: 12, sourceBytes: 4096, parsedCount: 2, reusedCount: 10,
    nodeCount: 80, edgeCount: 94, durationMs: 25.5, phases: { extract: 8, resolve: 4 } });
});
