import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { HermesRepository, type HermesPlatformAction } from '../src/messaging/hermes-repository.js';

test('Hermes repository isolates stable profiles, snapshots, nonces, receipts and secret-free actions', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:root' });
  try {
    const a = new HermesRepository(store.db, 'tenant:a');
    const b = new HermesRepository(store.db, 'tenant:b');
    const profileA = a.profileForTenant('2026-09-09T00:00:00.000Z');
    assert.equal(a.profileForTenant('2026-09-09T00:01:00.000Z'), profileA);
    assert.match(profileA, /^rw-[a-f0-9]{24}$/u);
    assert.notEqual(b.profileForTenant('2026-09-09T00:00:00.000Z'), profileA);

    a.savePlatformSnapshot({
      capturedAt: '2026-09-09T00:02:00.000Z',
      catalog: { platforms: [{ id: 'telegram', name: 'Telegram', configured: false }] },
    });
    b.savePlatformSnapshot({
      capturedAt: '2026-09-09T00:03:00.000Z',
      catalog: { platforms: [{ id: 'slack', name: 'Slack', configured: false }] },
    });
    assert.deepEqual(a.latestPlatformSnapshot()?.catalog, {
      platforms: [{ id: 'telegram', name: 'Telegram', configured: false }],
    });

    assert.equal(a.consumeNonce('nonce-001', '2026-09-09T00:00:00.000Z', '2026-09-09T00:05:00.000Z'), true);
    assert.equal(a.consumeNonce('nonce-001', '2026-09-09T00:01:00.000Z', '2026-09-09T00:06:00.000Z'), false);
    assert.equal(b.consumeNonce('nonce-001', '2026-09-09T00:01:00.000Z', '2026-09-09T00:06:00.000Z'), true);

    a.recordBridgeReceipt({
      requestId: 'bridge:one',
      requestFingerprint: 'a'.repeat(64),
      inboundId: 'inbound:one',
      result: { persisted: true },
      createdAt: '2026-09-09T00:02:00.000Z',
    });
    assert.deepEqual(a.bridgeReceipt('bridge:one')?.result, { persisted: true });

    a.recordPlatformAction({
      idempotencyKey: 'action:one',
      platformId: 'telegram',
      action: 'configure',
      requestFingerprint: 'b'.repeat(64),
      response: { ok: true },
      configuredFields: ['TELEGRAM_BOT_TOKEN'],
      secretFingerprints: { TELEGRAM_BOT_TOKEN: 'c'.repeat(64) },
      actorId: 'admin:a',
      createdAt: '2026-09-09T00:04:00.000Z',
    });
    const row = store.db.prepare(`SELECT configured_fields_json,secret_fingerprints_json,response_json
      FROM hermes_platform_actions WHERE tenant_id=? AND idempotency_key=?`).get('tenant:a', 'action:one') as Record<string, string>;
    assert.deepEqual(JSON.parse(row.configured_fields_json!), ['TELEGRAM_BOT_TOKEN']);
    assert.deepEqual(JSON.parse(row.secret_fingerprints_json!), { TELEGRAM_BOT_TOKEN: 'c'.repeat(64) });
    assert.equal(JSON.stringify(row).includes('real-telegram-secret'), false);
  } finally {
    store.close();
  }
});

test('Hermes repository rejects a reused action key with a different request', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  try {
    const repository = new HermesRepository(store.db, 'tenant:a');
    const input: HermesPlatformAction = {
      idempotencyKey: 'action:same',
      platformId: 'telegram',
      action: 'test',
      requestFingerprint: 'd'.repeat(64),
      response: { ok: false },
      configuredFields: [] as string[],
      secretFingerprints: {},
      actorId: 'admin:a',
      createdAt: '2026-09-09T00:00:00.000Z',
    };
    assert.equal(repository.recordPlatformAction(input).replayed, false);
    assert.equal(repository.recordPlatformAction(input).replayed, true);
    assert.throws(() => repository.recordPlatformAction({ ...input, requestFingerprint: 'e'.repeat(64) }), /幂等键/u);
  } finally {
    store.close();
  }
});
