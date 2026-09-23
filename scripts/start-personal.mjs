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

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

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

const mcpPath = resolve(value('mcp', join(root, 'plugin-mcp.json')));
if (!existsSync(mcpPath)) {
  // A starter file rather than an error: the one thing everyone needs and the
  // one thing that is tedious to look up.
  writeFileSync(mcpPath, `${JSON.stringify({
    mcpServers: { 'dai-memory': { command: 'dai-memory', args: ['serve'] } },
  }, null, 2)}\n`, 'utf8');
  console.log(`[chat] wrote ${mcpPath} — edit it if your memory server differs\n`);
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
  GATEWAY_PROJECT_DIR: resolve(value('dir', process.env.GATEWAY_PROJECT_DIR ?? process.cwd())),
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
