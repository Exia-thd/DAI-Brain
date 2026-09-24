/**
 * The Gateway -> UI event schema.
 *
 * One discriminated union, serialised as SSE `data:` lines. The UI switches on
 * `type` and nothing else, so a Runner swap -- `claude -p` today, the Agent SDK
 * later -- cannot reach the UI as long as the translator still emits these.
 */

import type { ChatAttachment } from './attachments.js';
import type { Citation } from './contracts.js';

export interface MessageDeltaEvent {
  type: 'message.delta';
  /** Text to append. Never a full re-render: the UI concatenates. */
  text: string;
}

export interface ToolStartEvent {
  type: 'tool.start';
  toolId: string;
  name: string;
  /** Already redacted by the translator; safe to show. */
  input: unknown;
}

export interface ToolResultEvent {
  type: 'tool.result';
  toolId: string;
  name: string;
  ok: boolean;
  /** A short human line, not the payload. Citations carry the payload. */
  summary: string;
}

/** Emitted when a `mcp__memory__*` tool result carries memory the answer may use. */
export interface CitationEvent {
  type: 'citation';
  toolId: string;
  citations: Citation[];
}

export interface MessageDoneEvent {
  type: 'message.done';
  conversationId: string;
  /** Claude's own session id, so the next turn can `--resume` it. */
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  stopReason: string | null;
}

export interface ErrorEvent {
  type: 'error';
  code: ErrorCode;
  message: string;
  /** True when the same request could succeed if retried. */
  retryable: boolean;
}

export type ErrorCode =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found'
  | 'scope_error' | 'timeout' | 'cancelled' | 'overloaded'
  | 'runner_failed' | 'upstream_failed' | 'internal';

export type BrainEvent =
  | MessageDeltaEvent | ToolStartEvent | ToolResultEvent
  | CitationEvent | MessageDoneEvent | ErrorEvent;

export const EVENT_TYPES: readonly BrainEvent['type'][] = [
  'message.delta', 'tool.start', 'tool.result', 'citation', 'message.done', 'error',
];

/** Whether an error is worth a retry, kept next to the codes so the two agree. */
export function retryable(code: ErrorCode): boolean {
  return code === 'timeout' || code === 'overloaded' || code === 'upstream_failed';
}

export function errorEvent(code: ErrorCode, message: string): ErrorEvent {
  return { type: 'error', code, message, retryable: retryable(code) };
}

// ---------------------------------------------------------------------------
// Gateway request shapes
// ---------------------------------------------------------------------------

export interface ChatRequest {
  /** Omit to start a new conversation; the Gateway mints one and returns it. */
  conversationId?: string;
  message: string;
  /** Pins the project within the caller's token scope. Never widens it. */
  project?: string;
  /** Files for this turn, base64. Written beside the conversation, then read. */
  attachments?: ChatAttachment[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}
