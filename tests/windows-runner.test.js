/**
 * Starting the CLI on Windows.
 *
 * Node has refused to spawn a `.cmd` without `shell: true` since the fix for
 * CVE-2024-27980, and `claude` on Windows is `claude.cmd`. A shell is not the
 * way out: the prompt is whatever the user typed and it travels in argv, so
 * under cmd.exe a message becomes a command. These tests pin the behaviour
 * down on every platform, including from Linux CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunner } from '../gateway/dist/index.js';

const NODE = '/usr/bin/node-for-test';

test('on linux and macOS the binary is spawned directly', () => {
  for (const platform of ['linux', 'darwin']) {
    const r = resolveRunner('claude', platform, NODE);
    assert.equal(r.command, 'claude');
    assert.deepEqual(r.prefixArgs, []);
  }
});

test('an explicit JS entry point runs under this process own node, on any platform', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const entry of ['C:\\npm\\cli.js', '/usr/lib/cli.mjs', '/x/cli.cjs']) {
      const r = resolveRunner(entry, platform, NODE);
      assert.equal(r.command, NODE, `${entry} on ${platform}`);
      assert.deepEqual(r.prefixArgs, [entry]);
    }
  }
});

test('on Windows, a shim it cannot resolve fails with instructions rather than ENOENT', () => {
  // The failure a user actually hits. It has to say what to do next: an
  // ENOENT from deep inside a spawn tells them nothing.
  let error = null;
  try {
    resolveRunner('claude', 'win32', NODE);
  } catch (err) {
    error = err;
  }
  assert.ok(error, 'an unresolvable shim must throw');
  assert.match(error.message, /CLAUDE_BIN/);
  assert.match(error.message, /cli\.js/);
  assert.match(error.message, /npm root -g/);
});

test('the resolver never asks for a shell', () => {
  // The whole point. If this ever returns something a shell has to interpret,
  // a user's message reaches cmd.exe as a command.
  const source = resolveRunner.toString();
  assert.doesNotMatch(source, /shell\s*:\s*true/);
});

// --- personal setup -------------------------------------------------------

test('without Brain MCP the memory tools are not allowed and the server is not declared', async () => {
  // Declaring a server that is not running does worse than nothing: the model
  // watches the connection fail and starts discounting whatever memory it does
  // get. Measured — it said so in its own answer.
  const { loadGatewayConfig } = await import('../gateway/dist/index.js');
  const solo = loadGatewayConfig({ GATEWAY_DEV_SCOPE: 'me/me/p', CORE_URL: 'none' });
  assert.equal(solo.coreUrl, null);
  assert.equal(solo.mcpUrl, null, 'Brain MCP is a front for Core; without Core there is none');
  assert.equal(solo.databaseUrl, null);
  assert.equal(solo.writebackEnabled, false, 'the queue is a Postgres table, so it cannot run');

  const full = loadGatewayConfig({
    GATEWAY_DEV_SCOPE: 'me/me/p',
    DATABASE_URL: 'postgres://x/y',
  });
  assert.equal(full.coreUrl, 'http://localhost:8081');
  assert.equal(full.mcpUrl, 'http://localhost:8082/mcp');
  assert.equal(full.writebackEnabled, true);
});

test('the local store path defaults under the session root', async () => {
  const { loadGatewayConfig } = await import('../gateway/dist/index.js');
  const config = loadGatewayConfig({ GATEWAY_DEV_SCOPE: 'me/me/p', GATEWAY_SESSION_ROOT: '/srv/brain' });
  assert.match(config.sqlitePath, /conversations\.db$/);
  assert.ok(config.sqlitePath.startsWith('/srv/brain'));
});

// --- which credential the runner uses -------------------------------------

test('without an API key the runner keeps your own claude login', async () => {
  // The bug this pins down: pointing the CLI at a fresh, empty
  // CLAUDE_CONFIG_DIR when that directory holds the only credential there is.
  // It surfaces as "Invalid API key · Please run /login", which sends people
  // hunting for a key problem.
  const { loadGatewayConfig } = await import('../gateway/dist/index.js');
  const personal = loadGatewayConfig({ GATEWAY_DEV_SCOPE: 'me/me/p', CORE_URL: 'none' });
  assert.equal(personal.isolateClaudeConfig, false);
});

test('with an API key each session gets its own config directory', async () => {
  const { loadGatewayConfig } = await import('../gateway/dist/index.js');
  const shared = loadGatewayConfig({
    GATEWAY_DEV_SCOPE: 'me/me/p', CORE_URL: 'none', ANTHROPIC_API_KEY: 'sk-ant-test',
  });
  assert.equal(shared.isolateClaudeConfig, true, 'one person login must not become the next person');
});

test('the choice can be forced either way', async () => {
  const { loadGatewayConfig } = await import('../gateway/dist/index.js');
  const forcedOff = loadGatewayConfig({
    GATEWAY_DEV_SCOPE: 'me/me/p', CORE_URL: 'none',
    ANTHROPIC_API_KEY: 'sk-ant-test', GATEWAY_ISOLATE_CLAUDE_CONFIG: 'false',
  });
  assert.equal(forcedOff.isolateClaudeConfig, false);

  const forcedOn = loadGatewayConfig({
    GATEWAY_DEV_SCOPE: 'me/me/p', CORE_URL: 'none', GATEWAY_ISOLATE_CLAUDE_CONFIG: 'true',
  });
  assert.equal(forcedOn.isolateClaudeConfig, true);
});
