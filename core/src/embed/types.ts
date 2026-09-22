export interface Embedding {
  vector: number[];
  model: string;
  dims: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
  /** What /health says about this provider, including why it is degraded. */
  status(): { status: 'available' | 'unavailable' | 'degraded'; detail?: string };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function l2normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}
