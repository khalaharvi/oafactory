import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The built-in Runner: a small coding agent with five tools. It runs inside the
 * Sandbox, reaches a model only through the Gateway with the run key, and has
 * no dependencies beyond Node itself, so any image with Node can host it.
 *
 * This file must not import anything outside node: builtins. It is executed on
 * its own (see agent-bin.ts), possibly from a read-only mount in a container.
 */

export interface AgentOptions {
  task: string;
  model: string;
  gatewayUrl: string;
  key: string;
  /** Which API shape the model alias is served with. */
  style: 'anthropic' | 'openai';
  cwd: string;
  maxTurns?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface AgentResult { turns: number; finished: boolean; summary: string; stopped?: string }

const SYSTEM = `You are a coding agent working in a checkout of a software project. Complete the task you are given by reading and editing files and running commands with the tools provided.

- Look before you change: list and read the relevant files first.
- Make the smallest change that completes the task. Do not touch unrelated files.
- If you change behaviour, add a new test file for it. Never edit, skip or delete an existing test to make it pass.
- Do not edit CI configuration, build scripts, or agent instruction files unless the task is specifically about them.
- Run the project's tests if you can, and fix what you broke.
- When the work is complete, call the finish tool with a one-paragraph summary of what you changed and anything you could not verify.

You cannot push, open pull requests or merge. Another process publishes the files you leave in the working directory.`;

interface ToolSpec { name: string; description: string; schema: Record<string, unknown> }
const str = (description: string) => ({ type: 'string', description });
export const TOOLS: ToolSpec[] = [
  { name: 'list_files', description: 'List files under a directory of the project, recursively. Skips .git and node_modules.', schema: { type: 'object', properties: { path: str('Directory relative to the project root. Defaults to the root.') } } },
  { name: 'read_file', description: 'Read a text file.', schema: { type: 'object', properties: { path: str('File path relative to the project root.') }, required: ['path'] } },
  { name: 'write_file', description: 'Create a file or replace its entire contents.', schema: { type: 'object', properties: { path: str('File path relative to the project root.'), content: str('The full new contents of the file.') }, required: ['path', 'content'] } },
  { name: 'replace_in_file', description: 'Replace one exact occurrence of a string in a file. Fails if the string is missing or appears more than once.', schema: { type: 'object', properties: { path: str('File path relative to the project root.'), old: str('The exact text to replace.'), new: str('The replacement text.') }, required: ['path', 'old', 'new'] } },
  { name: 'run_command', description: 'Run a shell command in the project root and return its output. Times out after two minutes.', schema: { type: 'object', properties: { command: str('The command to run with sh -c.') }, required: ['command'] } },
  { name: 'finish', description: 'Declare the task complete.', schema: { type: 'object', properties: { summary: str('What you changed, and anything you could not verify.') }, required: ['summary'] } },
];

const clip = (s: string, max = 12_000) => (s.length > max ? `${s.slice(0, max)}\n[output truncated: ${s.length - max} more characters]` : s);

/** Resolve a project-relative path, refusing anything that leaves the project or enters .git. */
export function safePath(cwd: string, p: unknown): string {
  if (typeof p !== 'string' || p === '') throw new Error('path must be a non-empty string');
  const root = resolve(cwd);
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`path ${p} is outside the project`);
  const rel = relative(root, abs).split(sep);
  if (rel[0] === '.git') throw new Error('the .git directory is off limits');
  return abs;
}

async function listFiles(root: string, dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) await listFiles(root, abs, out);
    else out.push(relative(root, abs).split(sep).join('/'));
    if (out.length >= 2000) break;
  }
  return out;
}

/** A fixed wrapper: drop the inherited Node flags, then run the command it is handed as its first argument. */
const UNRESTRICTED = 'unset NODE_OPTIONS; exec sh -c "$1"';

/**
 * Arguments for `sh` to run a command. Under Node's permission model, Node
 * passes its restrictions to every child through NODE_OPTIONS, which would stop
 * npm, test runners and any other Node program from reading their own files.
 * The restrictions are meant for this agent's file tools, not for the project's
 * commands, which the Sandbox confines. So a fixed wrapper drops them and then
 * runs the command, which it receives as an argument rather than as text
 * spliced into a script.
 */
export function shellArgs(command: string, underPermissionModel: boolean): string[] {
  return underPermissionModel ? ['-c', UNRESTRICTED, 'sh', command] : ['-c', command];
}

function runCommand(command: string, cwd: string): Promise<string> {
  return new Promise((res) => {
    const restricted = (process as { permission?: unknown }).permission !== undefined;
    const child = spawn('sh', shellArgs(command, restricted), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } out += '\n[timed out after 120 seconds]'; }, 120_000);
    child.on('error', (e) => { clearTimeout(timer); res(`could not run the command: ${e.message}`); });
    child.on('close', (code) => { clearTimeout(timer); res(clip(`${out}\n[exit status ${code}]`)); });
  });
}

/** Execute one tool call. Errors are returned to the model as text, never thrown. */
export async function runTool(cwd: string, name: string, input: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'list_files') {
      const dir = input.path ? safePath(cwd, input.path) : resolve(cwd);
      const files = (await listFiles(resolve(cwd), dir)).sort();
      return files.length ? clip(files.join('\n')) : '(no files)';
    }
    if (name === 'read_file') return clip(await readFile(safePath(cwd, input.path), 'utf8'), 60_000);
    if (name === 'write_file') {
      const abs = safePath(cwd, input.path);
      if (typeof input.content !== 'string') throw new Error('content must be a string');
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, input.content);
      return `wrote ${input.path} (${input.content.length} characters)`;
    }
    if (name === 'replace_in_file') {
      const abs = safePath(cwd, input.path);
      if (typeof input.old !== 'string' || typeof input.new !== 'string' || input.old === '') throw new Error('old and new must be strings, and old must not be empty');
      const text = await readFile(abs, 'utf8');
      const count = text.split(input.old).length - 1;
      if (count !== 1) throw new Error(`expected exactly one occurrence of the text in ${String(input.path)}, found ${count}`);
      await writeFile(abs, text.replace(input.old, () => input.new as string));
      return `replaced one occurrence in ${String(input.path)}`;
    }
    if (name === 'run_command') {
      if (typeof input.command !== 'string' || input.command.trim() === '') throw new Error('command must be a non-empty string');
      return await runCommand(input.command, resolve(cwd));
    }
    if (name === 'finish') return 'ok';
    return `unknown tool ${name}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

interface ToolCall { id: string; name: string; input: Record<string, unknown> }
interface Turn { text: string; calls: ToolCall[] }

/** One API shape: how to build the request, and how to read tool calls back and answer them. */
interface Dialect {
  request(): { path: string; headers: Record<string, string>; body: unknown };
  read(json: unknown): Turn;
  answer(results: Array<{ call: ToolCall; output: string }>): void;
}

function anthropic(o: AgentOptions, system: string): Dialect {
  const messages: unknown[] = [{ role: 'user', content: o.task }];
  return {
    request: () => ({
      path: '/v1/messages', headers: { 'x-api-key': o.key, 'anthropic-version': '2023-06-01' },
      body: { model: o.model, max_tokens: 8000, system, messages, tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) },
    }),
    read(json) {
      const content = ((json as { content?: unknown[] }).content ?? []) as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      messages.push({ role: 'assistant', content });
      return { text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), calls: content.filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id!, name: c.name!, input: c.input ?? {} })) };
    },
    answer(results) { messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.call.id, content: r.output })) }); },
  };
}

function openai(o: AgentOptions, system: string): Dialect {
  const messages: unknown[] = [{ role: 'system', content: system }, { role: 'user', content: o.task }];
  return {
    request: () => ({
      path: '/v1/chat/completions', headers: { authorization: `Bearer ${o.key}` },
      body: { model: o.model, messages, tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) },
    }),
    read(json) {
      const msg = ((json as { choices?: Array<{ message: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> }).choices?.[0]?.message) ?? {};
      messages.push({ role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
      const calls = (msg.tool_calls ?? []).map((c) => {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>; } catch { input = { __invalid: c.function.arguments }; }
        return { id: c.id, name: c.function.name, input };
      });
      return { text: msg.content ?? '', calls };
    },
    answer(results) { for (const r of results) messages.push({ role: 'tool', tool_call_id: r.call.id, content: r.output }); },
  };
}

/** Root instruction files, as they are in the checkout the Harness prepared (the base branch). */
async function projectInstructions(cwd: string): Promise<string> {
  const parts: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try { parts.push(`## ${name}\n${clip(await readFile(join(cwd, name), 'utf8'), 20_000)}`); } catch { /* absent */ }
  }
  return parts.length ? `\n\n# Project instructions\n\n${parts.join('\n\n')}` : '';
}

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const log = o.log ?? (() => {});
  const doFetch = o.fetch ?? fetch;
  const system = SYSTEM + (await projectInstructions(o.cwd));
  const dialect = o.style === 'anthropic' ? anthropic(o, system) : openai(o, system);
  const maxTurns = o.maxTurns ?? 40;
  // Trim trailing slashes without a regular expression: the URL is caller-supplied.
  let base = o.gatewayUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  let lastText = '';

  for (let turn = 1; turn <= maxTurns; turn++) {
    const req = dialect.request();
    const res = await doFetch(`${base}${req.path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...req.headers }, body: JSON.stringify(req.body) });
    if (res.status === 402) {
      log('the run has spent its budget; stopping');
      return { turns: turn - 1, finished: false, summary: lastText, stopped: 'budget' };
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`model request failed (${res.status}): ${text.slice(0, 400)}`);
    const reply = dialect.read(JSON.parse(text));
    if (reply.text) { lastText = reply.text; log(reply.text.split('\n')[0]!.slice(0, 160)); }
    if (reply.calls.length === 0) return { turns: turn, finished: true, summary: lastText };

    const results: Array<{ call: ToolCall; output: string }> = [];
    let summary: string | undefined;
    for (const call of reply.calls) {
      log(`tool ${call.name} ${JSON.stringify(call.input).slice(0, 120)}`);
      results.push({ call, output: await runTool(o.cwd, call.name, call.input) });
      if (call.name === 'finish') summary = String(call.input.summary ?? '');
    }
    if (summary !== undefined) return { turns: turn, finished: true, summary };
    dialect.answer(results);
  }
  return { turns: maxTurns, finished: false, summary: lastText, stopped: 'turn limit' };
}

/** Entry point when run as a process inside the Sandbox. Everything arrives in environment variables. */
export async function agentMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
  try {
    const style = need('OAFACTORY_API_STYLE');
    if (style !== 'anthropic' && style !== 'openai') throw new Error(`OAFACTORY_API_STYLE must be anthropic or openai, got ${style}`);
    const result = await runAgent({
      task: need('OAFACTORY_TASK'), model: need('OAFACTORY_MODEL'), gatewayUrl: need('OAFACTORY_GATEWAY_URL'), key: need('OAFACTORY_RUN_KEY'),
      style, cwd: process.cwd(), maxTurns: env.OAFACTORY_MAX_TURNS ? Number(env.OAFACTORY_MAX_TURNS) : undefined,
      log: (l) => process.stderr.write(`[agent] ${l}\n`),
    });
    process.stderr.write(`[agent] ${result.finished ? 'finished' : `stopped (${result.stopped})`} after ${result.turns} turn(s)\n`);
    process.stdout.write(`${result.summary}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`[agent] error: ${(e as Error).message}\n`);
    return 1;
  }
}
