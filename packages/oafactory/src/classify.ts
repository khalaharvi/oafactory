import type { FactoryConfig } from './config.js';
import { firstMatch, matchesPattern, normalizePath } from './paths.js';
import type { ChangedFile, Tier } from './types.js';

export interface Classification {
  tier: Tier;
  because: string[];
  lines: number;
  files: number;
  /** Paths outside the work order's scope. Non-empty means the decision is `escalate`. */
  outOfScope: string[];
}

/**
 * Tier classification, spec section 4. Deterministic; uses no model and no input
 * other than the config, the list of changed files and the work order's scope.
 */
export function classify(config: FactoryConfig, files: readonly ChangedFile[], scopePaths?: readonly string[]): Classification {
  let tier: Tier = files.length === 0 ? config.tiers.default : 0;
  const because: string[] = [];
  const outOfScope = new Set<string>();
  if (files.length === 0) because.push(`no files changed; default tier ${config.tiers.default}`);

  const raise = (t: Tier, why: string) => {
    if (t > tier) { tier = t; because.length = 0; }
    if (t === tier) because.push(why);
  };

  for (const f of files) {
    // A rename counts under both paths.
    const entries: Array<{ path: string; onBase: boolean }> = [];
    if (f.status === 'renamed' && f.previousPath) entries.push({ path: normalizePath(f.previousPath), onBase: true });
    entries.push({ path: normalizePath(f.path), onBase: f.status === 'modified' || f.status === 'deleted' });

    for (const { path, onBase } of entries) {
      if (scopePaths && !firstMatch(scopePaths, path)) outOfScope.add(path);

      const prot = firstMatch(config.protected, path);
      if (prot) { raise(3, `${path} matched protected ${prot}`); continue; }

      const ao = firstMatch(config.append_only, path);
      if (ao && onBase) { raise(3, `${path} exists on the base branch under append-only ${ao}`); continue; }

      let best: { tier: Tier; pattern: string } | undefined;
      for (const rule of config.tiers.rules) {
        for (const pattern of rule.paths) {
          if (matchesPattern(pattern, path) && (!best || rule.tier > best.tier)) best = { tier: rule.tier, pattern };
        }
      }
      if (best) raise(best.tier, `${path} matched ${best.pattern}`);
      else raise(config.tiers.default, `${path} matched no rule; default tier ${config.tiers.default}`);
    }
  }

  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  const count = files.length;
  for (;;) {
    const lim = tier === 0 ? config.tiers.limits['0'] : tier === 1 ? config.tiers.limits['1'] : undefined;
    if (!lim) break;
    const over: string[] = [];
    if (lines > lim.max_lines) over.push(`${lines} lines > ${lim.max_lines}`);
    if (count > lim.max_files) over.push(`${count} files > ${lim.max_files}`);
    if (over.length === 0) break;
    because.push(`exceeds tier ${tier} limits (${over.join(', ')}); raised to tier ${tier + 1}`);
    tier = (tier + 1) as Tier;
  }

  return { tier, because, lines, files: count, outOfScope: [...outOfScope].sort() };
}
