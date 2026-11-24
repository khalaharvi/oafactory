/** Regressions found by running the factory against its own repository on GitHub. */
import { describe, expect, it } from 'vitest';
import { run } from '../src/exec.js';
import { gate } from '../src/gate.js';
import { DOC_EDIT, SRC_EDIT, propose, rig } from './helpers.js';

describe('a test report that cannot be fetched', () => {
  it('is missing evidence, not a crash: a Tier 0 change is still decided', async () => {
    const r = rig();
    const { change } = propose(r, DOC_EDIT);
    r.host.getTestReport = async () => { throw new Error('error downloading oafactory-test-report: Forbidden'); };
    const res = await gate(r.deps, change.number);
    expect(res.decision).toBe('would_merge');
    const ti = res.statement.predicate.evidence.find((e) => e.kind === 'test_integrity')!;
    expect(ti.met).toBe(false);
    expect(String(ti.detail!.reason)).toMatch(/base commit's test report could not be read: error downloading/);
    expect(r.ledger.receipts().length).toBe(1);
  });

  it('escalates a Tier 1 change, naming the evidence', async () => {
    const r = rig();
    const { change } = propose(r, SRC_EDIT);
    r.host.getTestReport = async (sha) => { if (sha === change.headSha) throw new Error('timeout'); return { tests: [] }; };
    const res = await gate(r.deps, change.number);
    expect(res.decision).toBe('escalate');
    expect(res.statement.predicate.decision.reason).toMatch(/test_integrity/);
    expect(res.statement.predicate.unverified.join(' ')).toMatch(/Could not confirm that the head ran every test/);
  });
});

describe('command errors', () => {
  it('are kept short and drop query strings, which can carry signed URLs', async () => {
    const noisy = `echo "error downloading: Get https://blob.example/artifact.zip?sig=SECRETSIGNATURE&se=2026 ${'x'.repeat(2000)}" >&2; exit 1`;
    const err = await run('sh', ['-c', noisy]).catch((e: Error) => e);
    expect((err as Error).message).toContain('error downloading: Get https://blob.example/artifact.zip');
    expect((err as Error).message).not.toContain('SECRETSIGNATURE');
    expect((err as Error).message.length).toBeLessThan(500);
  });
});

describe('the receipt comment', () => {
  it('separates evidence the tier requires from evidence it does not', async () => {
    const r = rig();
    await gate(r.deps, propose(r, DOC_EDIT).change.number);
    const body = r.host.comments.at(-1)!.body;
    expect(body).toContain('| Evidence | Required at tier 0 | Result | Source |');
    expect(body).toContain('| `checks` | yes | met |');
    expect(body).toContain('| `new_test` | no | not met |');
    expect(body).not.toContain('**not met**');
    await gate(r.deps, propose(r, { 'src/a.py': 'a = 1\n' }).change.number);
    expect(r.host.comments.at(-1)!.body).toContain('| `new_test` | yes | **not met** |');
  });
});

describe('explain', () => {
  it('shortens a long technical reason to its first clause', async () => {
    const { explainReceipt } = await import('../src/explain.js');
    const r = rig();
    const { change } = propose(r, DOC_EDIT);
    r.host.getTestReport = async () => { throw new Error(`gh run download 1 -R failed (1): error downloading: Get "https://blob.example/${'a'.repeat(400)}"`); };
    const text = explainReceipt((await gate(r.deps, change.number)).statement);
    expect(text).toMatch(/\(the (base|head) commit's test report could not be read\)/);
    expect(text).not.toContain('blob.example');
  });
});
