import { describe, expect, it } from 'vitest';
import { parseFactoryConfig } from '../src/config.js';
import { nodeOptions, runnerCommand } from '../src/harness.js';
import { DockerSandbox, LocalSandbox } from '../src/sandbox.js';
import { CONFIG } from './helpers.js';

const builtin = parseFactoryConfig(CONFIG.replace('runner:   { use: mini-swe-agent,', 'runner:   { use: builtin,'));

describe('Node features used when the Sandbox has them', () => {
  it('runs the built-in Runner under the permission model from Node 26', () => {
    expect(nodeOptions('26.13.1\n', '/work', '/opt/oafactory'))
      .toBe('--permission --allow-child-process --allow-net "--allow-fs-read=/work" "--allow-fs-read=/opt/oafactory" "--allow-fs-write=/work"');
    expect(nodeOptions('v27.0.0', '/w', '/t')).toContain('--permission');
  });

  it('adds nothing on older Node, or when the version cannot be read', () => {
    for (const v of ['22.23.5', '24.11.0', '25.9.0', '', 'not a version']) expect(nodeOptions(v, '/work', '/opt/oafactory')).toBe('');
  });

  it('the command is a constant: the flags travel in the environment, not in a command line', () => {
    expect(runnerCommand(builtin)).toBe('node "$OAFACTORY_AGENT"');
  });

  it('keeps a path with a space in one flag, and gives up on a path it cannot quote safely', () => {
    expect(nodeOptions('26.0.0', '/tmp/my work', '/opt/tools')).toContain('"--allow-fs-read=/tmp/my work"');
    expect(nodeOptions('26.0.0', '/tmp/a"b', '/opt/tools')).toBe('');
    expect(nodeOptions('26.0.0', '/tmp/ok', 'C:\\tools')).toBe('');
  });

  it('never allows writing outside the project', () => {
    const options = nodeOptions('26.0.0', '/work', '/opt/oafactory');
    expect(options.match(/--allow-fs-write=/g)!.length).toBe(1);
    expect(options).not.toContain('--allow-fs-write=/opt/oafactory');
    expect(options).not.toMatch(/--allow-fs-(read|write)=\*/);
  });

  it('knows the working directory as the Worker sees it', () => {
    expect(new LocalSandbox().workPath('/tmp/x')).toBe('/tmp/x');
    expect(new DockerSandbox({ image: 'node:26-slim', network: 'n' }).workPath()).toBe('/work');
  });
});
