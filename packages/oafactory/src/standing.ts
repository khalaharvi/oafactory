import type { FactoryConfig } from './config.js';
import type { Ledger, OutcomeRecord, ReceiptRecord, Stored } from './ledger.js';
import type { Tier } from './types.js';

export function hasStanding(ledger: Ledger, repo: string, tier: Tier): boolean {
  const recs = ledger.standings(repo).filter((s) => s.record.tier === tier);
  return recs.at(-1)?.record.standing === true;
}

interface Resolved { receipt: Stored<ReceiptRecord>; outcome: OutcomeRecord }

/** Would-merge decisions at a tier (shadow and audited), paired with their outcome once resolved. */
function resolvedWouldMerge(ledger: Ledger, repo: string, tier: Tier, auditOnly = false): Resolved[] {
  const outcomes = new Map(ledger.outcomes(repo).map((o) => [o.record.receipt_id, o.record]));
  const out: Resolved[] = [];
  for (const receipt of ledger.receipts(repo)) {
    const p = receipt.record.statement.predicate;
    if (p.decision.value !== 'would_merge' || p.tier.value !== tier) continue;
    if (auditOnly && !p.run.audit) continue;
    const outcome = outcomes.get(p.id);
    if (outcome) out.push({ receipt, outcome });
  }
  return out;
}

export function agreementRate(items: Resolved[]): number | null {
  const judged = items.filter((i) => i.outcome.human !== null);
  if (judged.length === 0) return null;
  return judged.filter((i) => i.outcome.human === 'agree').length / judged.length;
}

export interface PromotionStatus {
  tier: Tier;
  standing: boolean;
  eligible: boolean;
  needed: number;
  /** Would-merge changes that were merged and finished their watch window. */
  watched: number;
  held: number;
  reverts: number;
  agreement: number | null;
  blockers: string[];
}

/**
 * Promotion (spec section 7). The window is the last `after_held` would-merge
 * changes that a person merged and whose watch window has ended. All must have
 * held, allowing `max_reverts`. Agreement is measured over every would-merge
 * decision a person resolved since the window began, including ones they closed.
 */
export function promotionStatus(ledger: Ledger, config: FactoryConfig, repo: string, tier: 0 | 1): PromotionStatus {
  const rule = config.autonomy.promote[tier === 0 ? '0' : '1'];
  const resolved = resolvedWouldMerge(ledger, repo, tier);
  const merged = resolved.filter((r) => r.outcome.merged_by !== null);
  const window = merged.slice(-rule.after_held);
  const firstSeq = window[0]?.receipt.seq ?? Infinity;
  const span = resolved.filter((r) => r.receipt.seq >= firstSeq);
  const held = window.filter((r) => r.outcome.result === 'held').length;
  const reverts = window.filter((r) => r.outcome.result === 'reverted').length;
  const failed = window.filter((r) => r.outcome.result === 'failed').length;
  const agreement = agreementRate(span);
  const standing = hasStanding(ledger, repo, tier);

  const blockers: string[] = [];
  if (standing) blockers.push('tier already has standing');
  if (config.autonomy.mode !== 'earned') blockers.push('autonomy.mode is shadow; standing has no effect until it is earned');
  if (window.length < rule.after_held) blockers.push(`${window.length} of ${rule.after_held} watched would-merge changes`);
  if (reverts > rule.max_reverts) blockers.push(`${reverts} reverts in the window (max ${rule.max_reverts})`);
  if (failed > 0) blockers.push(`${failed} changes in the window failed checks after merge`);
  if (agreement === null || agreement < rule.min_agreement) blockers.push(`agreement ${agreement === null ? 'n/a' : agreement.toFixed(2)} below ${rule.min_agreement}`);
  if (tier === 1 && !hasStanding(ledger, repo, 0)) blockers.push('tier 1 requires standing at tier 0');

  const hard = blockers.filter((b) => !b.startsWith('autonomy.mode'));
  return { tier, standing, eligible: hard.length === 0, needed: rule.after_held, watched: window.length, held, reverts, agreement, blockers };
}

/** A person MUST confirm each promotion. */
export function promote(ledger: Ledger, config: FactoryConfig, repo: string, tier: 0 | 1, confirmedBy: string, at: Date): PromotionStatus {
  const status = promotionStatus(ledger, config, repo, tier);
  if (!status.eligible) throw new Error(`tier ${tier} is not eligible for promotion: ${status.blockers.join('; ')}`);
  if (!confirmedBy.trim()) throw new Error('a person must confirm each promotion');
  ledger.writeStanding({
    repo, tier, standing: true, confirmed_by: confirmedBy, at: at.toISOString(),
    reason: `promoted: ${status.held}/${status.watched} held, agreement ${status.agreement?.toFixed(2)}, ${status.reverts} reverts`,
  });
  return { ...status, standing: true };
}

/**
 * Apply an outcome to standing: one revert of a factory-merged change removes
 * standing at that tier and above; falling audit agreement removes it at that tier.
 * Returns the tiers that lost standing.
 */
export function applyOutcome(ledger: Ledger, config: FactoryConfig, outcome: OutcomeRecord): Tier[] {
  const lost: Tier[] = [];
  const demote = (tier: Tier, reason: string) => {
    if (!hasStanding(ledger, outcome.repo, tier)) return;
    ledger.writeStanding({ repo: outcome.repo, tier, standing: false, reason, at: outcome.at });
    lost.push(tier);
  };
  if (outcome.result === 'reverted' && outcome.merged_by === 'factory') {
    for (let t = outcome.tier; t <= 3; t++) demote(t as Tier, `demoted: change ${outcome.change} (receipt ${outcome.receipt_id}) was reverted`);
  }
  if (outcome.human !== null && (outcome.tier === 0 || outcome.tier === 1) && hasStanding(ledger, outcome.repo, outcome.tier)) {
    const rule = config.autonomy.promote[outcome.tier === 0 ? '0' : '1'];
    const audited = resolvedWouldMerge(ledger, outcome.repo, outcome.tier, true).slice(-rule.after_held);
    const rate = agreementRate(audited);
    if (rate !== null && rate < rule.min_agreement) demote(outcome.tier, `demoted: audit agreement ${rate.toFixed(2)} fell below ${rule.min_agreement}`);
  }
  return lost;
}
