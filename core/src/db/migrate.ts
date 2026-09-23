import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './pool.js';
import { hasPgvector, pgvectorVersion } from './capabilities.js';

const here = dirname(fileURLToPath(import.meta.url));
/** dist/db/ -> the package root, where `migrations/` is shipped. */
const MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  vectorMode: 'pgvector' | 'array';
  /** Which ANN index the schema ended up with, and why. */
  indexMode: 'hnsw' | 'none';
  indexReason: string;
}

/**
 * Chooses the embedding storage mode, then applies every unapplied migration.
 *
 * The extension is created rather than merely detected: on a fresh
 * docker-compose Postgres it is present but not enabled, and failing over to
 * the array mode there would quietly cost every later query its index.
 */
export async function migrate(db: Db, dims: number): Promise<MigrationResult> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  let vector = false;
  // An operator on a managed Postgres that cannot install extensions wants to
  // know the fallback works before committing to it, and a fallback nobody has
  // run is a fallback nobody should trust. This makes it reachable on a machine
  // where pgvector happens to be installed.
  const forced = process.env.DAI_DISABLE_PGVECTOR === 'true';
  try {
    if (forced) throw new Error('DAI_DISABLE_PGVECTOR=true');
    await db.query('CREATE EXTENSION IF NOT EXISTS vector');
    vector = await hasPgvector(db);
  } catch (err) {
    // Not fatal: the array mode is correct, just slower, and the degradation is
    // reported by /health rather than discovered by a confused operator.
    console.warn(
      `[core] pgvector unavailable, falling back to real[] storage: ${(err as Error).message}`,
    );
  }

  const embeddingType = vector ? `vector(${dims})` : 'REAL[]';
  const { ddl: vectorIndex, mode: indexMode, reason: indexReason } = indexPlan(
    vector, vector ? await pgvectorVersion(db) : null,
  );

  const { rows } = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const done = new Set(rows.map((r) => r.version));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) { skipped.push(version); continue; }
    const sql = (await readFile(join(MIGRATIONS_DIR, file), 'utf8'))
      .replaceAll('{{EMBEDDING_TYPE}}', embeddingType)
      .replaceAll('{{VECTOR_INDEX}}', vectorIndex);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      applied.push(version);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${version} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  return {
    applied, skipped,
    vectorMode: vector ? 'pgvector' : 'array',
    indexMode, indexReason,
  };
}

/**
 * Which ANN index to build, and whether to build one at all.
 *
 * HNSW rather than IVFFlat, because IVFFlat has to be *trained* on the vectors
 * already in the table: it clusters them into `lists` buckets and a query, at
 * the default `ivfflat.probes = 1`, scans exactly one bucket. Built at
 * migration time the table is empty, so the centroids are meaningless -- and
 * on a small store `lists = 100` spreads sixty rows across a hundred buckets,
 * which measured here returned 4 rows out of 62 where an exact scan returned
 * all 62.
 *
 * That is the worst shape a bug can take in this system. The branch does not
 * fail, so it never reports itself degraded; it just quietly answers with a
 * fraction of the store, and every number downstream is measured against the
 * fraction.
 *
 * HNSW needs no training data, so it is correct on an empty table, and it
 * stays correct as the store grows without anyone retuning `lists` and
 * `probes`. It costs more to build and more memory to hold, which at the scale
 * of a memory store is not a real cost.
 *
 * Below pgvector 0.5 there is no HNSW, and the honest answer is no index at
 * all: an exact scan is linear but correct, and the vector branch already
 * reports that fallback in its fusion report.
 */
export function indexPlan(
  vector: boolean,
  version: string | null,
): { ddl: string; mode: 'hnsw' | 'none'; reason: string } {
  if (!vector) {
    return {
      ddl: '-- no ANN index: embeddings are stored as REAL[] and scanned exactly.',
      mode: 'none',
      reason: 'pgvector not installed; embeddings stored as real[]',
    };
  }

  const major = Number.parseInt(version?.split('.')[0] ?? '0', 10);
  const minor = Number.parseInt(version?.split('.')[1] ?? '0', 10);
  const hasHnsw = major > 0 || minor >= 5;

  if (!hasHnsw) {
    return {
      ddl: `DROP INDEX IF EXISTS memory_items_embedding_idx;
-- pgvector ${version ?? '?'} has no HNSW, and an IVFFlat index built on an empty
-- table silently returns a fraction of the rows. An exact scan is slower and right.`,
      mode: 'none',
      reason: `pgvector ${version ?? '?'} predates HNSW; using exact scan rather than a mistrained IVFFlat index`,
    };
  }

  return {
    ddl: `DROP INDEX IF EXISTS memory_items_embedding_idx;
CREATE INDEX memory_items_embedding_idx
  ON memory_items USING hnsw (embedding vector_cosine_ops);`,
    mode: 'hnsw',
    reason: `pgvector ${version} HNSW index`,
  };
}
