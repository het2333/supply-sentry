import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { MessagingRuntime } from '../src/messaging/runtime.js';
import { HermesRepository } from '../src/messaging/hermes-repository.js';
import { handleHermesIntegrationRequest } from '../src/messaging/hermes-bridge.js';

const secret = 'bridge-secret-with-at-least-thirty-two-bytes';
const now = '2026-09-09T10:00:00.000Z';

function signature(method: string, path: string, timestamp: string, nonce: string, body: string): string {
  return createHmac('sha256', secret).update([method, path, timestamp, nonce, body].join('\n')).digest('hex');
}

test('Hermes HMAC inbound persists once, replays safely and rejects tampering', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  const runtime = new MessagingRuntime(store.db, 'tenant:a', { listCredentials: () => [], getCredential: () => undefined }, { now: () => now });
  const profile = new HermesRepository(store.db, 'tenant:a').profileForTenant(now);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleHermesIntegrationRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db,
      bridgeSecret: secret,
      runtimeForTenant: () => runtime,
      now: () => now,
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    }).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  const payload = {
    requestId: 'bridge-request-001',
    profile,
    event: {
      platform: 'telegram',
      messageId: 'provider-message-001',
      conversationId: 'chat-001',
      sender: { address: 'supplier-42', displayName: '供应商四十二' },
      recipients: [{ address: 'readywork' }],
      text: '订单 P00088 可以按期交付。',
      occurredAt: now,
    },
    attachments: [],
  };
  const body = JSON.stringify(payload);
  const send = async (nonce: string, override: Record<string, string> = {}) => {
    const path = '/api/integrations/hermes/v1/inbound';
    const timestamp = String(Date.parse(now));
    const headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'X-Readywork-Bridge-Version': 'readywork.hermes.bridge.v1',
      'X-Readywork-Timestamp': timestamp,
      'X-Readywork-Nonce': nonce,
      'X-Readywork-Signature': signature('POST', path, timestamp, nonce, body),
      ...override,
    };
    return await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path,
        method: 'POST',
        headers,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        }));
      });
      req.on('error', reject);
      req.end(body);
    });
  };

  try {
    const accepted = await send('nonce-accepted-001');
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.persisted, true);
    assert.equal(accepted.body.replayed, false);
    const row = store.db.prepare(`SELECT channel,provider_message_id,envelope_json
      FROM messaging_inbound_messages WHERE tenant_id=?`).get('tenant:a') as Record<string, string>;
    assert.equal(row.channel, 'telegram');
    assert.equal(row.provider_message_id, 'provider-message-001');
    assert.match(row.envelope_json!, /订单 P00088/u);

    const replay = await send('nonce-accepted-002');
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM messaging_inbound_messages').get() as { count: number }).count, 1);

    const repeatedNonce = await send('nonce-accepted-002');
    assert.equal(repeatedNonce.status, 409);

    const tampered = await send('nonce-tampered-001', { 'X-Readywork-Signature': '0'.repeat(64) });
    assert.equal(tampered.status, 401);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM messaging_inbound_messages').get() as { count: number }).count, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});

test('Hermes HMAC inbound rejects stale timestamps, unknown versions and unmapped profiles', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  try {
    const runtime = new MessagingRuntime(store.db, 'tenant:a', { listCredentials: () => [], getCredential: () => undefined });
    const base = {
      db: store.db,
      bridgeSecret: secret,
      runtimeForTenant: () => runtime,
      now: () => now,
    };
    const { verifyHermesBridgeRequest, ingestHermesInboundBody } = await import('../src/messaging/hermes-bridge.js');
    const body = Buffer.from(JSON.stringify({
      requestId: 'bridge-request-002',
      profile: 'rw-000000000000000000000000',
      event: {
        platform: 'telegram',
        messageId: 'provider-message-002',
        sender: { address: 'supplier' },
        recipients: [],
        text: 'hello',
        occurredAt: now,
      },
      attachments: [],
    }));
    assert.throws(() => verifyHermesBridgeRequest({
      method: 'POST',
      path: '/api/integrations/hermes/v1/inbound',
      headers: {
        'x-readywork-bridge-version': 'unknown',
        'x-readywork-timestamp': String(Date.parse(now)),
        'x-readywork-nonce': 'nonce-version-001',
        'x-readywork-signature': '0'.repeat(64),
      },
      rawBody: body,
      secret,
      now: () => now,
    }), /版本/u);
    const staleAt = String(Date.parse(now) - 301_000);
    assert.throws(() => verifyHermesBridgeRequest({
      method: 'POST',
      path: '/api/integrations/hermes/v1/inbound',
      headers: {
        'x-readywork-bridge-version': 'readywork.hermes.bridge.v1',
        'x-readywork-timestamp': staleAt,
        'x-readywork-nonce': 'nonce-stale-001',
        'x-readywork-signature': signature('POST', '/api/integrations/hermes/v1/inbound', staleAt, 'nonce-stale-001', body.toString('utf8')),
      },
      rawBody: body,
      secret,
      now: () => now,
    }), /时间戳/u);
    await assert.rejects(() => ingestHermesInboundBody(body, 'nonce-profile-001', base), /profile/u);
  } finally {
    store.close();
  }
});
