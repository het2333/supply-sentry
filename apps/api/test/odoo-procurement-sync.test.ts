import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { OdooProcurementSnapshot } from '../src/odoo-procurement-sync.js';
import { importOdooProcurementSnapshot, OdooSyncIdempotencyConflictError } from '../src/odoo-procurement-sync.js';
import { openPersistence } from '@readywork/persistence';

function snapshot(price = 10): OdooProcurementSnapshot {
  return {
    suppliers: { items: [{ externalId: 'odoo-partner-7', name: '供应商 A', currency: 'CNY', contacts: [{ name: '联系人', email: 'buyer@example.test', phone: '' }], countryCode: 'CN', countryName: '中国', city: '上海', street: '浦东新区采购路 8 号', postalCode: '200120', status: 'active', sourceSystem: 'odoo' }], issues: [] },
    purchaseOrders: [{
      id: 20, name: 'P00011', supplierId: 'odoo-7', supplierName: '供应商 A', supplierEmail: 'buyer@example.test', currency: 'CNY',
      state: 'purchase', amountTotal: 113, amountUntaxed: 100, dateOrder: '2026-08-01 09:00:00', confirmedAt: '2026-08-01 09:05:00', promiseDate: '2026-08-05 00:00:00',
      incotermId: 5, incotermName: 'FOB', incotermLocation: 'Shanghai Port', dropshipAddressId: 18,
      dropshipAddressName: '上海工厂', deliveryOperationTypeId: 2, deliveryOperationTypeName: 'My Company: 收据',
      lines: [{ id: 201, productId: 55, product: 'M6 螺钉', unit: '件', qty: 10, priceUnit: price, datePlanned: '2026-08-05 00:00:00' }],
    }],
    receipts: [{
      id: 30, name: 'WH/IN/30', poName: 'P00011', state: 'done', scheduledDate: '2026-08-05 00:00:00', doneDate: '2026-08-05 12:00:00',
      warehouseLocationId: 8, warehouseLocationName: 'WH/Stock', createdAt: '2026-08-05 11:00:00', updatedAt: '2026-08-05 12:00:00',
      lines: [{ id: 301, productId: 55, product: 'M6 螺钉', quantity: 10, unit: '件', poLineId: 201, moveId: 300 }],
    }],
    invoices: [{
      id: 10, name: 'BILL/10', supplierId: 7, supplierName: '供应商 A', poName: 'P00011', currency: 'CNY', amountTotal: 113,
      amountUntaxed: 100, state: 'posted', paymentState: 'not_paid', date: '2026-08-06', createdAt: '2026-08-06 09:00:00', updatedAt: '2026-08-06 09:10:00',
      lines: [{ id: 101, productId: 55, product: 'M6 螺钉', unit: '件', quantity: 10, unitPrice: price, subtotal: 100, taxIds: [3], currency: 'CNY', poLineId: 201, poId: 20 }],
    }],
  };
}

test('Odoo 采购快照在单事务中按稳定外部 ID 落库并可重放', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readywork-odoo-sync-'));
  const store = openPersistence(join(dir, 'readywork.sqlite'), { tenantId: 'tenant:a' });
  try {
    const first = importOdooProcurementSnapshot(store.db, 'tenant:a', snapshot(), { idempotencyKey: 'sync:1', syncedAt: '2026-08-21T12:00:00.000Z' });
    assert.equal(store.db.prepare(`SELECT status FROM twin_projection_jobs
      WHERE tenant_id=? AND source_table='procurement_documents' AND source_key LIKE 'purchase_order:%' LIMIT 1`)
      .get('tenant:a')?.['status'], 'queued');
    assert.equal(first.stats.purchaseOrders.created, 1);
    assert.equal(first.stats.receipts.created, 1);
    assert.equal(first.stats.invoices.created, 1);
    assert.equal(first.stats.purchaseOrderLines.created, 1);
    assert.equal(first.issues.length, 0);
    const po = store.db.prepare("SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order'").get('tenant:a') as { json: string };
    assert.equal(JSON.parse(po.json).externalId, 'purchase.order:20');
    assert.equal(JSON.parse(po.json).number, 'P00011');
    assert.equal(JSON.parse(po.json).supplierId, 'supplier:odoo:7');
    assert.equal(JSON.parse(po.json).status, 'received');
    assert.equal(JSON.parse(po.json).confirmedAt, '2026-08-01T09:05:00.000Z');
    assert.deepEqual({
      incotermId: JSON.parse(po.json).incotermId,
      incotermName: JSON.parse(po.json).incotermName,
      incotermLocation: JSON.parse(po.json).incotermLocation,
      dropshipAddressId: JSON.parse(po.json).dropshipAddressId,
      dropshipAddressName: JSON.parse(po.json).dropshipAddressName,
      deliveryOperationTypeId: JSON.parse(po.json).deliveryOperationTypeId,
      deliveryOperationTypeName: JSON.parse(po.json).deliveryOperationTypeName,
    }, {
      incotermId: 5, incotermName: 'FOB', incotermLocation: 'Shanghai Port', dropshipAddressId: 18,
      dropshipAddressName: '上海工厂', deliveryOperationTypeId: 2, deliveryOperationTypeName: 'My Company: 收据',
    });
    const supplier = store.db.prepare("SELECT version,json FROM procurement_documents WHERE tenant_id=? AND kind='supplier'").get('tenant:a') as { version: number; json: string };
    assert.equal(supplier.version, 1);
    assert.deepEqual(JSON.parse(supplier.json), {
      id: 'supplier:odoo:7', tenantId: 'tenant:a', sourceSystem: 'odoo', externalId: 'odoo-partner-7', status: 'active',
      createdAt: '2026-08-21T12:00:00.000Z', updatedAt: '2026-08-21T12:00:00.000Z', name: '供应商 A', currency: 'CNY',
      contacts: [{ id: 'supplier-contact:odoo:7:0', name: '联系人', email: 'buyer@example.test', primary: true }],
      countryCode: 'CN', countryName: '中国', city: '上海', street: '浦东新区采购路 8 号', postalCode: '200120',
    });
    const invoiceLine = store.db.prepare("SELECT json FROM procurement_lines WHERE tenant_id=? AND kind='invoice_line'").get('tenant:a') as { json: string };
    assert.equal(JSON.parse(invoiceLine.json).poLineId, 'purchase-order-line:odoo:201');
    const projection = store.db.prepare(`SELECT confirmed_qty,received_qty FROM procurement_po_line_quantity_projections
      WHERE tenant_id=? AND po_line_id=?`).get('tenant:a', 'purchase-order-line:odoo:201') as { confirmed_qty: number; received_qty: number };
    assert.deepEqual({ ...projection }, { confirmed_qty: 10, received_qty: 10 });
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_line_quantity_events
      WHERE tenant_id=? AND source_system='odoo'`).get('tenant:a') as { count: number }).count, 2);
    const grn = store.db.prepare(`SELECT state,evidence_json FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND stage='delivery_grn' AND event_type='grn_completed'`).get('tenant:a', 'purchase-order:odoo:20') as { state: string; evidence_json: string };
    assert.equal(grn.state, 'completed');
    assert.equal(JSON.parse(grn.evidence_json)['externalId'], 'stock.picking:30');
    const issued = store.db.prepare(`SELECT state,occurred_at,source_kind,evidence_json FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND stage='po_sent' AND event_type='odoo_purchase_order_confirmed'`)
      .get('tenant:a', 'purchase-order:odoo:20') as { state: string; occurred_at: string; source_kind: string; evidence_json: string };
    assert.deepEqual({ state: issued.state, occurredAt: issued.occurred_at, sourceKind: issued.source_kind }, {
      state: 'completed', occurredAt: '2026-08-01T09:05:00.000Z', sourceKind: 'odoo_purchase_order',
    });
    assert.equal(JSON.parse(issued.evidence_json)['exactTransitionTime'], true);

    const replay = importOdooProcurementSnapshot(store.db, 'tenant:a', snapshot(), { idempotencyKey: 'sync:1', syncedAt: '2026-08-21T12:01:00.000Z' });
    assert.equal(replay.replayed, true);
    importOdooProcurementSnapshot(store.db, 'tenant:a', snapshot(), { idempotencyKey: 'sync:1-same-snapshot', syncedAt: '2026-08-21T12:02:00.000Z' });
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_line_quantity_events
      WHERE tenant_id=? AND source_system='odoo'`).get('tenant:a') as { count: number }).count, 2);
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_stage_events
      WHERE tenant_id=? AND source_kind='odoo_grn'`).get('tenant:a') as { count: number }).count, 2);
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_stage_events
      WHERE tenant_id=? AND source_kind='odoo_purchase_order'`).get('tenant:a') as { count: number }).count, 1);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM procurement_documents WHERE tenant_id=?").get('tenant:a') as { count: number }).count, 4);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Odoo GRN 部分收货、补收和冲销幂等投影 PO 状态与阶段事件', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:grn' });
  try {
    const partial = snapshot();
    partial.receipts[0]!.lines[0] = { ...partial.receipts[0]!.lines[0]!, quantity: 4 };
    importOdooProcurementSnapshot(store.db, 'tenant:grn', partial, { idempotencyKey: 'grn:partial', syncedAt: '2026-08-21T12:00:00.000Z' });
    let po = store.db.prepare(`SELECT status FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order'`).get('tenant:grn') as { status: string };
    assert.equal(po.status, 'partially_received');
    let projection = store.db.prepare(`SELECT received_qty FROM procurement_po_line_quantity_projections WHERE tenant_id=? AND po_line_id=?`)
      .get('tenant:grn', 'purchase-order-line:odoo:201') as { received_qty: number };
    assert.equal(projection.received_qty, 4);

    const complete = snapshot();
    complete.receipts[0] = { ...complete.receipts[0]!, updatedAt: '2026-08-05 13:00:00' };
    importOdooProcurementSnapshot(store.db, 'tenant:grn', complete, { idempotencyKey: 'grn:complete', syncedAt: '2026-08-21T13:00:00.000Z' });
    po = store.db.prepare(`SELECT status FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order'`).get('tenant:grn') as { status: string };
    assert.equal(po.status, 'received');
    projection = store.db.prepare(`SELECT received_qty FROM procurement_po_line_quantity_projections WHERE tenant_id=? AND po_line_id=?`)
      .get('tenant:grn', 'purchase-order-line:odoo:201') as { received_qty: number };
    assert.equal(projection.received_qty, 10);

    const correction = snapshot();
    correction.receipts[0] = { ...correction.receipts[0]!, updatedAt: '2026-08-05 14:00:00', lines: [{ ...correction.receipts[0]!.lines[0]!, quantity: 6 }] };
    importOdooProcurementSnapshot(store.db, 'tenant:grn', correction, { idempotencyKey: 'grn:correction', syncedAt: '2026-08-21T14:00:00.000Z' });
    po = store.db.prepare(`SELECT status FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order'`).get('tenant:grn') as { status: string };
    assert.equal(po.status, 'partially_received');
    projection = store.db.prepare(`SELECT received_qty FROM procurement_po_line_quantity_projections WHERE tenant_id=? AND po_line_id=?`)
      .get('tenant:grn', 'purchase-order-line:odoo:201') as { received_qty: number };
    assert.equal(projection.received_qty, 6);
    const events = store.db.prepare(`SELECT delta FROM procurement_po_line_quantity_events
      WHERE tenant_id=? AND source_system='odoo' AND dimension='received' ORDER BY occurred_at`).all('tenant:grn') as unknown as Array<{ delta: number }>;
    assert.deepEqual(events.map((event) => event.delta), [4, 6, -4]);
    const latest = store.db.prepare(`SELECT event_type,state FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND stage='delivery_grn' ORDER BY occurred_at DESC,id DESC LIMIT 1`)
      .get('tenant:grn', 'purchase-order:odoo:20') as { event_type: string; state: string };
    assert.deepEqual({ ...latest }, { event_type: 'partial_grn_recorded', state: 'active' });
  } finally { store.close(); }
});

test('Odoo 同步更新变化行、不跨租户，且拒绝幂等键换载荷', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readywork-odoo-sync-tenants-'));
  const store = openPersistence(join(dir, 'readywork.sqlite'), { tenantId: 'tenant:a' });
  try {
    importOdooProcurementSnapshot(store.db, 'tenant:a', snapshot(), { idempotencyKey: 'sync:a', syncedAt: '2026-08-21T12:00:00.000Z' });
    const changed = importOdooProcurementSnapshot(store.db, 'tenant:a', snapshot(12), { idempotencyKey: 'sync:b', syncedAt: '2026-08-21T12:02:00.000Z' });
    assert.equal(changed.stats.purchaseOrderLines.updated, 1);
    assert.equal(changed.stats.invoiceLines.updated, 1);
    assert.throws(() => importOdooProcurementSnapshot(store.db, 'tenant:a', snapshot(13), { idempotencyKey: 'sync:a' }), OdooSyncIdempotencyConflictError);
    importOdooProcurementSnapshot(store.db, 'tenant:b', snapshot(), { idempotencyKey: 'sync:a', syncedAt: '2026-08-21T12:03:00.000Z' });
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM procurement_documents WHERE tenant_id=?").get('tenant:a') as { count: number }).count, 4);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM procurement_documents WHERE tenant_id=?").get('tenant:b') as { count: number }).count, 4);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Odoo 行投影: A→B→A 保留三个单调世代且精确快照重放不入队', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:odoo-line-generation' });
  try {
    const tenantId = 'tenant:odoo-line-generation';
    importOdooProcurementSnapshot(store.db, tenantId, snapshot(10), { idempotencyKey: 'line:a1', syncedAt: '2026-08-21T12:00:00.000Z' });
    importOdooProcurementSnapshot(store.db, tenantId, snapshot(10), { idempotencyKey: 'line:a-replay', syncedAt: '2026-08-21T12:01:00.000Z' });
    const sourceKey = 'purchase_order_line:purchase-order-line:odoo:201';
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM twin_projection_jobs
      WHERE tenant_id=? AND source_table='procurement_lines' AND source_key=?`)
      .get(tenantId, sourceKey)?.['count'], 1);
    importOdooProcurementSnapshot(store.db, tenantId, snapshot(12), { idempotencyKey: 'line:b', syncedAt: '2026-08-21T12:02:00.000Z' });
    importOdooProcurementSnapshot(store.db, tenantId, snapshot(10), { idempotencyKey: 'line:a2', syncedAt: '2026-08-21T12:03:00.000Z' });

    const jobs = store.db.prepare(`SELECT source_revision,payload_hash,status FROM twin_projection_jobs
      WHERE tenant_id=? AND source_table='procurement_lines' AND source_key=?
      ORDER BY CAST(source_revision AS INTEGER)`)
      .all(tenantId, sourceKey) as unknown as Array<{ source_revision: string; payload_hash: string; status: string }>;
    assert.deepEqual(jobs.map((job) => job.source_revision), ['1', '2', '3']);
    assert.equal(jobs[0]!.payload_hash, jobs[2]!.payload_hash);
    assert.notEqual(jobs[0]!.payload_hash, jobs[1]!.payload_hash);
    assert.equal(jobs[2]!.status, 'queued');
    assert.equal(store.db.prepare(`SELECT projection_generation FROM procurement_lines
      WHERE tenant_id=? AND kind='purchase_order_line' AND id='purchase-order-line:odoo:201'`)
      .get(tenantId)?.['projection_generation'], 3);
  } finally { store.close(); }
});

test('未完成入库单不被伪造成真实收货', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readywork-odoo-sync-pending-'));
  const store = openPersistence(join(dir, 'readywork.sqlite'));
  try {
    const input = snapshot();
    input.receipts[0] = { ...input.receipts[0]!, state: 'assigned', doneDate: '' };
    const result = importOdooProcurementSnapshot(store.db, 't:acme', input, { syncedAt: '2026-08-21T12:00:00.000Z' });
    assert.equal(result.stats.receipts.skipped, 1);
    assert.equal(result.issues.some((issue) => issue.code === 'RECEIPT_NOT_DONE'), true);
    assert.equal((store.db.prepare("SELECT COUNT(*) AS count FROM procurement_documents WHERE tenant_id=? AND kind='receipt'").get('t:acme') as { count: number }).count, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
