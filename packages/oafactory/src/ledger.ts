import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SignedReceipt, Statement } from './receipt.js';
import type { RunState, Tier, WorkOrder } from './types.js';

export function defaultLedgerPath(): string {
  return process.env.OAFACTORY_LEDGER ?? join(homedir(), '.oafactory', 'ledger.db');
}

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return db;
}

export interface ReceiptRecord { kind: 'receipt'; statement: Statement; signed?: SignedReceipt }
export type OutcomeResult = 'held' | 'reverted' | 'failed' | 'closed' | 'merge_refused';
export interface OutcomeRecord {
  kind: 'outcome';
  receipt_id: string;
  repo: string;
  change: number | null;
  tier: Tier;
  result: OutcomeResult;
  /** Who merged the change, if anyone. */
  merged_by: 'factory' | 'person' | null;
  /** For would-merge decisions: did the person's action agree with the Gate? */
  human: 'agree' | 'disagree' | null;
  merge_sha?: string;
  flaky: string[];
  note?: string;
  at: string;
}
export interface StandingRecord {
  kind: 'standing';
  repo: string;
  tier: Tier;
  standing: boolean;
  reason: string;
  confirmed_by?: string;
  at: string;
}
export type LedgerRecord = ReceiptRecord | OutcomeRecord | StandingRecord;
export interface Stored<T> { seq: number; id: string; repo: string; at: string; record: T }

/**
 * The storage interface both backends sit behind (spec section 10).
 * SQLite is the reference backend; Postgres would implement the same four methods.
 */
export interface LedgerBackend {
  append(repo: string, id: string, at: string, record: LedgerRecord): number;
  list<T extends LedgerRecord>(kind: T['kind'], repo?: string): Array<Stored<T>>;
  get<T extends LedgerRecord>(kind: T['kind'], id: string): Stored<T> | undefined;
  all(): Array<Stored<LedgerRecord>>;
}

export class SqliteLedger implements LedgerBackend {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, repo TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL,
        UNIQUE (kind, id)
      );
      CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records
        BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records
        BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
    `);
  }
  append(repo: string, id: string, at: string, record: LedgerRecord): number {
    const r = this.db.prepare('INSERT INTO records (kind, repo, id, at, body) VALUES (?, ?, ?, ?, ?)')
      .run(record.kind, repo, id, at, JSON.stringify(record));
    return Number(r.lastInsertRowid);
  }
  private row<T>(r: Record<string, unknown>): Stored<T> {
    return { seq: Number(r.seq), id: String(r.id), repo: String(r.repo), at: String(r.at), record: JSON.parse(String(r.body)) as T };
  }
  list<T extends LedgerRecord>(kind: T['kind'], repo?: string): Array<Stored<T>> {
    const rows = repo
      ? this.db.prepare('SELECT * FROM records WHERE kind = ? AND repo = ? ORDER BY seq').all(kind, repo)
      : this.db.prepare('SELECT * FROM records WHERE kind = ? ORDER BY seq').all(kind);
    return rows.map((r) => this.row<T>(r as Record<string, unknown>));
  }
  get<T extends LedgerRecord>(kind: T['kind'], id: string): Stored<T> | undefined {
    const r = this.db.prepare('SELECT * FROM records WHERE kind = ? AND id = ?').get(kind, id);
    return r ? this.row<T>(r as Record<string, unknown>) : undefined;
  }
  all(): Array<Stored<LedgerRecord>> {
    return this.db.prepare('SELECT * FROM records ORDER BY seq').all().map((r) => this.row<LedgerRecord>(r as Record<string, unknown>));
  }
}

/** Append-only record store: receipts, outcomes and standing. */
export class Ledger {
  readonly backend: LedgerBackend;
  constructor(dbOrBackend: DatabaseSync | LedgerBackend) {
    this.backend = dbOrBackend instanceof DatabaseSync ? new SqliteLedger(dbOrBackend) : dbOrBackend;
  }
  writeReceipt(statement: Statement, signed?: SignedReceipt): void {
    const p = statement.predicate;
    this.backend.append(p.change.repo, p.id, p.issued_at, { kind: 'receipt', statement, ...(signed ? { signed } : {}) });
  }
  writeOutcome(o: Omit<OutcomeRecord, 'kind'>): void {
    this.backend.append(o.repo, o.receipt_id, o.at, { kind: 'outcome', ...o });
  }
  writeStanding(s: Omit<StandingRecord, 'kind'>): void {
    const n = this.backend.list('standing', s.repo).length;
    this.backend.append(s.repo, `${s.repo}#${s.tier}#${n}`, s.at, { kind: 'standing', ...s });
  }
  receipt(id: string) { return this.backend.get<ReceiptRecord>('receipt', id); }
  outcome(receiptId: string) { return this.backend.get<OutcomeRecord>('outcome', receiptId); }
  receipts(repo?: string) { return this.backend.list<ReceiptRecord>('receipt', repo); }
  outcomes(repo?: string) { return this.backend.list<OutcomeRecord>('outcome', repo); }
  standings(repo?: string) { return this.backend.list<StandingRecord>('standing', repo); }
  /** Every record as JSON Lines, in the order written. */
  exportJsonl(): string {
    return this.backend.all().map((r) => JSON.stringify({ seq: r.seq, ...r.record })).join('\n') + '\n';
  }
}

// --- Operational state. Mutable, and separate from the append-only ledger tables. ---

export interface RunRow {
  id: string;
  repo: string;
  work_order: WorkOrder;
  attempt: number;
  state: RunState;
  change: number | null;
  base_sha: string | null;
  head_sha: string | null;
  runner: string; runner_model: string; runner_family: string;
  reviewer: string; reviewer_model: string; reviewer_family: string;
  budget_usd: number; budget_minutes: number;
  started_at: string | null;
  ended_at: string | null;
}
export interface ReviewRow {
  repo: string; change: number; head_sha: string;
  verdict: 'approve' | 'request_changes';
  comments: string[];
  reviewer: string; reviewer_model: string; reviewer_family: string; runner_family: string;
  fresh_context: boolean;
  at: string;
}
export interface Usage { cost_usd: number; input_tokens: number; output_tokens: number; requests: number }

export class Store {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, change INTEGER, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (repo TEXT NOT NULL, change INTEGER NOT NULL, head_sha TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (repo, change, head_sha));
      CREATE TABLE IF NOT EXISTS usage (run_id TEXT NOT NULL, at TEXT NOT NULL, model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS run_keys (key_hash TEXT PRIMARY KEY, run_id TEXT NOT NULL, budget_usd REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    `);
  }
  putRun(run: RunRow): void {
    this.db.prepare('INSERT INTO runs (id, repo, change, body) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET change = excluded.change, body = excluded.body')
      .run(run.id, run.repo, run.change, JSON.stringify(run));
  }
  getRun(id: string): RunRow | undefined {
    const r = this.db.prepare('SELECT body FROM runs WHERE id = ?').get(id) as { body: string } | undefined;
    return r ? (JSON.parse(r.body) as RunRow) : undefined;
  }
  updateRun(id: string, patch: Partial<RunRow>): RunRow {
    const cur = this.getRun(id);
    if (!cur) throw new Error(`unknown run ${id}`);
    const next = { ...cur, ...patch };
    this.putRun(next);
    return next;
  }
  latestRunForChange(repo: string, change: number): RunRow | undefined {
    const r = this.db.prepare('SELECT body FROM runs WHERE repo = ? AND change = ? ORDER BY rowid DESC LIMIT 1').get(repo, change) as { body: string } | undefined;
    return r ? (JSON.parse(r.body) as RunRow) : undefined;
  }
  runs(repo?: string): RunRow[] {
    const rows = repo ? this.db.prepare('SELECT body FROM runs WHERE repo = ? ORDER BY rowid').all(repo) : this.db.prepare('SELECT body FROM runs ORDER BY rowid').all();
    return rows.map((r) => JSON.parse((r as { body: string }).body) as RunRow);
  }
  putReview(r: ReviewRow): void {
    this.db.prepare('INSERT OR REPLACE INTO reviews (repo, change, head_sha, body) VALUES (?, ?, ?, ?)').run(r.repo, r.change, r.head_sha, JSON.stringify(r));
  }
  getReview(repo: string, change: number, headSha: string): ReviewRow | undefined {
    const r = this.db.prepare('SELECT body FROM reviews WHERE repo = ? AND change = ? AND head_sha = ?').get(repo, change, headSha) as { body: string } | undefined;
    return r ? (JSON.parse(r.body) as ReviewRow) : undefined;
  }
  addUsage(runId: string, model: string, input: number, output: number, cost: number, at = new Date().toISOString()): void {
    this.db.prepare('INSERT INTO usage (run_id, at, model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?)').run(runId, at, model, input, output, cost);
  }
  usage(runId: string): Usage {
    const r = this.db.prepare('SELECT COALESCE(SUM(cost_usd),0) c, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COUNT(*) n FROM usage WHERE run_id = ?').get(runId) as { c: number; i: number; o: number; n: number };
    return { cost_usd: r.c, input_tokens: r.i, output_tokens: r.o, requests: r.n };
  }
  putKey(keyHash: string, runId: string, budgetUsd: number): void {
    this.db.prepare('INSERT INTO run_keys (key_hash, run_id, budget_usd) VALUES (?, ?, ?)').run(keyHash, runId, budgetUsd);
  }
  getKey(keyHash: string): { run_id: string; budget_usd: number; revoked: boolean } | undefined {
    const r = this.db.prepare('SELECT run_id, budget_usd, revoked FROM run_keys WHERE key_hash = ?').get(keyHash) as { run_id: string; budget_usd: number; revoked: number } | undefined;
    return r ? { run_id: r.run_id, budget_usd: r.budget_usd, revoked: !!r.revoked } : undefined;
  }
  revokeKeys(runId: string): void {
    this.db.prepare('UPDATE run_keys SET revoked = 1 WHERE run_id = ?').run(runId);
  }
}

export function minutesBetween(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  return Math.max(0, (Date.parse(b) - Date.parse(a)) / 60_000);
}
