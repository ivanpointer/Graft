import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  STATS_SCHEMA_VERSION,
  formatStatsReport,
  readStatsReport,
  recordConfigurationSnapshot,
  recordDecisionRun,
  recordHookRun,
  recordInvocation,
  recordSessionRollup,
  recordToolObservation,
  statsPath,
} from '../src/stats/store.js';
import { recordGraftConfiguration } from '../src/stats/config.js';

function freshHome(): string { return mkdtempSync(join(tmpdir(), 'graft-stats-')); }

test('machine stats retain exact local call, repo, and savings totals', async () => {
  const home = freshHome();
  await recordInvocation({ command: 'ask', surface: 'cli', repo: '/work/alpha', ok: true, savedTokens: 1200, sessionId: 'agent-session-1' }, home);
  await recordInvocation({ command: 'map', surface: 'mcp', repo: '/work/alpha', ok: true, savedTokens: 300, sessionId: 'agent-session-1' }, home);
  await recordInvocation({ command: 'grep', surface: 'cli', repo: '/work/beta', ok: false, sessionId: 'agent-session-1' }, home);

  const report = await readStatsReport({ home });
  assert.equal(report.calls, 3);
  assert.equal(report.successfulCalls, 2);
  assert.equal(report.repos, 2);
  assert.equal(report.sessions, 1);
  assert.equal(report.savedTokens, 1500);
  assert.equal(report.avgSavedTokens, 500);
  assert.deepEqual(report.commands[0], { command: 'ask', calls: 1, savedTokens: 1200 });
  assert.match(formatStatsReport(report), /1,500/);
  assert.match(statsPath(home), /\.graft\/stats\/v1\.sqlite3$/);
  if (process.platform !== 'win32') assert.equal(statSync(statsPath(home)).mode & 0o077, 0);
});

test('machine stats report a useful empty state', async () => {
  assert.equal(formatStatsReport(await readStatsReport({ home: freshHome() })), 'graft machine stats: no recorded calls yet.');
});

test('machine stats group saved tokens by immutable model and reasoning-effort configuration', async () => {
  const home = freshHome();
  const snapshot = await recordGraftConfiguration({
    provider: 'openai', model: 'gpt-5.2-codex', reasoningEffort: 'high',
  }, home, {});
  assert.ok(snapshot);
  await recordInvocation({ command: 'ask', surface: 'cli', savedTokens: 700, configSnapshotId: snapshot! }, home);
  await recordInvocation({ command: 'map', surface: 'mcp', savedTokens: 300 }, home);

  const report = await readStatsReport({ home });
  assert.deepEqual(report.modelEfforts, [
    { provider: 'unknown', model: 'unknown', reasoningEffort: 'unknown', calls: 2, savedTokens: 1000 },
  ]);
  assert.match(formatStatsReport(report), /unknown\/unknown \(unknown\)/);
});

test('machine stats upgrade databases created before session IDs', async () => {
  const home = freshHome();
  const path = statsPath(home);
  mkdirSync(join(home, '.graft', 'stats'), { recursive: true });
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE invocations (
      id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      command TEXT NOT NULL,
      surface TEXT NOT NULL,
      repo_path TEXT,
      repo_name TEXT,
      host TEXT,
      hit INTEGER,
      ok INTEGER NOT NULL,
      duration_ms INTEGER,
      saved_tokens INTEGER NOT NULL DEFAULT 0,
      baseline_tokens INTEGER,
      output_tokens INTEGER,
      source_files INTEGER
    );
    INSERT INTO invocations (id, occurred_at, command, surface, ok, saved_tokens)
    VALUES ('old-row', '2026-01-01T00:00:00.000Z', 'map', 'cli', 1, 200);
  `);
  legacy.close();

  await recordInvocation({ command: 'ask', surface: 'cli', repo: '/work/alpha', savedTokens: 800, sessionId: 'session-1' }, home);

  const report = await readStatsReport({ home });
  assert.equal(report.calls, 2);
  assert.equal(report.sessions, 1);
  assert.equal(report.savedTokens, 1000);
});

test('Umzug migrations retain legacy calls and record the unified fact model', async () => {
  const home = freshHome();
  const first = await recordConfigurationSnapshot({
    domain: 'jev', schemaVersion: 1,
    settings: { reuseThreshold: 0.92, enabled: ['ask-rerank', 'deep-build-route'] },
  }, home);
  const same = await recordConfigurationSnapshot({
    domain: 'jev', schemaVersion: 1,
    settings: { enabled: ['ask-rerank', 'deep-build-route'], reuseThreshold: 0.92 },
  }, home);
  assert.ok(first);
  assert.equal(first, same, 'equivalent declared settings have one content-addressed snapshot');

  await recordHookRun({ repo: '/work/alpha', sessionId: 's1', host: 'claude-code', event: 'prompt', durationMs: 37, configSnapshotId: first! }, home);
  await recordToolObservation({ repo: '/work/alpha', sessionId: 's1', host: 'claude-code', kind: 'graft', savedTokens: 900, configSnapshotId: first! }, home);
  await recordDecisionRun({
    repo: '/work/alpha', sessionId: 's1', configSnapshotId: first!, kind: 'deep-build-route',
    phase: 'symbol-meaning', candidateCount: 2, durationMs: 14, fallback: false,
    items: [
      { key: 's0', action: 'reuse', hasPrior: true, reuseEligible: true, reuseApplied: true, confidence: 0.98 },
      { key: 's1', action: 'process', hasPrior: false },
    ],
  }, home);
  await recordSessionRollup({
    repo: '/work/alpha', sessionId: 's1', host: 'claude-code', graftReads: 1, sourceReads: 2,
    savedTokens: 900, graftTurns: 1, reportedTurns: 1,
  }, home);

  const db = new DatabaseSync(statsPath(home), { readOnly: true });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n, STATS_SCHEMA_VERSION);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM config_snapshots').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM hook_runs').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tool_observations').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM decision_runs').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM decision_items').get() as { n: number }).n, 2);
  assert.equal((db.prepare('SELECT reuse_applied FROM decision_items WHERE item_key = ?').get('s0') as { reuse_applied: number }).reuse_applied, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_rollups').get() as { n: number }).n, 1);
  db.close();
});
