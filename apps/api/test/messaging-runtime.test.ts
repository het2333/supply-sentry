import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import type { MessageDeliveryRequest } from '@readywork/messaging';
import { MessagingRuntimeRegistry } from '../src/messaging/runtime.js';

const at = '2026-09-08T00:00:00.000Z';

function request(): MessageDeliveryRequest {
  return {
    tenantId: 'tenant:one',
    adapterId: 'email',
    channel: 'email',
    idempotencyKey: 'outbox:one',
    sender: { displayName: '李采购' },
    recipients: [{ address: 'supplier@example.test' }],
    subject: '采购订单 P00021',
    text: '请确认订单。',
    attachments: [],
    trace: { source: 'procurement_outbox', sourceId: 'outbox:one', correlationId: 'po:one' },
  };
}

test('Messaging runtime resolves the current verified tenant credential and never persists its secret', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const calls: Array<{ host: string; port: number; user: string; pass: string }> = [];
    const registry = new MessagingRuntimeRegistry(store.db, () => ({
      listCredentials: () => [{ id: 'credential:email', connectorId: 'email', status: 'connected' }],
      getCredential: () => ({
        smtpHost: 'smtp.example.test',
        smtpPort: 465,
        username: 'buyer@example.test',
        authorizationCode: 'super-secret-authorization-code',
      }),
    }), {
      now: () => at,
      sendMail: async (host, port, user, pass, mail) => {
        calls.push({ host, port, user, pass });
        return { ok: true, message: 'accepted', messageId: mail.messageId, acceptedAt: at };
      },
    });

    const receipt = await registry.forTenant('tenant:one').deliver(request());

    assert.equal(receipt.status, 'accepted');
    assert.deepEqual(calls, [{
      host: 'smtp.example.test',
      port: 465,
      user: 'buyer@example.test',
      pass: 'super-secret-authorization-code',
    }]);
    const row = store.db.prepare(`SELECT request_json FROM messaging_deliveries WHERE tenant_id=?`)
      .get('tenant:one') as { request_json: string };
    assert.equal(row.request_json.includes('super-secret-authorization-code'), false);
    assert.strictEqual(registry.forTenant('tenant:one'), registry.forTenant('tenant:one'));
  } finally {
    store.close();
  }
});

test('Messaging runtime reports an unconfigured adapter and performs no SMTP I/O without verified credentials', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    let calls = 0;
    const registry = new MessagingRuntimeRegistry(store.db, () => ({
      listCredentials: () => [],
      getCredential: () => undefined,
    }), {
      now: () => at,
      sendMail: async () => {
        calls += 1;
        return { ok: false, message: 'must not run' };
      },
    });
    const runtime = registry.forTenant('tenant:one');

    assert.equal(runtime.getAdapterState('email').status, 'unconfigured');
    const receipt=await runtime.deliver(request());
    assert.equal(receipt.status,'blocked');
    assert.match(receipt.error ?? '',/未配置/u);
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

test('Messaging runtime registers every dynamic Hermes catalog channel with honest state', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const registry = new MessagingRuntimeRegistry(store.db, () => ({
      listCredentials: () => [],
      getCredential: () => undefined,
    }), {
      now: () => at,
      hermesBridge: {
        baseUrl: 'http://127.0.0.1:8788',
        secret: 'bridge-secret-with-at-least-thirty-two-bytes',
        fetch: async () => new Response('{}'),
      },
    });
    const runtime = registry.forTenant('tenant:one');
    runtime.synchronizeHermesPlatforms([
      { id: 'telegram', enabled: true, configured: true, state: 'connected' },
      { id: 'future_channel', enabled: false, configured: false, state: 'disabled' },
    ]);
    assert.equal(runtime.getAdapterState('hermes:telegram').status, 'running');
    assert.equal(runtime.getAdapterState('hermes:telegram').channel, 'telegram');
    assert.equal(runtime.getAdapterState('hermes:telegram').provider, 'hermes-gateway');
    assert.equal(runtime.getAdapterState('hermes:future_channel').status, 'disabled');
    assert.equal(runtime.adapterStates().filter((state) => state.adapterId.startsWith('hermes:')).length, 2);
    runtime.synchronizeHermesPlatforms([
      { id: 'telegram', enabled: true, configured: true, state: 'connected' },
    ]);
    assert.equal(runtime.adapterStates().filter((state) => state.adapterId === 'hermes:telegram').length, 1);
  } finally {
    store.close();
  }
});
