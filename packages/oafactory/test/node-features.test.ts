import { describe, expect, it } from 'vitest';
import { parseFactoryConfig } from '../src/config.js';
import { nodeFlags, runnerCommand } from '../src/harness.js';
import { DockerSandbox, LocalSandbox } from '../src/sandbox.js';
import { CONFIG } from './helpers.js';

const builtin = parseFactoryConfig(CONFIG.replace('runner:   { use: mini-swe-agent,', 'runner:   { use: builtin,'));

describe('Node features used when the Sandbox has them', () => {
  it('runs the built-in Runner under the permission model from Node 26', () => {
    const flags = nodeFlags('26.13.1\n', '/work', '/opt/oafactory');
    expect(flags).toBe("--permission --allow-child-process --allow-net '--allow-fs-read=/work' '--allow-fs-read=/opt/oafactory' '--allow-fs-write=/work'");
    expect(nodeFlags('v27.0.0', '/w', '/t')).toContain('--permission');
    expect(runnerCommand(builtin, flags)).toBe(`node ${flags} "$OAFACTORY_AGENT"`);
  });

  it('adds nothing on older Node, or when the version cannot be read', () => {
    for (const v of ['22.23.5', '24.11.0', '25.9.0', '', 'not a version']) expect(nodeFlags(v, '/work', '/opt/oafactory')).toBe('');
    expect(runnerCommand(builtin)).toBe('node "$OAFACTORY_AGENT"');
    expect(runnerCommand(builtin, '')).toBe('node "$OAFACTORY_AGENT"');
  });

  it('quotes paths so a space or a quote cannot split or escape the flag', () => {
    const flags = nodeFlags('26.0.0', "/tmp/my work's dir", '/opt/tools');
    expect(flags).toContain(`'--allow-fs-read=/tmp/my work'\\''s dir'`);
    expect(flags).toContain(`'--allow-fs-write=/tmp/my work'\\''s dir'`);
  });

  it('never writes outside the project: only the work directory is writable', () => {
    const flags = nodeFlags('26.0.0', '/work', '/opt/oafactory');
    expect(flags.match(/--allow-fs-write=/g)!.length).toBe(1);
    expect(flags).not.toContain('--allow-fs-write=/opt/oafactory');
    expect(flags).not.toMatch(/--allow-fs-(read|write)=\*/);
  });

  it('knows the working directory as the Worker sees it', () => {
    expect(new LocalSandbox().workPath('/tmp/x')).toBe('/tmp/x');
    expect(new DockerSandbox({ image: 'node:26-slim', network: 'n' }).workPath()).toBe('/work');
  });
});
