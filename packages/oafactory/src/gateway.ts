import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { modelFamily, resolvedModelName, type GatewayConfig, type GatewayModel } from './config.js';
import type { Store } from './ledger.js';

/** Trim trailing slashes without a regular expression: request paths come from the Worker. */
function trimSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');
const UPSTREAM = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com' } as const;

interface Tokens { input: number; output: number }

/** Read token usage from a provider response body, plain JSON or server-sent events. */
export function extractUsage(body: string): Tokens {
  const t: Tokens = { input: 0, output: 0 };
  const visit = (u: Record<string, unknown> | undefined | null) => {
    if (!u || typeof u !== 'object') return;
    const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
    // Anthropic reports cache tokens separately; count them all as input so the meter never under-counts.
    const input = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('prompt_tokens');
    const output = n('output_tokens') + n('completion_tokens');
    t.input = Math.max(t.input, input);
    t.output = Math.max(t.output, output);
  };
  const scan = (obj: unknown) => {
    if (!obj || typeof obj !== 'object') return;
    const o = obj as Record<string, unknown>;
    visit(o.usage as Record<string, unknown>);
    visit((o.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown>);
  };
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{')) {
    try { scan(JSON.parse(trimmed)); } catch { /* not JSON */ }
  } else {
    for (const line of body.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { scan(JSON.parse(data)); } catch { /* partial line */ }
    }
  }
  return t;
}

export interface GatewayOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * The Gateway holds provider keys and issues one budgeted key per run. The
 * Worker only ever sees the run key. It also serves as the Sandbox's only way
 * out: an HTTPS CONNECT proxy limited to the egress allowlist.
 */
export class Gateway {
  private server?: Server;
  private env: NodeJS.ProcessEnv;
  private fetch: typeof fetch;
  constructor(readonly config: GatewayConfig, private store: Store, private opts: GatewayOptions = {}) {
    this.env = opts.env ?? process.env;
    this.fetch = opts.fetch ?? fetch;
  }

  issueKey(runId: string, budgetUsd: number): string {
    const key = `oaf_${randomBytes(24).toString('hex')}`;
    this.store.putKey(hashKey(key), runId, budgetUsd);
    return key;
  }
  revoke(runId: string): void { this.store.revokeKeys(runId); }
  model(alias: string): GatewayModel | undefined { return this.config.models[alias]; }
  describe(alias: string): { resolved: string; family: string } {
    const m = this.model(alias);
    if (!m) throw new Error(`the gateway config has no model alias "${alias}"`);
    return { resolved: resolvedModelName(m), family: modelFamily(m) };
  }

  private cost(m: GatewayModel, t: Tokens): number {
    return (t.input / 1e6) * m.usd_per_mtok.input + (t.output / 1e6) * m.usd_per_mtok.output;
  }

  private upstream(m: GatewayModel, path: string, headers: Record<string, string>, body: string) {
    const key = this.env[m.key_env];
    if (!key) throw new Error(`provider key ${m.key_env} is not set in the gateway's environment`);
    const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
    if (m.provider === 'anthropic') { h['x-api-key'] = key; h['anthropic-version'] ??= '2023-06-01'; }
    else h.authorization = `Bearer ${key}`;
    const base = trimSlashes(m.base_url ?? UPSTREAM[m.provider]);
    return this.fetch(`${base}${path}`, { method: 'POST', headers: h, body });
  }

  /** One non-streaming completion, metered against a run. Used by the built-in Reviewer. */
  async complete(alias: string, runId: string, system: string, user: string, maxTokens = 2000): Promise<string> {
    const m = this.model(alias);
    if (!m) throw new Error(`the gateway config has no model alias "${alias}"`);
    const body = m.provider === 'anthropic'
      ? { model: m.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }
      : { model: m.model, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    const res = await this.upstream(m, m.provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions', {}, JSON.stringify(body));
    const text = await res.text();
    if (!res.ok) throw new Error(`model request failed (${res.status}): ${text.slice(0, 300)}`);
    const t = extractUsage(text);
    this.store.addUsage(runId, resolvedModelName(m), t.input, t.output, this.cost(m, t));
    const json = JSON.parse(text) as { content?: Array<{ type: string; text?: string }>; choices?: Array<{ message: { content: string } }> };
    return m.provider === 'anthropic' ? (json.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('') : (json.choices?.[0]?.message.content ?? '');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'oafactory_gateway', message } }));
    };
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    // Absolute-URI requests are plain-HTTP proxying, which the Sandbox is never allowed.
    if (/^https?:\/\//i.test(url)) return send(403, 'egress is limited to the gateway allowlist over HTTPS');
    const path = trimSlashes(url.split('?')[0]!);
    const kind = path.endsWith('/messages') ? 'anthropic' : path.endsWith('/chat/completions') ? 'openai' : null;
    if (req.method !== 'POST' || !kind) return send(404, 'the gateway serves POST /v1/messages and POST /v1/chat/completions');

    const presented = (req.headers['x-api-key'] as string | undefined) ?? /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    const key = presented ? this.store.getKey(hashKey(presented)) : undefined;
    if (!key || key.revoked) return send(401, 'unknown or revoked run key');
    if (this.store.usage(key.run_id).cost_usd >= key.budget_usd) return send(402, `run ${key.run_id} has spent its budget of $${key.budget_usd}`);

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, unknown>;
    try { body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; } catch { return send(400, 'request body is not JSON'); }
    const alias = String(body.model ?? '');
    const m = this.model(alias);
    if (!m) return send(400, `unknown model alias "${alias}"; the gateway serves: ${Object.keys(this.config.models).join(', ')}`);
    if (m.provider !== kind) return send(400, `model alias "${alias}" is served by ${m.provider}; call ${m.provider === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'}`);
    body.model = m.model;
    if (kind === 'openai' && body.stream === true) body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };

    const forward: Record<string, string> = {};
    for (const h of ['anthropic-version', 'anthropic-beta', 'accept']) if (typeof req.headers[h] === 'string') forward[h] = req.headers[h] as string;
    let up: Response;
    try {
      up = await this.upstream(m, kind === 'anthropic' ? '/v1/messages' : '/v1/chat/completions', forward, JSON.stringify(body));
    } catch (e) {
      return send(502, `upstream request failed: ${(e as Error).message}`);
    }
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
    let text = '';
    if (up.body) {
      const decoder = new TextDecoder();
      for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) { res.write(chunk); text += decoder.decode(chunk, { stream: true }); }
    }
    res.end();
    if (up.ok) {
      const t = extractUsage(text);
      this.store.addUsage(key.run_id, resolvedModelName(m), t.input, t.output, this.cost(m, t));
      this.opts.log?.(`${key.run_id} ${alias} in=${t.input} out=${t.output}`);
    }
  }

  egressAllowed(host: string, port: number): boolean {
    return port === 443 && this.config.egress.includes(host.toLowerCase());
  }

  async listen(listen = this.config.listen): Promise<{ url: string; port: number; close: () => Promise<void> }> {
    const idx = listen.lastIndexOf(':');
    const host = listen.slice(0, idx), port = Number(listen.slice(idx + 1));
    const server = createServer((req, res) => { this.handle(req, res).catch((e) => { if (!res.headersSent) res.writeHead(500); res.end(String((e as Error).message)); }); });
    server.on('connect', (req, socket) => {
      const [h, p] = (req.url ?? '').split(':');
      if (!h || !this.egressAllowed(h, Number(p))) {
        this.opts.log?.(`egress refused: ${req.url}`);
        socket.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\negress to this host is not on the gateway allowlist\n');
        return;
      }
      const up = connect(Number(p), h, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(socket); socket.pipe(up); });
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    this.server = server;
    const actual = (server.address() as { port: number }).port;
    return {
      url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}`, port: actual,
      close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    };
  }
}
