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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[gateway] ${signal}, shutting down`);
    void gateway.close().then(() => process.exit(0));
  });
}
