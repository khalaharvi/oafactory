import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { WorkOrder } from './types.js';

export const API_VERSION = 'oafactory/v1alpha1';
export const CONFIG_PATH = '.oafactory/factory.yaml';

const tier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const paths = z.array(z.string().min(1));
const promote = z.object({
  after_held: z.number().int().positive(),
  min_agreement: z.number().min(0).max(1),
  max_reverts: z.number().int().min(0),
}).strict();
const limit = z.object({ max_lines: z.number().int().positive(), max_files: z.number().int().positive() }).strict();
const role = z.object({
  use: z.string().min(1),
  model: z.string().min(1),
  /** Extension: shell command used when `use: command`. */
  command: z.string().optional(),
}).strict();

export const DEFAULT_PROMOTE = {
  '0': { after_held: 20, min_agreement: 0.95, max_reverts: 0 },
  '1': { after_held: 50, min_agreement: 0.95, max_reverts: 0 },
} as const;

export const factorySchema = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('Factory'),
  protected: paths.min(1),
  append_only: paths.default([]),
  checks: z.object({
    required: z.array(z.string().min(1)).min(1),
    holdout: z.array(z.string().min(1)).default([]),
    /** Extension: checks that count as `behavior` evidence (the spec names no field for them). */
    behavior: z.array(z.string().min(1)).default([]),
  }).strict(),
  budget: z.object({
    usd_per_run: z.number().positive(),
    minutes_per_run: z.number().positive(),
    max_attempts: z.number().int().positive(),
  }).strict(),
  roles: z.object({ runner: role, reviewer: role }).strict(),
  tiers: z.object({
    default: tier,
    rules: z.array(z.object({ paths: paths.min(1), tier }).strict()).default([]),
    limits: z.object({ '0': limit.optional(), '1': limit.optional() }).strict().default({}),
  }).strict(),
  autonomy: z.object({
    mode: z.enum(['shadow', 'earned']),
    promote: z.object({ '0': promote.default(DEFAULT_PROMOTE['0']), '1': promote.default(DEFAULT_PROMOTE['1']) })
      .strict().default(DEFAULT_PROMOTE),
    audit_rate: z.number().min(0).max(1).default(0.1),
  }).strict(),
  watch: z.object({ window_hours: z.number().positive().default(168) }).strict().default({ window_hours: 168 }),
}).strict();

export type FactoryConfig = z.infer<typeof factorySchema>;

export class ConfigError extends Error {
  constructor(message: string, readonly issues: string[] = []) { super(message); }
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

function parseDoc(text: string, what: string): unknown {
  try {
    return parseYaml(text);
  } catch (e) {
    throw new ConfigError(`${what} is not valid YAML: ${(e as Error).message}`);
  }
}

export function parseFactoryConfig(text: string): FactoryConfig {
  const res = factorySchema.safeParse(parseDoc(text, 'factory config'));
  if (!res.success) {
    const issues = formatIssues(res.error);
    throw new ConfigError(`factory config is invalid: ${issues.join('; ')}`, issues);
  }
  return res.data;
}

export const workOrderSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  kind: z.literal('WorkOrder'),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  source: z.object({ host: z.string(), issue: z.number().int().optional() }).strict().optional(),
  requested_by: z.string().min(1),
  intent: z.string().min(1),
  scope: z.object({ paths: paths.min(1) }).strict(),
  budget: z.object({
    usd_per_run: z.number().positive().optional(),
    minutes_per_run: z.number().positive().optional(),
    max_attempts: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();

export function parseWorkOrder(text: string): WorkOrder {
  const res = workOrderSchema.safeParse(parseDoc(text, 'work order'));
  if (!res.success) {
    const issues = formatIssues(res.error);
    throw new ConfigError(`work order is invalid: ${issues.join('; ')}`, issues);
  }
  return res.data as WorkOrder;
}

export interface Budget { usd_per_run: number; minutes_per_run: number; max_attempts: number }

/** A work order may lower the config's ceilings, never raise them. */
export function effectiveBudget(config: FactoryConfig, wo?: Pick<WorkOrder, 'budget'>): Budget {
  const b = wo?.budget ?? {};
  return {
    usd_per_run: Math.min(config.budget.usd_per_run, b.usd_per_run ?? Infinity),
    minutes_per_run: Math.min(config.budget.minutes_per_run, b.minutes_per_run ?? Infinity),
    max_attempts: Math.min(config.budget.max_attempts, b.max_attempts ?? Infinity),
  };
}

// --- Gateway config: lives outside the repository, next to the provider keys. ---

const gatewayModel = z.object({
  provider: z.enum(['anthropic', 'openai']),
  /** Model family used for the Runner/Reviewer separation rule. Defaults to the provider. */
  family: z.string().optional(),
  model: z.string().min(1),
  base_url: z.string().url().optional(),
  key_env: z.string().min(1),
  /** Prices you pay, in USD per million tokens. Used to meter the run budget. */
  usd_per_mtok: z.object({ input: z.number().min(0), output: z.number().min(0) }).strict(),
}).strict();

export const gatewaySchema = z.object({
  listen: z.string().default('127.0.0.1:4141'),
  models: z.record(gatewayModel),
  /** Hosts the Sandbox may reach through the Gateway's CONNECT proxy. */
  egress: z.array(z.string()).default([
    'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'static.crates.io',
    'index.crates.io', 'proxy.golang.org', 'sum.golang.org',
  ]),
}).strict();

export type GatewayConfig = z.infer<typeof gatewaySchema>;
export type GatewayModel = z.infer<typeof gatewayModel>;

export function parseGatewayConfig(text: string): GatewayConfig {
  const res = gatewaySchema.safeParse(parseDoc(text, 'gateway config'));
  if (!res.success) {
    const issues = formatIssues(res.error);
    throw new ConfigError(`gateway config is invalid: ${issues.join('; ')}`, issues);
  }
  return res.data;
}

export function resolvedModelName(m: GatewayModel): string { return `${m.provider}/${m.model}`; }
export function modelFamily(m: GatewayModel): string { return m.family ?? m.provider; }
