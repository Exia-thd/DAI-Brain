import type { MemoryType, Scope } from '@dai-brain/shared';
import type { Db } from '../db/pool.js';
import { scopeWhere } from '../storage/scope-sql.js';
import { toTsQuery } from '../util/text.js';
import type { BranchResult } from './branch.js';

export interface FtsOptions {
  k: number;
  types?: MemoryType[];
  includeSuperseded?: boolean;
}

/**
 * Postgres full-text search, the lexical half of the hybrid.
 *
 * It exists because vector search is bad at exactly what people search memory
 * for: an identifier, a flag name, a version number. Those carry no semantics
 * to embed and every embedder smears them into their neighbourhood, while a
 * posting list finds them exactly.
 *
 * `ts_rank_cd` rather than `ts_rank`: cover density rewards matches that occur
 * close together, which is what distinguishes an item genuinely about the query
 * from one that happens to use its words in three unrelated paragraphs.
 */
export async function ftsSearch(
  db: Db,
  scope: Scope,
  query: string,
  options: FtsOptions,
): Promise<BranchResult> {
  const started = Date.now();
  const name = 'fts';
  const tsq = toTsQuery(query);
  if (tsq.length === 0) {
    return {
      name, ranked: [], scores: new Map(), tookMs: Date.now() - started,
      degradedReason: 'query had no indexable terms after stopword removal',
    };
  }

  const params: unknown[] = [tsq];
  const clauses = [scopeWhere(scope, params), `tsv @@ websearch_to_tsquery('simple', $1)`];
  if (!options.includeSuperseded) clauses.push('superseded_by IS NULL');
  if (options.types?.length) clauses.push(`type = ANY($${params.push(options.types)}::text[])`);

  const { rows } = await db.query<{ id: string; rank: number }>(
    `SELECT id, ts_rank_cd(tsv, websearch_to_tsquery('simple', $1)) AS rank
       FROM memory_items WHERE ${clauses.join(' AND ')}
      ORDER BY rank DESC, updated_at DESC LIMIT $${params.push(options.k)}`,
    params,
  );

  return {
    name,
    ranked: rows.map((r) => r.id),
    scores: new Map(rows.map((r) => [r.id, Number(r.rank)])),
    tookMs: Date.now() - started,
  };
}
