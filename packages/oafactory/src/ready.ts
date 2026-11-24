import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_PATH, ConfigError, parseFactoryConfig, type FactoryConfig } from './config.js';
import { isInstructionFile, walk } from './instructions.js';
import { firstMatch } from './paths.js';

export interface Finding { level: 'pass' | 'warn' | 'fail'; check: string; message: string }

const CI_FILES = (p: string) => p.startsWith('.github/workflows/') || p === '.gitlab-ci.yml' || p.startsWith('.circleci/') || p === 'Jenkinsfile' || p === 'azure-pipelines.yml' || p.startsWith('.buildkite/');
export const isTestFile = (p: string) => /(^|\/)(tests?|__tests__|spec|specs|e2e)\//.test(p) || /(^|\/)(test_[^/]+\.py|[^/]+_test\.(py|go|rb|rs)|[^/]+\.(test|spec)\.[cm]?[jt]sx?|[^/]+Tests?\.(java|kt|cs|swift)|conftest\.py)$/.test(p);

/** Files that define what a CI command actually runs: tool name -> manifest. */
const INDIRECTION: Array<{ re: RegExp; files: string[] }> = [
  { re: /\bmake\b/, files: ['Makefile', 'makefile', 'GNUmakefile'] },
  { re: /\b(npm|pnpm|yarn|bun|npx)\b/, files: ['package.json'] },
  { re: /\bjust\b/, files: ['justfile', 'Justfile'] },
  { re: /\btox\b/, files: ['tox.ini'] },
  { re: /\bnox\b/, files: ['noxfile.py'] },
  { re: /\b(pytest|python -m pytest)\b/, files: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'conftest.py'] },
  { re: /\btask\b/, files: ['Taskfile.yml', 'Taskfile.yaml'] },
  { re: /\bcargo\b/, files: ['Cargo.toml'] },
  { re: /\b(gradle|gradlew)\b/, files: ['build.gradle', 'build.gradle.kts'] },
  { re: /\bmvn\b/, files: ['pom.xml'] },
  { re: /\bgo test\b/, files: ['go.mod'] },
];

/**
 * `oafactory ready`: is this repository's factory config safe to gate with?
 * Checks everything spec section 3 says `protected` and `append_only` MUST cover.
 */
export async function ready(root: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (level: Finding['level'], check: string, message: string) => out.push({ level, check, message });

  let config: FactoryConfig;
  try {
    config = parseFactoryConfig(await readFile(join(root, CONFIG_PATH), 'utf8'));
    add('pass', 'config', `${CONFIG_PATH} is valid`);
  } catch (e) {
    add('fail', 'config', e instanceof ConfigError ? e.message : `${CONFIG_PATH} not found; run \`oafactory init\``);
    return out;
  }

  const files = await walk(root);
  const prot = (p: string) => firstMatch(config.protected, p) !== undefined;
  const report = (check: string, need: string[], what: string) => {
    const missing = need.filter((p) => !prot(p));
    if (need.length === 0) return;
    if (missing.length) add('fail', check, `${what} not covered by \`protected\`: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? `, and ${missing.length - 8} more` : ''}`);
    else add('pass', check, `${what} covered by \`protected\` (${need.length})`);
  };

  report('protected.config', files.filter((p) => p.startsWith('.oafactory/')), 'factory config');
  const ci = files.filter(CI_FILES);
  if (ci.length === 0) add('warn', 'protected.ci', 'no CI configuration found; the Gate reads check results from the Git host, so there is nothing to gate on yet');
  report('protected.ci', ci, 'CI configuration');
  report('protected.instructions', files.filter(isInstructionFile), 'instruction files');

  // Scripts the required checks execute through.
  let ciText = '';
  for (const p of ci) ciText += `\n${await readFile(join(root, p), 'utf8')}`;
  const manifests = new Set<string>();
  for (const { re, files: names } of INDIRECTION) {
    if (!re.test(ciText)) continue;
    for (const f of files) if (names.includes(f.split('/').pop()!)) manifests.add(f);
  }
  report('protected.scripts', [...manifests].sort(), 'scripts the checks run through');
  if (ci.length && manifests.size === 0) add('warn', 'protected.scripts', 'could not tell which scripts CI runs through; check by hand that each one is protected');

  // Test files must be covered by protected or append_only.
  const tests = files.filter(isTestFile);
  const uncovered = tests.filter((p) => !prot(p) && firstMatch(config.append_only, p) === undefined);
  if (tests.length === 0) add('warn', 'tests.covered', 'no test files found');
  else if (uncovered.length) add('fail', 'tests.covered', `test files covered by neither \`protected\` nor \`append_only\`: ${uncovered.slice(0, 8).join(', ')}${uncovered.length > 8 ? `, and ${uncovered.length - 8} more` : ''}`);
  else add('pass', 'tests.covered', `test files covered (${tests.length})`);

  // A new test must be able to be Tier 1, or Tier 1 can never meet its own bar.
  if (config.append_only.length) {
    const reachable = config.append_only.some((ao) => config.tiers.rules.some((r) => r.tier <= 1 && r.paths.some((rp) => {
      const probe = ao.endsWith('/') ? `${ao}__probe__` : ao.replace(/\*+/g, '__probe__');
      return firstMatch([rp], probe) !== undefined;
    })));
    if (!reachable && config.tiers.default > 1) add('warn', 'tiers.new_test', 'no tier rule gives new files under `append_only` Tier 1 or lower, so a change that adds a test is always Tier 2+ and Tier 1 can never merge');
  }

  // Required checks should exist in CI.
  if (ci.length) {
    const missing = config.checks.required.filter((n) => !new RegExp(`(^|[\\s"'])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*:|name:\\s*["']?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`, 'm').test(ciText));
    if (missing.length) add('warn', 'checks.required', `no CI job named ${missing.join(', ')} was found; check names must match exactly`);
    else add('pass', 'checks.required', `required checks found in CI: ${config.checks.required.join(', ')}`);
    if (!/oafactory-test-report/.test(ciText) && !files.includes('.gitlab-ci.yml')) add('warn', 'checks.test_report', 'CI uploads no `oafactory-test-report` artifact, so `test_integrity` evidence cannot be collected and Tier 1 will always escalate');
  }
  if (config.checks.holdout.length === 0) add('warn', 'checks.holdout', 'no holdout checks; configure at least one before seeking Tier 1 standing');
  if (config.roles.runner.model === config.roles.reviewer.model) add('fail', 'roles', 'runner and reviewer use the same model alias; the Reviewer must be a different model family');
  if (config.autonomy.mode === 'earned') add('warn', 'autonomy', 'mode is `earned`: the Gate will merge at tiers with standing');
  return out;
}
