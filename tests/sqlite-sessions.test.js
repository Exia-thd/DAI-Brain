/**
 * The local conversation store.
 *
 * It exists so one person on one machine does not have to run a database
 * server, and it has to behave exactly like the Postgres one where it matters
 * — above all the mapping to Claude's own session id, which is what makes a
 * multi-turn conversation cheap. A store that forgets it silently turns every
 * ongoing conversation into a new one with no history.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSessionStore } from '../gateway/dist/index.js';

describe('SqliteSessionStore', () => {
  let dir;
  let store;
  const scope = { tenant: 'me', user: 'me', project: 'inventory' };
  const other = { tenant: 'me', user: 'me', project: 'something-else' };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dai-sqlite-'));
    store = new SqliteSessionStore(join(dir, 'nested', 'conversations.db'), join(dir, 'sessions'));
  });

  after(async () => {
    if (store) await store.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('it creates its own directory rather than requiring one', () => {
    assert.ok(existsSync(join(dir, 'nested', 'conversations.db')));
  });

  test('a conversation round-trips with its working directory', async () => {
    const created = await store.create(scope, 'First question');
    const loaded = await store.get(scope, created.id);
    assert.equal(loaded.id, created.id);
    assert.equal(loaded.title, 'First question');
    assert.equal(loaded.workdir, created.workdir);
    assert.deepEqual(loaded.scope, scope);
  });

  test('the Claude session id survives, because --resume depends on it', async () => {
    const c = await store.create(scope, 'Resumable');
    assert.equal((await store.get(scope, c.id)).claudeSessionId, null);
    await store.bindClaudeSession(c.id, 'sess_abc123');
    assert.equal((await store.get(scope, c.id)).claudeSessionId, 'sess_abc123');
  });

  test('messages keep their order', async () => {
    const c = await store.create(scope, 'Ordered');
    for (const [role, content] of [['user', 'one'], ['assistant', 'two'], ['user', 'three']]) {
      await store.appendMessage(c.id, role, content);
    }
    assert.deepEqual(await store.messages(c.id), [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
  });

  test('listing is scoped, and a null project spans the user projects', async () => {
    const mine = await store.create(scope, 'Mine');
    const theirs = await store.create(other, 'Theirs');

    const scoped = await store.list(scope);
    assert.ok(scoped.some((c) => c.id === mine.id));
    assert.ok(!scoped.some((c) => c.id === theirs.id), 'a pinned project must not see another');

    const wide = await store.list({ ...scope, project: null });
    assert.ok(wide.some((c) => c.id === mine.id));
    assert.ok(wide.some((c) => c.id === theirs.id));
  });

  test('a conversation in another project is invisible and undeletable', async () => {
    const theirs = await store.create(other, 'Theirs');
    assert.equal(await store.get(scope, theirs.id), null);
    assert.equal(await store.delete(scope, theirs.id), false);
    assert.ok(await store.get(other, theirs.id), 'and it is still there afterwards');
  });

  test('turn counts come back with the listing', async () => {
    const c = await store.create(scope, 'Counted');
    await store.appendMessage(c.id, 'user', 'a');
    await store.appendMessage(c.id, 'assistant', 'b');
    const row = (await store.list(scope)).find((x) => x.id === c.id);
    assert.equal(row.turnCount, 2);
  });

  test('deleting a conversation takes its messages with it', async () => {
    const c = await store.create(scope, 'Doomed');
    await store.appendMessage(c.id, 'user', 'x');
    assert.equal(await store.delete(scope, c.id), true);
    assert.equal(await store.get(scope, c.id), null);
    assert.deepEqual(await store.messages(c.id), []);
  });

  test('a title is set once and not overwritten by a later turn', async () => {
    const c = await store.create(scope, 'Original');
    await store.setTitle(c.id, 'Replacement');
    assert.equal((await store.get(scope, c.id)).title, 'Original');
  });

  test('conversations survive reopening the file', async () => {
    // The whole point of a file rather than memory: closing the Gateway must
    // not lose the conversation, or --resume has nothing to resume.
    const path = join(dir, 'reopen.db');
    const first = new SqliteSessionStore(path, join(dir, 'sessions'));
    const c = await first.create(scope, 'Persisted');
    await first.bindClaudeSession(c.id, 'sess_persisted');
    await first.appendMessage(c.id, 'user', 'still here?');
    await first.close();

    const second = new SqliteSessionStore(path, join(dir, 'sessions'));
    const loaded = await second.get(scope, c.id);
    assert.equal(loaded.claudeSessionId, 'sess_persisted');
    assert.deepEqual(await second.messages(c.id), [{ role: 'user', content: 'still here?' }]);
    await second.close();
  });
});
