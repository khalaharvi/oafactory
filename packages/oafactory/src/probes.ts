import type { Sandbox } from './sandbox.js';

export interface Probe { id: string; pass: boolean; detail: string }

// Each probe is a Node one-liner, so it runs in any image that can host the built-in Runner.
const HEALTH = 'fetch(process.env.OAFACTORY_GATEWAY_URL+"/healthz",{signal:AbortSignal.timeout(8000)}).then(r=>console.log("status",r.status)).catch(e=>console.log("failed",(e.cause&&e.cause.code)||e.name))';
const DIRECT = (url: string) => `fetch("${url}",{signal:AbortSignal.timeout(8000)}).then(r=>console.log("REACHED",r.status)).catch(e=>console.log("blocked",(e.cause&&e.cause.code)||e.name))`;
const CONNECT = (target: string) => `const u=new URL(process.env.OAFACTORY_GATEWAY_URL);const q=require("http").request({host:u.hostname,port:u.port,method:"CONNECT",path:"${target}",timeout:8000});q.on("connect",(r,s)=>{console.log("status",r.statusCode);s.destroy()});q.on("error",e=>console.log("failed",e.code));q.on("timeout",()=>{console.log("failed timeout");q.destroy()});q.end()`;

/**
 * Live containment probes (conformance level 1), run inside the configured
 * Sandbox on the operator's own machine. `secrets` are the values that must not
 * be visible to the Worker: provider keys and the Harness, Gate and Watcher tokens.
 *
 * C1.1 includes a positive control: the Gateway must be reachable from the
 * Sandbox. Without it, a Sandbox with no network at all would pass by accident.
 */
export async function liveProbes(sandbox: Sandbox, cwd: string, gatewayUrl: string, secrets: string[]): Promise<Probe[]> {
  const out: Probe[] = [];
  const env = { OAFACTORY_GATEWAY_URL: gatewayUrl, HTTPS_PROXY: gatewayUrl, HTTP_PROXY: gatewayUrl, https_proxy: gatewayUrl, http_proxy: gatewayUrl };
  const sh = (command: string) => sandbox.exec(command, { cwd, env, timeoutMs: 60_000 });
  const node = async (js: string) => { const r = await sh(`node -e '${js}'`); return (r.stdout + r.stderr).trim().split('\n').at(-1) ?? ''; };

  const hasNode = (await sh('node --version')).code === 0;
  if (!hasNode) {
    out.push({ id: 'C1.1', pass: false, detail: 'the sandbox image has no `node`, which the probes need; use an image with Node, such as node:22-slim' });
  } else {
    const health = await node(HEALTH);
    const refused = await node(CONNECT('example.com:443'));
    const direct = await node(DIRECT('https://example.com'));
    const directIp = await node(DIRECT('http://1.1.1.1'));
    const pass = health === 'status 200' && refused === 'status 403' && direct.startsWith('blocked') && directIp.startsWith('blocked');
    out.push({ id: 'C1.1', pass, detail: `gateway reachable: ${health}; proxy to a host off the allowlist: ${refused}; direct to example.com: ${direct}; direct to 1.1.1.1: ${directIp}` });
  }

  const dump = await sh('env; echo ---; git config --list --show-origin 2>/dev/null; echo ---; cat .git/config 2>/dev/null; cat ~/.git-credentials ~/.config/gh/hosts.yml ~/.config/glab-cli/config.yml ~/.netrc 2>/dev/null; true');
  const text = dump.stdout + dump.stderr;
  const gitCred = /extraheader|credential\.helper=.+|x-access-token|oauth_token|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[\w-]{10,}/i.exec(text);
  out.push({ id: 'C1.2', pass: !gitCred, detail: gitCred ? `found: ${gitCred[0].slice(0, 24)}...` : 'no Git host credential in the environment, git configuration or credential files' });

  const leaked = secrets.filter((s) => s && s.length >= 8 && text.includes(s));
  out.push({ id: 'C1.3', pass: leaked.length === 0, detail: leaked.length ? `${leaked.length} secret value(s) are readable inside the sandbox` : `none of ${secrets.filter(Boolean).length} secret values is readable inside the sandbox` });
  return out;
}
