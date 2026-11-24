import { run } from '../exec.js';
import { GitHubHost } from './github.js';
import { GitLabHost } from './gitlab.js';
import type { Host } from './types.js';

export * from './types.js';
export { FakeHost } from './fake.js';
export { GitHubHost, TEST_REPORT_ARTIFACT } from './github.js';
export { GitLabHost } from './gitlab.js';

/** Parse `owner/name` and the host kind from a git remote URL. */
export function parseRemote(url: string): { kind: 'github' | 'gitlab'; repo: string; hostname: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) return null;
  const hostname = m[1]!, repo = m[2]!;
  return { kind: hostname.includes('gitlab') ? 'gitlab' : 'github', repo, hostname };
}

export async function detectHost(cwd: string, opts: { repo?: string; kind?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Host> {
  let kind = opts.kind, repo = opts.repo, hostname: string | undefined;
  if (!repo) {
    const url = (await run('git', ['remote', 'get-url', 'origin'], { cwd })).trim();
    const parsed = parseRemote(url);
    if (!parsed) throw new Error(`could not read owner/name from the origin remote (${url}); pass --repo`);
    repo = parsed.repo; kind ??= parsed.kind; hostname = parsed.hostname;
  }
  return kind === 'gitlab' ? new GitLabHost(repo, { env: opts.env, hostname }) : new GitHubHost(repo, { env: opts.env });
}
