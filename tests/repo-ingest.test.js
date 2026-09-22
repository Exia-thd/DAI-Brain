import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sections, entitiesOf, scanDocs, scanCommits, scanRepo } from '../core/dist/index.js';
import { openService, cleanup, freshScope, databaseAvailable } from './helpers.mjs';

// --- sections -------------------------------------------------------------

test('a section carries its heading path so it reads standalone', () => {
  const out = sections([
    '# Guide', 'intro text that is long enough to matter',
    '## Retrieval', 'how retrieval works',
    '### Packer', 'how the packer works',
    '## Scope', 'how scope works',
  ].join('\n'));

  assert.deepEqual(out.map((s) => s.breadcrumb), [
    'Guide', 'Guide > Retrieval', 'Guide > Retrieval > Packer', 'Guide > Scope',
  ]);
  // A retrieved memory arrives without the document around it, so "Packer"
  // alone is the one thing the reader cannot reconstruct.
  assert.equal(out[2].body, 'how the packer works');
});

test('a # comment inside a code fence is not a heading', () => {
  const out = sections([
    '# Real heading', 'body',
    '```bash', '# this is a shell comment', 'echo hi', '```',
    'more body',
  ].join('\n'));
  assert.equal(out.length, 1, 'the fence must not split the section');
  assert.match(out[0].body, /shell comment/);
  assert.match(out[0].body, /more body/);
});

test('tilde fences work too, and an unclosed fence does not eat the file', () => {
  const out = sections(['# A', '~~~', '# not a heading', '~~~', '# B', 'text'].join('\n'));
  assert.deepEqual(out.map((s) => s.breadcrumb), ['A', 'B']);
});

test('a deeper heading after a shallower one resets the stack', () => {
  const out = sections(['## X', 'a', '# Y', 'b', '## Z', 'c'].join('\n'));
  assert.deepEqual(out.map((s) => s.breadcrumb), ['X', 'Y', 'Y > Z']);
});

test('markdown with no headings still yields its body', () => {
  const out = sections('just prose, no headings at all');
  assert.equal(out.length, 1);
  assert.equal(out[0].breadcrumb, '');
});

// --- entities -------------------------------------------------------------

test('backticked identifiers become entities, prose and paths do not', () => {
  const names = entitiesOf({
    breadcrumb: 'Guide > Token budget packer',
    body: 'Use `scopeWhere()` and `estimateTokens`, not `a/b/c/d.ts` or `some long phrase`.',
  }, 'docs/guide.md').map((e) => e.name);

  assert.ok(names.includes('scopeWhere'), 'trailing () is stripped');
  assert.ok(names.includes('estimateTokens'));
  assert.ok(!names.includes('a/b/c/d.ts'), 'a deep path is not an entity');
  assert.ok(!names.includes('some long phrase'), 'a backticked phrase is not an identifier');
  // The heading is what the section is about, and what a later question names.
  assert.ok(names.includes('Token budget packer'));
  assert.ok(names.includes('guide'));
});

test('readme and index are not entities', () => {
  const names = entitiesOf({ breadcrumb: '', body: 'text' }, 'README.md').map((e) => e.name);
  assert.ok(!names.includes('README'));
});

// --- scanning a repository ------------------------------------------------

describe('scanning a fixture repo', () => {
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'dai-repo-'));
    const write = async (path, text) => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), text, 'utf8');
    };
    const long = (s) => `${s} ${'padding words to clear the minimum length. '.repeat(5)}`;

    await write('README.md', [
      '# Project', long('A description of what this does.'),
      '## Storage', long('We chose Postgres over Neo4j because one database is less to operate.'),
    ].join('\n'));
    await write('CLAUDE.md', ['# Rules', long('Never hand-write a scope predicate.')].join('\n'));
    await write('CONTRIBUTING.md', ['# How to help', long('Run the tests before opening a PR.')].join('\n'));
    await write('docs/adr/0001-use-rrf.md', ['# Use RRF', long('Ranks are the only shared scale.')].join('\n'));
    await write('docs/guide.md', ['# Guide', long('This explains how to use the thing.')].join('\n'));
    // Must be ignored: generated, vendored, or not prose.
    await write('node_modules/pkg/README.md', ['# Dep', long('Somebody else docs.')].join('\n'));
    await write('dist/README.md', ['# Built', long('Generated output.')].join('\n'));
    await write('src/index.ts', 'export const x = 1;');
    await write('CHANGELOG-tiny.md', '# v1\n\ntoo short');
  });

  after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  test('it reads decision-shaped files and skips generated ones', async () => {
    const items = await scanDocs(root, { maxCommits: 0 });
    const sources = items.map((i) => i.source);

    assert.ok(sources.some((s) => s.startsWith('repo:docs/adr/0001-use-rrf.md')));
    assert.ok(sources.some((s) => s.startsWith('repo:CLAUDE.md')));
    assert.ok(sources.some((s) => s.startsWith('repo:CONTRIBUTING.md')));
    assert.ok(!sources.some((s) => s.includes('node_modules')), 'vendored docs are not ours');
    assert.ok(!sources.some((s) => s.includes('dist/')), 'generated docs go stale immediately');
    assert.ok(!sources.some((s) => s.includes('index.ts')), 'code is not ingested');
  });

  test('file intent sets the type, and arguing prose promotes it', async () => {
    const items = await scanDocs(root, { maxCommits: 0 });
    const typeOf = (needle) => items.find((i) => i.source.includes(needle))?.type;

    assert.equal(typeOf('adr/0001'), 'decision');
    assert.equal(typeOf('CLAUDE.md'), 'preference');
    assert.equal(typeOf('CONTRIBUTING.md'), 'procedure');
    // A README is description by default...
    assert.equal(items.find((i) => i.source.endsWith('#project'))?.type, 'artifact');
    // ...but a section that argues for a choice is a decision wherever it lives.
    assert.equal(items.find((i) => i.source.includes('README.md#project-storage'))?.type, 'decision');
  });

  test('short sections are fragments, not memories', async () => {
    const items = await scanDocs(root, { maxCommits: 0 });
    assert.ok(!items.some((i) => i.source.includes('CHANGELOG-tiny')));
  });

  test('every item is traceable back to its section', async () => {
    for (const item of await scanDocs(root, { maxCommits: 0 })) {
      assert.match(item.source, /^repo:.+#.*/);
      assert.ok(item.content.length > 0);
      assert.ok(item.entities.length > 0);
    }
  });

  test('maxItems is a hard ceiling', async () => {
    const items = await scanDocs(root, { maxItems: 2, maxCommits: 0 });
    assert.ok(items.length <= 2);
  });

  test('a directory that is not a git repo yields no commits rather than throwing', async () => {
    assert.deepEqual(await scanCommits(root, { maxCommits: 10 }), []);
  });
});

describe('scanning commits', () => {
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'dai-git-'));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    await writeFile(join(root, 'a.txt'), 'one', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore: bump deps');
    await writeFile(join(root, 'a.txt'), 'two', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'Switch to RRF', '-m',
      'We chose reciprocal rank fusion instead of blending scores, because the '
      + 'three branches produce numbers that share no scale and normalising them '
      + 'would invent a relationship that does not exist.\n\n'
      + 'Co-Authored-By: Someone <s@example.com>\nSigned-off-by: T <t@example.com>');
  });

  after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  test('a commit with no body carries nothing worth retrieving', async () => {
    const items = await scanCommits(root, { maxCommits: 10 });
    assert.equal(items.length, 1);
    assert.match(items[0].content, /Switch to RRF/);
  });

  test('an arguing commit body is a decision, and trailers are stripped', async () => {
    const [item] = await scanCommits(root, { maxCommits: 10 });
    assert.equal(item.type, 'decision');
    assert.match(item.source, /^git:[0-9a-f]{12}$/);
    // Trailers are metadata; left in, they make every commit look alike to the
    // embedder.
    assert.doesNotMatch(item.content, /Co-Authored-By/);
    assert.doesNotMatch(item.content, /Signed-off-by/);
  });

  test('maxCommits 0 skips git entirely', async () => {
    assert.deepEqual(await scanCommits(root, { maxCommits: 0 }), []);
    const all = await scanRepo(root, { maxCommits: 0 });
    assert.ok(!all.some((i) => i.source.startsWith('git:')));
  });
});

// --- end to end -----------------------------------------------------------

const available = await databaseAvailable();

describe('ingesting into a store', { skip: available ? false : 'no Postgres at DATABASE_URL' }, () => {
  let service;
  let root;
  const scope = freshScope('repo');

  before(async () => {
    service = await openService();
    root = await mkdtemp(join(tmpdir(), 'dai-ing-'));
    await mkdir(join(root, 'docs', 'adr'), { recursive: true });
    await writeFile(join(root, 'docs', 'adr', '0001.md'),
      '# Use Postgres\n\nWe chose Postgres over Neo4j because running one database '
      + 'is less operational work than running two, and the graph stays small.', 'utf8');
    await writeFile(join(root, 'CONTRIBUTING.md'),
      '# Contributing\n\nRun `pnpm test` before opening a pull request, and keep '
      + 'each change scoped to one concern so it can be reviewed on its own.', 'utf8');
  });

  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    if (!service) return;
    await cleanup(service, scope);
    await service.close();
  });

  test('a cold store can answer a question about the repo after ingesting', async () => {
    const before = await service.search(scope, { query: 'which database did we choose?' });
    assert.equal(before.citations.length, 0, 'the store starts empty');

    for (const item of await scanRepo(root, {})) {
      const { origin, ...request } = item;
      await service.writeItem(scope, request);
    }

    const after = await service.search(scope, { query: 'which database did we choose and why?' });
    assert.ok(after.citations.length > 0);
    assert.match(after.context, /Postgres/);
    assert.ok(after.citations.some((c) => c.source.includes('adr/0001')), 'provenance survives');
  });

  test('re-running does not duplicate', async () => {
    // Re-ingest is the normal case: docs change, someone runs it again. It has
    // to be safe, or the store fills with near-identical copies of a README.
    const items = await scanRepo(root, {});
    const outcomes = [];
    for (const item of items) {
      const { origin, ...request } = item;
      outcomes.push((await service.writeItem(scope, request)).outcome);
    }
    assert.ok(outcomes.every((o) => o === 'duplicate'), `expected all duplicate, got ${outcomes}`);

    const { total } = await service.listItems(scope, { limit: 500 });
    assert.equal(total, items.length);
  });

  test('a doc carrying a credential is rejected, not stored', async () => {
    await writeFile(join(root, 'CONTRIBUTING.md'),
      '# Contributing\n\nUse the deploy token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 '
      + 'when publishing a release from your own machine to the registry.', 'utf8');

    const items = await scanRepo(root, { maxCommits: 0 });
    const contributing = items.find((i) => i.source.includes('CONTRIBUTING'));
    assert.ok(contributing, 'the file is still scanned');

    const { origin, ...request } = contributing;
    const result = await service.writeItem(scope, request);
    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /privacy filter/);
  });
});
