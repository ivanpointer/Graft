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
import { basename, dirname, join } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Umzug, type MigrationParams, type UmzugStorage } from 'umzug';

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
  /** Immutable effective-settings snapshot for this operation, when available. */
  configSnapshotId?: string;
}

/** The latest local schema revision. Migrations are additive and idempotent. */
export const STATS_SCHEMA_VERSION = 5;

export interface ConfigurationSnapshot {
  /** `graft`, `harness`, or `jev`; keeps independent setting namespaces distinct. */
  domain: string;
  schemaVersion: number;
  /** Deliberately declared safe settings only — never an environment dump or secret. */
  settings: Record<string, unknown>;
}

export interface HookRun {
  repo?: string;
  sessionId?: string;
  host?: string;
  event: string;
  outcome?: 'ok' | 'error' | 'timeout' | 'skipped';
  durationMs?: number;
  timeoutMs?: number;
  errorCode?: string;
  configSnapshotId?: string;
  occurredAt?: string;
}

export interface ToolObservation {
  repo?: string;
  sessionId?: string;
  host?: string;
  /** Adoption signal only; savings remain authoritative on `invocations`. */
  kind: 'graft' | 'source';
  savedTokens?: number;
  configSnapshotId?: string;
  occurredAt?: string;
}

export type DecisionKind = 'ask-rerank' | 'crux-select' | 'edge-disambiguate' | 'meaning-validate' | 'deep-build-route';

export interface DecisionItem {
  key: string;
  action?: string;
  inputRank?: number;
  outputRank?: number;
  confidence?: number;
  /** Closed, caller-declared category; raw model prose must never enter the store. */
  reasonCode?: string;
  hasPrior?: boolean;
  reuseEligible?: boolean;
  reuseApplied?: boolean;
}

export interface DecisionRun {
  repo?: string;
  sessionId?: string;
  operationId?: string;
  configSnapshotId?: string;
  kind: DecisionKind;
  phase?: string;
  host?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  outcome?: 'ok' | 'error' | 'fallback';
  fallback?: boolean;
  candidateCount: number;
  usage?: Record<string, number>;
  items: readonly DecisionItem[];
  occurredAt?: string;
}

export interface SessionRollup {
  repo: string;
  sessionId: string;
  host?: string;
  graftReads: number;
  sourceReads: number;
  savedTokens: number;
  graftTurns?: number;
  reportedTurns?: number;
  inputCostMicros?: number;
  inputTokensBilled?: number;
  closedAt?: string;
  configSnapshotId?: string;
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

export function statsPath(home: string = process.env.GRAFT_STATS_HOME ?? homedir()): string {
  return join(home, '.graft', 'stats', 'v1.sqlite3');
}

function sessionIdFromEnvironment(): string | undefined {
  const value = process.env.GRAFT_SESSION_ID
    ?? process.env.CLAUDE_SESSION_ID
    ?? process.env.CODEX_SESSION_ID
    ?? process.env.CURSOR_SESSION_ID;
  return value && value.length <= 512 ? value : undefined;
}

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>)
    .flatMap((column) => column.name ? [column.name] : []));
}

function addColumn(db: DatabaseSync, table: string, name: string, definition: string): void {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

function migration1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invocations (
      id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, command TEXT NOT NULL, surface TEXT NOT NULL,
      repo_path TEXT, repo_name TEXT, session_id TEXT, host TEXT, hit INTEGER,
      ok INTEGER NOT NULL DEFAULT 1, duration_ms INTEGER, saved_tokens INTEGER NOT NULL DEFAULT 0,
      baseline_tokens INTEGER, output_tokens INTEGER, source_files INTEGER
    );
  `);
  addColumn(db, 'invocations', 'repo_name', 'TEXT');
  addColumn(db, 'invocations', 'session_id', 'TEXT');
  addColumn(db, 'invocations', 'host', 'TEXT');
  addColumn(db, 'invocations', 'hit', 'INTEGER');
  addColumn(db, 'invocations', 'ok', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'invocations', 'duration_ms', 'INTEGER');
  addColumn(db, 'invocations', 'saved_tokens', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'invocations', 'baseline_tokens', 'INTEGER');
  addColumn(db, 'invocations', 'output_tokens', 'INTEGER');
  addColumn(db, 'invocations', 'source_files', 'INTEGER');
  db.exec(`
    CREATE INDEX IF NOT EXISTS invocations_occurred_at ON invocations(occurred_at);
    CREATE INDEX IF NOT EXISTS invocations_repo_path ON invocations(repo_path);
    CREATE INDEX IF NOT EXISTS invocations_session_id ON invocations(session_id);
    CREATE INDEX IF NOT EXISTS invocations_command ON invocations(command);
  `);
}

function migration2(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config_snapshots (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      settings_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);
  addColumn(db, 'invocations', 'config_snapshot_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS invocations_config_snapshot_id ON invocations(config_snapshot_id)');
}

function migration3(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hook_runs (
      id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, repo_path TEXT, session_id TEXT, host TEXT,
      event TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, timeout_ms INTEGER,
      error_code TEXT, config_snapshot_id TEXT
    );
    CREATE INDEX IF NOT EXISTS hook_runs_occurred_at ON hook_runs(occurred_at);
    CREATE INDEX IF NOT EXISTS hook_runs_event ON hook_runs(event);
    CREATE INDEX IF NOT EXISTS hook_runs_session_id ON hook_runs(session_id);
    CREATE TABLE IF NOT EXISTS tool_observations (
      id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, repo_path TEXT, session_id TEXT, host TEXT,
      kind TEXT NOT NULL, saved_tokens INTEGER NOT NULL DEFAULT 0, config_snapshot_id TEXT
    );
    CREATE INDEX IF NOT EXISTS tool_observations_occurred_at ON tool_observations(occurred_at);
    CREATE INDEX IF NOT EXISTS tool_observations_session_id ON tool_observations(session_id);
  `);
}

function migration4(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_runs (
      id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, operation_id TEXT, repo_path TEXT, session_id TEXT,
      host TEXT, config_snapshot_id TEXT, kind TEXT NOT NULL, phase TEXT, provider TEXT, model TEXT,
      duration_ms INTEGER, outcome TEXT NOT NULL, fallback INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL, usage_json TEXT
    );
    CREATE INDEX IF NOT EXISTS decision_runs_occurred_at ON decision_runs(occurred_at);
    CREATE INDEX IF NOT EXISTS decision_runs_kind ON decision_runs(kind);
    CREATE INDEX IF NOT EXISTS decision_runs_config_snapshot_id ON decision_runs(config_snapshot_id);
    CREATE TABLE IF NOT EXISTS decision_items (
      decision_run_id TEXT NOT NULL, item_key TEXT NOT NULL, action TEXT, input_rank INTEGER,
      output_rank INTEGER, confidence REAL, reason_code TEXT, has_prior INTEGER,
      reuse_eligible INTEGER, reuse_applied INTEGER,
      PRIMARY KEY (decision_run_id, item_key)
    );
    CREATE INDEX IF NOT EXISTS decision_items_action ON decision_items(action);
  `);
}

function migration5(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_rollups (
      repo_path TEXT NOT NULL, session_id TEXT NOT NULL, host TEXT, closed_at TEXT NOT NULL,
      graft_reads INTEGER NOT NULL, source_reads INTEGER NOT NULL, saved_tokens INTEGER NOT NULL,
      graft_turns INTEGER, reported_turns INTEGER, input_cost_micros INTEGER,
      input_tokens_billed INTEGER, config_snapshot_id TEXT,
      PRIMARY KEY (repo_path, session_id)
    );
    CREATE INDEX IF NOT EXISTS session_rollups_closed_at ON session_rollups(closed_at);
  `);
}

interface MigrationContext { db: DatabaseSync; }

/** Umzug storage backed by the same local SQLite database we are migrating. */
class SqliteMigrationStorage implements UmzugStorage<MigrationContext> {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  }

  async logMigration({ name }: MigrationParams<MigrationContext>): Promise<void> {
    this.db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
  }

  async unlogMigration({ name }: MigrationParams<MigrationContext>): Promise<void> {
    this.db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(name);
  }

  async executed(): Promise<string[]> {
    return (this.db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>)
      .map((row) => row.name);
  }
}

const MIGRATIONS = [migration1, migration2, migration3, migration4, migration5].map((up, index) => ({
  name: `${String(index + 1).padStart(3, '0')}-stats-schema`,
  up: async ({ context }: MigrationParams<MigrationContext>) => {
    context.db.exec('BEGIN IMMEDIATE');
    try {
      up(context.db);
      context.db.exec('COMMIT');
    } catch (error) {
      try { context.db.exec('ROLLBACK'); } catch { /* preserve the migration error */ }
      throw error;
    }
  },
}));

async function migrate(db: DatabaseSync): Promise<void> {
  const migrator = new Umzug<MigrationContext>({
    migrations: MIGRATIONS,
    context: { db },
    storage: new SqliteMigrationStorage(db),
    logger: undefined,
  });
  await migrator.up();
}

function open(home?: string): DatabaseSync {
  const path = statsPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  // SQLite creates the file using the process umask. Tighten it explicitly so
  // a local report that includes repository paths is never world-readable.
  try { chmodSync(path, 0o600); } catch { /* a read-only home is handled by callers */ }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 500;
  `);
  return db;
}

async function withDatabase<T>(home: string | undefined, work: (db: DatabaseSync) => T): Promise<T> {
  const db = open(home);
  try {
    await migrate(db);
    return work(db);
  } finally {
    db.close();
  }
}

/** Persist one exact local observation. Never throws. */
export async function recordInvocation(invocation: Invocation, home?: string): Promise<void> {
  try {
    await withDatabase(home, (db) => {
      db.prepare(`
        INSERT INTO invocations (
          id, occurred_at, command, surface, repo_path, repo_name, session_id, host, hit,
          ok, duration_ms, saved_tokens, baseline_tokens, output_tokens, source_files, config_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        invocation.configSnapshotId ?? null,
      );
    });
  } catch { /* stats must never affect a graft command */ }
}

/** Stable JSON prevents semantically identical settings from fragmenting reports. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('configuration contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error('configuration must contain JSON values only');
}

function cleanText(value: string | undefined, limit: number): string | null {
  if (!value) return null;
  return value.slice(0, limit);
}

function whole(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : Math.round(value);
}

function nonNegative(value: number | undefined): number | null {
  const n = whole(value);
  return n === null ? null : Math.max(0, n);
}

/**
 * Store one declared, secret-free effective settings snapshot and return its
 * content address. Callers attach this ID to every operation and child fact.
 */
export async function recordConfigurationSnapshot(snapshot: ConfigurationSnapshot, home?: string): Promise<string | null> {
  try {
    const settings = canonicalJson(snapshot.settings);
    if (settings.length > 32_768) throw new Error('configuration snapshot exceeds 32 KiB');
    const domain = cleanText(snapshot.domain, 96);
    if (!domain || !Number.isInteger(snapshot.schemaVersion) || snapshot.schemaVersion < 1) {
      throw new Error('invalid configuration snapshot identity');
    }
    const id = createHash('sha256').update(`${domain}\n${snapshot.schemaVersion}\n${settings}`).digest('hex');
    const now = new Date().toISOString();
    await withDatabase(home, (db) => {
      db.prepare(`
        INSERT INTO config_snapshots (id, domain, schema_version, settings_json, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `).run(id, domain, snapshot.schemaVersion, settings, now, now);
    });
    return id;
  } catch { return null; }
}

/** Persist one host hook firing. This is hook health, not a savings record. */
export async function recordHookRun(run: HookRun, home?: string): Promise<void> {
  try {
    await withDatabase(home, (db) => {
      db.prepare(`
        INSERT INTO hook_runs (
          id, occurred_at, repo_path, session_id, host, event, outcome, duration_ms, timeout_ms,
          error_code, config_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), run.occurredAt ?? new Date().toISOString(), run.repo ?? null,
        cleanText(run.sessionId ?? sessionIdFromEnvironment(), 512), cleanText(run.host, 96),
        cleanText(run.event, 128) ?? 'unknown', run.outcome ?? 'ok', nonNegative(run.durationMs),
        nonNegative(run.timeoutMs), cleanText(run.errorCode, 96), run.configSnapshotId ?? null,
      );
    });
  } catch { /* a hook metric must never affect the host hook */ }
}

/** Persist a host-side read classification without duplicating invocation savings. */
export async function recordToolObservation(observation: ToolObservation, home?: string): Promise<void> {
  try {
    await withDatabase(home, (db) => {
      db.prepare(`
        INSERT INTO tool_observations (
          id, occurred_at, repo_path, session_id, host, kind, saved_tokens, config_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), observation.occurredAt ?? new Date().toISOString(), observation.repo ?? null,
        cleanText(observation.sessionId ?? sessionIdFromEnvironment(), 512), cleanText(observation.host, 96),
        observation.kind, Math.max(0, nonNegative(observation.savedTokens) ?? 0), observation.configSnapshotId ?? null,
      );
    });
  } catch { /* observations are strictly best-effort */ }
}

/** Persist a bounded JEV decision batch and its item-level actions atomically. */
export async function recordDecisionRun(run: DecisionRun, home?: string): Promise<void> {
  try {
    const id = randomUUID();
    const occurredAt = run.occurredAt ?? new Date().toISOString();
    await withDatabase(home, (db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
        INSERT INTO decision_runs (
          id, occurred_at, operation_id, repo_path, session_id, host, config_snapshot_id, kind, phase,
          provider, model, duration_ms, outcome, fallback, candidate_count, usage_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
        id, occurredAt, run.operationId ?? null, run.repo ?? null,
        cleanText(run.sessionId ?? sessionIdFromEnvironment(), 512), cleanText(run.host, 96),
        run.configSnapshotId ?? null, run.kind, cleanText(run.phase, 96), cleanText(run.provider, 96),
        cleanText(run.model, 256), nonNegative(run.durationMs), run.outcome ?? 'ok', Number(run.fallback === true),
        Math.max(0, Math.round(run.candidateCount)), run.usage ? canonicalJson(run.usage) : null,
        );
        const insert = db.prepare(`
        INSERT OR IGNORE INTO decision_items (
          decision_run_id, item_key, action, input_rank, output_rank, confidence, reason_code,
          has_prior, reuse_eligible, reuse_applied
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of run.items) {
          insert.run(
          id, cleanText(item.key, 512) ?? 'unknown', cleanText(item.action, 64), whole(item.inputRank),
          whole(item.outputRank), item.confidence === undefined || !Number.isFinite(item.confidence) ? null : item.confidence,
          cleanText(item.reasonCode, 96), item.hasPrior === undefined ? null : Number(item.hasPrior),
          item.reuseEligible === undefined ? null : Number(item.reuseEligible),
          item.reuseApplied === undefined ? null : Number(item.reuseApplied),
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* preserve the write error */ }
        throw error;
      }
    });
  } catch { /* a decision observer must never affect a JEV decision */ }
}

/** Upsert a final local session rollup independently of anonymous telemetry. */
export async function recordSessionRollup(rollup: SessionRollup, home?: string): Promise<void> {
  try {
    await withDatabase(home, (db) => {
      db.prepare(`
        INSERT INTO session_rollups (
          repo_path, session_id, host, closed_at, graft_reads, source_reads, saved_tokens, graft_turns,
          reported_turns, input_cost_micros, input_tokens_billed, config_snapshot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_path, session_id) DO UPDATE SET
          host = excluded.host, closed_at = excluded.closed_at, graft_reads = excluded.graft_reads,
          source_reads = excluded.source_reads, saved_tokens = excluded.saved_tokens,
          graft_turns = excluded.graft_turns, reported_turns = excluded.reported_turns,
          input_cost_micros = excluded.input_cost_micros, input_tokens_billed = excluded.input_tokens_billed,
          config_snapshot_id = excluded.config_snapshot_id
      `).run(
        rollup.repo, cleanText(rollup.sessionId, 512) ?? 'default', cleanText(rollup.host, 96),
        rollup.closedAt ?? new Date().toISOString(), Math.max(0, Math.round(rollup.graftReads)),
        Math.max(0, Math.round(rollup.sourceReads)), Math.max(0, Math.round(rollup.savedTokens)),
        nonNegative(rollup.graftTurns), nonNegative(rollup.reportedTurns), nonNegative(rollup.inputCostMicros),
        nonNegative(rollup.inputTokensBilled), rollup.configSnapshotId ?? null,
      );
    });
  } catch { /* local reporting must never affect session finalization */ }
}

/** Read a compact aggregate suitable for a terminal report. Never throws. */
export async function readStatsReport(opts: { sinceDays?: number; home?: string } = {}): Promise<StatsReport> {
  const empty: StatsReport = {
    calls: 0, successfulCalls: 0, repos: 0, sessions: 0, savedTokens: 0, avgSavedTokens: 0,
    firstSeen: null, lastSeen: null, commands: [],
  };
  try {
    return await withDatabase(opts.home, (db) => {
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
    });
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
