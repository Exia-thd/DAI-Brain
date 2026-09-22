/**
 * The test the plan names as a top risk: scope leaking between users.
 *
 * It is deliberately paranoid. Every read path gets its own case, because a
 * leak only needs one query that forgot a predicate, and the one that forgot
 * it will not be the one anybody thought to check.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openService, cleanup, databaseAvailable } from './helpers.mjs';

const available = await databaseAvailable();

describe('scope isolation', { skip: available ? false : 'no Postgres at DATABASE_URL' }, () => {
  let service;
  const alice = { tenant: 'acme', user: 'alice', project: 'shared-name' };
  const bob = { tenant: 'acme', user: 'bob', project: 'shared-name' };
  const otherTenant = { tenant: 'other', user: 'alice', project: 'shared-name' };
  let aliceItem;

  before(async () => {
    service = await openService();
    for (const scope of [alice, bob, otherTenant]) await cleanup(service, scope);

    const written = await service.writeItem(alice, {
      type: 'decision',
      content: 'Alice decided to deploy on Fridays, which is a secret only Alice knows.',
      source: 'test',
      entities: [{ name: 'Deployment' }],
    });
    aliceItem = written.item.id;

    await service.writeItem(bob, {
      type: 'decision',
      content: 'Bob decided something entirely different about Tuesdays.',
      source: 'test',
      entities: [{ name: 'Deployment' }],
    });
  });

  after(async () => {
    if (!service) return;
    for (const scope of [alice, bob, otherTenant]) await cleanup(service, scope);
    await service.close();
  });

  test('search never crosses a user, even with an identical project name', async () => {
    const result = await service.search(bob, { query: 'deploy on Fridays secret' });
    const ids = result.citations.map((c) => c.id);
    assert.ok(!ids.includes(aliceItem), 'Bob must not see Alice memories');
  });

  test('search never crosses a tenant', async () => {
    const result = await service.search(otherTenant, { query: 'deploy on Fridays secret' });
    assert.equal(result.citations.length, 0);
  });

  test('a direct get by id is scoped', async () => {
    assert.ok(await service.getItem(alice, aliceItem));
    assert.equal(await service.getItem(bob, aliceItem), null);
    assert.equal(await service.getItem(otherTenant, aliceItem), null);
  });

  test('listing is scoped', async () => {
    const mine = await service.listItems(alice, { limit: 100 });
    const theirs = await service.listItems(bob, { limit: 100 });
    assert.ok(mine.items.some((i) => i.id === aliceItem));
    assert.ok(!theirs.items.some((i) => i.id === aliceItem));
  });

  test('the graph is scoped even when both users named the same entity', async () => {
    // Both wrote a memory about "Deployment". The entity ids are derived from
    // the scope, so these are two nodes, not one shared node.
    const mine = await service.graph(alice, 'Deployment', 2);
    const theirs = await service.graph(bob, 'Deployment', 2);
    assert.ok(mine.root && theirs.root);
    assert.notEqual(mine.root.id, theirs.root.id);
    assert.ok(mine.items.some((i) => i.id === aliceItem));
    assert.ok(!theirs.items.some((i) => i.id === aliceItem));
  });

  test('another user cannot update or delete an item', async () => {
    await assert.rejects(() => service.updateItem(bob, aliceItem, { content: 'hijacked' }), /no item/);
    assert.equal(await service.deleteItem(bob, aliceItem), false);
    const still = await service.getItem(alice, aliceItem);
    assert.match(still.content, /secret only Alice knows/);
  });

  test('the search cache is keyed by scope', async () => {
    // A cache keyed by query alone is the cheapest possible cross-user leak,
    // and it passes every test that runs as a single user.
    const query = 'deploy on Fridays secret';
    const first = await service.search(alice, { query });
    assert.ok(first.citations.some((c) => c.id === aliceItem));
    const second = await service.search(bob, { query });
    assert.ok(!second.citations.some((c) => c.id === aliceItem));
  });

  test('undo only removes the asking scope conversation items', async () => {
    await service.writeItem(alice, {
      type: 'note', content: 'Alice note from conversation X', source: 'test', conversationId: 'conv_shared',
    });
    await service.writeItem(bob, {
      type: 'note', content: 'Bob note from conversation X', source: 'test', conversationId: 'conv_shared',
    });
    const removed = await service.undoConversation(alice, 'conv_shared');
    assert.equal(removed, 1);
    const bobStill = await service.listItems(bob, { limit: 100 });
    assert.ok(bobStill.items.some((i) => i.content.startsWith('Bob note')));
  });
});
