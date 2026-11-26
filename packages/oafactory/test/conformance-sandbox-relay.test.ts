// How a Worker on the internal Docker network reaches the Gateway, on Linux and on Docker Desktop.
// C1.1: "A Worker request to a host outside the egress allowlist is refused." The relay must not
// widen what the Worker can reach: it forwards to the Gateway and nowhere else.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecResult } from '../src/exec.js';
import { RELAY_PORT, RELAY_SOURCE, dockerGatewayRoute, isLocalAddress, startRelay, type DockerCli } from '../src/sandbox.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr, timedOut: false });

/** A stand-in for the docker CLI: records every call and answers from a script. */
function fakeDocker(answer: (args: string[]) => ExecResult): { run: DockerCli; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, run: async (args) => { calls.push(args); return answer(args); } };
}

const desktop = (over: Partial<Record<string, ExecResult>> = {}) => fakeDocker((args) => {
  const key = args[0] === 'network' ? `network ${args[1]}` : args[0]!;
  if (over[key]) return over[key]!;
  switch (key) {
    case 'network inspect': return ok('true 172.24.0.1\n');
    case 'network connect': return ok();
    case 'run': return ok('abc123\n');
    case 'inspect': return ok(JSON.stringify({ bridge: { IPAddress: '172.17.0.9' }, 'oafactory-sandbox': { IPAddress: '172.24.0.5' } }));
    case 'logs': return ok('relay ready 8080\n');
    case 'rm': return ok();
    default: return fail(`unexpected docker ${args.join(' ')}`);
  }
});

describe('C1.1 Gateway route from the internal Docker network', () => {
  it('C1.1 on Linux the Gateway listens on the internal network\'s gateway address and no relay runs', async () => {
    const docker = desktop();
    const route = await dockerGatewayRoute({ network: 'oafactory-sandbox', image: 'node:26-slim', run: docker.run, isLocal: () => true });
    expect(route.listenHost).toBe('172.24.0.1');
    const link = await route.connect(4141);
    expect(link.url).toBe('http://172.24.0.1:4141');
    await link.close();
    expect(docker.calls.map((c) => c[0])).toEqual(['network']);
  });

  it('C1.1 on Docker Desktop the Gateway stays on loopback and a hardened relay carries only its traffic', async () => {
    const docker = desktop();
    const route = await dockerGatewayRoute({ network: 'oafactory-sandbox', image: 'node:26-slim', run: docker.run, isLocal: () => false });
    // Loopback, not 0.0.0.0: nothing outside this machine can reach the Gateway.
    expect(route.listenHost).toBe('127.0.0.1');

    const link = await route.connect(4141);
    expect(link.url).toBe(`http://172.24.0.5:${RELAY_PORT}`);

    const run = docker.calls.find((c) => c[0] === 'run')!;
    const flag = (name: string) => run[run.indexOf(name) + 1];
    expect(flag('--network')).toBe('bridge');
    expect(flag('--cap-drop')).toBe('ALL');
    expect(flag('--security-opt')).toBe('no-new-privileges');
    expect(flag('--user')).toBe('65534:65534');
    expect(run).toContain('--read-only');
    expect(run).toContain('OAF_TARGET_PORT=4141');
    // The relay holds no credential of any kind: its only environment is the two ports.
    const dockerFlags = run.slice(0, run.indexOf('node:26-slim'));
    expect(dockerFlags.filter((_a, i) => dockerFlags[i - 1] === '-e')).toEqual(['OAF_TARGET_PORT=4141', `OAF_LISTEN_PORT=${RELAY_PORT}`]);
    expect(run.join(' ')).not.toMatch(/KEY|TOKEN|SECRET/);
    expect(docker.calls).toContainEqual(['network', 'connect', 'oafactory-sandbox', expect.stringMatching(/^oafactory-relay-/)]);

    await link.close();
    expect(docker.calls.at(-1)).toEqual(['rm', '-f', run[run.indexOf('--name') + 1]]);
  });

  it('removes the relay when it cannot join the internal network', async () => {
    const docker = desktop({ 'network connect': fail('no such network') });
    await expect(startRelay({ network: 'oafactory-sandbox', image: 'node:26-slim', target: 1, run: docker.run, name: 'r1' })).rejects.toThrow(/could not join the Gateway relay/);
    expect(docker.calls.at(-1)).toEqual(['rm', '-f', 'r1']);
  });

  it('removes the relay when it never starts listening', async () => {
    const docker = desktop({ logs: ok('') });
    await expect(startRelay({ network: 'oafactory-sandbox', image: 'node:26-slim', target: 1, run: docker.run, name: 'r2', waitMs: 50 })).rejects.toThrow(/did not start listening/);
    expect(docker.calls.at(-1)).toEqual(['rm', '-f', 'r2']);
  });

  it('says what to check when the relay container cannot start', async () => {
    const docker = desktop({ run: fail('pull access denied') });
    await expect(startRelay({ network: 'n', image: 'busybox', target: 1, run: docker.run })).rejects.toThrow(/has `node`/);
  });

  it('recognises this machine\'s own addresses', () => {
    const ifaces = { lo0: [{ address: '127.0.0.1' }], 'br-1': [{ address: '172.24.0.1' }] } as unknown as Parameters<typeof isLocalAddress>[1];
    expect(isLocalAddress('172.24.0.1', ifaces)).toBe(true);
    expect(isLocalAddress('172.25.0.1', ifaces)).toBe(false);
  });
});

describe('C1.1 the relay forwards to one address only', () => {
  let target: Server | undefined;
  let relay: ChildProcess | undefined;
  afterEach(() => { relay?.kill(); target?.close(); });

  it('C1.1 every connection lands on the Gateway, whatever host the Worker asks for', async () => {
    const seen: string[] = [];
    target = createServer((req, res) => { seen.push(`${req.headers.host} ${req.url}`); res.end('gateway'); });
    await new Promise<void>((r) => target!.listen(0, '127.0.0.1', r));
    const targetPort = (target.address() as AddressInfo).port;

    relay = spawn(process.execPath, ['-e', RELAY_SOURCE], {
      env: { PATH: process.env.PATH, OAF_TARGET_HOST: '127.0.0.1', OAF_TARGET_PORT: String(targetPort), OAF_LISTEN_PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const relayPort = await new Promise<number>((resolve, reject) => {
      relay!.stdout!.on('data', (d: Buffer) => { const m = /relay ready (\d+)/.exec(d.toString()); if (m) resolve(Number(m[1])); });
      relay!.once('exit', (c) => reject(new Error(`relay exited ${c}`)));
    });

    const get = (path: string, host: string) => new Promise<string>((resolve, reject) => {
      request({ host: '127.0.0.1', port: relayPort, path, headers: { host } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); }).on('error', reject).end();
    });
    expect(await get('/v1/messages', 'gateway')).toBe('gateway');
    // A request aimed at another host, proxy style, still goes to the Gateway, which applies the allowlist.
    expect(await get('http://example.com/', 'example.com')).toBe('gateway');
    expect(seen).toEqual(['gateway /v1/messages', 'example.com http://example.com/']);
  });
});
