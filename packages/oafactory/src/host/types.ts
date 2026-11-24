import type { ChangedFile, TestReport } from '../types.js';

export interface Change {
  number: number;
  state: 'open' | 'merged' | 'closed';
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  title: string;
  body: string;
  author: string;
  mergeSha?: string;
  mergedAt?: string;
  mergedBy?: string;
}

export type CheckConclusion = 'success' | 'failure' | 'pending' | 'missing';

/** The state of one named check on a commit, across all of its attempts. */
export interface CheckState {
  name: string;
  conclusion: CheckConclusion;
  attempts: number;
  /** True when an earlier attempt failed. */
  failedBefore: boolean;
  /** Host-specific handle used to rerun the check. */
  ref?: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  /** Labels, each with the login of whoever applied it and whether that person can write to the repository. */
  labels: Array<{ name: string; appliedBy?: string; appliedByMaintainer: boolean }>;
}

export interface MergeResult { merged: boolean; sha?: string; reason?: string }

export interface CommitInfo { sha: string; message: string; treeSha: string; parents: string[]; date: string }

/**
 * The verbs of spec section 9. One implementation per Git host. The Gate reads
 * every fact through this interface and never from the Worker.
 */
export interface Host {
  readonly kind: 'github' | 'gitlab' | 'fake';
  /** `owner/name`. */
  readonly repo: string;
  /** Receipt subject name, e.g. `git+https://github.com/owner/name`. */
  subjectName(): string;

  defaultBranch(): Promise<string>;
  getIssue(number: number): Promise<Issue>;
  getChange(number: number): Promise<Change>;
  listFiles(number: number): Promise<ChangedFile[]>;
  /** File content at a ref, or null when the file does not exist there. */
  readFile(path: string, ref: string): Promise<string | null>;
  listChecks(sha: string): Promise<CheckState[]>;
  rerunCheck(sha: string, check: CheckState): Promise<void>;
  /** Test report published by CI for a commit, or null when there is none. */
  getTestReport(sha: string): Promise<TestReport | null>;
  comment(number: number, body: string): Promise<void>;
  openChange(input: { head: string; base: string; title: string; body: string }): Promise<number>;
  /** Merge only if the head is still `sha`. */
  merge(number: number, sha: string): Promise<MergeResult>;
  getCommit(sha: string): Promise<CommitInfo>;
  /** Commits on a branch after the given commit, oldest first. */
  commitsAfter(branch: string, sha: string): Promise<CommitInfo[]>;
  /** Create a branch holding the revert of `mergeSha` and open a change for it. */
  openRevert(mergeSha: string, title: string, body: string): Promise<number>;
  /** URL of a clone source, without credentials. */
  cloneUrl(): string;
}
