import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exec, run } from './exec.js';
import type { FakeHost } from './host/fake.js';
import { walk } from './instructions.js';

export interface Published { headSha: string; diff: string }

/** How the Harness gets code in and out. The real one uses git; tests use the in-memory host. */
export interface Transport {
  /** Check out `ref` into `dest` with no credential left behind. Returns the commit. */
  checkout(dest: string, ref: string): Promise<string>;
  /** Commit the working files in `workdir` onto a new branch from `baseSha` and push it. Null when nothing changed. */
  publish(workdir: string, baseSha: string, branch: string, message: string): Promise<Published | null>;
}

const CRED = /extraheader|credential|oauth|x-access-token|authorization|:\/\/[^/\s]*@/i;

/** Throw if a checkout's git configuration could carry a Git host credential. */
export async function assertNoCredentials(dir: string): Promise<void> {
  let text = '';
  try { text = await readFile(join(dir, '.git', 'config'), 'utf8'); } catch { return; }
  const bad = text.split('\n').filter((l) => CRED.test(l));
  if (bad.length) throw new Error(`the sandbox checkout's git config holds a possible credential: ${bad[0]!.trim()}`);
}

/**
 * Git transport. The Harness token lives only in this process's memory and is
 * passed to git per invocation; it is never written to any checkout.
 */
export class GitTransport implements Transport {
  constructor(private url: string, private token?: string, private scratch = '') {}

  private auth(): string[] {
    if (!this.token || !/^https?:/.test(this.url)) return [];
    const basic = Buffer.from(`x-access-token:${this.token}`).toString('base64');
    return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
  }
  private env(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}), ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}) };
  }

  async checkout(dest: string, ref: string): Promise<string> {
    await run('git', ['-c', 'credential.helper=', ...this.auth(), 'clone', '--quiet', '--depth', '1', '--branch', ref, '--single-branch', this.url, dest], { env: this.env() });
    const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dest })).trim();
    await run('git', ['remote', 'remove', 'origin'], { cwd: dest });
    await assertNoCredentials(dest);
    return sha;
  }

  async publish(workdir: string, baseSha: string, branch: string, message: string): Promise<Published | null> {
    // The Worker controlled `workdir/.git`, so nothing in it is trusted: hooks, config, filters.
    // Commit its files through a pristine git directory instead.
    const pristine = `${this.scratch || workdir}.pristine`;
    await rm(pristine, { recursive: true, force: true });
    const env = this.env();
    await run('git', ['init', '--quiet', '--bare', pristine], { env });
    await run('git', ['--git-dir', pristine, '-c', 'credential.helper=', ...this.auth(), 'fetch', '--quiet', '--depth', '1', this.url, baseSha], { env });
    await run('git', ['--git-dir', pristine, 'update-ref', 'refs/heads/work', baseSha], { env });
    await run('git', ['--git-dir', pristine, 'symbolic-ref', 'HEAD', 'refs/heads/work'], { env });
    const git = (args: string[]) => exec('git', ['--git-dir', pristine, '--work-tree', workdir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
      '-c', 'user.name=oafactory-harness', '-c', 'user.email=harness@oafactory.invalid', '-c', 'commit.gpgsign=false', ...args], { env });
    const must = async (args: string[]) => { const r = await git(args); if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`); return r.stdout; };
    try {
      await must(['read-tree', 'HEAD']);
      await must(['add', '-A', '--', '.']);
      const status = await must(['status', '--porcelain']);
      if (status.trim() === '') return null;
      await must(['commit', '--quiet', '--no-verify', '-m', message]);
      const headSha = (await must(['rev-parse', 'HEAD'])).trim();
      const diff = await must(['diff', '--no-ext-diff', '--no-textconv', baseSha, headSha]);
      const push = await exec('git', ['--git-dir', pristine, '-c', 'credential.helper=', ...this.auth(), 'push', '--quiet', this.url, `${headSha}:refs/heads/${branch}`], { env });
      if (push.code !== 0) throw new Error(`push failed: ${push.stderr.trim()}`);
      return { headSha, diff };
    } finally {
      await rm(pristine, { recursive: true, force: true });
    }
  }
}

/** Transport over the in-memory host, for tests and the demo. */
export class FakeTransport implements Transport {
  constructor(private host: FakeHost) {}
  async checkout(dest: string, ref: string): Promise<string> {
    const sha = this.host.head(ref);
    for (const path of this.host.listPaths(sha)) {
      await mkdir(dirname(join(dest, path)), { recursive: true });
      await writeFile(join(dest, path), (await this.host.readFile(path, sha))!);
    }
    return sha;
  }
  async publish(workdir: string, baseSha: string, branch: string, message: string): Promise<Published | null> {
    const edits: Record<string, string | null> = {};
    const now = new Set(await walk(workdir));
    for (const p of now) {
      const content = await readFile(join(workdir, p), 'utf8');
      if (content !== (await this.host.readFile(p, baseSha))) edits[p] = content;
    }
    for (const p of this.host.listPaths(baseSha)) if (!now.has(p)) edits[p] = null;
    if (Object.keys(edits).length === 0) return null;
    const headSha = this.host.push(branch, edits, message);
    const diff = Object.entries(edits).map(([p, v]) => `--- ${p}\n${v === null ? '(deleted)' : v.split('\n').map((l) => `+${l}`).join('\n')}`).join('\n');
    return { headSha, diff };
  }
}
