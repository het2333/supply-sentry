import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ToolRegistry } from '@readywork/tools';
import { openPersistence } from '@readywork/persistence';
import { ConnectorControlPlane } from '../src/connector-control-plane.js';

test('Connector 控制面: 安装、停用、启用与卸载均按租户持久化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-connector-test-'));
  try {
    const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:connector' });
    const control = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:connector');
    const initial = await control.list();
    assert.equal(initial.find((item) => item.id === 'http')?.status, 'available');
    const excel = initial.find((item) => item.id === 'excel');
    assert.equal(excel?.implementationMode, 'reference');
    assert.equal(excel?.externalVerified, false);
    assert.equal(excel?.healthy, false);
    const installed = await control.install('http', { allowedHosts: ['example.com'] });
    assert.equal(installed.status, 'installed');
    assert.equal(installed.runtimeHealthy, true);
    assert.equal(installed.externalVerified, false, '启动隔离运行时不等于已验证外部目标');
    assert.match(installed.healthMessage ?? '', /尚未验证任何外部目标/);
    assert.equal(installed.implementationMode, 'real');
    assert.equal((await control.disable('http')).status, 'disabled');
    assert.equal((await control.enable('http')).status, 'installed');
    await control.uninstall('http');
    assert.equal((await control.list()).find((item) => item.id === 'http')?.status, 'available');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Connector 控制面: 安装失败记录为 failed，运行时不进入注册表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-connector-test-'));
  try {
    const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:connector' });
    const control = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:connector');
    await assert.rejects(() => control.install('http'), /至少配置一个允许访问的主机/);
    const http = (await control.list()).find((item) => item.id === 'http');
    assert.equal(http?.status, 'failed');
    assert.equal(http?.healthy, false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Connector 控制面: 凭据加密保存、测试状态、事件与删除均可追溯', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-connector-credential-test-'));
  const previousKey = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'readywork-connector-test-key-long-enough';
  try {
    const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:credential' });
    const control = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:credential');
    control.putCredential({ id: 'credential:erp:test', connectorId: 'erp', credentialType: 'erpCredential', name: '测试 ERP', value: { baseUrl: 'https://erp.example.com', apiKey: 'private-value' } });
    assert.equal(control.listCredentials()[0]?.status, 'untested');
    const encrypted = store.db.prepare('SELECT encrypted_json FROM control_credentials WHERE tenant_id = ? AND id = ?').get('tenant:credential', 'credential:erp:test') as { encrypted_json: string };
    assert.equal(encrypted.encrypted_json.includes('private-value'), false);
    const tested = await control.testCredential('credential:erp:test');
    assert.equal(tested.ok, false);
    assert.equal(control.listCredentials()[0]?.status, 'failed');
    assert.deepEqual(control.listEvents().map((event) => event.eventType).slice(0, 2), ['credential_tested', 'credential_saved']);
    assert.equal(control.deleteCredential('credential:erp:test'), true);
    assert.equal(control.listCredentials().length, 0);
    const deletedEvent = control.listEvents().find((event) => event.eventType === 'credential_deleted');
    assert.equal(deletedEvent?.connectorId, 'erp');
    assert.match(deletedEvent?.message ?? '', /测试 ERP 已删除/);
    const disconnectedErp = (await control.list()).find((item) => item.id === 'erp');
    assert.equal(disconnectedErp?.credentialReady, false);
    assert.equal(disconnectedErp?.externalVerified, false);
    assert.equal(disconnectedErp?.healthy, false);
    assert.equal(control.deleteCredential('credential:erp:test'), false, '重复删除必须返回未找到，不能伪造成功');
    store.close();
  } finally {
    if (previousKey === undefined) delete process.env['READYWORK_CREDENTIAL_KEY'];
    else process.env['READYWORK_CREDENTIAL_KEY'] = previousKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Connector 控制面: DeepSeek 凭据通过官方余额接口验证后才标记可用', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-deepseek-credential-test-'));
  const previousKey = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'readywork-deepseek-credential-test-key';
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.deepseek.com/user/balance');
    assert.equal((init?.headers as Record<string, string>)['authorization'], 'Bearer deepseek-test-key');
    return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:deepseek' });
    const control = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:deepseek');
    const initial = (await control.list()).find((item) => item.id === 'deepseek');
    assert.equal(initial?.status, 'installed');
    assert.equal(initial?.runtimeHealthy, true);
    assert.equal(initial?.externalVerified, false);
    control.putCredential({
      id: 'credential:ai:deepseek', connectorId: 'deepseek', credentialType: 'deepseekApiKey', name: 'DeepSeek AI',
      value: { apiKey: 'deepseek-test-key' },
    });
    const tested = await control.testCredential('credential:ai:deepseek');
    assert.equal(tested.ok, true);
    assert.deepEqual(tested.checks, [{ name: 'DeepSeek API', ok: true, message: '密钥有效且账户余额可用' }]);
    assert.equal(control.listCredentials()[0]?.status, 'connected');
    const connected = (await control.list()).find((item) => item.id === 'deepseek');
    assert.equal(connected?.credentialReady, true);
    assert.equal(connected?.externalVerified, true);
    store.close();
  } finally {
    if (previousKey === undefined) delete process.env['READYWORK_CREDENTIAL_KEY'];
    else process.env['READYWORK_CREDENTIAL_KEY'] = previousKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Connector 控制面: ERP 和邮箱缺少凭据或动作未实现时绝不回退内存工具', async () => {
  let calls = 0;
  const tools = new ToolRegistry();
  for (const id of ['erp', 'email']) {
    tools.register({
      id,
      name: id,
      description: '不应被调用的参考工具',
      actions: id === 'erp' ? ['rfq.award'] : ['send'],
      execute: async () => { calls += 1; return { ok: true, data: { simulated: true } }; },
    });
  }
  const control = new ConnectorControlPlane(undefined, tools, 'tenant:fail-closed');
  const context = { tenantId: 'tenant:fail-closed', employeeId: 'ai:test', runId: 'run:test', nodeRunId: 'node:test', idempotencyKey: 'test', credentials: {}, timeoutMs: 1_000 };

  const erpMissing = await control.execute('erp', 'rfq.award', { rfqId: 'R1', supplierId: 'S1' }, context);
  const emailMissing = await control.execute('email', 'send', { to: 'supplier@example.com', subject: '测试', body: '测试' }, context);
  const unimplemented = await control.execute('erp', 'rfq.award', { rfqId: 'R1', supplierId: 'S1' }, {
    ...context,
    credentials: { baseUrl: 'http://127.0.0.1:1', database: 'odoo', apiKey: 'must-not-leak' },
  });

  assert.equal(erpMissing.ok, false);
  assert.match(erpMissing.error ?? '', /凭据不可用/);
  assert.equal(emailMissing.ok, false);
  assert.match(emailMissing.error ?? '', /凭据不可用/);
  assert.equal(unimplemented.ok, false);
  assert.match(unimplemented.error ?? '', /尚未实现动作/);
  assert.doesNotMatch(unimplemented.error ?? '', /must-not-leak/);
  assert.equal(calls, 0);
});

test('Connector 控制面: 邮件/ERP 凭据按租户隔离，WMS 无运行时时明确失败而非假连接', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-connector-isolation-test-'));
  const previousKey = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'readywork-isolation-credential-key';
  try {
    const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:a' });
    const controlA = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:a');
    const controlB = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:b');
    controlA.putCredential({ id: 'credential:shared', connectorId: 'email', credentialType: 'emailCredential', name: 'A 邮箱', value: { username: 'a@example.test', authorizationCode: 'secret-a' } });
    controlB.putCredential({ id: 'credential:shared', connectorId: 'erp', credentialType: 'erpCredential', name: 'B ERP', value: { baseUrl: 'https://b.example.test', database: 'b', apiKey: 'secret-b' } });
    assert.equal(controlA.getCredential('credential:shared')?.['username'], 'a@example.test');
    assert.equal(controlA.getCredential('credential:shared')?.['apiKey'], undefined);
    assert.equal(controlB.getCredential('credential:shared')?.['apiKey'], 'secret-b');
    await assert.rejects(() => controlA.execute('email', 'send', {}, {
      tenantId: 'tenant:b', employeeId: 'ai:test', runId: 'run:test', nodeRunId: 'node:test',
      idempotencyKey: 'cross-tenant', credentials: {}, timeoutMs: 1_000,
    }), /租户.*不一致/);

    await assert.rejects(() => controlA.install('wms'), /WMS.*运行时尚未配置/);
    const wms = (await controlA.list()).find((item) => item.id === 'wms');
    assert.equal(wms?.status, 'failed');
    assert.equal(wms?.runtimeHealthy, false);
    assert.equal(wms?.externalVerified, false);
    assert.equal(wms?.healthy, false);
    store.close();
  } finally {
    if (previousKey === undefined) delete process.env['READYWORK_CREDENTIAL_KEY'];
    else process.env['READYWORK_CREDENTIAL_KEY'] = previousKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Connector 控制面: 重启后丢失加密密钥时历史 connected 凭据不得继续健康', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-connector-lost-key-test-'));
  const previousKey = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'readywork-original-credential-key';
  try {
    const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:lost-key' });
    const control = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:lost-key');
    control.putCredential({ id: 'credential:erp:lost-key', connectorId: 'erp', credentialType: 'erpCredential', name: '历史 ERP', value: { baseUrl: 'https://erp.example.com', database: 'odoo', apiKey: 'private-value' } });
    store.db.prepare("UPDATE control_credentials SET status='connected' WHERE tenant_id=? AND id=?").run('tenant:lost-key', 'credential:erp:lost-key');
    assert.equal((await control.list()).find((item) => item.id === 'erp')?.externalVerified, true);

    delete process.env['READYWORK_CREDENTIAL_KEY'];
    const restarted = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:lost-key');
    const credential = restarted.listCredentials()[0];
    const erp = (await restarted.list()).find((item) => item.id === 'erp');
    assert.equal(credential?.status, 'failed');
    assert.match(credential?.lastError ?? '', /无法解密/);
    assert.equal(erp?.runtimeHealthy, true);
    assert.equal(erp?.credentialReady, false);
    assert.equal(erp?.externalVerified, false);
    assert.equal(erp?.healthy, false);
    assert.match(erp?.healthMessage ?? '', /无法解密/);
    store.close();
  } finally {
    if (previousKey === undefined) delete process.env['READYWORK_CREDENTIAL_KEY'];
    else process.env['READYWORK_CREDENTIAL_KEY'] = previousKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Connector 控制面: Webhook 使用独立适配器安装并验证 HMAC 签名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-webhook-connector-test-'));
  try {
    const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:webhook' });
    const control = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:webhook');
    const installed = await control.install('webhook');
    assert.equal(installed.status, 'installed');
    assert.equal(installed.runtimeHealthy, true);
    assert.equal(installed.credentialReady, false);
    assert.equal(installed.externalVerified, false);
    assert.equal(installed.healthy, false);
    const restored = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:webhook');
    const restoredWebhook = (await restored.list()).find((item) => item.id === 'webhook');
    assert.equal(restoredWebhook?.status, 'installed');
    assert.equal(restoredWebhook?.runtimeHealthy, true);
    assert.equal(restoredWebhook?.healthy, false);

    const secret = 'webhook-test-secret';
    const rawBody = JSON.stringify({ type: 'po.updated', poId: 'PO-1001' });
    const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
    const context = {
      tenantId: 'tenant:webhook',
      employeeId: 'ai:procurement',
      runId: 'run:webhook',
      nodeRunId: 'node:webhook',
      idempotencyKey: 'webhook:test',
      credentials: { secret },
      timeoutMs: 5_000,
    };
    const accepted = await control.execute('webhook', 'receive', { rawBody, payload: { type: 'po.updated', poId: 'PO-1001' }, signature }, context);
    assert.equal(accepted.ok, true);
    assert.equal((accepted.output?.['event'] as Record<string, unknown>)['type'], 'po.updated');

    const rejected = await control.execute('webhook', 'receive', { rawBody, payload: {}, signature: '0'.repeat(64) }, context);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'Webhook 签名验证失败');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Connector 控制面: ERP 凭据真实测试 Odoo 并读取采购单', async () => {
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['authorization'], 'bearer odoo-test-key');
    assert.equal(req.headers['x-odoo-database'], 'odoo_test');
    for await (const _ of req) { /* drain request */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.includes('/res.partner/search_read')) return res.end(JSON.stringify([{ id: 8, name: '测试供应商', email: 'supplier@example.com' }]));
    if (req.url?.includes('/purchase.order.line/search_read')) return res.end(JSON.stringify([{ id: 21, product_id: [3, '测试物料'], product_qty: 2, price_unit: 50, date_planned: '2026-08-30 00:00:00' }]));
    if (req.url?.includes('/purchase.order/search_read')) return res.end(JSON.stringify([{ id: 11, name: 'P00011', partner_id: [8, '测试供应商'], date_order: '2026-08-20 00:00:00', amount_total: 100, amount_untaxed: 90, state: 'purchase', order_line: [21] }]));
    res.end(JSON.stringify([]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), 'rw-odoo-connector-test-'));
  const previousKey = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'readywork-odoo-credential-test-key';
  try {
    const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:odoo' });
    const control = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:odoo');
    const credentials = { baseUrl: `http://127.0.0.1:${port}`, database: 'odoo_test', apiKey: 'odoo-test-key' };
    control.putCredential({ id: 'credential:erp:odoo', connectorId: 'erp', credentialType: 'erpCredential', name: '本地 Odoo', value: credentials });
    const tested = await control.testCredential('credential:erp:odoo');
    assert.equal(tested.ok, true);
    assert.equal(control.listCredentials()[0]?.status, 'connected');
    const erp = (await control.list()).find((item) => item.id === 'erp');
    assert.equal(erp?.runtimeHealthy, true);
    assert.equal(erp?.credentialReady, true);
    assert.equal(erp?.externalVerified, true);
    assert.equal(erp?.implementationMode, 'real');

    const result = await control.execute('erp', 'po.get', { poId: 'P00011' }, {
      tenantId: 'tenant:odoo', employeeId: 'ai:procurement', runId: 'run:odoo', nodeRunId: 'node:odoo', idempotencyKey: 'odoo:P00011', credentials, timeoutMs: 5_000,
    });
    assert.equal(result.ok, true);
    assert.equal((result.output?.['po'] as Record<string, unknown>)['name'], 'P00011');
    assert.equal(result.output?.['source'], 'odoo');
    store.close();
  } finally {
    if (previousKey === undefined) delete process.env['READYWORK_CREDENTIAL_KEY'];
    else process.env['READYWORK_CREDENTIAL_KEY'] = previousKey;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Connector 控制面: ERP po.create_draft 仅调用 fake Odoo 并返回规范回执', async () => {
  let created = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers['authorization'], 'bearer fake-odoo-key');
    assert.equal(req.headers['x-odoo-database'], 'fake_odoo');
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url?.includes('/res.partner/search_read')) return res.end(JSON.stringify([{ id: 8, name: '供应商', active: true, supplier_rank: 1 }]));
    if (req.url?.includes('/product.product/search_read')) return res.end(JSON.stringify([{ id: 31, display_name: '阀门', uom_po_id: [1, '件'] }]));
    if (req.url?.includes('/res.currency/search_read')) return res.end(JSON.stringify([{ id: 156, name: 'CNY' }]));
    if (req.url?.includes('/purchase.order/create')) { created = true; return res.end(JSON.stringify(701)); }
    if (req.url?.includes('/purchase.order/search_read')) {
      const domain = body['domain'] as Array<unknown[]>;
      assert.equal(domain[0]?.[2], 'readywork:tenant:odoo:po:1');
      return res.end(JSON.stringify(created ? [{ id: 701, name: 'P00701', origin: 'readywork:tenant:odoo:po:1', partner_id: [8, '供应商'], currency_id: [156, 'CNY'], state: 'draft', order_line: [901] }] : []));
    }
    return res.end(JSON.stringify([]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), 'rw-odoo-create-draft-test-'));
  const previousKey = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'readywork-odoo-create-draft-test-key';
  try {
    const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:odoo' });
    const control = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:odoo');
    const credentials = { baseUrl: `http://127.0.0.1:${port}`, database: 'fake_odoo', apiKey: 'fake-odoo-key' };
    const result = await control.execute('erp', 'po.create_draft', {
      correlationKey: 'readywork:tenant:odoo:po:1', partnerId: 8, currencyCode: 'CNY',
      lines: [{ itemCode: 'VALVE-1', quantity: 2, priceUnit: 50, description: '阀门', datePlanned: '2026-09-01T00:00:00.000Z' }],
    }, { tenantId: 'tenant:odoo', employeeId: 'ai:procurement', runId: 'run:odoo-draft', nodeRunId: 'node:odoo-draft', idempotencyKey: 'odoo-draft:1', credentials, timeoutMs: 5_000 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, { id: 701, name: 'P00701', state: 'draft', correlationKey: 'readywork:tenant:odoo:po:1', replayed: false });
    store.close();
  } finally {
    if (previousKey === undefined) delete process.env['READYWORK_CREDENTIAL_KEY']; else process.env['READYWORK_CREDENTIAL_KEY'] = previousKey;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
