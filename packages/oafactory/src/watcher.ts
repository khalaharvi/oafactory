import { CONFIG_PATH, parseFactoryConfig, type FactoryConfig } from './config.js';
import { gateRevert, type GateDeps } from './gate.js';
import type { Host } from './host/types.js';
import type { Ledger, OutcomeRecord, Store } from './ledger.js';
import { applyOutcome } from './standing.js';
import type { Tier } from './types.js';

export interface WatchDeps {
  host: Host;
  ledger: Ledger;
  store: Store;
  now?: () => Date;
  /** When set, the Gate may merge an exact-inverse revert automatically. */
  gate?: GateDeps;
}

export interface WatchEvent {
  receipt_id: string;
  change: number;
  action: 'pending' | 'watching' | 'rerun' | 'held' | 'reverted' | 'failed' | 'closed';
  detail?: string;
  demoted?: Tier[];
}

/**
 * One pass of the Watcher (spec section 11). Safe to run on a schedule: every
 * decision it makes is derived from the host and the Ledger, and each receipt
 * gets at most one Outcome.
 */
export async function watch(deps: WatchDeps): Promise<WatchEvent[]> {
  const { host, ledger, store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const branch = await host.defaultBranch();
  const text = await host.readFile(CONFIG_PATH, branch);
  if (text === null) throw new Error(`${CONFIG_PATH} does not exist on ${branch}`);
  const config: FactoryConfig = parseFactoryConfig(text);
  const events: WatchEvent[] = [];

  for (const stored of ledger.receipts(host.repo)) {
    const st = stored.record.statement;
    const p = st.predicate;
    const number = p.change.number;
    if (number === null || (p.decision.value !== 'merge' && p.decision.value !== 'would_merge')) continue;
    if (ledger.outcome(p.id)) continue;

    const change = await host.getChange(number);
    const evaluated = st.subject[0]!.digest.gitCommit;
    const base = { receipt_id: p.id, repo: host.repo, change: number, tier: p.tier.value, flaky: [] as string[], at: now.toISOString() };
    const finish = (o: Omit<OutcomeRecord, 'kind' | 'receipt_id' | 'repo' | 'change' | 'tier' | 'at' | 'flaky'> & { flaky?: string[] }, action: WatchEvent['action'], detail?: string) => {
      const outcome: OutcomeRecord = { kind: 'outcome', ...base, ...o, flaky: o.flaky ?? [] };
      ledger.writeOutcome(outcome);
      const demoted = applyOutcome(ledger, config, outcome);
      const run = store.latestRunForChange(host.repo, number);
      if (run && (o.result === 'held' || o.result === 'reverted')) store.updateRun(run.id, { state: o.result });
      events.push({ receipt_id: p.id, change: number, action, detail, ...(demoted.length ? { demoted } : {}) });
    };

    if (change.state === 'open') { events.push({ receipt_id: p.id, change: number, action: 'pending', detail: 'waiting for a person' }); continue; }
    const wouldMerge = p.decision.value === 'would_merge';
    if (change.state === 'closed') {
      finish({ result: 'closed', merged_by: null, human: wouldMerge ? 'disagree' : null }, 'closed', 'closed without merging');
      continue;
    }

    const mergeSha = change.mergeSha!;
    const merged_by = wouldMerge ? 'person' as const : 'factory' as const;
    // A person merging with no further commits agrees.
    const human = wouldMerge ? (change.headSha === evaluated ? 'agree' as const : 'disagree' as const) : null;
    const common = { merged_by, human, merge_sha: mergeSha };

    // A revert by a person that references the merge commit counts the same as a factory revert.
    const later = await host.commitsAfter(branch, mergeSha);
    const revert = later.find((c) => c.message.includes(mergeSha) || c.message.includes(`Reverts ${host.repo}#${number}`));
    if (revert) { finish({ ...common, result: 'reverted', note: `reverted by ${revert.sha.slice(0, 12)}` }, 'reverted', 'a revert references the merge commit'); continue; }

    const checks = new Map((await host.listChecks(mergeSha)).map((c) => [c.name, c]));
    const flaky: string[] = [];
    let failing: string | undefined;
    let rerun: string | undefined;
    for (const name of config.checks.required) {
      const c = checks.get(name);
      if (!c) continue;
      if (c.conclusion === 'failure') {
        if (c.attempts === 1) { await host.rerunCheck(mergeSha, c); rerun = name; }
        else failing = name;
      } else if (c.conclusion === 'pending' && c.failedBefore) rerun = name;
      else if (c.conclusion === 'success' && c.failedBefore) flaky.push(name);
    }

    if (failing) {
      if (merged_by === 'factory') {
        const n = await host.openRevert(mergeSha, `Revert change #${number}`, `Required check \`${failing}\` failed twice at merge commit ${mergeSha}. Opened by the OAFactory Watcher for receipt \`${p.id}\`.`);
        let detail = `check ${failing} failed twice; opened revert #${n}`;
        if (deps.gate) {
          const r = await gateRevert(deps.gate, n, mergeSha);
          detail += r.merged ? ' and merged it' : ` (not merged automatically: ${r.reason})`;
        }
        finish({ ...common, result: 'reverted', flaky, note: detail }, 'reverted', detail);
      } else {
        finish({ ...common, result: 'failed', flaky, note: `check ${failing} failed twice at the merge commit` }, 'failed', `check ${failing} failed twice at the merge commit`);
      }
      continue;
    }
    if (rerun) { events.push({ receipt_id: p.id, change: number, action: 'rerun', detail: `reran ${rerun} once` }); continue; }

    const elapsedHours = (now.getTime() - Date.parse(change.mergedAt ?? now.toISOString())) / 3_600_000;
    if (elapsedHours >= config.watch.window_hours) {
      finish({ ...common, result: 'held', flaky }, 'held', flaky.length ? `flaky: ${flaky.join(', ')}` : undefined);
    } else {
      const run = store.latestRunForChange(host.repo, number);
      if (run && run.state !== 'watching') store.updateRun(run.id, { state: 'watching' });
      events.push({ receipt_id: p.id, change: number, action: 'watching', detail: `${Math.max(0, config.watch.window_hours - elapsedHours).toFixed(0)}h left` });
    }
  }
  return events;
}
