import { randomInt } from 'node:crypto';
import { classify, type Classification } from './classify.js';
import { CONFIG_PATH, ConfigError, effectiveBudget, parseFactoryConfig, type FactoryConfig } from './config.js';
import { collectEvidence, requiredEvidence, type CollectOptions } from './evidence.js';
import type { Change, Host } from './host/types.js';
import { minutesBetween, type Ledger, type RunRow, type Store } from './ledger.js';
import { buildStatement, renderReceiptComment, type ReceiptPredicate, type SignedReceipt, type Signer, type Statement } from './receipt.js';
import { hasStanding } from './standing.js';
import type { DecisionValue, Evidence, EvidenceKind, RunState, Tier } from './types.js';

export interface GateDeps {
  host: Host;
  ledger: Ledger;
  store: Store;
  /** Required before any automatic merge. */
  signer?: Signer;
  /** Uniform draw in [0, 1) for audit sampling. Defaults to the OS CSPRNG, which the Worker cannot predict. */
  random?: () => number;
  now?: () => Date;
}

export interface GateOptions extends CollectOptions {
  /** Post the receipt summary on the change. Default true. */
  comment?: boolean;
}

export interface GateResult {
  statement: Statement;
  signed?: SignedReceipt;
  decision: DecisionValue;
  merged: boolean;
  mergeSha?: string;
}

export interface DecisionInput {
  configError?: string;
  mode: 'shadow' | 'earned';
  tier: Tier;
  /** Why the change has this tier; shown when the tier itself forces escalation. */
  because?: string[];
  outOfScope: string[];
  hasWorkOrder: boolean;
  required: EvidenceKind[];
  evidence: Evidence[];
  standing: boolean;
  auditRate: number;
  /** Called at most once, and only when the change would otherwise merge. */
  draw: () => number;
  canSign: boolean;
}

export interface Decision { value: DecisionValue; reason: string; audit: boolean }

/** The decision procedure of spec section 7, steps 1 and 4 to 8. Pure apart from the audit draw. */
export function decide(i: DecisionInput): Decision {
  const esc = (reason: string): Decision => ({ value: 'escalate', reason, audit: false });
  if (i.configError) return esc(`Factory config on the base branch is missing or invalid: ${i.configError}`);
  if (!i.hasWorkOrder) return esc('No work order is recorded for this change, so its scope cannot be checked.');
  if (i.outOfScope.length > 0) return esc(`Change touches paths outside the work order's scope: ${i.outOfScope.slice(0, 5).join(', ')}.`);
  const met = new Set(i.evidence.filter((e) => e.met).map((e) => e.kind));
  const missing = i.required.filter((k) => !met.has(k));
  if (i.tier >= 2) {
    const why = i.because?.[0] ? ` (${i.because[0]})` : '';
    return esc(`Tier ${i.tier} always goes to a person${why}. ${missing.length ? `Missing evidence: ${missing.join(', ')}.` : `Evidence bar met: ${i.required.join(', ')}.`}`);
  }
  if (missing.length > 0) return esc(`Tier ${i.tier} bar not met; missing evidence: ${missing.join(', ')}.`);
  if (i.mode === 'shadow') return { value: 'would_merge', reason: `Tier ${i.tier} bar met; shadow mode, so a person decides.`, audit: false };
  if (!i.standing) return { value: 'would_merge', reason: `Tier ${i.tier} bar met; the repository has not earned standing at this tier.`, audit: false };
  if (i.draw() < i.auditRate) return { value: 'would_merge', reason: `Tier ${i.tier} bar met; selected for audit, so a person decides.`, audit: true };
  if (!i.canSign) return { value: 'would_merge', reason: `Tier ${i.tier} bar met and standing held, but no receipt signer is configured, so the Gate will not merge.`, audit: false };
  return { value: 'merge', reason: `Tier ${i.tier} bar met; standing held.`, audit: false };
}

const defaultRandom = () => randomInt(0, 2 ** 32) / 2 ** 32;

function receiptId(ledger: Ledger, run: RunRow | undefined, change: Change): string {
  const base = run ? run.id : `adhoc-${change.number}-${change.headSha.slice(0, 7)}`;
  if (!ledger.receipt(base)) return base;
  for (let n = 2; ; n++) if (!ledger.receipt(`${base}.${n}`)) return `${base}.${n}`;
}

function runBlock(run: RunRow | undefined, config: FactoryConfig | undefined, cost: number, now: Date, state: RunState, audit: boolean): ReceiptPredicate['run'] {
  return {
    attempt: run?.attempt ?? 0,
    runner: run?.runner ?? config?.roles.runner.use ?? 'unknown',
    runner_model: run?.runner_model ?? 'unknown',
    reviewer: run?.reviewer ?? config?.roles.reviewer.use ?? 'unknown',
    reviewer_model: run?.reviewer_model ?? 'unknown',
    cost_usd: Math.round(cost * 10000) / 10000,
    minutes: Math.round(minutesBetween(run?.started_at ?? null, run?.ended_at ?? now.toISOString()) * 10) / 10,
    state, audit,
  };
}

/**
 * Evaluate one change: load config from the base branch, classify, collect
 * evidence, decide, write the receipt, and only then merge.
 */
export async function gate(deps: GateDeps, number: number, opts: GateOptions = {}): Promise<GateResult> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await evaluate(deps, number, opts);
    if (result) return result;
  }
  throw new Error(`change ${number} kept moving while it was being evaluated`);
}

async function evaluate(deps: GateDeps, number: number, opts: GateOptions): Promise<GateResult | null> {
  const { host, ledger, store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const change = await host.getChange(number);
  if (change.state !== 'open') throw new Error(`change ${number} is ${change.state}; the Gate only evaluates open changes`);

  const run = store.latestRunForChange(host.repo, number);
  const existing = run ? ledger.receipt(run.id) : undefined;
  if (existing && existing.record.statement.subject[0]?.digest.gitCommit === change.headSha) {
    // Already decided for this exact commit: the receipt is immutable, so return it.
    const st = existing.record.statement;
    return { statement: st, signed: existing.record.signed, decision: st.predicate.decision.value, merged: false };
  }

  // 1. Config from the base branch, never from the change.
  let config: FactoryConfig | undefined;
  let configError: string | undefined;
  try {
    const text = await host.readFile(CONFIG_PATH, change.baseRef);
    if (text === null) configError = `${CONFIG_PATH} does not exist on ${change.baseRef}`;
    else config = parseFactoryConfig(text);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    configError = e.message;
  }

  // 2. Classify. 3. Collect evidence for the current head commit.
  const files = await host.listFiles(number);
  let cls: Classification = { tier: 3, because: ['factory config missing or invalid'], lines: 0, files: files.length, outOfScope: [] };
  let evidence: Evidence[] = [];
  let unverified: string[] = [];
  let required: EvidenceKind[] = [];
  let cost = 0;
  if (config) {
    cls = classify(config, files, run?.work_order.scope.paths);
    const usage = run ? store.usage(run.id) : undefined;
    cost = usage?.cost_usd ?? 0;
    const collected = await collectEvidence({
      host, config, headSha: change.headSha, baseSha: change.baseSha, files, run, usage,
      budget: run ? effectiveBudget(config, run.work_order) : undefined,
      review: store.getReview(host.repo, number, change.headSha), now,
    }, opts);
    evidence = collected.evidence;
    unverified = collected.unverified;
    required = requiredEvidence(cls.tier, config);
    const met = new Set(evidence.filter((e) => e.met).map((e) => e.kind));
    if (!required.includes('behavior') || !met.has('behavior')) unverified.push('No integration or browser run exercised this change.');
    if (config.checks.holdout.length === 0 && cls.tier >= 1) unverified.push('No holdout checks are configured; the Worker could read every test that judged it.');
    if (!met.has('test_integrity')) unverified.push('Could not confirm that the head ran every test the base ran.');
  } else {
    unverified.push('Nothing was verified: the factory config could not be loaded.');
  }

  // 4 to 7. Decide.
  const tierForStanding = cls.tier;
  const decision = decide({
    configError, mode: config?.autonomy.mode ?? 'shadow', tier: cls.tier, because: cls.because, outOfScope: cls.outOfScope, hasWorkOrder: !!run,
    required, evidence, standing: !!config && hasStanding(ledger, host.repo, tierForStanding),
    auditRate: config?.autonomy.audit_rate ?? 1, draw: deps.random ?? defaultRandom, canSign: !!deps.signer,
  });

  // 8. The head must still be the commit that was evaluated.
  const again = await host.getChange(number);
  if (again.headSha !== change.headSha || again.state !== 'open') return null;

  const state: RunState = decision.value === 'merge' ? 'merged' : 'escalated';
  const predicate: ReceiptPredicate = {
    id: receiptId(ledger, run, change),
    work_order: run?.work_order.id ?? null,
    issued_at: now.toISOString(),
    change: { host: host.kind, repo: host.repo, number, base: change.baseSha },
    run: runBlock(run, config, cost, now, state, decision.audit),
    tier: { value: cls.tier, because: cls.because },
    evidence, unverified,
    decision: { value: decision.value, mode: config?.autonomy.mode ?? 'shadow', reason: decision.reason },
  };
  const statement = buildStatement(host.subjectName(), change.headSha, predicate);

  // Sign before any automatic merge, and write the receipt before merging. No receipt, no merge.
  const signed = decision.value === 'merge' ? await deps.signer!.sign(statement) : undefined;
  ledger.writeReceipt(statement, signed);
  if (run) store.updateRun(run.id, { state, head_sha: change.headSha, base_sha: change.baseSha, ended_at: run.ended_at ?? now.toISOString() });

  let merged = false;
  let mergeSha: string | undefined;
  if (decision.value === 'merge') {
    const res = await host.merge(number, change.headSha);
    merged = res.merged;
    mergeSha = res.sha;
    if (!res.merged) {
      ledger.writeOutcome({
        receipt_id: predicate.id, repo: host.repo, change: number, tier: cls.tier, result: 'merge_refused', merged_by: null, human: null,
        flaky: [], note: res.reason ?? 'the host refused the pinned merge', at: now.toISOString(),
      });
      if (run) store.updateRun(run.id, { state: 'escalated' });
    }
  }

  if (opts.comment !== false) {
    try { await host.comment(number, renderReceiptComment(statement, signed)); } catch { /* a failed comment never changes the decision */ }
  }
  return { statement, signed, decision: decision.value, merged, mergeSha };
}

/** Every run, including an abandoned one, produces a receipt. */
export function recordAbandoned(deps: Pick<GateDeps, 'host' | 'ledger' | 'store' | 'now'>, run: RunRow, config: FactoryConfig, reason: string, baseSha: string): Statement {
  const now = (deps.now ?? (() => new Date()))();
  const usage = deps.store.usage(run.id);
  const ended = deps.store.updateRun(run.id, { state: 'abandoned', ended_at: run.ended_at ?? now.toISOString() });
  const predicate: ReceiptPredicate = {
    id: run.id, work_order: run.work_order.id, issued_at: now.toISOString(),
    change: { host: deps.host.kind, repo: deps.host.repo, number: run.change, base: baseSha },
    run: runBlock(ended, config, usage.cost_usd, now, 'abandoned', false),
    tier: { value: config.tiers.default, because: ['run abandoned before classification'] },
    evidence: [{ kind: 'budget', met: false, source: 'gateway', detail: { cost_usd: usage.cost_usd, requests: usage.requests } }],
    unverified: ['The run was abandoned; nothing about the change was verified.'],
    decision: { value: 'abandon', mode: config.autonomy.mode, reason },
  };
  const statement = buildStatement(deps.host.subjectName(), run.head_sha ?? baseSha, predicate);
  deps.ledger.writeReceipt(statement);
  return statement;
}

/**
 * A revert may merge automatically only when it is the exact inverse of a
 * factory-merged commit: the tree after the revert equals the tree before the merge.
 */
export async function gateRevert(deps: GateDeps, revertChange: number, mergeSha: string): Promise<{ merged: boolean; reason: string }> {
  const { host, ledger } = deps;
  let factoryMerged = false;
  for (const r of ledger.receipts(host.repo)) {
    const p = r.record.statement.predicate;
    if (p.decision.value !== 'merge' || p.change.number === null) continue;
    if ((await host.getChange(p.change.number)).mergeSha === mergeSha) { factoryMerged = true; break; }
  }
  if (!factoryMerged) return { merged: false, reason: 'the ledger records no factory merge of that commit' };
  const change = await host.getChange(revertChange);
  const [revert, merge] = await Promise.all([host.getCommit(change.headSha), host.getCommit(mergeSha)]);
  if (!merge.parents[0]) return { merged: false, reason: 'the merge commit has no parent' };
  const before = await host.getCommit(merge.parents[0]);
  if (revert.treeSha !== before.treeSha) return { merged: false, reason: 'the revert is not the exact inverse of the merge commit; a person must review it' };
  const res = await host.merge(revertChange, change.headSha);
  return { merged: res.merged, reason: res.merged ? 'exact inverse of a factory-merged commit' : (res.reason ?? 'merge refused') };
}
