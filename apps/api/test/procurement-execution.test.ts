import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Communication, PurchaseOrder, PurchaseOrderLine, Receipt, Shipment, Supplier, SupplierInvoice, SupplierInvoiceLine } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementExecutionRequest } from '../src/procurement-execution.js';
import { ProcurementOutboxWorker } from '../src/procurement-outbox-worker.js';

const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
const at = '2026-08-21T00:00:00.000Z';

function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

test('采购执行 API: Edit PO 按来源原子更新 Draft 或排入 Odoo amendment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-edit-po-api-'));
  const store = openPersistence(join(dir, 'test.db'), { tenantId: 'bootstrap' });
  const repository = createProcurementRepository(store.db, 'tenant:edit');
  const supplier = (id: string, externalId: string): Supplier => ({
    id, tenantId: 'tenant:edit', sourceSystem: 'odoo', externalId, status: 'active', createdAt: at, updatedAt: at,
    name: id, currency: 'CNY', contacts: [{ id: `${id}:contact`, name: '采购联系人', email: `${id.replace(':', '.')}@example.com`, primary: true }],
  });
  const originalSupplier = supplier('supplier:edit:original', 'odoo-21');
  const replacementSupplier = supplier('supplier:edit:replacement', 'odoo-22');
  repository.saveDocument('supplier', originalSupplier);
  repository.saveDocument('supplier', replacementSupplier);
  const localDraft: PurchaseOrder = {
    id: 'po:edit:local', tenantId: 'tenant:edit', sourceSystem: 'readywork', externalId: 'PO-EDIT-LOCAL', status: 'draft',
    createdAt: at, updatedAt: at, supplierId: originalSupplier.id, currency: 'CNY', orderedAt: at,
  };
  const odooPo: PurchaseOrder = {
    ...localDraft, id: 'po:edit:odoo', sourceSystem: 'odoo', externalId: 'purchase.order:81', status: 'confirmed',
    number: 'P00081',
  } as PurchaseOrder & { number: string };
  const localLine: PurchaseOrderLine = {
    id: 'po-line:edit:local', poId: localDraft.id, lineNumber: '10', itemId: 'OLD-CODE', description: '旧物料',
    uom: 'EA', orderedQty: 2, unitPrice: 10, currency: 'CNY', taxRate: 0.13,
  };
  const odooLine: PurchaseOrderLine = { ...localLine, id: 'po-line:edit:odoo', poId: odooPo.id };
  const mappedDraft: PurchaseOrder = {
    ...localDraft, id: 'po:edit:mapped-draft', externalId: 'PO-EDIT-MAPPED-DRAFT',
    odooReference: { id: 82, name: 'P00082', correlationKey: 'readywork:tenant:edit:po:edit:mapped-draft', createdAt: at },
  };
  const inFlightDraft: PurchaseOrder = { ...localDraft, id: 'po:edit:in-flight', externalId: 'PO-EDIT-IN-FLIGHT' };
  const contactDraft: PurchaseOrder = { ...localDraft, id: 'po:edit:contact', externalId: 'PO-EDIT-CONTACT' };
  repository.saveDocument('purchase_order', localDraft); repository.saveLine('purchase_order_line', localDraft.id, localLine);
  repository.saveDocument('purchase_order', odooPo); repository.saveLine('purchase_order_line', odooPo.id, odooLine);
  repository.saveDocument('purchase_order', mappedDraft); repository.saveLine('purchase_order_line', mappedDraft.id, { ...localLine, id: 'po-line:edit:mapped-draft', poId: mappedDraft.id });
  repository.saveDocument('purchase_order', inFlightDraft); repository.saveLine('purchase_order_line', inFlightDraft.id, { ...localLine, id: 'po-line:edit:in-flight', poId: inFlightDraft.id });
  repository.saveDocument('purchase_order', contactDraft); repository.saveLine('purchase_order_line', contactDraft.id, { ...localLine, id: 'po-line:edit:contact', poId: contactDraft.id });
  const inFlightOutbox = {
    id: 'procurement-outbox:edit-in-flight', tenantId: 'tenant:edit', channel: 'email', connectorId: 'email', action: 'purchase_order.send',
    aggregateId: inFlightDraft.id, idempotencyKey: 'send:edit-in-flight', status: 'pending', payload: {}, attempts: 0, createdAt: at, updatedAt: at,
  };
  store.db.prepare(`INSERT INTO procurement_outbox
    (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'tenant:edit', inFlightOutbox.id, inFlightOutbox.channel, inFlightOutbox.connectorId, inFlightOutbox.action, inFlightOutbox.aggregateId,
    inFlightOutbox.idempotencyKey, inFlightOutbox.status, '{}', JSON.stringify(inFlightOutbox), at, at,
  );
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'].replace(/^Bearer /, '') : '';
    void handleProcurementExecutionRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(token), connectorReady: (channel) => channel === 'erp',
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = signSession({ username: 'buyer', tenantId: 'tenant:edit', humanId: 'human:buyer', name: 'Buyer', role: '采购专员', expiresAt: Date.now() + 60_000 });
  const tenantOther = signSession({ username: 'other', tenantId: 'tenant:other', humanId: 'human:other', name: 'Other', role: '采购专员', expiresAt: Date.now() + 60_000 });
  const request = async (token: string, key: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/procurement/execution/edit_po`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const localBody = {
    aggregateId: localDraft.id, expectedVersion: 1,
    patch: {
      supplierId: replacementSupplier.id, contactId: `${replacementSupplier.id}:contact`, requiredInHouseAt: '2026-10-01', materialType: 'direct',
      lines: [{ id: localLine.id, itemCode: 'NEW-CODE', description: '新物料', quantity: 4, unit: 'BOX', unitPrice: 12.5, taxRate: 0.06 }],
    }, reason: '变更供应商与采购行，已完成内部复核',
  };
  try {
    const localEdit = await request(buyer, 'edit-po:local:1', localBody);
    assert.equal(localEdit.status, 201, JSON.stringify(localEdit.body));
    assert.equal(localEdit.body['aggregate']['version'], 2);
    assert.equal(localEdit.body['aggregate']['document']['supplierId'], replacementSupplier.id);
    assert.equal(localEdit.body['aggregate']['document']['requiredInHouseAt'], '2026-10-01T00:00:00.000Z');
    assert.equal(localEdit.body['createdLines'][0]['itemId'], 'NEW-CODE');
    assert.equal(localEdit.body['createdLines'][0]['orderedQty'], 4);
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', localDraft.id)?.version, 2);
    assert.equal(repository.listLines<PurchaseOrderLine>('purchase_order_line', localDraft.id)[0]?.uom, 'BOX');
    const localEditActivity = store.db.prepare(`SELECT json FROM runtime_activities WHERE tenant_id=? AND object_id=? AND json_extract(json,'$.action')='purchase_order.edited'`)
      .get('tenant:edit', localDraft.id) as { json: string } | undefined;
    const localEditContext = JSON.parse(localEditActivity!.json).context as Record<string, unknown>;
    assert.equal(localEditContext['changedSupplier'], true);
    assert.equal(localEditContext['changedContact'], true);
    assert.equal(localEditContext['changedRihd'], true);
    assert.deepEqual(localEditContext['changedLineIds'], [localLine.id]);
    assert.notEqual(localEditContext['beforeHash'], localEditContext['afterHash'], 'line state participates in the audit hash');
    assert.equal((await request(buyer, 'edit-po:local:1', localBody)).status, 200, 'same edit key replays the first atomic result');
    const versionConflict = await request(buyer, 'edit-po:local:stale', { ...localBody, expectedVersion: 1 });
    assert.equal(versionConflict.status, 409); assert.equal(versionConflict.body['currentVersion'], 2);

    const amendmentBody = { ...localBody, aggregateId: odooPo.id, expectedVersion: 1, patch: { requiredInHouseAt: '2026-10-05' } };
    const amendment = await request(buyer, 'edit-po:odoo:match', amendmentBody);
    assert.equal(amendment.status, 201, JSON.stringify(amendment.body));
    assert.equal(amendment.body['outbox']['status'], 'pending');
    assert.equal(amendment.body['amendment']['state'], 'queued');
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', odooPo.id)?.version, 1, 'Odoo projection waits for readback');
    const claimed = repository.claimOutboxMessages({ workerId: 'fake-odoo', claimedAt: at, leaseDurationMs: 60_000, channel: 'erp', limit: 1 })[0]!;
    repository.completeOutboxMessage({ id: claimed.id, leaseToken: claimed.leaseToken!, completedAt: '2026-08-21T00:00:01.000Z', connectorResult: { readbackMatches: true, receiptReference: 'fake-odoo:match' } });
    const appliedAmendment = store.db.prepare(`SELECT state FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?`).get('tenant:edit', amendment.body['amendment']['id']) as { state: string } | undefined;
    assert.equal(appliedAmendment?.state, 'applied');
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', odooPo.id)?.version, 2, 'matching readback advances the authoritative projection');
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', odooPo.id)?.document.requiredInHouseAt, '2026-10-05T00:00:00.000Z');

    const unknown = await request(buyer, 'edit-po:odoo:mismatch', { ...amendmentBody, expectedVersion: 2, patch: { requiredInHouseAt: '2026-10-06' } });
    const claimedUnknown = repository.claimOutboxMessages({ workerId: 'fake-odoo', claimedAt: '2026-08-21T00:00:02.000Z', leaseDurationMs: 60_000, channel: 'erp', limit: 1 })[0]!;
    repository.completeOutboxMessage({ id: claimedUnknown.id, leaseToken: claimedUnknown.leaseToken!, completedAt: '2026-08-21T00:00:03.000Z', connectorResult: { readbackMatches: false } });
    const unknownAmendment = store.db.prepare(`SELECT state FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?`).get('tenant:edit', unknown.body['amendment']['id']) as { state: string } | undefined;
    assert.equal(unknownAmendment?.state, 'unknown');
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', odooPo.id)?.version, 2, 'mismatched readback never overwrites the projection');

    const externalUnsupported = await request(buyer, 'edit-po:odoo:unsupported', { ...amendmentBody, expectedVersion: 2, patch: { materialType: 'indirect' } });
    assert.equal(externalUnsupported.status, 422, 'external edits reject fields without an authoritative Odoo write/readback mapping');
    const externalOutboxCount = store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=? AND aggregate_id=? AND action='purchase_order.amend'`)
      .get('tenant:edit', odooPo.id) as { count: number };
    assert.equal(externalOutboxCount.count, 2, 'unsupported external change is not queued');

    const mappedRihd = await request(buyer, 'edit-po:mapped-draft:rihd', {
      aggregateId: mappedDraft.id, expectedVersion: 1, reason: '已批准调整项目需求日期', patch: { requiredInHouseAt: '2026-10-08' },
    });
    assert.equal(mappedRihd.status, 201, JSON.stringify(mappedRihd.body));
    assert.equal(mappedRihd.body['amendment']?.['state'], 'queued', 'mapped Readywork Draft queues an Odoo amendment');
    assert.equal(mappedRihd.body['outbox']?.['action'], 'purchase_order.amend');
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', mappedDraft.id)?.version, 1, 'mapped projection remains unchanged before authoritative readback');
    const mappedWorker = new ProcurementOutboxWorker(store.db, () => ({
      execute: async () => ({ ok: false, error: 'legacy connector must not be used for mapped Odoo amendment' }),
      listCredentials: () => [], getCredential: () => undefined,
    }), {
      now: () => new Date(at),
      odooRuntimeResolver: { resolve: () => ({
        client: {
          updateETA: async () => ({ updated: 1, lines: 1 }),
          readPO: async () => ({ id: 82, name: 'P00082', lines: [{ id: 1, datePlanned: '2026-10-08 00:00:00' }] }),
        } as never,
        credential: { credentialId: 'credential:erp:mapped', credentialVersion: 'v1', lastTestedAt: at },
      }) },
    });
    assert.equal((await mappedWorker.runTenant('tenant:edit')).dispatched, 1);
    const mappedAmendment = store.db.prepare(`SELECT state FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?`)
      .get('tenant:edit', mappedRihd.body['amendment']?.['id']) as { state: string } | undefined;
    assert.equal(mappedAmendment?.state, 'applied');
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', mappedDraft.id)?.version, 2);
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', mappedDraft.id)?.document.requiredInHouseAt, '2026-10-08T00:00:00.000Z');

    assert.equal((await request(buyer, 'edit-po:mapped-draft', {
      aggregateId: mappedDraft.id, expectedVersion: 2, reason: '已完成供应商切换复核', patch: { supplierId: replacementSupplier.id, contactId: `${replacementSupplier.id}:contact` },
    })).status, 422, 'mapped Readywork Draft is not eligible for supplier replacement');
    assert.equal((await request(buyer, 'edit-po:in-flight', {
      aggregateId: inFlightDraft.id, expectedVersion: 1, reason: '已完成供应商切换复核', patch: { supplierId: replacementSupplier.id, contactId: `${replacementSupplier.id}:contact` },
    })).status, 422, 'active PO send prevents supplier replacement');
    assert.equal((await request(buyer, 'edit-po:contact-omitted', {
      aggregateId: contactDraft.id, expectedVersion: 1, reason: '已完成供应商切换复核', patch: { supplierId: replacementSupplier.id },
    })).status, 422, 'supplier replacement requires an explicit compatible contact decision');
    const activityCountBeforeNoOp = store.db.prepare('SELECT COUNT(*) AS count FROM runtime_activities WHERE tenant_id=? AND object_id=?')
      .get('tenant:edit', localDraft.id) as { count: number };
    assert.equal((await request(buyer, 'edit-po:no-op', {
      aggregateId: localDraft.id, expectedVersion: 2, reason: '重复提交不应写入审计', patch: { requiredInHouseAt: '2026-10-01T00:00:00.000Z' },
    })).status, 422, 'semantic no-op edit is rejected rather than audited as a change');
    const activityCountAfterNoOp = store.db.prepare('SELECT COUNT(*) AS count FROM runtime_activities WHERE tenant_id=? AND object_id=?')
      .get('tenant:edit', localDraft.id) as { count: number };
    assert.equal(activityCountAfterNoOp.count, activityCountBeforeNoOp.count);

    for (const [name, patch] of Object.entries({ stage: { stage: 'supplier_commitment' }, status: { status: 'received' }, route: { route: 'import' }, externalId: { externalId: 'forged' } })) {
      assert.equal((await request(buyer, `edit-po:reject:${name}`, { ...localBody, aggregateId: odooPo.id, patch })).status, 422);
    }
    assert.equal((await request(buyer, 'edit-po:reject:supplier-after-execution', { ...localBody, aggregateId: odooPo.id, expectedVersion: 2, patch: { supplierId: replacementSupplier.id } })).status, 422);
    assert.equal((await request(tenantOther, 'edit-po:cross-tenant', localBody)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('采购执行 API: Cancel PO 使用双权限、追加事实、阻断履约单据并按 Odoo readback 收敛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-cancel-po-api-'));
  const store = openPersistence(join(dir, 'test.db'), { tenantId: 'bootstrap' });
  const tenantId = 'tenant:cancel';
  const repository = createProcurementRepository(store.db, tenantId);
  const supplier: Supplier = {
    id: 'supplier:cancel', tenantId, sourceSystem: 'odoo', externalId: 'odoo-91', status: 'active', createdAt: at, updatedAt: at,
    name: '取消测试供应商', currency: 'CNY', contacts: [],
  };
  repository.saveDocument('supplier', supplier);
  const seedPo = (id: string, status = 'confirmed', external = false) => {
    const po = {
      id, tenantId, sourceSystem: external ? 'odoo' : 'readywork', externalId: external ? `purchase.order:${id.slice(-3)}` : `PO-${id}`,
      status, createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at,
      ...(external ? { number: `P${id.slice(-3).padStart(5, '0')}` } : {}),
    } as PurchaseOrder & { number?: string };
    const line: PurchaseOrderLine = {
      id: `line:${id}`, poId: id, lineNumber: '10', itemId: `item:${id}`, description: id, uom: 'EA', orderedQty: 5, unitPrice: 10, currency: 'CNY',
    };
    repository.saveDocument('purchase_order', po);
    repository.saveLine('purchase_order_line', po.id, line);
    return { po, line };
  };
  const local = seedPo('po:cancel:local');
  const shipped = seedPo('po:cancel:shipped', 'shipped');
  const withReceipt = seedPo('po:cancel:receipt');
  const withInvoice = seedPo('po:cancel:invoice');
  const external = seedPo('po:cancel:201', 'confirmed', true);
  const externalUnknown = seedPo('po:cancel:202', 'confirmed', true);
  const receipt: Receipt = {
    id: 'receipt:cancel', tenantId, sourceSystem: 'odoo', externalId: 'GRN-CANCEL', status: 'received', createdAt: at, updatedAt: at,
    poId: withReceipt.po.id, warehouseId: 'warehouse:1', receivedAt: at,
  };
  const invoice: SupplierInvoice = {
    id: 'invoice:cancel', tenantId, sourceSystem: 'odoo', externalId: 'BILL-CANCEL', status: 'posted', createdAt: at, updatedAt: at,
    supplierId: supplier.id, invoiceNumber: 'BILL-CANCEL', currency: 'CNY', invoiceDate: at,
  };
  const invoiceLine: SupplierInvoiceLine = {
    id: 'invoice-line:cancel', invoiceId: invoice.id, poLineId: withInvoice.line.id, lineNumber: '10', itemId: withInvoice.line.itemId,
    description: '已开票物料', uom: 'EA', invoicedQty: 1, unitPrice: 10, netAmount: 10, currency: 'CNY',
  };
  repository.saveDocument('receipt', receipt);
  repository.saveDocument('invoice', invoice);
  repository.saveLine('invoice_line', invoice.id, invoiceLine);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'].replace(/^Bearer /, '') : '';
    void handleProcurementExecutionRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(token), connectorReady: (channel) => channel === 'erp',
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manager = signSession({ username: 'manager', tenantId, humanId: 'human:manager', name: 'Manager', role: '采购经理', expiresAt: Date.now() + 60_000 });
  const buyer = signSession({ username: 'buyer', tenantId, humanId: 'human:buyer', name: 'Buyer', role: '采购专员', expiresAt: Date.now() + 60_000 });
  const otherTenant = signSession({ username: 'manager-other', tenantId: 'tenant:other', humanId: 'human:other', name: 'Other', role: '采购经理', expiresAt: Date.now() + 60_000 });
  const request = async (token: string, key: string, aggregateId: string, expectedVersion = 1, reason = '项目终止，已获采购经理批准') => {
    const response = await fetch(`${base}/api/procurement/execution/cancel_po`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ aggregateId, expectedVersion, reason }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  try {
    assert.equal((await request(buyer, 'cancel:buyer', local.po.id)).status, 403, 'operate without approve cannot cancel');
    assert.equal((await request(manager, 'cancel:missing-reason', local.po.id, 1, '')).status, 422);
    assert.equal((await request(otherTenant, 'cancel:other-tenant', local.po.id)).status, 404);

    const cancelled = await request(manager, 'cancel:local', local.po.id);
    assert.equal(cancelled.status, 201, JSON.stringify(cancelled.body));
    assert.deepEqual(Object.keys(cancelled.body).sort(), ['outboxId', 'purchaseOrderVersion', 'requestId', 'status']);
    assert.equal(cancelled.body['status'], 'cancelled');
    assert.equal(cancelled.body['purchaseOrderVersion'], 2);
    assert.equal(cancelled.body['outboxId'], null);
    assert.match(cancelled.body['requestId'], /^purchase-order-cancellation:/);
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', local.po.id)?.document.status, 'cancelled');
    assert.equal(repository.listLines<PurchaseOrderLine>('purchase_order_line', local.po.id).length, 1, 'cancellation never deletes PO lines');
    const cancellationEvent = store.db.prepare(`SELECT json FROM runtime_activities WHERE tenant_id=? AND object_id=? AND json_extract(json,'$.action')='purchase_order.cancelled'`)
      .get(tenantId, local.po.id) as { json: string } | undefined;
    assert.equal(JSON.parse(cancellationEvent!.json)['context']['reason'], '项目终止，已获采购经理批准');
    const replay = await request(manager, 'cancel:local', local.po.id);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, cancelled.body);
    const stale = await request(manager, 'cancel:local:stale', local.po.id, 1);
    assert.equal(stale.status, 409);
    assert.equal(stale.body['currentVersion'], 2);

    assert.equal((await request(manager, 'cancel:shipped', shipped.po.id)).status, 409);
    assert.equal((await request(manager, 'cancel:receipt', withReceipt.po.id)).status, 409);
    assert.equal((await request(manager, 'cancel:invoice', withInvoice.po.id)).status, 409);
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', withReceipt.po.id)?.document.status, 'confirmed');

    const pending = await request(manager, 'cancel:external', external.po.id);
    assert.equal(pending.status, 201, JSON.stringify(pending.body));
    assert.equal(pending.body['status'], 'pending_external');
    assert.equal(pending.body['purchaseOrderVersion'], 1, 'Odoo PO remains authoritative until readback');
    assert.equal(typeof pending.body['outboxId'], 'string');
    const claimed = repository.claimOutboxMessages({ workerId: 'fake-odoo', claimedAt: at, leaseDurationMs: 60_000, channel: 'erp', limit: 1 })[0]!;
    repository.completeOutboxMessage({ id: claimed.id, leaseToken: claimed.leaseToken!, completedAt: '2026-08-21T00:00:01.000Z', connectorResult: { readbackMatches: true, receiptReference: 'purchase.order:201' } });
    const reconciled = await request(manager, 'cancel:external', external.po.id);
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body['status'], 'cancelled');
    assert.equal(reconciled.body['purchaseOrderVersion'], 2);
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', external.po.id)?.document.status, 'cancelled');

    const pendingUnknown = await request(manager, 'cancel:external:unknown', externalUnknown.po.id);
    const claimedUnknown = repository.claimOutboxMessages({ workerId: 'fake-odoo', claimedAt: '2026-08-21T00:00:02.000Z', leaseDurationMs: 60_000, channel: 'erp', limit: 1 })[0]!;
    repository.failOutboxMessage({ id: claimedUnknown.id, leaseToken: claimedUnknown.leaseToken!, failedAt: '2026-08-21T00:00:03.000Z', error: 'network response lost', uncertain: true });
    assert.equal((await request(manager, 'cancel:external:unknown', externalUnknown.po.id)).body['status'], 'unknown');
    assert.equal((await request(manager, 'cancel:external:unknown:different', externalUnknown.po.id)).status, 409, 'unknown cancellation cannot be replayed under another identity');
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', externalUnknown.po.id)?.version, 1);
    assert.equal(typeof pendingUnknown.body['requestId'], 'string');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('采购执行 API: 空值、权限、幂等、租户与连接器 fail-closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-procurement-execution-api-'));
  const store = openPersistence(join(dir, 'test.db'), { tenantId: 'bootstrap' });
  for (const identityTenantId of ['tenant:a', 'tenant:b']) {
    store.db.prepare(`INSERT INTO procurement_communication_identities
      (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?, 'active',1,?,?,?,?)`).run(
      identityTenantId, '李娜', '高级采购专员', '东方制造有限公司',
      'human:manager', 'human:manager', at, at,
    );
  }
  const repository = createProcurementRepository(store.db, 'tenant:a');
  const primarySupplier: Supplier = {
    id: 'supplier:a', tenantId: 'tenant:a', sourceSystem: 'odoo', externalId: 'odoo-7', status: 'active',
    createdAt: at, updatedAt: at, name: '真实邮箱验收供应商', currency: 'CNY',
    contacts: [{ id: 'contact:a', name: '供应商联系人', email: 'supplier@supplysentry.invalid', primary: true }],
  };
  repository.saveDocument('supplier', primarySupplier);
  const po: PurchaseOrder = {
    id: 'po:api-execution', tenantId: 'tenant:a', sourceSystem: 'readywork', externalId: 'PO-API-EXECUTION', status: 'draft',
    createdAt: at, updatedAt: at, supplierId: 'supplier:a', currency: 'CNY', orderedAt: at,
  };
  const line: PurchaseOrderLine = {
    id: 'po-line:api-execution', poId: po.id, lineNumber: '10', itemId: 'item:a', uom: 'EA', orderedQty: 10, unitPrice: 5, currency: 'CNY',
  };
  repository.saveDocument('purchase_order', po);
  repository.saveLine('purchase_order_line', po.id, line);
  const odooSupplier: Supplier = { id: 'supplier:odoo-draft', tenantId: 'tenant:a', sourceSystem: 'odoo', externalId: 'odoo-8', status: 'active', createdAt: at, updatedAt: at, name: 'Odoo 供应商', currency: 'CNY', contacts: [] };
  const odooDraftPo: PurchaseOrder = { ...po, id: 'po:api-odoo-draft', externalId: 'PO-API-ODOO-DRAFT', supplierId: odooSupplier.id };
  const odooDraftLine: PurchaseOrderLine = { ...line, id: 'po-line:api-odoo-draft', poId: odooDraftPo.id, itemId: 'VALVE-1', description: '阀门', requestedAt: '2026-09-01T00:00:00.000Z' };
  repository.saveDocument('supplier', odooSupplier); repository.saveDocument('purchase_order', odooDraftPo); repository.saveLine('purchase_order_line', odooDraftPo.id, odooDraftLine);
  const rihdPo = {
    ...po, id: 'po:api-rihd', externalId: 'purchase.order:99', sourceSystem: 'odoo', status: 'confirmed', number: 'P00099',
    requiredInHouseAt: '2026-09-10T00:00:00.000Z', promisedAt: '2026-09-10T00:00:00.000Z',
  } as PurchaseOrder & { number: string };
  const rihdLine: PurchaseOrderLine = { ...line, id: 'po-line:api-rihd', poId: rihdPo.id, requestedAt: '2026-09-10T00:00:00.000Z' };
  repository.saveDocument('purchase_order', rihdPo); repository.saveLine('purchase_order_line', rihdPo.id, rihdLine);
  const deliveryPo: PurchaseOrder = { ...po, id: 'po:api-delivery', externalId: 'PO-API-DELIVERY', status: 'confirmed' };
  const deliveryLine: PurchaseOrderLine = { ...line, id: 'po-line:api-delivery', poId: deliveryPo.id };
  repository.saveDocument('purchase_order', deliveryPo);
  repository.saveLine('purchase_order_line', deliveryPo.id, deliveryLine);
  const productionPo: PurchaseOrder = { ...po, id: 'po:api-production', externalId: 'PO-API-PRODUCTION', status: 'confirmed' };
  const productionLineA: PurchaseOrderLine = { ...line, id: 'po-line:api-production-a', poId: productionPo.id, orderedQty: 10 };
  const productionLineB: PurchaseOrderLine = { ...line, id: 'po-line:api-production-b', poId: productionPo.id, lineNumber: '20', orderedQty: 4 };
  repository.saveDocument('purchase_order', productionPo);
  repository.saveLine('purchase_order_line', productionPo.id, productionLineA);
  repository.saveLine('purchase_order_line', productionPo.id, productionLineB);
  const confirmationPo: PurchaseOrder = { ...po, id: 'po:api-confirmation', externalId: 'PO-API-CONFIRMATION', status: 'confirmed' };
  const confirmationLine: PurchaseOrderLine = { ...line, id: 'po-line:api-confirmation', poId: confirmationPo.id, requestedAt: '2026-08-22T00:00:00.000Z' };
  const confirmationCommunication: Communication = {
    id: 'communication:api-confirmation', tenantId: 'tenant:a', sourceSystem: 'imap:test', externalId: '<supplier-confirmation@example.com>', status: 'received',
    createdAt: at, updatedAt: at, businessObjectId: confirmationPo.id, businessObjectType: 'purchase_order', supplierId: confirmationPo.supplierId,
    channel: 'email', direction: 'inbound', messageId: '<supplier-confirmation@example.com>', from: 'supplier@example.com', subject: 'Re: PO-API-CONFIRMATION',
    body: '确认先交 5 件，交期调整至 2026-08-25。', attachmentIds: [], occurredAt: at, receivedAt: at,
  };
  repository.saveDocument('purchase_order', confirmationPo);
  repository.saveLine('purchase_order_line', confirmationPo.id, confirmationLine);
  repository.saveDocument('communication', confirmationCommunication);
  const importPo: PurchaseOrder = { ...po, id: 'po:api-import-transit', externalId: 'PO-API-IMPORT-TRANSIT', status: 'shipped' };
  const importShipment: Shipment = {
    id: 'shipment:api-import-transit', tenantId: 'tenant:a', sourceSystem: 'odoo', externalId: 'ASN-IMPORT-001', status: 'shipped',
    createdAt: at, updatedAt: at, poId: importPo.id, supplierId: importPo.supplierId, shippedAt: at,
    carrier: 'DHL', trackingNumber: 'DHL-IMPORT-001',
  };
  repository.saveDocument('purchase_order', importPo);
  repository.saveDocument('shipment', importShipment);
  store.db.prepare(`INSERT INTO procurement_route_assignments
    (tenant_id,po_id,route,source,evidence_json,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,?,?,?)`).run('tenant:a', importPo.id, 'import', 'manual', JSON.stringify({ reason: 'Incoterm FOB，进口路线测试证据' }), 'human:manager', 'human:manager', at, at);
  // Same aggregate ID in another tenant verifies the in-flight guard is
  // tenant-scoped rather than globally scoped by PO ID.
  const tenantBRepository = createProcurementRepository(store.db, 'tenant:b');
  tenantBRepository.saveDocument('supplier', { ...primarySupplier, tenantId: 'tenant:b', externalId: 'odoo-7-b' });
  tenantBRepository.saveDocument('purchase_order', { ...po, tenantId: 'tenant:b', externalId: 'PO-API-EXECUTION-B' });
  tenantBRepository.saveLine('purchase_order_line', po.id, { ...line, id: 'po-line:api-execution-b' });
  const markRiskPo: PurchaseOrder = { ...po, id: 'po:api-mark-risk', externalId: 'PO-API-MARK-RISK', status: 'confirmed' };
  repository.saveDocument('purchase_order', markRiskPo);
  tenantBRepository.saveDocument('purchase_order', {
    ...markRiskPo, tenantId: 'tenant:b', externalId: 'PO-API-MARK-RISK-B',
  });
  let emailReady = false;
  let erpReady = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    void handleProcurementExecutionRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(token), connectorReady: (channel) => channel === 'email' ? emailReady : erpReady,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = signSession({ username: 'buyer', tenantId: 'tenant:a', humanId: 'human:buyer', name: 'Buyer', role: '采购专员', expiresAt: Date.now() + 60_000 });
  const manager = signSession({ username: 'manager', tenantId: 'tenant:a', humanId: 'human:manager', name: 'Manager', role: '采购经理', expiresAt: Date.now() + 60_000 });
  const auditor = signSession({ username: 'auditor', tenantId: 'tenant:a', humanId: 'human:auditor', name: 'Auditor', role: '审计员', expiresAt: Date.now() + 60_000 });
  const tenantB = signSession({ username: 'buyer-b', tenantId: 'tenant:b', humanId: 'human:b', name: 'B', role: '采购专员', expiresAt: Date.now() + 60_000 });

  async function request(path: string, options: { token?: string; key?: string; body?: Record<string, unknown>; method?: string } = {}) {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'POST', headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.key ? { 'idempotency-key': options.key } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      }, ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  try {
    const sendPath = '/api/procurement/execution/send_po';
    assert.equal((await request(sendPath, { key: 'no-auth', body: { aggregateId: po.id, expectedVersion: 1 } })).status, 401);
    assert.equal((await request(sendPath, { token: buyer, key: 'empty', body: {} })).status, 422);
    assert.equal((await request(sendPath, { token: buyer, key: 'null', body: { aggregateId: po.id, expectedVersion: null } })).status, 422);
    assert.equal((await request(sendPath, { token: buyer, key: 'forged', body: { aggregateId: po.id, expectedVersion: 1, tenantId: 'tenant:b' } })).status, 422);
    assert.equal((await request(sendPath, { token: buyer, key: 'forged-shortfall-disposition', body: { aggregateId: po.id, expectedVersion: 1, shortfallDisposition: 'cancel_remainder' } })).status, 422);
    assert.equal((await request(sendPath, { token: buyer, key: 'forged-confirmation-fields', body: { aggregateId: po.id, expectedVersion: 1, confirmationMissingFields: ['unit_price'] } })).status, 422);
    assert.equal((await request('/api/procurement/execution/decide_confirmation', { token: buyer, key: 'buyer-approve', body: { aggregateId: 'approval:x', expectedVersion: 1, decision: 'approved' } })).status, 403);

    const duplicatePoPath = '/api/procurement/execution/duplicate_po';
    const duplicatePoBody = {
      aggregateId: po.id,
      expectedVersion: 1,
      purchaseOrderNumber: 'PO-API-DUPLICATE-A',
      requiredInHouseAt: '2026-10-01',
      reason: '为新项目批次复制一张独立采购订单草稿',
    };
    assert.equal((await request(duplicatePoPath, { token: auditor, key: 'duplicate-po:auditor', body: duplicatePoBody })).status, 403);
    assert.equal((await request(duplicatePoPath, { token: buyer, key: 'duplicate-po:missing-number', body: { ...duplicatePoBody, purchaseOrderNumber: undefined } })).status, 422);
    assert.equal((await request(duplicatePoPath, { token: buyer, key: 'duplicate-po:missing-rihd', body: { ...duplicatePoBody, requiredInHouseAt: undefined } })).status, 422);
    assert.equal((await request(duplicatePoPath, { token: buyer, key: 'duplicate-po:forged-odoo', body: { ...duplicatePoBody, odooReference: { id: 9 } } })).status, 422);
    const duplicateNotFound = await request(duplicatePoPath, { token: buyer, key: 'duplicate-po:not-found', body: { ...duplicatePoBody, aggregateId: 'po:not-found' } });
    assert.equal(duplicateNotFound.status, 404); assert.equal(duplicateNotFound.body['code'], 'PO_NOT_FOUND');
    const duplicateVersionConflict = await request(duplicatePoPath, { token: buyer, key: 'duplicate-po:version', body: { ...duplicatePoBody, expectedVersion: 2 } });
    assert.equal(duplicateVersionConflict.status, 409); assert.equal(duplicateVersionConflict.body['code'], 'EXECUTION_VERSION_CONFLICT');
    const duplicatedPo = await request(duplicatePoPath, { token: buyer, key: 'duplicate-po:api:a:1', body: duplicatePoBody });
    assert.equal(duplicatedPo.status, 201, JSON.stringify(duplicatedPo.body));
    assert.equal(duplicatedPo.body['aggregate']['document']['id'], po.id);
    assert.equal(duplicatedPo.body['aggregate']['version'], 1);
    assert.equal(duplicatedPo.body['createdDocuments'][0]['status'], 'draft');
    assert.equal(duplicatedPo.body['createdDocuments'][0]['sourceSystem'], 'readywork');
    assert.equal(duplicatedPo.body['createdDocuments'][0]['externalId'], duplicatePoBody.purchaseOrderNumber);
    assert.equal(duplicatedPo.body['createdDocuments'][0]['duplicatedFrom']['purchaseOrderId'], po.id);
    assert.equal(duplicatedPo.body['createdLines'][0]['poId'], duplicatedPo.body['createdDocuments'][0]['id']);
    assert.notEqual(duplicatedPo.body['createdLines'][0]['id'], line.id);
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.version, 1, '源 PO 版本不得改变');
    const duplicateStage = store.db.prepare(`SELECT stage,event_type,state FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND event_type='draft_created_from_duplicate'`).get('tenant:a', duplicatedPo.body['createdDocuments'][0]['id']) as Record<string, unknown>;
    assert.deepEqual([duplicateStage['stage'], duplicateStage['event_type'], duplicateStage['state']], ['po_sent', 'draft_created_from_duplicate', 'active']);
    const duplicateReplay = await request(duplicatePoPath, { token: buyer, key: 'duplicate-po:api:a:1', body: duplicatePoBody });
    assert.equal(duplicateReplay.status, 200); assert.equal(duplicateReplay.body['replayed'], true);
    assert.equal(duplicateReplay.body['createdDocuments'][0]['id'], duplicatedPo.body['createdDocuments'][0]['id']);
    const duplicateIdempotencyConflict = await request(duplicatePoPath, { token: buyer, key: 'duplicate-po:api:a:1', body: { ...duplicatePoBody, reason: '改为其他业务原因' } });
    assert.equal(duplicateIdempotencyConflict.status, 409); assert.equal(duplicateIdempotencyConflict.body['code'], 'EXECUTION_IDEMPOTENCY_CONFLICT');
    const duplicateNumberConflict = await request(duplicatePoPath, { token: buyer, key: 'duplicate-po:api:a:2', body: duplicatePoBody });
    assert.equal(duplicateNumberConflict.status, 409); assert.equal(duplicateNumberConflict.body['code'], 'DUPLICATE_PO_NUMBER');
    const tenantBDuplicate = await request(duplicatePoPath, { token: tenantB, key: 'duplicate-po:api:b:1', body: duplicatePoBody });
    assert.equal(tenantBDuplicate.status, 201, JSON.stringify(tenantBDuplicate.body));
    assert.equal(tenantBDuplicate.body['createdDocuments'][0]['externalId'], duplicatePoBody.purchaseOrderNumber);

    const markRiskPath = '/api/procurement/execution/mark_at_risk';
    const markRiskBody = {
      aggregateId: markRiskPo.id, expectedVersion: 1, riskSeverity: 'high', riskCategory: 'schedule',
      reason: '供应商尚未确认关键交付节点', recommendedAction: '今日确认恢复计划并指定负责人',
    };
    const countRiskRows = (table: 'runtime_exceptions' | 'runtime_activities' | 'procurement_execution_idempotency') =>
      (store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id=?`).get('tenant:a') as { count: number }).count;
    const riskBaseline = [countRiskRows('runtime_exceptions'), countRiskRows('runtime_activities'), countRiskRows('procurement_execution_idempotency')];
    const forbiddenRisk = await request(markRiskPath, { token: auditor, key: 'mark-risk:auditor', body: markRiskBody });
    assert.equal(forbiddenRisk.status, 403); assert.equal(forbiddenRisk.body['code'], 'FORBIDDEN');
    const riskVersionConflict = await request(markRiskPath, { token: buyer, key: 'mark-risk:version-conflict', body: { ...markRiskBody, expectedVersion: 2 } });
    assert.equal(riskVersionConflict.status, 409); assert.equal(riskVersionConflict.body['code'], 'EXECUTION_VERSION_CONFLICT');
    const invalidRiskBodies: Array<[string, Record<string, unknown>]> = [
      ['severity', { ...markRiskBody, riskSeverity: 'low' }],
      ['category', { ...markRiskBody, riskCategory: 'inventory' }],
      ['reason', { ...markRiskBody, reason: '短' }],
      ['recommended-action', { ...markRiskBody, recommendedAction: '短' }],
      ['connector', { ...markRiskBody, connectorId: 'erp' }],
      ['status', { ...markRiskBody, status: 'received' }],
      ['connector-ready', { ...markRiskBody, connectorReady: true }],
    ];
    for (const [key, body] of invalidRiskBodies) {
      const invalid = await request(markRiskPath, { token: buyer, key: `mark-risk:invalid:${key}`, body });
      assert.equal(invalid.status, 422, `${key}: ${JSON.stringify(invalid.body)}`);
    }
    assert.deepEqual([countRiskRows('runtime_exceptions'), countRiskRows('runtime_activities'), countRiskRows('procurement_execution_idempotency')], riskBaseline, 'invalid marker requests must be atomic');
    const markedRisk = await request(markRiskPath, { token: buyer, key: 'mark-risk:api:1', body: markRiskBody });
    assert.equal(markedRisk.status, 201, JSON.stringify(markedRisk.body));
    assert.equal(markedRisk.body['aggregate']['version'], 1);
    assert.equal(markedRisk.body['aggregate']['document']['status'], 'confirmed');
    assert.equal(markedRisk.body['outbox'], undefined);
    assert.equal(markedRisk.body['exception']['type'], 'manual_purchase_order_risk');
    assert.equal(markedRisk.body['exception']['status'], 'assigned');
    assert.equal(markedRisk.body['exception']['context']['source'], 'human_mark_at_risk');
    const riskActivity = store.db.prepare(`SELECT json FROM runtime_activities WHERE tenant_id=? AND object_id=?`)
      .get('tenant:a', markRiskPo.id) as { json: string };
    assert.equal(JSON.parse(riskActivity.json)['action'], 'purchase_order.marked_at_risk');
    assert.equal(JSON.parse(riskActivity.json)['context']['exceptionId'], markedRisk.body['exception']['id']);
    assert.deepEqual([countRiskRows('runtime_exceptions'), countRiskRows('runtime_activities'), countRiskRows('procurement_execution_idempotency')], [riskBaseline[0]! + 1, riskBaseline[1]! + 1, riskBaseline[2]! + 1]);
    const riskReplay = await request(markRiskPath, { token: buyer, key: 'mark-risk:api:1', body: markRiskBody });
    assert.equal(riskReplay.status, 200); assert.equal(riskReplay.body['replayed'], true);
    const riskIdempotencyConflict = await request(markRiskPath, { token: buyer, key: 'mark-risk:api:1', body: { ...markRiskBody, riskSeverity: 'critical' } });
    assert.equal(riskIdempotencyConflict.status, 409); assert.equal(riskIdempotencyConflict.body['code'], 'EXECUTION_IDEMPOTENCY_CONFLICT');
    const riskDuplicate = await request(markRiskPath, { token: buyer, key: 'mark-risk:api:duplicate', body: markRiskBody });
    assert.equal(riskDuplicate.status, 409); assert.equal(riskDuplicate.body['code'], 'EXECUTION_STATE_CONFLICT');
    assert.deepEqual([countRiskRows('runtime_exceptions'), countRiskRows('runtime_activities'), countRiskRows('procurement_execution_idempotency')], [riskBaseline[0]! + 1, riskBaseline[1]! + 1, riskBaseline[2]! + 1]);
    assert.equal(store.db.prepare(`SELECT 1 FROM procurement_execution_idempotency WHERE tenant_id=? AND action='mark_at_risk' AND idempotency_key=?`)
      .get('tenant:a', 'mark-risk:api:duplicate'), undefined);
    const isolatedRisk = await request(markRiskPath, { token: tenantB, key: 'mark-risk:api:b:1', body: markRiskBody });
    assert.equal(isolatedRisk.status, 201, JSON.stringify(isolatedRisk.body));
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM runtime_exceptions WHERE tenant_id=?`).get('tenant:b') as { count: number }).count, 1);

    const clarificationPath = '/api/procurement/execution/queue_followup';
    const clarificationBody = {
      aggregateId: confirmationPo.id, expectedVersion: 1, connectorId: 'email',
      reason: '请补充确认单价', supplierReference: confirmationCommunication.id,
      confirmationMissingFields: ['unit_price'],
    };
    assert.equal((await request(clarificationPath, { token: buyer, key: 'clarification-unknown-field', body: {
      ...clarificationBody, confirmationMissingFields: ['payment_terms'],
    } })).status, 422);
    assert.equal((await request(clarificationPath, { token: buyer, key: 'clarification-wrong-mail', body: {
      ...clarificationBody, supplierReference: 'communication:not-current-po',
    } })).status, 422);
    assert.equal((await request(clarificationPath, { token: buyer, key: 'clarification-field-mismatch', body: {
      ...clarificationBody, confirmationMissingFields: ['quantity'],
    } })).status, 422);
    const clarification = await request(clarificationPath, { token: buyer, key: 'clarification-unit-price', body: clarificationBody });
    assert.equal(clarification.status, 201, JSON.stringify(clarification.body));
    assert.equal(clarification.body['aggregate']['document']['status'], 'confirmed');
    assert.equal(clarification.body['aggregate']['version'], 1);
    assert.equal(clarification.body['outbox'], undefined);
    assert.equal(clarification.body['messageDraft']['sourceCommunicationId'], confirmationCommunication.id);
    assert.deepEqual(clarification.body['messageDraft']['confirmationMissingFields'], ['unit_price']);
    const persistedClarification = store.db.prepare(`SELECT subject,trigger_evidence_json,status FROM procurement_message_drafts
      WHERE tenant_id=? AND id=?`).get('tenant:a', clarification.body['messageDraft']['id']) as Record<string, unknown>;
    assert.equal(persistedClarification['status'], 'draft');
    assert.match(String(persistedClarification['subject']), /确认单价/);
    assert.equal(JSON.parse(String(persistedClarification['trigger_evidence_json']))['sourceCommunicationId'], confirmationCommunication.id);
    const recordConfirmationPath = '/api/procurement/execution/record_confirmation';
    const confirmationBody = { aggregateId: confirmationPo.id, expectedVersion: 1, supplierReference: confirmationCommunication.id,
      lines: [{ poLineId: confirmationLine.id, quantity: 5, unitPrice: 5, promisedAt: '2026-08-25' }] };
    assert.equal((await request(recordConfirmationPath, { token: buyer, key: 'confirmation-missing-evidence', body: { ...confirmationBody, supplierReference: undefined } })).status, 422);
    assert.equal((await request(recordConfirmationPath, { token: buyer, key: 'confirmation-untrusted-evidence', body: { ...confirmationBody, supplierReference: 'communication:not-current-po' } })).status, 422);
    const recordedConfirmation = await request(recordConfirmationPath, { token: buyer, key: 'confirmation-valid-evidence', body: confirmationBody });
    assert.equal(recordedConfirmation.status, 201);
    assert.equal(recordedConfirmation.body['aggregate']['document']['status'], 'awaiting_confirmation');
    assert.equal(recordedConfirmation.body['approval']['status'], 'pending');
    assert.equal(recordedConfirmation.body['createdDocuments'][0]['supplierReference'], confirmationCommunication.id);
    const confirmationApprovalId = recordedConfirmation.body['approval']['id'] as string;
    const decideConfirmationPath = '/api/procurement/execution/decide_confirmation';
    const shortfallDecision = { aggregateId: confirmationApprovalId, expectedVersion: 2, decision: 'approved', reason: '需求已调整，关闭未确认余量' };
    assert.equal((await request(decideConfirmationPath, {
      token: manager, key: 'confirmation-shortfall-unknown-disposition', body: { ...shortfallDecision, shortfallDisposition: 'keep_open' },
    })).status, 422);
    assert.equal((await request(decideConfirmationPath, {
      token: manager, key: 'confirmation-shortfall-reject-with-disposition', body: { ...shortfallDecision, decision: 'rejected', shortfallDisposition: 'cancel_remainder' },
    })).status, 422);
    assert.equal((await request(decideConfirmationPath, {
      token: manager, key: 'confirmation-shortfall-missing-disposition', body: shortfallDecision,
    })).status, 422);
    assert.equal((await request(decideConfirmationPath, {
      token: manager, key: 'confirmation-shortfall-missing-reason', body: { ...shortfallDecision, reason: '   ', shortfallDisposition: 'cancel_remainder' },
    })).status, 422);
    const approvedShortfall = await request(decideConfirmationPath, {
      token: manager, key: 'confirmation-shortfall-approved', body: { ...shortfallDecision, shortfallDisposition: 'cancel_remainder' },
    });
    assert.equal(approvedShortfall.status, 201);
    assert.equal(approvedShortfall.body['approval']['shortfallDisposition'], 'cancel_remainder');
    const shortfallStage = store.db.prepare(`SELECT evidence_json FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND stage='supplier_commitment' AND event_type='confirmation_approved'`)
      .get('tenant:a', confirmationPo.id) as { evidence_json: string };
    assert.equal(JSON.parse(shortfallStage.evidence_json)['shortfallDisposition'], 'cancel_remainder');
    const createOdooDraftPath = '/api/procurement/execution/create_odoo_po_draft';
    assert.equal((await request(createOdooDraftPath, { token: buyer, key: 'buyer-odoo-draft', body: { aggregateId: odooDraftPo.id, expectedVersion: 1, connectorId: 'erp' } })).status, 403);
    assert.equal((await request(createOdooDraftPath, { token: manager, key: 'reject-client-mapping', body: { aggregateId: odooDraftPo.id, expectedVersion: 1, connectorId: 'erp', partnerId: 8 } })).status, 422);
    const blockedOdooDraft = await request(createOdooDraftPath, { token: manager, key: 'blocked-odoo-draft', body: { aggregateId: odooDraftPo.id, expectedVersion: 1, connectorId: 'erp' } });
    assert.equal(blockedOdooDraft.status, 201); assert.equal(blockedOdooDraft.body['outbox']['action'], 'purchase_order.create_draft'); assert.equal(blockedOdooDraft.body['outbox']['status'], 'blocked');
    const blockedOdooReplay = await request(createOdooDraftPath, { token: manager, key: 'blocked-odoo-draft', body: { aggregateId: odooDraftPo.id, expectedVersion: 1, connectorId: 'erp' } });
    assert.equal(blockedOdooReplay.status, 200); assert.equal(blockedOdooReplay.body['replayed'], true);
    const updateRihdPath = '/api/procurement/execution/update_rihd';
    const updateRihdBody = { aggregateId: rihdPo.id, expectedVersion: 1, connectorId: 'erp', requiredInHouseAt: '2026-09-30', reason: '项目需求日已批准调整' };
    assert.equal((await request(updateRihdPath, { token: buyer, key: 'buyer-rihd', body: updateRihdBody })).status, 403);
    assert.equal((await request(updateRihdPath, { token: manager, key: 'rihd-client-forged', body: { ...updateRihdBody, poNumber: 'P00999' } })).status, 422);
    assert.equal((await request(updateRihdPath, { token: manager, key: 'rihd-wrong-connector', body: { ...updateRihdBody, connectorId: 'email' } })).status, 422);
    const blockedRihd = await request(updateRihdPath, { token: manager, key: 'rihd-blocked', body: updateRihdBody });
    assert.equal(blockedRihd.status, 201, JSON.stringify(blockedRihd.body));
    assert.equal(blockedRihd.body['outbox']['action'], 'purchase_order.update_rihd');
    assert.equal(blockedRihd.body['outbox']['status'], 'blocked');
    assert.equal(blockedRihd.body['outbox']['payload']['odooMapping']['poNumber'], 'P00099');
    assert.equal(blockedRihd.body['aggregate']['document']['requiredInHouseAt'], '2026-09-10T00:00:00.000Z');
    const blockedRihdReplay = await request(updateRihdPath, { token: manager, key: 'rihd-blocked', body: updateRihdBody });
    assert.equal(blockedRihdReplay.status, 200); assert.equal(blockedRihdReplay.body['replayed'], true);

    const blockedBody = { aggregateId: po.id, expectedVersion: 1, connectorId: 'email' };
    const [blocked, concurrentReplay] = await Promise.all([
      request(sendPath, { token: buyer, key: 'blocked', body: blockedBody }),
      request(sendPath, { token: buyer, key: 'blocked', body: blockedBody }),
    ]);
    assert.deepEqual([blocked.status, concurrentReplay.status].sort(), [200, 201]);
    assert.equal(blocked.body['aggregate']['document']['status'], 'draft');
    assert.equal(blocked.body['outbox']['status'], 'blocked');
    const replay = await request(sendPath, { token: buyer, key: 'blocked', body: blockedBody });
    assert.equal(replay.status, 200); assert.equal(replay.body['replayed'], true);
    const conflict = await request(sendPath, { token: buyer, key: 'blocked', body: { ...blockedBody, expectedVersion: 2 } });
    assert.equal(conflict.status, 409); assert.equal(conflict.body['code'], 'EXECUTION_IDEMPOTENCY_CONFLICT');

    // A blocked message was never handed to the connector, so a new operator
    // idempotency key may create a retry candidate.
    const blockedRetry = await request(sendPath, { token: buyer, key: 'blocked-retry', body: blockedBody });
    assert.equal(blockedRetry.status, 201); assert.equal(blockedRetry.body['outbox']['status'], 'blocked');

    emailReady = true;
    // Distinct keys racing while the PO is draft create exactly one active
    // send. The repository transaction serializes the check and insert.
    const [firstPending, duplicatePending] = await Promise.all([
      request(sendPath, { token: buyer, key: 'ready-one', body: blockedBody }),
      request(sendPath, { token: buyer, key: 'ready-two', body: blockedBody }),
    ]);
    assert.deepEqual([firstPending.status, duplicatePending.status].sort(), [201, 409]);
    const pending = firstPending.status === 201 ? firstPending : duplicatePending;
    assert.equal(pending.body['aggregate']['document']['status'], 'draft');
    assert.equal(pending.body['outbox']['status'], 'pending');
    const crossTenant = await request(sendPath, { token: tenantB, key: 'tenant-b-ready', body: blockedBody });
    assert.equal(crossTenant.status, 201, 'tenant B must not be blocked by tenant A PO activity');

    const claimed = repository.claimOutboxMessages({
      workerId: 'worker:email', claimedAt: at, leaseDurationMs: 60_000, channel: 'email', limit: 1,
    })[0]!;
    repository.failOutboxMessage({
      id: claimed.id, leaseToken: claimed.leaseToken!, failedAt: '2026-08-21T00:00:01.000Z', error: 'mailbox rejected before delivery',
    });
    // Terminal failed rows are also safe to retry using a fresh key.
    const failedRetry = await request(sendPath, { token: buyer, key: 'failed-retry', body: blockedBody });
    assert.equal(failedRetry.status, 201); assert.equal(failedRetry.body['outbox']['status'], 'pending');
    const retriedClaim = repository.claimOutboxMessages({
      workerId: 'worker:email', claimedAt: '2026-08-21T00:00:02.000Z', leaseDurationMs: 60_000, channel: 'email', limit: 1,
    })[0]!;
    repository.completeOutboxMessage({
      id: retriedClaim.id, leaseToken: retriedClaim.leaseToken!, completedAt: '2026-08-21T00:00:03.000Z',
    });
    // Once delivery is confirmed, the PO state transition is the durable
    // refresh guard; even a fresh HTTP idempotency key cannot enqueue again.
    const afterDispatch = await request(sendPath, { token: buyer, key: 'after-dispatch', body: { ...blockedBody, expectedVersion: 2 } });
    assert.equal(afterDispatch.status, 409); assert.equal(afterDispatch.body['code'], 'EXECUTION_STATE_CONFLICT');
    const duplicateLines = await request('/api/procurement/execution/record_shipment', {
      token: manager, key: 'duplicate-lines', body: { aggregateId: po.id, expectedVersion: 2, supplierReference: 'ASN-DUP-LINES', evidenceReference: 'mail:duplicate-lines', reason: '已核对供应商邮件', lines: [
        { poLineId: line.id, quantity: 1 }, { poLineId: line.id, quantity: 1 },
      ] },
    });
    assert.equal(duplicateLines.status, 422);

    const buyerCannotVerifyShipment = await request('/api/procurement/execution/record_shipment', {
      token: buyer, key: 'buyer-cannot-verify-shipment', body: { aggregateId: deliveryPo.id, expectedVersion: 1, supplierReference: 'ASN-NO-PERMISSION', evidenceReference: 'mail:no-permission', reason: '尝试人工核验', lines: [{ poLineId: deliveryLine.id, quantity: 1 }] },
    });
    assert.equal(buyerCannotVerifyShipment.status, 403);
    const missingVerification = await request('/api/procurement/execution/record_shipment', {
      token: manager, key: 'missing-verification', body: { aggregateId: deliveryPo.id, expectedVersion: 1, supplierReference: 'ASN-MISSING-EVIDENCE', lines: [{ poLineId: deliveryLine.id, quantity: 1 }] },
    });
    assert.equal(missingVerification.status, 422);
    const invalidEta = await request('/api/procurement/execution/record_shipment', {
      token: manager, key: 'invalid-shipment-eta', body: { aggregateId: deliveryPo.id, expectedVersion: 1, supplierReference: 'ASN-INVALID-ETA', evidenceReference: 'mail:invalid-eta', reason: '核验 ETA 输入', estimatedArrivalAt: 'not-a-date', lines: [{ poLineId: deliveryLine.id, quantity: 1 }] },
    });
    assert.equal(invalidEta.status, 422);

    const productionPath = '/api/procurement/execution/record_production_progress';
    const buyerCannotVerifyProduction = await request(productionPath, {
      token: buyer, key: 'buyer-cannot-verify-production', body: { aggregateId: productionPo.id, expectedVersion: 1,
        supplierReference: 'PROGRESS-NO-PERMISSION', evidenceReference: 'mail:progress-no-permission', reason: '尝试人工核验',
        lines: [{ poLineId: productionLineA.id, quantity: 2, completionPercent: 20, progressStatus: 'in_production' }] },
    });
    assert.equal(buyerCannotVerifyProduction.status, 403);
    const productionMissingEvidence = await request(productionPath, {
      token: manager, key: 'production-missing-evidence', body: { aggregateId: productionPo.id, expectedVersion: 1,
        supplierReference: 'PROGRESS-MISSING-EVIDENCE', lines: [{ poLineId: productionLineA.id, quantity: 2, completionPercent: 20, progressStatus: 'in_production' }] },
    });
    assert.equal(productionMissingEvidence.status, 422);
    const invalidProductionPercent = await request(productionPath, {
      token: manager, key: 'production-invalid-percent', body: { aggregateId: productionPo.id, expectedVersion: 1,
        supplierReference: 'PROGRESS-INVALID-PERCENT', evidenceReference: 'mail:invalid-percent', reason: '核验异常百分比',
        lines: [{ poLineId: productionLineA.id, quantity: 2, completionPercent: 120, progressStatus: 'in_production' }] },
    });
    assert.equal(invalidProductionPercent.status, 422);
    const delayedWithoutNote = await request(productionPath, {
      token: manager, key: 'production-delayed-without-note', body: { aggregateId: productionPo.id, expectedVersion: 1,
        supplierReference: 'PROGRESS-DELAY-NO-NOTE', evidenceReference: 'mail:delay-no-note', reason: '核验延期状态',
        lines: [{ poLineId: productionLineA.id, quantity: 2, completionPercent: 20, progressStatus: 'delayed' }] },
    });
    assert.equal(delayedWithoutNote.status, 422);
    const firstProgressBody = { aggregateId: productionPo.id, expectedVersion: 1, supplierReference: 'PROGRESS-001',
      evidenceReference: 'mail:<progress-001@example.com>', reason: '已核对供应商周报附件',
      lines: [{ poLineId: productionLineA.id, quantity: 5, completionPercent: 50, progressStatus: 'in_production', expectedReadyAt: '2026-08-26T16:00:00+08:00' }] };
    const firstProgress = await request(productionPath, { token: manager, key: 'production-progress-001', body: firstProgressBody });
    assert.equal(firstProgress.status, 201); assert.equal(firstProgress.body['aggregate']['document']['status'], 'in_production');
    assert.equal(firstProgress.body['createdDocuments'][0]['overallStatus'], 'in_production');
    assert.equal(firstProgress.body['createdDocuments'][0]['evidenceSource'], 'manual_verified');
    assert.equal(firstProgress.body['createdLines'][0]['expectedReadyAt'], '2026-08-26T08:00:00.000Z');
    const firstProgressReplay = await request(productionPath, { token: manager, key: 'production-progress-001', body: firstProgressBody });
    assert.equal(firstProgressReplay.status, 200); assert.equal(firstProgressReplay.body['replayed'], true);
    const duplicateProgressReference = await request(productionPath, { token: manager, key: 'production-progress-duplicate-reference', body: { ...firstProgressBody, expectedVersion: 2 } });
    assert.equal(duplicateProgressReference.status, 422);
    const delayedProgress = await request(productionPath, { token: manager, key: 'production-progress-delayed', body: {
      aggregateId: productionPo.id, expectedVersion: 2, supplierReference: 'PROGRESS-002', evidenceReference: 'meeting:progress-002', reason: '已核对供应商生产会议纪要',
      lines: [{ poLineId: productionLineB.id, quantity: 1, completionPercent: 25, progressStatus: 'delayed', expectedReadyAt: '2026-08-28T00:00:00.000Z', note: '关键原料晚到两天' }],
    } });
    assert.equal(delayedProgress.status, 201); assert.equal(delayedProgress.body['aggregate']['version'], 3);
    const delayedStage = store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND source_id=?`).get('tenant:a', delayedProgress.body['createdDocuments'][0]['id']) as { state: string };
    assert.equal(delayedStage.state, 'blocked');
    const readyLineA = await request(productionPath, { token: manager, key: 'production-ready-a', body: {
      aggregateId: productionPo.id, expectedVersion: 3, supplierReference: 'PROGRESS-003', evidenceReference: 'mail:progress-003', reason: '已核对第一行完工报告',
      lines: [{ poLineId: productionLineA.id, quantity: 10, completionPercent: 100, progressStatus: 'ready_to_ship' }],
    } });
    assert.equal(readyLineA.status, 201); assert.equal(readyLineA.body['aggregate']['document']['status'], 'in_production');
    const readyLineB = await request(productionPath, { token: manager, key: 'production-ready-b', body: {
      aggregateId: productionPo.id, expectedVersion: 4, supplierReference: 'PROGRESS-004', evidenceReference: 'attachment:progress-004.pdf', reason: '已核对第二行完工及质检报告',
      lines: [{ poLineId: productionLineB.id, quantity: 4, completionPercent: 100, progressStatus: 'ready_to_ship' }],
    } });
    assert.equal(readyLineB.status, 201); assert.equal(readyLineB.body['aggregate']['document']['status'], 'awaiting_shipment');
    const productionCompleted = store.db.prepare(`SELECT state,evidence_json FROM procurement_po_stage_events WHERE tenant_id=? AND source_id=?`).get('tenant:a', readyLineB.body['createdDocuments'][0]['id']) as { state: string; evidence_json: string };
    assert.equal(productionCompleted.state, 'completed'); assert.equal(JSON.parse(productionCompleted.evidence_json)['allLinesReadyToShip'], true);

    const partialShipment = await request('/api/procurement/execution/record_shipment', {
      token: manager, key: 'api-shipment-6', body: { aggregateId: deliveryPo.id, expectedVersion: 1, supplierReference: 'ASN-API-001', evidenceReference: 'mail:<asn-api-001@example.com>', reason: '采购经理已核对供应商 ASN 附件', carrier: '顺丰', trackingNumber: 'SF-001', estimatedArrivalAt: '2026-08-25T08:30:00+08:00', lines: [{ poLineId: deliveryLine.id, quantity: 6 }] },
    });
    assert.equal(partialShipment.status, 201); assert.equal(partialShipment.body['aggregate']['document']['status'], 'partially_shipped');
    assert.equal(partialShipment.body['createdDocuments'][0]['externalId'], 'ASN-API-001');
    assert.equal(partialShipment.body['createdDocuments'][0]['sourceSystem'], 'readywork-manual-verification');
    assert.equal(partialShipment.body['createdDocuments'][0]['evidenceSource'], 'manual_verified');
    assert.equal(partialShipment.body['createdDocuments'][0]['verifiedBy'], 'human:manager');
    assert.equal(partialShipment.body['createdDocuments'][0]['estimatedArrivalAt'], '2026-08-25T00:30:00.000Z');
    const etaStageEvidence = store.db.prepare(`SELECT evidence_json FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND source_id=? ORDER BY rowid`).all('tenant:a', deliveryPo.id, partialShipment.body['createdDocuments'][0]['id']) as Array<{ evidence_json: string }>;
    assert.equal(etaStageEvidence.length, 2);
    assert.ok(etaStageEvidence.every((event) => JSON.parse(event.evidence_json)['estimatedArrivalAt'] === '2026-08-25T00:30:00.000Z'));
    const shipmentReplay = await request('/api/procurement/execution/record_shipment', {
      token: manager, key: 'api-shipment-6', body: { aggregateId: deliveryPo.id, expectedVersion: 1, supplierReference: 'ASN-API-001', evidenceReference: 'mail:<asn-api-001@example.com>', reason: '采购经理已核对供应商 ASN 附件', carrier: '顺丰', trackingNumber: 'SF-001', estimatedArrivalAt: '2026-08-25T08:30:00+08:00', lines: [{ poLineId: deliveryLine.id, quantity: 6 }] },
    });
    assert.equal(shipmentReplay.status, 200); assert.equal(shipmentReplay.body['replayed'], true);
    const duplicateShipmentReference = await request('/api/procurement/execution/record_shipment', {
      token: manager, key: 'api-shipment-duplicate-reference', body: { aggregateId: deliveryPo.id, expectedVersion: 2, supplierReference: 'ASN-API-001', evidenceReference: 'mail:<asn-duplicate@example.com>', reason: '核对重复 ASN', lines: [{ poLineId: deliveryLine.id, quantity: 1 }] },
    });
    assert.equal(duplicateShipmentReference.status, 422);
    const finalShipment = await request('/api/procurement/execution/record_shipment', {
      token: manager, key: 'api-shipment-4', body: { aggregateId: deliveryPo.id, expectedVersion: 2, supplierReference: 'ASN-API-002', evidenceReference: 'attachment:asn-api-002.pdf', reason: '已核对第二批 ASN 附件', lines: [{ poLineId: deliveryLine.id, quantity: 4 }] },
    });
    assert.equal(finalShipment.status, 201); assert.equal(finalShipment.body['aggregate']['document']['status'], 'shipped');
    const transportBody = { aggregateId: deliveryPo.id, expectedVersion: 3, shipmentId: partialShipment.body['createdDocuments'][0]['id'], eventCode: 'picked_up', eventOccurredAt: '2026-08-21T08:00:00.000Z', eventReference: 'TRACK-EVT-API-001', location: '上海集货仓', carrierReference: 'SF-EVT-001', estimatedArrivalAt: '2026-09-02T08:00:00+08:00', evidenceReference: 'carrier:sf:event:001', reason: '采购经理已核对承运商轨迹页面' };
    const buyerCannotVerifyTransport = await request('/api/procurement/execution/record_transport_event', {
      token: buyer, key: 'buyer-cannot-verify-transport', body: transportBody,
    });
    assert.equal(buyerCannotVerifyTransport.status, 403);
    const futureTransport = await request('/api/procurement/execution/record_transport_event', {
      token: manager, key: 'future-transport-event', body: { ...transportBody, eventReference: 'TRACK-EVT-FUTURE', eventOccurredAt: '2999-01-01T00:00:00.000Z' },
    });
    assert.equal(futureTransport.status, 422);
    const customsWithoutImportRoute = await request('/api/procurement/execution/record_transport_event', {
      token: manager, key: 'customs-without-import-route', body: { ...transportBody, eventReference: 'TRACK-EVT-CUSTOMS-NO-ROUTE', eventCode: 'customs_submitted' },
    });
    assert.equal(customsWithoutImportRoute.status, 422);
    const transportEvent = await request('/api/procurement/execution/record_transport_event', {
      token: manager, key: 'transport-event-001', body: transportBody,
    });
    assert.equal(transportEvent.status, 201);
    assert.equal(transportEvent.body['createdDocuments'][0]['eventCode'], 'picked_up');
    assert.equal(transportEvent.body['createdDocuments'][0]['estimatedArrivalAt'], '2026-09-02T00:00:00.000Z');
    assert.equal(transportEvent.body['createdDocuments'][0]['evidenceSource'], 'manual_verified');
    assert.equal(transportEvent.body['aggregate']['version'], 4);
    const transportStage = store.db.prepare(`SELECT state,evidence_json FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND source_id=?`).get('tenant:a', deliveryPo.id, transportEvent.body['createdDocuments'][0]['id']) as { state: string; evidence_json: string };
    assert.equal(transportStage.state, 'active');
    assert.equal(JSON.parse(transportStage.evidence_json)['eventCode'], 'picked_up');
    const transportReplay = await request('/api/procurement/execution/record_transport_event', {
      token: manager, key: 'transport-event-001', body: transportBody,
    });
    assert.equal(transportReplay.status, 200); assert.equal(transportReplay.body['replayed'], true);
    const duplicateTransportReference = await request('/api/procurement/execution/record_transport_event', {
      token: manager, key: 'transport-event-duplicate-reference', body: { ...transportBody, expectedVersion: 4 },
    });
    assert.equal(duplicateTransportReference.status, 422);
    const customsHeld = await request('/api/procurement/execution/record_transport_event', {
      token: manager, key: 'import-customs-held', body: { aggregateId: importPo.id, expectedVersion: 1, shipmentId: importShipment.id, eventCode: 'customs_held', eventOccurredAt: '2026-08-22T02:00:00.000Z', eventReference: 'CUSTOMS-EVT-HELD-001', location: '上海海关', carrierReference: 'CUS-HOLD-001', evidenceReference: 'customs:notice:hold-001', reason: '已核对海关查验通知' },
    });
    assert.equal(customsHeld.status, 201); assert.equal(customsHeld.body['aggregate']['version'], 2);
    const heldStage = store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND source_id=?`)
      .get('tenant:a', customsHeld.body['createdDocuments'][0]['id']) as { state: string };
    assert.equal(heldStage.state, 'blocked');
    const customsCleared = await request('/api/procurement/execution/record_transport_event', {
      token: manager, key: 'import-customs-cleared', body: { aggregateId: importPo.id, expectedVersion: 2, shipmentId: importShipment.id, eventCode: 'customs_cleared', eventOccurredAt: '2026-08-23T03:00:00.000Z', eventReference: 'CUSTOMS-EVT-CLEARED-001', location: '上海海关', carrierReference: 'CUS-CLEAR-001', estimatedArrivalAt: '2026-09-03T12:00:00+08:00', evidenceReference: 'customs:release:001', reason: '已核对海关放行通知' },
    });
    assert.equal(customsCleared.status, 201); assert.equal(customsCleared.body['aggregate']['version'], 3);
    const clearedStage = store.db.prepare(`SELECT state,evidence_json FROM procurement_po_stage_events WHERE tenant_id=? AND source_id=?`)
      .get('tenant:a', customsCleared.body['createdDocuments'][0]['id']) as { state: string; evidence_json: string };
    assert.equal(clearedStage.state, 'active');
    assert.equal(JSON.parse(clearedStage.evidence_json)['eventCode'], 'customs_cleared');
    const partialReceipt = await request('/api/procurement/execution/record_receipt', {
      token: manager, key: 'api-receipt-5', body: { aggregateId: deliveryPo.id, expectedVersion: 4, supplierReference: 'GRN-API-001', evidenceReference: 'odoo:stock.picking:501', reason: '已核对 Odoo 收货单 501', warehouseId: 'WH-API', lines: [{ poLineId: deliveryLine.id, quantity: 5 }] },
    });
    assert.equal(partialReceipt.status, 201); assert.equal(partialReceipt.body['aggregate']['document']['status'], 'partially_received');
    assert.equal(partialReceipt.body['createdDocuments'][0]['externalId'], 'GRN-API-001');
    assert.equal(partialReceipt.body['createdDocuments'][0]['sourceSystem'], 'readywork-manual-verification');
    const finalReceipt = await request('/api/procurement/execution/record_receipt', {
      token: manager, key: 'api-receipt-5-final', body: { aggregateId: deliveryPo.id, expectedVersion: 5, supplierReference: 'GRN-API-002', evidenceReference: 'warehouse:signoff:GRN-API-002', reason: '已核对仓库签收凭证', warehouseId: 'WH-API', lines: [{ poLineId: deliveryLine.id, quantity: 5 }] },
    });
    assert.equal(finalReceipt.status, 201); assert.equal(finalReceipt.body['aggregate']['document']['status'], 'received');
    const deliveryProjection = repository.getPurchaseOrderLineQuantityProjection(deliveryLine.id)!;
    assert.equal(deliveryProjection.orderedQty, 10); assert.equal(deliveryProjection.shippedQty, 10); assert.equal(deliveryProjection.receivedQty, 10);
    assert.equal(deliveryProjection.events.length, 4); assert.equal(deliveryProjection.appliedEventKeys.length, 4);
    const completedStages = store.db.prepare(`SELECT stage,state FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND state='completed' ORDER BY rowid`).all('tenant:a', deliveryPo.id) as Array<{ stage: string; state: string }>;
    assert.ok(completedStages.some((event) => event.stage === 'dispatch_transit'));
    assert.ok(completedStages.some((event) => event.stage === 'delivery_grn'));
    const outbox = await request('/api/procurement/execution/outbox', { token: manager, method: 'GET' });
    assert.equal(outbox.status, 200); assert.equal(outbox.body['items'].length, 6);
    assert.ok(outbox.body['items'].some((item: Record<string, unknown>) => item['action'] === 'purchase_order.update_rihd'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
