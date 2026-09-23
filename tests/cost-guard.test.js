/**
 * The cost guard.
 *
 * This exists because a round of testing quietly consumed a person's quota
 * with nothing recording it and nothing stopping it. Every message spawns a
 * whole CLI session; a Gateway that keeps no account of that cannot answer the
 * only question asked afterwards — which conversation ran away — and cannot
 * stop the one that is still running.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSessionStore, loadGatewayConfig, startChat } from '../gateway/dist/index.js';

const scope = { tenant: 'me', user: 'me', project: 'p' };

describe('recording what a turn cost', () => {
  let dir;
  let store;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dai-cost-'));
    store = new SqliteSessionStore(join(dir, 'c.db'), join(dir, 'sessions'));
  });
  after(async () => {
    if (store) await store.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('a conversation starts at zero', async () => {
    const c = await store.create(scope, 'Fresh');
    assert.deepEqual(await store.spend(c.id), { costUsd: 0, turns: 0 });
  });

  test('turns accumulate', async () => {
    const c = await store.create(scope, 'Spending');
    await store.recordUsage(c.id, { inputTokens: 100, outputTokens: 20, costUsd: 0.047 });
    await store.recordUsage(c.id, { inputTokens: 200, outputTokens: 40, costUsd: 0.073 });
    const spend = await store.spend(c.id);
    assert.equal(spend.turns, 2);
    assert.ok(Math.abs(spend.costUsd - 0.12) < 1e-9);
  });

  test('a turn with no reported price still counts as a turn', async () => {
    // A missing price is not a free turn, and a conversation whose runner
    // reports nothing must not look idle.
    const c = await store.create(scope, 'Unpriced');
    await store.recordUsage(c.id, { inputTokens: 10, outputTokens: 5, costUsd: null });
    const spend = await store.spend(c.id);
    assert.equal(spend.turns, 1);
    assert.equal(spend.costUsd, 0);
  });

  test('spend is per conversation, so a runaway can be identified', async () => {
    const quiet = await store.create(scope, 'Quiet');
    const runaway = await store.create(scope, 'Runaway');
    await store.recordUsage(quiet.id, { inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
    for (let i = 0; i < 20; i++) {
      await store.recordUsage(runaway.id, { inputTokens: 1, outputTokens: 1, costUsd: 0.5 });
    }
    assert.ok((await store.spend(runaway.id)).costUsd > (await store.spend(quiet.id)).costUsd * 50);
  });

  test('usage dies with the conversation', async () => {
    const c = await store.create(scope, 'Doomed');
    await store.recordUsage(c.id, { inputTokens: 1, outputTokens: 1, costUsd: 1 });
    await store.delete(scope, c.id);
    assert.deepEqual(await store.spend(c.id), { costUsd: 0, turns: 0 });
  });
});

describe('refusing a turn over budget', () => {
  let dir;
  let store;

  const deps = (config) => ({
    config,
    core: null,
    sessions: store,
    // Never reached: the budget check runs before anything is spawned, which
    // is the point — after the process starts the money is already spent.
    runner: { name: 'must-not-run', run() { throw new Error('the runner must not be reached'); } },
  });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dai-budget-'));
    store = new SqliteSessionStore(join(dir, 'c.db'), join(dir, 'sessions'));
  });
  after(async () => {
    if (store) await store.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the ceiling defaults on, not off', () => {
    const config = loadGatewayConfig({ GATEWAY_DEV_SCOPE: 'me/me/p', CORE_URL: 'none' });
    assert.ok(config.maxConversationCostUsd > 0, 'a Gateway with no ceiling is one loop from an empty account');
  });

  test('a conversation over its ceiling is refused before the runner starts', async () => {
    const config = loadGatewayConfig({
      GATEWAY_DEV_SCOPE: 'me/me/p', CORE_URL: 'none',
      GATEWAY_MAX_CONVERSATION_COST_USD: '1',
    });
    const c = await store.create(scope, 'Expensive');
    await store.recordUsage(c.id, { inputTokens: 1, outputTokens: 1, costUsd: 1.5 });

    await assert.rejects(
      () => startChat(deps(config), scope, { conversationId: c.id, message: 'again' }, new AbortController().signal),
      (err) => {
        assert.match(err.message, /\$1\.50/);
        assert.match(err.message, /GATEWAY_MAX_CONVERSATION_COST_USD/);
        return true;
      },
    );
  });

  /**
   * Proves the guard let a turn through by reaching the runner.
   *
   * `startChat` only builds the stream; the runner is not touched until the
   * events are iterated, and `stream` turns a runner failure into an error
   * event rather than throwing. So "it got past the budget" is read from the
   * stub runner being reached, not from a rejection.
   */
  async function reachesRunner(config, conversationId) {
    const turn = await startChat(
      deps(config), scope, { conversationId, message: 'again' }, new AbortController().signal,
    );
    const events = [];
    for await (const event of turn.events) events.push(event);
    return events.some((e) => e.type === 'error' && /the runner must not be reached/.test(e.message));
  }

  test('a conversation under its ceiling is not refused by the guard', async () => {
    const config = loadGatewayConfig({
      GATEWAY_DEV_SCOPE: 'me/me/p', CORE_URL: 'none',
      GATEWAY_MAX_CONVERSATION_COST_USD: '10',
    });
    const c = await store.create(scope, 'Cheap');
    await store.recordUsage(c.id, { inputTokens: 1, outputTokens: 1, costUsd: 0.5 });
    assert.ok(await reachesRunner(config, c.id), 'the guard must let an affordable turn through');
  });

  test('zero disables the ceiling', async () => {
    const config = loadGatewayConfig({
      GATEWAY_DEV_SCOPE: 'me/me/p', CORE_URL: 'none',
      GATEWAY_MAX_CONVERSATION_COST_USD: '0',
    });
    const c = await store.create(scope, 'Unbounded');
    await store.recordUsage(c.id, { inputTokens: 1, outputTokens: 1, costUsd: 9999 });
    assert.ok(await reachesRunner(config, c.id), 'a zero ceiling must not refuse anything');
  });
});
