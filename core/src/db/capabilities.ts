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
  return {
    vectorIndex: vector
      ? { status: 'available', detail: 'pgvector ANN index' }
      : {
          status: 'degraded',
          detail: 'pgvector not installed; vector branch runs an exact scan (linear in item count)',
        },
    fts: { status: 'available', detail: "postgres tsvector, 'simple' config" },
    graph: { status: 'available', detail: 'entities/relations tables' },
    embeddings: embeddingDetail,
  };
}
