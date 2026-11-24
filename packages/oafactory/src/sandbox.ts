import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, shell, type ExecResult } from './exec.js';

export interface SandboxExec { cwd: string; env: Record<string, string>; timeoutMs?: number }

/** Where the built-in Runner is mounted inside a container. */
export const TOOLS_DIR = '/opt/oafactory';

export interface Sandbox {
  readonly kind: string;
  /** False when the sandbox does not actually confine the Worker. */
  readonly contained: boolean;
  exec(command: string, opts: SandboxExec): Promise<ExecResult>;
  /** The path, as seen from inside the Sandbox, of a file in a host directory the Sandbox exposes read-only. */
  toolPath(hostDir: string, file: string): string;
  /** The working directory as the Worker sees it. */
  workPath(hostCwd: string): string;
}

/** Environment variable names that must never reach the Worker. */
const SECRET = /TOKEN|SECRET|PASSWORD|CREDENTIAL|_KEY$|^GH_|^GITHUB_|^GITLAB_|^AWS_|^GOOGLE_|^AZURE_|^SSH_|^GIT_ASKPASS|^NPM_CONFIG_/i;

/** The Worker's environment: a short allowlist from the parent, plus what the Harness sets. */
export function workerEnv(extra: Record<string, string>, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ']) if (parent[k]) out[k] = parent[k]!;
  for (const [k, v] of Object.entries(extra)) {
    // The run key is the one credential the Worker is meant to hold.
    if (SECRET.test(k) && !/^(OAFACTORY_RUN_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)$/.test(k)) throw new Error(`refusing to pass ${k} into the sandbox`);
    out[k] = v;
  }
  return out;
}

/**
 * Runs the Worker as a child process on this machine with a scrubbed
 * environment and a throwaway HOME. This is NOT containment: the process can
 * still read the filesystem and reach the network. For development only.
 */
export class LocalSandbox implements Sandbox {
  readonly kind = 'local';
  readonly contained = false;
  toolPath(hostDir: string, file: string): string { return join(hostDir, file); }
  workPath(hostCwd: string): string { return hostCwd; }
  async exec(command: string, opts: SandboxExec): Promise<ExecResult> {
    const home = mkdtempSync(join(tmpdir(), 'oafactory-home-'));
    return shell(command, { cwd: opts.cwd, env: { ...workerEnv(opts.env), HOME: home }, timeoutMs: opts.timeoutMs, group: true });
  }
}

export interface DockerOptions {
  image: string;
  /** A Docker network created with `--internal`, so the only way out is the Gateway. */
  network: string;
  docker?: string;
  extraArgs?: string[];
}

/**
 * Runs the Worker in a container on an internal Docker network. The container
 * has no route to the internet; model calls and package downloads go through
 * the Gateway, which enforces the egress allowlist.
 */
export class DockerSandbox implements Sandbox {
  readonly kind = 'docker';
  readonly contained = true;
  private toolsDir?: string;
  constructor(private opts: DockerOptions) {}
  toolPath(hostDir: string, file: string): string { this.toolsDir = hostDir; return `${TOOLS_DIR}/${file}`; }
  workPath(): string { return '/work'; }
  args(command: string, o: SandboxExec, name?: string): string[] {
    const env = workerEnv(o.env, {});
    return [
      'run', '--rm', ...(name ? ['--name', name] : []), '--network', this.opts.network, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512',
      '-v', `${o.cwd}:/work`, '-w', '/work', '-e', 'HOME=/tmp',
      // Run as the Harness's user so the files the Worker leaves behind are not owned by root.
      ...(typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid!()}`] : []),
      ...(this.toolsDir ? ['-v', `${this.toolsDir}:${TOOLS_DIR}:ro`] : []),
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ...(this.opts.extraArgs ?? []), this.opts.image, 'sh', '-c', command,
    ];
  }
  async exec(command: string, o: SandboxExec): Promise<ExecResult> {
    const docker = this.opts.docker ?? 'docker';
    const name = `oafactory-${randomBytes(6).toString('hex')}`;
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) };
    const r = await exec(docker, this.args(command, o, name), { timeoutMs: o.timeoutMs, env });
    // Killing the docker client does not stop the container, so remove it explicitly.
    if (r.timedOut) await exec(docker, ['rm', '-f', name], { env }).catch(() => undefined);
    return r;
  }
}

export const SANDBOX_NETWORK = 'oafactory-sandbox';

/** Create the internal network if needed and return the address the Gateway must listen on to be reachable from it. */
export async function ensureNetwork(name = SANDBOX_NETWORK, docker = 'docker'): Promise<string> {
  const inspect = () => exec(docker, ['network', 'inspect', name, '--format', '{{.Internal}} {{(index .IPAM.Config 0).Gateway}}']);
  let r = await inspect();
  if (r.code !== 0) {
    const c = await exec(docker, ['network', 'create', '--internal', name]);
    if (c.code !== 0) throw new Error(`could not create docker network ${name}: ${c.stderr.trim()}`);
    r = await inspect();
  }
  const [internal, gatewayIp] = r.stdout.trim().split(' ');
  if (internal !== 'true') throw new Error(`docker network ${name} exists but is not internal; remove it or pick another name`);
  if (!gatewayIp) throw new Error(`could not read the gateway address of docker network ${name}`);
  return gatewayIp;
}
