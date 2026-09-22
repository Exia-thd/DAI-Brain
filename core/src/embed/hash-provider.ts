import { createHash } from 'node:crypto';
import { tokenize } from '../util/text.js';
import { l2normalize, type EmbeddingProvider } from './types.js';

/**
 * A deterministic bag-of-words hashing embedder. No download, no network.
 *
 * It is not a good semantic model and does not pretend to be: two paraphrases
 * with no shared tokens land far apart. It exists so the eval harness, the
 * tests and a first `docker compose up` all work with nothing to fetch, and so
 * the vector branch is exercised on every developer machine rather than only
 * where a model happened to download. Swap it for `transformers` before you
 * trust a recall number.
 *
 * The signed hashing trick (each token lands in one bucket with a sign drawn
 * from the same hash) keeps collisions from systematically inflating
 * similarity, which unsigned hashing does.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash';
  readonly model: string;

  constructor(readonly dims: number, model = 'hash-v1') {
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.one(text));
  }

  private one(text: string): number[] {
    const vector = new Array<number>(this.dims).fill(0);
    const tokens = tokenize(text);
    if (tokens.length === 0) return vector;

    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    for (const [token, count] of counts) {
      const digest = createHash('sha256').update(token).digest();
      const bucket = digest.readUInt32BE(0) % this.dims;
      const sign = (digest[4]! & 1) === 0 ? 1 : -1;
      // Sublinear term frequency: a word repeated ten times is not ten times
      // the evidence, the same reason BM25 saturates tf.
      vector[bucket]! += sign * (1 + Math.log(count));
    }
    return l2normalize(vector);
  }

  status() {
    return {
      status: 'degraded' as const,
      detail: 'hash embedder: lexical only, no semantic generalisation. Set DAI_EMBEDDING_PROVIDER=transformers for real recall.',
    };
  }
}
