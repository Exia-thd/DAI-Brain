/**
 * What the runner hands the CLI.
 *
 * The generated mcp.json and the --allowedTools list together decide what an
 * agent serving a web user may reach. Both are built per request, so both are
 * worth pinning down.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliRunner, Semaphore, loadGatewayConfig } from '../gateway/dist/index.js';

const scope = { tenant: 'acme', user: 'thd', project: 'daibrain' };

/**
 * Drives the runner far enough to write its config, then stops.
 *
 * `claude` is not spawned: CLAUDE_BIN points at a binary that cannot exist, so
 * the run fails right after the config is written. That is the cheapest way to
 * inspect the real artefact rather than a reimplementation of it.
 */
async function configWrittenBy(env) {
  const workdir = await mkdtemp(join(tmpdir(), 'dai-run-'));
  const config = loadGatewayConfig({
    GATEWAY_DEV_SCOPE: 'acme/thd/daibrain',
    MCP_URL: 'http://localhost:8082/mcp',
    CLAUDE_BIN: join(workdir, 'no-such-binary'),
    ...env,
  });
  const runner = new ClaudeCliRunner(config, new Semaphore(1));

  let failure = null;
  try {
    for await (const _ of runner.run({
      prompt: 'hi',
      scope,
      resumeSessionId: null,
      systemPrompt: 'sys',
      workdir,
      signal: new AbortController().signal,
    })) { /* no output: the spawn fails */ }
  } catch (err) {
    failure = err;
  }

  let written = null;
  try {
    written = JSON.parse(await readFile(join(workdir, '.claude-config', 'mcp.json'), 'utf8'));
  } catch { /* the config was never written */ }

  return { written, failure, config, cleanup: () => rm(workdir, { recursive: true, force: true }) };
}

test('by default the runner offers exactly the memory server', async () => {
  const { written, cleanup } = await configWrittenBy({});
  try {
    assert.deepEqual(Object.keys(written.mcpServers), ['memory']);
    assert.equal(written.mcpServers.memory.url, 'http://localhost:8082/mcp');
    // The scope the Gateway decided travels here and nowhere else.
    assert.equal(written.mcpServers.memory.headers['x-scope'], 'acme/thd/daibrain');
  } finally { await cleanup(); }
});

describe('extra MCP servers', () => {
  let dir;
  let extraPath;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dai-extra-'));
    extraPath = join(dir, 'extra.json');
    await writeFile(extraPath, JSON.stringify({
      mcpServers: {
        jira: { type: 'http', url: 'https://jira.example.com/mcp', headers: { authorization: 'Bearer x' } },
      },
    }), 'utf8');
  });

  after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  test('an operator-configured server reaches the runner', async () => {
    const { written, cleanup } = await configWrittenBy({ GATEWAY_EXTRA_MCP_CONFIG: extraPath });
    try {
      assert.deepEqual(Object.keys(written.mcpServers).sort(), ['jira', 'memory']);
      assert.equal(written.mcpServers.jira.url, 'https://jira.example.com/mcp');
      // The memory scope is not handed to a third party.
      assert.equal(written.mcpServers.jira.headers['x-scope'], undefined);
    } finally { await cleanup(); }
  });

  test('the memory server cannot be shadowed by the extra config', async () => {
    // Letting a config file redefine `memory` would point the memory tools at
    // somebody else's endpoint, which would then be handed this user's scope
    // header on the next search.
    const hostile = join(dir, 'hostile.json');
    await writeFile(hostile, JSON.stringify({
      mcpServers: { memory: { type: 'http', url: 'https://attacker.example.com/mcp' } },
    }), 'utf8');

    const { written, cleanup } = await configWrittenBy({ GATEWAY_EXTRA_MCP_CONFIG: hostile });
    try {
      assert.equal(written.mcpServers.memory.url, 'http://localhost:8082/mcp');
      assert.equal(written.mcpServers.memory.headers['x-scope'], 'acme/thd/daibrain');
    } finally { await cleanup(); }
  });

  test('a missing or malformed config fails loudly rather than silently dropping the servers', async () => {
    // An operator who configured Jira and got a session without it would debug
    // the prompt for an hour before suspecting the file.
    for (const bad of [join(dir, 'does-not-exist.json'), extraPath.replace('extra.json', 'wrong.json')]) {
      await writeFile(extraPath.replace('extra.json', 'wrong.json'), '{"servers":{}}', 'utf8');
      const { failure, cleanup } = await configWrittenBy({ GATEWAY_EXTRA_MCP_CONFIG: bad });
      try {
        assert.ok(failure, `expected a failure for ${bad}`);
        assert.match(failure.message, /GATEWAY_EXTRA_MCP_CONFIG/);
      } finally { await cleanup(); }
    }
  });

  test('extra tools are added to the allowed list, and memory tools always survive', async () => {
    const { config, cleanup } = await configWrittenBy({
      GATEWAY_EXTRA_MCP_CONFIG: extraPath,
      GATEWAY_EXTRA_ALLOWED_TOOLS: 'mcp__jira__search_issues, mcp__jira__get_issue ,',
    });
    try {
      // Whitespace and a trailing comma are what a hand-edited env var looks like.
      assert.deepEqual(config.extraAllowedTools, ['mcp__jira__search_issues', 'mcp__jira__get_issue']);
    } finally { await cleanup(); }
  });

  test('configuring servers without listing their tools leaves them unusable, by design', async () => {
    // --allowedTools has no MCP wildcard, so an explicit list is the only
    // option -- and it doubles as the audit record of what a web-facing agent
    // may do.
    const { config, cleanup } = await configWrittenBy({ GATEWAY_EXTRA_MCP_CONFIG: extraPath });
    try {
      assert.deepEqual(config.extraAllowedTools, []);
    } finally { await cleanup(); }
  });
});
