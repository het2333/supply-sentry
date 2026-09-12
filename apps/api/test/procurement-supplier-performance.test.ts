import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Communication, PurchaseOrder, PurchaseOrderLine, Receipt, Supplier } from '@readywork/core';
import { openPersistence } from '@readywork/persistence';
import type { Session } from '../src/auth.js';
import { handleProcurementSupplierPerformanceRequest } from '../src/procurement-supplier-performance.js';

const tenantId = 'tenant:supplier-performance';
const manager: Session = { username: 'manager', tenantId, humanId: 'human:manager', name: '经理', role: '采购经理', expiresAt: Date.now() + 60_000 };
const reader: Session = { username: 'reader', tenantId, humanId: 'human:reader', name: '采购员', role: '采购专员', expiresAt: Date.now() + 60_000 };
const at = '2026-08-20T08:00:00.000Z';

function seed(store: ReturnType<typeof openPersistence>): void {
  const suppliers: Supplier[] = [
    { id: 'supplier:measured', tenantId, sourceSystem: 'odoo', externalId: 'SUP-001', status: 'active', createdAt: at, updatedAt: at, name: '有履约证据供应商', contacts: [{ id: 'contact:1', name: '王工', email: 'wang@example.test', primary: true }], currency: 'CNY' },
    { id: 'supplier:no-evidence', tenantId, sourceSystem: 'odoo', externalId: 'SUP-002', status: 'active', createdAt: at, updatedAt: at, name: '无履约证据供应商', contacts: [], currency: 'CNY' },
  ];
  for (const supplier of suppliers) store.procurement.saveDocument('supplier', supplier);

  const purchaseOrders: PurchaseOrder[] = [
    { id: 'po:received', tenantId, sourceSystem: 'odoo', externalId: 'PO-001', status: 'received', createdAt: at, updatedAt: '2026-08-29T08:00:00.000Z', supplierId: suppliers[0]!.id, currency: 'CNY', orderedAt: at },
    { id: 'po:sent', tenantId, sourceSystem: 'odoo', externalId: 'PO-002', status: 'sent', createdAt: at, updatedAt: '2026-08-21T08:00:00.000Z', supplierId: suppliers[0]!.id, currency: 'CNY', orderedAt: at },
  ];
  for (const purchaseOrder of purchaseOrders) store.procurement.saveDocument('purchase_order', purchaseOrder);
  const lines: PurchaseOrderLine[] = [
    { id: 'line:received', poId: 'po:received', lineNumber: '10', itemId: 'item:valve', description: '阀门', uom: 'EA', orderedQty: 10, unitPrice: 100, currency: 'CNY', requestedAt: '2026-08-30T08:00:00.000Z' },
    { id: 'line:sent', poId: 'po:sent', lineNumber: '10', itemId: 'item:pump', description: '泵', uom: 'EA', orderedQty: 2, unitPrice: 500, currency: 'CNY', requestedAt: '2026-09-10T08:00:00.000Z' },
  ];
  for (const line of lines) store.procurement.saveLine('purchase_order_line', line.poId, line);
  const receipt: Receipt = { id: 'receipt:001', tenantId, sourceSystem: 'odoo', externalId: 'GRN-001', status: 'received', createdAt: '2026-08-29T08:00:00.000Z', updatedAt: '2026-08-29T08:00:00.000Z', poId: 'po:received', warehouseId: 'warehouse:1', receivedAt: '2026-08-29T08:00:00.000Z' };
  store.procurement.saveDocument('receipt', receipt);
  const communication: Communication = { id: 'communication:001', tenantId, sourceSystem: 'email', externalId: 'MSG-001', status: 'received', createdAt: '2026-08-20T12:00:00.000Z', updatedAt: '2026-08-20T12:00:00.000Z', businessObjectId: 'po:received', businessObjectType: 'purchase_order', supplierId: suppliers[0]!.id, channel: 'email', direction: 'inbound', body: '已确认', attachmentIds: [], occurredAt: '2026-08-20T12:00:00.000Z', receivedAt: '2026-08-20T12:00:00.000Z' };
  store.procurement.saveDocument('communication', communication);

  store.db.prepare(`INSERT INTO procurement_sla_evaluations
    (tenant_id,po_id,policy_id,policy_version,rule_id,stage,status,due_at,grace_until,next_followup_at,followup_count,evidence_json,fingerprint,version,evaluated_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(tenantId, 'po:received', 'sla:v1', 1, 'rule:1', 'delivery_grn', 'on_track', null, null, null, 0, '{}', 'sla-received', '2026-08-29T09:00:00.000Z', '2026-08-29T09:00:00.000Z');
  store.db.prepare(`INSERT INTO procurement_sla_evaluations
    (tenant_id,po_id,policy_id,policy_version,rule_id,stage,status,due_at,grace_until,next_followup_at,followup_count,evidence_json,fingerprint,version,evaluated_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(tenantId, 'po:sent', 'sla:v1', 1, 'rule:2', 'po_sent', 'breached', '2026-08-21T08:00:00.000Z', '2026-08-21T12:00:00.000Z', null, 2, '{}', 'sla-sent', '2026-08-22T09:00:00.000Z', '2026-08-22T09:00:00.000Z');
  store.db.prepare(`INSERT INTO procurement_import_document_evaluations
    (tenant_id,po_id,policy_id,policy_version,status,summary_json,fingerprint,version,evaluated_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?)`).run(tenantId, 'po:received', 'docs:v1', 1, 'passed', '{}', 'docs-received', '2026-08-29T09:00:00.000Z', '2026-08-29T09:00:00.000Z');
  store.db.prepare(`INSERT INTO procurement_import_document_evaluations
    (tenant_id,po_id,policy_id,policy_version,status,summary_json,fingerprint,version,evaluated_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?)`).run(tenantId, 'po:sent', 'docs:v1', 1, 'security_blocked', '{}', 'docs-sent', '2026-08-22T09:00:00.000Z', '2026-08-22T09:00:00.000Z');
}

test('供应商绩效：真实事实评分、缺证据不伪造、快照幂等与租户隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-supplier-performance-'));
  const databasePath = join(dir, 'performance.db');
  let store = openPersistence(databasePath, { tenantId });
  seed(store);
  const clock = new Date('2026-08-30T10:00:00.000Z');
  const server = createServer((req, res) => {
    const token = String(req.headers['authorization'] ?? '').replace('Bearer ', '');
    const session = token === 'manager' ? manager : token === 'reader' ? reader : token === 'other' ? { ...reader, tenantId: 'tenant:other' } : null;
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleProcurementSupplierPerformanceRequest(req, res, path, req.method ?? 'GET', { db: store.db, session, now: () => clock })
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
    assert.equal((await request('/api/procurement/supplier-performance', 'GET', '')).status, 401);
    assert.equal((await request('/api/procurement/supplier-performance?from=2026-09-01&to=2026-08-01')).status, 422);
    const empty = await request('/api/procurement/supplier-performance?from=2026-08-01&to=2026-08-31');
    assert.equal(empty.status, 200); assert.equal(empty.body['latest'], null);

    const created = await request('/api/procurement/supplier-performance/refresh', 'POST', 'manager');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const snapshot = created.body['item'];
    assert.equal(snapshot['metrics']['totalSuppliers'], 2);
    assert.equal(snapshot['metrics']['scoredSuppliers'], 1);
    const measured = snapshot['items'].find((item: Record<string, unknown>) => item['supplierId'] === 'supplier:measured');
    const noEvidence = snapshot['items'].find((item: Record<string, unknown>) => item['supplierId'] === 'supplier:no-evidence');
    assert.equal(measured['score'], 67.5);
    assert.equal(measured['grade'], 'watch');
    assert.equal(measured['evidenceCoverage'], 100);
    assert.equal(measured['averageResponseHours'], 4);
    assert.equal(measured['slaBreaches'], 1);
    assert.equal(measured['dimensions'].find((item: Record<string, unknown>) => item['code'] === 'on_time_delivery')['score'], 100);
    assert.equal(noEvidence['score'], null);
    assert.equal(noEvidence['grade'], 'insufficient_evidence');
    assert.equal(noEvidence['evidenceCoverage'], 0);

    const replay = await request('/api/procurement/supplier-performance/refresh', 'POST', 'reader');
    assert.equal(replay.status, 200); assert.equal(replay.body['replayed'], true);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM procurement_supplier_performance_snapshots').get()?.['count'], 1);
    assert.equal((await request('/api/procurement/supplier-performance?from=2026-08-01&to=2026-08-31', 'GET', 'other')).body['snapshotCount'], 0);

    store.close();
    store = openPersistence(databasePath, { tenantId });
    const restored = await request('/api/procurement/supplier-performance?from=2026-08-01&to=2026-08-31');
    assert.equal(restored.status, 200); assert.equal(restored.body['snapshotCount'], 1); assert.equal(restored.body['latest']['id'], snapshot['id']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
