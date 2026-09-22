#!/usr/bin/env node
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const config = loadConfig();
const db = createPool(config);
try {
  const result = await migrate(db, config.embeddingDims);
  console.log(`[core] storage mode: ${result.vectorMode}`);
  console.log(`[core] applied: ${result.applied.join(', ') || '(none)'}`);
  console.log(`[core] already applied: ${result.skipped.join(', ') || '(none)'}`);
} finally {
  await db.end();
}
