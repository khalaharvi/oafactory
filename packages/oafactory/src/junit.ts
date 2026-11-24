import type { TestCase, TestReport } from './types.js';

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[2] ?? m[3]) : undefined;
};

/**
 * Minimal JUnit XML reader. It extracts one entry per <testcase>, identified by
 * `classname::name`, and whether it was skipped. Nothing else is needed for
 * `test_integrity` evidence.
 */
export function parseJUnit(xml: string): TestReport {
  const tests: TestCase[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase\s*>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const tag = ` ${m[1] ?? ''}`;
    const body = m[3] ?? '';
    const name = attr(tag, 'name') ?? '';
    const cls = attr(tag, 'classname') ?? attr(tag, 'file') ?? '';
    tests.push({ id: cls ? `${cls}::${name}` : name, skipped: /<skipped\b/.test(body) || /<disabled\b/.test(body) });
  }
  return { tests };
}

export function mergeReports(reports: TestReport[]): TestReport {
  return { tests: reports.flatMap((r) => r.tests) };
}

export interface IntegrityResult { met: boolean; base: number; head: number; newly_skipped: string[] }

/**
 * The head executed at least as many tests as the base, and no test that ran on
 * the base is skipped on the head.
 */
export function compareReports(base: TestReport, head: TestReport): IntegrityResult {
  const ranOnBase = new Set(base.tests.filter((t) => !t.skipped).map((t) => t.id));
  const headRan = head.tests.filter((t) => !t.skipped).length;
  const newly = [...new Set(head.tests.filter((t) => t.skipped && ranOnBase.has(t.id)).map((t) => t.id))].sort();
  return { met: headRan >= ranOnBase.size && newly.length === 0, base: ranOnBase.size, head: headRan, newly_skipped: newly };
}
