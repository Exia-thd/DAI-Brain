/**
 * What this deployment can actually do, probed once and recorded.
 *
 * Borrowed wholesale from the plugin: a branch that silently falls back is the
 * failure mode this layer is built around, so the fallback gets a name here and
 * that name reaches every fusion report and the /health endpoint.
 */

import type { Db } from './pool.js';

export type Status = 'available' | 'unavailable' | 'degraded';

export interface Capability {
  status: Status;
  detail?: string;
}

export interface Capabilities {
  /** pgvector present, so ANN search is real. */
  vectorIndex: Capability;
  fts: Capability;
  graph: Capability;
  embeddings: Capability;
  /** A deployment may probe more than these four; /health reports them all. */
  [name: string]: Capability;
}

/** The installed pgvector version, or null when the extension is absent. */
export async function pgvectorVersion(db: Db): Promise<string | null> {
  const { rows } = await db.query<{ v: string }>(
    `SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`,
  );
  return rows[0]?.v ?? null;
}

/** Which ANN index the live table actually has. `/health` reports it. */
export async function embeddingIndex(db: Db): Promise<'hnsw' | 'ivfflat' | 'none'> {
  const { rows } = await db.query<{ def: string }>(
    `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'memory_items_embedding_idx'`,
  );
  const def = rows[0]?.def ?? '';
  if (/USING hnsw/i.test(def)) return 'hnsw';
  if (/USING ivfflat/i.test(def)) return 'ivfflat';
  return 'none';
}

export async function hasPgvector(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_extension WHERE extname = 'vector'`,
  );
  return (rows[0]?.n ?? '0') !== '0';
}

/** True when the live `memory_items.embedding` column is a pgvector column. */
export async function embeddingIsVector(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ udt: string }>(
    `SELECT udt_name AS udt FROM information_schema.columns
      WHERE table_name = 'memory_items' AND column_name = 'embedding'`,
  );
  return rows[0]?.udt === 'vector';
}

export async function probe(db: Db, embeddingDetail: Capability): Promise<Capabilities> {
  const vector = await embeddingIsVector(db).catch(() => false);
  const index = vector ? await embeddingIndex(db).catch(() => 'none' as const) : 'none';
  return {
    vectorIndex: describeIndex(vector, index),
    fts: { status: 'available', detail: "postgres tsvector, 'simple' config" },
    graph: { status: 'available', detail: 'entities/relations tables' },
    embeddings: embeddingDetail,
  };
}

function describeIndex(vector: boolean, index: 'hnsw' | 'ivfflat' | 'none'): Capability {
  if (!vector) {
    return {
      status: 'degraded',
      detail: 'pgvector not installed; vector branch runs an exact scan (linear in item count)',
    };
  }
  switch (index) {
    case 'hnsw':
      return { status: 'available', detail: 'pgvector HNSW index' };
    case 'ivfflat':
      // Loud, because this is the shape the bug took: an IVFFlat index built
      // before the rows existed answers with a fraction of the store and never
      // says so. Run `pnpm migrate` to replace it.
      return {
        status: 'degraded',
        detail: 'legacy IVFFlat index: trained on an empty table, so the vector branch '
          + 'sees only a fraction of the store. Run `pnpm migrate` to rebuild it as HNSW.',
      };
    default:
      return {
        status: 'degraded',
        detail: 'no ANN index; the vector branch runs an exact scan (correct, linear in item count)',
      };
  }
}
