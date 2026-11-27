import { describe, expect, it } from 'vitest';
import { parseGatewayConfig } from '../src/config.js';
import { Gateway, describeFetchError } from '../src/gateway.js';
import { openDb, Store } from '../src/ledger.js';

// Found in a live run on macOS: one network timeout on the Reviewer's request left
// the change without review evidence, and the log said only "fetch failed".

const CONFIG = parseGatewayConfig(`
models:
  oafactory/reviewer: { provider: anthropic, model: real-reviewer, key_env: K, usd_per_mtok: { input: 1, output: 1 } }
`);
const OK = JSON.stringify({ content: [{ type: 'text', text: '{"verdict":"approve","comments":[]}' }], usage: { input_tokens: 10, output_tokens: 5 } });

function timeout(): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
}

function gateway(responses: Array<() => Response>) {
  const store = new Store(openDb(':memory:'));
  let calls = 0;
  const fetch = (async () => { const next = responses[calls++]; if (!next) throw new Error('unexpected request'); return next(); }) as typeof globalThis.fetch;
  const logs: string[] = [];
  const gw = new Gateway(CONFIG, store, { env: { K: 'sk-provider' }, fetch, retryDelaysMs: [0, 0], log: (m) => logs.push(m) });
  return { gw, store, logs, calls: () => calls };
}

describe('Gateway completions used by the built-in Reviewer', () => {
  it('tries again after a network error and meters only the request that succeeded', async () => {
    const g = gateway([() => { throw timeout(); }, () => new Response(OK)]);
    expect(await g.gw.complete('oafactory/reviewer', 'run-1', 'sys', 'diff')).toContain('approve');
    expect(g.calls()).toBe(2);
    expect(g.logs.join('\n')).toMatch(/fetch failed \(ETIMEDOUT\); trying again/);
    expect(g.store.usage('run-1')).toMatchObject({ input_tokens: 10, requests: 1 });
  });

  it('tries again after an overloaded or rate-limited response', async () => {
    const g = gateway([() => new Response('overloaded', { status: 529 }), () => new Response('slow down', { status: 429 }), () => new Response(OK)]);
    expect(await g.gw.complete('oafactory/reviewer', 'run-1', 'sys', 'diff')).toContain('approve');
    expect(g.calls()).toBe(3);
  });

  it('does not try again when the request itself is wrong', async () => {
    const g = gateway([() => new Response('bad key', { status: 401 }), () => new Response(OK)]);
    await expect(g.gw.complete('oafactory/reviewer', 'run-1', 'sys', 'diff')).rejects.toThrow(/model request failed \(401\): bad key/);
    expect(g.calls()).toBe(1);
  });

  it('names the network error and what to check when every try fails', async () => {
    const g = gateway([() => { throw timeout(); }, () => { throw timeout(); }, () => { throw timeout(); }]);
    await expect(g.gw.complete('oafactory/reviewer', 'run-1', 'sys', 'diff')).rejects.toThrow(/could not reach anthropic after 3 tries: fetch failed \(ETIMEDOUT\)\. Check this machine's network connection/);
    expect(g.calls()).toBe(3);
  });

  it('gives up after the last status error and reports it', async () => {
    const g = gateway([() => new Response('a', { status: 503 }), () => new Response('b', { status: 503 }), () => new Response('c', { status: 503 })]);
    await expect(g.gw.complete('oafactory/reviewer', 'run-1', 'sys', 'diff')).rejects.toThrow(/model request failed \(503\): c/);
    expect(g.calls()).toBe(3);
  });

  it('does not try again when the provider key is missing', async () => {
    const store = new Store(openDb(':memory:'));
    const gw = new Gateway(CONFIG, store, { env: {}, fetch: (async () => new Response(OK)) as typeof fetch, retryDelaysMs: [0, 0] });
    await expect(gw.complete('oafactory/reviewer', 'run-1', 'sys', 'diff')).rejects.toThrow(/provider key K is not set/);
  });

  it('describes a fetch error with and without a cause', () => {
    expect(describeFetchError(timeout())).toBe('fetch failed (ETIMEDOUT)');
    expect(describeFetchError(new Error('boom'))).toBe('boom');
  });
});
