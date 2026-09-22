import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pack } from '../core/dist/index.js';
import { estimateTokens, truncateToTokens } from '../shared/dist/index.js';

const item = (id, content, type = 'note') => ({
  item: {
    id, type, content, source: 'test', confidence: 1,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    supersededBy: null, conversationId: null,
    scope: { tenant: 't', user: 'u', project: 'p' },
  },
  fusedScore: 1,
  ranks: { vector: 1 },
});

test('the packed context never exceeds its budget', () => {
  const candidates = Array.from({ length: 40 }, (_, i) =>
    item(`item_${i}`, `memory number ${i}. ${'padding words '.repeat(30)}`));
  for (const budget of [100, 400, 1200]) {
    const result = pack(candidates, 'memory', { maxTokens: budget });
    assert.ok(result.usedTokens <= budget, `used ${result.usedTokens} > budget ${budget}`);
    assert.ok(estimateTokens(result.context) <= budget + 4);
  }
});

test('one long item cannot eat the whole budget', () => {
  const candidates = [
    item('item_long', 'x '.repeat(4000)),
    item('item_a', 'the short decision that actually answers the question'),
    item('item_b', 'another short one'),
  ];
  const result = pack(candidates, 'decision', { maxTokens: 300 });
  const ids = result.citations.map((c) => c.id);
  assert.ok(ids.includes('item_a'), 'the short items must survive the long one');
  assert.ok(ids.includes('item_b'));
});

test('packing continues past an item that did not fit', () => {
  const candidates = [
    item('item_huge', 'y '.repeat(3000)),
    item('item_tiny', 'short'),
  ];
  const result = pack(candidates, 'short', { maxTokens: 120 });
  assert.ok(result.citations.some((c) => c.id === 'item_tiny'));
});

test('every packed item is cited with its provenance', () => {
  const result = pack([item('item_x', 'a decision', 'decision')], 'decision', { maxTokens: 500 });
  assert.equal(result.citations.length, 1);
  const [citation] = result.citations;
  assert.equal(citation.id, 'item_x');
  assert.equal(citation.type, 'decision');
  assert.equal(citation.source, 'test');
  assert.deepEqual(citation.ranks, { vector: 1 });
  assert.match(result.context, /\[item_x\]/);
});

test('dropped items are counted rather than hidden', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => item(`item_${i}`, 'z '.repeat(200)));
  const result = pack(candidates, 'z', { maxTokens: 150 });
  assert.ok(result.omitted > 0, 'a caller shown 2 of 20 must be told about the 18');
  assert.equal(result.omitted + result.citations.length, candidates.length);
});

test('truncation fits the budget and never grows the text', () => {
  const text = 'word '.repeat(500);
  for (const budget of [1, 10, 100]) {
    const cut = truncateToTokens(text, budget);
    assert.ok(estimateTokens(cut) <= budget);
    assert.ok(cut.length <= text.length);
  }
  assert.equal(truncateToTokens('short', 0), '');
});

test('token estimation never under-counts ascii or CJK', () => {
  // Under-counting is the one failure mode that matters: it produces a prompt
  // larger than the budget promised.
  assert.ok(estimateTokens('hello world') >= 2);
  assert.ok(estimateTokens('xin chào các bạn') >= 4);
  assert.ok(estimateTokens('日本語のテキスト') >= 8);
  assert.equal(estimateTokens(''), 0);
});
