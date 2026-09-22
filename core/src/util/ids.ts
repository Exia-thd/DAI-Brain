import { createHash } from 'node:crypto';

/** Stable, derived from content. Never random, so re-ingest is idempotent. */
export function contentHash(...parts: string[]): string {
  const h = createHash('sha256');
  for (const part of parts) {
    h.update(part);
    // Without a separator ['ab','c'] and ['a','bc'] hash identically, which
    // would let one scope's content collide with another's.
    h.update('\u0000');
  }
  return h.digest('hex');
}

export function shortHash(...parts: string[]): string {
  return contentHash(...parts).slice(0, 16);
}

export const itemId = (scopeKey: string, hash: string) => `item_${shortHash(scopeKey, hash)}`;
export const entityId = (scopeKey: string, nameNorm: string) => `ent_${shortHash(scopeKey, nameNorm)}`;
export const relationId = (from: string, to: string, type: string) => `rel_${shortHash(from, to, type)}`;

/** A random id, for the things that genuinely are events rather than content. */
export function randomId(prefix: string): string {
  return `${prefix}_${createHash('sha256')
    .update(`${Date.now()}:${Math.random()}:${process.pid}`)
    .digest('hex')
    .slice(0, 20)}`;
}
