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
