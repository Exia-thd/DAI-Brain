import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from './pool.js';
import { hasPgvector } from './capabilities.js';

const here = dirname(fileURLToPath(import.meta.url));
/** dist/db/ -> the package root, where `migrations/` is shipped. */
const MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  vectorMode: 'pgvector' | 'array';
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
  try {
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
  const vectorIndex = vector
    ? `CREATE INDEX IF NOT EXISTS memory_items_embedding_idx
  ON memory_items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`
    : '-- no ANN index: embeddings are stored as REAL[] and scanned exactly.';

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

  return { applied, skipped, vectorMode: vector ? 'pgvector' : 'array' };
}
