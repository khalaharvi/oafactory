import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }
export interface ExecOptions { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; inherit?: boolean; /** Run in its own process group and kill the whole group on timeout. */ group?: boolean }

function collect(child: ChildProcess, opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
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

const stdio = (opts: ExecOptions): StdioOptions => ['pipe', opts.inherit ? 'inherit' : 'pipe', opts.inherit ? 'inherit' : 'pipe'];

/** Run a program with an argument vector. Never goes through a shell: arguments are passed as they are. */
export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return collect(spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: stdio(opts), detached: !!opts.group, shell: false }), opts);
}

/**
 * Run a command line through `sh -c`. This is the only place a shell is used,
 * and it is for one purpose: running the Worker's command inside a sandbox.
 * Nothing that talks to the Git host goes through here.
 */
export function shell(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return collect(spawn('sh', ['-c', command], { cwd: opts.cwd, env: opts.env ?? process.env, stdio: stdio(opts), detached: !!opts.group }), opts);
}

export async function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) {
    // Keep errors short: tool output can run to thousands of characters and may carry signed URLs.
    const detail = (r.stderr.trim() || r.stdout.trim()).split('?')[0]!.slice(0, 300);
    throw new Error(`${cmd} ${args.slice(0, 4).map((a) => a.split('?')[0]!.slice(0, 80)).join(' ')} failed (${r.code}): ${detail}`);
  }
  return r.stdout;
}
