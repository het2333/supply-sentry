import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { MemoryAttachmentObjectStorage } from '../src/attachment-object-storage.js';
import { buildRouteExportCsv, handleProcurementRouteExportRequest } from '../src/procurement-route-exports.js';

const secret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
const fixedNow = new Date('2026-09-02T12:00:00.000Z');
const at = '2026-09-01T10:00:00.000Z';

function token(tenantId: string, role: string, humanId: string): string {
  const session: Session = { username: humanId, tenantId, humanId, name: humanId, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function seed(store: Pick<ReturnType<typeof openPersistence>, 'tenantId' | 'procurement'>, suffix: string, route: 'local' | 'import', options: {
  supplierName: string; number: string; materialType: string; requiredInHouseAt: string; supplierId?: string;
}): void {
  const supplierId = options.supplierId ?? `supplier:${suffix}`;
  const supplier: Supplier = { id: supplierId, tenantId: store.tenantId, sourceSystem: 'odoo', externalId: `SUP-${suffix}`, status: 'active', createdAt: at, updatedAt: at, name: options.supplierName, currency: 'CNY', contacts: [] };
  const po: PurchaseOrder & { route: 'local' | 'import'; number: string; materialType: string; requiredInHouseAt: string; amountTotal: number } = {
    id: `po:${suffix}`, tenantId: store.tenantId, sourceSystem: 'odoo', externalId: options.number, number: options.number,
    status: 'awaiting_confirmation', createdAt: at, updatedAt: at, supplierId, currency: 'CNY', orderedAt: at,
    route, materialType: options.materialType, requiredInHouseAt: options.requiredInHouseAt, amountTotal: 1250,
  };
  const line: PurchaseOrderLine = { id: `line:${suffix}`, poId: po.id, lineNumber: '1', itemId: `item:${suffix}`, description: options.materialType, uom: 'EA', orderedQty: 5, unitPrice: 250, currency: 'CNY', requestedAt: options.requiredInHouseAt };
  store.procurement.saveDocument('supplier', supplier); store.procurement.saveDocument('purchase_order', po); store.procurement.saveLine('purchase_order_line', po.id, line);
}

class FailingStorage extends MemoryAttachmentObjectStorage {
  override async put(): Promise<never> { throw new Error('isolated object store unavailable'); }
}

test('authoritative route CSV translates only system headings, risk, completion and row action labels', () => {
  const csv = Buffer.from(buildRouteExportCsv([
    { id: 'po:high', number: '=PO-HIGH', supplierId: 'supplier:high', supplierName: 'Alpha, "Quoted"\nSupplier', materialType: '+Precision', route: 'local', stage: 'supplier_commitment', stageLabel: 'Supplier Custom Stage', requiredInHouseAt: '2026-09-05T00:00:00.000Z', risk: 'high', nextAction: 'Supplier original action', currency: 'USD', amountTotal: 1234.5, active: true },
    { id: 'po:medium', number: 'PO-MEDIUM', supplierId: 'supplier:medium', supplierName: 'Beta Supplier', materialType: 'Cable', route: 'local', stage: 'fulfilment_production', stageLabel: 'Production', requiredInHouseAt: '2026-09-06T00:00:00.000Z', risk: 'medium', nextAction: 'Keep original', currency: 'CNY', amountTotal: 20, active: true },
    { id: 'po:low', number: 'PO-LOW', supplierId: 'supplier:low', supplierName: 'Gamma Supplier', materialType: 'Pump', route: 'local', stage: 'delivery_grn', stageLabel: 'Delivered', requiredInHouseAt: null, risk: 'low', nextAction: 'No action', currency: 'EUR', amountTotal: 30.125, active: false },
  ], fixedNow)).toString('utf8');
  const [heading] = csv.split('\r\n');
  assert.equal(heading, '\uFEFF"采购订单号","供应商","物料类型","当前阶段","要求到货日期（RIHD）","距 RIHD 天数","风险","下一步操作","总金额","行操作"');
  assert.match(csv, /"高"/u); assert.match(csv, /"中"/u); assert.match(csv, /"低"/u);
  assert.match(csv, /"已完成"/u); assert.match(csv, /"查看详情"/u);
  assert.match(csv, /"Alpha, ""Quoted""\nSupplier"/u);
  assert.match(csv, /"'=PO-HIGH"/u); assert.match(csv, /"'\+Precision"/u);
  assert.match(csv, /"Supplier Custom Stage"/u); assert.match(csv, /"Supplier original action"/u);
  assert.match(csv, /"USD 1234\.50"/u); assert.match(csv, /"EUR 30\.13"/u);
});

test('authoritative route CSV export is filtered, stable, idempotent, tenant-isolated and downloadable', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:route-export' });
  seed(store, 'quoted', 'local', { supplierName: 'Alpha, "Quoted"\nSupplier', number: 'PO-002', materialType: 'Precision, bolt', requiredInHouseAt: '2026-09-05T00:00:00.000Z' });
  seed(store, 'other-local', 'local', { supplierName: 'Beta Supplier', number: 'PO-001', materialType: 'Cable', requiredInHouseAt: '2026-09-09T00:00:00.000Z' });
  seed(store, 'import', 'import', { supplierName: 'Import Supplier', number: 'IMP-001', materialType: 'Pump', requiredInHouseAt: '2026-09-07T00:00:00.000Z' });
  seed({ tenantId: 'tenant:other', procurement: createProcurementRepository(store.db, 'tenant:other') }, 'outsider', 'local', {
    supplierName: 'Outsider', number: 'OUT-001', materialType: 'Bolt', requiredInHouseAt: '2026-09-05T00:00:00.000Z',
  });

  let storage: MemoryAttachmentObjectStorage = new MemoryAttachmentObjectStorage({ now: () => fixedNow });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers.authorization; const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    void handleProcurementRouteExportRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(bearer), attachmentObjectStorage: storage, now: () => fixedNow,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = token(store.tenantId, '采购专员', 'human:buyer');
  const auditor = token(store.tenantId, '审计员', 'human:auditor');
  const outsiderToken = token('tenant:other', '采购专员', 'human:other');
  const body = { query: '  PRECISION  ', stages: ['supplier_commitment', 'supplier_commitment'], risks: ['low', 'medium', 'high'], supplierIds: ['supplier:quoted'], rihdFrom: '2026-09-01', rihdTo: '2026-09-30', sort: 'po_number_asc' };
  const post = async (path: string, requestBody: Record<string, unknown>, key: string, bearer = buyer) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(requestBody) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  try {
    assert.equal((await post('/api/procurement/routes/local/exports', body, 'unauthorized', '')).status, 401);
    assert.equal((await post('/api/procurement/routes/local/exports', body, 'auditor', auditor)).status, 403);
    assert.equal((await post('/api/procurement/routes/domestic/exports', body, 'invalid-route')).status, 422);

    const created = await post('/api/procurement/routes/local/exports', body, 'route-export:one');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.rowCount, 1); assert.equal(created.body.replayed, false);
    assert.match(created.body.contentSha256, /^[a-f0-9]{64}$/u);
    assert.equal(created.body.sourceWatermark, '2026-09-01T10:00:00.000Z|tenant-preferences:0:auto-lead-time:1');
    assert.match(created.body.downloadUrl, /^\/api\/procurement\/route-exports\/[^/]+\/download$/u);
    const row = store.db.prepare('SELECT * FROM procurement_route_exports WHERE tenant_id=? AND id=?').get(store.tenantId, created.body.id) as Record<string, unknown>;
    assert.equal(row['row_count'], 1); assert.equal(row['content_sha256'], created.body.contentSha256); assert.equal(row['state'], 'ready');
    assert.equal(row['normalized_filters_json'], JSON.stringify({ query: 'precision', stages: ['supplier_commitment'], risks: ['high', 'low', 'medium'], supplierIds: ['supplier:quoted'], rihdFrom: '2026-09-01', rihdTo: '2026-09-30', sort: 'po_number_asc' }));

    const download = await fetch(`${base}${created.body.downloadUrl}`, { headers: { authorization: `Bearer ${buyer}` } });
    const csv = Buffer.from(await download.arrayBuffer());
    assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename="readywork-local-purchase-orders-2026-09-02.csv"');
    assert.equal(createHash('sha256').update(csv).digest('hex'), created.body.contentSha256);
    assert.ok(csv.toString('utf8').startsWith('\uFEFF"采购订单号","供应商","物料类型","当前阶段","要求到货日期（RIHD）","距 RIHD 天数","风险","下一步操作","总金额","行操作"\r\n'));
    assert.match(csv.toString('utf8'), /"Alpha, ""Quoted""\nSupplier"/u);
    assert.match(csv.toString('utf8'), /"低"/u);
    assert.match(csv.toString('utf8'), /"查看详情"/u);
    assert.equal((await fetch(`${base}${created.body.downloadUrl}`, { headers: { authorization: `Bearer ${outsiderToken}` } })).status, 404);

    const replay = await post('/api/procurement/routes/local/exports', body, 'route-export:one');
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.id, created.body.id);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_route_exports').get() as { count: number }).count, 1);
    const conflict = await post('/api/procurement/routes/local/exports', { ...body, query: 'cable' }, 'route-export:one');
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'ROUTE_EXPORT_IDEMPOTENCY_CONFLICT');

    const stable = await post('/api/procurement/routes/local/exports', body, 'route-export:two');
    assert.equal(stable.status, 201); assert.equal(stable.body.sourceWatermark, created.body.sourceWatermark); assert.equal(stable.body.contentSha256, created.body.contentSha256);
    storage = new FailingStorage();
    const beforeFailure = (store.db.prepare('SELECT COUNT(*) AS count FROM procurement_route_exports').get() as { count: number }).count;
    const failed = await post('/api/procurement/routes/local/exports', { ...body, query: 'beta' }, 'route-export:failure');
    assert.equal(failed.status, 500); assert.equal(failed.body.code, 'ROUTE_EXPORT_STORAGE_FAILED');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_route_exports').get() as { count: number }).count, beforeFailure);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
