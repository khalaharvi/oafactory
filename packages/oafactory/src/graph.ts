import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FactoryConfig } from './config.js';
import { requiredEvidence } from './evidence.js';
import type { Ledger, OutcomeRecord, ReceiptRecord, RunRow, StandingRecord, Store, Stored } from './ledger.js';
import type { EvidenceKind, Tier } from './types.js';

/**
 * A knowledge graph over the factory's building blocks: the spec's terms
 * (roles, tiers, evidence kinds), this repository's rules (checks, path rules)
 * and what has happened (work orders, runs, receipts, outcomes, standing).
 *
 * The graph is a projection. The base-branch config and the append-only Ledger
 * remain the only sources of truth, and the graph can be thrown away and
 * rebuilt from them at any time. Nothing in it is an input to the Gate: spec
 * section 4 says the Gate MUST compute the tier "with this procedure and no
 * other input".
 *
 * It deliberately holds no free text written by an issue author, a Worker or a
 * model: no intent, no file names, no reasons, no review comments. Every label
 * is a spec term, a number, or a string from the base-branch config. That is
 * what makes it safe to quote to an agent (see context.ts).
 */

export const ONTOLOGY_VERSION = 'v1alpha1';
export const ONTOLOGY_IRI = `https://oafactory.org/ontology/${ONTOLOGY_VERSION}#`;

export type NodeType =
  | 'Repository' | 'Role' | 'Tier' | 'EvidenceKind' | 'Check' | 'PathRule'
  | 'WorkOrder' | 'Run' | 'Change' | 'Receipt' | 'Outcome' | 'StandingEvent';

export type Relation =
  | 'requires' | 'produced_by' | 'provides' | 'gates' | 'assigns' | 'has_standing'
  | 'attempt_of' | 'opened' | 'issued_for' | 'about' | 'classified' | 'met' | 'missed'
  | 'touched' | 'resolves' | 'flaky' | 'changed' | 'went_wrong_in';

interface ClassDef { description: string }
interface RelationDef { domain: NodeType; range: NodeType; description: string; inferred?: boolean }

/** The schema. An edge that does not fit a relation's domain and range is refused. */
export const ONTOLOGY: { classes: Record<NodeType, ClassDef>; relations: Record<Relation, RelationDef> } = {
  classes: {
    Repository: { description: 'The repository the factory gates.' },
    Role: { description: 'A role of spec section 2, with what it may and must never do.' },
    Tier: { description: 'The risk class of a change, 0 (lowest) to 3.' },
    EvidenceKind: { description: 'A kind of fact about a change, produced by something other than the Worker (spec section 5).' },
    Check: { description: 'A named CI job on the Git host whose result the Gate reads.' },
    PathRule: { description: 'A path pattern from the factory config: protected, append-only, a tier rule, or the default tier.' },
    WorkOrder: { description: 'A request authorized by a person, with a scope and a budget.' },
    Run: { description: 'One attempt to satisfy a work order, ending in exactly one receipt.' },
    Change: { description: 'A pull request or merge request.' },
    Receipt: { description: 'The immutable record of a run and of the Gate decision.' },
    Outcome: { description: 'What happened to a change after the Gate decided.' },
    StandingEvent: { description: 'A promotion or demotion of a tier.' },
  },
  relations: {
    requires: { domain: 'Tier', range: 'EvidenceKind', description: 'The tier\'s bar includes this evidence.' },
    produced_by: { domain: 'EvidenceKind', range: 'Role', description: 'The role that produces this evidence.' },
    provides: { domain: 'Check', range: 'EvidenceKind', description: 'The check\'s result counts toward this evidence.' },
    gates: { domain: 'Check', range: 'Tier', inferred: true, description: 'Inferred: the check provides evidence the tier requires, so its failure blocks the tier.' },
    assigns: { domain: 'PathRule', range: 'Tier', description: 'A file matching the rule gets at least this tier.' },
    has_standing: { domain: 'Repository', range: 'Tier', description: 'The repository has earned automatic merging at this tier.' },
    attempt_of: { domain: 'Run', range: 'WorkOrder', description: 'The run is an attempt at the work order.' },
    opened: { domain: 'Run', range: 'Change', description: 'The Harness opened this change for the run.' },
    issued_for: { domain: 'Receipt', range: 'Run', description: 'The receipt records this run.' },
    about: { domain: 'Receipt', range: 'Change', description: 'The receipt decides this change.' },
    classified: { domain: 'Receipt', range: 'Tier', description: 'The Gate classified the change at this tier.' },
    met: { domain: 'Receipt', range: 'EvidenceKind', description: 'This evidence was collected and met.' },
    missed: { domain: 'Receipt', range: 'EvidenceKind', description: 'The tier requires this evidence under the current config, and it was not met.' },
    touched: { domain: 'Receipt', range: 'PathRule', description: 'A file that set the change\'s tier matched this rule.' },
    resolves: { domain: 'Outcome', range: 'Receipt', description: 'The outcome of the decision the receipt records.' },
    flaky: { domain: 'Outcome', range: 'Check', description: 'The check passed only after a failure.' },
    changed: { domain: 'StandingEvent', range: 'Tier', description: 'The tier whose standing was granted or removed.' },
    went_wrong_in: { domain: 'PathRule', range: 'Outcome', inferred: true, description: 'Inferred: a change touching the rule was reverted, failed its watch, or was rejected by a person after a would-merge.' },
  },
};

export interface GraphNode { id: string; type: NodeType; label: string; props: Record<string, unknown> }
export interface GraphEdge { from: string; rel: Relation; to: string; inferred: boolean }

export class Graph {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: GraphEdge[] = [];
  private keys = new Set<string>();
  constructor(readonly repo: string) {}

  addNode(type: NodeType, id: string, label: string, props: Record<string, unknown> = {}): GraphNode {
    const existing = this.nodes.get(id);
    if (existing) {
      if (existing.type !== type) throw new Error(`graph node ${id} is a ${existing.type}; it cannot also be a ${type}`);
      return existing;
    }
    const node: GraphNode = { id, type, label, props };
    this.nodes.set(id, node);
    return node;
  }

  /** Add an edge. Throws when either end is missing or the edge does not fit the ontology. */
  addEdge(from: string, rel: Relation, to: string): void {
    const def = ONTOLOGY.relations[rel];
    if (!def) throw new Error(`"${rel}" is not a relation in the ontology`);
    const a = this.nodes.get(from), b = this.nodes.get(to);
    if (!a || !b) throw new Error(`cannot add ${from} -${rel}-> ${to}: ${a ? to : from} is not in the graph`);
    if (a.type !== def.domain || b.type !== def.range) {
      throw new Error(`"${rel}" links a ${def.domain} to a ${def.range}; ${from} is a ${a.type} and ${to} is a ${b.type}`);
    }
    const key = `${from}\u0000${rel}\u0000${to}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.edges.push({ from, rel, to, inferred: !!def.inferred });
  }

  node(id: string): GraphNode | undefined { return this.nodes.get(id); }
  ofType(type: NodeType): GraphNode[] { return [...this.nodes.values()].filter((n) => n.type === type); }
  /** Nodes this node points at. */
  out(id: string, rel?: Relation): GraphNode[] {
    return this.edges.filter((e) => e.from === id && (!rel || e.rel === rel)).map((e) => this.nodes.get(e.to)!);
  }
  /** Nodes that point at this node. */
  in(id: string, rel?: Relation): GraphNode[] {
    return this.edges.filter((e) => e.to === id && (!rel || e.rel === rel)).map((e) => this.nodes.get(e.from)!);
  }
}

// --- Node ids. Local to a repository. ---

export type RuleKind = 'protected' | 'append_only' | 'tier' | 'default';
export const nodeId = {
  repo: 'repository',
  role: (name: string) => `role:${name}`,
  tier: (t: number) => `tier:${t}`,
  evidence: (k: string) => `evidence:${k}`,
  check: (name: string) => `check:${name}`,
  rule: (kind: RuleKind, pattern = '') => (kind === 'default' ? 'rule:default' : `rule:${kind}:${pattern}`),
  workOrder: (woId: string) => `workorder:${woId}`,
  run: (runId: string) => `run:${runId}`,
  change: (n: number) => `change:${n}`,
  receipt: (receiptId: string) => `receipt:${receiptId}`,
  outcome: (receiptId: string) => `outcome:${receiptId}`,
  standing: (recordId: string) => `standing:${recordId}`,
};

/** Spec section 2, in its wording. */
const ROLES: Array<[name: string, may: string, mustNever: string]> = [
  ['Sandbox', 'Run Worker commands; reach the Gateway and package registries', 'Allow other egress by default; contain any Git host credential'],
  ['Gateway', 'Hold provider keys; issue one budgeted key per run', 'Expose provider keys to the Worker'],
  ['Runner', 'Read and edit the working tree; run commands in the Sandbox', 'Hold any Git host credential; push; merge; set its own tier'],
  ['Harness', 'Push the run\'s branch; open the change', 'Merge'],
  ['Reviewer', 'Read the diff from a fresh context; return a verdict and comments', 'Share a model family with the Runner; see the Runner\'s transcript; push commits'],
  ['Gate', 'Read config, diff, checks and Ledger; merge or escalate; sign receipts', 'Accept the Worker\'s claims about evidence without re-reading the source'],
  ['Ledger', 'Append and serve records', 'Modify or delete a record; be writable by the Worker'],
  ['Watcher', 'Read the default branch; rerun checks; open a revert', 'Merge anything other than through the Gate'],
  ['Host', 'Translate the verbs in section 9 to `gh` or `glab`', ''],
];

/** Spec section 5, "Produced by". CI is reached through the Host. */
const PRODUCER: Record<EvidenceKind, string> = {
  checks: 'Host', budget: 'Gateway', test_integrity: 'Gate', new_test: 'Gate', holdout: 'Host', review: 'Reviewer', behavior: 'Host',
};
export const EVIDENCE_KINDS = Object.keys(PRODUCER) as EvidenceKind[];
const TIERS: Tier[] = [0, 1, 2, 3];

/**
 * Which path rule a line of a receipt's `tier.because` names. Only the end of
 * the line is read, and it is compared with patterns from the config: the file
 * name at the start of the line was chosen by the Worker and is never used.
 */
export function ruleForBecause(line: string, config: FactoryConfig): string | undefined {
  if (/matched no rule; default tier \d$/.test(line)) return nodeId.rule('default');
  let best: { ruleId: string; length: number } | undefined;
  const consider = (suffix: string, ruleId: string) => {
    if (line.endsWith(suffix) && (!best || suffix.length > best.length)) best = { ruleId, length: suffix.length };
  };
  for (const p of config.protected) consider(` matched protected ${p}`, nodeId.rule('protected', p));
  for (const p of config.append_only) consider(` under append-only ${p}`, nodeId.rule('append_only', p));
  for (const rule of config.tiers.rules) for (const p of rule.paths) consider(` matched ${p}`, nodeId.rule('tier', p));
  return (best as { ruleId: string } | undefined)?.ruleId;
}

export interface GraphInput {
  repo: string;
  config: FactoryConfig;
  receipts: Array<Stored<ReceiptRecord>>;
  outcomes: Array<Stored<OutcomeRecord>>;
  standings: Array<Stored<StandingRecord>>;
  runs: RunRow[];
}

/** Build the graph. Pure: the same input always gives the same graph. */
export function buildGraph(input: GraphInput): Graph {
  const { repo, config } = input;
  const g = new Graph(repo);
  g.addNode('Repository', nodeId.repo, repo, { mode: config.autonomy.mode, audit_rate: config.autonomy.audit_rate });

  // The spec's terms.
  for (const [name, may, mustNever] of ROLES) g.addNode('Role', nodeId.role(name), name, { may, must_never: mustNever });
  for (const t of TIERS) g.addNode('Tier', nodeId.tier(t), `tier ${t}`, { value: t, always_escalates: t >= 2, limits: (t === 0 ? config.tiers.limits['0'] : t === 1 ? config.tiers.limits['1'] : undefined) ?? null });
  for (const k of EVIDENCE_KINDS) {
    g.addNode('EvidenceKind', nodeId.evidence(k), k);
    g.addEdge(nodeId.evidence(k), 'produced_by', nodeId.role(PRODUCER[k]));
  }
  for (const t of TIERS) for (const k of requiredEvidence(t, config)) g.addEdge(nodeId.tier(t), 'requires', nodeId.evidence(k));

  // This repository's rules, from the base-branch config.
  const check = (name: string, kind: EvidenceKind, list: string) => {
    const node = g.addNode('Check', nodeId.check(name), name, { lists: [] as string[] });
    (node.props.lists as string[]).push(list);
    g.addEdge(node.id, 'provides', nodeId.evidence(kind));
  };
  for (const c of config.checks.required) check(c, 'checks', 'required');
  for (const c of config.checks.holdout) check(c, 'holdout', 'holdout');
  for (const c of config.checks.behavior) check(c, 'behavior', 'behavior');

  const rule = (kind: RuleKind, pattern: string, tier: Tier) => {
    const node = g.addNode('PathRule', nodeId.rule(kind, pattern), kind === 'default' ? '(any other path)' : pattern, { kind, tier });
    // "Highest wins": a pattern listed under two tier rules assigns the higher one.
    if ((node.props.tier as Tier) < tier) node.props.tier = tier;
  };
  for (const p of config.protected) rule('protected', p, 3);
  for (const p of config.append_only) rule('append_only', p, 3);
  for (const r of config.tiers.rules) for (const p of r.paths) rule('tier', p, r.tier);
  rule('default', '', config.tiers.default);
  for (const n of g.ofType('PathRule')) g.addEdge(n.id, 'assigns', nodeId.tier(n.props.tier as Tier));

  // What happened: runs from the operational store, the rest from the Ledger.
  for (const run of input.runs) {
    const wo = run.work_order;
    g.addNode('WorkOrder', nodeId.workOrder(wo.id), wo.id, { requested_by: wo.requested_by, scope: wo.scope.paths, issue: wo.source?.issue ?? null });
    g.addNode('Run', nodeId.run(run.id), run.id, {
      attempt: run.attempt, state: run.state, runner: run.runner, runner_model: run.runner_model, reviewer: run.reviewer, reviewer_model: run.reviewer_model,
      budget_usd: run.budget_usd, started_at: run.started_at, ended_at: run.ended_at,
    });
    g.addEdge(nodeId.run(run.id), 'attempt_of', nodeId.workOrder(wo.id));
    if (run.change !== null) {
      g.addNode('Change', nodeId.change(run.change), `#${run.change}`, { number: run.change });
      g.addEdge(nodeId.run(run.id), 'opened', nodeId.change(run.change));
    }
  }

  for (const r of input.receipts) {
    const p = r.record.statement.predicate;
    const rid = nodeId.receipt(p.id);
    g.addNode('Receipt', rid, p.id, {
      decision: p.decision.value, mode: p.decision.mode, tier: p.tier.value, audit: p.run.audit, state: p.run.state,
      cost_usd: p.run.cost_usd, minutes: p.run.minutes, issued_at: p.issued_at, signed: !!r.record.signed,
    });
    g.addEdge(rid, 'classified', nodeId.tier(p.tier.value));
    if (g.node(nodeId.run(p.id))) g.addEdge(rid, 'issued_for', nodeId.run(p.id));
    if (p.change.number !== null) {
      g.addNode('Change', nodeId.change(p.change.number), `#${p.change.number}`, { number: p.change.number });
      g.addEdge(rid, 'about', nodeId.change(p.change.number));
    }
    const met = new Set<string>();
    for (const e of p.evidence) if (e.met && EVIDENCE_KINDS.includes(e.kind)) { met.add(e.kind); g.addEdge(rid, 'met', nodeId.evidence(e.kind)); }
    // An abandoned run never reached the Gate, so no bar applied to it.
    if (p.decision.value !== 'abandon') {
      for (const k of requiredEvidence(p.tier.value, config)) if (!met.has(k)) g.addEdge(rid, 'missed', nodeId.evidence(k));
      for (const line of p.tier.because) {
        const ruleId = ruleForBecause(line, config);
        if (ruleId && g.node(ruleId)) g.addEdge(rid, 'touched', ruleId);
      }
    }
  }

  for (const o of input.outcomes) {
    const rec = o.record;
    if (!g.node(nodeId.receipt(rec.receipt_id))) continue;
    const oid = nodeId.outcome(rec.receipt_id);
    g.addNode('Outcome', oid, `${rec.receipt_id}: ${rec.result}`, { result: rec.result, merged_by: rec.merged_by, human: rec.human, tier: rec.tier, at: rec.at });
    g.addEdge(oid, 'resolves', nodeId.receipt(rec.receipt_id));
    // Only checks the config names: a check name is otherwise whatever a CI file calls its job.
    for (const name of rec.flaky) if (g.node(nodeId.check(name))) g.addEdge(oid, 'flaky', nodeId.check(name));
  }

  const current = new Map<Tier, boolean>();
  for (const s of input.standings) {
    const rec = s.record;
    g.addNode('StandingEvent', nodeId.standing(s.id), `tier ${rec.tier} ${rec.standing ? 'promoted' : 'demoted'}`, { standing: rec.standing, tier: rec.tier, confirmed: !!rec.confirmed_by, at: rec.at });
    g.addEdge(nodeId.standing(s.id), 'changed', nodeId.tier(rec.tier));
    current.set(rec.tier, rec.standing);
  }
  for (const [t, has] of current) if (has) g.addEdge(nodeId.repo, 'has_standing', nodeId.tier(t));

  infer(g);
  return g;
}

/** An outcome that says the change should not have gone through as it was. */
export function wentWrong(outcome: GraphNode): boolean {
  return outcome.props.result === 'reverted' || outcome.props.result === 'failed' || outcome.props.human === 'disagree';
}

/** Add the inferred relations. Each is a fixed rule over asserted edges; no model is involved. */
export function infer(g: Graph): void {
  // Check provides E, and Tier requires E  =>  Check gates Tier.
  for (const c of g.ofType('Check')) {
    for (const e of g.out(c.id, 'provides')) for (const t of g.in(e.id, 'requires')) g.addEdge(c.id, 'gates', t.id);
  }
  // Outcome resolves Receipt, Receipt touched Rule, and the outcome went wrong  =>  Rule went_wrong_in Outcome.
  for (const o of g.ofType('Outcome').filter(wentWrong)) {
    for (const r of g.out(o.id, 'resolves')) for (const rule of g.out(r.id, 'touched')) g.addEdge(rule.id, 'went_wrong_in', o.id);
  }
}

export interface History {
  receipts: number;
  escalated: number;
  would_merge: number;
  merged: number;
  abandoned: number;
  reverted: number;
  failed_watch: number;
  disagreed: number;
  agreed: number;
  /** Evidence kind to the number of receipts that needed it and lacked it. */
  missed: Record<string, number>;
  /** Check name to the number of outcomes in which it passed only after failing. */
  flaky: Record<string, number>;
}

/** Count what happened to a set of receipts. */
export function historyOf(g: Graph, receipts: GraphNode[]): History {
  const h: History = { receipts: receipts.length, escalated: 0, would_merge: 0, merged: 0, abandoned: 0, reverted: 0, failed_watch: 0, disagreed: 0, agreed: 0, missed: {}, flaky: {} };
  for (const r of receipts) {
    const d = r.props.decision;
    if (d === 'escalate') h.escalated += 1;
    else if (d === 'would_merge') h.would_merge += 1;
    else if (d === 'merge') h.merged += 1;
    else if (d === 'abandon') h.abandoned += 1;
    for (const e of g.out(r.id, 'missed')) h.missed[e.label] = (h.missed[e.label] ?? 0) + 1;
    for (const o of g.in(r.id, 'resolves')) {
      if (o.props.result === 'reverted') h.reverted += 1;
      if (o.props.result === 'failed') h.failed_watch += 1;
      if (o.props.human === 'disagree') h.disagreed += 1;
      if (o.props.human === 'agree') h.agreed += 1;
      for (const c of g.out(o.id, 'flaky')) h.flaky[c.label] = (h.flaky[c.label] ?? 0) + 1;
    }
  }
  return h;
}

export const ruleHistory = (g: Graph, ruleId: string): History => historyOf(g, g.in(ruleId, 'touched'));
export const repoHistory = (g: Graph): History => historyOf(g, g.ofType('Receipt'));

/**
 * The graph as JSON-LD, schema included. The shape follows JSON-LD 1.1 as I
 * understand it; it has not been run through a JSON-LD processor.
 */
export function toJsonLd(g: Graph): Record<string, unknown> {
  const iri = (nodeId: string) => `urn:oafactory:${encodeURIComponent(g.repo)}:${encodeURIComponent(nodeId)}`;
  const schema: unknown[] = [
    ...Object.entries(ONTOLOGY.classes).map(([name, c]) => ({ '@id': `oaf:${name}`, '@type': 'rdfs:Class', 'rdfs:comment': c.description })),
    ...Object.entries(ONTOLOGY.relations).map(([name, r]) => ({
      '@id': `oaf:${name}`, '@type': 'rdf:Property', 'rdfs:domain': { '@id': `oaf:${r.domain}` }, 'rdfs:range': { '@id': `oaf:${r.range}` },
      'rdfs:comment': r.description,
    })),
  ];
  const instances = [...g.nodes.values()].map((n) => {
    const doc: Record<string, unknown> = { '@id': iri(n.id), '@type': `oaf:${n.type}`, 'rdfs:label': n.label, 'oaf:props': { '@type': '@json', '@value': n.props } };
    for (const e of g.edges.filter((x) => x.from === n.id)) {
      ((doc[`oaf:${e.rel}`] ??= []) as unknown[]).push({ '@id': iri(e.to) });
    }
    return doc;
  });
  return {
    '@context': { oaf: ONTOLOGY_IRI, rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#' },
    '@graph': [...schema, ...instances],
  };
}

// --- Persistence. Mutable tables next to the Ledger's, like the operational state; never the `records` table. ---

export class GraphStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (repo TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL, props TEXT NOT NULL,
        PRIMARY KEY (repo, id));
      CREATE TABLE IF NOT EXISTS graph_edges (repo TEXT NOT NULL, src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, inferred INTEGER NOT NULL,
        PRIMARY KEY (repo, src, rel, dst));
      CREATE INDEX IF NOT EXISTS graph_edges_dst ON graph_edges (repo, dst, rel);
      CREATE TABLE IF NOT EXISTS graph_meta (repo TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, built_at TEXT NOT NULL);
    `);
  }

  fingerprint(repo: string): string | undefined {
    const r = this.db.prepare('SELECT fingerprint FROM graph_meta WHERE repo = ?').get(repo) as { fingerprint: string } | undefined;
    return r?.fingerprint;
  }

  /** Replace the stored graph for a repository, all or nothing. */
  save(g: Graph, fingerprint: string, at: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM graph_edges WHERE repo = ?').run(g.repo);
      this.db.prepare('DELETE FROM graph_nodes WHERE repo = ?').run(g.repo);
      const node = this.db.prepare('INSERT INTO graph_nodes (repo, id, type, label, props) VALUES (?, ?, ?, ?, ?)');
      for (const n of g.nodes.values()) node.run(g.repo, n.id, n.type, n.label, JSON.stringify(n.props));
      const edge = this.db.prepare('INSERT INTO graph_edges (repo, src, rel, dst, inferred) VALUES (?, ?, ?, ?, ?)');
      for (const e of g.edges) edge.run(g.repo, e.from, e.rel, e.to, e.inferred ? 1 : 0);
      this.db.prepare('INSERT INTO graph_meta (repo, fingerprint, built_at) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET fingerprint = excluded.fingerprint, built_at = excluded.built_at')
        .run(g.repo, fingerprint, at);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  load(repo: string): Graph | undefined {
    if (!this.fingerprint(repo)) return undefined;
    const g = new Graph(repo);
    for (const r of this.db.prepare('SELECT id, type, label, props FROM graph_nodes WHERE repo = ? ORDER BY rowid').all(repo) as Array<Record<string, string>>) {
      g.addNode(r.type as NodeType, r.id!, r.label!, JSON.parse(r.props!) as Record<string, unknown>);
    }
    for (const r of this.db.prepare('SELECT src, rel, dst FROM graph_edges WHERE repo = ? ORDER BY rowid').all(repo) as Array<Record<string, string>>) {
      g.addEdge(r.src!, r.rel as Relation, r.dst!);
    }
    return g;
  }
}

export interface SyncDeps { db: DatabaseSync; ledger: Ledger; store: Store; repo: string; config: FactoryConfig; now?: () => Date }

/**
 * Bring the stored graph up to date with the config and the Ledger, and return
 * it. The graph is rebuilt only when something it is built from has changed.
 */
export function syncGraph(deps: SyncDeps): { graph: Graph; rebuilt: boolean } {
  const { ledger, store, repo, config } = deps;
  const input: GraphInput = { repo, config, receipts: ledger.receipts(repo), outcomes: ledger.outcomes(repo), standings: ledger.standings(repo), runs: store.runs(repo) };
  const fingerprint = createHash('sha256').update(JSON.stringify([
    ONTOLOGY_VERSION, config, input.receipts.map((r) => r.seq), input.outcomes.map((r) => r.seq), input.standings.map((r) => r.seq), input.runs,
  ])).digest('hex');
  const graphs = new GraphStore(deps.db);
  if (graphs.fingerprint(repo) === fingerprint) {
    const stored = graphs.load(repo);
    if (stored) return { graph: stored, rebuilt: false };
  }
  const graph = buildGraph(input);
  graphs.save(graph, fingerprint, (deps.now ?? (() => new Date()))().toISOString());
  return { graph, rebuilt: true };
}
