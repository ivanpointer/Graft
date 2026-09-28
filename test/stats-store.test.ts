import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStatsReport, readStatsReport, recordInvocation, statsPath } from '../src/stats/store.js';

function freshHome(): string { return mkdtempSync(join(tmpdir(), 'graft-stats-')); }

test('machine stats retain exact local call, repo, and savings totals', () => {
  const home = freshHome();
  recordInvocation({ command: 'ask', surface: 'cli', repo: '/work/alpha', ok: true, savedTokens: 1200, sessionId: 'agent-session-1' }, home);
  recordInvocation({ command: 'map', surface: 'mcp', repo: '/work/alpha', ok: true, savedTokens: 300, sessionId: 'agent-session-1' }, home);
  recordInvocation({ command: 'grep', surface: 'cli', repo: '/work/beta', ok: false, sessionId: 'agent-session-1' }, home);

  const report = readStatsReport({ home });
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

test('machine stats report a useful empty state', () => {
  assert.equal(formatStatsReport(readStatsReport({ home: freshHome() })), 'graft machine stats: no recorded calls yet.');
});
