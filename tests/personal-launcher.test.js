import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const launcher = readFileSync(join(root, 'scripts', 'start-personal.mjs'), 'utf8');

/*
 * Assertions against the source text, which is unusual and deliberate: the
 * launcher spawns a gateway the moment it is imported, so there is nothing to
 * call. What it is guarding is worth the awkwardness -- this file's allowed
 * tools were a copied list of five names against a server with twenty, and the
 * fifteen it left out were denied at runtime with no error anyone could see.
 */

test('the memory server is allowed whole, not tool by tool', () => {
  const match = /const DEFAULT_TOOLS = ([^;]+);/.exec(launcher);
  assert.ok(match, 'DEFAULT_TOOLS should still exist');
  const value = match[1];

  assert.match(value, /'mcp__dai-memory__\*'/,
    'allow the server with a glob, so a new plugin tool is not silently denied');
  // The server segment of an allow rule must be glob-free, or the CLI skips it.
  assert.doesNotMatch(value, /mcp__\*/);
  // The regression: an enumerated list goes stale the moment the plugin adds a tool.
  assert.doesNotMatch(value, /dai_memory_search/);
});

test('the startup probe is what decides whether memory works', () => {
  assert.match(launcher, /async function probeMcpServer/);
  // tools/list is the question; initialize alone only proves a process started.
  assert.match(launcher, /'tools\/list'/);
  assert.match(launcher, /notifications\/initialized/);
  // An http server belongs to somebody else's process and must not be spawned.
  assert.match(launcher, /if \(!server\?\.command\) continue;/);
  assert.match(launcher, /--no-probe/);
});
