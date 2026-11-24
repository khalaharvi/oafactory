import { describe, expect, it } from 'vitest';
import { explainReceipt } from '../src/explain.js';
import { gate } from '../src/gate.js';
import { DOC_EDIT, SRC_EDIT, propose, rig } from './helpers.js';

describe('explain: only what the risk level requires counts as checked', () => {
  it('lists evidence the tier does not need separately, so a low-risk change is not shown as failing it', async () => {
    const r = rig();
    const text = explainReceipt((await gate(r.deps, propose(r, DOC_EDIT).change.number)).statement);
    const [checked, extra] = text.split('Also noted, but not required at this risk level');
    expect(checked).toContain("[yes] The project's automated checks passed");
    expect(checked).toContain('[yes] The work stayed within its money and time budget');
    expect(checked!.split('What was checked')[1]).not.toContain('[no]');
    expect(extra).toContain('The change did not add a new test');
    expect(extra).toContain('The change was not tried out in a running copy of the product');
  });

  it('keeps behaviour out of the required list at moderate risk and in it at higher risk', async () => {
    const r = rig();
    const moderate = explainReceipt((await gate(r.deps, propose(r, SRC_EDIT).change.number)).statement);
    expect(moderate.split('Also noted')[0]).not.toContain('running copy of the product');
    expect(moderate.split('Also noted')[1]).toContain('running copy of the product');
    const higher = explainReceipt((await gate(r.deps, propose(r, { 'other/x.txt': 'x\n' }, { scope: ['*'] }).change.number)).statement);
    expect(higher.split('What could not be confirmed')[0]).toContain('[no]  The change was not tried out in a running copy of the product');
    expect(higher).not.toContain('Also noted');
  });

  it('uses the singular for one test', async () => {
    const r = rig();
    const { change } = propose(r, SRC_EDIT);
    r.host.setReport(change.baseSha, { tests: [{ id: 'a', skipped: false }] });
    expect(explainReceipt((await gate(r.deps, change.number)).statement)).toContain('(1 test before, 3 after)');
  });
});
