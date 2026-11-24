import { describe, expect, it } from 'vitest';
import { shellLine } from '../src/agent.js';

describe("built-in Runner under Node's permission model", () => {
  it('drops the inherited restrictions for the commands it runs, and only then', () => {
    // Found by running npm inside a Node 26 container: Node re-adds its permission flags to every
    // child through NODE_OPTIONS, so a Node program started by the agent could not read its own files.
    expect(shellLine('npm test', true)).toBe('unset NODE_OPTIONS; npm test');
    expect(shellLine('npm test', false)).toBe('npm test');
  });

  it('keeps the command intact, whatever it contains', () => {
    const tricky = `echo "a; b" && node -e 'console.log(1)' | cat`;
    expect(shellLine(tricky, true)).toBe(`unset NODE_OPTIONS; ${tricky}`);
  });
});
