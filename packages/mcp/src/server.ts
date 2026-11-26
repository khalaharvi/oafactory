import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import {
  CONFIG_PATH, Ledger, Store, defaultLedgerPath, effectiveBudget, explainReceipt, explainWorkOrder, hasStanding, listWorkOrders, newWorkOrder,
  openDb, parseFactoryConfig, promotionStatus, ready, saveWorkOrder, serializeWorkOrder, workOrderDir, workOrderNotes,
  type FactoryConfig, type Tier, type WorkOrder,
} from 'oafactory';
import { z } from 'zod';

export const VERSION = '0.2.0';

export interface ServerOptions {
  /** The repository root: where `.oafactory/factory.yaml` lives. */
  cwd: string;
  /** `owner/name`. Used to find this repository's records and saved work orders. */
  repo: string;
  /** Who is at the keyboard. Recorded as the work order's `requested_by`. */
  requestedBy: string;
  ledgerPath?: string;
  /** Directory for saved work orders. Defaults to one outside the repository. */
  workOrders?: string;
  /**
   * Expose `run_work_order`. Off by default: without it this server can draft,
   * explain and save work orders, and a person starts them from a terminal.
   */
  allowRun?: boolean;
  /** How to start a run: the program and its leading arguments. Defaults to the `oafactory` CLI. */
  runCommand?: string[];
}

const INSTRUCTIONS = `OAFactory turns a written request (a "work order") into a proposed code change, made by an AI coding agent in a sandbox and judged by a fixed set of rules called the Gate.

Use these tools to help a person write a good work order and to tell them, in plain words, what will happen and what happened.

- Start with factory_overview to learn this project's rules, budget ceilings and folders.
- Use draft_work_order to check a request and show the person exactly what would happen. It changes nothing.
- Only call save_work_order once the person has seen the draft and agreed to it.
- A work order has three parts: intent (what to do), scope (which folders may change) and budget (money and minutes). Ask the person for anything you are unsure of rather than guessing, especially the scope.
- The first line of the intent becomes the title of the proposed change.
- You cannot approve or merge anything. The Gate, and for most changes a person, decides.`;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const failure = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true });

const orderShape = {
  intent: z.string().min(1).describe('What to do, in a sentence or a short paragraph. The first line becomes the title of the proposed change.'),
  scope: z.array(z.string().min(1)).optional().describe('Folders or files the change may touch, such as ["src/", "tests/"]. A trailing slash means a folder. Omit only if the person wants the whole project in scope.'),
  budget_usd: z.number().positive().optional().describe('Spend limit per attempt in US dollars. Can lower the project ceiling, never raise it.'),
  budget_minutes: z.number().positive().optional().describe('Time limit per attempt in minutes. Can lower the project ceiling, never raise it.'),
  max_attempts: z.number().int().positive().optional().describe('How many attempts are allowed. Can lower the project ceiling, never raise it.'),
};
type OrderInput = { intent: string; scope?: string[]; budget_usd?: number; budget_minutes?: number; max_attempts?: number; id?: string };

/** Build the MCP server. One instance serves one repository. */
export function createServer(opts: ServerOptions): McpServer {
  const server = new McpServer({ name: 'oafactory', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const dir = opts.workOrders ?? workOrderDir(opts.repo);

  const config = async (): Promise<FactoryConfig> => {
    const path = join(opts.cwd, CONFIG_PATH);
    if (!existsSync(path)) throw new Error(`${CONFIG_PATH} was not found in ${opts.cwd}. Run \`oafactory init\` in the repository first.`);
    return parseFactoryConfig(await readFile(path, 'utf8'));
  };
  const stores = () => {
    const db = openDb(opts.ledgerPath ?? defaultLedgerPath());
    return { ledger: new Ledger(db), store: new Store(db) };
  };
  const standingTiers = (ledger: Ledger): Tier[] => ([0, 1] as Tier[]).filter((t) => hasStanding(ledger, opts.repo, t));
  const build = (i: OrderInput): WorkOrder => newWorkOrder({
    intent: i.intent, scope: i.scope, id: i.id, requestedBy: `${opts.requestedBy} (via MCP)`,
    budget: { usd_per_run: i.budget_usd, minutes_per_run: i.budget_minutes, max_attempts: i.max_attempts },
  });
  const describe = (cfg: FactoryConfig, wo: WorkOrder, standing: Tier[]): string => {
    const notes = workOrderNotes(cfg, wo);
    return [
      explainWorkOrder(cfg, wo, { standing }),
      ...(notes.length ? ['', 'Worth knowing before it runs', ...notes.map((n) => `  - ${n}`)] : []),
      '', 'The work order as it would be saved', '```yaml', serializeWorkOrder(wo).trimEnd(), '```',
    ].join('\n');
  };
  const howToRun = (path: string) => (opts.allowRun
    ? 'To start it, call run_work_order with this id once the person has agreed.'
    : `This server is not allowed to start runs. A person starts it from the repository with:\n  oafactory run ${path}`);

  server.registerTool('factory_overview', {
    title: 'Factory overview',
    description: "Read this project's factory rules: whether it is in shadow or earned mode, the budget ceilings, which folders count as low, moderate and sensitive risk, the checks that must pass, and what has been run so far. Call this before drafting a work order.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      const cfg = await config();
      const { ledger, store } = stores();
      const b = effectiveBudget(cfg);
      const paths = (tier: number) => cfg.tiers.rules.filter((r) => r.tier === tier).flatMap((r) => r.paths).join(', ') || '(none)';
      const problems = (await ready(opts.cwd)).filter((f) => f.level === 'fail');
      const runs = store.runs(opts.repo);
      const lines = [
        `Project: ${opts.repo}`,
        `Mode: ${cfg.autonomy.mode}. ${cfg.autonomy.mode === 'shadow' ? 'The factory never accepts a change on its own; a person makes every decision.' : 'The factory may accept changes on its own at risk levels where it has earned standing.'}`,
        '',
        'Budget ceilings (a work order may lower these, never raise them)',
        `  $${b.usd_per_run} and ${b.minutes_per_run} minutes per attempt, at most ${b.max_attempts} attempts.`,
        '',
        'Risk levels, by the files a change touches',
        `  Low risk (tier 0): ${paths(0)}`,
        `  Moderate risk (tier 1): ${paths(1)}`,
        `  Higher risk (tier 2): anything larger, or anything not named above. Always goes to a person.`,
        `  Sensitive (tier 3): ${cfg.protected.join(', ')}, and any existing file under ${cfg.append_only.join(', ') || '(no append-only paths)'}. Always goes to a person.`,
        '',
        `New tests go under: ${cfg.append_only.join(', ') || '(not configured)'}. A code change must add one to be accepted without a person.`,
        `Checks that must pass: ${cfg.checks.required.join(', ')}`,
        `Agent: ${cfg.roles.runner.use}. Reviewer: ${cfg.roles.reviewer.use}.`,
        '',
        'Standing (the earned right to accept changes without a person)',
        ...([0, 1] as const).map((t) => {
          const s = promotionStatus(ledger, cfg, opts.repo, t);
          return `  Tier ${t}: ${s.standing ? 'has standing' : 'no standing'} (${s.held} of ${s.needed} changes held${s.agreement === null ? '' : `, agreement ${s.agreement.toFixed(2)}`})`;
        }),
        '',
        `Runs recorded for this project: ${runs.length}. Saved work orders: ${(await listWorkOrders(dir)).length}.`,
        ...(problems.length ? ['', 'Setup problems that should be fixed before relying on the factory', ...problems.map((p) => `  - ${p.message}`)] : []),
        '',
        opts.allowRun ? 'This server may start runs (run_work_order).' : 'This server may draft and save work orders. Starting a run is left to a person at a terminal.',
      ];
      return text(lines.join('\n'));
    } catch (e) { return failure(e); }
  });

  server.registerTool('draft_work_order', {
    title: 'Draft a work order',
    description: 'Check a request and describe, in plain words, exactly what would happen if it ran: where the agent may work, what it may spend, each step, and who decides at each risk level. Saves nothing and starts nothing. Show the result to the person before saving.',
    inputSchema: z.object(orderShape),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const cfg = await config();
      return text(describe(cfg, build({ ...input, id: 'draft' }), standingTiers(stores().ledger)));
    } catch (e) { return failure(e); }
  });

  server.registerTool('save_work_order', {
    title: 'Save a work order',
    description: 'Save a work order so it can be run. Call this only after the person has seen the draft and agreed to it. The file is written outside the repository. Saving does not start the work.',
    inputSchema: z.object({ ...orderShape, id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional().describe('An id for the work order. Defaults to one based on the current time. An id can be used once.') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    try {
      const cfg = await config();
      const wo = build(input);
      const path = await saveWorkOrder(dir, wo);
      return text([`Saved work order ${wo.id} at ${path}`, '', howToRun(path), '', describe(cfg, wo, standingTiers(stores().ledger))].join('\n'));
    } catch (e) { return failure(e); }
  });

  server.registerTool('list_work_orders', {
    title: 'List work orders',
    description: 'List the saved work orders for this project and what has happened to each: not started, running, waiting for a person, merged, or abandoned.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    try {
      const saved = await listWorkOrders(dir);
      const runs = stores().store.runs(opts.repo);
      if (saved.length === 0 && runs.length === 0) return text('No work orders have been saved or run for this project yet.');
      const ids = [...new Set([...saved.map((s) => s.workOrder.id), ...runs.map((r) => r.work_order.id)])];
      const lines = ids.map((id) => {
        const wo = saved.find((s) => s.workOrder.id === id)?.workOrder ?? runs.find((r) => r.work_order.id === id)!.work_order;
        const mine = runs.filter((r) => r.work_order.id === id);
        const status = mine.length === 0 ? 'not started' : mine.map((r) => `attempt ${r.attempt}: ${r.state}${r.change ? ` (proposed change #${r.change})` : ''}`).join('; ');
        return `${id}: ${wo.intent.split('\n')[0]}\n    ${status}`;
      });
      return text(lines.join('\n'));
    } catch (e) { return failure(e); }
  });

  server.registerTool('get_run', {
    title: 'Get the result of a work order',
    description: 'Report what happened to a work order: the state of each attempt and, where the Gate has decided, a plain-language account of what was checked, what could not be confirmed, what it cost and why.',
    inputSchema: z.object({ work_order_id: z.string().min(1).describe('The id of the work order.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ work_order_id }) => {
    try {
      const { ledger, store } = stores();
      const runs = store.runs(opts.repo).filter((r) => r.work_order.id === work_order_id);
      const parts: string[] = [];
      if (runs.length === 0) {
        const saved = (await listWorkOrders(dir)).some((s) => s.workOrder.id === work_order_id);
        parts.push(saved ? `Work order ${work_order_id} is saved but has not started.` : `No work order with id ${work_order_id} was found for this project.`);
      }
      for (const run of runs) {
        const receipt = ledger.receipt(run.id);
        parts.push(receipt
          ? explainReceipt(receipt.record.statement, ledger.outcome(run.id)?.record)
          : `Attempt ${run.attempt} (${run.id}) is ${run.state}${run.change ? `, proposed change #${run.change}` : ''}. The Gate has not decided yet.`);
      }
      const log = join(dir, `${work_order_id}.log`);
      if (existsSync(log)) parts.push(`Last lines of the run log:\n${(await readFile(log, 'utf8')).trimEnd().split('\n').slice(-15).join('\n')}`);
      return text(parts.join('\n\n'));
    } catch (e) { return failure(e); }
  });

  server.registerTool('explain_receipt', {
    title: 'Explain a receipt',
    description: 'Explain one receipt in plain words. A receipt id is the work order id, a hyphen, and the attempt number, such as 0042-1.',
    inputSchema: z.object({ receipt_id: z.string().min(1).describe('The receipt id, such as 0042-1.') }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ receipt_id }) => {
    try {
      const { ledger } = stores();
      const rec = ledger.receipt(receipt_id);
      if (!rec) throw new Error(`there is no receipt ${receipt_id} in the Ledger. Use list_work_orders to see what has run.`);
      return text(explainReceipt(rec.record.statement, ledger.outcome(receipt_id)?.record));
    } catch (e) { return failure(e); }
  });

  if (opts.allowRun) {
    server.registerTool('run_work_order', {
      title: 'Run a work order',
      description: 'Start a saved work order. An AI coding agent will work in a sandbox, spend money up to the budget, and publish a proposed change to the project. This returns immediately; use get_run to follow it. Only call this when the person has explicitly asked for the work to start.',
      inputSchema: z.object({ work_order_id: z.string().min(1).describe('The id of a work order saved with save_work_order.') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ work_order_id }) => {
      try {
        const saved = (await listWorkOrders(dir)).find((s) => s.workOrder.id === work_order_id);
        if (!saved) throw new Error(`no saved work order has id ${work_order_id}. Save it first with save_work_order.`);
        const { store } = stores();
        if (store.runs(opts.repo).some((r) => r.work_order.id === work_order_id)) throw new Error(`work order ${work_order_id} has already been run. A work order id can be used once; save a new one.`);
        await mkdir(dir, { recursive: true });
        const logPath = join(dir, `${work_order_id}.log`);
        const fd = openSync(logPath, 'a');
        const [program, ...lead] = opts.runCommand ?? ['oafactory'];
        const child = spawn(program!, [...lead, 'run', saved.path, '--json'], { cwd: opts.cwd, detached: true, stdio: ['ignore', fd, fd], shell: false });
        closeSync(fd);
        await new Promise<void>((resolve, reject) => { child.once('spawn', () => resolve()); child.once('error', reject); });
        child.unref();
        return text(`Started work order ${work_order_id}. It runs in the background and can take several minutes.\nFollow it with get_run. The log is at ${logPath}`);
      } catch (e) { return failure(e); }
    });
  }

  return server;
}
