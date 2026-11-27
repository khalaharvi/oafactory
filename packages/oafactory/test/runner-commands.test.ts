import { afterEach, describe, expect, it } from 'vitest';
import { parseFactoryConfig, parseGatewayConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { RUNNER_COMMANDS, runWorkOrder, runnerCommand } from '../src/harness.js';
import { LocalSandbox } from '../src/sandbox.js';
import { FakeTransport } from '../src/workspace.js';
import { CONFIG, rig, workOrder } from './helpers.js';

// Found in a live run with Claude Code 2.1.332 in the Docker sandbox: the work
// went through the Gateway, but Claude Code also tried api.anthropic.com
// directly for non-essential traffic, which the Gateway's egress rules refused.

describe('the claude-code Runner command', () => {
  it('turns off Claude Code\'s non-essential traffic and runs without permission prompts', () => {
    const cmd = RUNNER_COMMANDS['claude-code']!;
    expect(cmd.startsWith('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude -p "$OAFACTORY_TASK"')).toBe(true);
    expect(cmd).toContain('--model "$OAFACTORY_MODEL"');
    expect(cmd).toContain('--dangerously-skip-permissions');
  });

  it('is the command a factory config with use: claude-code runs', () => {
    const cfg = parseFactoryConfig(CONFIG.replace(/runner:\s*\{[^}]*\}/, 'runner: { use: claude-code, model: oafactory/coder }'));
    expect(runnerCommand(cfg)).toBe(RUNNER_COMMANDS['claude-code']);
  });
});

// Found in a live run with mini-swe-agent 2.4.6: without a terminal its first-run setup
// prompt aborted the run, and litellm rejected a model name with no provider in it.
describe('the mini-swe-agent Runner command', () => {
  it('skips the setup prompt, names the provider, and leaves spending to the Gateway', () => {
    const cmd = RUNNER_COMMANDS['mini-swe-agent']!;
    expect(cmd).toContain('MSWEA_CONFIGURED=true');
    expect(cmd).toContain('LITELLM_LOCAL_MODEL_COST_MAP=True');
    expect(cmd).toContain('-m "$OAFACTORY_API_STYLE/$OAFACTORY_MODEL"');
    expect(cmd).toContain('-t "$OAFACTORY_TASK"');
    expect(cmd).toContain('--exit-immediately');
    expect(cmd).toContain('-l 0');
  });
});

describe('what a command Runner is told about its model', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it('gets OAFACTORY_API_STYLE, so it can name the provider, not only the built-in Runner', async () => {
    const config = CONFIG.replace('runner:   { use: mini-swe-agent, model: oafactory/coder }', 'runner:   { use: command, model: oafactory/coder, command: "echo style=$OAFACTORY_API_STYLE >> docs/guide.md" }');
    const r = rig({ config });
    const gw = new Gateway(parseGatewayConfig(`
models:
  oafactory/coder: { provider: anthropic, model: real-coder, key_env: K1, usd_per_mtok: { input: 1, output: 1 } }
  oafactory/reviewer: { provider: openai, model: real-reviewer, key_env: K2, usd_per_mtok: { input: 1, output: 1 } }
`), r.store, { env: { K1: 'a', K2: 'b' }, fetch: (async () => new Response('{}')) as typeof fetch });
    const server = await gw.listen('127.0.0.1:0');
    closers.push(server.close);
    const [res] = await runWorkOrder({
      host: r.host, gate: r.deps, gateway: gw, gatewayUrl: server.url, sandbox: new LocalSandbox(), transport: new FakeTransport(r.host),
      reviewer: async () => ({ verdict: 'approve', comments: [] }), now: () => new Date(),
    }, workOrder('0001'));
    const head = (await r.host.getChange(res!.change!)).headSha;
    expect(await r.host.readFile('docs/guide.md', head)).toContain('style=anthropic');
  });
});
