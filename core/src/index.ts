export { loadConfig, type CoreConfig } from './config.js';
export { MemoryService, VERSION } from './service.js';
export { createCoreRouter, startCore } from './server.js';

export { createPool, parseEmbedding, type Db } from './db/pool.js';
export { migrate, indexPlan, type MigrationResult } from './db/migrate.js';
export {
  probe, embeddingIsVector, hasPgvector, pgvectorVersion, embeddingIndex,
  type Capabilities, type Capability,
} from './db/capabilities.js';

export {
  createEmbeddingProvider, HashEmbeddingProvider, TransformersEmbeddingProvider,
  cosine, l2normalize, type EmbeddingProvider,
} from './embed/index.js';

export { Retriever, BRANCH_WEIGHTS } from './retrieval/retriever.js';
export { fuse, RRF_K, type FusedHit, type FusionOutcome } from './retrieval/rrf.js';
export { vectorSearch } from './retrieval/vector.js';
export { ftsSearch } from './retrieval/fts.js';
export { graphSearch } from './retrieval/graph.js';
export { pack, packItems, type PackResult } from './retrieval/packer.js';
export {
  HeuristicReranker, NoopReranker, decay, HALF_LIFE_DAYS,
  type Reranker, type RerankCandidate,
} from './retrieval/rerank.js';
export { TtlCache } from './retrieval/cache.js';
export type { BranchResult } from './retrieval/branch.js';

export { redact, looksSecret, RULES, type RedactResult, type Rule } from './ingest/redact.js';
export { reconcile, type ReconcileInput, type ReconcileOptions } from './ingest/reconcile.js';
export {
  scanRepo, scanDocs, scanCommits, sections, entitiesOf,
  type RepoItem, type ScanOptions, type Section, type Commit,
} from './ingest/repo.js';

export * from './storage/items.js';
export * from './storage/entities.js';
export { scopeKey, scopeWhere } from './storage/scope-sql.js';
export { toItem, toEntity, toRelation, ITEM_COLUMNS } from './storage/rows.js';

export { normalize, tokenize, tokenSet, jaccard, toTsQuery, snippet } from './util/text.js';
export { contentHash, shortHash, itemId, entityId, relationId, randomId } from './util/ids.js';
