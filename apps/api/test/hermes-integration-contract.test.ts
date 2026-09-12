import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import type { MessageDeliveryRequest } from '@readywork/messaging';
import type { Session } from '../src/auth.js';
import { handleHermesIntegrationRequest, HERMES_BRIDGE_VERSION } from '../src/messaging/hermes-bridge.js';
import { HermesControlClient } from '../src/messaging/hermes-control-client.js';
import { HermesMessagingAdapter } from '../src/messaging/hermes-adapter.js';
import { HermesRepository } from '../src/messaging/hermes-repository.js';
import { handleHermesMessagingRequest } from '../src/messaging/hermes-routes.js';
import { MessagingRuntimeRegistry } from '../src/messaging/runtime.js';

const bridgeSecret = 'integration-bridge-secret-at-least-thirty-two-bytes';
const session: Session = {
  username: 'admin', tenantId: 't:acme', humanId: 'h:admin', name: '管理员', role: '管理员',
  expiresAt: Date.now() + 60_000,
};

function jsonResponse(response: import('node:http').ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

test('Hermes 集成合同串联官方目录、健康状态、动态渠道和 HMAC 持久入站', async () => {
  const upstream = createServer((request, response) => {
    assert.equal(request.headers['x-hermes-session-token'], 'dashboard-session-token');
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/api/messaging/platforms') {
      jsonResponse(response, { platforms: [
        {
          id: 'readywork_bridge', name: 'Readywork Bridge', description: 'internal', docs_url: '',
          enabled: true, configured: true, gateway_running: true, state: 'connected', error_code: null,
          error_message: null, updated_at: null, env_vars: [],
        },
        {
          id: 'future_channel', name: 'Future Channel', description: 'dynamic', docs_url: 'https://example.test/docs',
          enabled: true, configured: false, gateway_running: true, state: 'not_configured', error_code: null,
          error_message: null, updated_at: null,
          env_vars: [{ key: 'FUTURE_TOKEN', required: true, is_set: false, description: 'token', prompt: 'token', help: '', url: null, is_password: true, advanced: false }],
        },
      ] });
      return;
    }
    if (path === '/api/health') return jsonResponse(response, { ok: true, version: '0.21.1' });
    if (path === '/api/status') return jsonResponse(response, { gateway_running: true, gateway_state: 'running' });
    jsonResponse(response, { error: 'not found' }, 404);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('upstream did not bind');

  const store = openPersistence(':memory:', { tenantId: session.tenantId });
  const control = new HermesControlClient({
    baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    token: async () => 'dashboard-session-token',
  });
  const runtimes = new MessagingRuntimeRegistry(
    store.db,
    () => ({ listCredentials: () => [], getCredential: () => undefined }),
    { hermesBridge: { baseUrl: 'http://127.0.0.1:1', secret: bridgeSecret } },
  );
  const readywork = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const method = request.method ?? 'GET';
    void (async () => {
      if (await handleHermesIntegrationRequest(request, response, path, method, {
        db: store.db,
        bridgeSecret,
        runtimeForTenant: (tenantId) => runtimes.forTenant(tenantId),
      })) return;
      if (await handleHermesMessagingRequest(request, response, path, method, {
        db: store.db,
        session,
        control,
        synchronizePlatforms: (tenantId, platforms) => runtimes.forTenant(tenantId).synchronizeHermesPlatforms(platforms),
      })) return;
      jsonResponse(response, { error: 'not found' }, 404);
    })().catch((error) => jsonResponse(response, { error: error instanceof Error ? error.message : 'failure' }, 500));
  });
  await new Promise<void>((resolve) => readywork.listen(0, '127.0.0.1', resolve));
  const readyworkAddress = readywork.address();
  if (!readyworkAddress || typeof readyworkAddress === 'string') throw new Error('Readywork did not bind');
  const baseUrl = `http://127.0.0.1:${readyworkAddress.port}`;

  try {
    const platformsResponse = await fetch(`${baseUrl}/api/messaging/platforms`);
    assert.equal(platformsResponse.status, 200);
    const platforms = await platformsResponse.json() as { stale: boolean; platforms: Array<{ id: string; configured: boolean }> };
    assert.equal(platforms.stale, false);
    assert.deepEqual(platforms.platforms.map((platform) => platform.id), ['future_channel']);
    assert.equal(platforms.platforms[0]?.configured, false, '无凭据的渠道不得伪装已连接');
    assert.equal(runtimes.forTenant(session.tenantId).getAdapterState('hermes:future_channel').status, 'unconfigured');

    const healthResponse = await fetch(`${baseUrl}/api/messaging/hermes/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json() as { status: string; sidecar: { ok: boolean }; bridge: { ok: boolean } };
    assert.equal(health.status, 'running');
    assert.equal(health.sidecar.ok, true);
    assert.equal(health.bridge.ok, true);

    const profile = new HermesRepository(store.db, session.tenantId).profileForTenant(new Date().toISOString());
    const inbound = {
      requestId: 'integration-contract-request-001',
      profile,
      event: {
        platform: 'future_channel', messageId: 'provider-integration-001', conversationId: 'verification',
        inReplyTo: null, references: [], sender: { address: 'integration-verifier' },
        recipients: [{ address: 'readywork' }], subject: null,
        text: 'Readywork Hermes 集成验证事件（非供应商业务消息）', occurredAt: new Date().toISOString(),
        threadId: null, raw: { verification: true },
      },
      attachments: [],
    };
    const body = JSON.stringify(inbound);
    const timestamp = String(Date.now());
    const nonce = 'integration-nonce-001';
    const path = '/api/integrations/hermes/v1/inbound';
    const signature = createHmac('sha256', bridgeSecret).update(['POST', path, timestamp, nonce, body].join('\n')).digest('hex');
    const inboundResponse = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Readywork-Bridge-Version': HERMES_BRIDGE_VERSION,
        'X-Readywork-Timestamp': timestamp,
        'X-Readywork-Nonce': nonce,
        'X-Readywork-Signature': signature,
      },
      body,
    });
    assert.equal(inboundResponse.status, 200);
    const receipt = await inboundResponse.json() as { persisted: boolean; inboundId: string };
    assert.equal(receipt.persisted, true);
    const row = store.db.prepare('SELECT provider_message_id,channel FROM messaging_inbound_messages WHERE id=?')
      .get(receipt.inboundId) as { provider_message_id: string; channel: string } | undefined;
    assert.equal(row?.provider_message_id, 'provider-integration-001');
    assert.equal(row?.channel, 'future_channel');

    let externalCalls = 0;
    const unavailable = new HermesMessagingAdapter('future_channel', {
      baseUrl: 'http://127.0.0.1:8788', secret: bridgeSecret,
      profile,
      fetch: async () => {
        externalCalls += 1;
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
    });
    const delivery: MessageDeliveryRequest = {
      tenantId: session.tenantId, adapterId: 'hermes:future_channel', channel: 'future_channel',
      idempotencyKey: 'integration-unavailable-001', recipients: [{ address: 'target' }], text: '验证', attachments: [],
      trace: { source: 'integration_verification', sourceId: 'none', correlationId: 'integration-001' },
    };
    assert.deepEqual(await unavailable.send(delivery), { kind: 'retryable_before_dispatch', error: 'Hermes Bridge 当前不可达' });
    assert.equal(externalCalls, 1);
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => readywork.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())),
    ]);
    store.close();
  }
});
