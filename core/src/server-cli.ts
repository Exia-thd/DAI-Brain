#!/usr/bin/env node
import { loadConfig } from './config.js';
import { startCore } from './server.js';

const config = loadConfig();
const { server, service } = await startCore(config);
const health = await service.health();

console.log(`[core] listening on :${config.port}`);
for (const [name, cap] of Object.entries(health.capabilities)) {
  const mark = cap.status === 'available' ? 'ok' : cap.status;
  console.log(`[core]   ${name}: ${mark}${cap.detail ? ` — ${cap.detail}` : ''}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[core] ${signal}, shutting down`);
    server.close(() => { void service.close().then(() => process.exit(0)); });
  });
}
