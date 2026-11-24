/**
 * Path patterns (spec section 3): an entry ending in `/` covers a directory;
 * any other entry is a glob in which `*` crosses directory separators.
 * A leading `/` is ignored.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

const cache = new Map<string, RegExp>();

export function matchesPattern(pattern: string, path: string): boolean {
  const pat = normalizePath(pattern);
  const p = normalizePath(path);
  if (pat === '') return false;
  if (pat.endsWith('/')) return p.startsWith(pat);
  let re = cache.get(pat);
  if (!re) {
    const body = pat.split(/\*+/).map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    re = new RegExp(`^${body}$`);
    cache.set(pat, re);
  }
  return re.test(p);
}

/** Returns the first pattern that matches, or undefined. */
export function firstMatch(patterns: readonly string[], path: string): string | undefined {
  return patterns.find((pat) => matchesPattern(pat, path));
}
