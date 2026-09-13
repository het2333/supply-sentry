import { resolve } from 'node:path';
import { openPersistence } from '@readywork/persistence';
import { assertPublicDemoConfiguration, PUBLIC_DEMO_TENANT_ID } from '../../apps/api/src/public-demo-mode.js';
import { resetPublicDemo } from '../../apps/api/src/public-demo-reset.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resetInstant(): Date {
  const raw = argument('--reset-at');
  if (!raw) return new Date();
  const value = new Date(raw);
  if (!Number.isFinite(value.getTime()) || value.toISOString() !== raw) {
    throw new Error('--reset-at must be an RFC 3339 UTC instant');
  }
  return value;
}

assertPublicDemoConfiguration();
const databasePath = process.env['DB_PATH'];
if (!databasePath || databasePath === ':memory:') throw new Error('DB_PATH must name a dedicated public-demo SQLite file');

const store = openPersistence(resolve(databasePath), { tenantId: PUBLIC_DEMO_TENANT_ID });
try {
  process.stdout.write(`${JSON.stringify(resetPublicDemo(store.db, resetInstant()))}\n`);
} finally {
  store.close();
}
