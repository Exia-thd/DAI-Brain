#!/usr/bin/env node
/**
 * Registers the DAI Brain memory server with your own Claude Code CLI.
 *
 * A wrapper around one `claude mcp add` because the command has three things
 * that are easy to get subtly wrong: the transport must be http, the scope
 * header is mandatory (the server refuses a request without one rather than
 * guessing whose memory you meant), and the server name you pick becomes the
 * tool prefix the model sees.
 *
 *   pnpm mcp:add                               acme/me/daibrain on :8082
 *   pnpm mcp:add --scope acme/thd/daibrain
 *   pnpm mcp:add --name memory --user-scope    also available outside this repo
 */

import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 || at === argv.length - 1 ? fallback : argv[at + 1];
};

if (flag('help')) {
  console.log(`Usage: pnpm mcp:add [options]

  --scope <t/u/p>   memory scope            (default: $DAI_BRAIN_SCOPE or acme/me/daibrain)
  --url <url>       MCP server url          (default: $DAI_BRAIN_MCP_URL or http://localhost:8082/mcp)
  --name <name>     server name, which sets the tool prefix mcp__<name>__*  (default: dai-brain)
  --user-scope      register for every project, not just this directory
`);
  process.exit(0);
}

const scope = value('scope', process.env.DAI_BRAIN_SCOPE ?? 'acme/me/daibrain');
const url = value('url', process.env.DAI_BRAIN_MCP_URL ?? 'http://localhost:8082/mcp');
const name = value('name', 'dai-brain');
const configScope = flag('user-scope') ? 'user' : 'local';

if (!/^[\w.-]+\/[\w.-]+\/([\w.-]+|\*)$/.test(scope)) {
  console.error(`--scope must be tenant/user/project (got ${JSON.stringify(scope)})`);
  process.exit(1);
}

const args = [
  'mcp', 'add', '--transport', 'http', '--scope', configScope,
  name, url, '--header', `X-Scope: ${scope}`,
];

console.log(`claude ${args.join(' ')}\n`);
const result = spawnSync(process.env.CLAUDE_BIN ?? 'claude', args, { stdio: 'inherit' });

if (result.error) {
  console.error(
    `\nCould not run the Claude CLI: ${result.error.message}\n`
    + 'Install it with `npm i -g @anthropic-ai/claude-code`, or set CLAUDE_BIN to its path.',
  );
  process.exit(1);
}
if (result.status === 0) {
  console.log(`\nTools are now mcp__${name}__memory_search, _graph_explore, _get and _write.`);
  console.log('Check it with: claude mcp list');
}
process.exit(result.status ?? 1);
