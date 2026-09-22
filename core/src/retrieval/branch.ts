/** What every retrieval branch returns. */
export interface BranchResult {
  name: string;
  /** Ordered item ids, best first. */
  ranked: string[];
  /** Raw per-branch score, kept for debugging and for the reranker's input. */
  scores: Map<string, number>;
  /** Set when the branch could not run, as opposed to running and matching nothing. */
  unavailableReason?: string;
  /** Set when it answered through a lesser route than intended. */
  degradedReason?: string;
  tookMs: number;
}

export function emptyBranch(name: string, reason: string): BranchResult {
  return { name, ranked: [], scores: new Map(), unavailableReason: reason, tookMs: 0 };
}
