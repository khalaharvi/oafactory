export type Tier = 0 | 1 | 2 | 3;

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Set when status is `renamed`. */
  previousPath?: string;
  additions: number;
  deletions: number;
}

export type EvidenceKind =
  | 'checks' | 'budget' | 'test_integrity' | 'new_test' | 'holdout' | 'review' | 'behavior';

export interface Evidence {
  kind: EvidenceKind;
  met: boolean;
  source: string;
  detail?: Record<string, unknown>;
}

export type DecisionValue = 'merge' | 'would_merge' | 'escalate' | 'abandon';
export type RunState = 'queued' | 'running' | 'gated' | 'merged' | 'escalated' | 'abandoned' | 'watching' | 'held' | 'reverted';

export interface TestCase { id: string; skipped: boolean }
export interface TestReport { tests: TestCase[] }

export interface WorkOrder {
  apiVersion: string;
  kind: 'WorkOrder';
  id: string;
  source?: { host: string; issue?: number };
  requested_by: string;
  intent: string;
  scope: { paths: string[] };
  budget?: { usd_per_run?: number; minutes_per_run?: number; max_attempts?: number };
}
