import type { Budget, FactoryConfig } from './config.js';
import type { CheckState, Host } from './host/types.js';
import { compareReports } from './junit.js';
import { minutesBetween, type ReviewRow, type RunRow, type Usage } from './ledger.js';
import { firstMatch } from './paths.js';
import type { ChangedFile, Evidence, EvidenceKind, Tier } from './types.js';

/** The evidence bar per tier (spec section 5). */
export function requiredEvidence(tier: Tier, config: FactoryConfig): EvidenceKind[] {
  const kinds: EvidenceKind[] = ['checks', 'budget'];
  if (tier >= 1) {
    kinds.push('test_integrity', 'new_test', 'review');
    if (config.checks.holdout.length > 0) kinds.push('holdout');
  }
  if (tier >= 2) kinds.push('behavior');
  return kinds;
}

export interface CollectOptions {
  /** Wait up to this long for pending checks. Default 0: decide on what exists now. */
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CollectInput {
  host: Host;
  config: FactoryConfig;
  headSha: string;
  baseSha: string;
  files: readonly ChangedFile[];
  run?: RunRow;
  usage?: Usage;
  budget?: Budget;
  review?: ReviewRow;
  now: Date;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function settleChecks(host: Host, sha: string, names: string[], opts: CollectOptions, unverified: string[]): Promise<Map<string, CheckState>> {
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const rerun = new Set<string>();
  for (;;) {
    const all = await host.listChecks(sha);
    const byName = new Map(all.map((c) => [c.name, c]));
    let pending = false;
    for (const name of names) {
      const c = byName.get(name);
      if (!c || c.conclusion === 'pending') { pending = true; continue; }
      // A failed required check MAY be rerun once.
      if (c.conclusion === 'failure' && c.attempts === 1 && !rerun.has(name)) {
        rerun.add(name);
        await host.rerunCheck(sha, c);
        pending = true;
      }
    }
    if (!pending || Date.now() >= deadline) {
      if (pending) {
        // One last read so a rerun that already finished is seen.
        const again = new Map((await host.listChecks(sha)).map((c) => [c.name, c]));
        for (const [k, v] of again) byName.set(k, v);
      }
      for (const name of names) {
        const c = byName.get(name);
        if (c?.conclusion === 'success' && c.failedBefore) unverified.push(`Flaky check: \`${name}\` failed, then passed on rerun.`);
      }
      return byName;
    }
    await sleep(opts.pollMs ?? 15_000);
  }
}

function checkEvidence(kind: EvidenceKind, source: string, names: string[], states: Map<string, CheckState>): Evidence {
  const detail: Record<string, string> = {};
  for (const n of names) detail[n] = states.get(n)?.conclusion ?? 'missing';
  return { kind, met: names.length > 0 && names.every((n) => detail[n] === 'success'), source, detail };
}

/**
 * Collect every kind of evidence from its source. Nothing here reads the
 * change description or Worker output.
 */
export async function collectEvidence(input: CollectInput, opts: CollectOptions = {}): Promise<{ evidence: Evidence[]; unverified: string[] }> {
  const { host, config, headSha, baseSha, files, run, usage, budget, review } = input;
  const unverified: string[] = [];
  const evidence: Evidence[] = [];
  const src = host.kind;

  const names = [...new Set([...config.checks.required, ...config.checks.holdout, ...config.checks.behavior])];
  const states = await settleChecks(host, headSha, names, opts, unverified);

  evidence.push(checkEvidence('checks', `${src}:check-runs`, config.checks.required, states));

  if (run && usage && budget) {
    const minutes = minutesBetween(run.started_at, run.ended_at ?? input.now.toISOString());
    evidence.push({
      kind: 'budget', met: usage.cost_usd <= budget.usd_per_run && minutes <= budget.minutes_per_run, source: 'gateway',
      detail: { cost_usd: round(usage.cost_usd), limit_usd: budget.usd_per_run, minutes: round(minutes), limit_minutes: budget.minutes_per_run, requests: usage.requests },
    });
  } else {
    evidence.push({ kind: 'budget', met: false, source: 'gateway', detail: { reason: 'no factory run is recorded for this change' } });
  }

  const [baseReport, headReport] = await Promise.all([host.getTestReport(baseSha), host.getTestReport(headSha)]);
  if (baseReport && headReport) {
    const r = compareReports(baseReport, headReport);
    evidence.push({ kind: 'test_integrity', met: r.met, source: `${src}:test-report`, detail: { base: r.base, head: r.head, newly_skipped: r.newly_skipped.length, ...(r.newly_skipped.length ? { skipped: r.newly_skipped.slice(0, 20) } : {}) } });
  } else {
    evidence.push({ kind: 'test_integrity', met: false, source: `${src}:test-report`, detail: { reason: `no test report for the ${!baseReport ? 'base' : 'head'} commit` } });
  }

  const newTests = files.filter((f) => f.status === 'added' && firstMatch(config.append_only, f.path)).map((f) => f.path);
  evidence.push({ kind: 'new_test', met: newTests.length > 0, source: 'gate:diff', detail: { added: newTests.slice(0, 20) } });

  if (config.checks.holdout.length > 0) evidence.push(checkEvidence('holdout', `${src}:check-runs`, config.checks.holdout, states));

  if (review) {
    const familiesKnown = !!review.reviewer_family && !!review.runner_family;
    const distinct = familiesKnown && review.reviewer_family !== review.runner_family;
    evidence.push({
      kind: 'review', met: review.verdict === 'approve' && distinct && review.fresh_context, source: review.reviewer,
      detail: { verdict: review.verdict, reviewer_family: review.reviewer_family, runner_family: review.runner_family, fresh_context: review.fresh_context,
        ...(distinct ? {} : { reason: 'reviewer shares a model family with the runner, or a family is unknown' }) },
    });
  } else {
    evidence.push({ kind: 'review', met: false, source: config.roles.reviewer.use, detail: { reason: 'no review recorded for the head commit' } });
  }

  if (config.checks.behavior.length > 0) evidence.push(checkEvidence('behavior', `${src}:check-runs`, config.checks.behavior, states));
  else evidence.push({ kind: 'behavior', met: false, source: `${src}:check-runs`, detail: { reason: 'no behavior checks are configured' } });

  return { evidence, unverified };
}

const round = (n: number) => Math.round(n * 100) / 100;
