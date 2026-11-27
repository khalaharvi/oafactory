import { describe, expect, it } from 'vitest';
import { explainReceipt } from '../src/explain.js';
import { gate } from '../src/gate.js';
import { DOC_EDIT, propose, rig } from './helpers.js';

// Found in a live run: the Reviewer's request failed, yet the explanation said
// "Reviewed by builtin using ..." because it read the configured Reviewer, not the evidence.

describe('explain: who reviewed the change', () => {
  it('names the reviewer when a review is on record', async () => {
    const r = rig();
    const res = await gate(r.deps, propose(r, DOC_EDIT).change.number);
    expect(explainReceipt(res.statement)).toContain('Reviewed by pr-agent using openai/model-b.');
  });

  it('says no review was recorded when there is none, instead of claiming one', async () => {
    const r = rig();
    const res = await gate(r.deps, propose(r, DOC_EDIT, { review: false }).change.number);
    const text = explainReceipt(res.statement);
    expect(text).not.toContain('Reviewed by');
    expect(text).toContain('No review was recorded. The second AI set up to review it was pr-agent using openai/model-b.');
  });
});
