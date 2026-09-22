#!/usr/bin/env node
/**
 * `pnpm ingest:repo <path> --scope tenant/user/project`
 *
 * A CLI rather than an HTTP endpoint, on purpose. An endpoint taking a
 * server-side filesystem path would let anyone holding a token turn any file
 * the Core process can read into a memory they can then retrieve -- arbitrary
 * file disclosure wearing an ingestion API's clothes. The operator running
 * this already has the filesystem, so the CLI gives away nothing new.
 *
 * Everything goes through the normal write path: privacy filter, then the
 * reconciler. Re-running is safe -- identical sections come back `duplicate`,
 * an edited section supersedes its older phrasing.
 */

import { resolve } from 'node:path';
import { parseWriteScope } from '@dai-brain/shared';
import { loadConfig } from '../config.js';
import { MemoryService } from '../service.js';
import { scanRepo, type RepoItem } from './repo.js';

function arg(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 || at === process.argv.length - 1 ? fallback : process.argv[at + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

if (has('help') || process.argv.length < 3) {
  console.log(`Usage: pnpm ingest:repo <path> --scope <tenant/user/project> [options]

  --scope <t/u/p>   where the memories go                      (required)
  --dry-run         print what would be stored, store nothing
  --max-items <n>   ceiling on items produced                  (default 500)
  --max-commits <n> commits of history to read, 0 to skip git  (default 200)
  --since <date>    only commits at or after this date, e.g. 2025-01-01
  --min-chars <n>   below this a section is a fragment         (default 120)

Reads decision-shaped prose: ADRs, CONTRIBUTING, CLAUDE.md, architecture docs,
README sections that argue for a choice, and commit messages with a body.
It does not index code — symbols and call graphs go stale on the next commit,
and an agent with the repo checked out can read them directly.`);
  process.exit(0);
}

const root = resolve(process.argv[2]!);
const scopeArg = arg('scope');
if (!scopeArg) {
  console.error('--scope tenant/user/project is required: memory is never written unscoped.');
  process.exit(1);
}
const [tenant, user, project] = scopeArg.split('/');
const scope = parseWriteScope({ tenant, user, project });

const options = {
  maxItems: Number(arg('max-items', '500')),
  maxCommits: Number(arg('max-commits', '200')),
  minChars: Number(arg('min-chars', '120')),
  ...(arg('since') ? { since: arg('since') } : {}),
};

console.log(`[ingest] repo:  ${root}`);
console.log(`[ingest] scope: ${scope.tenant}/${scope.user}/${scope.project}`);

const items: RepoItem[] = await scanRepo(root, options);
const byType = items.reduce<Record<string, number>>((acc, item) => {
  acc[item.type] = (acc[item.type] ?? 0) + 1;
  return acc;
}, {});
console.log(`[ingest] found ${items.length} candidate memories: `
  + Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(' ') || '(none)');

if (has('dry-run')) {
  console.log('\n[ingest] dry run — nothing will be written\n');
  for (const item of items) {
    console.log(`  ${item.type.padEnd(10)} ${item.origin}`);
    console.log(`  ${''.padEnd(10)} ${item.source}`);
  }
  process.exit(0);
}

const service = await MemoryService.open(loadConfig());
const outcomes: Record<string, number> = {};
const rejected: string[] = [];

try {
  for (const item of items) {
    const { origin, ...request } = item;
    const result = await service.writeItem(scope, request);
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
    // A rejection is an outcome worth seeing: it usually means a doc has a
    // credential in it, which the operator wants to know about regardless.
    if (result.outcome === 'rejected') rejected.push(`${origin} — ${result.reason}`);
  }
} finally {
  await service.close();
}

console.log(`\n[ingest] ${Object.entries(outcomes).map(([o, n]) => `${o}=${n}`).join(' ') || 'nothing written'}`);
if (rejected.length > 0) {
  console.log(`\n[ingest] ${rejected.length} rejected by the privacy filter:`);
  for (const line of rejected) console.log(`  ${line}`);
}
