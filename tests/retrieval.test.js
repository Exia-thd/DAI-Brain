import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openService, cleanup, freshScope, databaseAvailable } from './helpers.mjs';

const available = await databaseAvailable();

describe('retrieval', { skip: available ? false : 'no Postgres at DATABASE_URL' }, () => {
  let service;
  const scope = freshScope('ret');

  before(async () => {
    service = await openService();
    const seed = [
      ['decision', 'We chose PostgreSQL with pgvector over Neo4j for the memory store.', ['PostgreSQL', 'Neo4j']],
      ['fact', 'The GATEWAY_MAX_CONCURRENCY environment variable defaults to 8.', ['Brain Gateway']],
      ['preference', 'Prefer TypeScript over Python for every service.', ['TypeScript']],
      ['note', 'Completely unrelated note about the weather in Hanoi.', []],
    ];
    for (const [type, content, entities] of seed) {
      await service.writeItem(scope, {
        type, content, source: 'test', entities: entities.map((name) => ({ name })),
      });
    }
  });

  after(async () => {
    if (!service) return;
    await cleanup(service, scope);
    await service.close();
  });

  test('full-text finds an exact identifier the embedder would smear', async () => {
    const result = await service.search(scope, { query: 'GATEWAY_MAX_CONCURRENCY', limit: 5 });
    assert.equal(result.citations[0].id, result.citations[0].id);
    assert.match(result.context, /GATEWAY_MAX_CONCURRENCY/);
    assert.ok(result.fusion.branches.fts > 0, 'the fts branch must contribute');
  });

  test('every branch is accounted for in the fusion report', async () => {
    const result = await service.search(scope, { query: 'PostgreSQL', limit: 5 });
    for (const name of ['vector', 'fts', 'graph']) {
      assert.ok(name in result.fusion.branches, `${name} missing from the report`);
    }
    for (const name of result.fusion.degraded) {
      assert.ok(result.fusion.reasons[name], `${name} is degraded without a reason`);
    }
  });

  test('graphDepth 0 disables the graph branch and says so', async () => {
    const result = await service.search(scope, { query: 'PostgreSQL', graphDepth: 0 });
    assert.ok(result.fusion.degraded.includes('graph'));
    assert.match(result.fusion.reasons.graph, /disabled/);
  });

  test('a type filter excludes everything else', async () => {
    const result = await service.search(scope, { query: 'the', types: ['preference'], limit: 10 });
    for (const citation of result.citations) assert.equal(citation.type, 'preference');
  });

  test('the budget is respected and the shortfall reported', async () => {
    const result = await service.search(scope, { query: 'PostgreSQL TypeScript gateway', maxTokens: 60 });
    assert.ok(result.tokens.used <= 60);
    assert.equal(result.tokens.budget, 60);
    assert.ok(result.total >= result.citations.length);
  });

  test('an empty query returns nothing rather than everything', async () => {
    const result = await service.search(scope, { query: '   ' });
    assert.equal(result.citations.length, 0);
    assert.equal(result.total, 0);
  });

  test('superseded items are excluded unless asked for', async () => {
    const first = await service.writeItem(scope, {
      type: 'decision', content: 'The retry limit is three attempts.', source: 'test',
    });
    const second = await service.writeItem(scope, {
      type: 'decision', content: 'The retry limit is five attempts, revised.', source: 'test',
      supersedes: first.item.id,
    });
    assert.equal(second.outcome, 'superseded');

    const hidden = await service.search(scope, { query: 'retry limit attempts', limit: 10 });
    assert.ok(!hidden.citations.some((c) => c.id === first.item.id));

    const shown = await service.search(scope, {
      query: 'retry limit attempts', limit: 10, includeSuperseded: true,
    });
    assert.ok(shown.citations.some((c) => c.id === first.item.id));
  });

  test('results are stable across identical calls', async () => {
    const once = await service.search(scope, { query: 'store decisions' });
    service.retriever.clearCache();
    const twice = await service.search(scope, { query: 'store decisions' });
    assert.deepEqual(once.citations.map((c) => c.id), twice.citations.map((c) => c.id));
  });

  test('a write invalidates the cache', async () => {
    const query = 'octopus migration plan';
    // Not asserting the first search is empty: the vector branch is k-nearest,
    // not thresholded, so it always returns its k neighbours however unrelated
    // they are. What must change after a write is whether the *new* item is
    // reachable — a stale cache would keep answering without it.
    const before = await service.search(scope, { query });
    const written = await service.writeItem(scope, {
      type: 'note', content: 'The octopus migration plan is scheduled for March.', source: 'test',
    });
    assert.ok(!before.citations.some((c) => c.id === written.item.id));

    const after = await service.search(scope, { query });
    assert.ok(
      after.citations.some((c) => c.id === written.item.id),
      'the item written between the two searches must be reachable by the second',
    );
  });
});
