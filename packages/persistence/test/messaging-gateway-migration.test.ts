import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';

const gatewayTables = [
  'messaging_inbound_messages',
  'messaging_deliveries',
  'messaging_adapter_states',
  'messaging_gateway_events',
  'messaging_gateway_actions',
] as const;

test('migration 53 installs tenant-scoped messaging gateway tables and constraints', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:gateway' });
  try {
    const migration = store.db.prepare('SELECT name FROM schema_migrations WHERE version=53').get() as { name: string } | undefined;
    assert.equal(migration?.name, 'messaging-gateway-boundaries');
    const dynamicChannels = store.db.prepare('SELECT name FROM schema_migrations WHERE version=55').get() as { name: string } | undefined;
    assert.equal(dynamicChannels?.name, 'messaging-dynamic-channel-identifiers');

    for (const table of gatewayTables) {
      assert.ok(
        store.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table),
        `${table} must exist`,
      );
    }

    assert.throws(() => store.db.prepare(`INSERT INTO messaging_deliveries
      (tenant_id,id,adapter_id,channel,idempotency_key,request_fingerprint,status,request_json,attempts,version,created_at,updated_at)
      VALUES ('tenant:gateway','delivery:invalid','email','email','key:invalid','hash','invented','{}',0,1,'2026-09-08T00:00:00.000Z','2026-09-08T00:00:00.000Z')`).run(), /CHECK constraint failed/u);
    assert.throws(() => store.db.prepare(`INSERT INTO messaging_adapter_states
      (tenant_id,adapter_id,channel,provider,status,capabilities_json,consecutive_failures,version,created_at,updated_at)
      VALUES ('tenant:gateway','email','email','smtp','invented','[]',0,1,'2026-09-08T00:00:00.000Z','2026-09-08T00:00:00.000Z')`).run(), /CHECK constraint failed/u);

    for (const channel of ['telegram', 'wecom_callback', 'future-platform:v2']) {
      store.db.prepare(`INSERT INTO messaging_adapter_states
        (tenant_id,adapter_id,channel,provider,status,capabilities_json,consecutive_failures,version,created_at,updated_at,configured)
        VALUES (?,?,?,?,?,'[]',0,1,?,?,0)`).run(
          'tenant:gateway',
          `adapter:${channel}`,
          channel,
          'hermes',
          'unconfigured',
          '2026-09-08T00:00:00.000Z',
          '2026-09-08T00:00:00.000Z',
        );
    }

    for (const channel of ['', ' ', '../email', 'UpperCase', `a${'b'.repeat(96)}`]) {
      assert.throws(() => store.db.prepare(`INSERT INTO messaging_adapter_states
        (tenant_id,adapter_id,channel,provider,status,capabilities_json,consecutive_failures,version,created_at,updated_at,configured)
        VALUES (?,?,?,?,?,'[]',0,1,?,?,0)`).run(
          'tenant:gateway',
          `invalid:${channel}`,
          channel,
          'hermes',
          'unconfigured',
          '2026-09-08T00:00:00.000Z',
          '2026-09-08T00:00:00.000Z',
        ), /CHECK constraint failed/u, channel);
    }
  } finally {
    store.close();
  }
});
