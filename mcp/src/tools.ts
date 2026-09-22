import { z } from 'zod';
import { MEMORY_TYPES, type Scope } from '@dai-brain/shared';
import type { CoreClient } from './core-client.js';

/**
 * The four tools.
 *
 * The descriptions are the real work here. They are not documentation -- they
 * are the prompt that decides whether Claude reaches for memory at the moment
 * it should, and a vague one produces a model that either never searches or
 * searches on every turn. So each says when to use it, when not to, and what
 * the result means, in that order.
 */

export interface ToolContext {
  core: CoreClient;
  /** Set by the transport from the X-Scope header the Gateway sent. */
  scope: Scope;
}

export const searchSchema = {
  query: z.string().describe(
    'What you want to remember, phrased as the question you are actually trying to answer. '
    + 'Full sentences work better than keywords. If the first search misses, rephrase with '
    + 'different words rather than repeating it — the branches key off wording differently.',
  ),
  maxTokens: z.number().int().min(100).max(8000).optional()
    .describe('Token budget for the returned context. Defaults to 1500. Raise it when you need breadth, lower it when you only need one fact.'),
  limit: z.number().int().min(1).max(50).optional().describe('Maximum number of memory items to return. Defaults to 10.'),
  types: z.array(z.enum(MEMORY_TYPES as unknown as [string, ...string[]])).optional()
    .describe('Restrict to these kinds of memory. Use `decision` when asking why something is the way it is, `preference` for how the user likes things done, `procedure` for how to do something.'),
  graphDepth: z.number().int().min(0).max(3).optional()
    .describe('How far to walk the entity graph from names found in the query. 1 is the default and usually right. 0 turns graph expansion off.'),
  rerank: z.boolean().optional().describe('Reorder results with a slower, more careful pass. Costs latency; worth it when the first page looked nearly right.'),
};

export const SEARCH_DESCRIPTION = `Search the user's long-term memory for anything they have told you before, in this conversation or any earlier one.

Use this whenever the answer might depend on something you were not told in this conversation: a past decision and its reasoning, a stated preference, a project convention, a fact about their systems, or what was concluded last time a topic came up. Prefer searching over guessing, and over asking the user something they have already told you.

Use it BEFORE answering, not after. A search that confirms you had it right costs a second; an answer that contradicts a decision the user made in March costs their trust.

Do not use it for general knowledge, for anything the user just said in this conversation, or for reading files — it holds remembered statements, not a filesystem.

Returns a packed context block plus citations. Each citation carries the memory's id, its type, where it came from and when. Cite the id when you use a memory, so the user can check it. The fusion report names any retrieval branch that was degraded — if it says a branch found nothing, a rephrased query may do better.`;

export const graphSchema = {
  name: z.string().describe('The entity to explore: a component, a person, a technology, a project. Use the name as the user would say it; matching ignores case and accents.'),
  depth: z.number().int().min(1).max(3).optional()
    .describe('How many hops to walk. 1 gives direct neighbours, 2 reaches their neighbours. Above 2 usually returns noise.'),
};

export const GRAPH_DESCRIPTION = `Explore what is connected to a named thing in the user's memory graph, and read the memories attached to those connections.

Use this when the question is about relationships rather than content: what depends on a component, what else was decided around a technology, what a project touches. It finds memories that never mention your search terms but hang off the same entity — the decision recorded under a component's name months before anyone asked about it.

Use memory_search first. Reach for this when search returned something relevant and you want the rest of the picture around it, or when the user names one specific thing and asks what it relates to.

Returns the entities reached, the relations between them, and the memory items attached. An empty result means that name is not in the graph — try memory_search, which matches on text rather than on entity names.`;

export const getSchema = {
  id: z.string().describe('The memory id, exactly as it appeared in a citation (it looks like `item_1a2b3c…`).'),
};

export const GET_DESCRIPTION = `Fetch one memory item in full by its id.

Use this when a search result was truncated and you need the whole thing, or when the user asks about a specific citation you showed them. The ids come from memory_search and memory_graph_explore citations; do not invent one.`;

export const writeSchema = {
  type: z.enum(MEMORY_TYPES as unknown as [string, ...string[]]).describe(
    'decision: a choice made and why. fact: something true about their systems or situation. '
    + 'preference: how they like things done. procedure: how to do something here. '
    + 'note: context worth keeping but not durable. artifact: a description of a file or resource.',
  ),
  content: z.string().min(3).describe(
    'The memory, written to be read months from now by someone without this conversation. '
    + 'State it in full: "We chose X over Y because Z", not "we decided on X". A memory that '
    + 'needs the surrounding conversation to make sense is a memory that will not survive it.',
  ),
  source: z.string().describe('Where this came from — the conversation, a file path, a URL. Required: a memory you cannot trace back is a memory the user cannot check.'),
  confidence: z.number().min(0).max(1).optional()
    .describe('How sure you are, 0 to 1. Default 1. Use below 0.8 when you inferred it rather than being told it.'),
  entities: z.array(z.object({
    name: z.string(),
    kind: z.string().optional().describe('e.g. component, person, technology, project'),
  })).optional().describe('Named things this memory is about. These build the graph, so a memory with entities is one that can be found by association later.'),
  supersedes: z.string().optional().describe('The id of a memory this replaces, when the user has changed their mind about something specific.'),
};

export const WRITE_DESCRIPTION = `Record something in the user's long-term memory so it is available in future conversations.

Use this when the user states a decision and its reasoning, tells you how they prefer things done, corrects a previous understanding, or establishes a fact about their systems that will still be true next month.

Do not use it for: anything already in memory (search first), transient details of the current task, your own conclusions the user has not confirmed, or anything containing a credential — those are rejected on arrival, and the rejection is reported back to you.

Write one memory per idea. Two decisions in one item cannot be superseded independently later.

The store reconciles automatically: an identical memory is a no-op, a near-duplicate supersedes the older phrasing, and a genuinely new one is inserted. The response says which happened, so you can tell the user "I already knew that" rather than claiming to have learned it.`;

// ---------------------------------------------------------------------------

export async function runSearch(
  ctx: ToolContext,
  args: { query: string; maxTokens?: number; limit?: number; types?: string[]; graphDepth?: number; rerank?: boolean },
): Promise<string> {
  const result = await ctx.core.search(ctx.scope, {
    query: args.query,
    maxTokens: args.maxTokens,
    limit: args.limit,
    types: args.types as never,
    graphDepth: args.graphDepth,
    rerank: args.rerank,
  });

  if (result.citations.length === 0) {
    const degraded = result.fusion.degraded
      .map((name) => `  - ${name}: ${result.fusion.reasons[name] ?? 'no reason given'}`)
      .join('\n');
    // Saying *why* nothing was found is the difference between the model
    // rephrasing usefully and the model concluding the user never said it.
    return `No memory matched "${args.query}".\n\nRetrieval detail:\n${degraded || '  all branches ran and matched nothing'}`;
  }

  const lines = [result.context, '', '---', `${result.total} item(s) matched, ${result.citations.length} returned, ${result.omitted} omitted for budget.`];
  if (result.fusion.degraded.length > 0) {
    lines.push(`Degraded branches: ${result.fusion.degraded.map((n) => `${n} (${result.fusion.reasons[n]})`).join('; ')}`);
  }
  return lines.join('\n');
}

export async function runGraph(
  ctx: ToolContext,
  args: { name: string; depth?: number },
): Promise<string> {
  const result = await ctx.core.graph(ctx.scope, args.name, args.depth ?? 1);
  if (!result.root) {
    return `"${args.name}" is not an entity in this memory graph. Try memory_search, which matches on text rather than entity names.`;
  }

  const byId = new Map(result.entities.map((e) => [e.id, e.name]));
  const edges = result.relations
    .map((r) => `  ${byId.get(r.fromEntity) ?? r.fromEntity} --${r.type}--> ${byId.get(r.toEntity) ?? r.toEntity}`)
    .join('\n');
  const items = result.items
    .map((i) => `  [${i.id}] (${i.type}) ${i.content.slice(0, 300)}`)
    .join('\n');

  return [
    `Entity: ${result.root.name} (${result.root.kind}), depth ${result.depth}`,
    `Connected entities (${result.entities.length}): ${result.entities.map((e) => e.name).join(', ')}`,
    '',
    `Relations (${result.relations.length}):`,
    edges || '  (none)',
    '',
    `Attached memories (${result.items.length}):`,
    items || '  (none)',
    result.truncated ? '\nNote: the subgraph hit its node cap and was truncated.' : '',
  ].join('\n');
}

export async function runGet(ctx: ToolContext, args: { id: string }): Promise<string> {
  const item = await ctx.core.getItem(ctx.scope, args.id);
  return [
    `[${item.id}] ${item.type}`,
    `source: ${item.source}`,
    `created: ${item.createdAt}  updated: ${item.updatedAt}  confidence: ${item.confidence}`,
    item.supersededBy ? `SUPERSEDED BY ${item.supersededBy} — this memory is out of date.` : '',
    '',
    item.content,
  ].filter(Boolean).join('\n');
}

export async function runWrite(
  ctx: ToolContext,
  args: {
    type: string; content: string; source: string; confidence?: number;
    entities?: { name: string; kind?: string }[]; supersedes?: string;
  },
): Promise<string> {
  const result = await ctx.core.writeItem(ctx.scope, {
    type: args.type as never,
    content: args.content,
    source: args.source,
    confidence: args.confidence,
    entities: args.entities,
    supersedes: args.supersedes,
  });

  switch (result.outcome) {
    case 'rejected':
      return `Not stored: ${result.reason}. Do not retry with the same content.`;
    case 'duplicate':
      return `Already known — nothing new was stored (${result.item.id}). Tell the user you already had this rather than that you learned it.`;
    case 'superseded':
      return `Stored as ${result.item.id}, replacing an earlier memory (${result.reason}). The old one is marked superseded, not deleted.`;
    case 'updated':
      return `Updated existing memory ${result.item.id}.`;
    default:
      return `Stored as ${result.item.id}.`;
  }
}
