import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementTenantPreferencesRequest } from '../src/procurement-tenant-preferences.js';

const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

function token(tenantId: string, role: string, humanId: string): string {
  const session: Session = { username: humanId, tenantId, humanId, name: humanId, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

test('采购区域偏好：默认值、校验、权限、乐观锁、审计与租户隔离', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:preferences-a' });
  const fixed = new Date('2026-08-30T08:00:00.000Z');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers['authorization'];
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleProcurementTenantPreferencesRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db,
      session: resolveSession(bearer),
      now: () => fixed,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = token('tenant:preferences-a', '采购专员', 'human:buyer');
  const manager = token('tenant:preferences-a', '采购经理', 'human:manager');
  const other = token('tenant:preferences-b', '采购经理', 'human:other');

  async function request(authToken = '', options: { method?: string; body?: Record<string, unknown> } = {}) {
    const response = await fetch(`${base}/api/procurement/tenant-preferences`, {
      method: options.method ?? 'GET',
      headers: { ...(authToken ? { authorization: `Bearer ${authToken}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  const valid = {
    expectedVersion: 0,
    countryCode: 'CN',
    workingDays: [1, 2, 3, 4, 5],
    timeZone: 'Asia/Shanghai',
    dateFormat: 'DD MMM YYYY',
    slaEscalationsEnabled: true,
    excludeWeekends: true,
    excludePublicHolidays: true,
    autoCalculateLeadTime: true,
    reason: '采用中国采购团队的正式工作日与显示规范',
  };

  try {
    assert.equal((await request()).status, 401);
    const initial = await request(buyer);
    assert.equal(initial.status, 200);
    assert.equal(initial.body['item'], null);
    assert.equal(initial.body['inheritedDefault'], true);
    assert.deepEqual(initial.body['effective'], {
      countryCode: 'CN', workingDays: [1, 2, 3, 4, 5], timeZone: 'Asia/Shanghai', dateFormat: 'DD MMM YYYY',
      slaEscalationsEnabled: true, excludeWeekends: true, excludePublicHolidays: true, autoCalculateLeadTime: true,
    });
    assert.deepEqual(initial.body['permissions'], { read: true, configure: false });

    assert.equal((await request(buyer, { method: 'PUT', body: valid })).status, 403);
    const missingWorkingDays = await request(manager, { method: 'PUT', body: { ...valid, workingDays: [] } });
    assert.equal(missingWorkingDays.status, 422);
    assert.equal(missingWorkingDays.body['error'], '工作日必须包含 1–7 个日期');
    for (const body of [
      { ...valid, workingDays: [1, 1] },
      { ...valid, timeZone: 'Mars/Olympus' },
      { ...valid, dateFormat: 'YY-M-D' },
      { ...valid, countryCode: 'China' },
      { ...valid, slaEscalationsEnabled: 'yes' },
      { ...valid, excludePublicHolidays: true, countryCode: 'ZZ' },
      { ...valid, workingDays: [6, 7], excludeWeekends: true },
      { ...valid, reason: '太短' },
      { ...valid, unknown: true },
    ]) {
      const invalid = await request(manager, { method: 'PUT', body });
      assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
      assert.equal(invalid.body['code'], 'INVALID_TENANT_PREFERENCES');
    }

    const created = await request(manager, { method: 'PUT', body: valid });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body['item']['version'], 1);
    assert.deepEqual(created.body['item']['workingDays'], [1, 2, 3, 4, 5]);
    assert.equal(created.body['events'][0]['action'], 'created');
    assert.equal(created.body['events'][0]['detail']['previous']['timeZone'], 'Asia/Shanghai');

    const replay = await request(manager, { method: 'PUT', body: valid });
    assert.equal(replay.status, 409);
    assert.equal(replay.body['currentVersion'], 1);

    const updated = await request(manager, { method: 'PUT', body: {
      ...valid,
      expectedVersion: 1,
      countryCode: 'GB',
      workingDays: [1, 2, 3, 4, 5, 6],
      timeZone: 'Europe/London',
      dateFormat: 'DD/MM/YYYY',
      slaEscalationsEnabled: false,
      excludeWeekends: false,
      excludePublicHolidays: false,
      autoCalculateLeadTime: false,
      reason: '英国采购团队采用周一至周六及本地日期格式',
    } });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body['item']['version'], 2);
    assert.deepEqual(updated.body['effective'], {
      countryCode: 'GB', workingDays: [1, 2, 3, 4, 5, 6], timeZone: 'Europe/London', dateFormat: 'DD/MM/YYYY',
      slaEscalationsEnabled: false, excludeWeekends: false, excludePublicHolidays: false, autoCalculateLeadTime: false,
    });
    assert.deepEqual(updated.body['events'].map((event: Record<string, unknown>) => event['action']), ['updated', 'created']);
    assert.deepEqual(updated.body['events'][0]['detail']['previous']['workingDays'], [1, 2, 3, 4, 5]);
    assert.equal(updated.body['events'][0]['detail']['previous']['slaEscalationsEnabled'], true);
    assert.equal(updated.body['events'][0]['detail']['current']['autoCalculateLeadTime'], false);

    const isolated = await request(other);
    assert.equal(isolated.body['item'], null);
    assert.equal(isolated.body['inheritedDefault'], true);
    assert.deepEqual(isolated.body['events'], []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});

test('采购区域偏好：成功 PUT 在真实文件数据库关闭重开后保留版本、审计与租户隔离', async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'readywork-tenant-preferences-'));
  const databasePath = join(temporaryDirectory, 'preferences.sqlite');
  let store: ReturnType<typeof openPersistence> | null = openPersistence(databasePath, { tenantId: 'tenant:preferences-reopen' });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers['authorization'];
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleProcurementTenantPreferencesRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store!.db,
      session: resolveSession(bearer),
      now: () => new Date('2026-09-07T08:00:00.000Z'),
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manager = token('tenant:preferences-reopen', '采购经理', 'human:manager');
  const other = token('tenant:preferences-other', '采购经理', 'human:other');
  const request = async (authToken: string, body?: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/procurement/tenant-preferences`, {
      method: body ? 'PUT' : 'GET',
      headers: { authorization: `Bearer ${authToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const initial = {
    expectedVersion: 0,
    countryCode: 'CN',
    workingDays: [1, 2, 3, 4, 5],
    timeZone: 'Asia/Shanghai',
    dateFormat: 'YYYY-MM-DD',
    slaEscalationsEnabled: true,
    excludeWeekends: true,
    excludePublicHolidays: true,
    autoCalculateLeadTime: true,
    reason: '中国采购团队正式启用区域工作日配置',
  };
  try {
    assert.equal((await request(manager, initial)).status, 201);
    const updated = await request(manager, {
      ...initial,
      expectedVersion: 1,
      countryCode: 'GB',
      workingDays: [1, 2, 3, 4, 5, 6],
      timeZone: 'Europe/London',
      dateFormat: 'DD/MM/YYYY',
      slaEscalationsEnabled: false,
      excludeWeekends: false,
      excludePublicHolidays: false,
      autoCalculateLeadTime: false,
      reason: '英国采购团队正式采用周一至周六的日历配置',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body['item']['version'], 2);

    store.close();
    store = openPersistence(databasePath, { tenantId: 'tenant:preferences-reopen' });

    const reopened = await request(manager);
    assert.equal(reopened.status, 200);
    assert.deepEqual(reopened.body['effective'], {
      countryCode: 'GB', workingDays: [1, 2, 3, 4, 5, 6], timeZone: 'Europe/London', dateFormat: 'DD/MM/YYYY',
      slaEscalationsEnabled: false, excludeWeekends: false, excludePublicHolidays: false, autoCalculateLeadTime: false,
    });
    assert.equal(reopened.body['item']['version'], 2);
    assert.deepEqual(reopened.body['events'].map((event: Record<string, unknown>) => event['action']), ['updated', 'created']);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM procurement_tenant_preferences WHERE tenant_id=?').get('tenant:preferences-reopen')?.['count'], 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM procurement_tenant_preference_events WHERE tenant_id=?').get('tenant:preferences-reopen')?.['count'], 2);
    const isolated = await request(other);
    assert.equal(isolated.body['item'], null);
    assert.deepEqual(isolated.body['events'], []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store?.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
