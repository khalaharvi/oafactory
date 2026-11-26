import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { firstMatch } from './paths.js';

/** Files an agent loads as instructions. `*` crosses directories, so nested copies match too. */
export const INSTRUCTION_PATTERNS = [
  '*AGENTS.md', '*AGENTS.override.md', '*CLAUDE.md', '*CLAUDE.local.md', '*GEMINI.md', '*.cursorrules', '*.cursor/rules/*', '*.windsurfrules',
  '*.clinerules*', '*.github/copilot-instructions.md', '*.github/instructions/*', '*.claude/*', '*.codex/*', '*.pi/*', '*.aider.conf.yml', '*CONVENTIONS.md',
  // MCP server lists tell an agent which programs to start, so they are instructions too.
  '*.mcp.json', '*.cursor/mcp.json', '*.vscode/mcp.json',
];

export function isInstructionFile(path: string): boolean {
  return firstMatch(INSTRUCTION_PATTERNS, path) !== undefined;
}

export async function walk(root: string, skip: (rel: string) => boolean = (r) => r === '.git' || r.startsWith('.git/')): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split('\\').join('/');
      if (skip(rel) || e.name === 'node_modules') continue;
      if (e.isDirectory()) await visit(abs);
      else out.push(rel);
    }
  };
  await visit(root);
  return out.sort();
}

/**
 * Make a checkout safe for an agent to load: every instruction file comes from
 * the base branch. Instruction files the change added are removed, and ones it
 * modified or deleted are restored from the base checkout.
 */
export async function useBaseInstructions(checkout: string, baseCheckout: string): Promise<{ removed: string[]; restored: string[] }> {
  const removed: string[] = [];
  const restored: string[] = [];
  for (const rel of (await walk(checkout)).filter(isInstructionFile)) { await rm(join(checkout, rel), { force: true }); removed.push(rel); }
  for (const rel of (await walk(baseCheckout)).filter(isInstructionFile)) {
    await mkdir(dirname(join(checkout, rel)), { recursive: true });
    await cp(join(baseCheckout, rel), join(checkout, rel));
    restored.push(rel);
  }
  return { removed: removed.filter((r) => !restored.includes(r)), restored };
}
