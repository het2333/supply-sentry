import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementDeploymentProfileRequest } from '../src/procurement-deployment-profile.js';

const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

function token(tenantId: string, role: string, humanId: string): string {
  const session: Session = { username: humanId, tenantId, humanId, name: humanId, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

test('采购部署模式：默认 Odoo、权限、纯邮箱切换、乐观锁、审计与租户隔离', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:deployment-a' });
  const fixed = new Date('2026-08-28T12:00:00.000Z');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers['authorization'];
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleProcurementDeploymentProfileRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(bearer), now: () => fixed,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = token('tenant:deployment-a', '采购专员', 'human:buyer');
  const manager = token('tenant:deployment-a', '采购经理', 'human:manager');
  const other = token('tenant:deployment-b', '采购经理', 'human:other');

  async function request(authToken: string, options: { method?: string; body?: Record<string, unknown> } = {}) {
    const response = await fetch(`${base}/api/procurement/deployment-profile`, {
      method: options.method ?? 'GET',
      headers: { authorization: `Bearer ${authToken}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  try {
    const initial = await request(buyer);
    assert.equal(initial.status, 200);
    assert.equal(initial.body['item'], null);
    assert.equal(initial.body['effectiveMode'], 'odoo_connected');
    assert.equal(initial.body['inheritedDefault'], true);
    assert.deepEqual(initial.body['permissions'], { read: true, configure: false });

    const denied = await request(buyer, { method: 'PUT', body: { expectedVersion: 0, mode: 'email_only', reason: '采购订单仅通过企业邮箱接收和核验' } });
    assert.equal(denied.status, 403);

    const shortReason = await request(manager, { method: 'PUT', body: { expectedVersion: 0, mode: 'email_only', reason: '太短' } });
    assert.equal(shortReason.status, 422);
    assert.equal(shortReason.body['code'], 'INVALID_DEPLOYMENT_PROFILE');

    const created = await request(manager, { method: 'PUT', body: { expectedVersion: 0, mode: 'email_only', reason: '采购订单仅通过企业邮箱接收和人工核验' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body['effectiveMode'], 'email_only');
    assert.equal(created.body['inheritedDefault'], false);
    assert.equal(created.body['item']['version'], 1);
    assert.equal(created.body['events'][0]['action'], 'created');
    assert.equal(created.body['events'][0]['detail']['previousMode'], 'odoo_connected');

    const conflict = await request(manager, { method: 'PUT', body: { expectedVersion: 0, mode: 'odoo_connected', reason: '恢复使用本地 Odoo 作为采购记录系统' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body['currentVersion'], 1);

    const updated = await request(manager, { method: 'PUT', body: { expectedVersion: 1, mode: 'odoo_connected', reason: '恢复使用本地 Odoo 作为采购记录系统' } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body['item']['version'], 2);
    assert.equal(updated.body['effectiveMode'], 'odoo_connected');
    assert.deepEqual(updated.body['events'].map((event: Record<string, unknown>) => event['action']), ['mode_changed', 'created']);

    const isolated = await request(other);
    assert.equal(isolated.body['item'], null);
    assert.equal(isolated.body['effectiveMode'], 'odoo_connected');
    assert.deepEqual(isolated.body['events'], []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
