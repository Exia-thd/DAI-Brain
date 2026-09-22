/**
 * Retrieval metrics.
 *
 * Three numbers, because each one hides a different failure. Recall@k says
 * whether the right memory was found at all -- the only thing that matters when
 * the answer is packed into a prompt, since an item at rank 9 and an item at
 * rank 2 both get included. MRR says how high the *first* right answer sat,
 * which is what the token budget actually rewards when the budget is tight.
 * nDCG accounts for the rest of them, so a query with three right answers is
 * not scored as if it had one.
 */

export interface QueryOutcome {
  id: string;
  query: string;
  relevant: string[];
  /** Retrieved item ids, best first. */
  retrieved: string[];
  latencyMs: number;
  /** Branches the fusion report named as degraded, for the failure table. */
  degraded: string[];
}

export function recallAt(outcome: QueryOutcome, k: number): number {
  if (outcome.relevant.length === 0) return 1;
  const top = new Set(outcome.retrieved.slice(0, k));
  let found = 0;
  for (const id of outcome.relevant) if (top.has(id)) found++;
  return found / outcome.relevant.length;
}

/** 1 if a relevant item is at rank 1, 1/2 at rank 2, and 0 if none is in the top k. */
export function reciprocalRank(outcome: QueryOutcome, k: number): number {
  const relevant = new Set(outcome.relevant);
  for (let i = 0; i < Math.min(k, outcome.retrieved.length); i++) {
    if (relevant.has(outcome.retrieved[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export function ndcgAt(outcome: QueryOutcome, k: number): number {
  const relevant = new Set(outcome.relevant);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, outcome.retrieved.length); i++) {
    if (relevant.has(outcome.retrieved[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  let ideal = 0;
  for (let i = 0; i < Math.min(k, outcome.relevant.length); i++) ideal += 1 / Math.log2(i + 2);
  return ideal === 0 ? 1 : dcg / ideal;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: with 45 queries there is no meaningful interpolation to do,
  // and nearest-rank never reports a latency no request actually took.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface Report {
  queries: number;
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
  latencyP50: number;
  latencyP95: number;
  /** Queries where nothing relevant was retrieved at all. The ones worth reading. */
  misses: QueryOutcome[];
}

export function report(outcomes: QueryOutcome[]): Report {
  return {
    queries: outcomes.length,
    recallAt5: mean(outcomes.map((o) => recallAt(o, 5))),
    recallAt10: mean(outcomes.map((o) => recallAt(o, 10))),
    mrrAt10: mean(outcomes.map((o) => reciprocalRank(o, 10))),
    ndcgAt10: mean(outcomes.map((o) => ndcgAt(o, 10))),
    latencyP50: percentile(outcomes.map((o) => o.latencyMs), 50),
    latencyP95: percentile(outcomes.map((o) => o.latencyMs), 95),
    misses: outcomes.filter((o) => recallAt(o, 10) === 0),
  };
}

export function formatReport(label: string, r: Report): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return [
    `${label}`,
    `  queries      ${r.queries}`,
    `  recall@5     ${pct(r.recallAt5)}`,
    `  recall@10    ${pct(r.recallAt10)}`,
    `  MRR@10       ${r.mrrAt10.toFixed(3)}`,
    `  nDCG@10      ${r.ndcgAt10.toFixed(3)}`,
    `  latency p50  ${r.latencyP50}ms`,
    `  latency p95  ${r.latencyP95}ms`,
    `  total miss   ${r.misses.length}`,
  ].join('\n');
}
