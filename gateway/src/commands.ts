import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { HttpError, type BrainEvent } from '@dai-brain/shared';

/**
 * Slash commands: operator-configured programs, run from the chat box.
 *
 * They exist because memory goes stale and nothing in MCP can refresh it. The
 * plugin's tools can search, read and write the store, but the store is built
 * by a scan, and a scan is a CLI command -- so after `git pull` the model is
 * answering about the repository as it was. Somebody has to run the scan, and
 * the only place the person already is, is the chat box.
 *
 * What keeps this from being "the Gateway shells out": the Gateway does not
 * know what any of these commands do. It is handed name -> argv by the
 * operator, runs it in the project directory, and streams what comes out. The
 * launcher is what knows that `sync` means the plugin's ingest, and swapping
 * the memory layer changes that one line rather than this file.
 *
 * Two properties this leans on:
 *
 *   - the message contributes nothing but the name. A command takes no
 *     arguments, ever, so there is no path from what somebody types to what
 *     gets executed -- only to which of the operator's entries is chosen.
 *   - argv, never a shell. Same reason as the runner: a command line
 *     reassembled by cmd.exe is a command line somebody else can extend.
 */

/** Anchored, and no arguments: a name is all a message can supply. */
const COMMAND = /^\/([a-z0-9][a-z0-9-]{0,31})$/i;

/** Output beyond this is dropped; a runaway scan must not fill the heap. */
const MAX_OUTPUT = 64 * 1024;

const TIMEOUT_MS = 10 * 60 * 1000;

export type CommandTable = Map<string, string[]>;

/**
 * Reads `GATEWAY_COMMANDS`: `{"sync": ["node", "...", "ingest"]}`.
 *
 * An array rather than a command line, because the alternative is quoting, and
 * quoting is how a path with a space in it becomes two arguments on the one
 * platform where paths have spaces in them.
 */
export function parseCommandTable(raw: string | undefined | null): CommandTable {
  const table: CommandTable = new Map();
  if (!raw || raw.trim().length === 0) return table;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GATEWAY_COMMANDS is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('GATEWAY_COMMANDS must be an object of name -> argv array');
  }

  for (const [name, argv] of Object.entries(parsed as Record<string, unknown>)) {
    if (!COMMAND.test(`/${name}`)) {
      throw new Error(`GATEWAY_COMMANDS: "${name}" is not a usable command name`);
    }
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string' && a.length > 0)) {
      throw new Error(`GATEWAY_COMMANDS: "${name}" must be a non-empty array of strings`);
    }
    table.set(name.toLowerCase(), argv as string[]);
  }
  return table;
}

/** The command a message names, or null when it is an ordinary message. */
export function commandName(message: string): string | null {
  const match = COMMAND.exec(message.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

function helpText(table: CommandTable): string {
  if (table.size === 0) {
    return 'No commands are configured on this Gateway.\n\n'
      + 'Set GATEWAY_COMMANDS to a JSON object of name → argv, for example:\n'
      + '  {"sync": ["dai-memory", "ingest"]}\n';
  }
  const lines = [...table.entries()].map(([name, argv]) => `  /${name}\n      ${argv.join(' ')}`);
  return `Commands, run in the project directory:\n\n${lines.join('\n')}\n\n  /help\n      this list\n`;
}

/**
 * Runs one command, as the six events the UI already knows.
 *
 * Reported as a tool call rather than a new event type: a command is the same
 * shape as one -- a named thing that runs, streams, and ends well or badly --
 * and the UI shows it with the chip and the spinner it already has.
 */
export async function* runCommand(
  name: string,
  table: CommandTable,
  cwd: string,
  conversationId: string,
  signal: AbortSignal,
): AsyncIterable<BrainEvent> {
  if (name === 'help') {
    yield { type: 'message.delta', text: helpText(table) };
    yield done(conversationId);
    return;
  }

  const argv = table.get(name);
  if (!argv) {
    throw new HttpError(
      400, 'not_found',
      `There is no /${name} command here. Try /help.`,
    );
  }

  const toolId = `cmd_${name}_${Date.now().toString(36)}`;
  yield { type: 'tool.start', toolId, name: `/${name}`, input: { command: argv.join(' ') } };

  const [command, ...args] = argv;
  if (!command) throw new HttpError(500, 'internal', `/${name} is configured with an empty command`);
  // Typed explicitly: with `signal` in the options the overloads collapse to
  // `never`, and the streams this reads become unreachable.
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(command, args, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], signal,
  }) as ChildProcessByStdio<null, Readable, Readable>;

  const chunks: string[] = [];
  let size = 0;
  let truncated = false;
  const collect = (chunk: Buffer) => {
    if (truncated) return;
    const text = chunk.toString('utf8');
    size += text.length;
    if (size > MAX_OUTPUT) {
      truncated = true;
      chunks.push('\n… output truncated.\n');
      return;
    }
    chunks.push(text);
  };

  const queue: string[] = [];
  let notify: (() => void) | null = null;
  const push = (text: string) => {
    queue.push(text);
    notify?.();
  };
  child.stdout.on('data', (chunk: Buffer) => { collect(chunk); push(chunk.toString('utf8')); });
  child.stderr.on('data', (chunk: Buffer) => { collect(chunk); push(chunk.toString('utf8')); });

  const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
  const finished = new Promise<{ code: number | null; error: Error | null }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }));
    child.once('close', (code) => resolve({ code, error: null }));
  });

  let settled: { code: number | null; error: Error | null } | null = null;
  void finished.then((result) => { settled = result; notify?.(); });

  try {
    // Drain as it arrives, so a scan that takes a minute shows a minute of
    // progress rather than a minute of nothing and then everything.
    for (;;) {
      while (queue.length > 0) yield { type: 'message.delta', text: queue.shift()! };
      if (settled) break;
      await new Promise<void>((resolve) => { notify = resolve; });
      notify = null;
    }
  } finally {
    clearTimeout(timer);
  }

  const result = settled as unknown as { code: number | null; error: Error | null };
  const ok = result.error === null && result.code === 0;
  const summary = result.error
    ? `could not start: ${result.error.message}`
    : result.code === 0 ? 'done' : `exited with code ${result.code}`;

  yield { type: 'tool.result', toolId, name: `/${name}`, ok, summary };
  if (!ok && chunks.length === 0) yield { type: 'message.delta', text: `${summary}\n` };
  yield done(conversationId);
}

function done(conversationId: string): BrainEvent {
  return {
    type: 'message.done',
    conversationId,
    sessionId: null,
    // A command costs nothing, and recording zero keeps it out of the spend
    // line rather than adding a turn that suggests a turn was paid for.
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    stopReason: 'command',
  };
}
