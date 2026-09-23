#!/usr/bin/env node
/**
 * The personal chat window, in one command.
 *
 * `pnpm chat` — one person, one machine, memory from an MCP server. It exists
 * because the alternative was eight environment variables that have to agree
 * with each other, and a setup nobody can retype from memory is a setup nobody
 * runs twice.
 *
 * Everything it sets can still be overridden: anything already in the
 * environment wins, so this is defaults, not policy.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, copyFileSync, existsSync, readFileSync, readSync, readdirSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { PLUGIN_REPO, findStore, resolvePlugin, show } from './resolve-plugin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d) => {
  const at = argv.indexOf(`--${n}`);
  return at === -1 || at === argv.length - 1 ? d : argv[at + 1];
};

if (flag('help')) {
  console.log(`Usage: pnpm chat [options]

  --dir <path>       the project to chat about; the memory server finds its
                     store from here                   (default: current directory)
  --plugin <path>    where the DAI Memory plugin is, if it cannot be found
  --install-plugin   clone and build it next to this repo when it is missing
  --no-init          do not create the plugin's store when the project has none
  --project <name>   which memory scope to use          (default: personal)
  --mcp <file>       MCP config for your memory server  (default: ./plugin-mcp.json)
  --tools <list>     comma-separated tools to allow     (default: the plugin's)
  --model <id>       model for every turn               (default: $CLAUDE_MODEL)
  --port <n>         (default 8080)
  --budget <usd>     ceiling per conversation, 0 to disable   (default 5)

Writes a starter plugin-mcp.json if none exists. Nothing here needs Postgres
or Brain Core; conversations go into a local SQLite file.`);
  process.exit(0);
}

/**
 * Which build of this script is running.
 *
 * Printed on every start because a round of debugging was already spent on a
 * report whose output came from a commit before the fix -- and nothing in it
 * said so. A version line makes "you are running the old one" a fact anyone
 * can see rather than something to deduce from the wording of an error.
 */
function version() {
  const head = spawnSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const dirty = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
  if (head.status !== 0) return 'unknown (not a git checkout)';
  return `${head.stdout.trim()}${dirty.stdout?.trim() ? ' +local changes' : ''}`;
}

console.log(`[chat] DAI Brain ${version()}`);

const projectDir = resolve(value('dir', process.env.GATEWAY_PROJECT_DIR ?? process.cwd()));

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(
    `[chat] this needs Node 22 or later for the local conversation store; this is Node ${process.versions.node}.`,
  );
  process.exit(1);
}

const mcpPath = resolve(value('mcp', join(root, 'plugin-mcp.json')));

// A config the person supplied is theirs; only a generated one is rewritten.
if (!existsSync(mcpPath)) {
  let plugin = resolvePlugin(value('plugin'), root);

  // Asking beats printing three options and exiting: this is a terminal, the
  // person is sitting at it, and the alternative is another round trip to run
  // the same command with one more flag.
  if (!plugin.command && (flag('install-plugin') || confirmInstall(plugin))) {
    plugin = installPlugin();
  }

  if (!plugin.command) {
    const lines = [
      process.stdin.isTTY ? '' : '[chat] cannot find the DAI Memory plugin.',
      plugin.reason ? `\n  ${plugin.reason}` : '',
      plugin.tried?.length ? `\n  Looked in:\n${plugin.tried.map((t) => `    ${show(t)}`).join('\n')}` : '',
      '\n  Fix it in one of three ways:',
      '\n    1. Let this fetch and build it:',
      '         pnpm chat --install-plugin --dir <your project>',
      '\n    2. Point at a checkout you already have:',
      '         pnpm chat --plugin <path to dai-memory-layer-plugin> --dir <your project>',
      '\n    3. Install it in Claude Code, then run its setup once:',
      '         /plugin marketplace add Exia-thd/DAI-memory-layer-plugin',
      '         /plugin install dai-memory',
    ];
    console.error(lines.filter(Boolean).join('\n'));
    process.exit(1);
  }

  writeFileSync(mcpPath, `${JSON.stringify({
    mcpServers: {
      'dai-memory': { command: plugin.command, args: plugin.args },
    },
  }, null, 2)}\n`, 'utf8');
  console.log(`[chat] memory server: ${show(plugin.from)}`);
}

function run([command, args, cwd]) {
  const result = spawnSync(command, args, {
    cwd, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.status === 0) return true;
  console.error(`\n[chat] \`${command} ${args.join(' ')}\` failed in ${show(cwd)}.`);
  return false;
}

function failed(target) {
  return { command: null, tried: [target], reason: 'the install did not finish' };
}

/**
 * Lets the plugin's native dependencies run their install scripts.
 *
 * pnpm 10 refuses to run them by default and fails the install outright, and
 * the plugin declares its exceptions under `pnpm.onlyBuiltDependencies` in
 * package.json -- which pnpm 10 no longer reads. It warns about that and then
 * errors, which reads as two unrelated problems rather than one.
 *
 * Without those scripts `@ladybugdb/core` never copies its platform binary
 * into place, and the first command fails with `lbugjs.node: cannot open
 * shared object file`. The setting's new home is pnpm-workspace.yaml.
 */
function allowNativeBuilds(target) {
  const workspace = join(target, 'pnpm-workspace.yaml');
  if (!existsSync(workspace)) return;
  const text = readFileSync(workspace, 'utf8');
  if (text.includes('onlyBuiltDependencies')) return;

  appendFileSync(workspace, [
    '',
    '# Added by DAI Brain: pnpm 10 reads this here, not from package.json,',
    '# and without it the native binding is never put in place.',
    'onlyBuiltDependencies:',
    "  - '@ladybugdb/core'",
    '  - onnxruntime-node',
    '  - protobufjs',
    '  - sharp',
    '',
  ].join('\n'), 'utf8');
  console.log(`[chat] allowed native builds in ${show(workspace)}`);
}

/**
 * Puts the platform binary where the loader looks, if the install did not.
 *
 * Belt and braces for the case above: the package ships one binary per
 * platform as an optional dependency and copies the right one in a postinstall
 * script. When that script is skipped the binary is on disk but in the wrong
 * package, so a copy is all that is missing.
 */
function ensureNativeBinding(target) {
  const pnpmDir = join(target, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return;

  let entries;
  try {
    entries = readdirSync(pnpmDir);
  } catch {
    return;
  }
  const core = entries.find((name) => /^@ladybugdb\+core@/.test(name));
  const platform = entries.find((name) => /^@ladybugdb\+core-[a-z0-9]+-[a-z0-9]+@/.test(name));
  if (!core || !platform) return;

  const dest = join(pnpmDir, core, 'node_modules', '@ladybugdb', 'core', 'lbugjs.node');
  if (existsSync(dest)) return;

  const scope = join(pnpmDir, platform, 'node_modules', '@ladybugdb');
  const pkg = readdirSync(scope).find((name) => name.startsWith('core-'));
  const source = pkg && join(scope, pkg, 'lbugjs.node');
  if (!source || !existsSync(source)) return;

  copyFileSync(source, dest);
  console.log('[chat] placed the native binding the install script would have copied');
}

/**
 * Offers to fetch the plugin, when there is someone there to answer.
 *
 * Only when stdin is a terminal. Under CI or a pipe there is nobody to say
 * yes, and a prompt that blocks forever is worse than a message that explains.
 */
function confirmInstall(plugin) {
  if (!process.stdin.isTTY) return false;

  console.log('[chat] cannot find the DAI Memory plugin.');
  if (plugin.reason) console.log(`\n  ${plugin.reason}`);
  if (plugin.tried?.length) {
    console.log(`\n  Looked in:\n${plugin.tried.map((t) => `    ${show(t)}`).join('\n')}`);
  }
  console.log(`\n  It can be cloned and built next to this repo, into`);
  console.log(`  ${show(join(dirname(root), 'dai-memory-layer-plugin'))}`);
  console.log('  That downloads an embedding model too — a few hundred MB, once.\n');

  process.stdout.write('  Do that now? [Y/n] ');
  const buffer = Buffer.alloc(64);
  let answer = '';
  try {
    answer = buffer.subarray(0, readSync(0, buffer, 0, 64, null)).toString('utf8').trim().toLowerCase();
  } catch {
    return false; // no readable stdin after all
  }
  console.log('');
  return answer === '' || answer === 'y' || answer === 'yes';
}

/**
 * Clones and builds the plugin beside this repo.
 *
 * Beside rather than inside, because it is a separate project with its own
 * updates — burying it in node_modules or a subdirectory here would make it
 * something nobody can find again to update or to run `dai-memory` from.
 */
function installPlugin() {
  const target = join(dirname(root), 'dai-memory-layer-plugin');
  const clone = existsSync(target)
    ? ['git', ['pull', '--ff-only'], target]
    : ['git', ['clone', '--depth', '1', PLUGIN_REPO, target], dirname(root)];

  console.log(`[chat] installing the DAI Memory plugin into ${show(target)}\n`);
  if (!run(clone)) return failed(target);

  allowNativeBuilds(target);

  for (const step of [['pnpm', ['install'], target], ['pnpm', ['build'], target]]) {
    if (!run(step)) return failed(target);
  }
  ensureNativeBinding(target);
  // The embedding model is a separate download and the plugin refuses to run
  // without it, so this is part of installing rather than an extra.
  console.log('\n[chat] downloading the embedding model (once, a few hundred MB)\n');
  const setup = spawnSync(process.execPath, [join(target, 'bin', 'setup.mjs')], {
    cwd: target, stdio: 'inherit',
  });
  if (setup.status !== 0) {
    console.error('\n[chat] the model download failed. The plugin will not start without it.');
    return { command: null, tried: [target], reason: 'the embedding model is missing' };
  }
  console.log('');
  return resolvePlugin(target, root);
}

// The plugin finds its store by walking up from the working directory, so a
// project without one produces "No memory store found", which reads as a
// broken install rather than a missing step.
if (!findStore(projectDir) && !flag('no-init')) {
  const plugin = resolvePlugin(value('plugin'), root);
  if (plugin.command) {
    console.log(`[chat] no memory store in ${projectDir} — running \`dai-memory init\` there.`);
    console.log('[chat] it scans the project and writes .memory/. Pass --no-init to skip.\n');
    const init = spawnSync(plugin.command, [plugin.args[0], 'init'], {
      cwd: projectDir, stdio: 'inherit',
    });
    if (init.status !== 0) {
      console.error('\n[chat] `dai-memory init` failed. Fix that first — the chat has no memory without it.');
      process.exit(1);
    }
    console.log('');
  }
}

const DEFAULT_TOOLS = [
  'mcp__dai-memory__dai_memory_search',
  'mcp__dai-memory__dai_memory_why',
  'mcp__dai-memory__dai_memory_get',
  'mcp__dai-memory__dai_memory_neighbors',
  'mcp__dai-memory__dai_memory_write',
].join(',');

const env = {
  ...process.env,
  // No Postgres, no Brain Core: memory comes from the MCP server above.
  CORE_URL: process.env.CORE_URL ?? 'none',
  GATEWAY_PORT: value('port', process.env.GATEWAY_PORT ?? '8080'),
  GATEWAY_DEV_SCOPE: process.env.GATEWAY_DEV_SCOPE ?? `me/me/${value('project', 'personal')}`,
  // The plugin's store takes one writer, so two turns at once would collide.
  GATEWAY_MAX_CONCURRENCY: process.env.GATEWAY_MAX_CONCURRENCY ?? '1',
  GATEWAY_EXTRA_MCP_CONFIG: mcpPath,
  GATEWAY_EXTRA_ALLOWED_TOOLS: value('tools', process.env.GATEWAY_EXTRA_ALLOWED_TOOLS ?? DEFAULT_TOOLS),
  GATEWAY_SESSION_ROOT: process.env.GATEWAY_SESSION_ROOT ?? join(homedir(), '.dai-brain'),
  // Every turn runs here, so a file-backed memory server finds its store.
  GATEWAY_PROJECT_DIR: projectDir,
  GATEWAY_MAX_CONVERSATION_COST_USD: value('budget', process.env.GATEWAY_MAX_CONVERSATION_COST_USD ?? '5'),
  GATEWAY_WRITEBACK: 'false',
};
delete env.DATABASE_URL;

const model = value('model', process.env.CLAUDE_MODEL);
if (model) env.CLAUDE_MODEL = model;

const entry = join(root, 'gateway', 'dist', 'server-cli.js');
if (!existsSync(entry)) {
  console.error(`[chat] ${entry} is missing. Run: pnpm install && pnpm build`);
  process.exit(1);
}

console.log(`[chat] project:  ${env.GATEWAY_PROJECT_DIR}`);
console.log(`[chat] http://localhost:${env.GATEWAY_PORT}\n`);
spawn(process.execPath, [entry], { stdio: 'inherit', env })
  .on('exit', (code) => process.exit(code ?? 0));
