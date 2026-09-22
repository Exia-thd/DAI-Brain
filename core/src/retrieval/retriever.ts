import {
  type Citation, type FusionReport, type MemoryType, type Scope,
  type SearchRequest, type SearchResponse,
} from '@dai-brain/shared';
import type { CoreConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import type { EmbeddingProvider } from '../embed/index.js';
import { getItems } from '../storage/items.js';
import { scopeKey } from '../storage/scope-sql.js';
import { TtlCache } from './cache.js';
import { ftsSearch } from './fts.js';
import { graphSearch } from './graph.js';
import { pack } from './packer.js';
import { HeuristicReranker, NoopReranker, type RerankCandidate, type Reranker } from './rerank.js';
import { fuse } from './rrf.js';
import { vectorSearch } from './vector.js';
import type { BranchResult } from './branch.js';

/**
 * Branch weights.
 *
 * Vector leads because it is the only branch that generalises across wording.
 * FTS is close behind and carries the exact-identifier cases vector loses.
 * Graph is weighted lowest not because it matters least but because it is the
 * least precise: it returns what is *associated*, and association is a weaker
 * claim than resemblance. These are starting values -- `eval/` exists to move
 * them with evidence rather than taste.
 */
export const BRANCH_WEIGHTS: Record<string, number> = { vector: 1.0, fts: 0.9, graph: 0.6 };

/** Fusion sees more than it returns, so the reranker has something to reorder. */
const OVERFETCH = 4;

export interface RetrieverDeps {
  db: Db;
  config: CoreConfig;
  embedder: EmbeddingProvider;
  /** Whether `memory_items.embedding` is a pgvector column. Probed at boot. */
  isVector: boolean;
}

export class Retriever {
  private readonly cache: TtlCache<SearchResponse>;
  private readonly reranker: Reranker;
  private readonly noopReranker = new NoopReranker();

  constructor(private readonly deps: RetrieverDeps, reranker: Reranker = new HeuristicReranker()) {
    this.cache = new TtlCache(deps.config.searchCacheTtlMs, deps.config.searchCacheMax);
    this.reranker = reranker;
  }

  clearCache(): void { this.cache.clear(); }

  async search(scope: Scope, request: SearchRequest): Promise<SearchResponse> {
    const started = Date.now();
    const query = (request.query ?? '').trim();
    if (query.length === 0) {
      return {
        context: '', citations: [],
        fusion: { branches: {}, degraded: [], reasons: { query: 'empty query' }, k: 0 },
        tokens: { budget: request.maxTokens ?? this.deps.config.defaultMaxTokens, used: 0 },
        total: 0, omitted: 0, tookMs: 0,
      };
    }

    const limit = Math.min(request.limit ?? this.deps.config.defaultLimit, 50);
    const maxTokens = request.maxTokens ?? this.deps.config.defaultMaxTokens;
    const graphDepth = request.graphDepth ?? this.deps.config.defaultGraphDepth;
    const types = request.types;
    const wantRerank = request.rerank ?? false;

    const key = JSON.stringify([
      scopeKey(scope), query, limit, maxTokens, graphDepth, types ?? null,
      wantRerank, request.includeSuperseded ?? false,
    ]);
    const cached = this.cache.get(key);
    if (cached) return { ...cached, tookMs: Date.now() - started };

    const k = limit * OVERFETCH;
    const branches = await this.runBranches(scope, query, {
      k, graphDepth, types, includeSuperseded: request.includeSuperseded ?? false,
    });

    const { hits, report } = fuse(branches, BRANCH_WEIGHTS);
    const total = hits.length;

    // Hydrate only what can plausibly survive the budget. Fetching all of
    // `hits` would be a wasted round trip for the long tail RRF already ranked
    // out of contention.
    const shortlist = hits.slice(0, limit * 2);
    const items = await getItems(this.deps.db, scope, shortlist.map((h) => h.id));
    const byId = new Map(items.map((item) => [item.id, item]));

    let candidates: RerankCandidate[] = [];
    for (const hit of shortlist) {
      const item = byId.get(hit.id);
      // An id that fused but did not hydrate means the row moved out of scope
      // between the two queries. Dropping it is the safe read.
      if (!item) continue;
      candidates.push({ item, fusedScore: hit.score, ranks: hit.ranks });
    }

    const reranker = wantRerank ? this.reranker : this.noopReranker;
    candidates = (await reranker.rerank(query, candidates)).slice(0, limit);

    const packed = pack(candidates, query, { maxTokens });
    const response: SearchResponse = {
      context: packed.context,
      citations: packed.citations,
      fusion: this.withRerankNote(report, reranker.name),
      tokens: { budget: maxTokens, used: packed.usedTokens },
      total,
      // Everything fusion found that the caller is not seeing: ranked out by
      // the limit, or dropped by the budget. A limit answers "how much", never
      // "how much was there", and a caller shown three of nine should know.
      omitted: Math.max(0, total - candidates.length) + packed.omitted,
      tookMs: Date.now() - started,
    };

    this.cache.set(key, response);
    return response;
  }

  private withRerankNote(report: FusionReport, rerankerName: string): FusionReport {
    return {
      ...report,
      reasons: {
        ...report.reasons,
        ...(rerankerName === 'none'
          ? {}
          : { rerank: `reordered by the ${rerankerName} reranker` }),
      },
    };
  }

  private async runBranches(
    scope: Scope,
    query: string,
    options: { k: number; graphDepth: number; types?: MemoryType[]; includeSuperseded: boolean },
  ): Promise<BranchResult[]> {
    const { db, embedder, isVector } = this.deps;

    // All three run concurrently. They touch different indexes and none needs
    // another's output, so the pipeline costs the slowest branch rather than
    // their sum -- which is most of what keeps p95 under the budget.
    const [vector, fts, graph] = await Promise.all([
      (async (): Promise<BranchResult> => {
        try {
          const [queryVector] = await embedder.embed([query]);
          return await vectorSearch(db, scope, queryVector ?? [], isVector, {
            k: options.k, types: options.types, includeSuperseded: options.includeSuperseded,
          });
        } catch (err) {
          // A branch that throws must not take the search with it. Two working
          // branches are a worse answer than three, and far better than none.
          return {
            name: 'vector', ranked: [], scores: new Map(), tookMs: 0,
            unavailableReason: `embedding failed: ${(err as Error).message}`,
          };
        }
      })(),
      ftsSearch(db, scope, query, {
        k: options.k, types: options.types, includeSuperseded: options.includeSuperseded,
      }).catch((err: Error): BranchResult => ({
        name: 'fts', ranked: [], scores: new Map(), tookMs: 0,
        unavailableReason: `fts failed: ${err.message}`,
      })),
      graphSearch(db, scope, query, { k: options.k, depth: options.graphDepth })
        .catch((err: Error): BranchResult => ({
          name: 'graph', ranked: [], scores: new Map(), tookMs: 0,
          unavailableReason: `graph failed: ${err.message}`,
        })),
    ]);

    return [vector, fts, graph];
  }
}

export type { Citation };
