import type { Ledger } from './ledger.js';
import type { Tier } from './types.js';

export interface Scoreboard {
  work_orders: number;
  runs: number;
  accepted: number;
  first_attempt_accept_rate: number | null;
  cost_per_accepted_change: number | null;
  escalations_per_accepted_change: number | null;
  by_tier: Array<{ tier: Tier; would_merge: number; merged: number; held: number; reverted: number; agreement: number | null; revert_rate: number | null }>;
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

/** The scoreboard of spec section 10, computed from the Ledger alone. */
export function scoreboard(ledger: Ledger, repo?: string): Scoreboard {
  const receipts = ledger.receipts(repo).map((r) => r.record.statement.predicate);
  const outcomes = new Map(ledger.outcomes(repo).map((o) => [o.record.receipt_id, o.record]));
  const workOrders = new Set(receipts.map((r) => r.work_order).filter((w): w is string => w !== null));
  const held = receipts.filter((r) => outcomes.get(r.id)?.result === 'held');
  // Merged on attempt 1 with no human commits: a factory merge, or a would-merge the person merged unchanged.
  const firstAttempt = receipts.filter((r) => r.run.attempt === 1 && (
    (r.decision.value === 'merge' && outcomes.get(r.id)?.result !== 'merge_refused')
    || (r.decision.value === 'would_merge' && outcomes.get(r.id)?.human === 'agree')));
  const cost = receipts.reduce((n, r) => n + r.run.cost_usd, 0);
  const escalated = receipts.filter((r) => r.run.state === 'escalated').length;

  const by_tier = ([0, 1, 2, 3] as Tier[]).map((tier) => {
    const at = receipts.filter((r) => r.tier.value === tier);
    const o = at.map((r) => outcomes.get(r.id)).filter((x) => x !== undefined);
    const merged = o.filter((x) => x.merged_by !== null);
    const judged = o.filter((x) => x.human !== null);
    const reverted = merged.filter((x) => x.result === 'reverted').length;
    return {
      tier, would_merge: at.filter((r) => r.decision.value === 'would_merge').length, merged: merged.length,
      held: merged.filter((x) => x.result === 'held').length, reverted,
      agreement: ratio(judged.filter((x) => x.human === 'agree').length, judged.length),
      revert_rate: ratio(reverted, merged.length),
    };
  });

  return {
    work_orders: workOrders.size, runs: receipts.length, accepted: held.length,
    first_attempt_accept_rate: ratio(new Set(firstAttempt.map((r) => r.work_order)).size, workOrders.size),
    cost_per_accepted_change: ratio(cost, held.length),
    escalations_per_accepted_change: ratio(escalated, held.length),
    by_tier,
  };
}
