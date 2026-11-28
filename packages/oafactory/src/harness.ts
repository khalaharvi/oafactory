import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, effectiveBudget, parseFactoryConfig, type FactoryConfig } from './config.js';
import type { Gateway } from './gateway.js';
import { gate, recordAbandoned, type GateDeps, type GateOptions, type GateResult } from './gate.js';
import type { Host, Issue } from './host/types.js';
import { isInstructionFile, useBaseInstructions, walk } from './instructions.js';
import type { RunRow } from './ledger.js';
import { makeReviewer, type Reviewer } from './reviewer.js';
import type { Sandbox } from './sandbox.js';
import type { WorkOrder } from './types.js';
import { API_VERSION } from './config.js';
import type { Transport } from './workspace.js';

/**
 * Starting points for common agents. The task and model arrive in environment
 * variables, so untrusted issue text is never interpolated into a shell command.
 * Flags differ between agent versions: check them, or use `use: command`.
 */
export const RUNNER_COMMANDS: Record<string, string> = {
  // Run live with mini-swe-agent 2.4.6. MSWEA_CONFIGURED skips its first-run setup prompt, which aborts without a terminal.
  // Its model library (litellm) needs the provider in the model name, and fetches a price list from GitHub unless told not to.
  // The Gateway meters spending, so mini's own cost limit is off.
  'mini-swe-agent': 'MSWEA_CONFIGURED=true MSWEA_COST_TRACKING=ignore_errors LITELLM_LOCAL_MODEL_COST_MAP=True mini -m "$OAFACTORY_API_STYLE/$OAFACTORY_MODEL" -t "$OAFACTORY_TASK" -y --exit-immediately -l 0',
  // Run live with Claude Code 2.1.332. Without the variable it also calls api.anthropic.com directly, which the Gateway refuses.
  // Skipping permission prompts is what lets it run unattended; the Sandbox, not Claude Code, is the boundary.
  'claude-code': 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude -p "$OAFACTORY_TASK" --model "$OAFACTORY_MODEL" --dangerously-skip-permissions',
  pi: 'pi -p "$OAFACTORY_TASK" --model "$OAFACTORY_MODEL"',
  codex: 'codex exec --full-auto -m "$OAFACTORY_MODEL" "$OAFACTORY_TASK"',
};

/** File name of the built-in Runner's standalone entry point, next to this module once compiled. */
export const AGENT_ENTRY = 'agent-bin.js';

/**
 * The NODE_OPTIONS value for the built-in Runner, or '' for none. From Node 26
 * it runs under Node's permission model: its own file access is limited to the
 * project and the directory it was loaded from. This is a second layer under
 * the path checks in the agent's tools. It does not confine the commands the
 * agent runs, which is the Sandbox's job.
 *
 * The flags travel in an environment variable, so no command line is ever
 * assembled from a path.
 */
export function nodeOptions(nodeVersion: string, workDir: string, toolsDir: string): string {
  const major = Number.parseInt(nodeVersion.trim().replace(/^v/, ''), 10);
  if (!Number.isFinite(major) || major < 26) return '';
  // NODE_OPTIONS quotes a value with double quotes. Rather than guess at its escaping rules,
  // run without the permission model when a path contains a quote or a backslash.
  if ([workDir, toolsDir].some((p) => p.includes('"') || p.includes('\\'))) return '';
  // One flag per path: recent Node versions do not split a comma-separated list.
  const paths = [`--allow-fs-read=${workDir}`, `--allow-fs-read=${toolsDir}`, `--allow-fs-write=${workDir}`].map((f) => `"${f}"`);
  return ['--permission', '--allow-child-process', '--allow-net', ...paths].join(' ');
}

export function runnerCommand(config: FactoryConfig): string {
  const role = config.roles.runner;
  if (role.use === 'builtin') return 'node "$OAFACTORY_AGENT"';
  const cmd = role.use === 'command' ? role.command : RUNNER_COMMANDS[role.use];
  if (!cmd) throw new Error(`no runner adapter for "${role.use}". Known: builtin, ${Object.keys(RUNNER_COMMANDS).join(', ')}, or "command" with roles.runner.command.`);
  return cmd;
}

/** The label a maintainer applies to turn an issue into a work order. */
export const WORK_LABEL = 'oafactory';

/**
 * Derive a work order from an issue. Authorization is the label, applied by
 * someone who can write to the repository. The issue text supplies only the
 * intent: it cannot set scope, budget or tier.
 */
export function workOrderFromIssue(issue: Issue, hostKind: string, scope: string[] = ['*']): WorkOrder {
  const label = issue.labels.find((l) => l.name === WORK_LABEL);
  if (!label) throw new Error(`issue #${issue.number} does not carry the "${WORK_LABEL}" label`);
  if (!label.appliedByMaintainer) throw new Error(`the "${WORK_LABEL}" label on issue #${issue.number} was applied by ${label.appliedBy ?? 'an unknown user'}, who cannot write to the repository`);
  return {
    apiVersion: API_VERSION, kind: 'WorkOrder', id: String(issue.number).padStart(4, '0'),
    source: { host: hostKind, issue: issue.number }, requested_by: label.appliedBy!,
    intent: `${issue.title}\n\n${issue.body}`.trim(), scope: { paths: scope },
  };
}

export interface HarnessDeps {
  /** Host with the Harness credential: push branch, open change. */
  host: Host;
  /** Gate dependencies, whose host carries the Gate credential. */
  gate: GateDeps;
  gateway: Gateway;
  gatewayUrl: string;
  sandbox: Sandbox;
  transport: Transport;
  /** Directory holding the compiled built-in Runner. Defaults to this module's directory. */
  agentDir?: string;
  reviewer?: Reviewer;
  gateOptions?: GateOptions;
  now?: () => Date;
  log?: (msg: string) => void;
  keepWorkspaces?: boolean;
}

export interface AttemptResult { run: RunRow; change: number | null; gate?: GateResult; abandoned?: string }

function gatewayEnv(url: string, key: string): Record<string, string> {
  const hostPort = new URL(url).host;
  return {
    OAFACTORY_GATEWAY_URL: url, OAFACTORY_RUN_KEY: key,
    OPENAI_BASE_URL: `${url}/v1`, OPENAI_API_KEY: key, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: key,
    HTTPS_PROXY: url, HTTP_PROXY: url, https_proxy: url, http_proxy: url, NO_PROXY: hostPort.split(':')[0]!, no_proxy: hostPort.split(':')[0]!,
    // Node 24 and later: make fetch and http honour the proxy variables above, so Node programs
    // in the Sandbox can reach the allowlisted hosts through the Gateway. Older versions ignore it.
    NODE_USE_ENV_PROXY: '1',
  };
}

/** Run a work order: up to `max_attempts` runs, each ending in exactly one receipt. */
export async function runWorkOrder(deps: HarnessDeps, wo: WorkOrder): Promise<AttemptResult[]> {
  const { host, gateway, sandbox, transport } = deps;
  const { store } = deps.gate;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const baseRef = await host.defaultBranch();
  const text = await host.readFile(CONFIG_PATH, baseRef);
  if (text === null) throw new Error(`${CONFIG_PATH} does not exist on ${baseRef}; run \`oafactory init\` first`);
  const config = parseFactoryConfig(text);
  const budget = effectiveBudget(config, wo);
  const command = runnerCommand(config);
  const runner = gateway.describe(config.roles.runner.model);
  const reviewerModel = gateway.describe(config.roles.reviewer.model);
  const builtin = config.roles.runner.use === 'builtin';
  // Every Runner learns which API style its model alias speaks, so a command can name the provider (mini-swe-agent needs it).
  const runnerEnv: Record<string, string> = {
    OAFACTORY_API_STYLE: gateway.model(config.roles.runner.model)!.provider,
    ...(builtin ? { OAFACTORY_AGENT: sandbox.toolPath(deps.agentDir ?? dirname(fileURLToPath(import.meta.url)), AGENT_ENTRY) } : {}),
  };
  const reviewer = deps.reviewer ?? makeReviewer(config, gateway, sandbox, (k) => gatewayEnv(deps.gatewayUrl, k));
  if (!sandbox.contained) log('warning: the sandbox is not contained; do not run untrusted work this way');

  const results: AttemptResult[] = [];
  let feedback = '';
  for (let attempt = 1; attempt <= budget.max_attempts; attempt++) {
    const id = `${wo.id}-${attempt}`;
    if (store.getRun(id)) throw new Error(`run ${id} already exists; a work order id can be used once`);
    const run: RunRow = {
      id, repo: host.repo, work_order: wo, attempt, state: 'queued', change: null, base_sha: null, head_sha: null,
      runner: config.roles.runner.use, runner_model: runner.resolved, runner_family: runner.family,
      reviewer: config.roles.reviewer.use, reviewer_model: reviewerModel.resolved, reviewer_family: reviewerModel.family,
      budget_usd: budget.usd_per_run, budget_minutes: budget.minutes_per_run, started_at: null, ended_at: null,
    };
    store.putRun(run);
    const dir = await mkdtemp(join(tmpdir(), `oafactory-${id}-`));
    const work = join(dir, 'work');
    const abandon = (reason: string, baseSha: string): AttemptResult => {
      gateway.revoke(id);
      recordAbandoned(deps.gate, store.getRun(id)!, config, reason, baseSha);
      log(`run ${id}: abandoned. ${reason}`);
      return { run: store.getRun(id)!, change: store.getRun(id)!.change, abandoned: reason };
    };
    try {
      // Every attempt starts from the base branch, so the Runner only ever loads base-branch instruction files.
      const baseSha = await transport.checkout(work, baseRef);
      store.updateRun(id, { state: 'running', base_sha: baseSha, started_at: now().toISOString() });
      const key = gateway.issueKey(id, budget.usd_per_run);
      const task = feedback ? `${wo.intent}\n\nA previous attempt was not accepted:\n${feedback}` : wo.intent;
      log(`run ${id}: ${config.roles.runner.use} on ${runner.resolved}, budget $${budget.usd_per_run} / ${budget.minutes_per_run} min`);
      const nodeEnv: Record<string, string> = {};
      if (builtin) {
        // Ask the Sandbox which Node it has, and use the permission model where it exists.
        const version = await sandbox.exec('node -p process.versions.node', { cwd: work, env: {}, timeoutMs: 60_000 });
        const options = version.code === 0 ? nodeOptions(version.stdout, sandbox.workPath(work), dirname(runnerEnv.OAFACTORY_AGENT!)) : '';
        if (options) {
          nodeEnv.NODE_OPTIONS = options;
          log(`run ${id}: Node ${version.stdout.trim()} in the sandbox; the built-in Runner is under Node's permission model`);
        }
      }
      const res = await sandbox.exec(command, {
        cwd: work, timeoutMs: budget.minutes_per_run * 60_000,
        env: { ...gatewayEnv(deps.gatewayUrl, key), ...runnerEnv, ...nodeEnv, OAFACTORY_TASK: task, OAFACTORY_MODEL: config.roles.runner.model, OAFACTORY_SCOPE: wo.scope.paths.join(':') },
      });
      gateway.revoke(id);
      store.updateRun(id, { ended_at: now().toISOString() });

      const spent = store.usage(id).cost_usd;
      if (res.timedOut) { results.push(abandon(`Run exceeded its time budget of ${budget.minutes_per_run} minutes.`, baseSha)); break; }
      if (spent >= budget.usd_per_run) { results.push(abandon(`Run reached its budget of $${budget.usd_per_run} (spent $${spent.toFixed(2)}).`, baseSha)); break; }
      if (res.code !== 0) { results.push(abandon(`Runner exited with status ${res.code}.${res.stderr.trim() ? ` Last output: ${res.stderr.trim().split('\n').at(-1)!.slice(0, 300)}` : ''}`, baseSha)); break; }

      const branch = `oafactory/${id}`;
      const pub = await transport.publish(work, baseSha, branch, `${wo.intent.split('\n')[0]!.slice(0, 72)}\n\nWork order ${wo.id}, attempt ${attempt}.`);
      if (!pub) { results.push(abandon('Runner made no changes.', baseSha)); break; }
      const number = await host.openChange({
        head: branch, base: baseRef, title: wo.intent.split('\n')[0]!.slice(0, 120),
        body: `Work order \`${wo.id}\`, attempt ${attempt}, requested by ${wo.requested_by}.${wo.source?.issue ? ` Source: #${wo.source.issue}.` : ''}\n\nOpened by the OAFactory Harness. The Gate's receipt follows as a comment; nothing in this description is evidence.`,
      });
      store.updateRun(id, { state: 'gated', change: number, head_sha: pub.headSha });
      log(`run ${id}: opened change #${number} at ${pub.headSha.slice(0, 12)}`);

      // Review from a fresh context: the Reviewer sees the task and the diff, never the Runner's transcript.
      try {
        const baseDir = join(dir, 'base');
        await transport.checkout(baseDir, baseRef);
        const baseInstructions = await Promise.all((await walk(baseDir)).filter(isInstructionFile).map(async (p) => ({ path: p, content: await readFile(join(baseDir, p), 'utf8') })));
        await useBaseInstructions(work, baseDir);
        await writeFile(join(work, '.oafactory-review.diff'), pub.diff);
        const verdict = await reviewer({ intent: wo.intent, diff: pub.diff, baseInstructions, runId: id, checkout: work });
        store.putReview({
          repo: host.repo, change: number, head_sha: pub.headSha, verdict: verdict.verdict, comments: verdict.comments,
          reviewer: config.roles.reviewer.use, reviewer_model: reviewerModel.resolved, reviewer_family: reviewerModel.family, runner_family: runner.family,
          fresh_context: true, at: now().toISOString(),
        });
        log(`run ${id}: review ${verdict.verdict}`);
      } catch (e) {
        log(`run ${id}: review failed (${(e as Error).message}); the change will have no review evidence`);
      } finally {
        gateway.revoke(id);
      }

      let result: GateResult;
      try {
        result = await gate(deps.gate, number, deps.gateOptions);
      } catch (e) {
        // The change is open and the run is recorded; only the decision is missing. It can be made later.
        throw new Error(`the Gate could not evaluate change #${number} (${(e as Error).message}). Run ${id} is still waiting: once the cause is fixed, run \`oafactory gate ${number}\`.`);
      }
      results.push({ run: store.getRun(id)!, change: number, gate: result });
      log(`run ${id}: ${result.decision}. ${result.statement.predicate.decision.reason}`);
      if (result.decision !== 'escalate') break;

      // A failed check or a request_changes review MAY start another attempt.
      const ev = result.statement.predicate.evidence;
      const checks = ev.find((e) => e.kind === 'checks');
      const failed = Object.entries((checks?.detail ?? {}) as Record<string, string>).filter(([, v]) => v === 'failure').map(([k]) => k);
      const review = store.getReview(host.repo, number, pub.headSha);
      const parts: string[] = [];
      if (failed.length) parts.push(`Failed checks: ${failed.join(', ')}.`);
      if (review?.verdict === 'request_changes') parts.push(`Reviewer requested changes:\n${review.comments.map((c) => `- ${c}`).join('\n')}`);
      if (parts.length === 0) break;
      feedback = parts.join('\n');
    } catch (e) {
      const cur = store.getRun(id)!;
      if (cur.state === 'queued' || cur.state === 'running') results.push(abandon(`Harness error: ${(e as Error).message}`, cur.base_sha ?? 'unknown'));
      throw e;
    } finally {
      if (!deps.keepWorkspaces) await rm(dir, { recursive: true, force: true });
    }
  }
  return results;
}
