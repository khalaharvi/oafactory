import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { shellArgs } from '../src/agent.js';

describe("built-in Runner under Node's permission model", () => {
  it('drops the inherited restrictions for the commands it runs, and only then', () => {
    // Found by running npm inside a Node 26 container: Node re-adds its permission flags to every
    // child through NODE_OPTIONS, so a Node program started by the agent could not read its own files.
    expect(shellArgs('npm test', true)).toEqual(['-c', 'unset NODE_OPTIONS; exec sh -c "$1"', 'sh', 'npm test']);
    expect(shellArgs('npm test', false)).toEqual(['-c', 'npm test']);
  });

  it('hands the command over as an argument, never spliced into the wrapper', () => {
    const tricky = `echo "a; b" && printf '%s' "$NODE_OPTIONS" | cat`;
    const args = shellArgs(tricky, true);
    expect(args[1]).not.toContain(tricky);
    expect(args.at(-1)).toBe(tricky);
    // And it really runs: the wrapper clears NODE_OPTIONS before the command sees it.
    const out = execFileSync('sh', args, { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=64' } }).toString();
    expect(out).toBe('a; b\n');
    expect(execFileSync('sh', shellArgs('printf "%s" "$NODE_OPTIONS"', false), { env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=64' } }).toString()).toBe('--max-old-space-size=64');
  });
});
