import pg from 'pg';
import type { CoreConfig } from '../config.js';

export type Db = pg.Pool;

/**
 * `vector` columns arrive as the string '[1,2,3]'. Parsing them here rather than
 * at each call site means no query has to remember which storage mode is live.
 */
export function parseEmbedding(value: unknown): number[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length < 2) return null;
    const inner = trimmed.slice(1, -1);
    if (inner.length === 0) return [];
    return inner.split(',').map(Number);
  }
  return null;
}

export function createPool(config: CoreConfig): Db {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client that errors takes the process down with it unless something
  // is listening; a pool is expected to lose idle connections.
  pool.on('error', (err) => {
    console.error('[core] idle pg client error:', err.message);
  });
  return pool;
}
