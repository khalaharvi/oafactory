import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CONFIG_PATH, parseFactoryConfig } from './config.js';
import { walk } from './instructions.js';
import { isTestFile } from './ready.js';

const q = (items: string[]) => `[${items.map((i) => (/^[\w./-]+$/.test(i) ? i : JSON.stringify(i))).join(', ')}]`;

/** Build a starting factory config from what is in the repository. Always shadow mode. */
export async function draftConfig(root: string): Promise<{ yaml: string; notes: string[] }> {
  const files = await walk(root);
  const top = new Set(files.map((f) => f.split('/')[0]!));
  const notes: string[] = [];

  const protectedPaths = ['.oafactory/'];
  for (const d of ['.github/', '.circleci/', '.buildkite/']) if (files.some((f) => f.startsWith(d))) protectedPaths.push(d);
  for (const f of ['.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml']) if (top.has(f)) protectedPaths.push(f);
  const manifests = ['Makefile', 'justfile', 'package.json', 'pyproject.toml', 'tox.ini', 'noxfile.py', 'pytest.ini', 'setup.cfg', 'conftest.py', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Taskfile.yml',
    'vitest.config.ts', 'vitest.config.js', 'jest.config.js', 'jest.config.ts', 'tsconfig.json'];
  for (const m of manifests) if (files.some((f) => f === m || f.endsWith(`/${m}`))) protectedPaths.push(`*${m}`);
  // Instruction files are protected whether or not they exist yet: adding one is itself a Tier 3 change.
  protectedPaths.push('*AGENTS.md', '*CLAUDE.md', '*GEMINI.md', '*.cursorrules', '*.cursor/rules/*', '*.claude/*', '*.github/copilot-instructions.md');

  const testDirs = ['tests/', 'test/', 'spec/', '__tests__/', 'e2e/'].filter((d) => files.some((f) => f.startsWith(d)));
  const appendOnly = [...testDirs];
  const scattered = files.filter((f) => isTestFile(f) && !testDirs.some((d) => f.startsWith(d)));
  if (scattered.some((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f))) appendOnly.push('*.test.*', '*.spec.*');
  if (scattered.some((f) => /_test\.(go|py|rb|rs)$/.test(f))) appendOnly.push('*_test.*');
  if (scattered.some((f) => /(^|\/)test_[^/]+\.py$/.test(f))) appendOnly.push('*test_*.py');
  if (appendOnly.length === 0) { appendOnly.push('tests/'); notes.push('No tests were found. `append_only` assumes `tests/`; adjust it.'); }

  const srcDirs = ['src', 'lib', 'app', 'pkg', 'internal', 'cmd', 'packages', 'apps', 'crates'].filter((d) => top.has(d) && files.some((f) => f.startsWith(`${d}/`)));
  if (srcDirs.length === 0) notes.push('No conventional source directory was found, so no path is Tier 1 yet. Add a rule under `tiers.rules`.');
  const tier1 = [...srcDirs.map((d) => `${d}/**`), ...appendOnly.map((a) => (a.endsWith('/') ? `${a}**` : a))];
  const tier3 = ['install', 'deploy', 'infra', 'terraform', 'migrations', 'scripts', '.husky'].filter((d) => files.some((f) => f.startsWith(`${d}/`))).map((d) => `${d}/**`);

  const jobs: string[] = [];
  for (const f of files.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))) {
    try {
      const doc = parseYaml(await readFile(join(root, f), 'utf8')) as { on?: unknown; jobs?: Record<string, { name?: string }> };
      const on = JSON.stringify(doc.on ?? (doc as Record<string, unknown>).true ?? '');
      if (!/pull_request|push/.test(on)) continue;
      for (const [id, job] of Object.entries(doc.jobs ?? {})) jobs.push(typeof job?.name === 'string' && !job.name.includes('${{') ? job.name : id);
    } catch { /* unreadable workflow: `ready` will flag missing checks */ }
  }
  const required = [...new Set(jobs)];
  if (required.length === 0) { required.push('lint', 'test'); notes.push('No CI jobs were detected. `checks.required` is a placeholder; set it to the exact names of your CI jobs.'); }

  const yaml = `# OAFactory config. The Gate reads this file from the base branch only.
# Reference: https://oafactory.org/docs/reference/factory-config
apiVersion: oafactory/v1alpha1
kind: Factory

# Any change to these paths is Tier 3 and always goes to a person.
protected: ${q(protectedPaths)}
# New files are allowed here; modifying or deleting an existing one is Tier 3.
append_only: ${q(appendOnly)}

checks:
  # Exact CI job names that must pass on the head commit.
  required: ${q(required)}
  # Checks whose definitions live outside this repository, unreadable by the Worker.
  holdout: []

budget: { usd_per_run: 2.50, minutes_per_run: 30, max_attempts: 2 }

roles:
  # Model names are aliases resolved by your Gateway config (~/.oafactory/gateway.yaml).
  # builtin is OAFactory's own small agent. Others: mini-swe-agent, claude-code, pi, codex, or command.
  runner:   { use: builtin, model: oafactory/coder }
  reviewer: { use: builtin, model: oafactory/reviewer }

tiers:
  default: 2
  rules:
    - { paths: ["docs/**", "*.md"], tier: 0 }
${tier1.length ? `    - { paths: ${q(tier1)}, tier: 1 }\n` : ''}${tier3.length ? `    - { paths: ${q(tier3)}, tier: 3 }\n` : ''}  limits:
    0: { max_lines: 200, max_files: 10 }
    1: { max_lines: 150, max_files: 5 }

autonomy:
  # shadow: the Gate records what it would do; people merge everything.
  mode: shadow
  promote:
    0: { after_held: 20, min_agreement: 0.95, max_reverts: 0 }
    1: { after_held: 50, min_agreement: 0.95, max_reverts: 0 }
  audit_rate: 0.10

watch: { window_hours: 168 }
`;
  parseFactoryConfig(yaml); // never write a config the Gate would reject
  return { yaml, notes };
}

export async function init(root: string, force = false): Promise<{ path: string; notes: string[] }> {
  const path = join(root, CONFIG_PATH);
  if (existsSync(path) && !force) throw new Error(`${CONFIG_PATH} already exists; pass --force to overwrite it`);
  const { yaml, notes } = await draftConfig(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, yaml);
  return { path, notes };
}

export const GATEWAY_EXAMPLE = `# OAFactory Gateway config. Keep this file, and the keys it names, outside any repository
# and outside the Sandbox. The Worker only ever sees a per-run key issued by the Gateway.
listen: 127.0.0.1:4141

models:
  # The Runner and the Reviewer must be different model families.
  oafactory/coder:
    provider: anthropic
    model: claude-sonnet-5-5
    key_env: ANTHROPIC_API_KEY
    # What you pay, in USD per million tokens. The run budget is metered with these numbers:
    # replace them with your provider's current prices.
    usd_per_mtok: { input: 0, output: 0 }
  oafactory/reviewer:
    provider: openai
    model: REPLACE_WITH_A_MODEL_FROM_ANOTHER_FAMILY
    key_env: OPENAI_API_KEY
    usd_per_mtok: { input: 0, output: 0 }

# Hosts the Sandbox may reach, over HTTPS only.
egress: [registry.npmjs.org, pypi.org, files.pythonhosted.org, crates.io, static.crates.io, index.crates.io, proxy.golang.org, sum.golang.org]
`;
