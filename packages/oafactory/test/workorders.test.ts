import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFactoryConfig, parseWorkOrder } from '../src/config.js';
import { listWorkOrders, newWorkOrder, saveWorkOrder, serializeWorkOrder, workOrderDir, workOrderNotes } from '../src/workorders.js';
import { CONFIG } from './helpers.js';

const cfg = parseFactoryConfig(CONFIG);
const at = new Date('2026-11-24T10:15:00Z');

describe('work orders: building', () => {
  it('fills in an id from the time and defaults the scope to the whole project', () => {
    const wo = newWorkOrder({ intent: '  Fix the crash.  ', requestedBy: 'krishna', now: at });
    expect(wo).toEqual({ apiVersion: 'oafactory/v1alpha1', kind: 'WorkOrder', id: 'wo-20261124-101500', requested_by: 'krishna', intent: 'Fix the crash.', scope: { paths: ['*'] } });
  });

  it('keeps only the budget fields that were given, and round-trips through YAML', () => {
    const wo = newWorkOrder({ intent: 'x y', requestedBy: 'k', id: '0042', scope: ['src/', 'tests/'], budget: { usd_per_run: 1, minutes_per_run: undefined } });
    expect(wo.budget).toEqual({ usd_per_run: 1 });
    expect(parseWorkOrder(serializeWorkOrder(wo))).toEqual(wo);
    expect(newWorkOrder({ intent: 'x', requestedBy: 'k', budget: {} }).budget).toBeUndefined();
  });

  it('rejects an invalid id or an empty intent', () => {
    expect(() => newWorkOrder({ intent: 'x', requestedBy: 'k', id: 'has spaces' })).toThrow(/invalid/);
    expect(() => newWorkOrder({ intent: '   ', requestedBy: 'k' })).toThrow(/invalid/);
  });
});

describe('work orders: notes before a run', () => {
  const notes = (scope: string[] | undefined, budget?: { usd_per_run?: number; minutes_per_run?: number; max_attempts?: number }, intent = 'Fix it.') =>
    workOrderNotes(cfg, newWorkOrder({ intent, requestedBy: 'k', scope, budget })).join('\n');

  it('says nothing about a well-formed request', () => {
    expect(notes(['src/', 'tests/'], { usd_per_run: 1 })).toBe('');
    expect(notes(['docs/'])).toBe('');
  });
  it('points out a scope that allows code but not the test it needs', () => {
    expect(notes(['src/'])).toMatch(/allows code changes but not new tests \(tests\/\)/);
  });
  it('points out a scope of everything, sensitive paths, and budgets above the ceiling', () => {
    expect(notes(undefined)).toMatch(/scope is the whole project/);
    expect(notes(['.github/', 'docs/'])).toMatch(/sensitive paths \(\.github\/\)/);
    const over = notes(['docs/'], { usd_per_run: 9, minutes_per_run: 90, max_attempts: 5 });
    expect(over).toMatch(/asks for \$9 per attempt; the project allows at most \$2.5/);
    expect(over).toMatch(/asks for 90 minutes; the project allows at most 30/);
    expect(over).toMatch(/asks for 5 attempts; the project allows at most 2/);
  });
  it('points out a first line too long to be a title', () => {
    expect(notes(['docs/'], undefined, 'x'.repeat(121))).toMatch(/under 120 characters/);
  });
});

describe('work orders: saving', () => {
  it('saves outside the repository by default, lists what is saved, and uses an id once', async () => {
    expect(workOrderDir('acme/widgets')).toMatch(/work-orders[\\/]acme_widgets$/);
    expect(workOrderDir('../../etc')).toMatch(/work-orders[\\/]\.\._\.\._etc$/);
    const dir = mkdtempSync(join(tmpdir(), 'oaf-wo-'));
    expect(await listWorkOrders(join(dir, 'missing'))).toEqual([]);
    const a = newWorkOrder({ intent: 'First.', requestedBy: 'k', id: 'a' });
    const path = await saveWorkOrder(dir, a);
    expect(path).toBe(join(dir, 'a.yaml'));
    await expect(saveWorkOrder(dir, a)).rejects.toThrow(/already saved/);
    await saveWorkOrder(dir, newWorkOrder({ intent: 'Second.', requestedBy: 'k', id: 'b' }));
    writeFileSync(join(dir, 'junk.yaml'), 'not: a work order');
    expect((await listWorkOrders(dir)).map((w) => w.workOrder.id)).toEqual(['a', 'b']);
  });
});
