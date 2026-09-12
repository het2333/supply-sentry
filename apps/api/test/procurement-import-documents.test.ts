import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { createProcurementRepository, openPersistence, ProcurementValidationError } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementImportDocumentRequest } from '../src/procurement-import-documents.js';
import { ProcurementDocumentWorker } from '../src/procurement-document-worker.js';

const secret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
function token(tenantId: string, role = '采购经理'): string {
  const session: Session = { username: 'manager', tenantId, humanId: 'human:manager', name: 'Manager', role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

test('进口单证: 策略发布、真实文件、ClamAV 状态、评估、审计与最终 GRN 门禁', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-import-documents-'));
  const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:import-documents' });
  const tenantId = 'tenant:import-documents'; const repository = createProcurementRepository(store.db, tenantId);
  const at = '2026-08-28T00:00:00.000Z';
  const supplier: Supplier = { id: 'supplier:import', tenantId, sourceSystem: 'odoo', externalId: 'SUP-IMPORT', status: 'active', createdAt: at, updatedAt: at, name: 'Verified Import Supplier', currency: 'USD', contacts: [] };
  const po: PurchaseOrder = { id: 'po:import', tenantId, sourceSystem: 'odoo', externalId: 'PO-IMPORT-001', status: 'shipped', createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'USD', orderedAt: at };
  const line: PurchaseOrderLine = { id: 'po-line:import', poId: po.id, lineNumber: '10', itemId: 'VALVE-1', description: 'Industrial valve', uom: 'EA', orderedQty: 10, unitPrice: 100, currency: 'USD' };
  repository.saveDocument('supplier', supplier); repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
  store.db.prepare(`INSERT INTO procurement_route_assignments (tenant_id,po_id,route,source,evidence_json,version,created_by,updated_by,created_at,updated_at) VALUES (?,?,'import','manual',?,1,?,?,?,?)`)
    .run(tenantId, po.id, JSON.stringify({ reason: '合同 Incoterm 与进口报关安排已复核' }), 'human:manager', 'human:manager', at, at);
  store.db.prepare(`INSERT OR REPLACE INTO procurement_po_line_quantity_projections
    (tenant_id,po_line_id,ordered_qty,confirmed_qty,shipped_qty,received_qty,invoiced_qty,cancelled_qty,projection_json,updated_at)
    VALUES (?,?,10,10,10,0,0,0,?,?)`)
    .run(tenantId, line.id, JSON.stringify({ tenantId, poLineId: line.id, orderedQty: 10, confirmedQty: 10, shippedQty: 10, receivedQty: 0, invoicedQty: 0, cancelledQty: 0, events: [], appliedEventKeys: [] }), at);

  const now = new Date('2026-08-28T12:00:00.000Z');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1'); const auth = req.headers['authorization']; const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    void handleProcurementImportDocumentRequest(req, res, url.pathname, req.method ?? 'GET', { db: store.db, session: resolveSession(bearer), now: () => now, clamAvConfigured: true })
      .then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const manager = token(tenantId); const buyer = token(tenantId, '采购专员');
  async function request(path: string, options: { method?: string; token?: string; body?: Record<string, unknown>; key?: string } = {}) {
    const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.key ? { 'idempotency-key': options.key } : {}) }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  try {
    assert.equal((await request('/api/procurement/import-documents')).status, 401);
    const created = await request('/api/procurement/import-documents/policies', { method: 'POST', token: manager, body: { name: '进口单证 V1', description: '测试正式门禁', requirements: [{ code: 'packing_list', name: '装箱单', description: '最终装箱单', required: true, requiredStage: 'dispatch_transit', expiryRequired: false }] } });
    assert.equal(created.status, 201, JSON.stringify(created.body)); const policy = created.body['item'];
    assert.equal((await request(`/api/procurement/import-documents/policies/${encodeURIComponent(policy.id)}/publish`, { method: 'POST', token: buyer, body: { expectedVersion: policy.version } })).status, 403);
    const published = await request(`/api/procurement/import-documents/policies/${encodeURIComponent(policy.id)}/publish`, { method: 'POST', token: manager, body: { expectedVersion: policy.version } });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const missing = await request('/api/procurement/import-documents/evaluate', { method: 'POST', token: buyer, body: { purchaseOrderId: po.id } });
    assert.equal(missing.status, 200); assert.equal(missing.body['purchaseOrders'][0]['evaluation']['status'], 'missing');

    assert.throws(() => repository.executeProcurementMutation({ action: 'record_receipt', aggregateId: po.id, expectedVersion: 1, idempotencyKey: 'blocked-before-docs', payloadHash: 'blocked-before-docs', actorId: 'human:manager', permission: 'approve', occurredAt: now.toISOString(), evidenceSource: 'manual_verified', supplierReference: 'GRN-BLOCKED', evidenceReference: 'odoo:stock.picking:blocked', reason: '已核对 Odoo GRN', warehouseId: 'WH', lines: [{ poLineId: line.id, quantity: 10 }] }), (error: unknown) => error instanceof ProcurementValidationError && error.code === 'IMPORT_DOCUMENT_GATE_BLOCKED');

    const documentContent = Buffer.from('PACKING LIST PL-001\n10 EA INDUSTRIAL VALVE\n').toString('base64');
    const uploaded = await request(`/api/procurement/import-documents/pos/${encodeURIComponent(po.id)}/documents`, { method: 'POST', token: buyer, key: 'packing-list-v1', body: { requirementCode: 'packing_list', fileName: 'packing-list.txt', contentType: 'text/plain', contentBase64: documentContent, documentNumber: 'PL-001', issuedAt: '2026-08-28' } });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body)); assert.equal(uploaded.body['item']['securityStatus'], 'pending_scan');
    const replay = await request(`/api/procurement/import-documents/pos/${encodeURIComponent(po.id)}/documents`, { method: 'POST', token: buyer, key: 'packing-list-v1', body: { requirementCode: 'packing_list', fileName: 'packing-list.txt', contentType: 'text/plain', contentBase64: documentContent, documentNumber: 'PL-001', issuedAt: '2026-08-28' } });
    assert.equal(replay.status, 200); assert.equal(replay.body['replayed'], true);

    store.db.prepare(`UPDATE procurement_document_jobs SET available_at='1970-01-01T00:00:00.000Z' WHERE tenant_id=?`).run(tenantId);
    const worker = new ProcurementDocumentWorker(store.db, { malwareScanner: async () => ({ status: 'clean', engine: 'clamav', detail: 'stream: OK' }) });
    const workerResult = await worker.runTenant(tenantId); assert.equal(workerResult.completed, 1);
    const passed = await request('/api/procurement/import-documents/evaluate', { method: 'POST', token: buyer, body: { purchaseOrderId: po.id } });
    assert.equal(passed.body['purchaseOrders'][0]['evaluation']['status'], 'passed');
    const receipt = repository.executeProcurementMutation({ action: 'record_receipt', aggregateId: po.id, expectedVersion: 1, idempotencyKey: 'receipt-after-docs', payloadHash: 'receipt-after-docs', actorId: 'human:manager', permission: 'approve', occurredAt: now.toISOString(), evidenceSource: 'manual_verified', supplierReference: 'GRN-AFTER-DOCS', evidenceReference: 'odoo:stock.picking:after-docs', reason: '已核对 Odoo GRN 与安全单证', warehouseId: 'WH', lines: [{ poLineId: line.id, quantity: 10 }] });
    assert.equal(receipt.aggregate.document.status, 'received');
    const audit = store.db.prepare(`SELECT action FROM procurement_import_document_events WHERE tenant_id=? AND po_id=?`).all(tenantId, po.id) as Array<{ action: string }>;
    assert.ok(audit.some((item) => item.action === 'document_bound'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); store.close(); rmSync(dir, { recursive: true, force: true });
  }
});
