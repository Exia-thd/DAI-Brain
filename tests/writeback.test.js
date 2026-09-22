import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseFacts, ExtractionError } from '../gateway/dist/index.js';
import { openService, cleanup, freshScope, databaseAvailable } from './helpers.mjs';

test('well-formed extractor output parses', () => {
  const facts = parseFacts(JSON.stringify({
    facts: [
      { type: 'decision', content: 'We chose Postgres over Neo4j because one database is enough.', confidence: 0.95, entities: [{ name: 'Postgres', kind: 'technology' }] },
      { type: 'preference', content: 'Prefer TypeScript everywhere.', confidence: 0.8, entities: [] },
    ],
  }));
  assert.equal(facts.length, 2);
  assert.equal(facts[0].type, 'decision');
  assert.equal(facts[0].entities[0].name, 'Postgres');
});

test('a fenced or chatty answer still parses', () => {
  // Models add prose and fences however firmly the prompt says not to.
  const raw = 'Sure! Here you go:\n```json\n{"facts":[{"type":"fact","content":"The limit is eight.","confidence":0.9}]}\n```\nLet me know!';
  assert.equal(parseFacts(raw).length, 1);
});

test('a malformed entry is dropped without losing the batch', () => {
  const facts = parseFacts(JSON.stringify({
    facts: [
      { type: 'not-a-real-type', content: 'should be dropped', confidence: 1 },
      { type: 'fact', content: 'x', confidence: 1 },
      { type: 'fact', content: 'This one is long enough to keep.', confidence: 1 },
      null,
      { content: 'no type at all' },
    ],
  }));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].content, 'This one is long enough to keep.');
});

test('confidence is clamped and defaulted', () => {
  const facts = parseFacts(JSON.stringify({
    facts: [
      { type: 'fact', content: 'Confidence above one.', confidence: 5 },
      { type: 'fact', content: 'Confidence below zero.', confidence: -2 },
      { type: 'fact', content: 'Confidence missing entirely.' },
    ],
  }));
  assert.deepEqual(facts.map((f) => f.confidence), [1, 0, 0.7]);
});

test('an empty extraction is a valid answer', () => {
  assert.deepEqual(parseFacts('{"facts":[]}'), []);
  assert.deepEqual(parseFacts('{"facts":"not an array"}'), []);
});

test('output with no JSON at all is an error, not silent data loss', () => {
  assert.throws(() => parseFacts('I could not find anything durable.'), ExtractionError);
  assert.throws(() => parseFacts('{"facts": [unclosed'), ExtractionError);
});

const available = await databaseAvailable();

describe('reconciliation', { skip: available ? false : 'no Postgres at DATABASE_URL' }, () => {
  let service;
  const scope = freshScope('wb');

  before(async () => { service = await openService(); });
  after(async () => {
    if (!service) return;
    await cleanup(service, scope);
    await service.close();
  });

  test('the same fact restated is not stored twice', async () => {
    const content = 'The write-back worker polls Postgres every five seconds.';
    const first = await service.writeItem(scope, { type: 'fact', content, source: 'a' });
    const second = await service.writeItem(scope, { type: 'fact', content, source: 'b' });
    assert.equal(first.outcome, 'inserted');
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.item.id, first.item.id);
  });

  test('a near-duplicate supersedes rather than accumulating', async () => {
    const original = await service.writeItem(scope, {
      type: 'preference',
      content: 'The user prefers dark mode in every tool they use daily.',
      source: 'conv1',
    });
    const restated = await service.writeItem(scope, {
      type: 'preference',
      content: 'The user prefers dark mode in every tool they use daily, always.',
      source: 'conv2',
    });
    if (restated.outcome === 'superseded') {
      const old = await service.getItem(scope, original.item.id);
      assert.equal(old.supersededBy, restated.item.id, 'the old item points at the new one');
      assert.notEqual(old.id, restated.item.id);
    } else {
      // Below the similarity threshold the two are separate memories, which is
      // also correct — but then the original must not have been touched.
      assert.equal(restated.outcome, 'inserted');
      const old = await service.getItem(scope, original.item.id);
      assert.equal(old.supersededBy, null);
    }
  });

  test('an item carrying a secret is rejected and nothing is stored', async () => {
    const before = await service.listItems(scope, { limit: 500 });
    const result = await service.writeItem(scope, {
      type: 'fact',
      content: 'The production key is sk-ant-api03-QQQQQQQQQQQQQQQQQQQQQQQQ',
      source: 'conv3',
    });
    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /privacy filter/);
    const after = await service.listItems(scope, { limit: 500 });
    assert.equal(after.total, before.total);
  });

  test('undo removes exactly what one conversation created', async () => {
    const conversationId = 'conv_undo_test';
    await service.writeItem(scope, { type: 'note', content: 'Derived note one from the run.', source: 's', conversationId });
    await service.writeItem(scope, { type: 'note', content: 'Derived note two from the run.', source: 's', conversationId });
    const byHand = await service.writeItem(scope, { type: 'note', content: 'A note a person wrote themselves.', source: 's' });

    const removed = await service.undoConversation(scope, conversationId);
    assert.equal(removed, 2);
    // An item written by a person has a null conversation_id and must survive.
    assert.ok(await service.getItem(scope, byHand.item.id));
  });
});
