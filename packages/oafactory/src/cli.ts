import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { classify } from './classify.js';
import { CONFIG_PATH, parseFactoryConfig, parseGatewayConfig, parseWorkOrder } from './config.js';
import { demo } from './demo.js';
import { run as sh } from './exec.js';
import { explainReceipt, explainWorkOrder } from './explain.js';
import { Gateway } from './gateway.js';
import { gate, type GateDeps } from './gate.js';
import { runWorkOrder, workOrderFromIssue } from './harness.js';
import { detectHost, type Host } from './host/index.js';
import { GATEWAY_EXAMPLE, init } from './init.js';
import { Ledger, Store, defaultLedgerPath, openDb } from './ledger.js';
import { liveProbes } from './probes.js';
import { ready } from './ready.js';
import { LocalKeySigner, SigstoreSigner, verifyEnvelope, type Signer } from './receipt.js';
import { DockerSandbox, LOOPBACK_ROUTE, LocalSandbox, SANDBOX_NETWORK, dockerGatewayRoute, type GatewayRoute, type Sandbox } from './sandbox.js';
import { scoreboard } from './scoreboard.js';
import { hasStanding, promote, promotionStatus } from './standing.js';
import type { ChangedFile, Tier, WorkOrder } from './types.js';
import { watch } from './watcher.js';
import { newWorkOrder, workOrderNotes } from './workorders.js';
import { GitTransport } from './workspace.js';

export const VERSION = '0.3.0';
export const DEFAULT_SANDBOX_IMAGE = 'node:26-slim';

const HELP = `oafactory ${VERSION}: an open software factory

Usage: oafactory <command> [options]

Try it
  demo                         Walk through the whole lifecycle on an in-memory Git host

Set up a repository
  init [--force]               Write .oafactory/factory.yaml from what is in this repository
  ready [--json]               Check that the factory config protects what it must
  classify [--base <ref>]      Show the tier of your local changes against a base ref

Understand it
  explain <work-order.yaml>    What will happen if this work order runs, in plain words
  explain <receipt-id>         What happened in a run, in plain words

Operate the factory
  run "<what you want done>"   Run a request: sandboxed agent, change, review, Gate
  run <work-order.yaml>        Same, from a work order file
  run --issue <n>              Same, from an issue a maintainer labelled "oafactory"
  gate <change>                Evaluate one change and write its receipt
  watch [--every <minutes>]    Watch merged changes; rerun, revert and record outcomes
  standing                     Show standing and promotion progress per tier
  standing --promote <tier> --confirm <name>
  gateway init | serve         Create the Gateway config, or run the Gateway on its own

Inspect
  scoreboard [--json]          Accept rate, cost, escalations, agreement and reverts
  ledger export                Every record as JSON Lines
  ledger show <receipt-id>     One receipt
  ledger verify <receipt-id> --key <public.pem>
  keys generate [--out <dir>]  Create a local signing key (evaluation only; use Sigstore to merge)
  conformance [--live]         List the conformance tests; --live probes your Sandbox

Common options
  --repo <owner/name>          Default: read from the origin remote
  --host <github|gitlab>       Default: inferred from the remote
  --ledger <path>              Default: $OAFACTORY_LEDGER or ~/.oafactory/ledger.db
  --json                       Machine-readable output

Credentials (each role has its own; none of them ever enters the Sandbox)
  OAFACTORY_HARNESS_TOKEN      push the run's branch, open the change
  OAFACTORY_GATE_TOKEN         merge
  OAFACTORY_WATCHER_TOKEN      open a revert, rerun checks

Docs: https://oafactory.org/docs
`;

type Flags = Record<string, string | boolean | undefined>;
const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const col = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

function roleEnv(role: 'HARNESS' | 'GATE' | 'WATCHER'): NodeJS.ProcessEnv | undefined {
  const token = process.env[`OAFACTORY_${role}_TOKEN`];
  if (!token) return undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token, GITLAB_TOKEN: token };
  for (const r of ['HARNESS', 'GATE', 'WATCHER']) delete env[`OAFACTORY_${r}_TOKEN`];
  return env;
}

/** Three credentials MUST exist and MUST be distinct. Enforced whenever the Gate is able to merge. */
export function checkCredentials(env: NodeJS.ProcessEnv, mode: 'shadow' | 'earned'): string[] {
  const names = ['OAFACTORY_HARNESS_TOKEN', 'OAFACTORY_GATE_TOKEN', 'OAFACTORY_WATCHER_TOKEN'];
  const problems: string[] = [];
  const missing = names.filter((n) => !env[n]);
  if (missing.length) problems.push(`not set: ${missing.join(', ')}`);
  const set = names.map((n) => env[n]).filter(Boolean);
  if (new Set(set).size !== set.length) problems.push('the Harness, Gate and Watcher tokens must be three distinct credentials');
  if (problems.length && mode === 'earned') throw new Error(`earned mode needs three distinct role credentials (${problems.join('; ')})`);
  return problems;
}

async function hostFor(flags: Flags, role: 'HARNESS' | 'GATE' | 'WATCHER'): Promise<Host> {
  return detectHost(process.cwd(), { repo: flags.repo as string | undefined, kind: flags.host as string | undefined, env: roleEnv(role) });
}

function stores(flags: Flags) {
  const db = openDb((flags.ledger as string | undefined) ?? defaultLedgerPath());
  return { ledger: new Ledger(db), store: new Store(db) };
}

async function signerFrom(flags: Flags): Promise<Signer | undefined> {
  const kind = (flags.signer as string | undefined) ?? process.env.OAFACTORY_SIGNER;
  if (kind === 'sigstore') return new SigstoreSigner();
  if (kind === 'local-key') {
    const path = (flags['signing-key'] as string | undefined) ?? process.env.OAFACTORY_SIGNING_KEY ?? join(homedir(), '.oafactory', 'signing-key.pem');
    err('warning: local-key signing is for evaluation. The spec requires Sigstore before any automatic merge.');
    return new LocalKeySigner(await readFile(path, 'utf8'));
  }
  if (kind) throw new Error(`unknown signer "${kind}"; use sigstore or local-key`);
  return undefined;
}

async function loadGateway(flags: Flags, store: Store): Promise<Gateway> {
  const path = (flags['gateway-config'] as string | undefined) ?? process.env.OAFACTORY_GATEWAY_CONFIG ?? join(homedir(), '.oafactory', 'gateway.yaml');
  if (!existsSync(path)) throw new Error(`no Gateway config at ${path}; run \`oafactory gateway init\``);
  return new Gateway(parseGatewayConfig(await readFile(path, 'utf8')), store, { log: flags.verbose ? err : undefined });
}

async function localChanges(base: string): Promise<ChangedFile[]> {
  const cwd = process.cwd();
  const status = await sh('git', ['diff', '--name-status', '-M', '-z', base], { cwd });
  const num = await sh('git', ['diff', '--numstat', '-M', '-z', base], { cwd });
  const untracked = (await sh('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd })).split('\0').filter(Boolean);
  const counts = new Map<string, [number, number]>();
  const nt = num.split('\0');
  for (let i = 0; i < nt.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(nt[i]!);
    if (!m) continue;
    let path = m[3]!;
    if (path === '') { path = nt[i + 2] ?? ''; i += 2; }
    counts.set(path, [Number(m[1]) || 0, Number(m[2]) || 0]);
  }
  const files: ChangedFile[] = [];
  const st = status.split('\0');
  for (let i = 0; i < st.length; i++) {
    const code = st[i]!;
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = st[++i]!, to = st[++i]!;
      const [a, d] = counts.get(to) ?? [0, 0];
      files.push(code.startsWith('R') ? { path: to, status: 'renamed', previousPath: from, additions: a, deletions: d } : { path: to, status: 'added', additions: a, deletions: d });
    } else {
      const path = st[++i]!;
      const [a, d] = counts.get(path) ?? [0, 0];
      files.push({ path, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', additions: a, deletions: d });
    }
  }
  for (const path of untracked) files.push({ path, status: 'added', additions: (await readFile(join(cwd, path), 'utf8').catch(() => '')).split('\n').length, deletions: 0 });
  return files;
}

async function makeSandbox(flags: Flags): Promise<{ sandbox: Sandbox; route: GatewayRoute }> {
  const kind = (flags.sandbox as string | undefined) ?? 'docker';
  if (kind === 'local') return { sandbox: new LocalSandbox(), route: LOOPBACK_ROUTE };
  if (kind !== 'docker') throw new Error(`unknown sandbox "${kind}"; use docker or local`);
  // The built-in Runner needs only Node. Use your own image when the work needs your project's toolchain.
  const image = (flags.image as string | undefined) ?? process.env.OAFACTORY_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
  const network = (flags.network as string | undefined) ?? SANDBOX_NETWORK;
  // The relay, when one is needed, runs its own Node image, not the Worker's.
  return { sandbox: new DockerSandbox({ image, network }), route: await dockerGatewayRoute({ network }) };
}

/** Turn a plain sentence into a work order. Scope comes from --scope, never from the sentence. */
export async function workOrderFromIntent(intent: string, scope: string[] | undefined, now = new Date()): Promise<WorkOrder> {
  const who = (await sh('git', ['config', 'user.name'], { cwd: process.cwd() }).catch(() => '')).trim() || process.env.USER || 'unknown';
  return newWorkOrder({ intent, requestedBy: who, scope, now });
}

const commands: Record<string, (args: string[], flags: Flags) => Promise<number>> = {
  async demo() { await demo(out, !!tty); return 0; },

  async init(_a, flags) {
    const r = await init(process.cwd(), !!flags.force);
    out(`Wrote ${CONFIG_PATH} (shadow mode).`);
    for (const n of r.notes) out(col(33, `note: ${n}`));
    out('\nNext:\n  oafactory ready          check that it protects what it must\n  oafactory gateway init   set up model access\n  git add .oafactory && git commit   the Gate reads the config from the base branch');
    return 0;
  },

  async ready(_a, flags) {
    const findings = await ready(process.cwd());
    if (flags.json) out(JSON.stringify(findings, null, 2));
    else for (const f of findings) out(`${f.level === 'pass' ? col(32, 'pass') : f.level === 'warn' ? col(33, 'warn') : col(31, 'FAIL')}  ${f.check.padEnd(24)} ${f.message}`);
    const fails = findings.filter((f) => f.level === 'fail').length;
    if (!flags.json) out(fails ? `\n${fails} problem(s) must be fixed before this repository is ready.` : '\nReady.');
    return fails ? 1 : 0;
  },

  async classify(_a, flags) {
    const base = (flags.base as string | undefined) ?? 'origin/HEAD';
    const text = await sh('git', ['show', `${base}:${CONFIG_PATH}`], { cwd: process.cwd() }).catch(() => { throw new Error(`${CONFIG_PATH} does not exist on ${base}; the Gate reads config from the base branch, so commit it there first (or pass --base)`); });
    const scope = typeof flags.scope === 'string' ? flags.scope.split(',') : undefined;
    const c = classify(parseFactoryConfig(text), await localChanges(base), scope);
    if (flags.json) out(JSON.stringify(c, null, 2));
    else {
      out(`Tier ${c.tier}  (${c.files} files, ${c.lines} lines, against ${base})`);
      for (const b of c.because) out(`  ${b}`);
      if (c.outOfScope.length) out(`Outside scope: ${c.outOfScope.join(', ')}`);
    }
    return 0;
  },

  async explain(args, flags) {
    const target = args[0];
    if (!target) throw new Error('usage: oafactory explain <work-order.yaml> | <receipt-id>');
    if (existsSync(resolve(target))) {
      const wo = parseWorkOrder(await readFile(resolve(target), 'utf8'));
      const cfgPath = join(process.cwd(), CONFIG_PATH);
      if (!existsSync(cfgPath)) throw new Error(`${CONFIG_PATH} not found here; run this from the repository root, after \`oafactory init\``);
      const config = parseFactoryConfig(await readFile(cfgPath, 'utf8'));
      // Standing is looked up when the repository can be identified; otherwise the explanation assumes none.
      let standing: Tier[] = [];
      try {
        const host = await hostFor(flags, 'GATE');
        const { ledger } = stores(flags);
        standing = ([0, 1] as Tier[]).filter((t) => hasStanding(ledger, host.repo, t));
      } catch { /* no remote or no ledger yet */ }
      out(explainWorkOrder(config, wo, { standing }));
      const notes = workOrderNotes(config, wo);
      if (notes.length) out(`\nWorth knowing before it runs\n${notes.map((n) => `  - ${n}`).join('\n')}`);
      return 0;
    }
    const { ledger } = stores(flags);
    const rec = ledger.receipt(target);
    if (!rec) throw new Error(`"${target}" is neither a work order file nor a receipt in the Ledger`);
    out(explainReceipt(rec.record.statement, ledger.outcome(target)?.record));
    return 0;
  },

  async gate(args, flags) {
    const number = Number(args[0]);
    if (!Number.isInteger(number)) throw new Error('usage: oafactory gate <change number>');
    const host = await hostFor(flags, 'GATE');
    const { ledger, store } = stores(flags);
    const deps: GateDeps = { host, ledger, store, signer: await signerFrom(flags) };
    const res = await gate(deps, number, { waitMs: Number(flags.wait ?? 0) * 60_000, comment: !flags['no-comment'] });
    const p = res.statement.predicate;
    if (flags.json) out(JSON.stringify(res.statement, null, 2));
    else {
      out(`${p.decision.value.toUpperCase()}  tier ${p.tier.value}  receipt ${p.id}`);
      out(p.decision.reason);
      for (const e of p.evidence) out(`  ${e.met ? col(32, 'met    ') : col(31, 'not met')}  ${e.kind}`);
      if (res.merged) out(`Merged at ${res.mergeSha}.`);
    }
    return 0;
  },

  async run(args, flags) {
    const { ledger, store } = stores(flags);
    const harnessHost = await hostFor(flags, 'HARNESS');
    const gateHost = await hostFor(flags, 'GATE');
    const base = await harnessHost.defaultBranch();
    const cfgText = await harnessHost.readFile(CONFIG_PATH, base);
    if (cfgText === null) throw new Error(`${CONFIG_PATH} does not exist on ${base}`);
    const config = parseFactoryConfig(cfgText);
    for (const p of checkCredentials(process.env, config.autonomy.mode)) err(`warning: ${p}. Fine for shadow mode on your own machine; required before earned mode.`);

    const scope = typeof flags.scope === 'string' ? flags.scope.split(',') : undefined;
    let wo: WorkOrder;
    if (flags.issue) wo = workOrderFromIssue(await harnessHost.getIssue(Number(flags.issue)), harnessHost.kind, scope);
    else if (args[0] && existsSync(resolve(args[0]))) wo = parseWorkOrder(await readFile(resolve(args[0]), 'utf8'));
    else if (args.length && /\s/.test(args.join(' ').trim())) wo = await workOrderFromIntent(args.join(' '), scope);
    else throw new Error('usage: oafactory run "<what you want done>" | <work-order.yaml> | --issue <n>');
    const standing = ([0, 1] as Tier[]).filter((t) => hasStanding(ledger, harnessHost.repo, t));
    err(explainWorkOrder(config, wo, { standing }));
    err('');

    const gateway = await loadGateway(flags, store);
    const { sandbox, route } = await makeSandbox(flags);
    const server = await gateway.listen(`${route.listenHost}:0`);
    let link: { url: string; close(): Promise<void> } | undefined;
    try {
      link = await route.connect(server.port);
      const token = process.env.OAFACTORY_HARNESS_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITLAB_TOKEN;
      const results = await runWorkOrder({
        host: harnessHost, gate: { host: gateHost, ledger, store, signer: await signerFrom(flags) }, gateway,
        gatewayUrl: link.url, sandbox, transport: new GitTransport(harnessHost.cloneUrl(), token),
        gateOptions: { waitMs: Number(flags.wait ?? 30) * 60_000 }, log: err,
      }, wo);
      if (flags.json) out(JSON.stringify(results.map((r) => ({ run: r.run.id, change: r.change, decision: r.gate?.decision ?? 'abandon', reason: r.gate?.statement.predicate.decision.reason ?? r.abandoned })), null, 2));
      else for (const r of results) out(`${r.run.id}  ${(r.gate?.decision ?? 'abandon').toUpperCase()}  ${r.change ? `change #${r.change}` : 'no change'}  ${r.gate?.statement.predicate.decision.reason ?? r.abandoned}`);
      return 0;
    } finally {
      await link?.close();
      await server.close();
    }
  },

  async watch(_a, flags) {
    const host = await hostFor(flags, 'WATCHER');
    const { ledger, store } = stores(flags);
    const gateDeps = flags['merge-reverts'] ? { host: await hostFor(flags, 'GATE'), ledger, store, signer: await signerFrom(flags) } : undefined;
    const every = Number(flags.every ?? 0);
    for (;;) {
      const events = await watch({ host, ledger, store, gate: gateDeps });
      if (flags.json) out(JSON.stringify(events));
      else if (events.length === 0) out('Nothing to watch.');
      else for (const e of events) out(`#${String(e.change).padEnd(6)} ${e.action.padEnd(9)} ${e.receipt_id}  ${e.detail ?? ''}${e.demoted ? `  standing removed at tier ${e.demoted.join(', ')}` : ''}`);
      if (!every) return 0;
      await new Promise((r) => setTimeout(r, every * 60_000));
    }
  },

  async standing(_a, flags) {
    const host = await hostFor(flags, 'GATE');
    const { ledger } = stores(flags);
    const text = await host.readFile(CONFIG_PATH, await host.defaultBranch());
    if (text === null) throw new Error(`${CONFIG_PATH} does not exist on the default branch`);
    const config = parseFactoryConfig(text);
    if (flags.promote !== undefined) {
      const tier = Number(flags.promote);
      if (tier !== 0 && tier !== 1) throw new Error('only tiers 0 and 1 can hold standing');
      if (typeof flags.confirm !== 'string') throw new Error('a person must confirm each promotion: pass --confirm <your name>');
      promote(ledger, config, host.repo, tier, flags.confirm, new Date());
      out(`Tier ${tier} promoted, confirmed by ${flags.confirm}.`);
      return 0;
    }
    const status = ([0, 1] as const).map((t) => promotionStatus(ledger, config, host.repo, t));
    if (flags.json) { out(JSON.stringify({ mode: config.autonomy.mode, tiers: status }, null, 2)); return 0; }
    out(`${host.repo}  mode: ${config.autonomy.mode}`);
    for (const s of status) {
      out(`Tier ${s.tier}: ${s.standing ? col(32, 'has standing') : 'no standing'}   ${s.held}/${s.needed} held, ${s.reverts} reverts, agreement ${s.agreement === null ? 'n/a' : s.agreement.toFixed(2)}`);
      if (!s.standing) for (const b of s.blockers) out(`    ${b}`);
      if (s.eligible) out(`    eligible: oafactory standing --promote ${s.tier} --confirm <your name>`);
    }
    for (const t of [2, 3] as Tier[]) out(`Tier ${t}: always goes to a person${hasStanding(ledger, host.repo, t) ? ' (unexpected standing record)' : ''}`);
    return 0;
  },

  async scoreboard(_a, flags) {
    const { ledger } = stores(flags);
    const sb = scoreboard(ledger, flags.repo as string | undefined);
    if (flags.json) { out(JSON.stringify(sb, null, 2)); return 0; }
    const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(0)}%`);
    const usd = (n: number | null) => (n === null ? 'n/a' : `$${n.toFixed(2)}`);
    out(`Work orders ${sb.work_orders}   runs ${sb.runs}   accepted ${sb.accepted}`);
    out(`First-attempt accept rate        ${pct(sb.first_attempt_accept_rate)}`);
    out(`Cost per accepted change         ${usd(sb.cost_per_accepted_change)}`);
    out(`Escalations per accepted change  ${sb.escalations_per_accepted_change === null ? 'n/a' : sb.escalations_per_accepted_change.toFixed(2)}`);
    for (const t of sb.by_tier) out(`Tier ${t.tier}: would-merge ${t.would_merge}, merged ${t.merged}, held ${t.held}, reverted ${t.reverted}, agreement ${pct(t.agreement)}, revert rate ${pct(t.revert_rate)}`);
    return 0;
  },

  async ledger(args, flags) {
    const { ledger } = stores(flags);
    if (args[0] === 'export') { process.stdout.write(ledger.exportJsonl()); return 0; }
    const rec = args[1] ? ledger.receipt(args[1]) : undefined;
    if ((args[0] === 'show' || args[0] === 'verify') && !rec) throw new Error(`no receipt ${args[1] ?? ''}`.trim());
    if (args[0] === 'show') { out(JSON.stringify(rec!.record, null, 2)); return 0; }
    if (args[0] === 'verify') {
      const signed = rec!.record.signed;
      if (!signed) { out('This receipt is unsigned (shadow-mode receipts may be).'); return 1; }
      if (signed.method !== 'local-key') { out(`Signed with ${signed.method}. Verify the stored bundle with \`cosign verify-blob-attestation\` or the sigstore library.`); return 0; }
      if (typeof flags.key !== 'string') throw new Error('pass --key <public.pem>');
      const st = verifyEnvelope(signed.envelope!, await readFile(flags.key, 'utf8'));
      const same = JSON.stringify(st) === JSON.stringify(rec!.record.statement);
      out(same ? 'Signature verifies and matches the stored receipt.' : 'Signature verifies but the stored receipt differs from the signed payload.');
      return same ? 0 : 1;
    }
    throw new Error('usage: oafactory ledger export | show <id> | verify <id> --key <public.pem>');
  },

  async keys(args, flags) {
    if (args[0] !== 'generate') throw new Error('usage: oafactory keys generate [--out <dir>]');
    const dir = (flags.out as string | undefined) ?? join(homedir(), '.oafactory');
    const priv = join(dir, 'signing-key.pem'), pub = join(dir, 'signing-key.pub.pem');
    if (existsSync(priv)) throw new Error(`${priv} already exists`);
    const k = LocalKeySigner.generate();
    await mkdir(dir, { recursive: true });
    await writeFile(priv, k.privateKeyPem, { mode: 0o600 });
    await writeFile(pub, k.publicKeyPem);
    out(`Wrote ${priv} and ${pub}.\nUse with: OAFACTORY_SIGNER=local-key (evaluation only).`);
    return 0;
  },

  async gateway(args, flags) {
    const path = (flags['gateway-config'] as string | undefined) ?? process.env.OAFACTORY_GATEWAY_CONFIG ?? join(homedir(), '.oafactory', 'gateway.yaml');
    if (args[0] === 'init') {
      if (existsSync(path) && !flags.force) throw new Error(`${path} already exists`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, GATEWAY_EXAMPLE, { mode: 0o600 });
      out(`Wrote ${path}. Edit the models and prices, and export the provider keys it names.`);
      return 0;
    }
    if (args[0] === 'serve') {
      const { store } = stores(flags);
      const gw = await loadGateway({ ...flags, verbose: true }, store);
      const s = await gw.listen(flags.listen as string | undefined);
      out(`Gateway listening on ${s.url}`);
      await new Promise(() => {});
    }
    throw new Error('usage: oafactory gateway init | serve');
  },

  async conformance(_a, flags) {
    if (!flags.live) {
      out('The conformance suite is the test suite: run `npm test` in packages/oafactory.\nEach test is named after its ID in spec section 12 (C1.1 to C3.8).\n\n`oafactory conformance --live --sandbox docker --image <image>` probes C1.1 to C1.3 in your real Sandbox.');
      return 0;
    }
    const { store } = stores({ ...flags, ledger: ':memory:' });
    const { sandbox, route } = await makeSandbox(flags);
    const gwPath = (flags['gateway-config'] as string | undefined) ?? join(homedir(), '.oafactory', 'gateway.yaml');
    const gwConfig = parseGatewayConfig(existsSync(gwPath) ? await readFile(gwPath, 'utf8') : 'models: {}');
    const gw = new Gateway(gwConfig, store);
    const server = await gw.listen(`${route.listenHost}:0`);
    const dir = await mkdtemp(join(tmpdir(), 'oafactory-probe-'));
    let link: { url: string; close(): Promise<void> } | undefined;
    try {
      link = await route.connect(server.port);
      const url = link.url;
      const secrets = [process.env.OAFACTORY_HARNESS_TOKEN, process.env.OAFACTORY_GATE_TOKEN, process.env.OAFACTORY_WATCHER_TOKEN, process.env.GH_TOKEN, process.env.GITLAB_TOKEN,
        ...Object.values(gwConfig.models).map((m) => process.env[m.key_env])].filter((s): s is string => !!s);
      const probes = await liveProbes(sandbox, dir, url, secrets);
      for (const p of probes) out(`${p.pass ? col(32, 'pass') : col(31, 'FAIL')}  ${p.id}  ${p.detail}`);
      if (!sandbox.contained) out(col(33, 'The local sandbox is not contained; these results say little. Use --sandbox docker.'));
      return probes.every((p) => p.pass) ? 0 : 1;
    } finally {
      await link?.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
};

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: false,
    options: {
      json: { type: 'boolean' }, force: { type: 'boolean' }, live: { type: 'boolean' }, verbose: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      'no-comment': { type: 'boolean' }, 'merge-reverts': { type: 'boolean' },
      repo: { type: 'string' }, host: { type: 'string' }, ledger: { type: 'string' }, base: { type: 'string' }, scope: { type: 'string' }, wait: { type: 'string' },
      issue: { type: 'string' }, sandbox: { type: 'string' }, image: { type: 'string' }, network: { type: 'string' }, signer: { type: 'string' }, 'signing-key': { type: 'string' },
      'gateway-config': { type: 'string' }, listen: { type: 'string' }, every: { type: 'string' }, promote: { type: 'string' }, confirm: { type: 'string' }, key: { type: 'string' }, out: { type: 'string' },
    },
  });
  if (values.version) { out(VERSION); return 0; }
  const [name, ...rest] = positionals;
  if (!name || values.help || name === 'help') { out(HELP); return 0; }
  const cmd = commands[name];
  if (!cmd) { err(`Unknown command "${name}".\n`); err(HELP); return 2; }
  try {
    return await cmd(rest, values as Flags);
  } catch (e) {
    err(`${col(31, 'error:')} ${(e as Error).message}`);
    return 1;
  }
}
