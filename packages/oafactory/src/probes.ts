import type { Sandbox } from './sandbox.js';

export interface Probe { id: string; pass: boolean; detail: string }

/**
 * Live containment probes (conformance level 1), run inside the configured
 * Sandbox on the operator's own machine. `secrets` are the values that must not
 * be visible to the Worker: provider keys and the Harness, Gate and Watcher tokens.
 */
export async function liveProbes(sandbox: Sandbox, cwd: string, env: Record<string, string>, secrets: string[]): Promise<Probe[]> {
  const out: Probe[] = [];
  const sh = (command: string) => sandbox.exec(command, { cwd, env, timeoutMs: 60_000 });

  const viaProxy = await sh('curl -sS -m 15 -o /dev/null -w "%{http_code}" https://example.com 2>&1; echo " exit=$?"');
  const direct = await sh('curl -sS -m 15 --noproxy "*" -o /dev/null -w "%{http_code}" https://example.com 2>&1; echo " exit=$?"');
  const refused = (r: { stdout: string }) => !/exit=0\s*$/.test(r.stdout.trim()) || /^(000|403)/.test(r.stdout.trim());
  out.push({ id: 'C1.1', pass: refused(viaProxy) && refused(direct), detail: `through the gateway: ${viaProxy.stdout.trim()}; direct: ${direct.stdout.trim()}` });

  const dump = await sh('env; echo ---; git config --list --show-origin 2>/dev/null; echo ---; cat .git/config 2>/dev/null; cat ~/.git-credentials ~/.config/gh/hosts.yml ~/.config/glab-cli/config.yml ~/.netrc 2>/dev/null; true');
  const text = dump.stdout + dump.stderr;
  const gitCred = /extraheader|credential\.helper=.+|x-access-token|oauth_token|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[\w-]{10,}/i.exec(text);
  out.push({ id: 'C1.2', pass: !gitCred, detail: gitCred ? `found: ${gitCred[0].slice(0, 24)}...` : 'no Git host credential in the environment, git configuration or credential files' });

  const leaked = secrets.filter((s) => s && s.length >= 8 && text.includes(s));
  out.push({ id: 'C1.3', pass: leaked.length === 0, detail: leaked.length ? `${leaked.length} secret value(s) are readable inside the sandbox` : `none of ${secrets.filter(Boolean).length} secret values is readable inside the sandbox` });
  return out;
}
