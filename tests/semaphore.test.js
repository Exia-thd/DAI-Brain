import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore } from '../gateway/dist/index.js';

test('permits are limited and released', async () => {
  const sem = new Semaphore(2);
  const a = await sem.acquire();
  const b = await sem.acquire();
  assert.equal(sem.available, 0);

  let third = false;
  const pending = sem.acquire().then((release) => { third = true; return release; });
  await new Promise((r) => setImmediate(r));
  assert.equal(third, false, 'the third caller must wait');
  assert.equal(sem.queued, 1);

  a();
  const release = await pending;
  assert.equal(third, true);
  b();
  release();
  assert.equal(sem.available, 2);
});

test('a double release does not invent a permit', async () => {
  const sem = new Semaphore(1);
  const release = await sem.acquire();
  release();
  release();
  assert.equal(sem.available, 1);
});

test('a queued caller that gives up frees its place', async () => {
  const sem = new Semaphore(1);
  const held = await sem.acquire();
  const controller = new AbortController();
  const waiting = sem.acquire(controller.signal);
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 1);

  controller.abort();
  await assert.rejects(() => waiting, /cancelled while queued/);
  assert.equal(sem.queued, 0);
  held();
  assert.equal(sem.available, 1);
});

test('an already-aborted caller never takes a permit', async () => {
  const sem = new Semaphore(1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => sem.acquire(controller.signal), /cancelled/);
  assert.equal(sem.available, 1);
});

test('the limit must be at least one', () => {
  assert.throws(() => new Semaphore(0), /at least 1/);
});
