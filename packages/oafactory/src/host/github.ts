import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, run } from '../exec.js';
import { mergeReports, parseJUnit } from '../junit.js';
import type { ChangedFile, TestReport } from '../types.js';
import type { Change, CheckState, CommitInfo, Host, Issue, MergeResult } from './types.js';

/** Name of the CI artifact that carries JUnit XML for `test_integrity`. */
export const TEST_REPORT_ARTIFACT = 'oafactory-test-report';

async function findXml(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await findXml(p));
    else if (e.name.endsWith('.xml')) out.push(p);
  }
  return out;
}

/**
 * GitHub through the `gh` CLI. Each role (Harness, Gate, Watcher) runs this
 * with its own token in GH_TOKEN; the class never stores a credential.
 */
export class GitHubHost implements Host {
  readonly kind = 'github' as const;
  constructor(readonly repo: string, private opts: { env?: NodeJS.ProcessEnv; mergeMethod?: 'squash' | 'merge' | 'rebase' } = {}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`expected owner/name, got ${repo}`);
  }
  subjectName() { return `git+https://github.com/${this.repo}`; }
  cloneUrl() { return `https://github.com/${this.repo}.git`; }

  private gh(args: string[], input?: string) { return run('gh', args, { env: this.opts.env, input }); }
  private async api<T>(path: string, extra: string[] = []): Promise<T> {
    return JSON.parse(await this.gh(['api', path, ...extra])) as T;
  }
  /** Paginated list; `jq` must emit one JSON value per line. */
  private async list<T>(path: string, jq: string): Promise<T[]> {
    const out = await this.gh(['api', '--paginate', path, '--jq', jq]);
    return out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
  }

  async defaultBranch(): Promise<string> {
    return (await this.api<{ default_branch: string }>(`repos/${this.repo}`)).default_branch;
  }

  async getIssue(number: number): Promise<Issue> {
    const i = await this.api<{ title: string; body: string | null; user: { login: string }; labels: Array<{ name: string }> }>(`repos/${this.repo}/issues/${number}`);
    const events = await this.list<{ event: string; label?: string; actor?: string }>(
      `repos/${this.repo}/issues/${number}/events?per_page=100`, '.[] | select(.event == "labeled") | {event, label: .label.name, actor: .actor.login}');
    const perms = new Map<string, boolean>();
    const labels: Issue['labels'] = [];
    for (const l of i.labels) {
      const actor = events.filter((e) => e.label === l.name).at(-1)?.actor;
      let maintainer = false;
      if (actor) {
        if (!perms.has(actor)) {
          try {
            const p = await this.api<{ permission: string }>(`repos/${this.repo}/collaborators/${actor}/permission`);
            perms.set(actor, p.permission === 'admin' || p.permission === 'write');
          } catch { perms.set(actor, false); }
        }
        maintainer = perms.get(actor)!;
      }
      labels.push({ name: l.name, appliedBy: actor, appliedByMaintainer: maintainer });
    }
    return { number, title: i.title, body: i.body ?? '', author: i.user.login, labels };
  }

  async getChange(number: number): Promise<Change> {
    const p = await this.api<{
      state: string; merged: boolean; title: string; body: string | null; user: { login: string };
      head: { sha: string; ref: string }; base: { sha: string; ref: string };
      merge_commit_sha: string | null; merged_at: string | null; merged_by: { login: string } | null;
    }>(`repos/${this.repo}/pulls/${number}`);
    return {
      number, state: p.merged ? 'merged' : p.state === 'open' ? 'open' : 'closed',
      headSha: p.head.sha, headRef: p.head.ref, baseSha: p.base.sha, baseRef: p.base.ref,
      title: p.title, body: p.body ?? '', author: p.user.login,
      ...(p.merged ? { mergeSha: p.merge_commit_sha ?? undefined, mergedAt: p.merged_at ?? undefined, mergedBy: p.merged_by?.login } : {}),
    };
  }

  async listFiles(number: number): Promise<ChangedFile[]> {
    const rows = await this.list<{ filename: string; status: string; additions: number; deletions: number; previous_filename?: string }>(
      `repos/${this.repo}/pulls/${number}/files?per_page=100`, '.[] | {filename, status, additions, deletions, previous_filename}');
    const map: Record<string, ChangedFile['status']> = { added: 'added', copied: 'added', removed: 'deleted', renamed: 'renamed', modified: 'modified', changed: 'modified' };
    return rows.filter((r) => r.status !== 'unchanged').map((r) => ({
      path: r.filename, status: map[r.status] ?? 'modified', additions: r.additions, deletions: r.deletions,
      ...(r.status === 'renamed' && r.previous_filename ? { previousPath: r.previous_filename } : {}),
    }));
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    const enc = path.split('/').map(encodeURIComponent).join('/');
    const r = await exec('gh', ['api', `repos/${this.repo}/contents/${enc}?ref=${encodeURIComponent(ref)}`, '-H', 'Accept: application/vnd.github.raw+json'], { env: this.opts.env });
    if (r.code === 0) return r.stdout;
    if (/404|Not Found/.test(r.stderr + r.stdout)) return null;
    throw new Error(`could not read ${path} at ${ref}: ${r.stderr.trim()}`);
  }

  async listChecks(sha: string): Promise<CheckState[]> {
    const runs = await this.list<{ id: number; name: string; status: string; conclusion: string | null; started_at: string | null }>(
      `repos/${this.repo}/commits/${sha}/check-runs?filter=all&per_page=100`, '.check_runs[] | {id, name, status, conclusion, started_at}');
    const byName = new Map<string, typeof runs>();
    for (const r of runs) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
    const out: CheckState[] = [];
    for (const [name, list] of byName) {
      list.sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? '') || a.id - b.id);
      const last = list.at(-1)!;
      const concl = (r: (typeof list)[number]): CheckState['conclusion'] =>
        r.status !== 'completed' ? 'pending' : r.conclusion === 'success' ? 'success' : 'failure';
      out.push({ name, conclusion: concl(last), attempts: list.length, failedBefore: list.slice(0, -1).some((r) => concl(r) === 'failure'), ref: String(last.id) });
    }
    return out;
  }

  async rerunCheck(_sha: string, check: CheckState): Promise<void> {
    // For GitHub Actions the check run id is the job id.
    await this.gh(['api', '-X', 'POST', `repos/${this.repo}/actions/jobs/${check.ref}/rerun`]);
  }

  async getTestReport(sha: string): Promise<TestReport | null> {
    const arts = await this.list<{ id: number; expired: boolean; created_at: string; run_id: number; head_sha: string }>(
      `repos/${this.repo}/actions/artifacts?name=${TEST_REPORT_ARTIFACT}&per_page=100`,
      '.artifacts[] | {id, expired, created_at, run_id: .workflow_run.id, head_sha: .workflow_run.head_sha}');
    const match = arts.filter((a) => a.head_sha === sha && !a.expired).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!match) return null;
    const dir = await mkdtemp(join(tmpdir(), 'oafactory-report-'));
    try {
      await this.gh(['run', 'download', String(match.run_id), '-R', this.repo, '-n', TEST_REPORT_ARTIFACT, '-D', dir]);
      const files = await findXml(dir);
      if (files.length === 0) return null;
      return mergeReports(await Promise.all(files.map(async (f) => parseJUnit(await readFile(f, 'utf8')))));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Writes go through the REST API rather than `gh pr ...`, which needs GraphQL.
  // REST works with fine-grained tokens and in environments where GraphQL is not reachable.
  /** Change and issue numbers are interpolated into API paths, so insist they are plain positive integers. */
  private id(n: number): number {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`expected a positive integer, got ${String(n)}`);
    return n;
  }

  private post<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
    return this.gh(['api', '-X', method, path, '--input', '-'], JSON.stringify(body)).then((out) => JSON.parse(out) as T);
  }

  async comment(number: number, body: string): Promise<void> {
    await this.post('POST', `repos/${this.repo}/issues/${this.id(number)}/comments`, { body });
  }

  async openChange(input: { head: string; base: string; title: string; body: string }): Promise<number> {
    const pr = await this.post<{ number: number }>('POST', `repos/${this.repo}/pulls`, input);
    return pr.number;
  }

  async merge(number: number, sha: string): Promise<MergeResult> {
    // `sha` makes GitHub refuse the merge unless the head is still the commit that was evaluated.
    const r = await exec('gh', ['api', '-X', 'PUT', `repos/${this.repo}/pulls/${this.id(number)}/merge`, '--input', '-'],
      { env: this.opts.env, input: JSON.stringify({ sha, merge_method: this.opts.mergeMethod ?? 'squash' }) });
    if (r.code !== 0) {
      let reason = r.stderr.trim() || r.stdout.trim();
      try { reason = (JSON.parse(r.stdout) as { message?: string }).message ?? reason; } catch { /* not JSON */ }
      return { merged: false, reason };
    }
    const res = JSON.parse(r.stdout) as { merged?: boolean; sha?: string; message?: string };
    return res.merged ? { merged: true, sha: res.sha } : { merged: false, reason: res.message ?? 'the host did not merge the change' };
  }

  async getCommit(sha: string): Promise<CommitInfo> {
    const c = await this.api<{ sha: string; commit: { message: string; tree: { sha: string }; committer: { date: string } }; parents: Array<{ sha: string }> }>(`repos/${this.repo}/commits/${sha}`);
    return { sha: c.sha, message: c.commit.message, treeSha: c.commit.tree.sha, parents: c.parents.map((p) => p.sha), date: c.commit.committer.date };
  }

  async commitsAfter(branch: string, sha: string): Promise<CommitInfo[]> {
    const cmp = await this.api<{ commits: Array<{ sha: string; commit: { message: string; tree: { sha: string }; committer: { date: string } }; parents: Array<{ sha: string }> }> }>(
      `repos/${this.repo}/compare/${sha}...${encodeURIComponent(branch)}?per_page=250`);
    return cmp.commits.map((c) => ({ sha: c.sha, message: c.commit.message, treeSha: c.commit.tree.sha, parents: c.parents.map((p) => p.sha), date: c.commit.committer.date }));
  }

  async openRevert(mergeSha: string, title: string, body: string): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), 'oafactory-revert-'));
    const branch = `oafactory/revert-${mergeSha.slice(0, 12)}`;
    const env = this.opts.env;
    try {
      await this.gh(['repo', 'clone', this.repo, dir, '--', '--quiet']);
      const base = await this.defaultBranch();
      const git = (args: string[]) => run('git', ['-c', 'user.name=oafactory-watcher', '-c', 'user.email=watcher@oafactory.invalid', ...args], { cwd: dir, env });
      await git(['checkout', '-q', '-b', branch, `origin/${base}`]);
      const parents = (await git(['rev-list', '--parents', '-n', '1', mergeSha])).trim().split(' ').length - 1;
      await git(['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), mergeSha]);
      await git(['push', '-q', 'origin', branch]);
      return await this.openChange({ head: branch, base, title, body });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
