#!/usr/bin/env node
/**
 * The retrieval eval.
 *
 * It exists because every later optimisation -- a branch weight, a reranker, a
 * different embedder -- is a guess until something measures it. The plan puts
 * this in Phase 1 rather than at the end for exactly that reason: a retrieval
 * regression found in week 7 has had six weeks to be built on.
 *
 * Each run ingests the golden corpus into its own throwaway project scope, so
 * runs never see each other's data and the numbers are reproducible.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, MemoryService, type CoreConfig } from '@dai-brain/core';
import type { MemoryType, Scope, WriteScope } from '@dai-brain/shared';
import { formatReport, report, type QueryOutcome, type Report } from './metrics.js';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '..', 'data');

interface CorpusItem { ref: string; type: MemoryType; content: string; entities: string[] }
interface GoldenQuery { id: string; query: string; relevant: string[] }

interface Options {
  rerank: boolean;
  graphDepth: number;
  limit: number;
  maxTokens: number;
  /** Compare configurations in one run instead of reporting a single number. */
  compare: boolean;
  keep: boolean;
  minRecall: number;
  maxP95: number;
}

function parseArgs(argv: string[]): Options {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string, fallback: number) => {
    const at = argv.indexOf(`--${name}`);
    if (at === -1 || at === argv.length - 1) return fallback;
    const n = Number(argv[at + 1]);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    rerank: flag('rerank'),
    graphDepth: value('graph-depth', 1),
    limit: value('limit', 10),
    maxTokens: value('max-tokens', 1500),
    compare: flag('compare'),
    keep: flag('keep'),
    minRecall: value('min-recall', 0),
    maxP95: value('max-p95', 0),
  };
}

async function load<T>(file: string, key: string): Promise<T[]> {
  const parsed = JSON.parse(await readFile(join(DATA, file), 'utf8')) as Record<string, T[]>;
  const rows = parsed[key];
  if (!Array.isArray(rows)) throw new Error(`${file} has no '${key}' array`);
  return rows;
}

/**
 * Ingests the corpus and returns ref -> stored id.
 *
 * The mapping matters: ids are derived from content and scope, so they differ
 * per run, while `queries.json` is written against stable refs. Resolving one
 * to the other here is what lets the golden set outlive any particular store.
 */
async function ingest(
  service: MemoryService,
  scope: WriteScope,
  items: CorpusItem[],
): Promise<Map<string, string>> {
  const byRef = new Map<string, string>();
  for (const item of items) {
    const written = await service.writeItem(scope, {
      type: item.type,
      content: item.content,
      source: `eval:${item.ref}`,
      entities: item.entities.map((name) => ({ name })),
    });
    if (written.outcome === 'rejected') {
      throw new Error(`corpus item ${item.ref} was rejected: ${written.reason}`);
    }
    byRef.set(item.ref, written.item.id);
  }
  return byRef;
}

async function runQueries(
  service: MemoryService,
  scope: Scope,
  queries: GoldenQuery[],
  byRef: Map<string, string>,
  options: Options,
): Promise<QueryOutcome[]> {
  const outcomes: QueryOutcome[] = [];
  for (const golden of queries) {
    const started = Date.now();
    const result = await service.search(scope, {
      query: golden.query,
      limit: options.limit,
      maxTokens: options.maxTokens,
      graphDepth: options.graphDepth,
      rerank: options.rerank,
    });
    outcomes.push({
      id: golden.id,
      query: golden.query,
      relevant: golden.relevant.map((ref) => {
        const id = byRef.get(ref);
        if (!id) throw new Error(`query ${golden.id} references unknown corpus ref ${ref}`);
        return id;
      }),
      retrieved: result.citations.map((c) => c.id),
      // Measured here rather than read from `tookMs` so the number includes
      // everything a caller waits for, and so a cache hit cannot flatter it.
      latencyMs: Date.now() - started,
      degraded: result.fusion.degraded,
    });
  }
  return outcomes;
}

function formatMisses(outcomes: QueryOutcome[], byId: Map<string, string>): string {
  const misses = outcomes.filter((o) => !o.relevant.some((r) => o.retrieved.includes(r)));
  if (misses.length === 0) return '  (none)';
  return misses
    .map((m) => {
      const want = m.relevant.map((id) => byId.get(id) ?? id).join(', ');
      const got = m.retrieved.slice(0, 3).map((id) => byId.get(id) ?? id).join(', ') || '(nothing)';
      const why = m.degraded.length ? ` [degraded: ${m.degraded.join(', ')}]` : '';
      return `  ${m.id}  "${m.query}"\n       want ${want}\n       got  ${got}${why}`;
    })
    .join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config: CoreConfig = loadConfig();
  const items = await load<CorpusItem>('corpus.json', 'items');
  const queries = await load<GoldenQuery>('queries.json', 'queries');

  const project = `eval${Date.now().toString(36)}`;
  const scope: WriteScope = { tenant: 'eval', user: 'eval', project };

  const service = await MemoryService.open(config);
  try {
    console.log(`[eval] embedder: ${config.embeddingProvider} (${config.embeddingModel}, ${config.embeddingDims}d)`);
    console.log(`[eval] scope: ${scope.tenant}/${scope.user}/${scope.project}`);
    const ingestStart = Date.now();
    const byRef = await ingest(service, scope, items);
    console.log(`[eval] ingested ${byRef.size} items in ${Date.now() - ingestStart}ms\n`);

    const byId = new Map([...byRef].map(([ref, id]) => [id, ref]));

    const configurations: { label: string; options: Options }[] = options.compare
      ? [
          { label: 'vector+fts only (graph off)', options: { ...options, graphDepth: 0, rerank: false } },
          { label: 'all branches, no rerank', options: { ...options, graphDepth: 1, rerank: false } },
          { label: 'all branches, 2-hop graph', options: { ...options, graphDepth: 2, rerank: false } },
          { label: 'all branches + rerank', options: { ...options, graphDepth: 1, rerank: true } },
        ]
      : [{ label: `graphDepth=${options.graphDepth} rerank=${options.rerank}`, options }];

    let last: Report | null = null;
    for (const configuration of configurations) {
      // The cache is keyed by options, so configurations cannot contaminate
      // each other -- but clearing makes the latency numbers comparable rather
      // than measuring whichever run happened to go first.
      service.retriever.clearCache();
      const outcomes = await runQueries(service, scope, queries, byRef, configuration.options);
      last = report(outcomes);
      console.log(formatReport(configuration.label, last));
      if (!options.compare) {
        console.log('\n  misses:');
        console.log(formatMisses(outcomes, byId));
      }
      console.log('');
    }

    if (!options.keep) {
      await service.db.query(
        'DELETE FROM memory_items WHERE tenant = $1 AND user_id = $2 AND project = $3',
        [scope.tenant, scope.user, scope.project],
      );
      await service.db.query(
        'DELETE FROM entities WHERE tenant = $1 AND user_id = $2 AND project = $3',
        [scope.tenant, scope.user, scope.project],
      );
    } else {
      console.log(`[eval] kept data in project ${scope.project} (--keep)`);
    }

    // Thresholds are opt-in so a developer run never fails, and CI can turn
    // them on. This is what "run eval automatically on every retrieval change"
    // hangs off in Phase 6.
    if (last && options.minRecall > 0 && last.recallAt10 < options.minRecall) {
      console.error(`[eval] FAIL recall@10 ${last.recallAt10.toFixed(3)} < ${options.minRecall}`);
      process.exitCode = 1;
    }
    if (last && options.maxP95 > 0 && last.latencyP95 > options.maxP95) {
      console.error(`[eval] FAIL p95 ${last.latencyP95}ms > ${options.maxP95}ms`);
      process.exitCode = 1;
    }
  } finally {
    await service.close();
  }
}

await main();
