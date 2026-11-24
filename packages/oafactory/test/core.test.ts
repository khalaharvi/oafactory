import { describe, expect, it } from 'vitest';
import { classify } from '../src/classify.js';
import { effectiveBudget, parseFactoryConfig, parseWorkOrder } from '../src/config.js';
import { compareReports, parseJUnit } from '../src/junit.js';
import { openDb, Ledger } from '../src/ledger.js';
import { matchesPattern } from '../src/paths.js';
import { buildStatement, LocalKeySigner, verifyEnvelope, type ReceiptPredicate } from '../src/receipt.js';
import type { ChangedFile } from '../src/types.js';
import { CONFIG } from './helpers.js';

const cfg = parseFactoryConfig(CONFIG);
const f = (path: string, status: ChangedFile['status'] = 'modified', lines = 1, previousPath?: string): ChangedFile =>
  ({ path, status, additions: lines, deletions: 0, ...(previousPath ? { previousPath } : {}) });

describe('path patterns', () => {
  it('treats a trailing slash as a directory', () => {
    expect(matchesPattern('.github/', '.github/workflows/ci.yml')).toBe(true);
    expect(matchesPattern('tests/', 'src/tests/x.py')).toBe(false);
    expect(matchesPattern('tests/', 'tests')).toBe(false);
  });
  it('lets * cross directory separators and ignores a leading slash', () => {
    expect(matchesPattern('*.md', 'docs/deep/guide.md')).toBe(true);
    expect(matchesPattern('docs/**', 'docs/a/b.txt')).toBe(true);
    expect(matchesPattern('/Makefile', 'Makefile')).toBe(true);
    expect(matchesPattern('Makefile', 'sub/Makefile')).toBe(false);
    expect(matchesPattern('src/*.py', 'src/a/b.py')).toBe(true);
  });
  it('escapes regex characters', () => {
    expect(matchesPattern('a.b', 'aXb')).toBe(false);
    expect(matchesPattern('a+(b)', 'a+(b)')).toBe(true);
  });
});

describe('config', () => {
  it('parses the spec example and applies defaults', () => {
    const min = parseFactoryConfig(CONFIG.replace(/  promote:[\s\S]*?audit_rate: 0.10\n/, '').replace('watch: { window_hours: 168 }\n', ''));
    expect(min.autonomy.audit_rate).toBe(0.1);
    expect(min.autonomy.promote['1'].after_held).toBe(50);
    expect(min.watch.window_hours).toBe(168);
  });
  it('rejects unknown fields and wrong versions', () => {
    expect(() => parseFactoryConfig(CONFIG + 'surprise: 1\n')).toThrow(/invalid/);
    expect(() => parseFactoryConfig(CONFIG.replace('v1alpha1', 'v9'))).toThrow(/apiVersion/);
    expect(() => parseFactoryConfig(': : :')).toThrow();
  });
  it('lets a work order lower the budget but never raise it', () => {
    const wo = parseWorkOrder('apiVersion: oafactory/v1alpha1\nkind: WorkOrder\nid: "0042"\nrequested_by: k\nintent: fix\nscope: { paths: [src/] }\nbudget: { usd_per_run: 1.00, minutes_per_run: 999 }\n');
    expect(effectiveBudget(cfg, wo)).toEqual({ usd_per_run: 1, minutes_per_run: 30, max_attempts: 2 });
  });
});

describe('tier classification', () => {
  it('uses the highest matching rule regardless of order', () => {
    expect(classify(cfg, [f('docs/guide.md')]).tier).toBe(0);
    expect(classify(cfg, [f('src/a.py')]).tier).toBe(1);
    expect(classify(cfg, [f('src/notes.md')]).tier).toBe(1);
    expect(classify(cfg, [f('other/x')]).tier).toBe(2);
    expect(classify(cfg, [f('docs/guide.md'), f('install/run.sh')]).tier).toBe(3);
  });
  it('makes protected paths tier 3 even when a rule says otherwise', () => {
    const c = classify(cfg, [f('AGENTS.md')]);
    expect(c.tier).toBe(3);
    expect(c.because[0]).toMatch(/protected/);
  });
  it('allows new files under append-only paths but not edits or deletes', () => {
    expect(classify(cfg, [f('tests/test_new.py', 'added')]).tier).toBe(1);
    // With the spec's literal example config, tests/ matches no rule and falls to the default tier.
    const literal = parseFactoryConfig(CONFIG.replace('"src/**", "tests/**"', '"src/**"'));
    expect(classify(literal, [f('src/a.py'), f('tests/test_new.py', 'added')]).tier).toBe(2);
    expect(classify(cfg, [f('tests/test_config.py', 'modified')]).tier).toBe(3);
    expect(classify(cfg, [f('tests/test_config.py', 'deleted')]).tier).toBe(3);
  });
  it('counts a rename under both paths', () => {
    expect(classify(cfg, [f('docs/b.md', 'renamed', 0, 'tests/test_config.py')]).tier).toBe(3);
    expect(classify(cfg, [f('install/b.md', 'renamed', 0, 'docs/a.md')]).tier).toBe(3);
    expect(classify(cfg, [f('docs/b.md', 'renamed', 0, 'docs/a.md')]).tier).toBe(0);
  });
  it('raises the tier while limits are exceeded', () => {
    expect(classify(cfg, [f('docs/guide.md', 'modified', 201)]).tier).toBe(2);
    expect(classify(cfg, [f('docs/guide.md', 'modified', 151)]).tier).toBe(0);
    expect(classify(cfg, [f('src/a.py', 'modified', 151)]).tier).toBe(2);
    const many = Array.from({ length: 6 }, (_, i) => f(`src/${i}.py`));
    expect(classify(cfg, many).tier).toBe(2);
    const docs = Array.from({ length: 11 }, (_, i) => f(`docs/${i}.md`));
    expect(classify(cfg, docs).tier).toBe(2); // over tier 0 and tier 1 file limits
  });
  it('reports paths outside the work order scope', () => {
    expect(classify(cfg, [f('src/a.py'), f('docs/x.md')], ['src/']).outOfScope).toEqual(['docs/x.md']);
    expect(classify(cfg, [f('src/b.py', 'renamed', 0, 'lib/b.py')], ['src/']).outOfScope).toEqual(['lib/b.py']);
  });
  it('can only get stricter when a rule is added', () => {
    const stricter = parseFactoryConfig(CONFIG.replace('  limits:', '    - { paths: ["src/auth/**"], tier: 3 }\n  limits:'));
    for (const p of ['src/a.py', 'src/auth/x.py', 'docs/a.md', 'zzz']) expect(classify(stricter, [f(p)]).tier).toBeGreaterThanOrEqual(classify(cfg, [f(p)]).tier);
  });
});

describe('junit', () => {
  const xml = `<testsuites><testsuite name="s"><testcase classname="a.B" name="one" time="0.1"/>
    <testcase classname="a.B" name="two"><skipped message="x"/></testcase>
    <testcase name='three' classname='a.C'><failure>boom</failure></testcase></testsuite></testsuites>`;
  it('reads test cases and skips', () => {
    expect(parseJUnit(xml).tests).toEqual([{ id: 'a.B::one', skipped: false }, { id: 'a.B::two', skipped: true }, { id: 'a.C::three', skipped: false }]);
  });
  it('detects fewer tests and newly skipped tests', () => {
    const t = (id: string, skipped = false) => ({ id, skipped });
    expect(compareReports({ tests: [t('a'), t('b')] }, { tests: [t('a'), t('b'), t('c')] }).met).toBe(true);
    expect(compareReports({ tests: [t('a'), t('b')] }, { tests: [t('a')] }).met).toBe(false);
    const r = compareReports({ tests: [t('a'), t('b')] }, { tests: [t('a'), t('b', true), t('c'), t('d')] });
    expect(r.met).toBe(false);
    expect(r.newly_skipped).toEqual(['b']);
  });
});

describe('ledger', () => {
  const pred = (id: string): ReceiptPredicate => ({
    id, work_order: '1', issued_at: '2026-01-01T00:00:00Z', change: { host: 'fake', repo: 'a/b', number: 1, base: 'x' },
    run: { attempt: 1, runner: 'r', runner_model: 'm', reviewer: 'v', reviewer_model: 'n', cost_usd: 1, minutes: 1, state: 'escalated', audit: false },
    tier: { value: 0, because: [] }, evidence: [], unverified: [], decision: { value: 'escalate', mode: 'shadow', reason: '' },
  });
  it('is append-only and exports JSON Lines', () => {
    const db = openDb(':memory:');
    const ledger = new Ledger(db);
    ledger.writeReceipt(buildStatement('git+x', 'abc', pred('1-1')));
    ledger.writeReceipt(buildStatement('git+x', 'abd', pred('2-1')));
    expect(() => ledger.writeReceipt(buildStatement('git+x', 'abc', pred('1-1')))).toThrow();
    expect(() => db.exec("UPDATE records SET body = '{}'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM records')).toThrow(/append-only/);
    const lines = ledger.exportJsonl().trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.statement.predicate.id)).toEqual(['1-1', '2-1']);
  });
  it('signs and verifies receipts, and rejects tampering', async () => {
    const { signer, publicKeyPem } = LocalKeySigner.generate();
    const st = buildStatement('git+x', 'abc', pred('1-1'));
    const signed = await signer.sign(st);
    expect(verifyEnvelope(signed.envelope!, publicKeyPem)).toEqual(st);
    const forged = { ...signed.envelope!, payload: Buffer.from(JSON.stringify({ ...st, predicateType: 'x' })).toString('base64') };
    expect(() => verifyEnvelope(forged, publicKeyPem)).toThrow(/does not verify/);
    expect(() => verifyEnvelope(signed.envelope!, LocalKeySigner.generate().publicKeyPem)).toThrow();
  });
});
