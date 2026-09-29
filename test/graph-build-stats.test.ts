import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildGraph } from '../src/graph/build.js';
import { askIndexPath } from '../src/ask/index-file.js';
import { ensureFreshGraph } from '../src/graph/refresh.js';
import { readGraphBuildReport, statsPath } from '../src/stats/store.js';

test('graph build facts track exact source size, modes, refresh, phases, and failed attempts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'graft-build-stats-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'graft-build-stats-repo-'));
  mkdirSync(join(repo, 'src'));
  const firstSource = 'export function one(): number { return 1; }\n';
  const secondSource = 'export function two(): number { return 2; }\n';
  writeFileSync(join(repo, 'src', 'one.ts'), firstSource);
  writeFileSync(join(repo, 'src', 'two.ts'), secondSource);
  const priorHome = process.env.GRAFT_STATS_HOME;
  process.env.GRAFT_STATS_HOME = home;
  try {
    await buildGraph(repo);
    await buildGraph(repo);
    writeFileSync(join(repo, 'src', 'one.ts'), `${firstSource}export const changed = true;\n`);
    await buildGraph(repo);
    writeFileSync(join(repo, 'src', 'two.ts'), `${secondSource}export const refreshed = true;\n`);
    assert.equal((await ensureFreshGraph(repo)).refreshed, true);
    await assert.rejects(buildGraph(repo, {
      onProgress: () => { throw new Error('test interruption'); },
    }), /test interruption/);

    const db = new DatabaseSync(statsPath(home), { readOnly: true });
    try {
      const rows = db.prepare(`SELECT trigger, mode, graph_only, outcome, source_file_count,
        source_bytes, parsed_count, reused_count, node_count, edge_count, error_count, duration_ms
        FROM graph_builds ORDER BY rowid`).all() as Array<Record<string, number | string | null>>;
      assert.equal(rows.length, 5, 'one fact per attempted build');
      assert.equal(rows[0].mode, 'cold');
      assert.equal(rows[0].source_file_count, 2);
      assert.equal(rows[0].source_bytes, Buffer.byteLength(firstSource) + Buffer.byteLength(secondSource));
      assert.equal(rows[0].parsed_count, 2);
      assert.equal(rows[0].reused_count, 0);
      assert.ok(Number(rows[0].node_count) > 0);
      assert.ok(Number(rows[0].edge_count) > 0);
      assert.equal(rows[0].outcome, 'ok');
      assert.equal(rows[1].mode, 'reuse');
      assert.equal(rows[1].parsed_count, 0);
      assert.equal(rows[1].reused_count, 2);
      assert.equal(rows[2].mode, 'incremental');
      assert.equal(rows[2].parsed_count, 1);
      assert.equal(rows[2].reused_count, 1);
      assert.equal(rows[3].trigger, 'auto-refresh');
      assert.equal(rows[3].graph_only, 1);
      assert.equal(rows[4].outcome, 'failed');
      assert.equal(rows[4].error_count, 1);
      assert.ok(rows.every((row) => Number(row.duration_ms) >= 0));
      const phases = db.prepare('SELECT phase FROM graph_build_phases WHERE build_id = (SELECT id FROM graph_builds ORDER BY rowid LIMIT 1)')
        .all() as Array<{ phase: string }>;
      assert.deepEqual(phases.map((row) => row.phase).sort(),
        ['enrich', 'enumerate', 'extract', 'prepare', 'resolve', 'write']);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM graph_build_phases').get() as { n: number }).n, 27,
        'the interrupted attempt retains completed and active phase timing');
      const timings = db.prepare(`
        SELECT b.duration_ms AS total, SUM(p.duration_ms) AS phases
        FROM graph_builds b JOIN graph_build_phases p ON p.build_id = b.id
        GROUP BY b.id
      `).all() as Array<{ total: number; phases: number }>;
      assert.equal(timings.length, 5);
      assert.ok(timings.every(({ total, phases }) => phases <= total + 0.01),
        'phase durations partition build work and never double-count nested time');
    } finally { db.close(); }
    const report = await readGraphBuildReport({ home, repo });
    assert.equal(report.attempts, 5);
    assert.equal(report.completed, 4);
    assert.equal(report.failed, 1);
    assert.equal(report.latest?.outcome, 'failed');
    assert.ok(report.latest?.phases.extract !== undefined);
    process.env.GRAFT_STATS_HOME = join(repo, 'src', 'one.ts');
    assert.equal((await buildGraph(repo)).files, 2, 'unwritable stats storage cannot fail a graph build');
  } finally {
    if (priorHome === undefined) delete process.env.GRAFT_STATS_HOME;
    else process.env.GRAFT_STATS_HOME = priorHome;
  }
});

test('recoverable graph errors are recorded as partial builds', async () => {
  const home = mkdtempSync(join(tmpdir(), 'graft-partial-stats-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'graft-partial-stats-repo-'));
  writeFileSync(join(repo, 'one.ts'), 'export function one(): number { return 1; }\n');
  const priorHome = process.env.GRAFT_STATS_HOME;
  process.env.GRAFT_STATS_HOME = home;
  try {
    await buildGraph(repo);
    const sidecar = askIndexPath(join(repo, 'graft'));
    rmSync(sidecar);
    mkdirSync(sidecar);
    const result = await buildGraph(repo);
    assert.match(result.errors.join('\n'), /ask-index:/);
    const report = await readGraphBuildReport({ home, repo });
    assert.equal(report.latest?.outcome, 'partial');
    assert.equal(report.latest?.errorCount, result.errors.length);
    assert.equal(report.latest?.mode, 'reuse');
  } finally {
    if (priorHome === undefined) delete process.env.GRAFT_STATS_HOME;
    else process.env.GRAFT_STATS_HOME = priorHome;
  }
});
