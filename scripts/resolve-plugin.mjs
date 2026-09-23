/**
 * Finding the DAI Memory plugin on this machine.
 *
 * There is no single place it lives. Installed through the marketplace it sits
 * under the Claude plugins directory, in a layout that nests differently on
 * each platform; cloned by hand it sits wherever the person put it, which in
 * practice is next to whatever else they cloned. Guessing one path and failing
 * is what turns a five-minute setup into an afternoon, so this looks in every
 * plausible place, and when it finds nothing it says what it looked for and
 * offers to fetch it.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';

/** The entry point the plugin itself tells the outside world to use. */
const ENTRY = join('bin', 'dai-memory.mjs');
/** Proof it has been built. Present but unbuilt is its own failure. */
const BUILT = join('packages', 'cli', 'dist', 'cli.js');

export const PLUGIN_REPO = 'https://github.com/Exia-thd/DAI-memory-layer-plugin';

function entryUnder(dir) {
  const candidate = join(dir, ENTRY);
  return existsSync(candidate) ? candidate : null;
}

/** Walks down looking for the entry point, skipping what cannot contain it. */
function search(root, depth) {
  if (depth < 0 || !existsSync(root)) return null;
  const here = entryUnder(root);
  if (here) return here;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null; // an unreadable directory is not a reason to stop looking
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const hit = search(join(root, entry.name), depth - 1);
    if (hit) return hit;
  }
  return null;
}

/**
 * Every directory worth looking in, most specific first.
 *
 * `repoRoot`'s parent is on the list because a person who cloned this repo
 * almost certainly cloned the plugin beside it — that is where checkouts go.
 */
export function searchRoots(repoRoot) {
  const home = homedir();
  const roots = [];

  // Marketplace installs, per platform.
  roots.push(join(home, '.claude', 'plugins'));
  roots.push(join(home, '.config', 'claude', 'plugins'));
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'claude', 'plugins'));
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'claude', 'plugins'));
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(join(process.env.CLAUDE_CONFIG_DIR, 'plugins'));

  // Hand-made checkouts, beside this one and in the usual places.
  if (repoRoot) roots.push(dirname(resolve(repoRoot)));
  roots.push(join(home, 'Projects'));
  roots.push(join(home, 'source', 'repos'));

  return [...new Set(roots)];
}

/** A directory or a script, because people pass both. */
function fromPath(candidate) {
  if (!existsSync(candidate)) return null;
  try {
    if (!statSync(candidate).isDirectory()) return candidate;
  } catch {
    return null;
  }
  return entryUnder(candidate);
}

export function resolvePlugin(explicit, repoRoot) {
  for (const candidate of [explicit, process.env.DAI_MEMORY_BIN].filter(Boolean)) {
    const found = fromPath(resolve(candidate));
    if (found) return describe(found);
    // An explicit path that is wrong is a mistake to report, not to search past.
    return {
      command: null,
      tried: [resolve(candidate)],
      reason: `nothing at ${resolve(candidate)} — expected a plugin checkout or its ${ENTRY}`,
    };
  }

  const tried = [];
  for (const root of searchRoots(repoRoot)) {
    tried.push(join(root, '**', ENTRY));
    // Three levels covers marketplaces/<name>/<plugin>/ and a sibling checkout;
    // deeper turns a miss into a slow walk of the whole home directory.
    const found = search(root, 3);
    if (found) return describe(found);
  }

  // The plugin may be on PATH as a shim even when its checkout is not found.
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of ['dai-memory', 'dai-memory.cmd', 'dai-memory.exe']) {
      const shim = join(dir, name);
      if (existsSync(shim)) {
        tried.push(shim);
        // Reported rather than used: Node cannot spawn a .cmd, and the shim
        // does not tell us where the checkout is.
        return {
          command: null,
          tried,
          reason: `found ${shim} on PATH, but the checkout it points at is what this needs. `
            + 'Pass --plugin with the checkout directory.',
        };
      }
    }
  }

  return { command: null, tried, reason: null };
}

function describe(entry) {
  const root = dirname(dirname(entry));
  if (!existsSync(join(root, BUILT))) {
    return {
      command: null,
      tried: [entry],
      reason: `found the plugin at ${root}, but it is not built. Run there:\n`
        + '    pnpm install && pnpm build && node bin/setup.mjs',
    };
  }
  return { command: process.execPath, args: [entry, 'serve'], from: entry, root };
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

/** Normalises separators so a message does not mix them. */
export function show(path) {
  return path.split(/[\\/]/).join(sep);
}
