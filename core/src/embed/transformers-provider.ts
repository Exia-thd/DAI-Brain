import { l2normalize, type EmbeddingProvider } from './types.js';

type Pipeline = (texts: string[], opts: Record<string, unknown>) => Promise<{
  tolist(): number[][];
  dims?: number[];
}>;

/**
 * Sentence embeddings via `@huggingface/transformers`, loaded lazily.
 *
 * Lazily because the package is an optional dependency and the model is a
 * download: importing it at module load would make Core fail to boot on a
 * machine that only ever wanted the hash provider. The first `embed` call pays
 * the load; every later one is warm.
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'transformers';
  private pipe: Pipeline | null = null;
  private loading: Promise<Pipeline> | null = null;
  private failure: string | null = null;

  constructor(readonly model: string, readonly dims: number) {}

  private async load(): Promise<Pipeline> {
    if (this.pipe) return this.pipe;
    if (!this.loading) {
      this.loading = (async () => {
        const mod = await import('@huggingface/transformers' as string).catch((err: Error) => {
          throw new Error(
            `@huggingface/transformers is not installed (${err.message}). `
            + 'Install it or set DAI_EMBEDDING_PROVIDER=hash.',
          );
        });
        const pipeline = (mod as { pipeline: (task: string, model: string) => Promise<Pipeline> }).pipeline;
        const pipe = await pipeline('feature-extraction', this.model);
        this.pipe = pipe;
        return pipe;
      })().catch((err: Error) => {
        this.failure = err.message;
        this.loading = null;
        throw err;
      });
    }
    return this.loading;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const pipe = await this.load();
    const out = await pipe(texts, { pooling: 'mean', normalize: true });
    const rows = out.tolist() as unknown as number[][] | number[][][];
    // The pipeline returns [batch, dims] when pooled and [batch, tokens, dims]
    // when a model ignores the pooling hint; flatten the second case rather
    // than handing the caller a nested array it will silently mis-score.
    const flat: number[][] = rows.map((row) => {
      const first = (row as unknown[])[0];
      if (Array.isArray(first)) {
        const tokens = row as unknown as number[][];
        const dims = tokens[0]?.length ?? 0;
        const mean = new Array<number>(dims).fill(0);
        for (const t of tokens) for (let i = 0; i < dims; i++) mean[i]! += t[i]! / tokens.length;
        return mean;
      }
      return row as number[];
    });

    for (const vec of flat) {
      if (vec.length !== this.dims) {
        throw new Error(
          `embedding model ${this.model} returned ${vec.length} dims but the store was `
          + `created with ${this.dims}. Re-create the store with DAI_EMBEDDING_DIMS=${vec.length}.`,
        );
      }
    }
    return flat.map(l2normalize);
  }

  status() {
    if (this.failure) return { status: 'unavailable' as const, detail: this.failure };
    if (!this.pipe) return { status: 'available' as const, detail: `${this.model} (not yet loaded)` };
    return { status: 'available' as const, detail: this.model };
  }
}
