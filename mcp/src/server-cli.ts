#!/usr/bin/env node
import { createServer } from 'node:http';
import { createMcpHandler, MCP_VERSION } from './server.js';

const port = Number.parseInt(process.env.MCP_PORT ?? '8082', 10);
const coreUrl = process.env.CORE_URL ?? 'http://localhost:8081';

const server = createServer(createMcpHandler({ coreUrl }));
server.listen(port, () => {
  console.log(`[mcp] dai-brain-memory ${MCP_VERSION} on :${port} -> core at ${coreUrl}`);
  console.log('[mcp] tools: memory_search, memory_graph_explore, memory_get, memory_write');
  console.log(`[mcp] scope is read from the ${'X-Scope'} header; requests without one are refused`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
