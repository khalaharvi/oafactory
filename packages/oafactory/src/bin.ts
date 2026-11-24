#!/usr/bin/env node
// node:sqlite still prints an ExperimentalWarning on Node 22; it is noise for a CLI.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  (emit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const { main } = await import('./cli.js');
process.exitCode = await main(process.argv.slice(2));
