/** Core's configuration, read once at boot so a missing value fails loudly. */

export interface CoreConfig {
  databaseUrl: string;
  port: number;
  embeddingProvider: 'hash' | 'transformers';
  embeddingModel: string;
  embeddingDims: number;
  /** Default token budget for /search when the caller does not name one. */
  defaultMaxTokens: number;
  defaultLimit: number;
  defaultGraphDepth: number;
  /** Similarity at or above which the reconciler calls two items the same. */
  dedupeThreshold: number;
  searchCacheTtlMs: number;
  searchCacheMax: number;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer (got ${raw})`);
  return n;
}

function float(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got ${raw})`);
  return n;
}

export function loadConfig(env = process.env): CoreConfig {
  const provider = (env.DAI_EMBEDDING_PROVIDER ?? 'hash') as CoreConfig['embeddingProvider'];
  if (provider !== 'hash' && provider !== 'transformers') {
    throw new Error(`DAI_EMBEDDING_PROVIDER must be hash|transformers (got ${provider})`);
  }
  return {
    databaseUrl: env.DATABASE_URL
      ?? 'postgres://postgres:postgres@localhost:5432/daibrain',
    port: int('CORE_PORT', 8081),
    embeddingProvider: provider,
    embeddingModel: env.DAI_EMBEDDING_MODEL ?? (provider === 'hash' ? 'hash-v1' : 'Xenova/all-MiniLM-L6-v2'),
    embeddingDims: int('DAI_EMBEDDING_DIMS', 384),
    defaultMaxTokens: int('DAI_SEARCH_MAX_TOKENS', 1500),
    defaultLimit: int('DAI_SEARCH_LIMIT', 10),
    defaultGraphDepth: int('DAI_GRAPH_DEPTH', 1),
    dedupeThreshold: float('DAI_DEDUPE_THRESHOLD', 0.93),
    searchCacheTtlMs: int('DAI_SEARCH_CACHE_TTL_MS', 30_000),
    searchCacheMax: int('DAI_SEARCH_CACHE_MAX', 256),
  };
}
