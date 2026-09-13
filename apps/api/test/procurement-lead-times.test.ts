import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { createProcurementSupplierOperatingProfile, openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementLeadTimeRequest } from '../src/procurement-lead-times.js';
import { procurementPortfolio } from '../src/procurement-workbench.js';

const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
function token(tenantId: string, role: string, humanId: string): string {
  const session: Session = { username: humanId, tenantId, humanId, name: humanId, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

test('Navisight 物料制造交期：真实供应商绑定、版本审计、退役、租户隔离与 PO 风险证据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-lead-times-'));
  const dbPath = join(dir, 'lead-times.db');
  const tenantId = 'tenant:lead-times';
  const store = openPersistence(dbPath, { tenantId });
  const at = '2026-08-30T00:00:00.000Z';
  const supplier: Supplier = {
    id: 'supplier:lead-time', tenantId, sourceSystem: 'odoo', externalId: 'SUP-LT', status: 'active',
    createdAt: at, updatedAt: at, name: '精密阀门供应商', currency: 'CNY', contacts: [],
  };
  const po: PurchaseOrder & Record<string, unknown> = {
    id: 'po:lead-time', tenantId, sourceSystem: 'odoo', externalId: 'PO-LT-001', status: 'confirmed',
    createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at,
    requiredInHouseAt: '2026-09-04T00:00:00.000Z',
  };
  const line: PurchaseOrderLine & Record<string, unknown> = {
    id: 'line:lead-time', poId: po.id, lineNumber: '10', itemId: 'item:PV-30', itemCode: 'PV-30', description: '气动真空阀',
    uom: 'EA', orderedQty: 20, unitPrice: 800, currency: 'CNY', requestedAt: '2026-09-04T00:00:00.000Z',
  };
  store.procurement.saveDocument('supplier', supplier);
  const inactiveProfileSupplier: Supplier = { ...supplier, id: 'supplier:inactive-profile', externalId: 'SUP-INACTIVE-PROFILE', name: '经营档案已停用供应商' };
  store.procurement.saveDocument('supplier', inactiveProfileSupplier);
  createProcurementSupplierOperatingProfile(store.db, tenantId, {
    profile: { supplierId: inactiveProfileSupplier.id, countryCode: 'CN', route: 'unclassified', supplierType: 'other', industry: null, address: null, primaryMaterialCode: null, primaryMaterialName: null, defaultLeadTimeDays: null, productCriticality: 'unclassified', paymentTerms: null, contractStartsOn: null, contractEndsOn: null, status: 'inactive', version: 1 },
    actorId: 'human:manager', reason: '测试经营档案状态投影', source: 'manual', at,
  });
  store.procurement.saveDocument('purchase_order', po);
  store.procurement.saveLine('purchase_order_line', po.id, line);
  store.db.prepare(`INSERT INTO procurement_route_assignments
    (tenant_id,po_id,route,source,evidence_json,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?,?,?)`).run(tenantId, po.id, 'local', 'manual', '{}', 'human:manager', 'human:manager', at, at);

  const fixed = new Date('2026-08-30T08:00:00.000Z');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers['authorization'];
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleProcurementLeadTimeRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(bearer), now: () => fixed,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manager = token(tenantId, '采购经理', 'human:manager');
  const buyer = token(tenantId, '采购专员', 'human:buyer');
  const other = token('tenant:other', '采购经理', 'human:other');
  async function request(path: string, authToken = '', options: { method?: string; body?: Record<string, unknown> } = {}) {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: { ...(authToken ? { authorization: `Bearer ${authToken}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  const createBody = {
    supplier_id: supplier.id,
    supplier_name: supplier.name,
    material: '气动真空阀',
    item_code: 'PV-30',
    material_type: '工业阀门',
    procurement_route: 'local',
    standard_lead_time_days: 15,
    criticality: 'high',
    remarks: '供应商正式确认的标准制造周期',
    reason: '依据供应商 2026 年度正式交期协议登记',
  };

  try {
    assert.equal((await request('/api/po/lead-times')).status, 401);
    const initial = await request('/api/po/lead-times', buyer);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body['items'], []);
    assert.ok(initial.body['suppliers'].some((item: Record<string, unknown>) => item['id'] === supplier.id));
    assert.equal(initial.body['suppliers'].find((item: Record<string, unknown>) => item['id'] === inactiveProfileSupplier.id)['status'], 'inactive');
    assert.deepEqual(initial.body['permissions'], { read: true, configure: false });
    assert.equal((await request('/api/po/lead-times', buyer, { method: 'POST', body: createBody })).status, 403);
    assert.equal((await request('/api/po/lead-times', manager, { method: 'POST', body: { ...createBody, supplier_id: 'supplier:missing' } })).status, 422);
    assert.equal((await request('/api/po/lead-times', manager, { method: 'POST', body: { ...createBody, supplier_name: '伪造供应商名称' } })).status, 422);
    const invalidCriticality = await request('/api/po/lead-times', manager, { method: 'POST', body: { ...createBody, criticality: 'urgent' } });
    assert.equal(invalidCriticality.status, 422);
    assert.equal(invalidCriticality.body['error'], '产品关键程度必须为高、中或低');
    assert.equal((await request('/api/po/lead-times', other, { method: 'POST', body: createBody })).status, 422, '其他租户不能绑定本租户供应商');

    const created = await request('/api/po/lead-times', manager, { method: 'POST', body: createBody });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = String(created.body['item']['id']);
    assert.equal(created.body['item']['supplier_name'], supplier.name);
    assert.equal(created.body['item']['version'], 1);
    assert.equal(created.body['item']['standard_lead_time_days'], 15);
    assert.equal(created.body['item']['criticality'], 'high');
    const duplicate = await request('/api/po/lead-times', manager, { method: 'POST', body: createBody });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body['code'], 'LEAD_TIME_DUPLICATE');

    const stale = await request(`/api/po/lead-times/${encodeURIComponent(id)}`, manager, { method: 'PATCH', body: { expected_version: 8, standard_lead_time_days: 20, reason: '验证旧版本不能覆盖当前交期主数据' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body['current_version'], 1);
    const updated = await request(`/api/po/lead-times/${encodeURIComponent(id)}`, manager, { method: 'PATCH', body: { expected_version: 1, standard_lead_time_days: 20, criticality: 'low', remarks: '年度协议修订后的制造周期', reason: '供应商书面通知标准制造周期调整为二十天' } });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body['item']['version'], 2);
    assert.equal(updated.body['item']['standard_lead_time_days'], 20);
    assert.equal(updated.body['item']['criticality'], 'low');

    const portfolio = procurementPortfolio(store.db, tenantId, fixed) as Record<string, any>;
    const riskItem = portfolio['items'].find((item: Record<string, unknown>) => item['id'] === po.id) as Record<string, any>;
    const factor = riskItem['riskFactors'].find((item: Record<string, unknown>) => item['code'] === 'manufacturing_lead_time_shortfall');
    assert.ok(factor, JSON.stringify(riskItem));
    assert.equal(factor['evidenceDetail']['templateId'], id);
    assert.equal(factor['evidenceDetail']['templateVersion'], 2);
    assert.equal(factor['evidenceDetail']['availableDays'], 5);
    assert.equal(factor['evidenceDetail']['shortfallDays'], 15);
    assert.equal(riskItem['leadTimeEvidence'][0]['templateId'], id);
    assert.equal(riskItem['riskPublicationState'], 'provisional');
    assert.equal(riskItem['riskScore'], 67);
    assert.equal(riskItem['riskModel']['components']['deliveryDelay']['score'], 95);
    assert.equal(riskItem['riskModel']['components']['productCriticality']['score'], 20);
    assert.deepEqual(riskItem['riskModel']['components']['productCriticality']['evidenceReferences'], [{ type: 'procurement_material_lead_time', id, version: 2 }]);
    assert.deepEqual(riskItem['missingRiskComponents'], ['supplierPerformance']);

    store.db.prepare(`INSERT INTO procurement_tenant_preferences
      (tenant_id,country_code,working_days_json,time_zone,date_format,sla_escalations_enabled,exclude_weekends,exclude_public_holidays,auto_calculate_lead_time,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,1,1,1,0,1,?,?,?,?)`).run(
        tenantId, 'CN', JSON.stringify([1, 2, 3, 4, 5]), 'Asia/Shanghai', 'YYYY-MM-DD',
        'human:manager', 'human:manager', at, at,
      );
    const disabledPortfolio = procurementPortfolio(store.db, tenantId, fixed) as Record<string, any>;
    const disabledRiskItem = disabledPortfolio['items'].find((item: Record<string, unknown>) => item['id'] === po.id) as Record<string, any>;
    assert.deepEqual(disabledRiskItem['leadTimeEvidence'], []);
    assert.equal(disabledRiskItem['riskFactors'].some((item: Record<string, unknown>) => item['code'] === 'manufacturing_lead_time_shortfall'), false);
    assert.deepEqual(disabledRiskItem['leadTimeConfiguration'], { autoCalculateLeadTime: false, preferenceVersion: 1, inheritedDefault: false });
    assert.match(disabledPortfolio['configurationWatermark'], /auto-lead-time:0$/);
    store.db.prepare('DELETE FROM procurement_tenant_preferences WHERE tenant_id=?').run(tenantId);

    const list = await request('/api/po/lead-times', buyer);
    assert.equal(list.body['items'].length, 1);
    assert.equal(list.body['items'][0]['criticality'], 'low');
    assert.deepEqual(list.body['events'].map((event: Record<string, unknown>) => event['action']), ['updated', 'created']);
    assert.deepEqual((await request('/api/po/lead-times', other)).body['items'], []);

    const retired = await request(`/api/po/lead-times/${encodeURIComponent(id)}`, manager, { method: 'DELETE', body: { expected_version: 2, reason: '供应商年度协议失效，退役该制造交期记录' } });
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    assert.equal(retired.body['item']['status'], 'retired');
    assert.equal(retired.body['item']['version'], 3);
    assert.deepEqual((await request('/api/po/lead-times', buyer)).body['items'], []);
    const history = await request('/api/po/lead-times?includeRetired=true', buyer);
    assert.equal(history.body['items'][0]['status'], 'retired');
    assert.deepEqual(history.body['events'].map((event: Record<string, unknown>) => event['action']), ['retired', 'updated', 'created']);
    const afterRetire = procurementPortfolio(store.db, tenantId, fixed) as Record<string, any>;
    const retiredRiskItem = afterRetire['items'].find((item: Record<string, unknown>) => item['id'] === po.id) as Record<string, any>;
    assert.equal(retiredRiskItem['riskFactors'].some((item: Record<string, unknown>) => item['code'] === 'manufacturing_lead_time_shortfall'), false);
    assert.deepEqual(retiredRiskItem['leadTimeEvidence'], []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }

  const reopened = openPersistence(dbPath, { tenantId });
  try {
    const row = reopened.db.prepare(`SELECT status,version,supplier_id,criticality FROM procurement_material_lead_times WHERE tenant_id=?`).get(tenantId) as { status: string; version: number; supplier_id: string; criticality: string };
    assert.equal(row.status, 'retired');
    assert.equal(row.version, 3);
    assert.equal(row.supplier_id, supplier.id);
    assert.equal(row.criticality, 'low');
    const count = reopened.db.prepare(`SELECT COUNT(*) AS count FROM procurement_material_lead_time_events WHERE tenant_id=?`).get(tenantId) as { count: number };
    assert.equal(Number(count.count), 3);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
