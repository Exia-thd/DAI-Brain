import type { ConversationSummary, Scope, WriteScope } from '@dai-brain/shared';

export interface Conversation {
  id: string;
  scope: WriteScope;
  title: string;
  claudeSessionId: string | null;
  workdir: string;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  /** Null when the runner did not report one. */
  costUsd: number | null;
}

/**
 * Where conversations live.
 *
 * Two implementations, and the reason there are two is the whole shape of the
 * product. Shared Postgres is what lets the Gateway run more than one instance
 * over one person's memory. A single person on one machine has no second
 * instance and no second person, so making them run a database server is cost
 * with nothing on the other side of it.
 *
 * The mapping to Claude's own session id is the part that has to survive a
 * restart either way: `--resume` is what makes a multi-turn conversation cheap,
 * and a Gateway that forgot it would silently turn every ongoing conversation
 * into a new one with no history.
 */
export interface SessionStore {
  readonly kind: 'postgres' | 'sqlite';
  create(scope: WriteScope, title: string): Promise<Conversation>;
  get(scope: Scope, id: string): Promise<Conversation | null>;
  bindClaudeSession(conversationId: string, sessionId: string): Promise<void>;
  setTitle(conversationId: string, title: string): Promise<void>;
  appendMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<void>;
  messages(conversationId: string): Promise<TranscriptMessage[]>;
  /**
   * Records what a turn cost.
   *
   * Kept per turn rather than as a running total, because a total cannot
   * answer "which conversation ran away" -- which is the question anyone asks
   * after a surprising bill.
   */
  recordUsage(conversationId: string, usage: TurnUsage): Promise<void>;
  /** What this conversation has cost so far, for the budget check and the UI. */
  spend(conversationId: string): Promise<{ costUsd: number; turns: number }>;
  list(scope: Scope, limit?: number): Promise<ConversationSummary[]>;
  delete(scope: Scope, id: string): Promise<boolean>;
  close(): Promise<void>;
}
