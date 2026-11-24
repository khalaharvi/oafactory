import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { API_VERSION, effectiveBudget, parseWorkOrder, type FactoryConfig } from './config.js';
import { matchesPattern } from './paths.js';
import type { WorkOrder } from './types.js';

export interface NewWorkOrder {
  intent: string;
  requestedBy: string;
  /** Paths the change may touch. Defaults to the whole repository. */
  scope?: string[];
  budget?: WorkOrder['budget'];
  id?: string;
  now?: Date;
}

/** Build and validate a work order. The id defaults to one based on the time. */
export function newWorkOrder(input: NewWorkOrder): WorkOrder {
  const stamp = (input.now ?? new Date()).toISOString().replaceAll('-', '').replaceAll(':', '').replace('T', '-').slice(0, 15);
  const budget = input.budget && Object.values(input.budget).some((v) => v !== undefined) ? input.budget : undefined;
  const wo = {
    apiVersion: API_VERSION, kind: 'WorkOrder' as const, id: input.id ?? `wo-${stamp}`, requested_by: input.requestedBy.trim(),
    intent: input.intent.trim(), scope: { paths: input.scope?.length ? input.scope : ['*'] }, ...(budget ? { budget } : {}),
  };
  return parseWorkOrder(serializeWorkOrder(wo));
}

export function serializeWorkOrder(wo: WorkOrder): string {
  return stringify(wo, { lineWidth: 0 });
}

const isEverything = (pattern: string) => pattern !== '' && [...pattern].every((c) => c === '*');
const probe = (pattern: string) => (pattern.endsWith('/') ? `${pattern}x` : pattern.replaceAll('*', 'x'));
const overlaps = (a: string, b: string) => matchesPattern(a, probe(b)) || matchesPattern(b, probe(a));

/** Things worth telling the person before a work order runs. None of them stops it. */
export function workOrderNotes(config: FactoryConfig, wo: WorkOrder): string[] {
  const notes: string[] = [];
  const budget = effectiveBudget(config, wo);
  const b = wo.budget ?? {};
  if ((b.usd_per_run ?? 0) > budget.usd_per_run) notes.push(`The work order asks for $${b.usd_per_run} per attempt; the project allows at most $${budget.usd_per_run}, so that is what applies.`);
  if ((b.minutes_per_run ?? 0) > budget.minutes_per_run) notes.push(`The work order asks for ${b.minutes_per_run} minutes; the project allows at most ${budget.minutes_per_run}.`);
  if ((b.max_attempts ?? 0) > budget.max_attempts) notes.push(`The work order asks for ${b.max_attempts} attempts; the project allows at most ${budget.max_attempts}.`);

  const everything = wo.scope.paths.some(isEverything);
  if (everything) notes.push('The scope is the whole project. Naming the folders the work belongs in makes a surprise less likely.');
  const code = config.tiers.rules.filter((r) => r.tier === 1).flatMap((r) => r.paths).filter((p) => !config.append_only.some((ao) => overlaps(p, ao)));
  const touchesCode = everything || wo.scope.paths.some((s) => code.some((c) => overlaps(s, c)));
  const touchesTests = everything || wo.scope.paths.some((s) => config.append_only.some((ao) => overlaps(s, ao)));
  if (touchesCode && !touchesTests && config.append_only.length) {
    notes.push(`The scope allows code changes but not new tests (${config.append_only.join(', ')}). A code change must add a test to be accepted without a person, so add the test folder to the scope.`);
  }
  const sensitive = wo.scope.paths.filter((s) => !isEverything(s) && config.protected.some((p) => overlaps(s, p)));
  if (sensitive.length) notes.push(`The scope includes sensitive paths (${sensitive.join(', ')}). Any change there always goes to a person.`);
  if (wo.intent.split('\n')[0]!.length > 120) notes.push('The first line of the intent becomes the title of the proposed change. Keep it under 120 characters.');
  return notes;
}

/** Where saved work orders live: outside the repository, next to the Ledger. */
export function workOrderDir(repo: string): string {
  const root = process.env.OAFACTORY_WORK_ORDERS ?? join(homedir(), '.oafactory', 'work-orders');
  const safe = [...repo].map((c) => (/[\w.-]/.test(c) ? c : '_')).join('');
  return join(root, safe);
}

export async function saveWorkOrder(dir: string, wo: WorkOrder): Promise<string> {
  const path = join(dir, `${wo.id}.yaml`);
  if (existsSync(path)) throw new Error(`a work order with id ${wo.id} is already saved at ${path}; a work order id can be used once`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, serializeWorkOrder(wo));
  return path;
}

export async function listWorkOrders(dir: string): Promise<Array<{ path: string; workOrder: WorkOrder }>> {
  if (!existsSync(dir)) return [];
  const out: Array<{ path: string; workOrder: WorkOrder }> = [];
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.yaml')).sort()) {
    try {
      out.push({ path: join(dir, name), workOrder: parseWorkOrder(await readFile(join(dir, name), 'utf8')) });
    } catch {
      // Not a work order: leave it out of the listing.
    }
  }
  return out;
}
