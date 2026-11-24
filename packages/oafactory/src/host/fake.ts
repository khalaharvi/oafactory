import { createHash } from 'node:crypto';
import type { ChangedFile, TestReport } from '../types.js';
import type { Change, CheckState, CommitInfo, Host, Issue, MergeResult } from './types.js';

type Files = Map<string, string>;
interface Commit { sha: string; files: Files; parents: string[]; message: string; date: string }
interface FakeChange extends Change { stats?: ChangedFile[] }

const lines = (s: string) => (s === '' ? 0 : s.split('\n').length);

/** An in-memory Git host. Used by the test suite, the conformance suite and `oafactory demo`. */
export class FakeHost implements Host {
  readonly kind = 'fake' as const;
  readonly repo: string;
  private commits = new Map<string, Commit>();
  private branches = new Map<string, string>();
  private changes = new Map<number, FakeChange>();
  private checks = new Map<string, CheckState[]>();
  private reports = new Map<string, TestReport>();
  private issues = new Map<number, Issue>();
  private seq = 0;
  private next = 1;
  clock = Date.parse('2026-01-01T00:00:00Z');
  comments: Array<{ number: number; body: string }> = [];
  reruns: Array<{ sha: string; name: string }> = [];
  /** Called when a check is rerun; return the new conclusion. Defaults to `success`. */
  onRerun: (sha: string, name: string) => 'success' | 'failure' | 'pending' = () => 'success';

  constructor(repo = 'acme/widgets', initial: Record<string, string> = {}) {
    this.repo = repo;
    this.branches.set('main', this.write(new Map(Object.entries(initial)), [], 'initial commit'));
  }

  subjectName() { return `git+https://fake.invalid/${this.repo}`; }
  cloneUrl() { return `https://fake.invalid/${this.repo}.git`; }
  async defaultBranch() { return 'main'; }

  private write(files: Files, parents: string[], message: string): string {
    this.clock += 60_000;
    const sha = createHash('sha1').update(`${this.seq++}:${message}`).digest('hex');
    this.commits.set(sha, { sha, files, parents, message, date: new Date(this.clock).toISOString() });
    return sha;
  }
  private commit(sha: string): Commit {
    const c = this.commits.get(sha);
    if (!c) throw new Error(`unknown commit ${sha}`);
    return c;
  }
  private resolve(ref: string): string {
    return this.branches.get(ref) ?? ref;
  }
  head(branch: string): string { return this.resolve(branch); }
  listPaths(ref: string): string[] { return [...this.commit(this.resolve(ref)).files.keys()].sort(); }

  /** Apply edits on a branch (created from `main` if new). `null` deletes a file. */
  push(branch: string, edits: Record<string, string | null>, message = 'edit'): string {
    const parent = this.branches.get(branch) ?? this.branches.get('main')!;
    const files = new Map(this.commit(parent).files);
    for (const [p, v] of Object.entries(edits)) { if (v === null) files.delete(p); else files.set(p, v); }
    const sha = this.write(files, [parent], message);
    this.branches.set(branch, sha);
    for (const c of this.changes.values()) if (c.state === 'open' && c.headRef === branch) c.headSha = sha;
    return sha;
  }

  /** Open a change from edits in one step. */
  propose(edits: Record<string, string | null>, opts: { title?: string; body?: string; branch?: string; author?: string } = {}): Change {
    const branch = opts.branch ?? `oafactory/change-${this.next}`;
    this.push(branch, edits, opts.title ?? 'change');
    const n = this.createChange(branch, 'main', opts.title ?? 'change', opts.body ?? '', opts.author ?? 'oafactory-harness');
    return { ...this.changes.get(n)! };
  }

  private createChange(head: string, base: string, title: string, body: string, author: string): number {
    const number = this.next++;
    this.changes.set(number, {
      number, state: 'open', headSha: this.resolve(head), baseSha: this.resolve(base), baseRef: base, headRef: head, title, body, author,
    });
    return number;
  }

  setCheck(sha: string, name: string, conclusion: CheckState['conclusion']) {
    const list = this.checks.get(sha) ?? [];
    const cur = list.find((c) => c.name === name);
    if (cur) {
      cur.failedBefore = cur.failedBefore || cur.conclusion === 'failure';
      cur.attempts += 1;
      cur.conclusion = conclusion;
    } else list.push({ name, conclusion, attempts: 1, failedBefore: false, ref: name });
    this.checks.set(sha, list);
  }
  passAll(sha: string, names: string[]) { for (const n of names) this.setCheck(sha, n, 'success'); }
  setReport(sha: string, report: TestReport) { this.reports.set(sha, report); }
  setIssue(issue: Issue) { this.issues.set(issue.number, issue); }
  /** A person closes a change without merging. */
  close(number: number) { this.change(number).state = 'closed'; }
  /** A person merges a change at whatever its head is. */
  humanMerge(number: number, by = 'maintainer'): string {
    const c = this.change(number);
    const res = this.doMerge(c, by);
    return res;
  }
  advance(hours: number) { this.clock += hours * 3_600_000; }
  now(): Date { return new Date(this.clock); }

  private change(n: number): FakeChange {
    const c = this.changes.get(n);
    if (!c) throw new Error(`unknown change ${n}`);
    return c;
  }
  private doMerge(c: FakeChange, by: string): string {
    const base = this.commit(c.baseSha).files;
    const head = this.commit(c.headSha).files;
    const tipSha = this.branches.get(c.baseRef)!;
    const files = new Map(this.commit(tipSha).files);
    for (const p of new Set([...base.keys(), ...head.keys()])) {
      if (base.get(p) === head.get(p)) continue;
      if (head.has(p)) files.set(p, head.get(p)!); else files.delete(p);
    }
    const sha = this.write(files, [tipSha], `${c.title} (#${c.number})`);
    this.branches.set(c.baseRef, sha);
    Object.assign(c, { state: 'merged', mergeSha: sha, mergedAt: new Date(this.clock).toISOString(), mergedBy: by });
    return sha;
  }

  async getIssue(number: number): Promise<Issue> {
    const i = this.issues.get(number);
    if (!i) throw new Error(`unknown issue ${number}`);
    return i;
  }
  async getChange(number: number): Promise<Change> { return { ...this.change(number) }; }

  async listFiles(number: number): Promise<ChangedFile[]> {
    const c = this.change(number);
    const base = this.commit(c.baseSha).files;
    const head = this.commit(c.headSha).files;
    const out: ChangedFile[] = [];
    const removed = [...base.keys()].filter((p) => !head.has(p));
    const added = [...head.keys()].filter((p) => !base.has(p));
    const renamedFrom = new Set<string>();
    for (const p of added) {
      const from = removed.find((r) => !renamedFrom.has(r) && base.get(r) === head.get(p));
      if (from) { renamedFrom.add(from); out.push({ path: p, status: 'renamed', previousPath: from, additions: 0, deletions: 0 }); }
      else out.push({ path: p, status: 'added', additions: lines(head.get(p)!), deletions: 0 });
    }
    for (const p of removed) if (!renamedFrom.has(p)) out.push({ path: p, status: 'deleted', additions: 0, deletions: lines(base.get(p)!) });
    for (const [p, v] of head) {
      if (!base.has(p) || base.get(p) === v) continue;
      const a = v.split('\n'), b = base.get(p)!.split('\n');
      const bs = new Set(b), as = new Set(a);
      out.push({ path: p, status: 'modified', additions: a.filter((l) => !bs.has(l)).length, deletions: b.filter((l) => !as.has(l)).length });
    }
    return out.sort((x, y) => x.path.localeCompare(y.path));
  }

  async readFile(path: string, ref: string): Promise<string | null> {
    return this.commit(this.resolve(ref)).files.get(path) ?? null;
  }
  async listChecks(sha: string): Promise<CheckState[]> { return (this.checks.get(sha) ?? []).map((c) => ({ ...c })); }
  async rerunCheck(sha: string, check: CheckState): Promise<void> {
    this.reruns.push({ sha, name: check.name });
    this.setCheck(sha, check.name, this.onRerun(sha, check.name));
  }
  async getTestReport(sha: string): Promise<TestReport | null> { return this.reports.get(sha) ?? null; }
  async comment(number: number, body: string): Promise<void> { this.comments.push({ number, body }); }
  async openChange(input: { head: string; base: string; title: string; body: string }): Promise<number> {
    return this.createChange(input.head, input.base, input.title, input.body, 'oafactory-harness');
  }
  async merge(number: number, sha: string): Promise<MergeResult> {
    const c = this.change(number);
    if (c.state !== 'open') return { merged: false, reason: `change is ${c.state}` };
    if (c.headSha !== sha) return { merged: false, reason: 'head commit has moved' };
    return { merged: true, sha: this.doMerge(c, 'oafactory-gate') };
  }
  async getCommit(sha: string): Promise<CommitInfo> {
    const c = this.commit(this.resolve(sha));
    const treeSha = createHash('sha1').update(JSON.stringify([...c.files].sort())).digest('hex');
    return { sha: c.sha, message: c.message, treeSha, parents: c.parents, date: c.date };
  }
  async commitsAfter(branch: string, sha: string): Promise<CommitInfo[]> {
    const out: CommitInfo[] = [];
    let cur: string | undefined = this.resolve(branch);
    while (cur && cur !== sha) { out.unshift(await this.getCommit(cur)); cur = this.commit(cur).parents[0]; }
    return out;
  }
  async openRevert(mergeSha: string, title: string, body: string): Promise<number> {
    const m = this.commit(mergeSha);
    const parent = this.commit(m.parents[0]!);
    const tip = this.commit(this.branches.get('main')!);
    const files = new Map(tip.files);
    for (const p of new Set([...m.files.keys(), ...parent.files.keys()])) {
      if (m.files.get(p) === parent.files.get(p)) continue;
      if (parent.files.has(p)) files.set(p, parent.files.get(p)!); else files.delete(p);
    }
    const branch = `oafactory/revert-${mergeSha.slice(0, 7)}`;
    this.branches.set(branch, this.write(files, [tip.sha], `Revert "${m.message}"\n\nThis reverts commit ${mergeSha}.`));
    return this.createChange(branch, 'main', title, body, 'oafactory-watcher');
  }
  /** A person reverts a merge directly on the default branch. */
  humanRevert(mergeSha: string): string {
    const m = this.commit(mergeSha);
    const parent = this.commit(m.parents[0]!);
    const sha = this.write(new Map(parent.files), [this.branches.get('main')!], `Revert "${m.message}"\n\nThis reverts commit ${mergeSha}.`);
    this.branches.set('main', sha);
    return sha;
  }
}
