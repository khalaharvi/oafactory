/**
 * Drives the built server over stdio with the MCP client, the way Claude or any
 * other MCP client would.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Ledger, Store, openDb } from 'oafactory';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(pkg, '..', '..');
const tsc = join(root, 'node_modules', '.bin', 'tsc');

const CONFIG = `apiVersion: oafactory/v1alpha1
kind: Factory
protected: [.oafactory/, .github/, "*AGENTS.md"]
append_only: [tests/]
checks: { required: [lint, test], holdout: [] }
budget: { usd_per_run: 2.50, minutes_per_run: 30, max_attempts: 2 }
roles:
  runner:   { use: builtin, model: oafactory/coder }
  reviewer: { use: builtin, model: oafactory/reviewer }
tiers:
  default: 2
  rules:
    - { paths: ["docs/**", "*.md"], tier: 0 }
    - { paths: ["src/**", "tests/**"], tier: 1 }
autonomy: { mode: shadow }
`;

// The server is exercised as a separate process, so both packages must be compiled.
beforeAll(() => {
  execFileSync(tsc, ['-p', 'tsconfig.build.json'], { cwd: join(root, 'packages', 'oafactory'), stdio: 'pipe' });
  execFileSync(tsc, ['-p', 'tsconfig.build.json'], { cwd: pkg, stdio: 'pipe' });
}, 180_000);

const clients: Client[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.close(); });

function project() {
  // macOS's temp directory is under /var, a symlink to /private/var; a child process reports the resolved path.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'oaf-mcp-')));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.oafactory'), { recursive: true });
  mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, '.oafactory/factory.yaml'), CONFIG);
  writeFileSync(join(repo, 'src/a.py'), 'a = 1\n');
  writeFileSync(join(repo, 'tests/test_a.py'), 'def test_a(): pass\n');
  return { dir, repo, ledger: join(dir, 'ledger.db'), orders: join(dir, 'orders') };
}

async function connect(p: ReturnType<typeof project>, extra: string[] = []) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(pkg, 'dist', 'bin.js'), '--cwd', p.repo, '--repo', 'acme/widgets', '--ledger', p.ledger, ...extra],
    env: { PATH: process.env.PATH ?? '', HOME: p.dir, USER: 'tester', OAFACTORY_WORK_ORDERS: p.orders },
  }));
  clients.push(client);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const body = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('\n');
  return { body, isError: res.isError === true };
};

describe('oafactory-mcp', () => {
  it('offers the drafting tools, and the run tool only when allowed', async () => {
    const p = project();
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).sort();
    expect(await names(await connect(p))).toEqual(['draft_work_order', 'explain_receipt', 'factory_overview', 'get_run', 'list_work_orders', 'save_work_order']);
    expect(await names(await connect(p, ['--allow-run']))).toContain('run_work_order');

    const tools = (await (await connect(p, ['--allow-run'])).listTools()).tools;
    const hint = (n: string) => tools.find((t) => t.name === n)!.annotations?.readOnlyHint;
    expect([hint('factory_overview'), hint('draft_work_order'), hint('get_run'), hint('explain_receipt'), hint('list_work_orders')]).toEqual([true, true, true, true, true]);
    expect([hint('save_work_order'), hint('run_work_order')]).toEqual([false, false]);
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(60);
  });

  it('describes the project', async () => {
    const p = project();
    const { body, isError } = await call(await connect(p), 'factory_overview');
    expect(isError).toBe(false);
    expect(body).toContain('Project: acme/widgets');
    expect(body).toContain('Mode: shadow.');
    expect(body).toContain('$2.5 and 30 minutes per attempt, at most 2 attempts.');
    expect(body).toContain('Low risk (tier 0): docs/**, *.md');
    expect(body).toContain('This server may draft and save work orders. Starting a run is left to a person');
  });

  it('drafts without saving, in plain words, with notes about the request', async () => {
    const p = project();
    const client = await connect(p);
    const { body } = await call(client, 'draft_work_order', { intent: 'Fix the crash when the config file is empty.', scope: ['src/'], budget_usd: 9 });
    expect(body).toContain('Only in: src/');
    expect(body).toContain('Up to $2.50 and 30 minutes per attempt');
    expect(body).toContain('shadow mode: the factory never accepts a change on its own');
    expect(body).toContain('asks for $9 per attempt; the project allows at most $2.5');
    expect(body).toContain('allows code changes but not new tests (tests/)');
    expect(body).toContain('requested_by: tester (via MCP)');
    expect(existsSync(p.orders)).toBe(false);
    expect((await call(client, 'list_work_orders')).body).toMatch(/No work orders/);
  });

  it('saves a work order outside the repository and refuses to reuse an id', async () => {
    const p = project();
    const client = await connect(p);
    const saved = await call(client, 'save_work_order', { id: '0042', intent: 'Fix the crash when the config file is empty.', scope: ['src/', 'tests/'], budget_usd: 1 });
    expect(saved.isError).toBe(false);
    const file = join(p.orders, 'acme_widgets', '0042.yaml');
    expect(saved.body).toContain(`Saved work order 0042 at ${file}`);
    expect(saved.body).toContain(`oafactory run ${file}`);
    const yaml = readFileSync(file, 'utf8');
    expect(yaml).toContain('id: "0042"');
    expect(yaml).toContain('usd_per_run: 1');
    expect(file.startsWith(p.repo)).toBe(false);

    const again = await call(client, 'save_work_order', { id: '0042', intent: 'Something else.' });
    expect(again.isError).toBe(true);
    expect(again.body).toMatch(/already saved/);
    const listed = await call(client, 'list_work_orders');
    expect(listed.body).toContain('0042: Fix the crash when the config file is empty.');
    expect(listed.body).toContain('not started');
    expect((await call(client, 'get_run', { work_order_id: '0042' })).body).toContain('saved but has not started');
  });

  it('rejects malformed requests and unknown receipts with a usable message', async () => {
    const p = project();
    const client = await connect(p);
    const bad = await client.callTool({ name: 'save_work_order', arguments: { id: 'no spaces allowed', intent: 'x' } }).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
    expect(bad.isError).toBe(true);
    const missing = await call(client, 'explain_receipt', { receipt_id: 'nope-1' });
    expect(missing.isError).toBe(true);
    expect(missing.body).toContain('there is no receipt nope-1');
    expect((await call(client, 'get_run', { work_order_id: 'nope' })).body).toContain('No work order with id nope');
  });

  it('reports a clear error when the project has no factory config', async () => {
    const p = project();
    writeFileSync(join(p.repo, '.oafactory/factory.yaml'), 'kind: nonsense');
    const res = await call(await connect(p), 'draft_work_order', { intent: 'x y' });
    expect(res.isError).toBe(true);
    expect(res.body).toMatch(/factory config is invalid/);
  });

  it('explains a finished run from the Ledger', async () => {
    const p = project();
    const db = openDb(p.ledger);
    const ledger = new Ledger(db); const store = new Store(db);
    const wo = { apiVersion: 'oafactory/v1alpha1', kind: 'WorkOrder' as const, id: '0007', requested_by: 'tester', intent: 'Tidy the docs.', scope: { paths: ['docs/'] } };
    store.putRun({ id: '0007-1', repo: 'acme/widgets', work_order: wo, attempt: 1, state: 'escalated', change: 12, base_sha: 'b', head_sha: 'h', runner: 'builtin', runner_model: 'anthropic/x', runner_family: 'anthropic',
      reviewer: 'builtin', reviewer_model: 'openai/y', reviewer_family: 'openai', budget_usd: 1, budget_minutes: 10, started_at: null, ended_at: null });
    ledger.writeReceipt({ _type: 'https://in-toto.io/Statement/v1', subject: [{ name: 'git+x', digest: { gitCommit: 'h' } }], predicateType: 'https://oafactory.org/receipt/v1alpha1',
      predicate: { id: '0007-1', work_order: '0007', issued_at: '2026-01-01T00:00:00Z', change: { host: 'github', repo: 'acme/widgets', number: 12, base: 'b' },
        run: { attempt: 1, runner: 'builtin', runner_model: 'anthropic/x', reviewer: 'builtin', reviewer_model: 'openai/y', cost_usd: 0.2, minutes: 3, state: 'escalated', audit: false },
        tier: { value: 0, because: ['docs/a.md matched docs/**'] }, evidence: [{ kind: 'checks', met: true, source: 'github:check-runs' }, { kind: 'budget', met: true, source: 'gateway' }],
        unverified: [], decision: { value: 'would_merge', mode: 'shadow', reason: 'Tier 0 bar met; shadow mode, so a person decides.' } } });
    db.close();

    const client = await connect(p);
    const run = await call(client, 'get_run', { work_order_id: '0007' });
    expect(run.body).toContain('Receipt 0007-1: proposed change #12 in acme/widgets');
    expect(run.body).toContain('The factory would have accepted this change. The project is in shadow mode, so a person decides.');
    expect((await call(client, 'explain_receipt', { receipt_id: '0007-1' })).body).toContain('Low risk (tier 0)');
    expect((await call(client, 'list_work_orders')).body).toContain('attempt 1: escalated (proposed change #12)');
  });
});

describe('run_work_order', () => {
  it('starts a saved work order in the background and will not start one twice', async () => {
    const { createServer } = await import('../src/server.js');
    const p = project();
    // Stand in for the CLI: record how it was invoked, then exit.
    const fake = join(p.dir, 'fake-cli.mjs');
    writeFileSync(fake, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(p.dir, 'invoked.json'))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\nconsole.log('run started');\n`);
    const server = createServer({ cwd: p.repo, repo: 'acme/widgets', requestedBy: 'tester', ledgerPath: p.ledger, workOrders: p.orders, allowRun: true, runCommand: [process.execPath, fake] });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> })._registeredTools;
    const invoke = async (name: string, args: unknown) => { const r = await tools[name]!.handler(args, {}); return { body: r.content.map((c) => c.text).join('\n'), isError: r.isError === true }; };

    expect((await invoke('run_work_order', { work_order_id: '0001' })).body).toMatch(/no saved work order has id 0001/);
    await invoke('save_work_order', { id: '0001', intent: 'Tidy the docs.', scope: ['docs/'] });
    const started = await invoke('run_work_order', { work_order_id: '0001' });
    expect(started.isError).toBe(false);
    expect(started.body).toContain('Started work order 0001');

    const marker = join(p.dir, 'invoked.json');
    for (let i = 0; i < 50 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
    const seen = JSON.parse(readFileSync(marker, 'utf8')) as { args: string[]; cwd: string };
    expect(seen.args).toEqual(['run', join(p.orders, '0001.yaml'), '--json']);
    expect(seen.cwd).toBe(p.repo);
    expect(readFileSync(join(p.orders, '0001.log'), 'utf8')).toContain('run started');

    // Once a run is recorded for the id, it cannot be started again.
    const db = openDb(p.ledger);
    new Store(db).putRun({ id: '0001-1', repo: 'acme/widgets', work_order: { apiVersion: 'oafactory/v1alpha1', kind: 'WorkOrder', id: '0001', requested_by: 't', intent: 'x', scope: { paths: ['docs/'] } }, attempt: 1, state: 'running', change: null,
      base_sha: null, head_sha: null, runner: 'builtin', runner_model: 'a/x', runner_family: 'a', reviewer: 'builtin', reviewer_model: 'b/y', reviewer_family: 'b', budget_usd: 1, budget_minutes: 1, started_at: null, ended_at: null });
    db.close();
    const twice = await invoke('run_work_order', { work_order_id: '0001' });
    expect(twice.isError).toBe(true);
    expect(twice.body).toMatch(/has already been run/);
  });
});
