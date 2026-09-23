import {
  HttpError, errorEvent, type BrainEvent, type ChatRequest, type Scope, type WriteScope,
} from '@dai-brain/shared';
import type { GatewayConfig } from './config.js';
import { CoreClient, CoreUnavailable } from './core-client.js';
import { RunnerError } from './runner/claude-cli.js';
import type { Runner } from './runner/types.js';
import type { SessionStore, Conversation } from './sessions/types.js';
import { StreamTranslator } from './sse/translate.js';

const SYSTEM_PREAMBLE = `You have access to this user's long-term memory through the \`memory\` MCP server.

Search it before answering anything that might depend on an earlier conversation — a past decision, a stated preference, a project convention. When you use a memory, cite its id so the user can check it. When the user states a decision, a preference, or a durable fact, write it to memory.

Below is memory that was retrieved for this question before you were asked it. It may be enough on its own; if it is not, search for more.`;

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
    return `${SYSTEM_PREAMBLE}\n\n${result.context}`;
  } catch (err) {
    if (!(err instanceof CoreUnavailable)) throw err;
    // Worth saying out loud: a Gateway quietly answering without memory looks
    // exactly like a Gateway whose memory is empty.
    console.warn(`[gateway] pre-fetch failed, continuing without it: ${err.message}`);
    return `${SYSTEM_PREAMBLE}\n\n(Memory pre-fetch was unavailable for this turn.)`;
  }
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

  await assertWithinBudget(deps, conversation.id);

  const systemPrompt = await buildSystemPrompt(deps, scope, message);
  await deps.sessions.appendMessage(conversation.id, 'user', message);

  return { conversation, events: stream(deps, conversation, message, systemPrompt, signal) };
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

async function* stream(
  deps: ChatDeps,
  conversation: Conversation,
  message: string,
  systemPrompt: string,
  signal: AbortSignal,
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
      signal,
    });

    for await (const line of lines) {
      for (const event of translator.translate(line)) {
        if (event.type === 'error') failed = true;
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
