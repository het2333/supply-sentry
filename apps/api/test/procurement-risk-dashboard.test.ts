import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ProductionProgress, PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { createProcurementSupplierOperatingProfile, openPersistence } from '@readywork/persistence';
import type { Session } from '../src/auth.js';
import { handleProcurementRiskDashboardRequest } from '../src/procurement-risk-dashboard.js';

const tenantId = 'tenant:risk';
const at = '2026-08-27T08:00:00.000Z';
const manager: Session = { username: 'manager', tenantId, humanId: 'human:manager', name: '经理', role: '采购经理', expiresAt: Date.now() + 60_000 };
const reader: Session = { username: 'reader', tenantId, humanId: 'human:reader', name: '采购员', role: '采购专员', expiresAt: Date.now() + 60_000 };
const auditor: Session = { username: 'auditor', tenantId, humanId: 'human:auditor', name: '审计员', role: '审计员', expiresAt: Date.now() + 60_000 };

function seed(store: ReturnType<typeof openPersistence>): void {
  const suppliers: Supplier[] = [
    { id: 'supplier:cn', tenantId, sourceSystem: 'odoo', externalId: 'SUP-CN', status: 'active', createdAt: at, updatedAt: at, name: '真实供应商甲', contacts: [], currency: 'CNY', performanceScore: 40 },
    { id: 'supplier:us', tenantId, sourceSystem: 'odoo', externalId: 'SUP-US', status: 'active', createdAt: at, updatedAt: at, name: '真实供应商乙', contacts: [], currency: 'USD', performanceScore: 50 },
  ];
  for (const supplier of suppliers) store.procurement.saveDocument('supplier', supplier);
  createProcurementSupplierOperatingProfile(store.db, tenantId, {
    profile: {
      supplierId: 'supplier:cn', countryCode: 'CN', route: 'local', supplierType: 'manufacturer', industry: null,
      address: null, primaryMaterialCode: 'item:valve', primaryMaterialName: '控制阀', defaultLeadTimeDays: 30,
      productCriticality: 'high', paymentTerms: null, contractStartsOn: null, contractEndsOn: null, status: 'active', version: 1,
    },
    actorId: 'human:manager', reason: '风险模型测试档案', source: 'manual', at,
  });
  createProcurementSupplierOperatingProfile(store.db, tenantId, {
    profile: {
      supplierId: 'supplier:us', countryCode: 'US', route: 'import', supplierType: 'manufacturer', industry: null,
      address: null, primaryMaterialCode: 'item:pump', primaryMaterialName: '离心泵', defaultLeadTimeDays: 20,
      productCriticality: 'low', paymentTerms: null, contractStartsOn: null, contractEndsOn: null, status: 'inactive', version: 1,
    },
    actorId: 'human:manager', reason: '风险模型测试档案', source: 'manual', at,
  });
  const purchaseOrders: PurchaseOrder[] = [
    { id: 'po:high', tenantId, sourceSystem: 'odoo', externalId: 'P00001', status: 'sent', createdAt: at, updatedAt: at, supplierId: 'supplier:cn', currency: 'CNY', orderedAt: at },
    { id: 'po:low', tenantId, sourceSystem: 'odoo', externalId: 'P00002', status: 'confirmed', createdAt: at, updatedAt: at, supplierId: 'supplier:us', currency: 'USD', orderedAt: at },
  ];
  for (const purchaseOrder of purchaseOrders) store.procurement.saveDocument('purchase_order', purchaseOrder);
  const lines: PurchaseOrderLine[] = [
    { id: 'line:high', poId: 'po:high', lineNumber: '10', itemId: 'item:valve', description: '控制阀', uom: 'EA', orderedQty: 10, unitPrice: 1200, currency: 'CNY', requestedAt: '2026-08-20T00:00:00.000Z' },
    { id: 'line:low', poId: 'po:low', lineNumber: '10', itemId: 'item:pump', description: '离心泵', uom: 'EA', orderedQty: 2, unitPrice: 400, currency: 'USD', requestedAt: '2026-09-30T00:00:00.000Z' },
  ];
  for (const line of lines) store.procurement.saveLine('purchase_order_line', line.poId, line);
  const productionProgress: ProductionProgress = {
    id: 'production-progress:high', tenantId, sourceSystem: 'readywork-manual-verification', externalId: 'PROGRESS-HIGH',
    status: 'recorded', createdAt: at, updatedAt: at, poId: 'po:high', supplierId: 'supplier:cn', reportedAt: at,
    overallStatus: 'blocked', evidenceSource: 'manual_verified', evidenceReference: 'mail:progress-high',
    verifiedBy: 'human:manager', verificationReason: '已核对供应商停线说明',
  };
  store.procurement.saveDocument('production_progress', productionProgress);
}

test('采购风险看板：快照持久化、幂等、日期范围、租户隔离与按币种金额', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-risk-dashboard-'));
  const store = openPersistence(join(dir, 'risk.db'), { tenantId });
  seed(store);
  let clock = new Date('2026-08-27T10:00:00.000Z');
  const server = createServer((req, res) => {
    const token = String(req.headers['authorization'] ?? '').replace('Bearer ', '');
    const session = token === 'manager' ? manager : token === 'reader' ? reader : token === 'auditor' ? auditor : null;
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleProcurementRiskDashboardRequest(req, res, path, req.method ?? 'GET', { db: store.db, session, now: () => clock })
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error: unknown) => res.writeHead(500).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, method = 'GET', token = 'reader') {
    const response = await fetch(`${base}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  try {
    assert.equal((await request('/api/procurement/risk-dashboard', 'GET', '')).status, 401);
    const empty = await request('/api/procurement/risk-dashboard?from=2026-08-01&to=2026-08-31');
    assert.equal(empty.status, 200);
    assert.equal(empty.body['latest'], null);
    assert.equal(empty.body['freshness']['state'], 'missing');
    assert.deepEqual(empty.body['capabilities'], { refresh: true });
    assert.deepEqual(empty.body['freshness']['liveMetrics'], { total: 2, high: 1, medium: 0, low: 0, overdue: 1, highRiskPercent: 50 });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM procurement_risk_snapshots').get()?.['count'], 0, 'GET 不产生快照');

    const auditRead = await request('/api/procurement/risk-dashboard?from=2026-08-01&to=2026-08-31', 'GET', 'auditor');
    assert.equal(auditRead.status, 200);
    assert.deepEqual(auditRead.body['capabilities'], { refresh: false });
    const beforeAuditorRefresh = store.db.prepare('SELECT COUNT(*) AS count FROM procurement_risk_snapshots').get()?.['count'];
    assert.equal((await request('/api/procurement/risk-dashboard/refresh', 'POST', 'auditor')).status, 403);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM procurement_risk_snapshots').get()?.['count'], beforeAuditorRefresh);

    const created = await request('/api/procurement/risk-dashboard/refresh', 'POST', 'manager');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body['item']['modelVersion'], 'risk-model-v2');
    assert.deepEqual(created.body['item']['thresholds'], { high: 70, medium: 40 });
    assert.equal(created.body['item']['inputWatermarks']['portfolio'], created.body['item']['sourceWatermark'].split('|')[0]);
    assert.equal(created.body['item']['metrics']['total'], 2);
    assert.equal(created.body['item']['metrics']['high'], 1);
    assert.equal(created.body['item']['metrics']['low'], 0);
    assert.equal(created.body['item']['metrics']['provisional'], 1);
    assert.deepEqual(created.body['item']['metrics']['atRiskValueByCurrency'], { CNY: 12000 });
    assert.deepEqual(
      created.body['item']['suppliers'].find((supplier: Record<string, unknown>) => supplier['supplierId'] === 'supplier:cn')['atRiskValueByCurrency'],
      { CNY: 12000 },
      'supplier risk value includes only formally published medium/high scores',
    );
    assert.deepEqual(
      created.body['item']['suppliers'].find((supplier: Record<string, unknown>) => supplier['supplierId'] === 'supplier:us')['atRiskValueByCurrency'],
      {},
      'a provisional medium score does not become a formal supplier at-risk amount',
    );
    assert.equal(created.body['item']['items'][0]['riskFactors'].some((factor: Record<string, unknown>) => factor['code'] === 'rihd_overdue'), true);
    assert.equal(created.body['item']['items'][0]['riskFactors'].some((factor: Record<string, unknown>) => factor['code'] === 'production_blocked'), true);
    assert.equal(created.body['item']['items'][0]['requiredInHouseAt'], '2026-08-20T00:00:00.000Z');
    assert.equal(created.body['item']['items'][0]['nextAction'], '获取供应商确认');
    assert.deepEqual(created.body['item']['configuration']['leadTime'], { autoCalculateLeadTime: true, preferenceVersion: null, inheritedDefault: true });
    assert.deepEqual(created.body['item']['items'][0]['leadTimeConfiguration'], { autoCalculateLeadTime: true, preferenceVersion: null, inheritedDefault: true });
    assert.equal(created.body['item']['items'][0]['riskModel']['modelVersion'], 'risk-model-v2');
    assert.equal(created.body['item']['items'][0]['riskModel']['evidenceCoverage'], 1);
    assert.equal(typeof created.body['item']['items'][0]['riskModel']['totalScore'], 'number');
    assert.equal(created.body['item']['items'][0]['riskModel']['provisionalScore'], null);
    assert.deepEqual(Object.fromEntries(Object.entries(created.body['item']['items'][0]['riskModel']['components']).map(([name, value]: [string, any]) => [name, value.weight])), {
      supplierPerformance: 0.30, deliveryDelay: 0.25, poValue: 0.20, productCriticality: 0.15, complianceApproval: 0.10,
    });
    assert.equal(created.body['item']['items'][0]['riskModel']['components']['productCriticality']['evidenceReferences'][0]['version'], 1);
    assert.equal(created.body['item']['riskBreakdown'].every((item: Record<string, unknown>) => typeof item['weight'] === 'number'), true);
    const deliveryDelay = created.body['item']['riskBreakdown'].find((item: Record<string, unknown>) => item['code'] === 'delivery_delay');
    assert.equal(deliveryDelay['affectedPurchaseOrders'], 1);
    assert.ok(Number(deliveryDelay['score']) > 0);

    const replay = await request('/api/procurement/risk-dashboard/refresh', 'POST', 'manager');
    assert.equal(replay.status, 200);
    assert.equal(replay.body['replayed'], true);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM procurement_risk_snapshots').get()?.['count'], 1);

    const current = await request('/api/procurement/risk-dashboard?from=2026-08-01&to=2026-08-31');
    assert.equal(current.body['freshness']['state'], 'current');
    assert.equal(current.body['freshness']['reason'], null);

    store.db.prepare(`INSERT INTO procurement_tenant_preferences
      (tenant_id,country_code,working_days_json,time_zone,date_format,sla_escalations_enabled,exclude_weekends,exclude_public_holidays,auto_calculate_lead_time,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,1,1,1,0,1,?,?,?,?)`).run(
        tenantId, 'CN', JSON.stringify([1, 2, 3, 4, 5]), 'Asia/Shanghai', 'YYYY-MM-DD', 'human:manager', 'human:manager', clock.toISOString(), clock.toISOString(),
      );
    const configurationStale = await request('/api/procurement/risk-dashboard?from=2026-08-01&to=2026-08-31');
    assert.equal(configurationStale.body['freshness']['state'], 'stale');
    assert.equal(configurationStale.body['freshness']['reason'], 'configuration_changed');
    store.db.prepare('DELETE FROM procurement_tenant_preferences WHERE tenant_id=?').run(tenantId);

    clock = new Date('2026-08-28T10:00:00.000Z');
    const stale = await request('/api/procurement/risk-dashboard?from=2026-08-01&to=2026-08-31');
    assert.equal(stale.body['freshness']['state'], 'stale');
    assert.equal(stale.body['freshness']['reason'], 'calendar_day_changed');
    assert.equal(stale.body['freshness']['latestSnapshotAt'], '2026-08-27T10:00:00.000Z');
    const next = await request('/api/procurement/risk-dashboard/refresh', 'POST', 'reader');
    assert.equal(next.status, 201, '采购专员拥有 operate 权限，可以刷新内部读模型');
    const history = await request('/api/procurement/risk-dashboard?from=2026-08-01&to=2026-08-31');
    assert.equal(history.status, 200);
    assert.equal(history.body['snapshotCount'], 2);
    assert.equal(history.body['freshness']['state'], 'current');
    assert.equal(history.body['trend'].length, 2);
    assert.equal(history.body['trend'][1]['sourceWatermark'], history.body['latest']['sourceWatermark']);
    assert.deepEqual(history.body['trend'][1]['overviewMetrics'], {
      highRisk: 1,
      overdue: 1,
      requireAttention: 1,
      activePurchaseOrders: 2,
      localProcurement: 0,
      importProcurement: 0,
    });
    assert.equal(history.body['latest']['asOf'], '2026-08-28T10:00:00.000Z');
    assert.equal(history.body['unfilteredItemCount'], 2);
    assert.equal(history.body['filteredItemCount'], 2);
    assert.deepEqual(history.body['filterOptions']['risks'], ['high']);
    assert.deepEqual(history.body['filterOptions']['routes'], ['unclassified']);
    assert.equal(history.body['filterOptions']['suppliers'].length, 2);

    const filtered = await request('/api/procurement/risk-dashboard?from=2026-08-01&to=2026-08-31&risk=high&supplierId=supplier%3Acn');
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body['latest']['metrics']['total'], 1);
    assert.equal(filtered.body['latest']['metrics']['high'], 1);
    assert.equal(filtered.body['latest']['items'][0]['number'], 'P00001');
    assert.equal(filtered.body['filteredItemCount'], 1);
    assert.deepEqual(filtered.body['appliedFilters'], { risk: 'high', route: null, supplierId: 'supplier:cn', materialType: null });
    assert.equal(filtered.body['trend'].length, 2, '筛选条件必须同时作用于历史趋势');
    assert.equal(filtered.body['trend'][0]['high'], 1);

    const exportResponse = await fetch(`${base}/api/procurement/risk-dashboard/export?from=2026-08-01&to=2026-08-31&risk=high`, { headers: { authorization: 'Bearer reader' } });
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(exportResponse.headers.get('content-disposition') ?? '', /readywork-risk-2026-08-31\.csv/);
    assert.ok(exportResponse.headers.get('x-readywork-snapshot-id'));
    const exportedCsv = await exportResponse.text();
    assert.match(exportedCsv, /Required In-House Date/);
    assert.match(exportedCsv, /Next Action/);
    assert.match(exportedCsv, /Risk Model Version/);
    assert.match(exportedCsv, /Evidence Coverage/);
    assert.match(exportedCsv, /Score State/);
    assert.match(exportedCsv, /risk-model-v2/);
    assert.match(exportedCsv, /P00001/);
    assert.doesNotMatch(exportedCsv, /P00002/);

    const invalidRisk = await request('/api/procurement/risk-dashboard?risk=critical');
    assert.equal(invalidRisk.status, 422);
    assert.equal(invalidRisk.body['error'], '风险等级必须是 high、medium 或 low');
    const invalidRoute = await request('/api/procurement/risk-dashboard?route=freight');
    assert.equal(invalidRoute.status, 422);
    assert.equal(invalidRoute.body['error'], '采购路线必须是 local、import 或 unclassified');
    assert.equal((await request('/api/procurement/risk-dashboard?from=2026-09-01&to=2026-08-01')).status, 422);

    const other: Session = { ...reader, tenantId: 'tenant:other' };
    const isolated = await new Promise<{ status: number; body: Record<string, any> }>(async (resolve) => {
      const isolatedServer = createServer((req, res) => {
        const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        void handleProcurementRiskDashboardRequest(req, res, path, 'GET', { db: store.db, session: other, now: () => clock });
      });
      await new Promise<void>((done) => isolatedServer.listen(0, '127.0.0.1', done));
      const response = await fetch(`http://127.0.0.1:${(isolatedServer.address() as AddressInfo).port}/api/procurement/risk-dashboard?from=2026-08-01&to=2026-08-31`);
      const body = await response.json() as Record<string, any>;
      isolatedServer.close();
      resolve({ status: response.status, body });
    });
    assert.equal(isolated.status, 200);
    assert.equal(isolated.body['snapshotCount'], 0);
  } finally {
    server.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('采购风险看板：旧模型快照只读兼容且不会被 V2 回填改写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-risk-dashboard-legacy-'));
  const store = openPersistence(join(dir, 'risk.db'), { tenantId });
  const legacy = {
    id: 'risk:legacy', sourceWatermark: 'legacy-watermark', asOf: '2026-08-01T08:00:00.000Z',
    metrics: { total: 1, high: 1, medium: 0, low: 0, highRiskPercent: 100, atRiskValueByCurrency: { CNY: 100 }, averageRiskScore: 88 },
    riskDistribution: [{ risk: 'high', count: 1 }, { risk: 'medium', count: 0 }, { risk: 'low', count: 0 }],
    riskBreakdown: [], suppliers: [{ supplierId: 'supplier:legacy', supplierName: '历史供应商', purchaseOrders: 1, riskScore: 88, atRiskValueByCurrency: { CNY: 100 } }], aging: [], products: [],
    items: [{
      purchaseOrderId: 'po:legacy', number: 'P-LEGACY-001', supplierId: 'supplier:legacy', supplierName: '历史供应商', materialType: '历史物料',
      route: 'local', risk: 'high', riskScore: 88, riskFactors: [], requiredInHouseAt: null, overdueDays: 0, currency: 'CNY', amountTotal: 100,
    }],
  };
  const raw = JSON.stringify(legacy);
  store.db.prepare(`INSERT INTO procurement_risk_snapshots
    (tenant_id,id,source_watermark,as_of,snapshot_json,created_by,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(tenantId, legacy.id, legacy.sourceWatermark, legacy.asOf, raw, 'human:legacy', legacy.asOf);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleProcurementRiskDashboardRequest(req, res, path, req.method ?? 'GET', { db: store.db, session: reader, now: () => new Date('2026-08-02T08:00:00.000Z') });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/procurement/risk-dashboard?from=2026-08-01&to=2026-08-02`);
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, 200);
    assert.equal(body['latest']['modelVersion'], 'legacy-risk-v1');
    assert.equal(body['latest']['metrics']['averageRiskScore'], 88);
    assert.equal(body['latest']['items'][0]['riskPublicationState'], 'legacy');
    assert.deepEqual(body['latest']['items'][0]['riskModel'], {
      modelVersion: 'legacy-risk-v1', evidenceCoverage: null, totalScore: null, provisionalScore: null, provisionalBand: null,
    });
    assert.deepEqual(body['latest']['items'][0]['missingRiskComponents'], []);
    assert.equal(body['trend'][0]['modelVersion'], 'legacy-risk-v1');
    assert.equal(store.db.prepare('SELECT snapshot_json FROM procurement_risk_snapshots WHERE tenant_id=? AND id=?').get(tenantId, legacy.id)?.['snapshot_json'], raw);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
