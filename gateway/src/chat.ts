import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HttpError, errorEvent, humanSize, parseAttachments,
  type BrainEvent, type ChatRequest, type DecodedAttachment, type Scope, type WriteScope,
} from '@dai-brain/shared';
import { commandName, parseCommandTable, runCommand, type CommandTable } from './commands.js';
import type { GatewayConfig } from './config.js';
import { CoreClient, CoreUnavailable } from './core-client.js';
import { RunnerError } from './runner/claude-cli.js';
import type { Runner } from './runner/types.js';
import type { SessionStore, Conversation } from './sessions/types.js';
import { StreamTranslator } from './sse/translate.js';

/*
 * Written to be true whether or not a pre-fetch happened.
 *
 * The old preamble ended with "Below is memory that was retrieved for this
 * question" and was also used on the path where nothing is pre-fetched, so the
 * model was told to read memory that was not there. What it did instead was go
 * looking for the project on disk -- Read on a directory, Bash -- which is both
 * blocked and not the point. The pre-fetch sentence now only exists when there
 * is a pre-fetch to introduce.
 *
 * The tool names are described rather than listed because the server is the
 * operator's choice: Brain MCP calls them `memory_*`, the plugin calls them
 * `dai_memory_*`, and naming one of them here would misdirect the other setup.
 */
const SYSTEM_PREAMBLE = `You have access to this user's long-term memory through MCP tools whose names contain \`memory\` — \`memory_search\` and \`memory_write\`, or \`dai_memory_search\` and \`dai_memory_write\`, depending on which memory server is connected. List what you have and use it.

Those tools are how you learn about this user and their project. You cannot explore the project yourself: this is a chat window, not a coding session, and the shell tools are unavailable by design. If a question depends on the project, search memory rather than trying to list or run anything — and if memory has no answer, say that it has no answer instead of guessing. The exception is a file the user attaches to a message: read that, at the path given to you.

Search before answering anything that might depend on an earlier conversation: a past decision, a stated preference, a project convention. When you use a memory, cite its id so the user can check it. When the user states a decision, a preference, or a durable fact, write it to memory.`;

/** Appended only when a pre-fetch actually produced something to read. */
const PREFETCH_INTRO = 'Below is memory that was retrieved for this question before you were '
  + 'asked it. It may be enough on its own; if it is not, search for more.';

export interface ChatDeps {
  config: GatewayConfig;
  /** Null when memory comes from an MCP server the runner is given instead. */
  core: CoreClient | null;
  sessions: SessionStore;
  runner: Runner;
}

export interface ChatTurn {
  conversation: Conversation;
  events: AsyncIterable<BrainEvent>;
}

/**
 * Builds the system prompt for one turn: preamble plus pre-fetched memory.
 *
 * The pre-fetch exists because the first turn of a conversation is where a
 * model is least likely to think of searching and most likely to need it. One
 * cheap search, injected before it is asked, removes a round trip from the
 * common case -- and a failed pre-fetch degrades to "the model can still call
 * memory_search itself", which is why it is allowed to fail quietly here.
 */
export async function buildSystemPrompt(
  deps: ChatDeps,
  scope: Scope,
  question: string,
): Promise<string> {
  // Without Core there is nothing to pre-fetch from, and that is a setup, not
  // a failure: the model still has whatever memory tools the runner was given
  // and calls them itself.
  if (!deps.core || !deps.config.prefetchEnabled) return SYSTEM_PREAMBLE;
  try {
    const result = await deps.core.search(scope, {
      query: question,
      maxTokens: deps.config.prefetchTokens,
      limit: 8,
    });
    if (result.citations.length === 0) {
      return `${SYSTEM_PREAMBLE}\n\n(No memory matched this question in advance. Search if you need to.)`;
    }
    return `${SYSTEM_PREAMBLE}\n\n${PREFETCH_INTRO}\n\n${result.context}`;
  } catch (err) {
    if (!(err instanceof CoreUnavailable)) throw err;
    // Worth saying out loud: a Gateway quietly answering without memory looks
    // exactly like a Gateway whose memory is empty.
    console.warn(`[gateway] pre-fetch failed, continuing without it: ${err.message}`);
    return `${SYSTEM_PREAMBLE}\n\n(Memory pre-fetch was unavailable for this turn.)`;
  }
}

/**
 * Writes this turn's attachments next to the conversation, and says where.
 *
 * Next to the conversation rather than in the project directory, which is the
 * person's own repository: a chat window does not get to leave files in it. The
 * consequence is that the files sit outside the CLI's working directory, so the
 * directory has to be handed over explicitly -- see `addDirs` -- or the read is
 * refused with an error that looks like the file is missing.
 *
 * The names are already sanitised by `parseAttachments`; this only joins them.
 */
async function writeAttachments(
  workdir: string,
  attachments: DecodedAttachment[],
): Promise<{ dir: string | null; note: string; names: string[] }> {
  if (attachments.length === 0) return { dir: null, note: '', names: [] };

  const dir = join(workdir, 'uploads');
  await mkdir(dir, { recursive: true });

  const lines: string[] = [];
  for (const attachment of attachments) {
    const path = join(dir, attachment.name);
    await writeFile(path, attachment.bytes);
    lines.push(`  ${path}  (${attachment.type}, ${humanSize(attachment.bytes.length)})`);
  }

  // Appended to the user's message rather than the system prompt: it describes
  // this turn, and a resumed session would otherwise carry a previous turn's
  // attachment list into one that has none.
  const note = `\n\n---\nThe user attached ${attachments.length === 1 ? 'this file' : 'these files'} `
    + `to this message. Read ${attachments.length === 1 ? 'it' : 'them'} with the Read tool `
    + `before answering:\n${lines.join('\n')}`;

  return { dir, note, names: attachments.map((a) => a.name) };
}

export async function startChat(
  deps: ChatDeps,
  scope: WriteScope,
  request: ChatRequest,
  signal: AbortSignal,
): Promise<ChatTurn> {
  const message = request.message?.trim();
  if (!message) throw new Error('message is required');

  const conversation = request.conversationId
    ? await deps.sessions.get(scope, request.conversationId)
    : await deps.sessions.create(scope, titleFrom(message));

  if (!conversation) throw new Error(`no conversation ${request.conversationId} in this scope`);

  // Before the budget check, deliberately: refreshing memory is exactly what
  // somebody wants to do on a conversation that has run out of budget, and it
  // costs nothing to run.
  const command = commandName(message);
  if (command) {
    await deps.sessions.appendMessage(conversation.id, 'user', message);
    return {
      conversation,
      events: runCommandTurn(deps, conversation, command, signal),
    };
  }

  await assertWithinBudget(deps, conversation.id);

  const attachments = parseAttachments(request.attachments, {
    maxCount: deps.config.maxAttachments,
    maxTotalBytes: deps.config.maxAttachmentBytes,
  });
  const written = await writeAttachments(conversation.workdir, attachments);

  const systemPrompt = await buildSystemPrompt(deps, scope, message);

  // The transcript records what the person wrote plus what they attached, so
  // reopening the conversation shows the same thing the model was given. The
  // paths are not in it: they name a directory on this machine, and they mean
  // nothing to a reader a week later.
  const transcript = written.names.length > 0
    ? `${message}\n\n[attached: ${written.names.join(', ')}]`
    : message;
  await deps.sessions.appendMessage(conversation.id, 'user', transcript);

  return {
    conversation,
    events: stream(deps, conversation, message + written.note, systemPrompt, signal, written.dir),
  };
}

/**
 * Refuses a turn that would push a conversation past its budget.
 *
 * Checked before the process is spawned, because after it is spawned the money
 * is already spent. The ceiling is per conversation rather than global: a
 * runaway is almost always one conversation in a loop, and a global cap would
 * take everything else down with it.
 */
async function assertWithinBudget(deps: ChatDeps, conversationId: string): Promise<void> {
  const limit = deps.config.maxConversationCostUsd;
  if (limit <= 0) return;
  const { costUsd, turns } = await deps.sessions.spend(conversationId);
  if (costUsd < limit) return;
  throw new HttpError(
    402,
    'forbidden',
    `This conversation has spent $${costUsd.toFixed(2)} over ${turns} turns, which is at or above `
    + `the $${limit.toFixed(2)} ceiling. Start a new conversation, or raise `
    + 'GATEWAY_MAX_CONVERSATION_COST_USD.',
  );
}

/**
 * A command turn: no model, no cost, same six events.
 *
 * The transcript keeps the output so reopening the conversation still shows
 * what the scan said. The Claude session is not told about it -- the CLI keeps
 * its own history, and a resumed turn has no reason to know that a scan ran.
 */
async function* runCommandTurn(
  deps: ChatDeps,
  conversation: Conversation,
  command: string,
  signal: AbortSignal,
): AsyncIterable<BrainEvent> {
  const cwd = deps.config.projectDir ?? conversation.workdir;
  let output = '';
  try {
    for await (const event of runCommand(command, commandTable(deps), cwd, conversation.id, signal)) {
      if (event.type === 'message.delta') output += event.text;
      yield event;
    }
  } catch (err) {
    yield toErrorEvent(err);
  } finally {
    if (output.trim().length > 0) {
      await deps.sessions.appendMessage(conversation.id, 'assistant', output.trim()).catch(() => {});
    }
  }
}

/**
 * Parsed once per process.
 *
 * A bad table is the operator's mistake and should be loud, but it must not be
 * loud on every turn -- and re-reading it per request would let one edit hand
 * two conversations different commands.
 */
let commandCache: { raw: string; table: CommandTable } | null = null;
function commandTable(deps: ChatDeps): CommandTable {
  if (commandCache?.raw !== deps.config.commands) {
    commandCache = { raw: deps.config.commands, table: parseCommandTable(deps.config.commands) };
  }
  return commandCache.table;
}

async function* stream(
  deps: ChatDeps,
  conversation: Conversation,
  message: string,
  systemPrompt: string,
  signal: AbortSignal,
  uploadDir: string | null,
): AsyncIterable<BrainEvent> {
  const translator = new StreamTranslator(conversation.id);
  let failed = false;

  try {
    const lines = deps.runner.run({
      prompt: message,
      scope: conversation.scope,
      resumeSessionId: conversation.claudeSessionId,
      systemPrompt,
      workdir: conversation.workdir,
      addDirs: uploadDir ? [uploadDir] : [],
      signal,
    });

    for await (const line of lines) {
      for (const event of translator.translate(line)) {
        if (event.type === 'error') {
          failed = true;
          // Also to the terminal: the person running `pnpm chat` is watching
          // it, and a memory server that never came up is a setup problem they
          // fix there, not in the browser.
          console.warn(`[gateway] ${event.message}`);
        }
        if (event.type === 'message.done') {
          // Recorded before the event reaches the client, so a client that
          // hangs up on the last frame still leaves the spend accounted for.
          await deps.sessions.recordUsage(conversation.id, {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            costUsd: event.usage.costUsd,
          }).catch(() => {});
        }
        yield event;
      }
    }
  } catch (err) {
    failed = true;
    yield toErrorEvent(err);
  } finally {
    // Persist whatever the turn produced, even a partial answer from a stream
    // the client abandoned. A conversation that loses the answer it already
    // showed is worse than one that shows an incomplete answer twice.
    const sessionId = translator.claudeSessionId;
    if (sessionId && sessionId !== conversation.claudeSessionId) {
      await deps.sessions.bindClaudeSession(conversation.id, sessionId).catch(() => {});
    }
    const text = translator.text;
    if (text.length > 0) {
      await deps.sessions.appendMessage(conversation.id, 'assistant', text).catch(() => {});
      if (!failed) await queueWriteback(deps, conversation).catch(() => {});
    }
  }
}

/**
 * Hands the finished transcript to Core's write-back queue.
 *
 * Only on a clean turn: a transcript cut short by a timeout or a disconnect is
 * a conversation whose conclusions were never reached, and extracting "facts"
 * from one is how a memory store fills with half-thoughts.
 */
async function queueWriteback(deps: ChatDeps, conversation: Conversation): Promise<void> {
  if (!deps.config.writebackEnabled || !deps.core) return;
  const turns = await deps.sessions.messages(conversation.id);
  if (turns.length === 0) return;
  await deps.core.ingestTranscript(conversation.scope, {
    conversationId: conversation.id,
    turns,
  });
}

function toErrorEvent(err: unknown): BrainEvent {
  if (err instanceof RunnerError) {
    switch (err.code) {
      case 'timeout': return errorEvent('timeout', err.message);
      case 'cancelled': return errorEvent('cancelled', err.message);
      case 'spawn_failed': return errorEvent('runner_failed', err.message);
      default: return errorEvent('runner_failed', err.message);
    }
  }
  if (err instanceof CoreUnavailable) return errorEvent('upstream_failed', err.message);
  return errorEvent('internal', (err as Error).message);
}

/** A first-line title, so the conversation list is readable before the model answers. */
function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length <= 60 ? line : `${line.slice(0, 57)}…`;
}
