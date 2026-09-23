/**
 * Finding the DAI Memory plugin on this machine.
 *
 * There is no single place it lives: installed through the marketplace it sits
 * under the Claude plugins directory in a layout that has changed more than
 * once, and cloned by hand it sits wherever the person put it. Guessing one
 * path and failing is what turns a five-minute setup into an afternoon, so
 * this tries the plausible ones and, when it finds nothing, says what it
 * looked for.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The entry point the plugin itself tells the outside world to use. */
const ENTRY = join('bin', 'dai-memory.mjs');

function entryUnder(dir) {
  const direct = join(dir, ENTRY);
  return existsSync(direct) ? direct : null;
}

function searchDir(root, depth = 4) {
  if (depth < 0 || !existsSync(root)) return null;
  const found = entryUnder(root);
  if (found) return found;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const hit = searchDir(join(root, entry.name), depth - 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Returns how to start the plugin's MCP server, or null.
 *
 * `serve` is the command. It is worth naming here rather than in the config
 * template, because `mcp` is the obvious guess, it is wrong, and the failure
 * it produces is the server dying at startup with the model reporting that
 * memory is unreachable.
 */
export function resolvePlugin(explicit) {
  const tried = [];

  const candidates = [];
  if (explicit) candidates.push(resolve(explicit));
  if (process.env.DAI_MEMORY_BIN) candidates.push(resolve(process.env.DAI_MEMORY_BIN));

  for (const candidate of candidates) {
    tried.push(candidate);
    if (!existsSync(candidate)) continue;
    // A repo root or the script itself, because people pass both.
    if (statSync(candidate).isDirectory()) {
      const found = entryUnder(candidate);
      if (found) return { command: process.execPath, args: [found, 'serve'], from: found };
    } else {
      return { command: process.execPath, args: [candidate, 'serve'], from: candidate };
    }
  }

  const roots = [
    join(homedir(), '.claude', 'plugins'),
    join(homedir(), '.config', 'claude', 'plugins'),
  ];
  for (const root of roots) {
    tried.push(`${root}/**/${ENTRY}`);
    const found = searchDir(root);
    if (found) return { command: process.execPath, args: [found, 'serve'], from: found };
  }

  return { command: null, args: [], from: null, tried };
}

/** Whether a project has a plugin store, found the way the plugin finds it. */
export function findStore(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, '.memory');
    if (existsSync(join(candidate, 'store.lbug'))) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}
