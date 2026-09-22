import type { FusionReport } from '@dai-brain/shared';
import type { BranchResult } from './branch.js';

/** The standard constant. */
export const RRF_K = 60;

export interface FusedHit {
  id: string;
  score: number;
  ranks: Record<string, number>;
}

export interface FusionOutcome {
  hits: FusedHit[];
  report: FusionReport;
}

/**
 * Reciprocal rank fusion, with a weight per branch.
 *
 * Rank-based rather than score-based because the three branches produce numbers
 * that are not comparable: a cosine similarity, a `ts_rank_cd` value and a hop
 * count share no scale, and normalising them would invent a relationship
 * between them that does not exist. Ranks are the one thing all three agree on.
 *
 * Every branch that contributed nothing is named in the report, with its
 * reason. A branch that returns empty and says nothing is how a hybrid quietly
 * decays into whichever branch still works -- and the operator's first sign is
 * a recall number that dropped weeks ago.
 */
export function fuse(
  branches: BranchResult[],
  weights: Record<string, number> = {},
  k = RRF_K,
): FusionOutcome {
  const scores = new Map<string, number>();
  const ranks = new Map<string, Record<string, number>>();
  const counts: Record<string, number> = {};
  const degraded: string[] = [];
  const reasons: Record<string, string> = {};

  for (const branch of branches) {
    counts[branch.name] = branch.ranked.length;

    if (branch.unavailableReason) {
      degraded.push(branch.name);
      reasons[branch.name] = branch.unavailableReason;
    } else if (branch.ranked.length === 0) {
      degraded.push(branch.name);
      // "No entity matched" is actionable; "matched nothing" is not. A branch
      // that knows why it is empty has more to say than the generic line.
      reasons[branch.name] = branch.degradedReason ?? 'Branch ran and matched nothing.';
    } else if (branch.degradedReason) {
      degraded.push(branch.name);
      reasons[branch.name] = branch.degradedReason;
    }

    const weight = weights[branch.name] ?? 1;
    for (const [index, id] of branch.ranked.entries()) {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank));
      let perBranch = ranks.get(id);
      if (!perBranch) { perBranch = {}; ranks.set(id, perBranch); }
      perBranch[branch.name] = rank;
    }
  }

  const hits = [...scores.entries()]
    .map(([id, score]) => ({ id, score, ranks: ranks.get(id) ?? {} }))
    // Ties broken by id rather than left to Map order: a search that returns
    // the same set in a different order each call cannot be evaluated.
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return { hits, report: { branches: counts, degraded, reasons, k } };
}
