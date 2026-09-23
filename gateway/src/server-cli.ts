#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGatewayConfig } from './config.js';
import { startGateway, GATEWAY_VERSION } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadGatewayConfig();
// dist/ -> gateway/ -> repo root -> ui/public
if (!config.uiRoot) config.uiRoot = join(here, '..', '..', 'ui', 'public');

const gateway = await startGateway(config);
console.log(`[gateway] dai-brain-gateway ${GATEWAY_VERSION} on :${config.port}`);
console.log(`[gateway]   store:       ${config.databaseUrl ? 'postgres' : `sqlite — ${config.sqlitePath}`}`);
console.log(`[gateway]   core:        ${config.coreUrl ?? 'none (memory comes from the runner\'s MCP servers)'}`);
console.log(`[gateway]   mcp:         ${config.mcpUrl ?? 'none'}`);
console.log(`[gateway]   runner:      ${config.claudeBin} (max ${config.maxConcurrency} concurrent)`);
console.log(`[gateway]   write-back:  ${config.writebackEnabled ? `on, ${config.writebackModel}` : 'off'}`);
if (config.extraMcpConfigPath) {
  console.log(`[gateway]   extra mcp:   ${config.extraMcpConfigPath}`);
  console.log(`[gateway]   extra tools: ${config.extraAllowedTools.join(', ') || '(none listed — those servers are unreachable)'}`);
}
console.log(`[gateway]   ui:          ${config.uiRoot}`);
if (config.devScope) {
  console.log(`[gateway]   AUTH DISABLED — every request runs as ${config.devScope}`);
}

console.log(`[gateway]   model:       ${config.model ?? "(CLI default)"}`);
console.log(`[gateway]   cost ceiling: ${config.maxConversationCostUsd > 0
  ? `$${config.maxConversationCostUsd.toFixed(2)} per conversation`
  : 'none — GATEWAY_MAX_CONVERSATION_COST_USD=0'}`);
if (!config.model) {
  // Every message spawns a whole CLI session, and unset means the default
  // model, which is the expensive one. For a personal chat window that is
  // almost always money for nothing.
  console.warn(
    '[gateway]   WARNING: CLAUDE_MODEL is not set, so every turn runs on the CLI\'s default '
    + 'model.\n[gateway]            Set CLAUDE_MODEL to something cheaper if this is a personal chat window.',
  );
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '[gateway]   WARNING: ANTHROPIC_API_KEY is not set, so the runner bills whatever account the '
    + 'CLI is\n[gateway]            logged into — including your own subscription quota.',
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[gateway] ${signal}, shutting down`);
    void gateway.close().then(() => process.exit(0));
  });
}
