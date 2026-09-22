/** Shared test helpers. Tests run against a real Postgres — see tests/README.md. */
import { randomUUID } from 'node:crypto';

export const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/daibrain_test';

/** A fresh project per test file, so tests never see each other's memories. */
export function freshScope(prefix = 't') {
  return {
    tenant: 'test',
    user: 'tester',
    project: `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  };
}

export async function openService() {
  process.env.DATABASE_URL = DATABASE_URL;
  const { loadConfig, MemoryService } = await import('../core/dist/index.js');
  return MemoryService.open(loadConfig());
}

export async function cleanup(service, scope) {
  await service.db.query(
    'DELETE FROM memory_items WHERE tenant = $1 AND user_id = $2 AND project = $3',
    [scope.tenant, scope.user, scope.project],
  );
  await service.db.query(
    'DELETE FROM entities WHERE tenant = $1 AND user_id = $2 AND project = $3',
    [scope.tenant, scope.user, scope.project],
  );
}

/** True when a Postgres is reachable; tests skip rather than fail without one. */
export async function databaseAvailable() {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}
