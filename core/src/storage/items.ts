import type { MemoryItem, MemoryType, Scope, WriteScope } from '@dai-brain/shared';
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { contentHash, itemId } from '../util/ids.js';
import { normalize } from '../util/text.js';
import { ITEM_COLUMNS, toItem, type ItemRow } from './rows.js';
import { scopeKey, scopeWhere } from './scope-sql.js';

export type Queryable = Db | pg.PoolClient;

export interface InsertItemInput {
  scope: WriteScope;
  type: MemoryType;
  content: string;
  source: string;
  confidence?: number;
  conversationId?: string | null;
  embedding?: number[] | null;
  embeddingModel?: string | null;
}

/**
 * The dedupe key.
 *
 * Normalised rather than raw, so re-stating the same fact with different
 * casing or punctuation does not create a second row. Not similarity-based:
 * this catches the exact repeat cheaply and in the database, and the
 * reconciler handles the near-duplicate where it can afford a vector compare.
 */
export function hashOf(content: string): string {
  return contentHash(normalize(content));
}

/** Formats a vector for either storage mode. */
function embeddingParam(embedding: number[] | null | undefined, isVector: boolean): string | number[] | null {
  if (!embedding) return null;
  return isVector ? `[${embedding.join(',')}]` : embedding;
}

export async function insertItem(
  db: Queryable,
  input: InsertItemInput,
  isVector: boolean,
): Promise<{ item: MemoryItem; inserted: boolean }> {
  const hash = hashOf(input.content);
  const id = itemId(scopeKey(input.scope), hash);
  const { rows } = await db.query<ItemRow & { inserted: boolean }>(
    `INSERT INTO memory_items
       (id, tenant, user_id, project, type, content, content_hash, source,
        confidence, conversation_id, embedding, embedding_model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (tenant, user_id, project, content_hash) DO UPDATE
       -- Touching updated_at on a repeat is what makes recency mean "last
       -- confirmed" rather than "first written": a fact restated today is
       -- fresh evidence, not a stale row.
       SET updated_at = now(),
           confidence = GREATEST(memory_items.confidence, EXCLUDED.confidence),
           source = EXCLUDED.source
     RETURNING ${ITEM_COLUMNS}, (xmax = 0) AS inserted`,
    [
      id, input.scope.tenant, input.scope.user, input.scope.project,
      input.type, input.content, hash, input.source,
      input.confidence ?? 1.0, input.conversationId ?? null,
      embeddingParam(input.embedding, isVector), input.embeddingModel ?? null,
    ],
  );
  const row = rows[0]!;
  return { item: toItem(row), inserted: row.inserted };
}

export async function getItem(db: Queryable, scope: Scope, id: string): Promise<MemoryItem | null> {
  const params: unknown[] = [id];
  const { rows } = await db.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM memory_items
      WHERE id = $1 AND ${scopeWhere(scope, params)}`,
    params,
  );
  return rows[0] ? toItem(rows[0]) : null;
}

export async function getItems(db: Queryable, scope: Scope, ids: string[]): Promise<MemoryItem[]> {
  if (ids.length === 0) return [];
  const params: unknown[] = [ids];
  const { rows } = await db.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM memory_items
      WHERE id = ANY($1::text[]) AND ${scopeWhere(scope, params)}`,
    params,
  );
  return rows.map(toItem);
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  types?: MemoryType[];
  includeSuperseded?: boolean;
  /** Free-text filter for the memory explorer, not for retrieval. */
  contains?: string;
}

export async function listItems(
  db: Queryable,
  scope: Scope,
  options: ListOptions = {},
): Promise<{ items: MemoryItem[]; total: number }> {
  const params: unknown[] = [];
  const clauses = [scopeWhere(scope, params)];
  if (!options.includeSuperseded) clauses.push('superseded_by IS NULL');
  if (options.types?.length) clauses.push(`type = ANY($${params.push(options.types)}::text[])`);
  if (options.contains) clauses.push(`content ILIKE $${params.push(`%${options.contains}%`)}`);
  const where = clauses.join(' AND ');

  const { rows: countRows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM memory_items WHERE ${where}`,
    params,
  );
  const limit = Math.min(options.limit ?? 50, 500);
  const { rows } = await db.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM memory_items WHERE ${where}
      ORDER BY updated_at DESC, id
      LIMIT $${params.push(limit)} OFFSET $${params.push(options.offset ?? 0)}`,
    params,
  );
  return { items: rows.map(toItem), total: Number(countRows[0]?.n ?? 0) };
}

/**
 * Marks `oldId` superseded by `newId`.
 *
 * Both ids are resolved inside the scope first. Doing it in one UPDATE with a
 * scoped WHERE would be shorter, but it would also silently no-op when the id
 * belongs to another user -- and "nothing happened" is the wrong answer to
 * "supersede this", which the caller believes succeeded.
 */
export async function supersede(
  db: Queryable,
  scope: Scope,
  oldId: string,
  newId: string,
): Promise<boolean> {
  const params: unknown[] = [newId, oldId];
  const { rowCount } = await db.query(
    `UPDATE memory_items SET superseded_by = $1, updated_at = now()
      WHERE id = $2 AND ${scopeWhere(scope, params)}`,
    params,
  );
  return (rowCount ?? 0) > 0;
}

export async function updateItem(
  db: Queryable,
  scope: Scope,
  id: string,
  patch: { content?: string; type?: MemoryType; confidence?: number },
  embedding?: { vector: number[]; model: string } | null,
  isVector = true,
): Promise<MemoryItem | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  if (patch.content !== undefined) {
    sets.push(`content = $${params.push(patch.content)}`);
    sets.push(`content_hash = $${params.push(hashOf(patch.content))}`);
  }
  if (patch.type !== undefined) sets.push(`type = $${params.push(patch.type)}`);
  if (patch.confidence !== undefined) sets.push(`confidence = $${params.push(patch.confidence)}`);
  if (embedding) {
    sets.push(`embedding = $${params.push(embeddingParam(embedding.vector, isVector))}`);
    sets.push(`embedding_model = $${params.push(embedding.model)}`);
  }
  const idParam = params.push(id);
  const { rows } = await db.query<ItemRow>(
    `UPDATE memory_items SET ${sets.join(', ')}
      WHERE id = $${idParam} AND ${scopeWhere(scope, params)}
      RETURNING ${ITEM_COLUMNS}`,
    params,
  );
  return rows[0] ? toItem(rows[0]) : null;
}

export async function deleteItem(db: Queryable, scope: Scope, id: string): Promise<boolean> {
  const params: unknown[] = [id];
  const { rowCount } = await db.query(
    `DELETE FROM memory_items WHERE id = $1 AND ${scopeWhere(scope, params)}`,
    params,
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Undo: removes everything one write-back run created.
 *
 * The plan asks that write-back be reversible, and this is the whole of it --
 * which is only true because every derived item carries the conversation that
 * produced it. An item written by a person has a null conversation_id and is
 * never touched here.
 */
export async function deleteByConversation(
  db: Queryable,
  scope: Scope,
  conversationId: string,
): Promise<number> {
  const params: unknown[] = [conversationId];
  const { rowCount } = await db.query(
    `DELETE FROM memory_items
      WHERE conversation_id = $1 AND ${scopeWhere(scope, params)}`,
    params,
  );
  return rowCount ?? 0;
}

export async function countItems(db: Queryable, scope: Scope): Promise<number> {
  const params: unknown[] = [];
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM memory_items WHERE ${scopeWhere(scope, params)}`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}
