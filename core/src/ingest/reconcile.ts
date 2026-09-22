import type { MemoryItem, WriteItemResponse, WriteScope } from '@dai-brain/shared';
import type { Db } from '../db/pool.js';
import { parseEmbedding } from '../db/pool.js';
import { cosine, type EmbeddingProvider } from '../embed/index.js';
import { insertItem, supersede, type InsertItemInput } from '../storage/items.js';
import { scopeWhere } from '../storage/scope-sql.js';
import { ITEM_COLUMNS, toItem, type ItemRow } from '../storage/rows.js';
import { redact } from './redact.js';

export interface ReconcileOptions {
  /** At or above this cosine similarity, two items are the same memory. */
  dedupeThreshold: number;
  /** Below this confidence, a derived item is not stored at all. */
  minConfidence?: number;
  /** How many near neighbours to compare against. */
  neighbours?: number;
}

export interface ReconcileInput extends Omit<InsertItemInput, 'embedding' | 'embeddingModel'> {
  /** When the writer knows what this replaces, it says so and no guessing happens. */
  supersedes?: string;
}

/**
 * Decides what a new item does to the ones already there.
 *
 * Four outcomes, in the order they are checked:
 *
 *   rejected   - the privacy filter found a secret, or confidence is too low.
 *   duplicate  - an item with the same normalised content already exists. The
 *                insert touches `updated_at` and returns the existing row.
 *   superseded - the writer named what this replaces, or a near neighbour is
 *                close enough to be the same memory restated. The old row is
 *                marked, never deleted.
 *   inserted   - genuinely new.
 *
 * The near-neighbour case is the one that keeps write-back from producing a
 * hundred rows of "the user prefers TypeScript". Exact-hash dedupe cannot catch
 * it, because the extractor phrases it differently every run.
 */
export async function reconcile(
  db: Db,
  embedder: EmbeddingProvider,
  isVector: boolean,
  scope: WriteScope,
  input: ReconcileInput,
  options: ReconcileOptions,
): Promise<WriteItemResponse> {
  const filtered = redact(input.content);
  if (filtered.rejected) {
    return {
      item: placeholder(scope, input),
      outcome: 'rejected',
      reason: `privacy filter: ${filtered.rejectedBy}`,
    };
  }

  const confidence = input.confidence ?? 1.0;
  if (options.minConfidence !== undefined && confidence < options.minConfidence) {
    return {
      item: placeholder(scope, input),
      outcome: 'rejected',
      reason: `confidence ${confidence.toFixed(2)} below threshold ${options.minConfidence}`,
    };
  }

  const content = filtered.text.trim();
  if (content.length === 0) {
    return { item: placeholder(scope, input), outcome: 'rejected', reason: 'content empty after redaction' };
  }

  const [vector] = await embedder.embed([content]);
  const embedding = vector ?? null;

  const explicit = input.supersedes ?? null;
  const neighbour = explicit
    ? null
    : embedding
      ? await nearest(db, scope, embedding, isVector, options.neighbours ?? 5)
      : null;

  const match = neighbour && neighbour.similarity >= options.dedupeThreshold ? neighbour : null;

  const { item, inserted } = await insertItem(
    db,
    {
      ...input,
      content,
      confidence,
      embedding,
      embeddingModel: embedder.model,
    },
    isVector,
  );

  const target = explicit ?? match?.item.id ?? null;
  // The neighbour search runs before the insert, so on an exact repeat it finds
  // the very row the insert is about to touch -- same normalised content, same
  // derived id. Superseding that would orphan the item behind its own pointer,
  // so a self-match is not a supersede; it is what a duplicate looks like.
  if (target && target !== item.id) {
    const ok = await supersede(db, scope, target, item.id);
    if (ok) {
      return {
        item,
        outcome: 'superseded',
        reason: explicit
          ? `explicitly supersedes ${target}`
          : `similarity ${match!.similarity.toFixed(3)} >= ${options.dedupeThreshold}`,
      };
    }
  }

  if (!inserted) {
    return {
      item,
      outcome: 'duplicate',
      reason: 'identical content already stored; updated_at refreshed so recency reads as last confirmed',
    };
  }
  return { item, outcome: 'inserted' };
}

interface Neighbour { item: MemoryItem; similarity: number }

async function nearest(
  db: Db,
  scope: WriteScope,
  vector: number[],
  isVector: boolean,
  k: number,
): Promise<Neighbour | null> {
  const params: unknown[] = [];
  const where = [
    scopeWhere(scope, params),
    'embedding IS NOT NULL',
    'superseded_by IS NULL',
  ].join(' AND ');

  if (isVector) {
    const vec = `[${vector.join(',')}]`;
    const { rows } = await db.query<ItemRow & { distance: number }>(
      `SELECT ${ITEM_COLUMNS}, (embedding <=> $${params.push(vec)}::vector) AS distance
         FROM memory_items WHERE ${where}
        ORDER BY distance ASC LIMIT $${params.push(k)}`,
      params,
    );
    const best = rows[0];
    return best ? { item: toItem(best), similarity: 1 - Number(best.distance) } : null;
  }

  const { rows } = await db.query<ItemRow & { embedding: unknown }>(
    `SELECT ${ITEM_COLUMNS}, embedding FROM memory_items WHERE ${where}`,
    params,
  );
  let best: Neighbour | null = null;
  for (const row of rows) {
    const other = parseEmbedding(row.embedding);
    if (!other) continue;
    const similarity = cosine(vector, other);
    if (!best || similarity > best.similarity) best = { item: toItem(row), similarity };
  }
  return best;
}

/** A rejection still owes the caller a shaped item, so the DTO stays one type. */
function placeholder(scope: WriteScope, input: ReconcileInput): MemoryItem {
  const now = new Date().toISOString();
  return {
    id: '',
    scope,
    type: input.type,
    content: '',
    source: input.source,
    confidence: input.confidence ?? 1.0,
    createdAt: now,
    updatedAt: now,
    supersededBy: null,
    conversationId: input.conversationId ?? null,
  };
}
