import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import type {
  ConnectorCredentialView,
  ConnectorInstallationView,
} from '../src/connector-control-plane.js';
import { handleProcurementConfigurationConnectionsRequest } from '../src/procurement-configuration-connections.js';

const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

function token(tenantId: string, role: string, humanId: string): string {
  const session: Session = { username: humanId, tenantId, humanId, name: humanId, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

function connector(id: string, overrides: Partial<ConnectorInstallationView> = {}): ConnectorInstallationView {
  return {
    id,
    version: 1,
    name: `${id} connector`,
    description: `${id} connector`,
    icon: 'plug',
    vendor: 'Readywork',
    runtime: 'builtin',
    credentials: [],
    actions: [],
    status: 'installed',
    healthy: true,
    runtimeHealthy: true,
    credentialReady: true,
    externalVerified: true,
    implementationMode: 'real',
    credentialCount: 1,
    healthMessage: `${id} verified`,
    ...overrides,
  };
}

function credential(connectorId: string): ConnectorCredentialView {
  return {
    id: `credential:${connectorId}`,
    connectorId,
    credentialType: `${connectorId}Credential`,
    name: `${connectorId} secret name`,
    status: 'connected',
    lastTestedAt: '2026-09-01T08:00:00.000Z',
    createdAt: '2026-09-01T07:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
  };
}

test('配置连接摘要：采购经理可读真实状态但不能管理，响应不泄露凭据标识或连接器动作', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  const requestedTenants: string[] = [];
  const source = {
    connectors: [connector('email'), connector('whatsapp', { credentialReady: false, externalVerified: false, healthy: false, credentialCount: 0 }), connector('deepseek', { credentialReady: false, externalVerified: false, healthy: false }), connector('erp'), connector('http')],
    credentials: [credential('email'), { ...credential('deepseek'), status: 'failed' as const, lastError: 'DeepSeek API 密钥无效' }, credential('erp'), credential('http')],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleProcurementConfigurationConnectionsRequest(req, res, url.pathname, req.method ?? 'GET', {
      session: resolveSession(bearer),
      db: store.db,
      load: async (tenantId) => { requestedTenants.push(tenantId); return source; },
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function request(authToken: string | null, method = 'GET') {
    const response = await fetch(`${base}/api/procurement/configuration/connections`, {
      method,
      ...(authToken ? { headers: { authorization: `Bearer ${authToken}` } } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  try {
    assert.equal((await request(null)).status, 401);
    assert.equal((await request(token('tenant:a', '采购经理', 'manager'), 'POST')).status, 405);

    const manager = await request(token('tenant:a', '采购经理', 'manager'));
    assert.equal(manager.status, 200);
    assert.deepEqual(Object.keys(manager.body).sort(), ['autoSend', 'connections', 'permissions']);
    assert.deepEqual(manager.body.permissions, { manage: false });
    assert.deepEqual(manager.body.connections.map((item: Record<string, unknown>) => item.id), ['email', 'whatsapp', 'wechat', 'deepseek', 'erp']);
    assert.equal(manager.body.connections.find((item: Record<string, unknown>) => item.id === 'whatsapp').connectionType, 'Meta WhatsApp Cloud API');
    assert.equal(manager.body.connections.find((item: Record<string, unknown>) => item.id === 'wechat').status, 'unavailable');
    assert.equal(manager.body.connections.find((item: Record<string, unknown>) => item.id === 'deepseek').connectionType, 'DeepSeek 官方 API');
    assert.equal(manager.body.connections.find((item: Record<string, unknown>) => item.id === 'deepseek').healthMessage, 'DeepSeek API 密钥无效');
    assert.deepEqual(Object.keys(manager.body.connections[0]).sort(), [
      'connectionType', 'credentialCount', 'credentialReady', 'externalVerified', 'healthMessage', 'id', 'lastTestedAt', 'runtimeHealthy', 'status',
    ]);
    assert.equal(manager.body.credentials, undefined);
    assert.equal(manager.body.connections[0].actions, undefined);
    assert.equal(manager.body.connections[0].credentialId, undefined);
    assert.equal(manager.body.connections[0].credentialType, undefined);
    assert.deepEqual(manager.body.autoSend.gates.map((item: Record<string, unknown>) => item.id), [
      'permission', 'published_profile', 'communication_identity', 'allowlists', 'supplier_target', 'connector', 'kill_switch',
    ]);
    assert.deepEqual(manager.body.autoSend.gates.map((item: Record<string, unknown>) => ({ id: item.id, label: item.label })), [
      { id: 'permission', label: '配置与审批权限' },
      { id: 'published_profile', label: '已发布的高级 SLA v2 配置' },
      { id: 'communication_identity', label: '具名采购身份' },
      { id: 'allowlists', label: '阶段、通道与风险允许列表' },
      { id: 'supplier_target', label: '已验证的供应商目标' },
      { id: 'connector', label: '健康且已验证的连接器' },
      { id: 'kill_switch', label: '终止开关正在运行' },
    ]);
    assert.deepEqual(manager.body.autoSend.gates.map((item: Record<string, unknown>) => item.detail), [
      '当前身份同时具备配置和审批权限。',
      '尚无已发布的高级 SLA 架构 v2 配置。',
      '尚未启用供应商可见的具名采购身份。',
      '策略必须启用，并明确阶段、通道与风险允许列表。',
      '当前没有完整可验证的供应商目标，或至少一个活动采购单缺少允许通道收件人。',
      '完成通道允许列表后才能核验连接器。',
      '运行控制缺失、版本不匹配或终止开关已暂停。',
    ]);
    assert.deepEqual(manager.body.autoSend.blockers.map((item: Record<string, unknown>) => item.id), [
      'published_profile', 'communication_identity', 'allowlists', 'supplier_target', 'connector', 'kill_switch',
    ]);
    assert.deepEqual(requestedTenants, ['tenant:a']);

    const buyer = await request(token('tenant:a', '采购专员', 'buyer'));
    assert.equal(buyer.status, 200);
    assert.equal(buyer.body.autoSend.blockers[0].id, 'permission');
    assert.equal(buyer.body.autoSend.blockers[0].detail, '启用自动发送需要同时具备配置与审批权限。');

    const admin = await request(token('tenant:b', '管理员', 'admin'));
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body.permissions, { manage: true });
    assert.deepEqual(requestedTenants, ['tenant:a', 'tenant:a', 'tenant:b']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});

test('配置自动发送摘要：只有权限、v2 发布配置、身份、完整 allowlist、供应商目标、连接器和 kill switch 全部通过才就绪', async () => {
  const tenantId = 'tenant:auto-send-ready';
  const store = openPersistence(':memory:', { tenantId });
  const source = {
    connectors: [connector('email'), connector('whatsapp'), connector('erp')],
    credentials: [credential('email'), credential('whatsapp'), credential('erp')],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleProcurementConfigurationConnectionsRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db,
      session: resolveSession(bearer),
      load: async () => source,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manager = token(tenantId, '采购经理', 'manager');
  const read = async () => {
    const response = await fetch(`${base}/api/procurement/configuration/connections`, { headers: { authorization: `Bearer ${manager}` } });
    return await response.json() as Record<string, any>;
  };

  try {
    const blocked = await read();
    assert.equal(blocked.autoSend.ready, false);
    assert.deepEqual(blocked.autoSend.blockers.map((item: Record<string, unknown>) => item.id), [
      'published_profile', 'communication_identity', 'allowlists', 'supplier_target', 'connector', 'kill_switch',
    ]);

    const at = '2026-09-03T08:00:00.000Z';
    store.db.prepare(`INSERT INTO procurement_advanced_sla_profiles
      (tenant_id,id,name,description,status,version,sections_json,auto_send_json,created_by,updated_by,published_by,created_at,updated_at,published_at,schema_version)
      VALUES (?,?,?,'','published',3,'[]',?,'manager','manager','manager',?,?,?,2)`)
      .run(tenantId, 'advanced-sla:published', 'Production policy', JSON.stringify({ enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks: ['high'] }), at, at, at);
    store.db.prepare(`INSERT INTO procurement_advanced_sla_runtime_controls
      (tenant_id,profile_id,profile_version,paused,version,updated_by,updated_at) VALUES (?,?,3,0,1,'manager',?)`)
      .run(tenantId, 'advanced-sla:published', at);
    store.db.prepare(`INSERT INTO procurement_communication_identities
      (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,'Buyer','Procurement Manager','Readywork','active',1,'manager','manager',?,?)`).run(tenantId, at, at);
    store.db.prepare(`INSERT INTO procurement_documents
      (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at) VALUES (?,?,?,?,?,'active',1,?,?,?)`)
      .run(tenantId, 'supplier', 'supplier:verified', 'manual', 'supplier-verified', JSON.stringify({ id: 'supplier:verified', contacts: [{ primary: true, email: 'orders@vendor.cn' }] }), at, at);
    store.db.prepare(`INSERT INTO procurement_documents
      (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at) VALUES (?,?,?,?,?,'sent',1,?,?,?)`)
      .run(tenantId, 'purchase_order', 'po:verified-target', 'manual', 'po-verified-target', JSON.stringify({ id: 'po:verified-target', supplierId: 'supplier:verified', status: 'sent' }), at, at);

    const ready = await read();
    assert.equal(ready.autoSend.ready, true);
    assert.equal(ready.autoSend.enabled, true);
    assert.equal(ready.autoSend.profileId, 'advanced-sla:published');
    assert.equal(ready.autoSend.profileVersion, 3);
    assert.deepEqual(ready.autoSend.stageAllowlist, ['supplier_commitment']);
    assert.deepEqual(ready.autoSend.channelAllowlist, ['email']);
    assert.deepEqual(ready.autoSend.riskAllowlist, ['high']);
    assert.deepEqual(ready.autoSend.blockers, []);
    assert.equal(ready.autoSend.gates.every((item: Record<string, unknown>) => item.status === 'ready'), true);
    assert.deepEqual(ready.autoSend.gates.map((item: Record<string, unknown>) => item.detail), [
      '当前身份同时具备配置和审批权限。',
      '已发布 advanced-sla:published v3。',
      '供应商可见的具名采购身份已启用。',
      '1 个阶段 · 1 个通道 · 1 个风险等级',
      '当前活动采购单的供应商目标均可按允许通道规范化。',
      '允许通道的运行时、凭据和外部验证均就绪。',
      '已发布配置的运行控制处于运行状态。',
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});

test('配置连接摘要：控制面读取失败返回稳定 503，不伪造未配置状态', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleProcurementConfigurationConnectionsRequest(req, res, url.pathname, req.method ?? 'GET', {
      session: resolveSession(bearer),
      db: store.db,
      load: async () => { throw new Error('control plane offline'); },
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/procurement/configuration/connections`, {
      headers: { authorization: `Bearer ${token('tenant:a', '采购经理', 'manager')}` },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as Record<string, unknown>).code, 'CONFIGURATION_CONNECTIONS_UNAVAILABLE');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
