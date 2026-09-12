import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { MessagingRuntimeRegistry } from '../src/messaging/runtime.js';
import { handleMessagingRequest } from '../src/messaging-routes.js';

const at = '2026-09-08T00:00:00.000Z';
const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

function token(tenantId: string, role: string, humanId: string): string {
  const session: Session = { username: humanId, tenantId, humanId, name: humanId, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

test('消息网关 API 隔离租户、保护权限并提供幂等暂停恢复与脱敏异常列表', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  const registry = new MessagingRuntimeRegistry(store.db, () => ({
    listCredentials: () => [{ id: 'credential:email', connectorId: 'email', status: 'connected' }],
    getCredential: () => ({ username: 'buyer@example.test', authorizationCode: 'never-return-this-secret' }),
  }), { now: () => at });
  const runtimeA = registry.forTenant('tenant:a');
  const delivery = runtimeA.repository.reserveDelivery({
    tenantId: 'tenant:a',
    adapterId: 'email',
    channel: 'email',
    idempotencyKey: 'delivery:unknown',
    recipients: [{ address: 'supplier@example.test' }],
    subject: 'P00021',
    text: '不得通过运维 API 返回的邮件正文',
    attachments: [],
    trace: { source: 'procurement_outbox', sourceId: 'outbox:one', correlationId: 'po:one' },
  }, at).delivery;
  const sending = runtimeA.repository.markDeliverySending(delivery.id, delivery.version, at);
  runtimeA.repository.failDelivery(sending.id, sending.version, {
    kind: 'unknown_after_dispatch',
    error: 'SMTP DATA 后连接中断',
  }, at);
  registry.forTenant('tenant:b');

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleMessagingRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db,
      session: resolveSession(bearer),
      runtimeForTenant: (tenantId) => registry.forTenant(tenantId),
      now: () => at,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const admin = token('tenant:a', '管理员', 'admin:a');
  const manager = token('tenant:a', '采购经理', 'manager:a');

  async function request(path: string, options: {
    method?: string;
    token?: string;
    idempotencyKey?: string;
    body?: Record<string, unknown>;
  } = {}) {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const body = await response.json() as Record<string, any>;
    return { status: response.status, body, raw: JSON.stringify(body) };
  }

  try {
    assert.equal((await request('/api/messaging/gateway')).status, 401);
    const read = await request('/api/messaging/gateway', { token: manager });
    assert.equal(read.status, 200);
    assert.equal(read.body.status, 'degraded');
    assert.equal(read.body.adapters.length, 1);
    assert.equal(read.body.adapters[0].id, 'email');
    assert.equal(read.body.adapters[0].exceptionalDeliveries, 1);
    assert.equal(read.raw.includes('never-return-this-secret'), false);
    assert.equal(read.raw.includes('不得通过运维 API 返回的邮件正文'), false);

    assert.equal((await request('/api/messaging/adapters/email/pause', {
      method: 'POST', token: manager, idempotencyKey: 'pause:manager', body: { expectedVersion: 1, reason: '维护' },
    })).status, 403);
    assert.equal((await request('/api/messaging/adapters/email/pause', {
      method: 'POST', token: admin, body: { expectedVersion: 1, reason: '维护' },
    })).status, 400);

    const paused = await request('/api/messaging/adapters/email/pause', {
      method: 'POST', token: admin, idempotencyKey: 'pause:one', body: { expectedVersion: 1, reason: '服务商维护' },
    });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.adapter.status, 'paused');
    assert.equal(paused.body.adapter.version, 2);
    const replay = await request('/api/messaging/adapters/email/pause', {
      method: 'POST', token: admin, idempotencyKey: 'pause:one', body: { expectedVersion: 1, reason: '服务商维护' },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.adapter.version, 2);
    assert.equal(replay.body.replayed, true);
    assert.equal((await request('/api/messaging/adapters/email/pause', {
      method: 'POST', token: admin, idempotencyKey: 'pause:one', body: { expectedVersion: 2, reason: '不同请求' },
    })).status, 409);

    assert.equal((await request('/api/messaging/adapters/email/resume', {
      method: 'POST', token: admin, idempotencyKey: 'resume:stale', body: { expectedVersion: 1, reason: '维护完成' },
    })).status, 409);
    const resumed = await request('/api/messaging/adapters/email/resume', {
      method: 'POST', token: admin, idempotencyKey: 'resume:one', body: { expectedVersion: 2, reason: '维护完成' },
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.adapter.status, 'degraded');
    assert.equal(resumed.body.adapter.version, 3);

    const exceptions = await request('/api/messaging/deliveries?status=unknown', { token: admin });
    assert.equal(exceptions.status, 200);
    assert.equal(exceptions.body.deliveries.length, 1);
    assert.equal(exceptions.body.deliveries[0].recipient, 's***@example.test');
    assert.equal(exceptions.raw.includes('不得通过运维 API 返回的邮件正文'), false);
    assert.equal(exceptions.raw.includes('supplier@example.test'), false);
    assert.equal((await request('/api/messaging/deliveries?status=accepted', { token: admin })).status, 400);

    const adminB=token('tenant:b','管理员','admin:b');
    const readB=await request('/api/messaging/gateway',{token:adminB});
    assert.equal(readB.body.adapters[0].exceptionalDeliveries,0);
    assert.equal(readB.body.adapters[0].version,1);
    assert.deepEqual((await request('/api/messaging/deliveries?status=unknown',{token:adminB})).body.deliveries,[]);
    const pausedB=await request('/api/messaging/adapters/email/pause',{
      method:'POST',token:adminB,idempotencyKey:'pause:one',body:{expectedVersion:1,reason:'租户乙维护',tenantId:'tenant:a'},
    });
    assert.equal(pausedB.status,200);
    assert.equal(pausedB.body.replayed,false,'same action key is isolated per authenticated tenant');
    assert.equal(registry.forTenant('tenant:a').getAdapterState('email').version,3);
    assert.equal(registry.forTenant('tenant:a').getAdapterState('email').status,'degraded');
    assert.equal(registry.forTenant('tenant:b').getAdapterState('email').status,'paused');
    runtimeA.gateway.register({id:'a-only',channel:'email',provider:'smtp',capabilities:[],health:async()=>({ok:false}),send:async()=>({kind:'failed_before_dispatch',error:'isolated'})});
    assert.equal((await request('/api/messaging/adapters/a-only/pause',{method:'POST',token:adminB,idempotencyKey:'cross-tenant',body:{expectedVersion:1,reason:'unauthorized target',tenantId:'tenant:a'}})).status,404);
    assert.equal(runtimeA.getAdapterState('a-only').status,'degraded');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
