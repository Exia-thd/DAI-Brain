import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuse, RRF_K } from '../core/dist/index.js';

const branch = (name, ranked, extra = {}) => ({
  name, ranked, scores: new Map(), tookMs: 0, ...extra,
});

test('a document ranked by two branches outranks one ranked by one', () => {
  const { hits } = fuse([
    branch('vector', ['a', 'b', 'c']),
    branch('fts', ['b', 'd']),
  ]);
  assert.equal(hits[0].id, 'b');
  assert.deepEqual(hits[0].ranks, { vector: 2, fts: 1 });
});

test('branch weights change the order', () => {
  const branches = [branch('vector', ['a']), branch('graph', ['b'])];
  assert.equal(fuse(branches, { vector: 1, graph: 0.1 }).hits[0].id, 'a');
  assert.equal(fuse(branches, { vector: 0.1, graph: 1 }).hits[0].id, 'b');
});

test('an unavailable branch is named with its reason', () => {
  const { report } = fuse([
    branch('vector', ['a']),
    branch('fts', [], { unavailableReason: 'index missing' }),
  ]);
  assert.deepEqual(report.degraded, ['fts']);
  assert.equal(report.reasons.fts, 'index missing');
  assert.equal(report.branches.fts, 0);
});

test('a branch that ran and matched nothing is still reported', () => {
  // The distinction the whole fusion report exists for: empty is not the same
  // as broken, and a hybrid that silently loses a branch is the failure mode.
  const { report } = fuse([branch('vector', ['a']), branch('graph', [])]);
  assert.deepEqual(report.degraded, ['graph']);
  assert.match(report.reasons.graph, /matched nothing/);
});

test('a branch that answered through a lesser route is reported but used', () => {
  const { hits, report } = fuse([
    branch('vector', ['a', 'b'], { degradedReason: 'exact scan, no ANN index' }),
  ]);
  assert.equal(hits.length, 2);
  assert.deepEqual(report.degraded, ['vector']);
  assert.match(report.reasons.vector, /exact scan/);
});

test('ties break deterministically', () => {
  // A search that returns the same set in a different order each call cannot
  // be evaluated, so ordering may never depend on Map insertion order.
  const run = () => fuse([branch('vector', ['b', 'a']), branch('fts', ['a', 'b'])]).hits.map((h) => h.id);
  const first = run();
  for (let i = 0; i < 20; i++) assert.deepEqual(run(), first);
});

test('scores follow the RRF formula', () => {
  const { hits, report } = fuse([branch('vector', ['a'])]);
  assert.equal(report.k, RRF_K);
  assert.ok(Math.abs(hits[0].score - 1 / (RRF_K + 1)) < 1e-12);
});

test('no branches means no hits and no crash', () => {
  const { hits, report } = fuse([]);
  assert.deepEqual(hits, []);
  assert.deepEqual(report.degraded, []);
});
