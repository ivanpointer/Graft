import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
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

test('machine stats attribute invocation savings only to correlated, observed host metadata', async () => {
  const home = freshHome();
  const snapshot = await recordConfigurationSnapshot({
    domain: 'graft', schemaVersion: 1, settings: { model: 'configured-graft-model' },
    dimensions: { harness: { provider: 'configured', model: 'not-observed', reasoningEffort: 'high' } },
  }, home);
  assert.ok(snapshot);
  const invocationId = await recordInvocation({ command: 'ask', surface: 'cli', savedTokens: 700, configSnapshotId: snapshot! }, home);
  assert.match(invocationId!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await recordToolObservation({
    host: 'codex', sessionId: 's1', turnId: 't1', toolUseId: 'u1', kind: 'graft',
    invocationId: invocationId!, savedTokens: 700, provider: 'openai', model: 'observed-host-model',
    reasoningEffort: 'medium', metadataSource: 'host-payload',
  }, home);
  await recordToolObservation({
    host: 'codex', sessionId: 's1', turnId: 't1', toolUseId: 'u1', kind: 'graft',
    invocationId: invocationId!, savedTokens: 700, metadataSource: 'host-payload', model: 'retry',
  }, home);
  await recordToolObservation({
    host: 'codex', sessionId: 's1', turnId: 't1', toolUseId: 'u2', kind: 'graft',
    invocationId: invocationId!, savedTokens: 700, metadataSource: 'host-payload', model: 'retry',
  }, home);
  const otherInvocationId = await recordInvocation({ command: 'map', surface: 'mcp', savedTokens: 300 }, home);
  await recordToolObservation({
    host: 'codex', kind: 'graft', invocationId: otherInvocationId!, toolUseId: 'u4',
    model: 'unproven-model',
  }, home);
  await recordToolObservation({
    host: 'codex', sessionId: 's1', toolUseId: 'u3', kind: 'graft',
    metadataSource: 'host-payload', model: 'unlinked-host-model',
  }, home);
  await recordToolObservation({ host: 'cursor', toolUseId: 'source-1', kind: 'source' }, home);
  await recordToolObservation({ host: 'cursor', toolUseId: 'source-1', kind: 'source' }, home);

  const report = await readStatsReport({ home });
  assert.deepEqual(report.modelEfforts, [
    { provider: 'openai', model: 'observed-host-model', reasoningEffort: 'medium', calls: 1, savedTokens: 700 },
    { provider: 'unknown', model: 'unknown', reasoningEffort: 'unknown', calls: 1, savedTokens: 300 },
  ]);
  assert.equal(report.savedTokens, 1000, 'host observation savings are never added to invocation savings');
  const db = new DatabaseSync(statsPath(home), { readOnly: true });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tool_observations').get() as { n: number }).n, 4);
  db.close();
});

test('invocation recording returns null when the best-effort database write fails', async () => {
  const home = freshHome();
  const invalidHome = join(home, 'file');
  writeFileSync(invalidHome, '');
  assert.equal(await recordInvocation({ command: 'ask', surface: 'cli' }, invalidHome), null);
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
    CREATE TABLE tool_observations (
      id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, repo_path TEXT, session_id TEXT, host TEXT,
      kind TEXT NOT NULL, saved_tokens INTEGER NOT NULL DEFAULT 0, config_snapshot_id TEXT
    );
    INSERT INTO tool_observations (id, occurred_at, host, kind, saved_tokens)
    VALUES ('old-observation', '2026-01-01T00:00:00.000Z', 'codex', 'graft', 200);
  `);
  legacy.close();

  await recordInvocation({ command: 'ask', surface: 'cli', repo: '/work/alpha', savedTokens: 800, sessionId: 'session-1' }, home);

  const report = await readStatsReport({ home });
  assert.equal(report.calls, 2);
  assert.equal(report.sessions, 1);
  assert.equal(report.savedTokens, 1000);
  assert.deepEqual(report.modelEfforts, [
    { provider: 'unknown', model: 'unknown', reasoningEffort: 'unknown', calls: 2, savedTokens: 1000 },
  ]);
  const db = new DatabaseSync(path, { readOnly: true });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tool_observations WHERE id = ?').get('old-observation') as { n: number }).n, 1);
  db.close();
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
