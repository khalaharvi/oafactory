import { spawn } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }
export interface ExecOptions { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; inherit?: boolean; /** Run in its own process group and kill the whole group on timeout. */ group?: boolean }

/** Run a program with an argument vector. Never goes through a shell. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', opts.inherit ? 'inherit' : 'pipe', opts.inherit ? 'inherit' : 'pipe'], detached: !!opts.group });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true;
      try { if (opts.group && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, opts.timeoutMs) : undefined;
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, timedOut }); });
    child.stdin?.on('error', () => { /* the child exited without reading stdin */ });
    child.stdin?.end(opts.input ?? '');
  });
}

export async function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}
