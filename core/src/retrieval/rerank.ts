import { TYPE_WEIGHTS, type MemoryItem } from '@dai-brain/shared';
import { jaccard, tokenSet } from '../util/text.js';

export interface RerankCandidate {
  item: MemoryItem;
  /** The fused score that got it here. */
  fusedScore: number;
  ranks: Record<string, number>;
}

export interface Reranker {
  readonly name: string;
  rerank(query: string, candidates: RerankCandidate[]): Promise<RerankCandidate[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A year-old note scores about half a fresh one on the recency term alone. */
export const HALF_LIFE_DAYS = 180;

export function decay(timestamp: string, now = Date.now()): number {
  const age = Math.max(0, now - Date.parse(timestamp)) / DAY_MS;
  return 2 ** (-age / HALF_LIFE_DAYS);
}

/**
 * A blend of signals fusion cannot see, applied to the top of the list only.
 *
 * Not a cross-encoder, and it does not claim to be one: it reorders using the
 * three things the item itself knows and the ranks do not -- how much of the
 * query it literally covers, what kind of memory it is, and how old it is.
 * That is worth having because RRF is rank-only by construction, so it cannot
 * tell a decision from a passing note when both landed at rank 3.
 *
 * The seam is the point. `Reranker` is an interface so a real cross-encoder or
 * an LLM judge can replace this without the retriever noticing, and the eval
 * harness exists to say whether that swap earned its latency.
 */
export class HeuristicReranker implements Reranker {
  readonly name = 'heuristic';

  constructor(
    private readonly weights = { fused: 0.55, coverage: 0.25, type: 0.1, recency: 0.1 },
  ) {}

  async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankCandidate[]> {
    if (candidates.length <= 1) return candidates;
    const queryTokens = tokenSet(query);
    const maxFused = Math.max(...candidates.map((c) => c.fusedScore), Number.EPSILON);
    const now = Date.now();

    return [...candidates]
      .map((candidate) => {
        const coverage = jaccard(queryTokens, tokenSet(candidate.item.content));
        const type = TYPE_WEIGHTS[candidate.item.type] / 10;
        const recency = decay(candidate.item.updatedAt, now);
        const score =
          this.weights.fused * (candidate.fusedScore / maxFused)
          + this.weights.coverage * coverage
          + this.weights.type * type
          + this.weights.recency * recency;
        // Confidence multiplies rather than adds: a fact the extractor was
        // unsure of should not outrank a certain one by accumulating small
        // bonuses elsewhere.
        return { candidate, score: score * candidate.item.confidence };
      })
      .sort((a, b) => b.score - a.score || a.candidate.item.id.localeCompare(b.candidate.item.id))
      .map((scored) => ({ ...scored.candidate, fusedScore: scored.score }));
  }
}

/** The no-op, so `rerank: false` is a choice of strategy rather than a branch. */
export class NoopReranker implements Reranker {
  readonly name = 'none';
  async rerank(_query: string, candidates: RerankCandidate[]): Promise<RerankCandidate[]> {
    return candidates;
  }
}
