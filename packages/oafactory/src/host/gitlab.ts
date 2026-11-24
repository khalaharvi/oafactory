import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, run } from '../exec.js';
import type { ChangedFile, TestReport } from '../types.js';
import type { Change, CheckState, CommitInfo, Host, Issue, MergeResult } from './types.js';

/**
 * GitLab through the `glab` CLI, using `glab api` for every read so that the
 * calls map one-to-one onto documented REST endpoints.
 *
 * STATUS: written against the GitLab REST API documentation and not yet run
 * against a live GitLab instance. Treat it as unverified.
 */
export class GitLabHost implements Host {
  readonly kind = 'gitlab' as const;
  private id: string;
  constructor(readonly repo: string, private opts: { env?: NodeJS.ProcessEnv; hostname?: string } = {}) {
    this.id = encodeURIComponent(repo);
  }
  private get hostname() { return this.opts.hostname ?? 'gitlab.com'; }
  subjectName() { return `git+https://${this.hostname}/${this.repo}`; }
  cloneUrl() { return `https://${this.hostname}/${this.repo}.git`; }

  private async api<T>(path: string, extra: string[] = []): Promise<T> {
    return JSON.parse(await run('glab', ['api', path, ...extra], { env: this.opts.env })) as T;
  }
  private async pages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const rows = await this.api<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  }

  async defaultBranch(): Promise<string> {
    return (await this.api<{ default_branch: string }>(`projects/${this.id}`)).default_branch;
  }

  async getIssue(number: number): Promise<Issue> {
    const i = await this.api<{ title: string; description: string | null; author: { username: string; id: number }; labels: string[] }>(`projects/${this.id}/issues/${number}`);
    const events = await this.pages<{ action: string; label: { name: string } | null; user: { id: number; username: string } }>(`projects/${this.id}/issues/${number}/resource_label_events`);
    const labels: Issue['labels'] = [];
    for (const name of i.labels) {
      const ev = events.filter((e) => e.action === 'add' && e.label?.name === name).at(-1);
      let maintainer = false;
      if (ev) {
        try {
          const m = await this.api<{ access_level: number }>(`projects/${this.id}/members/all/${ev.user.id}`);
          maintainer = m.access_level >= 40; // Maintainer or Owner
        } catch { maintainer = false; }
      }
      labels.push({ name, appliedBy: ev?.user.username, appliedByMaintainer: maintainer });
    }
    return { number, title: i.title, body: i.description ?? '', author: i.author.username, labels };
  }

  async getChange(number: number): Promise<Change> {
    const m = await this.api<{
      state: string; title: string; description: string | null; author: { username: string };
      sha: string; source_branch: string; target_branch: string; diff_refs: { base_sha: string } | null;
      merge_commit_sha: string | null; squash_commit_sha: string | null; merged_at: string | null; merged_by: { username: string } | null;
    }>(`projects/${this.id}/merge_requests/${number}`);
    return {
      number, state: m.state === 'merged' ? 'merged' : m.state === 'opened' ? 'open' : 'closed',
      headSha: m.sha, headRef: m.source_branch, baseSha: m.diff_refs?.base_sha ?? '', baseRef: m.target_branch,
      title: m.title, body: m.description ?? '', author: m.author.username,
      ...(m.state === 'merged' ? { mergeSha: m.merge_commit_sha ?? m.squash_commit_sha ?? undefined, mergedAt: m.merged_at ?? undefined, mergedBy: m.merged_by?.username } : {}),
    };
  }

  async listFiles(number: number): Promise<ChangedFile[]> {
    const diffs = await this.pages<{ old_path: string; new_path: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean; diff: string }>(`projects/${this.id}/merge_requests/${number}/diffs`);
    return diffs.map((d) => {
      let additions = 0, deletions = 0;
      for (const line of d.diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
      }
      const status: ChangedFile['status'] = d.new_file ? 'added' : d.deleted_file ? 'deleted' : d.renamed_file ? 'renamed' : 'modified';
      return { path: d.new_path, status, additions, deletions, ...(status === 'renamed' ? { previousPath: d.old_path } : {}) };
    });
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    const r = await exec('glab', ['api', `projects/${this.id}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`], { env: this.opts.env });
    if (r.code === 0) return r.stdout;
    if (/404/.test(r.stderr + r.stdout)) return null;
    throw new Error(`could not read ${path} at ${ref}: ${r.stderr.trim()}`);
  }

  private async jobs(sha: string) {
    const pipelines = await this.api<Array<{ id: number }>>(`projects/${this.id}/pipelines?sha=${sha}`);
    const jobs: Array<{ id: number; name: string; status: string; pipeline: number }> = [];
    for (const p of pipelines) {
      for (const j of await this.pages<{ id: number; name: string; status: string }>(`projects/${this.id}/pipelines/${p.id}/jobs?include_retried=true`)) jobs.push({ ...j, pipeline: p.id });
    }
    return { pipelines, jobs };
  }

  async listChecks(sha: string): Promise<CheckState[]> {
    const { jobs } = await this.jobs(sha);
    const byName = new Map<string, typeof jobs>();
    for (const j of jobs) byName.set(j.name, [...(byName.get(j.name) ?? []), j]);
    const concl = (s: string): CheckState['conclusion'] => (s === 'success' ? 'success' : ['failed', 'canceled'].includes(s) ? 'failure' : 'pending');
    return [...byName].map(([name, list]) => {
      list.sort((a, b) => a.id - b.id);
      const last = list.at(-1)!;
      return { name, conclusion: concl(last.status), attempts: list.length, failedBefore: list.slice(0, -1).some((j) => concl(j.status) === 'failure'), ref: String(last.id) };
    });
  }

  async rerunCheck(_sha: string, check: CheckState): Promise<void> {
    await run('glab', ['api', '-X', 'POST', `projects/${this.id}/jobs/${check.ref}/retry`], { env: this.opts.env });
  }

  async getTestReport(sha: string): Promise<TestReport | null> {
    const { pipelines } = await this.jobs(sha);
    const latest = pipelines.sort((a, b) => b.id - a.id)[0];
    if (!latest) return null;
    const rep = await this.api<{ total_count: number; test_suites: Array<{ name: string; test_cases: Array<{ name: string; classname: string; status: string }> }> }>(`projects/${this.id}/pipelines/${latest.id}/test_report`);
    if (!rep.total_count) return null;
    return { tests: rep.test_suites.flatMap((s) => s.test_cases.map((t) => ({ id: `${t.classname}::${t.name}`, skipped: t.status === 'skipped' }))) };
  }

  async comment(number: number, body: string): Promise<void> {
    await run('glab', ['api', '-X', 'POST', `projects/${this.id}/merge_requests/${number}/notes`, '-f', `body=${body}`], { env: this.opts.env });
  }

  async openChange(input: { head: string; base: string; title: string; body: string }): Promise<number> {
    const m = await this.api<{ iid: number }>(`projects/${this.id}/merge_requests`, ['-X', 'POST', '-f', `source_branch=${input.head}`, '-f', `target_branch=${input.base}`, '-f', `title=${input.title}`, '-f', `description=${input.body}`]);
    return m.iid;
  }

  async merge(number: number, sha: string): Promise<MergeResult> {
    // The `sha` parameter makes GitLab refuse the merge unless the head still matches.
    const r = await exec('glab', ['api', '-X', 'PUT', `projects/${this.id}/merge_requests/${number}/merge`, '-f', `sha=${sha}`, '-f', 'squash=true'], { env: this.opts.env });
    if (r.code !== 0) return { merged: false, reason: r.stderr.trim() || r.stdout.trim() };
    const c = await this.getChange(number);
    return c.state === 'merged' ? { merged: true, sha: c.mergeSha } : { merged: false, reason: 'merge accepted but not completed' };
  }

  private async tree(sha: string): Promise<string> {
    // GitLab's commit API does not expose the tree id, so hash the recursive tree listing.
    const entries = await this.pages<{ id: string; path: string; mode: string }>(`projects/${this.id}/repository/tree?ref=${sha}&recursive=true`);
    const { createHash } = await import('node:crypto');
    return createHash('sha1').update(entries.map((e) => `${e.mode} ${e.id} ${e.path}`).sort().join('\n')).digest('hex');
  }

  async getCommit(sha: string): Promise<CommitInfo> {
    const c = await this.api<{ id: string; message: string; parent_ids: string[]; committed_date: string }>(`projects/${this.id}/repository/commits/${sha}`);
    return { sha: c.id, message: c.message, treeSha: await this.tree(c.id), parents: c.parent_ids, date: c.committed_date };
  }

  async commitsAfter(branch: string, sha: string): Promise<CommitInfo[]> {
    const cmp = await this.api<{ commits: Array<{ id: string; message: string; parent_ids: string[]; committed_date: string }> }>(`projects/${this.id}/repository/compare?from=${sha}&to=${encodeURIComponent(branch)}`);
    return cmp.commits.map((c) => ({ sha: c.id, message: c.message, treeSha: '', parents: c.parent_ids, date: c.committed_date }));
  }

  async openRevert(mergeSha: string, title: string, body: string): Promise<number> {
    const dir = await mkdtemp(join(tmpdir(), 'oafactory-revert-'));
    const branch = `oafactory/revert-${mergeSha.slice(0, 12)}`;
    try {
      await run('glab', ['repo', 'clone', this.repo, dir], { env: this.opts.env });
      const base = await this.defaultBranch();
      const git = (args: string[]) => run('git', ['-c', 'user.name=oafactory-watcher', '-c', 'user.email=watcher@oafactory.invalid', ...args], { cwd: dir, env: this.opts.env });
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
