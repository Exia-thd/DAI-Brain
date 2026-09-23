/**
 * The vector branch must see the whole store.
 *
 * This file exists because of a bug that reported itself healthy. An IVFFlat
 * index created at migration time is trained on an empty table, and at the
 * default `probes = 1` a query scans one cluster — on a 62-item store that
 * returned 4 rows where an exact scan returned 62. Nothing failed, nothing was
 * marked degraded, and every recall number measured downstream was measured
 * against a fraction of the data.
 *
 * So the assertion is not "the branch works" but "the branch returns as many
 * items as exist". That is the property an ANN index is allowed to approximate
 * and this one destroyed.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { indexPlan } from '../core/dist/index.js';
import { openService, cleanup, freshScope, databaseAvailable } from './helpers.mjs';

test('the index plan refuses IVFFlat and says why', () => {
  const hnsw = indexPlan(true, '0.6.0');
  assert.equal(hnsw.mode, 'hnsw');
  assert.match(hnsw.ddl, /USING hnsw/);
  // A deployment carrying the old index must be repaired, not left alone.
  assert.match(hnsw.ddl, /DROP INDEX IF EXISTS memory_items_embedding_idx/);
  assert.doesNotMatch(hnsw.ddl, /ivfflat/i);
});

test('below pgvector 0.5 it builds no index rather than a mistrained one', () => {
  const old = indexPlan(true, '0.4.4');
  assert.equal(old.mode, 'none');
  assert.doesNotMatch(old.ddl, /CREATE INDEX/);
  assert.match(old.reason, /HNSW/);
  // The stale index still has to go: it is worse than nothing.
  assert.match(old.ddl, /DROP INDEX IF EXISTS/);
});

test('without pgvector there is nothing to index', () => {
  const none = indexPlan(false, null);
  assert.equal(none.mode, 'none');
  assert.doesNotMatch(none.ddl, /CREATE INDEX/);
});

const available = await databaseAvailable();

describe('the vector branch against a real index', { skip: available ? false : 'no Postgres at DATABASE_URL' }, () => {
  let service;
  const scope = freshScope('vec');
  /** Read back from the database, never assumed from the write loop. */
  let liveCount = 0;

  // Distinct vocabulary on purpose. Sixty variations on one sentence are, to
  // the reconciler, the same memory restated sixty times -- it supersedes most
  // of them, correctly, and a test that counted its own loop instead of the
  // store would blame the index for that.
  const WORDS = [
    'postgres', 'redis', 'kafka', 'nginx', 'docker', 'kubernetes', 'terraform',
    'ansible', 'grafana', 'jaeger', 'retrieval', 'embedding', 'tokenizer',
    'scheduler', 'compactor', 'allocator', 'serializer', 'validator', 'migrator',
    'planner', 'latency', 'throughput', 'quota', 'backpressure', 'idempotency',
    'partition', 'replica', 'checkpoint', 'snapshot', 'lineage', 'invoice',
    'payroll', 'shipment', 'warehouse', 'courier', 'customs', 'tariff',
    'manifest', 'pallet', 'forklift', 'chromatography', 'photosynthesis',
    'entropy', 'isotope', 'catalyst', 'polymer', 'enzyme', 'quasar', 'tectonic',
    'magnetar', 'sonnet', 'fugue', 'fresco', 'baroque', 'haiku', 'origami',
    'calligraphy', 'tapestry', 'mosaic', 'gargoyle',
  ];

  before(async () => {
    service = await openService();
    for (let i = 0; i < WORDS.length; i++) {
      await service.writeItem(scope, {
        type: 'note',
        content: `The ${WORDS[i]} component handles ${WORDS[(i * 7) % WORDS.length]} duties in production.`,
        source: 'test',
      });
    }
    const { rows } = await service.db.query(
      `SELECT count(*)::int AS n FROM memory_items
        WHERE tenant = $1 AND user_id = $2 AND project = $3
          AND superseded_by IS NULL AND embedding IS NOT NULL`,
      [scope.tenant, scope.user, scope.project],
    );
    liveCount = rows[0].n;
    assert.ok(liveCount > 40, `only ${liveCount} items survived reconciliation; the fixture is too similar`);
  });

  after(async () => {
    if (!service) return;
    await cleanup(service, scope);
    await service.close();
  });

  test('it returns every live item in the scope, not a fraction of them', async () => {
    const result = await service.search(scope, {
      query: 'which component handles production duties',
      limit: 50,
      maxTokens: 8000,
      graphDepth: 0,
    });
    // limit 50 over-fetches by 4, so the branch is asked for 200 and must find
    // all of them. Measured against the old IVFFlat index this returned 1.
    assert.equal(
      result.fusion.branches.vector, liveCount,
      `the vector branch saw ${result.fusion.branches.vector} of ${liveCount} live items`,
    );
  });

  test('a small limit truncates by the limit, never by the index', async () => {
    const small = await service.search(scope, {
      query: 'which component handles production duties',
      limit: 5,
      graphDepth: 0,
    });
    assert.equal(small.fusion.branches.vector, 20, 'limit 5 over-fetches to exactly 20');
  });

  test('the live index is HNSW or absent, never IVFFlat', async () => {
    const { embeddingIndex } = await import('../core/dist/index.js');
    const index = await embeddingIndex(service.db);
    assert.notEqual(
      index, 'ivfflat',
      'an IVFFlat index here was trained on an empty table and truncates silently',
    );
  });

  test('health reports the live index rather than assuming one', async () => {
    const health = await service.health();
    const detail = health.capabilities.vectorIndex.detail ?? '';
    assert.match(detail, /HNSW|exact scan/i);
    if (/IVFFlat/i.test(detail)) {
      assert.equal(health.capabilities.vectorIndex.status, 'degraded');
    }
  });
});
