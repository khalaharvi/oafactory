import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runAgent, runTool, safePath } from '../src/agent.js';
import { parseGatewayConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { runWorkOrder, runnerCommand } from '../src/harness.js';
import { parseFactoryConfig } from '../src/config.js';
import { LocalSandbox, DockerSandbox, TOOLS_DIR } from '../src/sandbox.js';
import { FakeTransport } from '../src/workspace.js';
import { CONFIG, rig, workOrder } from './helpers.js';

const dir = () => mkdtempSync(join(tmpdir(), 'oaf-agent-'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A scripted model: each call returns the next step. Records what it was sent. */
function scripted(style: 'anthropic' | 'openai', steps: Array<Array<{ name: string; input: Record<string, unknown> }> | string>) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let i = 0;
  const fetchStub = (async (url: any, init: any) => {
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const step = steps[i++] ?? 'done';
    const usage = style === 'anthropic' ? { input_tokens: 1000, output_tokens: 100 } : { prompt_tokens: 1000, completion_tokens: 100 };
    if (style === 'anthropic') {
      return json(typeof step === 'string' ? { content: [{ type: 'text', text: step }], stop_reason: 'end_turn', usage }
        : { content: step.map((c, n) => ({ type: 'tool_use', id: `tu_${i}_${n}`, name: c.name, input: c.input })), stop_reason: 'tool_use', usage });
    }
    return json({ choices: [{ message: typeof step === 'string' ? { role: 'assistant', content: step }
      : { role: 'assistant', content: null, tool_calls: step.map((c, n) => ({ id: `call_${i}_${n}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } }], usage });
  }) as typeof fetch;
  return { fetchStub, sent };
}

describe('built-in Runner: tools', () => {
  it('keeps every path inside the project and out of .git', () => {
    const cwd = dir();
    expect(safePath(cwd, 'src/a.py')).toBe(join(cwd, 'src/a.py'));
    for (const bad of ['../x', '/etc/passwd', 'a/../../x', '.git/config', '.git/hooks/pre-commit', '']) expect(() => safePath(cwd, bad)).toThrow();
  });

  it('reads, writes, replaces, lists and runs', async () => {
    const cwd = dir();
    expect(await runTool(cwd, 'write_file', { path: 'src/a.txt', content: 'one two one' })).toMatch(/wrote src\/a.txt/);
    expect(await runTool(cwd, 'read_file', { path: 'src/a.txt' })).toBe('one two one');
    expect(await runTool(cwd, 'replace_in_file', { path: 'src/a.txt', old: 'one', new: 'x' })).toMatch(/found 2/);
    expect(await runTool(cwd, 'replace_in_file', { path: 'src/a.txt', old: 'two', new: '$& 2' })).toMatch(/replaced/);
    expect(readFileSync(join(cwd, 'src/a.txt'), 'utf8')).toBe('one $& 2 one');
    mkdirSync(join(cwd, '.git')); writeFileSync(join(cwd, '.git/config'), 'x');
    expect(await runTool(cwd, 'list_files', {})).toBe('src/a.txt');
    expect(await runTool(cwd, 'run_command', { command: 'echo hi; exit 3' })).toBe('hi\n\n[exit status 3]');
    expect(await runTool(cwd, 'write_file', { path: '../escape.txt', content: 'x' })).toMatch(/^error: .*outside the project/);
    expect(await runTool(cwd, 'read_file', { path: 'missing.txt' })).toMatch(/^error:/);
    expect(await runTool(cwd, 'nope', {})).toBe('unknown tool nope');
  });
});

describe('built-in Runner: loop', () => {
  for (const style of ['anthropic', 'openai'] as const) {
    it(`edits files through ${style}-style tool calls and stops on finish`, async () => {
      const cwd = dir();
      writeFileSync(join(cwd, 'AGENTS.md'), 'House rule: be brief.\n');
      const { fetchStub, sent } = scripted(style, [
        [{ name: 'list_files', input: {} }],
        [{ name: 'write_file', input: { path: 'docs/note.md', content: 'hello\n' } }, { name: 'run_command', input: { command: 'cat docs/note.md' } }],
        [{ name: 'finish', input: { summary: 'Added docs/note.md.' } }],
      ]);
      const res = await runAgent({ task: 'Add a note.', model: 'oafactory/coder', gatewayUrl: 'http://gw.test/', key: 'oaf_key', style, cwd, fetch: fetchStub });
      expect(res).toEqual({ turns: 3, finished: true, summary: 'Added docs/note.md.' });
      expect(readFileSync(join(cwd, 'docs/note.md'), 'utf8')).toBe('hello\n');
      expect(sent[0]!.url).toBe(style === 'anthropic' ? 'http://gw.test/v1/messages' : 'http://gw.test/v1/chat/completions');
      expect(sent[0]!.headers[style === 'anthropic' ? 'x-api-key' : 'authorization']).toContain('oaf_key');
      expect(sent[0]!.body.model).toBe('oafactory/coder');
      // Base-branch instructions are part of the system prompt; tool results are fed back.
      expect(JSON.stringify(sent[0]!.body)).toContain('House rule: be brief.');
      expect(JSON.stringify(sent[1]!.body)).toContain('AGENTS.md');
      expect(JSON.stringify(sent[2]!.body)).toContain('hello');
    });
  }

  it('stops when the model stops, at the turn limit, and when the budget is spent', async () => {
    const cwd = dir();
    expect(await runAgent({ task: 't', model: 'm', gatewayUrl: 'http://gw', key: 'k', style: 'anthropic', cwd, fetch: scripted('anthropic', ['All done.']).fetchStub }))
      .toEqual({ turns: 1, finished: true, summary: 'All done.' });
    const forever = scripted('openai', Array.from({ length: 10 }, () => [{ name: 'list_files', input: {} }]));
    expect(await runAgent({ task: 't', model: 'm', gatewayUrl: 'http://gw', key: 'k', style: 'openai', cwd, maxTurns: 3, fetch: forever.fetchStub })).toMatchObject({ turns: 3, finished: false, stopped: 'turn limit' });
    const broke = (async () => json({ error: { message: 'spent' } }, 402)) as typeof fetch;
    expect(await runAgent({ task: 't', model: 'm', gatewayUrl: 'http://gw', key: 'k', style: 'anthropic', cwd, fetch: broke })).toMatchObject({ finished: false, stopped: 'budget' });
    const down = (async () => json({ error: 'boom' }, 500)) as typeof fetch;
    await expect(runAgent({ task: 't', model: 'm', gatewayUrl: 'http://gw', key: 'k', style: 'anthropic', cwd, fetch: down })).rejects.toThrow(/500/);
  });
});

describe('built-in Runner: through the Harness', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });
  const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
  // The sandbox runs the compiled agent as its own process, so compile it if this checkout has not been built.
  beforeAll(() => { execFileSync(join(pkg, '..', '..', 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], { cwd: pkg, stdio: 'pipe' }); }, 120_000);

  it('runs as a separate process in the sandbox, through the real Gateway, and its work is gated', async () => {
    const cfg = CONFIG.replace('runner:   { use: mini-swe-agent, model: oafactory/coder }', 'runner:   { use: builtin, model: oafactory/coder }');
    expect(runnerCommand(parseFactoryConfig(cfg))).toBe('node "$OAFACTORY_AGENT"');
    const r = rig({ config: cfg });
    const provider = scripted('anthropic', [
      [{ name: 'read_file', input: { path: 'docs/guide.md' } }],
      [{ name: 'replace_in_file', input: { path: 'docs/guide.md', old: 'guide', new: 'guide\nNow with an empty-config section.' } }],
      [{ name: 'finish', input: { summary: 'Documented empty configs.' } }],
    ]);
    const gw = new Gateway(parseGatewayConfig(`
models:
  oafactory/coder: { provider: anthropic, model: real-coder, key_env: K1, usd_per_mtok: { input: 10, output: 50 } }
  oafactory/reviewer: { provider: openai, model: real-reviewer, key_env: K2, usd_per_mtok: { input: 1, output: 1 } }
`), r.store, { env: { K1: 'sk-provider-one', K2: 'sk-provider-two' }, fetch: provider.fetchStub });
    const server = await gw.listen('127.0.0.1:0');
    closers.push(server.close);
    const open = r.host.openChange.bind(r.host);
    r.host.openChange = async (input) => { const n = await open(input); r.host.passAll((await r.host.getChange(n)).headSha, ['lint', 'test']); return n; };

    // The compiled agent lives in dist/; the sandbox runs it as its own process.
    const dist = join(pkg, 'dist');
    expect(existsSync(join(dist, 'agent-bin.js'))).toBe(true);
    const [res] = await runWorkOrder({
      host: r.host, gate: r.deps, gateway: gw, gatewayUrl: server.url, sandbox: new LocalSandbox(), transport: new FakeTransport(r.host), agentDir: dist,
      reviewer: async () => ({ verdict: 'approve', comments: [] }), now: () => new Date(),
    }, workOrder('0099', ['docs/']));

    expect(res!.abandoned).toBeUndefined();
    expect(res!.gate!.decision).toBe('would_merge');
    const change = await r.host.getChange(res!.change!);
    expect(await r.host.readFile('docs/guide.md', change.headSha)).toBe('guide\nNow with an empty-config section.\n');
    // Three model calls, each with the real model name and provider key swapped in by the Gateway, and metered.
    expect(provider.sent.length).toBe(3);
    expect(provider.sent.every((s) => s.body.model === 'real-coder' && s.headers['x-api-key'] === 'sk-provider-one')).toBe(true);
    expect(res!.gate!.statement.predicate.run.cost_usd).toBeCloseTo(3 * (1000 * 10 + 100 * 50) / 1e6);
    expect(res!.gate!.statement.predicate.run.runner).toBe('builtin');
  });

  it('is mounted read-only into a Docker sandbox', () => {
    const sb = new DockerSandbox({ image: 'node:22-slim', network: 'oafactory-sandbox' });
    expect(sb.toolPath('/host/dist', 'agent-bin.js')).toBe(`${TOOLS_DIR}/agent-bin.js`);
    const args = sb.args('node "$OAFACTORY_AGENT"', { cwd: '/w', env: {} }).join(' ');
    expect(args).toContain(`-v /host/dist:${TOOLS_DIR}:ro`);
    expect(args).toContain('--user');
  });
});
