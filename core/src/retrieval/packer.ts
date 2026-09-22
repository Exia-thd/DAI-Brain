import {
  estimateTokens, truncateToTokens, type Citation, type MemoryItem,
} from '@dai-brain/shared';
import { snippet } from '../util/text.js';
import type { RerankCandidate } from './rerank.js';

export interface PackOptions {
  maxTokens: number;
  /** No single item may take more than this share of the budget. */
  maxItemShare?: number;
  snippetChars?: number;
}

export interface PackResult {
  context: string;
  citations: Citation[];
  usedTokens: number;
  omitted: number;
}

const HEADER = 'Relevant memory from DAI Brain. Cite an item by its id when you use it.';

/**
 * Turns ranked items into a block of text that fits a token budget.
 *
 * Two rules, both learned the hard way. One item may not eat the budget: a
 * single long artifact would otherwise crowd out the five short decisions that
 * actually answer the question, so each is capped at a share of the total and
 * truncated rather than dropped. And packing does not stop at the first item
 * that does not fit -- it keeps going, because the item after a long one is
 * often short and still useful. Stopping early is how a 1000-token budget ends
 * up carrying 300 tokens.
 *
 * Every line carries the id, so a citation can be resolved back to the row and
 * the UI can show what the answer was built from.
 */
export function pack(candidates: RerankCandidate[], query: string, options: PackOptions): PackResult {
  const budget = Math.max(0, options.maxTokens);
  const perItemCap = Math.max(32, Math.floor(budget * (options.maxItemShare ?? 0.35)));
  const snippetChars = options.snippetChars ?? 400;

  const lines: string[] = [];
  const citations: Citation[] = [];
  let used = estimateTokens(HEADER);
  let omitted = 0;

  for (const candidate of candidates) {
    const item = candidate.item;
    const remaining = budget - used;
    if (remaining <= 16) { omitted++; continue; }

    const text = snippet(item.content, query, snippetChars);
    const label = `[${item.id}] (${item.type}, ${item.createdAt.slice(0, 10)}, src=${item.source})`;
    const labelTokens = estimateTokens(label) + 2;
    const bodyBudget = Math.min(perItemCap, remaining) - labelTokens;
    if (bodyBudget <= 8) { omitted++; continue; }

    const body = truncateToTokens(text, bodyBudget);
    if (body.length === 0) { omitted++; continue; }

    const line = `${label}\n${body}`;
    lines.push(line);
    used += estimateTokens(line) + 1;
    citations.push({
      id: item.id,
      type: item.type,
      source: item.source,
      timestamp: item.createdAt,
      score: Number(candidate.fusedScore.toFixed(6)),
      ranks: candidate.ranks,
      snippet: snippet(item.content, query, 200),
    });
  }

  return {
    context: lines.length === 0 ? '' : `${HEADER}\n\n${lines.join('\n\n')}`,
    citations,
    usedTokens: lines.length === 0 ? 0 : used,
    omitted,
  };
}

/** Used by the Gateway's pre-fetch, which wants the text without the citations. */
export function packItems(items: MemoryItem[], query: string, maxTokens: number): string {
  return pack(
    items.map((item) => ({ item, fusedScore: 0, ranks: {} })),
    query,
    { maxTokens },
  ).context;
}
