import type { Scope } from '@dai-brain/shared';
import type { Db } from '../db/pool.js';
import { expand, itemsForEntities, linkEntities } from '../storage/entities.js';
import type { BranchResult } from './branch.js';

export interface GraphOptions {
  k: number;
  depth: number;
}

/**
 * Entity linking, then one or two hops, then the items hanging off what we reached.
 *
 * This is the branch that answers the question the other two cannot: "what else
 * is true about the thing you just asked about". Vector and FTS both rank items
 * by their resemblance to the query, so both are blind to the item that never
 * mentions the query's words but is attached to the same entity -- the decision
 * recorded under a component's name months before anyone asked about it.
 *
 * Items are scored by the hop count of the *nearest* entity that reached them,
 * so a fact one hop out ranks above the same fact found two hops away.
 */
export async function graphSearch(
  db: Db,
  scope: Scope,
  query: string,
  options: GraphOptions,
): Promise<BranchResult> {
  const started = Date.now();
  const name = 'graph';
  if (options.depth <= 0) {
    return { name, ranked: [], scores: new Map(), unavailableReason: 'graph expansion disabled (depth 0)', tookMs: 0 };
  }

  const seeds = await linkEntities(db, scope, query);
  if (seeds.length === 0) {
    return {
      name, ranked: [], scores: new Map(), tookMs: Date.now() - started,
      degradedReason: 'no entity in this scope matched the query text',
    };
  }

  const sub = await expand(db, scope, seeds.map((e) => e.id), options.depth);
  const pairs = await itemsForEntities(db, scope, [...sub.byDepth.keys()], options.k * 3);

  const best = new Map<string, number>();
  for (const pair of pairs) {
    const hop = sub.byDepth.get(pair.entityId) ?? options.depth;
    // 1.0 at the seed, halving per hop: near enough to matter, far enough to
    // let fusion decide against it.
    const score = 1 / (1 + hop);
    const current = best.get(pair.itemId);
    if (current === undefined || score > current) best.set(pair.itemId, score);
  }

  const ranked = [...best.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, options.k);

  return {
    name,
    ranked: ranked.map(([id]) => id),
    scores: new Map(ranked),
    tookMs: Date.now() - started,
    ...(sub.truncated ? { degradedReason: 'subgraph hit the node cap and was truncated' } : {}),
  };
}
