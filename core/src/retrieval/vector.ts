import type { MemoryType, Scope } from '@dai-brain/shared';
import type { Db } from '../db/pool.js';
import { cosine } from '../embed/types.js';
import { scopeWhere } from '../storage/scope-sql.js';
import type { BranchResult } from './branch.js';

export interface VectorOptions {
  k: number;
  types?: MemoryType[];
  includeSuperseded?: boolean;
}

/**
 * Nearest neighbours by cosine distance.
 *
 * Two implementations behind one signature. With pgvector the ANN index does
 * the work; without it every embedded row in the scope is pulled and scored in
 * process. The second is not a stub -- it returns the same answer, and in fact
 * a more exact one -- but it is linear, so it names itself degraded and that
 * name travels into the fusion report rather than staying in a log nobody reads.
 */
export async function vectorSearch(
  db: Db,
  scope: Scope,
  queryVector: number[],
  isVector: boolean,
  options: VectorOptions,
): Promise<BranchResult> {
  const started = Date.now();
  const name = 'vector';
  if (queryVector.length === 0) {
    return { name, ranked: [], scores: new Map(), unavailableReason: 'query produced no embedding', tookMs: 0 };
  }

  const params: unknown[] = [];
  const clauses = [scopeWhere(scope, params), 'embedding IS NOT NULL'];
  if (!options.includeSuperseded) clauses.push('superseded_by IS NULL');
  if (options.types?.length) clauses.push(`type = ANY($${params.push(options.types)}::text[])`);
  const where = clauses.join(' AND ');

  if (isVector) {
    const vec = `[${queryVector.join(',')}]`;
    const { rows } = await db.query<{ id: string; distance: number }>(
      `SELECT id, (embedding <=> $${params.push(vec)}::vector) AS distance
         FROM memory_items WHERE ${where}
        ORDER BY distance ASC LIMIT $${params.push(options.k)}`,
      params,
    );
    const scores = new Map<string, number>();
    // `<=>` is cosine *distance*; the branch reports similarity so every branch
    // score reads the same direction (higher is better) for the reranker.
    for (const row of rows) scores.set(row.id, 1 - Number(row.distance));
    return { name, ranked: rows.map((r) => r.id), scores, tookMs: Date.now() - started };
  }

  const { rows } = await db.query<{ id: string; embedding: number[] | null }>(
    `SELECT id, embedding FROM memory_items WHERE ${where}`,
    params,
  );
  const scored: { id: string; score: number }[] = [];
  for (const row of rows) {
    if (!row.embedding) continue;
    scored.push({ id: row.id, score: cosine(queryVector, row.embedding) });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const top = scored.slice(0, options.k);
  return {
    name,
    ranked: top.map((s) => s.id),
    scores: new Map(top.map((s) => [s.id, s.score])),
    degradedReason: `pgvector not installed: scanned ${rows.length} embedded items exactly`,
    tookMs: Date.now() - started,
  };
}
