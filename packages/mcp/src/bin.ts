#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

// node:sqlite prints an ExperimentalWarning on Node 22. On stdio it would only reach stderr, but it is noise.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (message.includes('SQLite is an experimental feature')) return;
  (emit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const HELP = `oafactory-mcp: an MCP server for OAFactory, over stdio

Usage: oafactory-mcp [options]

  --cwd <dir>        The repository root. Default: the current directory
  --repo <owner/name>  Default: read from the origin remote
  --ledger <path>    Default: $OAFACTORY_LEDGER or ~/.oafactory/ledger.db
  --allow-run        Also expose run_work_order, which starts work that spends money.
                     Without it, the server drafts, explains and saves work orders,
                     and a person starts them with \`oafactory run\`.

Add it to an MCP client as a stdio server whose command is \`oafactory-mcp\`.
`;

const { values } = parseArgs({
  options: { cwd: { type: 'string' }, repo: { type: 'string' }, ledger: { type: 'string' }, 'allow-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
});
if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const git = (cwd: string, ...args: string[]) => {
  try { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
};

const { createServer } = await import('./server.js');
const { parseRemote } = await import('oafactory');
const cwd = resolve(values.cwd ?? process.cwd());
const repo = values.repo ?? parseRemote(git(cwd, 'remote', 'get-url', 'origin'))?.repo;
if (!repo) {
  process.stderr.write('oafactory-mcp: could not read owner/name from the origin remote; pass --repo <owner/name>\n');
  process.exit(1);
}

// Start runs with the oafactory CLI this server was installed alongside, not whatever is on PATH.
const cli = join(dirname(createRequire(import.meta.url).resolve('oafactory')), 'bin.js');

serveStdio(() => createServer({
  cwd, repo, ledgerPath: values.ledger, allowRun: !!values['allow-run'],
  requestedBy: git(cwd, 'config', 'user.name') || process.env.USER || 'unknown',
  runCommand: [process.execPath, cli],
}), { onerror: (e) => process.stderr.write(`oafactory-mcp: ${e.message}\n`) });
