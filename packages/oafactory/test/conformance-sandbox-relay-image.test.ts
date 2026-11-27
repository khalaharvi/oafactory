// C1.1 on Docker Desktop: the relay must start whatever image the Worker runs in.
// Found in a live run: a Python sandbox image for mini-swe-agent has no Node, and the
// relay borrowed that image, so the run failed before the Worker started.
import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../src/exec.js';
import { RELAY_IMAGE, dockerGatewayRoute, relayImage, type DockerCli } from '../src/sandbox.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });

function desktop(): { run: DockerCli; calls: string[][] } {
  const calls: string[][] = [];
  const run: DockerCli = async (args) => {
    calls.push(args);
    if (args[0] === 'network' && args[1] === 'inspect') return ok('true 172.24.0.1\n');
    if (args[0] === 'inspect') return ok(JSON.stringify({ bridge: { IPAddress: '172.17.0.9' }, 'oafactory-sandbox': { IPAddress: '172.24.0.5' } }));
    if (args[0] === 'logs') return ok('relay ready 8080\n');
    return ok('abc123\n');
  };
  return { run, calls };
}

/** The image is the argument right before `node -e <relay source>`. */
const imageOf = (run: string[]) => run[run.indexOf('node') - 1];

describe('C1.1 the Gateway relay image', () => {
  it('C1.1 runs its own Node image when no image is given, not the Worker\'s', async () => {
    const docker = desktop();
    const route = await dockerGatewayRoute({ network: 'oafactory-sandbox', run: docker.run, isLocal: () => false });
    const link = await route.connect(4141);
    expect(imageOf(docker.calls.find((c) => c[0] === 'run')!)).toBe(relayImage());
    await link.close();
  });

  it('C1.1 defaults to node:26-slim and can be pointed at a mirror', () => {
    expect(RELAY_IMAGE).toBe('node:26-slim');
    expect(relayImage({})).toBe('node:26-slim');
    expect(relayImage({ OAFACTORY_RELAY_IMAGE: 'registry.example.com/node:26-slim' })).toBe('registry.example.com/node:26-slim');
    expect(relayImage({ OAFACTORY_RELAY_IMAGE: '' })).toBe('node:26-slim');
  });
});
