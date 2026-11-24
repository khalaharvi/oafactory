import { Ledger, Store, openDb, type RunRow } from '../src/ledger.js';
import { FakeHost } from '../src/host/fake.js';
import { LocalKeySigner } from '../src/receipt.js';
import type { GateDeps } from '../src/gate.js';
import type { WorkOrder } from '../src/types.js';

export const CONFIG = `apiVersion: oafactory/v1alpha1
kind: Factory
protected: [.oafactory/, .github/, .gitlab-ci.yml, Makefile, AGENTS.md, CLAUDE.md]
append_only: [tests/]
checks:
  required: [lint, test]
  holdout: []
budget: { usd_per_run: 2.50, minutes_per_run: 30, max_attempts: 2 }
roles:
  runner:   { use: mini-swe-agent, model: oafactory/coder }
  reviewer: { use: pr-agent, model: oafactory/reviewer }
tiers:
  default: 2
  rules:
    - { paths: ["docs/**", "*.md"], tier: 0 }
    - { paths: ["src/**", "tests/**"], tier: 1 }
    - { paths: ["install/**"],      tier: 3 }
  limits:
    0: { max_lines: 200, max_files: 10 }
    1: { max_lines: 150, max_files: 5 }
autonomy:
  mode: shadow
  promote:
    0: { after_held: 20, min_agreement: 0.95, max_reverts: 0 }
    1: { after_held: 50, min_agreement: 0.95, max_reverts: 0 }
  audit_rate: 0.10
watch: { window_hours: 168 }
`;

export const REPO_FILES: Record<string, string> = {
  '.oafactory/factory.yaml': CONFIG,
  'README.md': '# widgets\n',
  'docs/guide.md': 'guide\n',
  'src/config.py': 'def load():\n    return {}\n',
  'tests/test_config.py': 'def test_load():\n    pass\n',
  'Makefile': 'test:\n\tpytest\n',
  'AGENTS.md': 'Be careful.\n',
};

export interface Rig { host: FakeHost; ledger: Ledger; store: Store; deps: GateDeps; signer: LocalKeySigner; publicKeyPem: string; n: number }

export function rig(opts: { config?: string; random?: () => number; signer?: boolean } = {}): Rig {
  const host = new FakeHost('acme/widgets', { ...REPO_FILES, '.oafactory/factory.yaml': opts.config ?? CONFIG });
  const db = openDb(':memory:');
  const ledger = new Ledger(db);
  const store = new Store(db);
  const { signer, publicKeyPem } = LocalKeySigner.generate();
  const deps: GateDeps = { host, ledger, store, random: opts.random ?? (() => 0.99), now: () => host.now(), ...(opts.signer === false ? {} : { signer }) };
  return { host, ledger, store, deps, signer, publicKeyPem, n: 0 };
}

export const earned = (c = CONFIG) => c.replace('mode: shadow', 'mode: earned');

export function workOrder(id: string, paths = ['docs/', 'src/', 'tests/', '*.md']): WorkOrder {
  return { apiVersion: 'oafactory/v1alpha1', kind: 'WorkOrder', id, requested_by: 'krishna', intent: 'Do the thing.', scope: { paths } };
}

/** Open a change with a factory run behind it, green checks, test reports and (optionally) an approving review. */
export function propose(r: Rig, edits: Record<string, string | null>, opts: { scope?: string[]; cost?: number; review?: 'approve' | 'request_changes' | false; sameFamily?: boolean; checks?: boolean; reports?: boolean; attempt?: number; body?: string } = {}) {
  r.n += 1;
  const id = String(r.n).padStart(4, '0');
  const attempt = opts.attempt ?? 1;
  const change = r.host.propose(edits, { title: `change ${id}`, body: opts.body });
  const started = r.host.now().toISOString();
  r.host.advance(0.1);
  const run: RunRow = {
    id: `${id}-${attempt}`, repo: r.host.repo, work_order: workOrder(id, opts.scope), attempt, state: 'gated', change: change.number,
    base_sha: change.baseSha, head_sha: change.headSha,
    runner: 'mini-swe-agent', runner_model: 'anthropic/model-a', runner_family: 'anthropic',
    reviewer: 'pr-agent', reviewer_model: 'openai/model-b', reviewer_family: opts.sameFamily ? 'anthropic' : 'openai',
    budget_usd: 2.5, budget_minutes: 30, started_at: started, ended_at: r.host.now().toISOString(),
  };
  r.store.putRun(run);
  r.store.addUsage(run.id, 'anthropic/model-a', 1000, 500, opts.cost ?? 0.5);
  if (opts.checks !== false) r.host.passAll(change.headSha, ['lint', 'test']);
  if (opts.reports !== false) {
    r.host.setReport(change.baseSha, { tests: [{ id: 't::a', skipped: false }, { id: 't::b', skipped: false }] });
    r.host.setReport(change.headSha, { tests: [{ id: 't::a', skipped: false }, { id: 't::b', skipped: false }, { id: 't::c', skipped: false }] });
  }
  if (opts.review !== false) {
    r.store.putReview({
      repo: r.host.repo, change: change.number, head_sha: change.headSha, verdict: opts.review ?? 'approve', comments: [],
      reviewer: 'pr-agent', reviewer_model: 'openai/model-b', reviewer_family: opts.sameFamily ? 'anthropic' : 'openai', runner_family: 'anthropic',
      fresh_context: true, at: r.host.now().toISOString(),
    });
  }
  return { change, run };
}

export const DOC_EDIT = { 'docs/guide.md': 'guide\nmore\n' };
export const SRC_EDIT = { 'src/config.py': 'def load():\n    return {"a": 1}\n', 'tests/test_empty.py': 'def test_empty():\n    pass\n' };
