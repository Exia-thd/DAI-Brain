/**
 * The Core HTTP contract.
 *
 * Core owns retrieval; MCP and Gateway are adapters over these shapes. Keeping
 * the DTOs here rather than in Core is what lets the adapters be replaced --
 * Claude CLI for the API, this UI for another -- without the lobotomy of moving
 * retrieval logic out of the one service that owns it.
 */

import type { Scope } from './scope.js';

/** What a memory item is. `decision` outranks `note` when the packer runs out of budget. */
export type MemoryType = 'decision' | 'fact' | 'preference' | 'procedure' | 'note' | 'artifact';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'decision', 'fact', 'preference', 'procedure', 'note', 'artifact',
];

/**
 * What a type is worth, and therefore what survives the token budget.
 *
 * One number doing two jobs, borrowed from the plugin this Core grew out of:
 * the thing worth ranking highly is the thing worth keeping. A decision is why
 * the system is shaped as it is and does not expire. A note is what happened
 * once, useful for days and clutter after months.
 */
export const TYPE_WEIGHTS: Record<MemoryType, number> = {
  decision: 10,
  preference: 8,
  procedure: 7,
  fact: 6,
  artifact: 3,
  note: 2,
};

export interface MemoryItem {
  id: string;
  scope: Scope;
  type: MemoryType;
  content: string;
  /** Where this came from: a conversation id, a file ref, a URL. Never null. */
  source: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  /** Set when a newer item replaced this one. Items are superseded, never deleted. */
  supersededBy: string | null;
  /** Set by write-back so every derived item can be traced and rolled back. */
  conversationId: string | null;
}

export interface Entity {
  id: string;
  scope: Scope;
  name: string;
  kind: string;
  createdAt: string;
}

export type RelationType =
  | 'RELATES_TO' | 'DEPENDS_ON' | 'PART_OF' | 'CONTRADICTS' | 'SUPERSEDES' | 'MENTIONS';

export const RELATION_TYPES: readonly RelationType[] = [
  'RELATES_TO', 'DEPENDS_ON', 'PART_OF', 'CONTRADICTS', 'SUPERSEDES', 'MENTIONS',
];

export interface Relation {
  id: string;
  fromEntity: string;
  toEntity: string;
  type: RelationType;
  weight: number;
  /** The item that evidences this edge, so a relation can be checked. */
  evidenceItem: string | null;
}

// ---------------------------------------------------------------------------
// POST /search
// ---------------------------------------------------------------------------

export interface SearchRequest {
  query: string;
  /** Hard cap on the packed context. The packer never exceeds it. */
  maxTokens?: number;
  limit?: number;
  types?: MemoryType[];
  /** Graph expansion depth, 0 disables the branch. */
  graphDepth?: number;
  /** Off by default: it costs a model call, and the eval says when it earns it. */
  rerank?: boolean;
  /** Superseded items are excluded unless asked for. */
  includeSuperseded?: boolean;
}

export interface Citation {
  id: string;
  type: MemoryType;
  source: string;
  timestamp: string;
  score: number;
  /** Rank this item took in each branch, so a result can be explained. */
  ranks: Record<string, number>;
  snippet: string;
}

/** Which retrieval branches actually contributed, and why one did not. */
export interface FusionReport {
  branches: Record<string, number>;
  degraded: string[];
  reasons: Record<string, string>;
  k: number;
}

export interface SearchResponse {
  /** The packed context, ready to drop into a system prompt. */
  context: string;
  citations: Citation[];
  fusion: FusionReport;
  tokens: { budget: number; used: number };
  /** How many hits existed before the budget, and how many it dropped. */
  total: number;
  omitted: number;
  tookMs: number;
}

// ---------------------------------------------------------------------------
// GET /entities/{name}/graph
// ---------------------------------------------------------------------------

export interface GraphResponse {
  root: Entity | null;
  entities: Entity[];
  relations: Relation[];
  /** Items attached to any entity in the subgraph. */
  items: MemoryItem[];
  depth: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// POST /items  /  PATCH /items/{id}  /  DELETE /items/{id}
// ---------------------------------------------------------------------------

export interface WriteItemRequest {
  type: MemoryType;
  content: string;
  source: string;
  confidence?: number;
  conversationId?: string;
  entities?: { name: string; kind?: string }[];
  /** When set, the named item is marked superseded by this one. */
  supersedes?: string;
}

export interface WriteItemResponse {
  item: MemoryItem;
  /** What the reconciler decided. `duplicate` returns the existing item unchanged. */
  outcome: 'inserted' | 'updated' | 'superseded' | 'duplicate' | 'rejected';
  reason?: string;
}

// ---------------------------------------------------------------------------
// POST /ingest/transcript
// ---------------------------------------------------------------------------

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface IngestTranscriptRequest {
  conversationId: string;
  turns: TranscriptTurn[];
}

export interface IngestTranscriptResponse {
  jobId: string;
  queued: boolean;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  capabilities: Record<string, { status: 'available' | 'unavailable' | 'degraded'; detail?: string }>;
}
