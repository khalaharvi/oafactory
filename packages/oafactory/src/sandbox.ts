import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
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

/** Runs the docker CLI with an argument vector. Injected so the network plumbing can be tested without Docker. */
export type DockerCli = (args: string[]) => Promise<ExecResult>;
const dockerCli = (docker: string): DockerCli => (args) => exec(docker, args);

/** Create the internal network if needed and return its gateway address. */
export async function ensureNetwork(name = SANDBOX_NETWORK, docker = 'docker', run: DockerCli = dockerCli(docker)): Promise<string> {
  const inspect = () => run(['network', 'inspect', name, '--format', '{{.Internal}} {{(index .IPAM.Config 0).Gateway}}']);
  let r = await inspect();
  if (r.code !== 0) {
    const c = await run(['network', 'create', '--internal', name]);
    if (c.code !== 0) throw new Error(`could not create docker network ${name}: ${c.stderr.trim()}`);
    r = await inspect();
  }
  const [internal, gatewayIp] = r.stdout.trim().split(' ');
  if (internal !== 'true') throw new Error(`docker network ${name} exists but is not internal; remove it or pick another name`);
  if (!gatewayIp) throw new Error(`could not read the gateway address of docker network ${name}`);
  return gatewayIp;
}

/** True when an address belongs to one of this machine's network interfaces. */
export function isLocalAddress(ip: string, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): boolean {
  return Object.values(interfaces).some((list) => (list ?? []).some((i) => i.address === ip));
}

/** How the Sandbox reaches the Gateway: where the Gateway listens, and the URL the Worker is given once it does. */
export interface GatewayRoute {
  listenHost: string;
  connect(port: number): Promise<{ url: string; close(): Promise<void> }>;
}

/** The local sandbox shares this machine's network, so the Gateway listens on loopback. */
export const LOOPBACK_ROUTE: GatewayRoute = {
  listenHost: '127.0.0.1',
  connect: async (port) => ({ url: `http://127.0.0.1:${port}`, close: async () => {} }),
};

/**
 * A TCP relay that forwards every connection to one fixed address and nowhere
 * else. It reads its target from the environment so the same source runs in a
 * container and in the tests.
 */
export const RELAY_SOURCE = [
  "const net = require('node:net');",
  "const host = process.env.OAF_TARGET_HOST || 'host.docker.internal';",
  'const port = Number(process.env.OAF_TARGET_PORT);',
  'const server = net.createServer((c) => {',
  '  const u = net.connect(port, host);',
  "  c.on('error', () => u.destroy()); u.on('error', () => c.destroy());",
  '  c.pipe(u).pipe(c);',
  '});',
  "server.listen(Number(process.env.OAF_LISTEN_PORT || 8080), () => console.log('relay ready ' + server.address().port));",
].join('\n');

export const RELAY_PORT = 8080;

export interface RelayOptions {
  /** The internal network the Worker runs on. */
  network: string;
  image: string;
  /** The port the Gateway listens on, on this machine's loopback interface. */
  target: number;
  run: DockerCli;
  name?: string;
  waitMs?: number;
}

/**
 * Start a relay container joined to the internal network and to Docker's
 * default bridge, forwarding only to the Gateway on this machine. The Worker
 * stays on the internal network alone, so its only way out is still the
 * Gateway. The relay runs as nobody, with no capabilities and a read-only root.
 */
export async function startRelay(o: RelayOptions): Promise<{ address: string; port: number; close(): Promise<void> }> {
  const name = o.name ?? `oafactory-relay-${randomBytes(6).toString('hex')}`;
  const close = async () => { await o.run(['rm', '-f', name]).catch(() => undefined); };
  const started = await o.run([
    'run', '-d', '--rm', '--name', name, '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--pids-limit', '64', '--user', '65534:65534',
    '-e', `OAF_TARGET_PORT=${o.target}`, '-e', `OAF_LISTEN_PORT=${RELAY_PORT}`, o.image, 'node', '-e', RELAY_SOURCE,
  ]);
  if (started.code !== 0) throw new Error(`could not start the Gateway relay container: ${started.stderr.trim()}. Check that the image ${o.image} has \`node\`, or set OAFACTORY_RELAY_IMAGE to one that does.`);
  try {
    const joined = await o.run(['network', 'connect', o.network, name]);
    if (joined.code !== 0) throw new Error(`could not join the Gateway relay to docker network ${o.network}: ${joined.stderr.trim()}`);
    const inspected = await o.run(['inspect', '--format', '{{json .NetworkSettings.Networks}}', name]);
    const networks = (() => { try { return JSON.parse(inspected.stdout) as Record<string, { IPAddress?: string }>; } catch { return {}; } })();
    const address = networks[o.network]?.IPAddress;
    if (!address) throw new Error(`could not read the Gateway relay's address on docker network ${o.network}`);
    const deadline = Date.now() + (o.waitMs ?? 15_000);
    for (;;) {
      if ((await o.run(['logs', name])).stdout.includes('relay ready')) break;
      if (Date.now() > deadline) throw new Error('the Gateway relay container did not start listening in time; see `docker logs` for the container, or run with --sandbox docker on a Linux host');
      await new Promise((r) => setTimeout(r, 100));
    }
    return { address, port: RELAY_PORT, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/**
 * Work out how a container on the internal network reaches the Gateway.
 *
 * On Linux the internal network's gateway address is on this machine, so the
 * Gateway listens there directly. Docker Desktop (macOS, Windows) runs
 * containers in a VM: that address is not on this machine and an internal
 * network has no route out of the VM, so a relay container carries the
 * Gateway's traffic, and only its traffic.
 */
/**
 * The relay only needs Node, whatever image the Worker runs in. A sandbox image
 * built for another language (Python for mini-swe-agent, for example) has none,
 * so the relay never borrows it.
 */
export const RELAY_IMAGE = 'node:26-slim';
export function relayImage(env: NodeJS.ProcessEnv = process.env): string { return env.OAFACTORY_RELAY_IMAGE || RELAY_IMAGE; }

export async function dockerGatewayRoute(o: { network: string; image?: string; docker?: string; run?: DockerCli; isLocal?: (ip: string) => boolean }): Promise<GatewayRoute> {
  const run = o.run ?? dockerCli(o.docker ?? 'docker');
  const gatewayIp = await ensureNetwork(o.network, o.docker, run);
  if ((o.isLocal ?? isLocalAddress)(gatewayIp)) {
    return { listenHost: gatewayIp, connect: async (port) => ({ url: `http://${gatewayIp}:${port}`, close: async () => {} }) };
  }
  return {
    listenHost: '127.0.0.1',
    connect: async (port) => {
      const relay = await startRelay({ network: o.network, image: o.image ?? relayImage(), target: port, run });
      return { url: `http://${relay.address}:${relay.port}`, close: relay.close };
    },
  };
}
