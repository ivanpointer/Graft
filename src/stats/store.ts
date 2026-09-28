/**
 * Machine-local, exact usage statistics. This is deliberately independent of
 * telemetry: it never sends data, keeps the local repo path, and is useful
 * even when DO_NOT_TRACK is set.
 *
 * One short SQLite transaction is used per CLI/MCP invocation. Failure to open
 * or write the database is always swallowed; observing Graft must never make a
 * query fail.
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface Invocation {
  command: string;
  surface: 'cli' | 'mcp';
  repo?: string;
  host?: string;
  hit?: boolean;
  ok?: boolean;
  durationMs?: number;
  savedTokens?: number;
  baselineTokens?: number;
  outputTokens?: number;
  sourceFiles?: number;
  /** An agent-provided session identifier, when the host makes one available. */
  sessionId?: string;
}

export interface StatsReport {
  calls: number;
  successfulCalls: number;
  repos: number;
  sessions: number;
  savedTokens: number;
  avgSavedTokens: number;
  firstSeen: string | null;
  lastSeen: string | null;
  commands: Array<{ command: string; calls: number; savedTokens: number }>;
}

export function statsPath(home: string = homedir()): string {
  return join(home, '.graft', 'stats', 'v1.sqlite3');
}

const BACKUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * A backup destination is deliberately configuration, not a hard-coded cloud
 * provider.  It lets a managed machine choose an encrypted/synced location
 * without ever uploading telemetry from Graft itself.
 */
function statsBackupDir(): string | undefined {
  const dir = process.env.GRAFT_STATS_BACKUP_DIR?.trim();
  return dir && isAbsolute(dir) ? dir : undefined;
}

function sessionIdFromEnvironment(): string | undefined {
  const value = process.env.GRAFT_SESSION_ID
    ?? process.env.CLAUDE_SESSION_ID
    ?? process.env.CODEX_SESSION_ID
    ?? process.env.CURSOR_SESSION_ID;
  return value && value.length <= 512 ? value : undefined;
}

function restoreFromBackup(path: string): void {
  const backupDir = statsBackupDir();
  const backup = backupDir ? join(backupDir, 'v1.sqlite3') : undefined;
  if (!backup || existsSync(path) || !existsSync(backup)) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    copyFileSync(backup, path);
    chmodSync(path, 0o600);
  } catch { /* a missing or unreadable backup must not affect a query */ }
}

function open(home?: string): DatabaseSync {
  const path = statsPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  restoreFromBackup(path);
  const db = new DatabaseSync(path);
  // SQLite creates the file using the process umask. Tighten it explicitly so
  // a local report that includes repository paths is never world-readable.
  try { chmodSync(path, 0o600); } catch { /* a read-only home is handled by callers */ }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 100;
    CREATE TABLE IF NOT EXISTS invocations (
      id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      command TEXT NOT NULL,
      surface TEXT NOT NULL,
      repo_path TEXT,
      repo_name TEXT,
      session_id TEXT,
      host TEXT,
      hit INTEGER,
      ok INTEGER NOT NULL,
      duration_ms INTEGER,
      saved_tokens INTEGER NOT NULL DEFAULT 0,
      baseline_tokens INTEGER,
      output_tokens INTEGER,
      source_files INTEGER
    );
    CREATE INDEX IF NOT EXISTS invocations_occurred_at ON invocations(occurred_at);
    CREATE INDEX IF NOT EXISTS invocations_repo_path ON invocations(repo_path);
    CREATE INDEX IF NOT EXISTS invocations_session_id ON invocations(session_id);
    CREATE INDEX IF NOT EXISTS invocations_command ON invocations(command);
  `);
  const columns = db.prepare('PRAGMA table_info(invocations)').all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === 'session_id')) {
    db.exec('ALTER TABLE invocations ADD COLUMN session_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS invocations_session_id ON invocations(session_id)');
  }
  return db;
}

/** Atomically checkpoint and copy the database to the configured private backup. */
export function backupStats(home?: string): boolean {
  const backupDir = statsBackupDir();
  if (!backupDir) return false;
  try {
    const db = open(home);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    const source = statsPath(home);
    if (!existsSync(source)) return false;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const target = join(backupDir, 'v1.sqlite3');
    const temporary = join(backupDir, `.v1.sqlite3-${randomUUID()}.tmp`);
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    return true;
  } catch {
    return false;
  }
}

function maybeBackupStats(home?: string): void {
  const backupDir = statsBackupDir();
  if (!backupDir) return;
  try {
    const target = join(backupDir, 'v1.sqlite3');
    if (existsSync(target) && Date.now() - statSync(target).mtimeMs < BACKUP_INTERVAL_MS) return;
  } catch { /* attempt the backup below */ }
  backupStats(home);
}

/** Persist one exact local observation. Never throws. */
export function recordInvocation(invocation: Invocation, home?: string): void {
  let recorded = false;
  try {
    const db = open(home);
    try {
      db.prepare(`
        INSERT INTO invocations (
          id, occurred_at, command, surface, repo_path, repo_name, session_id, host, hit,
          ok, duration_ms, saved_tokens, baseline_tokens, output_tokens, source_files
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), new Date().toISOString(), invocation.command, invocation.surface,
        invocation.repo ?? null, invocation.repo ? basename(invocation.repo) : null,
        invocation.sessionId ?? sessionIdFromEnvironment() ?? null,
        invocation.host ?? null, invocation.hit === undefined ? null : Number(invocation.hit),
        Number(invocation.ok !== false), invocation.durationMs === undefined ? null : Math.round(invocation.durationMs),
        Math.max(0, Math.round(invocation.savedTokens ?? 0)),
        invocation.baselineTokens === undefined ? null : Math.max(0, Math.round(invocation.baselineTokens)),
        invocation.outputTokens === undefined ? null : Math.max(0, Math.round(invocation.outputTokens)),
        invocation.sourceFiles === undefined ? null : Math.max(0, Math.round(invocation.sourceFiles)),
      );
      recorded = true;
    } finally {
      db.close();
    }
  } catch { /* stats must never affect a graft command */ }
  if (recorded) maybeBackupStats(home);
}

/** Read a compact aggregate suitable for a terminal report. Never throws. */
export function readStatsReport(opts: { sinceDays?: number; home?: string } = {}): StatsReport {
  const empty: StatsReport = {
    calls: 0, successfulCalls: 0, repos: 0, sessions: 0, savedTokens: 0, avgSavedTokens: 0,
    firstSeen: null, lastSeen: null, commands: [],
  };
  try {
    const db = open(opts.home);
    try {
      const since = opts.sinceDays === undefined
        ? null
        : new Date(Date.now() - Math.max(0, opts.sinceDays) * 86_400_000).toISOString();
      const where = since ? 'WHERE occurred_at >= ?' : '';
      const args = since ? [since] : [];
      const totals = db.prepare(`
        SELECT COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS successfulCalls,
               COUNT(DISTINCT repo_path) AS repos, COUNT(DISTINCT session_id) AS sessions,
               COALESCE(SUM(saved_tokens), 0) AS savedTokens,
               MIN(occurred_at) AS firstSeen, MAX(occurred_at) AS lastSeen
        FROM invocations ${where}
      `).get(...args) as Record<string, unknown>;
      const commands = db.prepare(`
        SELECT command, COUNT(*) AS calls, COALESCE(SUM(saved_tokens), 0) AS savedTokens
        FROM invocations ${where}
        GROUP BY command ORDER BY savedTokens DESC, calls DESC, command ASC LIMIT 12
      `).all(...args) as Array<Record<string, unknown>>;
      const calls = Number(totals.calls ?? 0);
      const savedTokens = Number(totals.savedTokens ?? 0);
      return {
        calls,
        successfulCalls: Number(totals.successfulCalls ?? 0),
        repos: Number(totals.repos ?? 0),
        sessions: Number(totals.sessions ?? 0),
        savedTokens,
        avgSavedTokens: calls ? Math.round(savedTokens / calls) : 0,
        firstSeen: typeof totals.firstSeen === 'string' ? totals.firstSeen : null,
        lastSeen: typeof totals.lastSeen === 'string' ? totals.lastSeen : null,
        commands: commands.map((row) => ({
          command: String(row.command), calls: Number(row.calls), savedTokens: Number(row.savedTokens),
        })),
      };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

export function formatStatsReport(report: StatsReport): string {
  if (report.calls === 0) return 'graft machine stats: no recorded calls yet.';
  const lines = [
    'graft machine stats',
    `  calls:         ${report.calls.toLocaleString()} (${report.successfulCalls.toLocaleString()} successful)`,
    `  repos:         ${report.repos.toLocaleString()}`,
    `  sessions:      ${report.sessions.toLocaleString()} (when supplied by the host)`,
    `  tokens saved:  ~${report.savedTokens.toLocaleString()}`,
    `  avg per call:  ~${report.avgSavedTokens.toLocaleString()} tokens`,
    `  first seen:    ${report.firstSeen}`,
    `  last seen:     ${report.lastSeen}`,
  ];
  if (report.commands.length) {
    lines.push('  by command:');
    for (const row of report.commands) {
      lines.push(`    ${row.command.padEnd(12)} ${String(row.calls).padStart(5)} calls  ~${row.savedTokens.toLocaleString()} saved`);
    }
  }
  return lines.join('\n');
}
