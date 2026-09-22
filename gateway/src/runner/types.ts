import type { Scope } from '@dai-brain/shared';

/** One turn's worth of input to a Runner. */
export interface RunRequest {
  prompt: string;
  scope: Scope;
  /** Claude's session id from the previous turn, resumed when present. */
  resumeSessionId: string | null;
  /** Injected verbatim via --append-system-prompt. */
  systemPrompt: string;
  workdir: string;
  signal: AbortSignal;
}

/**
 * A line of Claude's stream-json output, loosely typed.
 *
 * Loosely on purpose: the CLI's schema is not frozen, and a Gateway that
 * rejects an unfamiliar field is a Gateway that breaks on a CLI upgrade. The
 * translator reads what it recognises and ignores the rest.
 */
export interface StreamLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  delta?: { type?: string; text?: string; partial_json?: string };
  content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  index?: number;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  [key: string]: unknown;
}

/**
 * What every Runner must provide.
 *
 * The interface exists so the CLI can be replaced by the Agent SDK without the
 * UI noticing: the plan flags per-request CLI startup as the likeliest latency
 * problem, and this is the seam that makes that swap a new file rather than a
 * rewrite.
 */
export interface Runner {
  readonly name: string;
  run(request: RunRequest): AsyncIterable<StreamLine>;
}
