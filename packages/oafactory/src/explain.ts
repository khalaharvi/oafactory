import { effectiveBudget, type FactoryConfig } from './config.js';
import type { OutcomeRecord } from './ledger.js';
import type { Statement } from './receipt.js';
import type { Evidence, EvidenceKind, Tier, WorkOrder } from './types.js';

/**
 * Plain-language explanations of a work order and of a receipt, for people who
 * are not engineers. Everything here is built from the config, the work order
 * and the receipt with fixed wording: no model is involved, so the same input
 * always produces the same explanation.
 */

const TIER_NAME: Record<Tier, string> = { 0: 'low risk', 1: 'moderate risk', 2: 'higher risk', 3: 'sensitive' };

const money = (n: number) => `$${n.toFixed(2)}`;
const list = (items: string[], max = 6) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function section(title: string, lines: string[]): string {
  return [title, ...lines.map((l) => (l === '' ? '' : `  ${l}`))].join('\n');
}

function pathsFor(config: FactoryConfig, tier: Tier): string[] {
  return config.tiers.rules.filter((r) => r.tier === tier).flatMap((r) => r.paths);
}

export interface ExplainOptions {
  /** Tiers at which this repository has earned automatic merging. */
  standing?: Tier[];
}

/** What will happen if this work order is run, in plain words. */
export function explainWorkOrder(config: FactoryConfig, wo: WorkOrder, opts: ExplainOptions = {}): string {
  const budget = effectiveBudget(config, wo);
  const standing = new Set(opts.standing ?? []);
  const shadow = config.autonomy.mode === 'shadow';
  const everything = wo.scope.paths.length === 1 && /^\*+$/.test(wo.scope.paths[0]!);

  const who = (tier: 0 | 1): string => {
    if (shadow) return 'A person decides. The factory only records that it would have said yes.';
    if (!standing.has(tier)) return 'A person decides, until the factory has earned trust at this level.';
    return `The factory may accept it on its own. About 1 in ${Math.max(1, Math.round(1 / Math.max(config.autonomy.audit_rate, 0.0001)))} are still sent to a person as a spot check.`;
  };

  const tier0 = pathsFor(config, 0), tier1 = pathsFor(config, 1);
  const checks = list(config.checks.required);
  const levels: string[] = [];
  if (tier0.length) levels.push(`Low risk: changes only to ${list(tier0)}, up to ${config.tiers.limits['0']?.max_lines ?? 'any number of'} lines.`, `  Must pass the automated checks and stay within budget.`, `  ${who(0)}`, '');
  if (tier1.length) levels.push(`Moderate risk: changes to ${list(tier1)}, up to ${config.tiers.limits['1']?.max_lines ?? 'any number of'} lines.`, `  Must also add a new test, run every test that ran before, and be approved by the second AI.`, `  ${who(1)}`, '');
  levels.push('Higher risk: anything larger, or anything the rules do not name.', '  Always goes to a person, with the evidence attached.', '');
  levels.push(`Sensitive: any change to ${list(config.protected, 5)}, or to an existing test.`, '  Always goes to a person. These are the files that define the rules and the checks themselves.');

  return [
    `Work order ${wo.id}, requested by ${wo.requested_by}`,
    '',
    section('What is being asked', wo.intent.trim().split('\n')),
    '',
    section('Where the AI may make changes', [
      everything ? 'Anywhere in the project.' : `Only in: ${list(wo.scope.paths, 10)}`,
      everything ? 'Sensitive files are still off limits without a person: see below.' : 'If it changes anything outside these places, the work stops and goes to a person.',
    ]),
    '',
    section('What it may spend', [
      `Up to ${money(budget.usd_per_run)} and ${budget.minutes_per_run} minutes per attempt, with at most ${plural(budget.max_attempts, 'attempt')}.`,
      'If an attempt runs out of money or time it is stopped. You still get a record of what it did.',
    ]),
    '',
    section('What happens, step by step', [
      `1. An AI coding assistant (${config.roles.runner.use}) works on a private copy of the project.`,
      '   It cannot publish its work, approve it, or see any passwords or keys.',
      '2. Its changes are published as a proposed change that people can read and comment on.',
      '3. A second AI, from a different maker, reads the changes and says whether it would approve them.',
      `4. The project's automated checks run: ${checks}.`,
      '5. The Gate sorts the change by how risky it is and decides what happens next.',
      '   The Gate is a fixed set of rules, not an AI. The same change always gets the same answer.',
      `6. If the change is accepted, it is watched for ${Math.round(config.watch.window_hours / 24)} days. If it breaks the checks, it is undone.`,
    ]),
    '',
    section('How the decision is made', levels),
    '',
    section('Where things stand today', [
      shadow
        ? 'This project is in shadow mode: the factory never accepts a change on its own. It records what it would have done, and a person makes every call.'
        : `This project is in earned mode. The factory may accept changes on its own at: ${standing.size ? [...standing].sort().map((t) => `${TIER_NAME[t]} (tier ${t})`).join(', ') : 'no level yet'}.`,
    ]),
    '',
    section('What you get at the end', [
      'A receipt for every attempt: what was checked, what could not be confirmed, what it cost, and why the Gate decided as it did.',
      `Read it in plain words with: oafactory explain ${wo.id}-1`,
    ]),
  ].join('\n');
}

const EVIDENCE_TEXT: Record<EvidenceKind, [yes: string, no: string]> = {
  checks: ["The project's automated checks passed", "The project's automated checks did not all pass"],
  budget: ['The work stayed within its money and time budget', 'The work went over budget, or its spending could not be confirmed'],
  test_integrity: ['Every test that ran before still ran', 'Could not confirm that every earlier test still ran'],
  new_test: ['The change added a new test', 'The change did not add a new test'],
  holdout: ['It passed checks the AI was never shown', 'It did not pass the checks the AI was never shown'],
  review: ['A second AI from a different maker approved it', 'There is no valid approval from a second AI'],
  behavior: ['The change was tried out in a running copy of the product', 'The change was not tried out in a running copy of the product'],
};

function evidenceNote(e: Evidence): string {
  const d = (e.detail ?? {}) as Record<string, unknown>;
  if (e.kind === 'budget' && typeof d.cost_usd === 'number' && typeof d.limit_usd === 'number') return ` (${money(d.cost_usd)} of ${money(d.limit_usd)})`;
  if (e.kind === 'test_integrity' && typeof d.base === 'number' && typeof d.head === 'number') return ` (${d.base} tests before, ${d.head} after)`;
  if (e.kind === 'checks' || e.kind === 'holdout') {
    const failed = Object.entries(d).filter(([, v]) => v !== 'success').map(([k, v]) => `${k}: ${String(v)}`);
    if (failed.length) return ` (${list(failed)})`;
  }
  if (typeof d.reason === 'string' && !e.met) return ` (${d.reason})`;
  return '';
}

/** What happened in a run, in plain words. */
export function explainReceipt(st: Statement, outcome?: OutcomeRecord): string {
  const p = st.predicate;
  const shadow = p.decision.mode === 'shadow';
  const summary =
    p.decision.value === 'merge' ? 'The factory accepted this change on its own. Every requirement for its risk level was met, and the project has earned trust at that level.'
    : p.decision.value === 'would_merge' ? (p.run.audit
      ? 'The factory would have accepted this change, but it was picked for a spot check, so a person decides.'
      : shadow ? 'The factory would have accepted this change. The project is in shadow mode, so a person decides.'
      : 'The factory would have accepted this change, but it has not yet earned the right to do so on its own. A person decides.')
    : p.decision.value === 'abandon' ? 'This attempt was stopped before it produced a change that could be judged.'
    : 'The factory did not accept this change. It was sent to a person.';

  const lines = [
    `Receipt ${p.id}${p.change.number !== null ? `: proposed change #${p.change.number} in ${p.change.repo}` : ` in ${p.change.repo}`}`,
    '',
    section('In short', [summary, `Reason given: ${p.decision.reason}`]),
  ];

  if (p.decision.value !== 'abandon') {
    lines.push('', section('How risky was it judged to be', [
      `${TIER_NAME[p.tier.value][0]!.toUpperCase()}${TIER_NAME[p.tier.value].slice(1)} (tier ${p.tier.value}), because of the files it touched:`,
      ...p.tier.because.slice(0, 6).map((b) => `- ${b}`),
      ...(p.tier.because.length > 6 ? [`- and ${p.tier.because.length - 6} more`] : []),
    ]));
    lines.push('', section('What was checked', p.evidence.map((e) => `${e.met ? '[yes]' : '[no] '} ${EVIDENCE_TEXT[e.kind][e.met ? 0 : 1]}${evidenceNote(e)}`)));
  }

  lines.push('', section('What could not be confirmed', p.unverified.length ? p.unverified.map((u) => `- ${u}`) : ['Nothing was recorded here.']));
  lines.push('', section('Who did the work, and what it cost', [
    `Written by ${p.run.runner} using ${p.run.runner_model}. Reviewed by ${p.run.reviewer} using ${p.run.reviewer_model}.`,
    `${money(p.run.cost_usd)} and ${p.run.minutes} minutes, on attempt ${p.run.attempt}.`,
    p.work_order ? `Work order ${p.work_order}.` : 'No work order is on record for this change.',
  ]));

  if (outcome) {
    const after =
      outcome.result === 'held' ? `It was merged by ${outcome.merged_by === 'factory' ? 'the factory' : 'a person'} and was still in place when the watch period ended.`
      : outcome.result === 'reverted' ? 'It was merged and later undone. An undone change takes away the factory\'s right to accept changes at this risk level.'
      : outcome.result === 'failed' ? 'It was merged by a person, and the checks then failed on the merged result.'
      : outcome.result === 'closed' ? 'A person closed it without merging.'
      : 'The factory tried to merge it, but the change had moved on, so nothing was merged.';
    const agree = outcome.human === 'agree' ? ' The person agreed with the factory.' : outcome.human === 'disagree' ? ' The person disagreed with the factory.' : '';
    lines.push('', section('What happened afterwards', [`${after}${agree}`, ...(outcome.flaky.length ? [`A check was unreliable: ${list(outcome.flaky)} failed once and passed when run again.`] : [])]));
  } else if (p.decision.value === 'merge' || p.decision.value === 'would_merge') {
    lines.push('', section('What happened afterwards', ['Nothing is recorded yet. The outcome is written once the change is merged and watched, or closed.']));
  }
  return lines.join('\n');
}
