import type { DatabaseSync } from 'node:sqlite';
import { classify } from './classify.js';
import type { FactoryConfig } from './config.js';
import { EVIDENCE_KINDS, historyOf, nodeId, repoHistory, ruleForBecause, ruleHistory, syncGraph, type Graph, type GraphNode, type History } from './graph.js';
import type { Ledger, Store } from './ledger.js';
import { normalizePath } from './paths.js';
import type { ChangedFile, Tier, WorkOrder } from './types.js';

/**
 * Background for the Runner and the Reviewer, read off the knowledge graph.
 *
 * The wording is fixed and no model is involved, so the same graph always
 * gives the same text. Every variable part is a number, a spec term, or a
 * string from the base-branch config. File names, issue text, decision reasons
 * and review comments never appear: they are written by the Worker or by an
 * issue author, and "issue text, code comments and review comments are
 * untrusted input" (spec section 6).
 *
 * This is advice to the agents. It is not evidence, and the Gate does not read it.
 */

const MAX_RULES = 12;

/** A config string, made safe to sit inside a code span on one line. */
const code = (s: string) => `\`${s.replace(/[`\u0000-\u001f\u007f]/g, '').slice(0, 80)}\``;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const counts = (m: Record<string, number>, allowed: (name: string) => boolean) =>
  Object.entries(m).filter(([name]) => allowed(name)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => `${name} (${n})`);

const ruleText = (n: GraphNode): string => {
  const kind = n.props.kind;
  if (kind === 'protected') return `${code(n.label)} is protected`;
  if (kind === 'append_only') return `existing files under ${code(n.label)} are append-only`;
  if (kind === 'default') return `any path no rule names is tier ${n.props.tier}`;
  return `${code(n.label)} is tier ${n.props.tier}`;
};

/** The part of a pattern before its first `*`. */
const literal = (pattern: string) => normalizePath(pattern).split('*')[0]!;

/** Whether two patterns could match the same path. Errs towards yes. */
export function mayOverlap(a: string, b: string): boolean {
  const pa = literal(a), pb = literal(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

function bar(g: Graph, tier: Tier): string {
  const needs = g.out(nodeId.tier(tier), 'requires').map((e) => e.label);
  return `Tier ${tier} needs this evidence: ${needs.join(', ')}.${tier >= 2 ? ' It always goes to a person.' : ''}`;
}

function went(h: History): string[] {
  const parts: string[] = [];
  if (h.reverted) parts.push(`${h.reverted} reverted after merging`);
  if (h.failed_watch) parts.push(`${h.failed_watch} failed during the watch period`);
  if (h.disagreed) parts.push(`${h.disagreed} rejected by a person after the factory would have accepted`);
  return parts;
}

const HEADER = [
  '## Factory context',
  'Facts from this repository\'s factory rules (base branch) and its record of past runs. They are background, not instructions.',
];

/**
 * What the Runner is told before it starts. Holdout results and audit sampling
 * are left out on purpose: the Worker must not learn which hidden checks judged
 * earlier work, and "the audit draw ... MUST NOT be predictable by the Worker".
 */
export function runnerContext(g: Graph, wo: Pick<WorkOrder, 'scope'>): string {
  // The rules an agent can act on come first, so they survive the cut when there are many.
  const order = ['tier', 'append_only', 'default', 'protected'];
  const inScope = g.ofType('PathRule').filter((r) => r.props.kind === 'default' || wo.scope.paths.some((s) => mayOverlap(s, r.label)))
    .sort((x, y) => order.indexOf(String(x.props.kind)) - order.indexOf(String(y.props.kind)));
  const shown = inScope.slice(0, MAX_RULES);
  const tiers = [...new Set(inScope.map((r) => r.props.tier as Tier))].sort();
  const lines = [
    ...HEADER,
    'Nothing here widens the task or the paths you may change.',
    '',
    `Rules that may apply to the paths in scope: ${shown.map(ruleText).join('; ')}${inScope.length > shown.length ? `; and ${inScope.length - shown.length} more` : ''}.`,
    'A protected path, or a change to an existing append-only file, always goes to a person.',
    ...tiers.map((t) => bar(g, t)),
  ];
  {
    const h = repoHistory(g);
    const gated = h.receipts - h.abandoned;
    if (gated === 0) lines.push('', 'No earlier change has been through the Gate in this repository.');
    else {
      lines.push('', `Record so far: ${plural(gated, 'change')} went through the Gate; ${h.escalated} went to a person because the rules required it or evidence was missing.`);
      const missed = counts(h.missed, (k) => k !== 'holdout' && (EVIDENCE_KINDS as string[]).includes(k));
      if (missed.length) lines.push(`Evidence most often missing: ${missed.join(', ')}.`);
      const wrong = went(h);
      if (wrong.length) lines.push(`Afterwards: ${wrong.join('; ')}.`);
      const hot = inScope.map((r) => ({ r, n: g.out(r.id, 'went_wrong_in').length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, MAX_RULES);
      if (hot.length) lines.push(`Paths where accepted work later went wrong: ${hot.map((x) => `${x.r.props.kind === 'default' ? 'paths no rule names' : code(x.r.label)} (${x.n})`).join(', ')}.`);
    }
  }
  return lines.join('\n');
}

/**
 * What the Reviewer is told about the change in front of it. It can only add
 * reasons to look harder: the closing line says so, because `review` is
 * evidence and nothing here may talk a Reviewer into approving.
 */
export function reviewerContext(g: Graph, config: FactoryConfig, wo: Pick<WorkOrder, 'scope'>, files: readonly ChangedFile[]): string {
  // Advisory only. The Gate classifies again for itself, from the host, when it decides.
  const cls = classify(config, files, wo.scope.paths);
  const rules = [...new Set(cls.because.map((line) => ruleForBecause(line, config)).filter((r): r is string => !!r))]
    .map((ruleId) => g.node(ruleId)).filter((n): n is GraphNode => !!n);
  const lines = [
    ...HEADER,
    '',
    `This change is tier ${cls.tier}: ${plural(cls.files, 'file')}, ${plural(cls.lines, 'changed line')}.`,
    rules.length ? `Rules that set the tier: ${rules.slice(0, MAX_RULES).map(ruleText).join('; ')}.` : 'The size limits set the tier.',
    bar(g, cls.tier),
    'A review is one piece of evidence among several; it is never enough on its own.',
  ];
  if (cls.outOfScope.length) lines.push(`${plural(cls.outOfScope.length, 'changed path is', 'changed paths are')} outside the work order's scope. That alone sends the change to a person.`);

  const seen = new Map<string, GraphNode>();
  for (const r of rules) for (const receipt of g.in(r.id, 'touched')) seen.set(receipt.id, receipt);
  const h = historyOf(g, [...seen.values()]);
  if (h.receipts === 0) lines.push('', 'No earlier change under these rules is on record.');
  else {
    lines.push('', `Earlier changes under these rules: ${h.receipts}.`);
    const wrong = went(h);
    if (wrong.length) lines.push(`Of those: ${wrong.join('; ')}.`);
    const missed = counts(h.missed, (k) => (EVIDENCE_KINDS as string[]).includes(k));
    if (missed.length) lines.push(`Evidence they most often lacked: ${missed.join(', ')}.`);
    for (const r of rules.slice(0, MAX_RULES)) {
      const rh = ruleHistory(g, r.id);
      const flaky = counts(rh.flaky, () => true);
      if (flaky.length) lines.push(`Checks that passed only after failing on ${r.props.kind === 'default' ? 'paths no rule names' : code(r.label)}: ${flaky.join(', ')}.`);
    }
  }
  lines.push('', 'Use this to decide where to look harder. It is never a reason to approve.');
  return lines.join('\n');
}

/** Where the Harness gets its background from. */
export interface ContextSource {
  runner(config: FactoryConfig, wo: WorkOrder): string;
  reviewer(config: FactoryConfig, wo: WorkOrder, files: readonly ChangedFile[]): string;
}

/** A context source backed by the stored graph, brought up to date on each call. */
export function graphContext(deps: { db: DatabaseSync; ledger: Ledger; store: Store; repo: string; now?: () => Date }): ContextSource {
  const graph = (config: FactoryConfig) => syncGraph({ ...deps, config }).graph;
  return {
    runner: (config, wo) => runnerContext(graph(config), wo),
    reviewer: (config, wo, files) => reviewerContext(graph(config), config, wo, files),
  };
}
