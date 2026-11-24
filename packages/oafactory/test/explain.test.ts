import { describe, expect, it } from 'vitest';
import { parseFactoryConfig } from '../src/config.js';
import { explainReceipt, explainWorkOrder } from '../src/explain.js';
import { gate } from '../src/gate.js';
import { watch } from '../src/watcher.js';
import { CONFIG, DOC_EDIT, SRC_EDIT, earned, propose, rig, workOrder } from './helpers.js';

/** Words a non-technical reader should not need. */
const JARGON = /\b(sha|commit|diff|predicate|in-toto|DSSE|would_merge|test_integrity|new_test|holdout|append_only|pull request)\b/i;

describe('explain: work orders', () => {
  const wo = { ...workOrder('0042', ['src/', 'tests/']), intent: 'Fix the crash when the config file is empty.', budget: { usd_per_run: 1 } };

  it('says what is asked, where, for how much, and who decides, without jargon', () => {
    const text = explainWorkOrder(parseFactoryConfig(CONFIG), wo);
    expect(text).toContain('Fix the crash when the config file is empty.');
    expect(text).toContain('Only in: src/, tests/');
    expect(text).toContain('Up to $1.00 and 30 minutes per attempt, with at most 2 attempts.');
    expect(text).toContain('shadow mode: the factory never accepts a change on its own');
    expect(text).toContain('The Gate is a fixed set of rules, not an AI.');
    expect(text).toContain('watched for 7 days');
    expect(text).not.toMatch(JARGON);
  });

  it('reflects earned mode and standing', () => {
    const cfg = parseFactoryConfig(earned());
    const none = explainWorkOrder(cfg, wo);
    expect(none).toContain('at: no level yet');
    expect(none).toContain('until the factory has earned trust at this level');
    const some = explainWorkOrder(cfg, wo, { standing: [0] });
    expect(some).toContain('at: low risk (tier 0)');
    expect(some).toContain('The factory may accept it on its own. About 1 in 10 are still sent to a person as a spot check.');
  });

  it('never promises more budget than the config allows', () => {
    const text = explainWorkOrder(parseFactoryConfig(CONFIG), { ...wo, budget: { usd_per_run: 999 } });
    expect(text).toContain('Up to $2.50');
  });

  it('is the same every time', () => {
    const cfg = parseFactoryConfig(CONFIG);
    expect(explainWorkOrder(cfg, wo)).toBe(explainWorkOrder(cfg, wo));
  });
});

describe('explain: receipts', () => {
  it('explains a would-merge decision and its outcome', async () => {
    const r = rig();
    const { change, run } = propose(r, SRC_EDIT);
    const res = await gate(r.deps, change.number);
    const before = explainReceipt(res.statement);
    expect(before).toContain('The factory would have accepted this change. The project is in shadow mode, so a person decides.');
    expect(before).toContain('Moderate risk (tier 1)');
    expect(before).toContain("[yes] The project's automated checks passed");
    expect(before).toContain('[yes] Every test that ran before still ran (2 tests before, 3 after)');
    expect(before).toContain('[yes] The work stayed within its money and time budget ($0.50 of $2.50)');
    expect(before).toContain('Nothing is recorded yet.');
    // The receipt's own wording is quoted as written; everything the explanation adds is plain.
    const added = before.split('\n').filter((l) => !l.includes('Reason given:') && !l.trim().startsWith('- ')).join('\n');
    expect(added).not.toMatch(JARGON);

    r.host.humanMerge(change.number);
    r.host.advance(169);
    await watch(r);
    const after = explainReceipt(res.statement, r.ledger.outcome(run.id)!.record);
    expect(after).toContain('merged by a person and was still in place when the watch period ended. The person agreed with the factory.');
  });

  it('explains an escalation by naming what was missing', async () => {
    const r = rig();
    const res = await gate(r.deps, propose(r, { 'src/a.py': 'a = 1\n' }, { review: false }).change.number);
    const text = explainReceipt(res.statement);
    expect(text).toContain('The factory did not accept this change. It was sent to a person.');
    expect(text).toContain('[no]  The change did not add a new test');
    expect(text).toContain('[no]  There is no valid approval from a second AI');
  });

  it('explains a sensitive change, a failed check and a reverted merge', async () => {
    const r = rig();
    const sensitive = explainReceipt((await gate(r.deps, propose(r, { 'Makefile': 'x\n' }, { scope: ['*'] }).change.number)).statement);
    expect(sensitive).toContain('Sensitive (tier 3)');
    expect(sensitive).toContain('Makefile matched protected Makefile');

    const failing = propose(r, DOC_EDIT, { checks: false });
    r.host.onRerun = () => 'failure';
    r.host.setCheck(failing.change.headSha, 'lint', 'success');
    r.host.setCheck(failing.change.headSha, 'test', 'failure');
    expect(explainReceipt((await gate(r.deps, failing.change.number)).statement)).toContain("[no]  The project's automated checks did not all pass (test: failure)");

    const reverted = explainReceipt((await gate(r.deps, propose(r, { 'docs/x.md': 'x\n' }).change.number)).statement,
      { kind: 'outcome', receipt_id: 'x', repo: 'a/b', change: 1, tier: 0, result: 'reverted', merged_by: 'factory', human: null, flaky: [], at: '' });
    expect(reverted).toContain('merged and later undone');
  });
});
