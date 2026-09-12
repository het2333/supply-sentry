import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type {
  Award,
  Communication,
  Item,
  LineMatchResult,
  ProcurementRequisition,
  PurchaseOrder,
  PurchaseOrderConfirmationLine,
  PurchaseOrderLine,
  PurchaseOrderLineQuantityEvent,
  QuoteComparisonSnapshot,
  RequisitionLine,
  RequestForQuotation,
  RequestForQuotationLine,
  SupplierQuote,
  SupplierQuoteLine,
  Supplier,
} from '@readywork/core';
import {
  createProcurementRepository,
  ProcurementAwardIdempotencyConflictError,
  ProcurementCreateIdempotencyConflictError,
  ProcurementIdempotencyConflictError,
  ProcurementExecutionIdempotencyConflictError,
  ProcurementExecutionPermissionError,
  ProcurementExecutionSendInFlightError,
  ProcurementExecutionStateConflictError,
  ProcurementExecutionVersionConflictError,
  ProcurementOutboxLeaseConflictError,
  ProcurementDuplicateInvoiceError,
  ProcurementQuantityEventConflictError,
  ProcurementQuoteVersionConflictError,
  ProcurementQuoteComparisonIdempotencyConflictError,
  ProcurementRfqAlreadyAwardedError,
  ProcurementValidationError,
  SupplierSyncIdempotencyConflictError,
  openPersistence,
} from '@readywork/persistence';
import {
  ProcurementPoProjector,
  SqliteManufacturingContextStore,
  SqliteTwinProjectionQueue,
} from '@readywork/context';

const at = '2026-08-21T00:00:00.000Z';

function tmpDb(): { dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'rw-procurement-persist-'));
  return { dbPath: join(dir, 'test.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function queuedTwinSources(db: DatabaseSync, tenantId: string): string[] {
  return db.prepare(`SELECT source_table || ':' || source_key FROM twin_projection_jobs
    WHERE tenant_id=? AND status='queued' ORDER BY source_table,source_key`)
    .all(tenantId).map((row) => String(Object.values(row as Record<string, unknown>)[0]));
}

test('Twin projection jobs are enqueued atomically with PO writes', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:atomic' });
    const poId = 'po:atomic';
    const initial = purchaseOrder('tenant:atomic', { id: poId, externalId: 'PO-ATOMIC', status: 'draft' });
    store.procurement.saveDocument('purchase_order', initial);
    const job = store.db.prepare(`SELECT source_key,status FROM twin_projection_jobs WHERE tenant_id=? AND source_key=?`)
      .get('tenant:atomic', `purchase_order:${poId}`) as { source_key: string; status: string };
    assert.equal(job.status, 'queued');
    store.db.prepare(`INSERT INTO twin_projection_jobs
      (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,available_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'purchase_order.changed','conflicting-hash','queued',0,8,?,?,?)`)
      .run('tenant:atomic', 'job:conflict-v2', 'procurement_documents', `purchase_order:${poId}`, '2', at, at, at);
    assert.throws(
      () => store.procurement.saveDocument('purchase_order', {
        ...initial, status: 'sent', updatedAt: '2026-08-21T01:00:00.000Z',
      }, 1),
      /不同载荷/,
    );
    const persisted = store.procurement.getDocument<PurchaseOrder>('purchase_order', poId)!;
    assert.equal(persisted.version, 1);
    assert.equal(persisted.document.status, 'draft');
    store.close();
  } finally { temp.cleanup(); }
});

test('projection failure after Outbox completion does not rewrite committed PO facts', () => {
  const temp = tmpDb();
  try {
    const tenantId = 'tenant:projection-failure';
    const store = openPersistence(temp.dbPath, { tenantId });
    configureCommunicationIdentity(store.db, tenantId);
    const po = purchaseOrder(tenantId, {
      id: 'po:projection-failure', externalId: 'PO-PROJECTION-FAILURE', status: 'draft', sourceSystem: 'readywork',
    });
    store.procurement.saveDocument('purchase_order', po);
    const outbox = store.procurement.executeProcurementMutation({
      action: 'send_po', idempotencyKey: 'projection-failure-send', payloadHash: 'projection-failure-send-hash',
      actorId: 'human:buyer', permission: 'operate', aggregateId: po.id, expectedVersion: 1,
      occurredAt: at, connectorId: 'email', connectorReady: true,
    }).outbox!;
    const outboxLease = store.procurement.claimOutboxMessages({
      workerId: 'worker:email', claimedAt: at, leaseDurationMs: 60_000, channel: 'email', limit: 1,
    })[0]!;
    assert.equal(outboxLease.id, outbox.id);
    store.procurement.completeOutboxMessage({
      id: outboxLease.id, leaseToken: outboxLease.leaseToken!, completedAt: '2026-08-21T00:00:01.000Z',
    });

    const queue = new SqliteTwinProjectionQueue(store.db, tenantId);
    const projectionJob = queue.claim({
      workerId: 'projector:failing', claimedAt: '2026-08-21T00:00:02.000Z', leaseDurationMs: 60_000, limit: 100,
    }).find((job) => job.sourceTable === 'procurement_documents'
      && job.sourceKey === `purchase_order:${po.id}` && job.sourceRevision === '2')!;
    assert.ok(projectionJob);
    const projector = new ProcurementPoProjector(
      store.db, tenantId, new SqliteManufacturingContextStore(store.db, tenantId),
    );
    let projectionError: unknown;
    try { projector.project(projectionJob); } catch (error) { projectionError = error; }
    assert.ok(projectionError instanceof Error);
    const failed = queue.fail({
      id: projectionJob.id, leaseToken: projectionJob.leaseToken!,
      failedAt: '2026-08-21T00:00:03.000Z', error: projectionError,
    });
    assert.equal(failed.status, 'retry_wait');
    assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.status, 'sent');
    assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', po.id)?.version, 2);
    store.close();
  } finally { temp.cleanup(); }
});

test('migrations 35 and 37 install tenant-scoped Manufacturing Context storage and worker heartbeat', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:context' });
    const tables = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'twin_%' ORDER BY name`)
      .all().map((row) => String((row as { name: string }).name));
    assert.deepEqual(tables, [
      'twin_agent_events', 'twin_entities', 'twin_evidence',
      'twin_projection_jobs', 'twin_projection_worker_heartbeats', 'twin_relations', 'twin_snapshots',
    ]);
    const migration = store.db.prepare('SELECT name FROM schema_migrations WHERE version=35').get() as { name: string };
    assert.equal(migration.name, 'manufacturing-context-twin');
    const runtimeMigration = store.db.prepare('SELECT name FROM schema_migrations WHERE version=37').get() as { name: string };
    assert.equal(runtimeMigration.name, 'manufacturing-context-worker-heartbeats');
    store.close();
  } finally { temp.cleanup(); }
});

test('migration 35 keeps evidence, agent events, and snapshots append-only', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:context' });
    const db = store.db;
    db.prepare(`INSERT INTO twin_evidence
      (tenant_id,id,entity_id,relation_id,source_semantics,source_kind,source_id,source_version,source_hash,fact_path,value_json,priority,confidence,effective_at,observed_at,actor_id,raw_reference_json,supersedes_evidence_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'tenant:context', 'evidence:1', 'entity:1', null, 'deterministic', 'readywork', 'po:1', '1', 'hash:1', 'purchase_order.status', '"sent"', 200, 1, at, at, 'system', '{}', null, at,
    );
    db.prepare(`INSERT INTO twin_agent_events
      (tenant_id,id,employee_id,temporal_workflow_id,run_id,task_id,business_object_id,entity_id,event_type,input_snapshot_id,model,reasoning_profile,prompt_hash,response_hash,action_name,status,confidence,evidence_ids_json,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'tenant:context', 'event:1', 'ai:1', null, 'run:1', 'task:1', null, 'entity:1', 'context_read', null, null, null, null, null, null, 'completed', 1, '[]', '{}', at,
    );
    db.prepare(`INSERT INTO twin_snapshots
      (tenant_id,id,employee_id,root_entity_id,purpose,schema_version,source_watermark,permission_fingerprint,snapshot_json,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      'tenant:context', 'snapshot:1', 'ai:1', 'entity:1', 'test', 'manufacturing-context/v1', 'watermark:1', 'permission:1', '{}', 'hash:1', at,
    );

    for (const [table, id, mutationColumn, originalValue] of [
      ['twin_evidence', 'evidence:1', 'value_json', '"sent"'],
      ['twin_agent_events', 'event:1', 'status', 'completed'],
      ['twin_snapshots', 'snapshot:1', 'snapshot_json', '{}'],
    ] as const) {
      assert.throws(() => db.prepare(`UPDATE ${table} SET ${mutationColumn}=? WHERE tenant_id=? AND id=?`).run('"changed"', 'tenant:context', id), /immutable|append-only/i);
      assert.throws(() => db.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND id=?`).run('tenant:context', id), /immutable|append-only/i);
      assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id=? AND id=?`).get('tenant:context', id) as { count: number }).count, 1);
      assert.equal((db.prepare(`SELECT ${mutationColumn} AS value FROM ${table} WHERE tenant_id=? AND id=?`).get('tenant:context', id) as { value: string }).value, originalValue);
    }
    store.close();
  } finally { temp.cleanup(); }
});

function purchaseOrder(tenantId: string, overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'po:1',
    tenantId,
    sourceSystem: 'odoo',
    externalId: 'P00001',
    status: 'created',
    createdAt: at,
    updatedAt: at,
    supplierId: 'supplier:1',
    currency: 'CNY',
    orderedAt: at,
    ...overrides,
  };
}

function poLine(overrides: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return {
    id: 'po-line:1',
    poId: 'po:1',
    lineNumber: '10',
    itemId: 'item:1',
    uom: 'EA',
    orderedQty: 100,
    unitPrice: 10,
    currency: 'CNY',
    ...overrides,
  };
}

function quantityEvent(tenantId: string, overrides: Partial<PurchaseOrderLineQuantityEvent> = {}): PurchaseOrderLineQuantityEvent {
  return {
    tenantId,
    sourceSystem: 'odoo',
    sourceEventId: 'event:1',
    poLineId: 'po-line:1',
    dimension: 'confirmed',
    delta: 100,
    occurredAt: at,
    ...overrides,
  };
}

function supplier(tenantId: string, overrides: Partial<Supplier> = {}): Supplier {
  return {
    id: 'supplier:1', tenantId, sourceSystem: 'erp', externalId: 'SUP-1', status: 'active',
    createdAt: at, updatedAt: at, name: '供应商 A', currency: 'CNY',
    contacts: [{ id: 'contact:1', name: '张三', email: 'supplier@example.com', primary: true }],
    ...overrides,
  };
}

function configureCommunicationIdentity(db: DatabaseSync, tenantId: string): void {
  db.prepare(`INSERT INTO procurement_communication_identities
    (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?, 'active',1,?,?,?,?)`).run(
    tenantId,
    '李娜',
    '高级采购专员',
    '东方制造有限公司',
    'human:manager',
    'human:manager',
    at,
    at,
  );
}

test('supplier_email_ai 只接受同 PO 同供应商入站邮件并保留真实生产与发运来源', () => {
  const temp = tmpDb();
  try {
    const tenantId = 'tenant:supplier-email-ai';
    const store = openPersistence(temp.dbPath, { tenantId });
    const po = purchaseOrder(tenantId, {
      id: 'po:supplier-email-ai', externalId: 'PO-SUPPLIER-EMAIL-AI', status: 'confirmed', supplierId: 'supplier:ai',
    });
    const line = poLine({ id: 'po-line:supplier-email-ai', poId: po.id, orderedQty: 100 });
    const communication: Communication = {
      id: 'communication:supplier-email-ai', tenantId, sourceSystem: 'imap:test', externalId: 'uid:supplier-email-ai',
      status: 'received', createdAt: at, updatedAt: at, businessObjectId: po.id, businessObjectType: 'purchase_order',
      supplierId: po.supplierId, channel: 'email', direction: 'inbound', messageId: '<supplier-email-ai@example.com>',
      provider: 'imap:test', mailbox: 'INBOX', uid: 'uid:supplier-email-ai', from: 'supplier@example.com',
      subject: 'Re: PO-SUPPLIER-EMAIL-AI', body: '生产已完成 100 件，完成度 100%。ASN: ASN-AI-1。',
      attachmentIds: [], occurredAt: at, receivedAt: at,
    };
    store.procurement.saveDocument('supplier', supplier(tenantId, { id: po.supplierId }));
    store.procurement.saveDocument('purchase_order', po);
    store.procurement.saveLine('purchase_order_line', po.id, line);
    store.procurement.saveDocument('communication', communication);

    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'record_production_progress', idempotencyKey: 'ai-production-forged', payloadHash: 'ai-production-forged-hash',
      actorId: 'ai:supplier-reply', permission: 'operate', aggregateId: po.id, expectedVersion: 1, occurredAt: at,
      evidenceSource: 'supplier_email_ai' as any, evidenceReference: 'communication:missing',
      supplierReference: communication.messageId, lines: [{ poLineId: line.id, quantity: 100, progressStatus: 'ready_to_ship', completionPercent: 100 }],
    }), ProcurementValidationError, '不存在的邮件证据不能生成生产事实');

    const production = store.procurement.executeProcurementMutation({
      action: 'record_production_progress', idempotencyKey: 'ai-production', payloadHash: 'ai-production-hash',
      actorId: 'ai:supplier-reply', permission: 'operate', aggregateId: po.id, expectedVersion: 1, occurredAt: at,
      evidenceSource: 'supplier_email_ai' as any, evidenceReference: communication.id,
      supplierReference: communication.messageId, lines: [{ poLineId: line.id, quantity: 100, progressStatus: 'ready_to_ship', completionPercent: 100 }],
    });
    assert.equal(production.aggregate.document.status, 'awaiting_shipment');
    assert.equal(production.createdDocuments[0]?.sourceSystem, 'supplier-email-ai');
    assert.equal((production.createdDocuments[0] as any)?.evidenceSource, 'supplier_email_ai');
    assert.equal((production.createdDocuments[0] as any)?.evidenceReference, communication.id);
    assert.equal((production.createdDocuments[0] as any)?.verifiedBy, undefined);

    const shipment = store.procurement.executeProcurementMutation({
      action: 'record_shipment', idempotencyKey: 'ai-shipment', payloadHash: 'ai-shipment-hash',
      actorId: 'ai:supplier-reply', permission: 'operate', aggregateId: po.id, expectedVersion: 2, occurredAt: at,
      evidenceSource: 'supplier_email_ai' as any, evidenceReference: communication.id, supplierReference: 'ASN-AI-1',
      carrier: 'DHL', trackingNumber: 'DHL-AI-1', estimatedArrivalAt: '2026-08-28T00:00:00.000Z',
      lines: [{ poLineId: line.id, quantity: 100 }],
    });
    assert.equal(shipment.aggregate.document.status, 'shipped');
    assert.equal(shipment.createdDocuments[0]?.sourceSystem, 'supplier-email-ai');
    assert.equal((shipment.createdDocuments[0] as any)?.evidenceSource, 'supplier_email_ai');
    assert.equal((shipment.createdDocuments[0] as any)?.evidenceReference, communication.id);
    assert.equal((shipment.createdDocuments[0] as any)?.verifiedBy, undefined);
    const stageSources = store.db.prepare(`SELECT source_kind,evidence_json FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND source_kind LIKE 'supplier_email_ai_%' ORDER BY rowid`)
      .all(tenantId, po.id) as Array<{ source_kind: string; evidence_json: string }>;
    assert.deepEqual(stageSources.map((row) => row.source_kind), [
      'supplier_email_ai_production_progress', 'supplier_email_ai_shipment', 'supplier_email_ai_shipment',
    ]);
    assert.ok(stageSources.every((row) => JSON.parse(row.evidence_json).evidenceSource === 'supplier_email_ai'));
    assert.ok(stageSources.every((row) => !row.evidence_json.includes('manual_verified')));
    store.close();
  } finally { temp.cleanup(); }
});

function comparisonQuote(
  quote: SupplierQuote,
  line: SupplierQuoteLine,
  quoteVersion = 1,
): QuoteComparisonSnapshot['lineComparisons'][number]['quotes'][number] {
  return {
    quoteId: quote.id,
    quoteVersion,
    quoteLineId: line.id,
    supplierId: quote.supplierId,
    supplierName: quote.supplierId,
    currency: quote.currency,
    eligibility: 'eligible',
    reason: '符合条件',
    taxStatus: line.taxIncluded === undefined ? 'unknown' : line.taxIncluded ? 'included' : 'excluded',
    taxReviewRequired: line.taxIncluded === undefined,
    unitPriceUntaxed: line.unitPrice / (line.priceBasisQuantity ?? 1),
    unitPriceTaxIncluded: line.unitPrice / (line.priceBasisQuantity ?? 1),
    oneTimeCharges: line.oneTimeCharges ?? [],
    freight: line.freight ?? 0,
    leadTimeDays: line.leadTimeDays ?? 0,
    paymentTerms: line.paymentTerms ?? 'Net 30',
    paymentTermsDays: 30,
    totalCost: line.quotedQty * line.unitPrice / (line.priceBasisQuantity ?? 1),
    scores: { price: 100, leadTime: 100, paymentTerms: 100, total: 100 },
    rank: 1,
  };
}

test('采购入口持久化: Item/Supplier/Requisition/Communication 与 RequisitionLine roundtrip', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:1' });
    const item: Item = {
      id: 'item:1', tenantId: 'tenant:1', sourceSystem: 'erp', externalId: 'SKU-1', status: 'active',
      createdAt: at, updatedAt: at, sku: 'SKU-1', name: '轴承', uom: 'EA', category: 'MRO',
    };
    const req: ProcurementRequisition = {
      id: 'req:1', tenantId: 'tenant:1', sourceSystem: 'excel', externalId: 'REQ-1', status: 'submitted',
      createdAt: at, updatedAt: at, source: 'excel', requesterId: 'human:1', requestedAt: at,
    };
    const reqLine: RequisitionLine = {
      id: 'req-line:1', requisitionId: req.id, lineNumber: '10', itemId: item.id, uom: 'EA',
      requestedQty: 50, requiredAt: at, technicalRequirements: '耐高温', attachmentIds: ['attachment:1'],
    };
    const communication: Communication = {
      id: 'comm:1', tenantId: 'tenant:1', sourceSystem: 'email', externalId: 'mail:1', status: 'recorded',
      createdAt: at, updatedAt: at, businessObjectId: req.id, businessObjectType: 'requisition',
      supplierId: 'supplier:1', channel: 'email', direction: 'outbound', messageId: '<mail-1@example.com>',
      subject: '询价', body: '请报价', attachmentIds: ['attachment:1'], occurredAt: at,
    };
    store.procurement.saveDocument('item', item);
    store.procurement.saveDocument('supplier', supplier('tenant:1'));
    store.procurement.saveDocument('requisition', req);
    store.procurement.saveLine('requisition_line', req.id, reqLine);
    store.procurement.saveDocument('communication', communication);

    assert.equal(store.procurement.getDocument<Item>('item', item.id)?.document.sku, 'SKU-1');
    assert.equal(store.procurement.getDocument<Supplier>('supplier', 'supplier:1')?.document.contacts[0]?.email, 'supplier@example.com');
    assert.equal(store.procurement.getDocument<ProcurementRequisition>('requisition', req.id)?.document.source, 'excel');
    assert.equal(store.procurement.getLine<RequisitionLine>('requisition_line', reqLine.id)?.technicalRequirements, '耐高温');
    assert.equal(store.procurement.getDocument<Communication>('communication', communication.id)?.document.businessObjectId, req.id);
    assert.throws(
      () => store.procurement.saveLine('requisition_line', req.id, { ...reqLine, id: 'req-line:wrong', lineNumber: '20', requisitionId: 'req:other' }),
      /采购行父单据不一致/,
    );
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('采购持久化: document/line 版本化 roundtrip 与不可变匹配决策', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:1' });
    const document = purchaseOrder('tenant:1');
    assert.equal(store.procurement.saveDocument('purchase_order', document).version, 1);
    assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', document.id)?.document.externalId, 'P00001');
    assert.equal((store.db.prepare('SELECT status FROM procurement_documents WHERE tenant_id=? AND kind=? AND id=?').get('tenant:1', 'purchase_order', document.id) as { status: string }).status, 'created');
    assert.throws(
      () => store.procurement.saveDocument('purchase_order', purchaseOrder('tenant:1', { id: 'po:duplicate-external' })),
      /UNIQUE|constraint/i,
    );

    const updated = { ...document, status: 'sent', updatedAt: '2026-08-21T01:00:00.000Z' };
    assert.equal(store.procurement.saveDocument('purchase_order', updated, 1).version, 2);
    assert.equal((store.db.prepare('SELECT status FROM procurement_documents WHERE tenant_id=? AND kind=? AND id=?').get('tenant:1', 'purchase_order', document.id) as { status: string }).status, 'sent');
    assert.throws(() => store.procurement.saveDocument('purchase_order', updated, 1), /版本冲突/);

    const line = poLine();
    store.procurement.saveLine('purchase_order_line', document.id, line);
    assert.throws(
      () => store.procurement.saveLine('purchase_order_line', document.id, poLine({ id: 'po-line:wrong-parent', lineNumber: '20', poId: 'po:other' })),
      /采购行父单据不一致/,
    );
    assert.equal(store.procurement.getLine<PurchaseOrderLine>('purchase_order_line', line.id)?.orderedQty, 100);
    assert.equal(store.procurement.listLines<PurchaseOrderLine>('purchase_order_line', document.id).length, 1);
    assert.throws(
      () => store.procurement.saveLine('purchase_order_line', document.id, poLine({ id: 'po-line:duplicate-number' })),
      /UNIQUE|constraint/i,
    );

    const snapshot: LineMatchResult = {
      poLineId: line.id,
      receiptAllocations: [{ receiptLineId: 'receipt-line:1', allocatedQty: 100 }],
      invoiceLineId: 'invoice-line:1',
      disposition: 'exact_match',
      variances: {
        quantity: { expected: 100, actual: 100, difference: 0, differencePercent: 0 },
        unitPrice: { expected: 10, actual: 10, difference: 0, differencePercent: 0 },
        amount: { expected: 1000, actual: 1000, difference: 0, differencePercent: 0 },
        currency: { expected: 'CNY', actual: 'CNY', matches: true },
      },
    };
    const decision = { id: 'match-decision:1', tenantId: 'tenant:1', ruleVersion: 'match-v1', status: 'exact_match' as const, snapshot, createdAt: at };
    store.procurement.appendMatchDecision(decision);
    assert.deepEqual(store.procurement.getMatchDecision(decision.id), decision);
    assert.throws(() => store.procurement.appendMatchDecision(decision), /UNIQUE|constraint/i);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('采购行投影: A→B→A 保留三个单调世代且精确重放不重复入队', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:line-generation' });
  try {
    const document = purchaseOrder('tenant:line-generation', { id: 'po:line-generation', externalId: 'PO-LINE-GENERATION' });
    const lineA = poLine({ id: 'po-line:line-generation', poId: document.id, orderedQty: 10 });
    const lineB = { ...lineA, orderedQty: 20 };
    store.procurement.saveDocument('purchase_order', document);
    store.procurement.saveLine('purchase_order_line', document.id, lineA);
    store.procurement.saveLine('purchase_order_line', document.id, lineA);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM twin_projection_jobs
      WHERE tenant_id=? AND source_table='procurement_lines' AND source_key=?`)
      .get('tenant:line-generation', `purchase_order_line:${lineA.id}`)?.['count'], 1);
    store.procurement.saveLine('purchase_order_line', document.id, lineB);
    store.procurement.saveLine('purchase_order_line', document.id, lineA);

    const jobs = store.db.prepare(`SELECT source_revision,payload_hash,status FROM twin_projection_jobs
      WHERE tenant_id=? AND source_table='procurement_lines' AND source_key=?
      ORDER BY CAST(source_revision AS INTEGER)`)
      .all('tenant:line-generation', `purchase_order_line:${lineA.id}`) as unknown as Array<{
        source_revision: string; payload_hash: string; status: string;
      }>;
    assert.deepEqual(jobs.map((job) => job.source_revision), ['1', '2', '3']);
    assert.equal(jobs[0]!.payload_hash, jobs[2]!.payload_hash, '回到 A 时载荷摘要可相同，但变更世代必须不同');
    assert.notEqual(jobs[0]!.payload_hash, jobs[1]!.payload_hash);
    assert.equal(jobs[2]!.status, 'queued');
    assert.equal(store.db.prepare(`SELECT projection_generation FROM procurement_lines
      WHERE tenant_id=? AND kind='purchase_order_line' AND id=?`)
      .get('tenant:line-generation', lineA.id)?.['projection_generation'], 3);
  } finally { store.close(); }
});

test('采购持久化: 相同 document/line ID 与外部编号按租户隔离', () => {
  const temp = tmpDb();
  try {
    const tenantA = openPersistence(temp.dbPath, { tenantId: 'tenant:a' });
    const tenantB = openPersistence(temp.dbPath, { tenantId: 'tenant:b' });
    tenantA.procurement.saveDocument('purchase_order', purchaseOrder('tenant:a', { status: 'sent' }));
    tenantB.procurement.saveDocument('purchase_order', purchaseOrder('tenant:b', { status: 'created' }));
    tenantA.procurement.saveDocument('supplier', supplier('tenant:a', { status: 'active' }));
    tenantB.procurement.saveDocument('supplier', supplier('tenant:b', { status: 'blocked' }));
    tenantA.procurement.saveLine('purchase_order_line', 'po:1', poLine({ orderedQty: 10 }));
    tenantB.procurement.saveLine('purchase_order_line', 'po:1', poLine({ orderedQty: 20 }));
    const tenantAQuantity = tenantA.procurement.applyPurchaseOrderLineQuantityEvent(
      poLine({ orderedQty: 10 }),
      quantityEvent('tenant:a', { delta: 10 }),
    );
    const tenantBQuantity = tenantB.procurement.applyPurchaseOrderLineQuantityEvent(
      poLine({ orderedQty: 20 }),
      quantityEvent('tenant:b', { delta: 20 }),
    );
    assert.equal(tenantA.procurement.getDocument<PurchaseOrder>('purchase_order', 'po:1')?.document.status, 'sent');
    assert.equal(tenantB.procurement.getDocument<PurchaseOrder>('purchase_order', 'po:1')?.document.status, 'created');
    assert.equal(tenantA.procurement.getDocument<Supplier>('supplier', 'supplier:1')?.document.status, 'active');
    assert.equal(tenantB.procurement.getDocument<Supplier>('supplier', 'supplier:1')?.document.status, 'blocked');
    assert.equal(tenantA.procurement.getLine<PurchaseOrderLine>('purchase_order_line', 'po-line:1')?.orderedQty, 10);
    assert.equal(tenantB.procurement.getLine<PurchaseOrderLine>('purchase_order_line', 'po-line:1')?.orderedQty, 20);
    assert.equal(tenantAQuantity.projection.confirmedQty, 10);
    assert.equal(tenantBQuantity.projection.confirmedQty, 20);
    tenantA.close();
    tenantB.close();
  } finally {
    temp.cleanup();
  }
});

test('采购数量事件: 跨进程幂等、冲突检测且重开数据库后继续累计', () => {
  const temp = tmpDb();
  try {
    const first = openPersistence(temp.dbPath, { tenantId: 'tenant:1' });
    const document = purchaseOrder('tenant:1');
    const line = poLine();
    first.procurement.saveDocument('purchase_order', document);
    first.procurement.saveLine('purchase_order_line', document.id, line);
    const confirmed = first.procurement.applyPurchaseOrderLineQuantityEvent(line, quantityEvent('tenant:1'));
    assert.equal(confirmed.projection.confirmedQty, 100);

    const concurrent = openPersistence(temp.dbPath, { tenantId: 'tenant:1' });
    const duplicate = concurrent.procurement.applyPurchaseOrderLineQuantityEvent(line, quantityEvent('tenant:1'));
    assert.equal(duplicate.applied, false);
    assert.equal(duplicate.projection.events.length, 1);
    assert.throws(
      () => concurrent.procurement.applyPurchaseOrderLineQuantityEvent(line, quantityEvent('tenant:1', { delta: 50 })),
      ProcurementQuantityEventConflictError,
    );
    assert.throws(
      () => concurrent.procurement.applyPurchaseOrderLineQuantityEvent(line, quantityEvent('tenant:1', { occurredAt: '2026-08-21T00:00:01.000Z' })),
      /幂等键已被不同载荷使用/,
    );
    concurrent.close();
    first.close();

    const reopened = openPersistence(temp.dbPath, { tenantId: 'tenant:1' });
    const received = reopened.procurement.applyPurchaseOrderLineQuantityEvent(
      line,
      quantityEvent('tenant:1', { sourceEventId: 'event:2', dimension: 'received', delta: 40 }),
    );
    assert.equal(received.projection.confirmedQty, 100);
    assert.equal(received.projection.receivedQty, 40);
    assert.equal(received.projection.events.length, 2);
    assert.ok(received.issues.some((issue) => issue.code === 'received_exceeds_shipped'));
    reopened.close();
  } finally {
    temp.cleanup();
  }
});

test('采购迁移修复: migration 5 已记录的旧库缺 status 时补列并从 JSON 回填', () => {
  const temp = tmpDb();
  try {
    const initial = openPersistence(temp.dbPath, { tenantId: 'tenant:1' });
    initial.procurement.saveDocument('purchase_order', purchaseOrder('tenant:1', { status: 'sent' }));
    initial.close();

    const legacyV5 = new DatabaseSync(temp.dbPath);
    legacyV5.exec('ALTER TABLE procurement_documents DROP COLUMN status');
    assert.ok(legacyV5.prepare('SELECT 1 FROM schema_migrations WHERE version=5').get());
    legacyV5.close();

    const repaired = openPersistence(temp.dbPath, { tenantId: 'tenant:1' });
    const columns = repaired.db.prepare('PRAGMA table_info(procurement_documents)').all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'status'));
    const row = repaired.db.prepare('SELECT status FROM procurement_documents WHERE tenant_id=? AND id=?').get('tenant:1', 'po:1') as { status: string };
    assert.equal(row.status, 'sent');
    repaired.close();
  } finally {
    temp.cleanup();
  }
});

test('采购迁移: 仅将历史 RFQ open 的列与 JSON 同步归一为 draft', () => {
  const temp = tmpDb();
  try {
    const initial = openPersistence(temp.dbPath, { tenantId: 'tenant:migration' });
    const legacyRfq: RequestForQuotation = {
      id: 'rfq:legacy-open', tenantId: 'tenant:migration', sourceSystem: 'manual', externalId: 'RFQ-LEGACY-OPEN', status: 'open',
      createdAt: at, updatedAt: at, buyerId: 'human:buyer', supplierIds: ['supplier:a'], currency: 'CNY', quoteDueAt: '2026-12-31T00:00:00.000Z',
    };
    initial.procurement.saveDocument('rfq', legacyRfq);
    initial.db.prepare(`
      INSERT INTO runtime_exceptions (tenant_id,id,object_id,status,json,updated_at)
      VALUES (?,?,?,?,?,?)
    `).run('tenant:migration', 'exception:open', legacyRfq.id, 'open', JSON.stringify({ id: 'exception:open', status: 'open' }), at);
    initial.db.prepare('DELETE FROM schema_migrations WHERE version=11').run();
    initial.close();

    const migrated = openPersistence(temp.dbPath, { tenantId: 'tenant:migration' });
    const row = migrated.db.prepare(`
      SELECT status,json_extract(json, '$.status') AS json_status
      FROM procurement_documents WHERE tenant_id=? AND kind='rfq' AND id=?
    `).get('tenant:migration', legacyRfq.id) as { status: string; json_status: string };
    assert.equal(row.status, 'draft');
    assert.equal(row.json_status, 'draft');
    const exception = migrated.db.prepare(`
      SELECT status,json_extract(json, '$.status') AS json_status
      FROM runtime_exceptions WHERE tenant_id=? AND id=?
    `).get('tenant:migration', 'exception:open') as { status: string; json_status: string };
    assert.equal(exception.status, 'open');
    assert.equal(exception.json_status, 'open');
    migrated.close();
  } finally {
    temp.cleanup();
  }
});

test('采购迁移 26: 历史 PO 只回填诚实的状态观察，不伪造精确阶段时间', () => {
  const temp = tmpDb();
  try {
    const initial = openPersistence(temp.dbPath, { tenantId: 'tenant:stage-migration' });
    const po = purchaseOrder('tenant:stage-migration', { id: 'po:legacy-shipped', externalId: 'PO-LEGACY-SHIPPED', status: 'shipped' });
    initial.procurement.saveDocument('purchase_order', po);
    initial.db.prepare('DELETE FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=?').run('tenant:stage-migration', po.id);
    initial.db.prepare('DELETE FROM schema_migrations WHERE version=26').run();
    initial.close();

    const migrated = openPersistence(temp.dbPath, { tenantId: 'tenant:stage-migration' });
    const row = migrated.db.prepare(`SELECT stage,event_type,state,source_kind,evidence_json FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=?`).get('tenant:stage-migration', po.id) as { stage: string; event_type: string; state: string; source_kind: string; evidence_json: string };
    assert.equal(row.stage, 'dispatch_transit');
    assert.equal(row.event_type, 'observed_status_backfill');
    assert.equal(row.state, 'active');
    assert.equal(row.source_kind, 'migration');
    const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
    assert.equal(evidence['observedStatus'], 'shipped');
    assert.equal(evidence['exactTransitionTime'], false);
    migrated.close();
  } finally {
    temp.cleanup();
  }
});

test('采购申请持久化: 原子创建、列表与租户级幂等冲突', () => {
  const temp = tmpDb();
  try {
    const tenantA = openPersistence(temp.dbPath, { tenantId: 'tenant:a' });
    const tenantB = openPersistence(temp.dbPath, { tenantId: 'tenant:b' });
    const requisition: ProcurementRequisition = {
      id: 'req:idempotent', tenantId: 'tenant:a', sourceSystem: 'manual', externalId: 'REQ-IDEMPOTENT', status: 'submitted',
      createdAt: at, updatedAt: at, source: 'manual', requesterId: 'human:a', requestedAt: at,
    };
    const line: RequisitionLine = {
      id: 'req-line:idempotent', requisitionId: requisition.id, lineNumber: '10', itemId: 'item:1',
      uom: 'EA', requestedQty: 2, requiredAt: at, attachmentIds: [],
    };

    const created = tenantA.procurement.createRequisitionIdempotent({
      idempotencyKey: 'create-1', payloadHash: 'hash-a', requisition, lines: [line],
    });
    assert.equal(created.replayed, false);
    assert.equal(created.requisition.version, 1);
    assert.equal(tenantA.procurement.listDocuments<ProcurementRequisition>('requisition').length, 1);

    const replayed = tenantA.procurement.createRequisitionIdempotent({
      idempotencyKey: 'create-1', payloadHash: 'hash-a',
      requisition: { ...requisition, id: 'req:ignored' },
      lines: [{ ...line, id: 'req-line:ignored', requisitionId: 'req:ignored' }],
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.requisition.document.id, requisition.id);
    assert.equal(replayed.lines[0]?.id, line.id);
    assert.throws(
      () => tenantA.procurement.createRequisitionIdempotent({
        idempotencyKey: 'create-1', payloadHash: 'hash-b', requisition, lines: [line],
      }),
      ProcurementIdempotencyConflictError,
    );

    const tenantBRequisition = { ...requisition, tenantId: 'tenant:b' };
    const tenantBResult = tenantB.procurement.createRequisitionIdempotent({
      idempotencyKey: 'create-1', payloadHash: 'hash-b', requisition: tenantBRequisition, lines: [line],
    });
    assert.equal(tenantBResult.replayed, false);
    assert.equal(tenantA.procurement.listDocuments('requisition').length, 1);
    assert.equal(tenantB.procurement.listDocuments('requisition').length, 1);
    tenantB.close();
    tenantA.close();
  } finally {
    temp.cleanup();
  }
});

test('采购申请持久化: 任一申请行写入失败时整单和幂等记录均回滚', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:1' });
    const requisition: ProcurementRequisition = {
      id: 'req:rollback', tenantId: 'tenant:1', sourceSystem: 'excel', externalId: 'REQ-ROLLBACK', status: 'submitted',
      createdAt: at, updatedAt: at, source: 'excel', requesterId: 'human:1', requestedAt: at,
    };
    const line: RequisitionLine = {
      id: 'req-line:rollback-1', requisitionId: requisition.id, lineNumber: '10', itemId: 'item:1',
      uom: 'EA', requestedQty: 1, requiredAt: at, attachmentIds: [],
    };
    assert.throws(() => store.procurement.createRequisitionIdempotent({
      idempotencyKey: 'rollback-key', payloadHash: 'rollback-hash', requisition,
      lines: [line, { ...line, id: 'req-line:rollback-2' }],
    }), /UNIQUE|constraint/i);
    assert.equal(store.procurement.getDocument('requisition', requisition.id), undefined);
    assert.equal(store.db.prepare('SELECT 1 FROM procurement_requisition_idempotency WHERE tenant_id=? AND idempotency_key=?').get('tenant:1', 'rollback-key'), undefined);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('供应商同步持久化: 稳定重放、载荷冲突、租户隔离与外部 ID 竞争恢复', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:a' });
    const firstSupplier = supplier('tenant:a', {
      id: 'supplier:odoo:88', sourceSystem: 'odoo', externalId: 'odoo-partner-88',
      name: 'ERP 供应商', createdAt: at, updatedAt: at,
    });
    const created = store.procurement.syncSuppliersIdempotent({
      idempotencyKey: 'sync-key', payloadHash: 'payload-a', suppliers: [firstSupplier], issues: [], completedAt: at,
    });
    assert.equal(created.created, 1);
    assert.equal(created.items[0]?.version, 1);

    const replay = store.procurement.syncSuppliersIdempotent({
      idempotencyKey: 'sync-key', payloadHash: 'payload-a',
      suppliers: [{ ...firstSupplier, name: '不应写入', updatedAt: '2026-08-22T00:00:00.000Z' }],
      issues: [{ row: 9, reason: '不应写入' }], completedAt: '2026-08-22T00:00:00.000Z',
    });
    assert.deepEqual(replay, created);
    assert.equal(store.procurement.getDocument<Supplier>('supplier', firstSupplier.id)?.version, 1);
    assert.throws(() => store.procurement.getSupplierSyncResult('sync-key', 'payload-b'), SupplierSyncIdempotencyConflictError);

    const tenantB = createProcurementRepository(store.db, 'tenant:b');
    const tenantBResult = tenantB.syncSuppliersIdempotent({
      idempotencyKey: 'sync-key', payloadHash: 'payload-b',
      suppliers: [{ ...firstSupplier, tenantId: 'tenant:b' }], issues: [], completedAt: at,
    });
    assert.equal(tenantBResult.created, 1);
    assert.equal(store.procurement.listDocuments<Supplier>('supplier').length, 1);
    assert.equal(tenantB.listDocuments<Supplier>('supplier').length, 1);

    const legacy = supplier('tenant:a', {
      id: 'supplier:legacy:77', sourceSystem: 'odoo', externalId: 'odoo-partner-77', name: '旧供应商',
    });
    store.procurement.saveDocument('supplier', legacy);
    const recovered = store.procurement.syncSuppliersIdempotent({
      idempotencyKey: 'race-key', payloadHash: 'race-payload',
      suppliers: [{ ...legacy, id: 'supplier:odoo:77', name: '获胜记录', updatedAt: '2026-08-22T00:00:00.000Z' }],
      issues: [], completedAt: '2026-08-22T00:00:00.000Z',
    });
    assert.equal(recovered.updated, 1);
    assert.equal(recovered.items[0]?.id, legacy.id);
    assert.equal(recovered.items[0]?.version, 2);
    assert.equal(store.procurement.listDocuments<Supplier>('supplier').filter(({ document }) => document.externalId === legacy.externalId).length, 1);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('RFQ/Quote 持久化: 头行原子保存、重放原结果且同键异载荷冲突', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:1' });
    const rfq: RequestForQuotation = {
      id: 'rfq:atomic', tenantId: 'tenant:1', sourceSystem: 'manual', externalId: 'RFQ-ATOMIC', status: 'draft',
      createdAt: at, updatedAt: at, requisitionId: 'req:1', buyerId: 'human:1', supplierIds: ['supplier:1'],
      currency: 'CNY', quoteDueAt: '2026-09-30T00:00:00.000Z', title: '原子 RFQ',
    };
    const rfqLine: RequestForQuotationLine = {
      id: 'rfq-line:atomic', rfqId: rfq.id, requisitionLineId: 'req-line:1', lineNumber: '10',
      itemId: 'item:1', uom: 'EA', requestedQty: 100, requiredAt: at,
    };
    const createdRfq = store.procurement.createRfqIdempotent({ idempotencyKey: 'rfq-key', payloadHash: 'rfq-hash', document: rfq, lines: [rfqLine] });
    assert.equal(createdRfq.replayed, false);
    assert.equal(createdRfq.document.document.status, 'draft');
    const replayedRfq = store.procurement.createRfqIdempotent({
      idempotencyKey: 'rfq-key', payloadHash: 'rfq-hash', document: { ...rfq, id: 'rfq:ignored' },
      lines: [{ ...rfqLine, id: 'rfq-line:ignored', rfqId: 'rfq:ignored' }],
    });
    assert.equal(replayedRfq.replayed, true);
    assert.equal(replayedRfq.document.document.id, rfq.id);
    assert.throws(() => store.procurement.createRfqIdempotent({
      idempotencyKey: 'rfq-key', payloadHash: 'changed', document: rfq, lines: [rfqLine],
    }), ProcurementCreateIdempotencyConflictError);

    const quote: SupplierQuote = {
      id: 'quote:atomic', tenantId: 'tenant:1', sourceSystem: 'manual', externalId: 'QUOTE-ATOMIC', status: 'received',
      createdAt: at, updatedAt: at, rfqId: rfq.id, supplierId: 'supplier:1', currency: 'CNY',
      receivedAt: at, validUntil: '2026-12-31T00:00:00.000Z',
    };
    const quoteLine: SupplierQuoteLine = {
      id: 'quote-line:atomic', quoteId: quote.id, rfqLineId: rfqLine.id, lineNumber: '10', itemId: 'item:1',
      uom: 'EA', quotedQty: 100, unitPrice: 10, priceBasisQuantity: 1, taxIncluded: false,
      leadTimeDays: 10, oneTimeCharges: [], paymentTerms: 'Net 30',
    };
    assert.equal(store.procurement.createQuoteIdempotent({ idempotencyKey: 'quote-key', payloadHash: 'quote-hash', document: quote, lines: [quoteLine] }).replayed, false);
    assert.equal(store.procurement.createQuoteIdempotent({
      idempotencyKey: 'quote-key', payloadHash: 'quote-hash', document: { ...quote, id: 'quote:ignored' },
      lines: [{ ...quoteLine, id: 'quote-line:ignored', quoteId: 'quote:ignored' }],
    }).document.document.id, quote.id);
    assert.equal(store.procurement.listDocuments<RequestForQuotation>('rfq').length, 1);
    assert.equal(store.procurement.listDocuments<SupplierQuote>('quote').length, 1);

    const rollbackRfq = { ...rfq, id: 'rfq:rollback', externalId: 'RFQ-ROLLBACK' };
    const rollbackLine = { ...rfqLine, id: 'rfq-line:rollback-1', rfqId: rollbackRfq.id };
    assert.throws(() => store.procurement.createRfqIdempotent({
      idempotencyKey: 'rfq-rollback', payloadHash: 'rollback', document: rollbackRfq,
      lines: [rollbackLine, { ...rollbackLine, id: 'rfq-line:rollback-2' }],
    }), /UNIQUE|constraint/i);
    assert.equal(store.procurement.getDocument('rfq', rollbackRfq.id), undefined);
    assert.equal(store.db.prepare("SELECT 1 FROM procurement_create_idempotency WHERE tenant_id=? AND kind='rfq' AND idempotency_key=?").get('tenant:1', 'rfq-rollback'), undefined);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('收到报价按候选供应商覆盖原子推进 RFQ，重放不重复推进', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:quote-state' });
    const rfq: RequestForQuotation = {
      id: 'rfq:quote-state', tenantId: 'tenant:quote-state', sourceSystem: 'manual', externalId: 'RFQ-QUOTE-STATE', status: 'sent',
      createdAt: at, updatedAt: at, requisitionId: 'req:1', buyerId: 'human:1', supplierIds: ['supplier:a', 'supplier:b'],
      currency: 'CNY', quoteDueAt: '2026-09-30T00:00:00.000Z',
    };
    const rfqLine: RequestForQuotationLine = {
      id: 'rfq-line:quote-state', rfqId: rfq.id, requisitionLineId: 'req-line:1', lineNumber: '10',
      itemId: 'item:1', uom: 'EA', requestedQty: 100, requiredAt: at,
    };
    store.procurement.createRfqIdempotent({ idempotencyKey: 'rfq-quote-state', payloadHash: 'rfq-quote-state', document: rfq, lines: [rfqLine] });
    store.procurement.saveDocument('rfq', rfq, 1);
    const createQuote = (supplierId: string) => {
      const quote: SupplierQuote = {
        id: `quote:quote-state:${supplierId}`, tenantId: rfq.tenantId, sourceSystem: 'manual', externalId: `QUOTE-QUOTE-STATE-${supplierId}`,
        status: 'received', createdAt: at, updatedAt: at, rfqId: rfq.id, supplierId, currency: 'CNY', receivedAt: at, validUntil: '2026-12-31T00:00:00.000Z',
      };
      const line: SupplierQuoteLine = {
        id: `quote-line:quote-state:${supplierId}`, quoteId: quote.id, rfqLineId: rfqLine.id, lineNumber: '10', itemId: rfqLine.itemId,
        uom: 'EA', quotedQty: 100, unitPrice: 10, priceBasisQuantity: 1, taxIncluded: false, leadTimeDays: 10, oneTimeCharges: [], paymentTerms: 'Net 30',
      };
      return store.procurement.createQuoteIdempotent({ idempotencyKey: `quote-state:${supplierId}`, payloadHash: `quote-state:${supplierId}`, document: quote, lines: [line] });
    };
    assert.equal(createQuote('supplier:a').replayed, false);
    assert.deepEqual(store.procurement.getDocument<RequestForQuotation>('rfq', rfq.id), {
      document: { ...rfq, status: 'partial_quotes' }, version: 3,
    });
    assert.equal(createQuote('supplier:a').replayed, true);
    assert.equal(store.procurement.getDocument<RequestForQuotation>('rfq', rfq.id)?.version, 3);
    assert.equal(createQuote('supplier:b').replayed, false);
    assert.deepEqual(store.procurement.getDocument<RequestForQuotation>('rfq', rfq.id), {
      document: { ...rfq, status: 'quotes_complete' }, version: 4,
    });
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('不可定标比价保持 compared，修订报价撤销快照并可再次比价', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:quote-revision' });
    const rfq: RequestForQuotation = {
      id: 'rfq:quote-revision', tenantId: 'tenant:quote-revision', sourceSystem: 'manual', externalId: 'RFQ-QUOTE-REVISION', status: 'sent',
      createdAt: at, updatedAt: at, requisitionId: 'req:1', buyerId: 'human:1', supplierIds: ['supplier:a'], currency: 'CNY', quoteDueAt: '2026-09-30T00:00:00.000Z',
    };
    const rfqLine: RequestForQuotationLine = {
      id: 'rfq-line:quote-revision', rfqId: rfq.id, requisitionLineId: 'req-line:1', lineNumber: '10', itemId: 'item:1', uom: 'EA', requestedQty: 100, requiredAt: at,
    };
    store.procurement.createRfqIdempotent({ idempotencyKey: 'rfq-quote-revision', payloadHash: 'rfq-quote-revision', document: rfq, lines: [rfqLine] });
    store.procurement.saveDocument('rfq', rfq, 1);
    const initialQuote: SupplierQuote = {
      id: 'quote:tax-unknown', tenantId: rfq.tenantId, sourceSystem: 'manual', externalId: 'QUOTE-TAX-UNKNOWN', status: 'received',
      createdAt: at, updatedAt: at, rfqId: rfq.id, supplierId: 'supplier:a', currency: 'CNY', receivedAt: at, validUntil: '2026-12-31T00:00:00.000Z',
    };
    const initialLine: SupplierQuoteLine = {
      id: 'quote-line:tax-unknown', quoteId: initialQuote.id, rfqLineId: rfqLine.id, lineNumber: '10', itemId: rfqLine.itemId,
      uom: 'EA', quotedQty: 100, unitPrice: 10, priceBasisQuantity: 1, leadTimeDays: 10, oneTimeCharges: [], paymentTerms: 'Net 30',
    };
    store.procurement.createQuoteIdempotent({ idempotencyKey: 'quote-tax-unknown', payloadHash: 'quote-tax-unknown', document: initialQuote, lines: [initialLine] });
    const taxReviewQuote = {
      ...comparisonQuote(initialQuote, initialLine), eligibility: 'tax_review_required' as const, reason: '供应商未说明含税或未税，需税务复核',
      unitPriceUntaxed: null, unitPriceTaxIncluded: null, totalCost: null, scores: {}, rank: null,
    };
    const incompleteSnapshot: QuoteComparisonSnapshot = {
      id: 'quote-comparison:tax-review', tenantId: rfq.tenantId, sourceSystem: 'readywork', externalId: 'COMPARE-TAX-REVIEW', status: 'final',
      createdAt: at, updatedAt: at, rfqId: rfq.id, rfqVersion: 3, createdBy: 'human:buyer', asOf: at, comparisonCurrency: 'CNY',
      rateSnapshot: { version: 'fx-1', rates: {} }, weights: { price: 1, leadTime: 0, paymentTerms: 0, performance: 0 }, ruleVersion: 'quote-v1',
      lineComparisons: [{
        rfqLineId: rfqLine.id, lineNumber: rfqLine.lineNumber, itemId: rfqLine.itemId, comparisonCurrency: 'CNY', purchaseQuantity: 100,
        quotes: [taxReviewQuote], recommendedSupplierId: null, recommendationReason: '税务状态未知，需复核', ruleVersion: 'quote-v1', rateSnapshotVersion: 'fx-1',
      }],
    };
    const incomplete = store.procurement.persistQuoteComparison({
      idempotencyKey: 'compare-tax-review', payloadHash: 'compare-tax-review', expectedRfqVersion: 3,
      quoteVersions: [{ quoteId: initialQuote.id, version: 1 }], snapshot: incompleteSnapshot,
    });
    assert.equal(incomplete.rfq.document.status, 'compared');
    assert.equal(incomplete.rfq.version, 4);
    const revisedQuote: SupplierQuote = { ...initialQuote, id: 'quote:tax-confirmed', externalId: 'QUOTE-TAX-CONFIRMED' };
    const revisedLine: SupplierQuoteLine = { ...initialLine, id: 'quote-line:tax-confirmed', quoteId: revisedQuote.id, taxIncluded: false };
    assert.equal(store.procurement.createQuoteIdempotent({
      idempotencyKey: 'quote-tax-confirmed', payloadHash: 'quote-tax-confirmed', document: revisedQuote, lines: [revisedLine],
    }).replayed, false);
    const readyForRecompare = store.procurement.getDocument<RequestForQuotation>('rfq', rfq.id)!;
    assert.equal(readyForRecompare.document.status, 'quotes_complete');
    assert.equal(readyForRecompare.document.comparisonSnapshotId, undefined);
    assert.equal(readyForRecompare.version, 5);
    assert.equal(store.procurement.createQuoteIdempotent({
      idempotencyKey: 'quote-tax-confirmed', payloadHash: 'quote-tax-confirmed', document: revisedQuote, lines: [revisedLine],
    }).replayed, true);
    assert.equal(store.procurement.getDocument<RequestForQuotation>('rfq', rfq.id)?.version, 5);
    const revisedSnapshot: QuoteComparisonSnapshot = {
      ...incompleteSnapshot, id: 'quote-comparison:tax-confirmed', externalId: 'COMPARE-TAX-CONFIRMED', rfqVersion: 5,
      lineComparisons: [{
        ...incompleteSnapshot.lineComparisons[0]!, quotes: [taxReviewQuote, comparisonQuote(revisedQuote, revisedLine)],
        recommendedSupplierId: revisedQuote.supplierId, recommendationReason: '修订报价税务状态明确，可推荐',
      }],
    };
    const recomparison = store.procurement.persistQuoteComparison({
      idempotencyKey: 'compare-tax-confirmed', payloadHash: 'compare-tax-confirmed', expectedRfqVersion: 5,
      quoteVersions: [{ quoteId: initialQuote.id, version: 1 }, { quoteId: revisedQuote.id, version: 1 }], snapshot: revisedSnapshot,
    });
    assert.equal(recomparison.rfq.document.status, 'pending_award');
    assert.equal(recomparison.rfq.version, 6);
    assert.equal(recomparison.snapshot.document.lineComparisons[0]!.quotes.length, 2);
    assert.equal(recomparison.snapshot.document.lineComparisons[0]!.quotes[1]!.eligibility, 'eligible');
    const laterRevision: SupplierQuote = { ...revisedQuote, id: 'quote:tax-confirmed-later', externalId: 'QUOTE-TAX-CONFIRMED-LATER' };
    const laterLine: SupplierQuoteLine = { ...revisedLine, id: 'quote-line:tax-confirmed-later', quoteId: laterRevision.id };
    assert.equal(store.procurement.createQuoteIdempotent({
      idempotencyKey: 'quote-tax-confirmed-later', payloadHash: 'quote-tax-confirmed-later', document: laterRevision, lines: [laterLine],
    }).replayed, false);
    const afterPendingAwardRevision = store.procurement.getDocument<RequestForQuotation>('rfq', rfq.id)!;
    assert.equal(afterPendingAwardRevision.document.status, 'quotes_complete');
    assert.equal(afterPendingAwardRevision.document.comparisonSnapshotId, undefined);
    assert.equal(afterPendingAwardRevision.version, 7);
    assert.ok(store.procurement.getDocument('quote_comparison', incompleteSnapshot.id));
    assert.ok(store.procurement.getDocument('quote_comparison', revisedSnapshot.id));
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('比价快照与定标: 精确报价版本、原子幂等、人工原因与多供应商 PO draft', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:award' });
    const rfq: RequestForQuotation = {
      id: 'rfq:award', tenantId: 'tenant:award', sourceSystem: 'manual', externalId: 'RFQ-AWARD', status: 'draft',
      createdAt: at, updatedAt: at, buyerId: 'human:buyer', supplierIds: ['supplier:a', 'supplier:b'],
      currency: 'CNY', quoteDueAt: '2026-12-31T00:00:00.000Z',
    };
    const rfqLines: RequestForQuotationLine[] = [
      { id: 'rfq-line:a', rfqId: rfq.id, lineNumber: '10', itemId: 'item:a', uom: 'EA', requestedQty: 100 },
      { id: 'rfq-line:b', rfqId: rfq.id, lineNumber: '20', itemId: 'item:b', uom: 'EA', requestedQty: 50 },
    ];
    store.procurement.createRfqIdempotent({ idempotencyKey: 'rfq-award', payloadHash: 'rfq-award-hash', document: rfq, lines: rfqLines });
    const quoteA: SupplierQuote = {
      id: 'quote:a', tenantId: 'tenant:award', sourceSystem: 'manual', externalId: 'QUOTE-A', status: 'received',
      createdAt: at, updatedAt: at, rfqId: rfq.id, supplierId: 'supplier:a', currency: 'CNY', validUntil: '2026-12-31T00:00:00.000Z',
    };
    const quoteB: SupplierQuote = {
      ...quoteA, id: 'quote:b', externalId: 'QUOTE-B', supplierId: 'supplier:b', currency: 'USD',
    };
    const quoteLineA: SupplierQuoteLine = {
      id: 'quote-line:a', quoteId: quoteA.id, rfqLineId: rfqLines[0]!.id, lineNumber: '10', itemId: 'item:a',
      uom: 'EA', quotedQty: 100, unitPrice: 1000, priceBasisQuantity: 100, taxIncluded: true, taxRate: 0.13,
      leadTimeDays: 5, oneTimeCharges: [], freight: 0, paymentTerms: 'Net 30',
    };
    const quoteLineB: SupplierQuoteLine = {
      id: 'quote-line:b', quoteId: quoteB.id, rfqLineId: rfqLines[1]!.id, lineNumber: '20', itemId: 'item:b',
      uom: 'EA', quotedQty: 50, unitPrice: 8, priceBasisQuantity: 1, taxIncluded: false,
      leadTimeDays: 7, oneTimeCharges: [], freight: 0, paymentTerms: 'Net 30',
    };
    store.procurement.createQuoteIdempotent({ idempotencyKey: 'quote-a', payloadHash: 'quote-a-hash', document: quoteA, lines: [quoteLineA] });
    store.procurement.createQuoteIdempotent({ idempotencyKey: 'quote-b', payloadHash: 'quote-b-hash', document: quoteB, lines: [quoteLineB] });
    assert.throws(
      () => store.procurement.saveLine('quote_line', quoteA.id, { ...quoteLineA, unitPrice: 1 }),
      ProcurementValidationError,
      '已提交报价行不得绕过 quote version 被覆盖',
    );

    const snapshot: QuoteComparisonSnapshot = {
      id: 'quote-comparison:award', tenantId: 'tenant:award', sourceSystem: 'readywork', externalId: 'COMPARE-AWARD', status: 'final',
      createdAt: '2026-08-21T01:00:00.000Z', updatedAt: '2026-08-21T01:00:00.000Z', rfqId: rfq.id, rfqVersion: 1,
      createdBy: 'human:buyer', asOf: '2026-08-21T01:00:00.000Z', comparisonCurrency: 'CNY',
      rateSnapshot: { version: 'fx-1', rates: { 'USD/CNY': 7 } },
      weights: { price: 1, leadTime: 0, paymentTerms: 0, performance: 0 }, ruleVersion: 'quote-v1',
      lineComparisons: [
        {
          rfqLineId: rfqLines[0]!.id, lineNumber: '10', itemId: 'item:a', comparisonCurrency: 'CNY', purchaseQuantity: 100,
          quotes: [comparisonQuote(quoteA, quoteLineA)], recommendedSupplierId: quoteA.supplierId,
          recommendationReason: '人工离线报价 A 符合条件', ruleVersion: 'quote-v1', rateSnapshotVersion: 'fx-1',
        },
        {
          rfqLineId: rfqLines[1]!.id, lineNumber: '20', itemId: 'item:b', comparisonCurrency: 'CNY', purchaseQuantity: 50,
          quotes: [comparisonQuote(quoteB, quoteLineB)], recommendedSupplierId: quoteB.supplierId,
          recommendationReason: '人工离线报价 B 符合条件', ruleVersion: 'quote-v1', rateSnapshotVersion: 'fx-1',
        },
      ],
    };
    assert.throws(
      () => store.procurement.saveDocument('quote_comparison', snapshot),
      ProcurementValidationError,
      '快照不得绕过 persistQuoteComparison 直接插入',
    );
    assert.equal(store.procurement.getDocument('quote_comparison', snapshot.id), undefined);
    assert.throws(() => store.procurement.persistQuoteComparison({
      idempotencyKey: 'compare-bad-version', payloadHash: 'compare-bad-version-hash', expectedRfqVersion: 1,
      quoteVersions: [{ quoteId: quoteA.id, version: 2 }, { quoteId: quoteB.id, version: 1 }], snapshot,
    }), ProcurementQuoteVersionConflictError);
    assert.equal(store.procurement.getDocument('quote_comparison', snapshot.id), undefined);
    assert.equal(store.procurement.getDocument<RequestForQuotation>('rfq', rfq.id)?.document.status, 'draft');

    const compared = store.procurement.persistQuoteComparison({
      idempotencyKey: 'compare-key', payloadHash: 'compare-hash', expectedRfqVersion: 1,
      quoteVersions: [{ quoteId: quoteA.id, version: 1 }, { quoteId: quoteB.id, version: 1 }], snapshot,
    });
    assert.equal(compared.replayed, false);
    assert.equal(compared.rfq.document.status, 'pending_award');
    assert.equal(compared.rfq.document.comparisonSnapshotId, snapshot.id);
    assert.equal(compared.rfq.version, 2);
    assert.equal(compared.snapshot.document.lineComparisons[0]!.quotes[0]!.quoteLineId, quoteLineA.id);
    const quoteReplayAfterComparison = store.procurement.createQuoteIdempotent({
      idempotencyKey: 'quote-a', payloadHash: 'quote-a-hash', document: quoteA, lines: [quoteLineA],
    });
    assert.equal(quoteReplayAfterComparison.replayed, true, '已接受的旧幂等请求在 pending_award 仍可重放');
    const comparisonReplay = store.procurement.persistQuoteComparison({
      idempotencyKey: 'compare-key', payloadHash: 'compare-hash', expectedRfqVersion: 1,
      quoteVersions: [{ quoteId: quoteA.id, version: 1 }, { quoteId: quoteB.id, version: 1 }],
      snapshot: { ...snapshot, id: 'quote-comparison:ignored' },
    });
    assert.equal(comparisonReplay.replayed, true);
    assert.equal(comparisonReplay.snapshot.document.id, snapshot.id);
    assert.throws(() => store.procurement.persistQuoteComparison({
      idempotencyKey: 'compare-key', payloadHash: 'changed', expectedRfqVersion: 1,
      quoteVersions: [{ quoteId: quoteA.id, version: 1 }, { quoteId: quoteB.id, version: 1 }], snapshot,
    }), ProcurementQuoteComparisonIdempotencyConflictError);
    assert.throws(
      () => store.procurement.saveDocument('quote_comparison', { ...snapshot, status: 'changed' }, 1),
      ProcurementValidationError,
    );

    const validSelections = [
      { rfqLineId: rfqLines[0]!.id, quoteLineId: quoteLineA.id, awardedQuantity: 100, selectionReason: 'A 价格与交期最佳' },
      { rfqLineId: rfqLines[1]!.id, quoteLineId: quoteLineB.id, awardedQuantity: 50, selectionReason: 'B 是唯一合格来源' },
    ];
    assert.throws(() => store.procurement.awardRfqAndCreateDraftPurchaseOrders({
      idempotencyKey: 'award-incomplete', payloadHash: 'award-incomplete-hash', rfqId: rfq.id, expectedRfqVersion: 2,
      approvedBy: 'human:manager', approvedAt: '2026-08-21T02:00:00.000Z', lines: [validSelections[0]!],
    }), ProcurementValidationError);
    assert.throws(() => store.procurement.awardRfqAndCreateDraftPurchaseOrders({
      idempotencyKey: 'award-expired', payloadHash: 'award-expired-hash', rfqId: rfq.id, expectedRfqVersion: 2,
      approvedBy: 'human:manager', approvedAt: '2027-01-01T00:00:00.000Z', lines: validSelections,
    }), (error: unknown) => error instanceof ProcurementValidationError && error.code === 'QUOTE_EXPIRED');
    assert.equal(store.procurement.listDocuments('award').length, 0);

    const awarded = store.procurement.awardRfqAndCreateDraftPurchaseOrders({
      idempotencyKey: 'award-key', payloadHash: 'award-hash', rfqId: rfq.id, expectedRfqVersion: 2,
      approvedBy: 'human:manager', approvedAt: '2026-08-21T02:00:00.000Z',
      lines: validSelections,
    });
    assert.equal(awarded.replayed, false);
    assert.equal(awarded.award.document.approvedBy, 'human:manager');
    assert.equal(awarded.lines[0]!.selectionReason, 'A 价格与交期最佳');
    assert.equal(awarded.lines[0]!.unitPrice, 10, '报价 1000/100 应规范化为每件 10');
    assert.equal(awarded.lines[0]!.quotedUnitPrice, 1000);
    assert.equal(awarded.lines[0]!.priceBasisQuantity, 100);
    assert.equal(awarded.lines[0]!.taxIncluded, true);
    assert.equal(awarded.purchaseOrders.length, 2);
    assert.deepEqual(awarded.purchaseOrders.map((item) => item.purchaseOrder.document.supplierId).sort(), ['supplier:a', 'supplier:b']);
    assert.ok(awarded.purchaseOrders.every((item) => item.purchaseOrder.document.status === 'draft'));
    assert.equal(awarded.rfq.document.status, 'awarded');
    assert.equal(awarded.rfq.version, 3);

    const awardReplay = store.procurement.awardRfqAndCreateDraftPurchaseOrders({
      idempotencyKey: 'award-key', payloadHash: 'award-hash', rfqId: rfq.id, expectedRfqVersion: 2,
      approvedBy: 'human:manager', approvedAt: '2099-01-01T00:00:00.000Z',
      lines: validSelections,
    });
    assert.equal(awardReplay.replayed, true);
    assert.equal(awardReplay.award.document.id, awarded.award.document.id);
    assert.equal(store.procurement.listDocuments<Award>('award').length, 1);
    assert.equal(store.procurement.listDocuments<PurchaseOrder>('purchase_order').length, 2);
    assert.throws(() => store.procurement.awardRfqAndCreateDraftPurchaseOrders({
      idempotencyKey: 'award-key', payloadHash: 'changed', rfqId: rfq.id, expectedRfqVersion: 2,
      approvedBy: 'human:manager', approvedAt: '2026-08-21T02:00:00.000Z',
      lines: [{ rfqLineId: rfqLines[0]!.id, quoteLineId: quoteLineA.id, awardedQuantity: 100, selectionReason: '异载荷' }],
    }), ProcurementAwardIdempotencyConflictError);
    const concurrent = openPersistence(temp.dbPath, { tenantId: 'tenant:award' });
    assert.throws(() => concurrent.procurement.awardRfqAndCreateDraftPurchaseOrders({
      idempotencyKey: 'award-other-key', payloadHash: 'award-other-hash', rfqId: rfq.id, expectedRfqVersion: 2,
      approvedBy: 'human:manager', approvedAt: '2026-08-21T02:00:00.000Z',
      lines: [{ rfqLineId: rfqLines[0]!.id, quoteLineId: quoteLineA.id, awardedQuantity: 100, selectionReason: '重复' }],
    }), ProcurementRfqAlreadyAwardedError);
    concurrent.close();
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('定标事务: PO 写入失败时 Award/行/幂等与 RFQ 状态全部回滚', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:rollback-award' });
    const rfq: RequestForQuotation = {
      id: 'rfq:rollback-award', tenantId: 'tenant:rollback-award', sourceSystem: 'manual', externalId: 'RFQ-ROLLBACK-AWARD', status: 'draft',
      createdAt: at, updatedAt: at, buyerId: 'human:buyer', supplierIds: ['supplier:a'], currency: 'CNY', quoteDueAt: '2026-12-31T00:00:00.000Z',
    };
    const rfqLine: RequestForQuotationLine = { id: 'rfq-line:rollback-award', rfqId: rfq.id, lineNumber: '10', itemId: 'item:a', uom: 'EA', requestedQty: 10 };
    store.procurement.createRfqIdempotent({ idempotencyKey: 'rollback-rfq', payloadHash: 'rollback-rfq-hash', document: rfq, lines: [rfqLine] });
    const quote: SupplierQuote = {
      id: 'quote:rollback-award', tenantId: rfq.tenantId, sourceSystem: 'manual', externalId: 'QUOTE-ROLLBACK-AWARD', status: 'received',
      createdAt: at, updatedAt: at, rfqId: rfq.id, supplierId: 'supplier:a', currency: 'CNY', validUntil: '2026-12-31T00:00:00.000Z',
    };
    const quoteLine: SupplierQuoteLine = {
      id: 'quote-line:rollback-award', quoteId: quote.id, rfqLineId: rfqLine.id, lineNumber: '10', itemId: rfqLine.itemId,
      uom: 'EA', quotedQty: 10, unitPrice: 5, priceBasisQuantity: 1, taxIncluded: false, leadTimeDays: 1, oneTimeCharges: [], freight: 0, paymentTerms: 'Net 30',
    };
    store.procurement.createQuoteIdempotent({ idempotencyKey: 'rollback-quote', payloadHash: 'rollback-quote-hash', document: quote, lines: [quoteLine] });
    const snapshot: QuoteComparisonSnapshot = {
      id: 'quote-comparison:rollback-award', tenantId: rfq.tenantId, sourceSystem: 'readywork', externalId: 'COMPARE-ROLLBACK-AWARD', status: 'final',
      createdAt: at, updatedAt: at, rfqId: rfq.id, rfqVersion: 1, createdBy: 'human:buyer', asOf: at, comparisonCurrency: 'CNY',
      rateSnapshot: { version: 'fx-1', rates: {} }, weights: { price: 1, leadTime: 0, paymentTerms: 0, performance: 0 }, ruleVersion: 'v1',
      lineComparisons: [{
        rfqLineId: rfqLine.id, lineNumber: rfqLine.lineNumber, itemId: rfqLine.itemId, comparisonCurrency: 'CNY', purchaseQuantity: 10,
        quotes: [comparisonQuote(quote, quoteLine)], recommendedSupplierId: quote.supplierId, recommendationReason: '合格', ruleVersion: 'v1', rateSnapshotVersion: 'fx-1',
      }],
    };
    store.procurement.persistQuoteComparison({
      idempotencyKey: 'rollback-compare', payloadHash: 'rollback-compare-hash', expectedRfqVersion: 1,
      quoteVersions: [{ quoteId: quote.id, version: 1 }], snapshot,
    });
    store.db.exec(`
      CREATE TRIGGER fail_draft_po BEFORE INSERT ON procurement_documents
      WHEN NEW.kind = 'purchase_order'
      BEGIN SELECT RAISE(ABORT, 'injected PO failure'); END
    `);
    assert.throws(() => store.procurement.awardRfqAndCreateDraftPurchaseOrders({
      idempotencyKey: 'rollback-award', payloadHash: 'rollback-award-hash', rfqId: rfq.id, expectedRfqVersion: 2,
      approvedBy: 'human:manager', approvedAt: '2026-08-21T02:00:00.000Z',
      lines: [{ rfqLineId: rfqLine.id, quoteLineId: quoteLine.id, awardedQuantity: 10, selectionReason: '合格且性价比最高' }],
    }), /injected PO failure/);
    assert.equal(store.procurement.listDocuments('award').length, 0);
    assert.equal(store.procurement.listDocuments('purchase_order').length, 0);
    assert.equal(store.procurement.listLines('award_line', 'award:any').length, 0);
    assert.equal(store.procurement.getDocument<RequestForQuotation>('rfq', rfq.id)?.document.status, 'pending_award');
    assert.equal(store.procurement.getDocument<RequestForQuotation>('rfq', rfq.id)?.version, 2);
    assert.equal(store.db.prepare('SELECT 1 FROM procurement_award_idempotency WHERE tenant_id=?').get(rfq.tenantId), undefined);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('供应商确认持久化与 Web 预检共享同一交期审批阈值', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:confirmation-threshold' });
    const twoDayPo = purchaseOrder('tenant:confirmation-threshold', {
      id: 'po:confirmation-two-days', externalId: 'PO-CONFIRM-2D', status: 'sent', sourceSystem: 'readywork',
    });
    const twoDayLine = poLine({
      id: 'po-line:confirmation-two-days', poId: twoDayPo.id, orderedQty: 10, unitPrice: 5,
      requestedAt: '2026-09-15T00:00:00.000Z',
    });
    store.procurement.saveDocument('purchase_order', twoDayPo);
    store.procurement.saveLine('purchase_order_line', twoDayPo.id, twoDayLine);
    const twoDays = store.procurement.executeProcurementMutation({
      action: 'record_confirmation', idempotencyKey: 'confirmation-two-days', payloadHash: 'confirmation-two-days-hash',
      actorId: 'human:buyer', permission: 'operate', aggregateId: twoDayPo.id, expectedVersion: 1, occurredAt: at,
      lines: [{ poLineId: twoDayLine.id, quantity: 10, unitPrice: 5, promisedAt: '2026-09-17T00:00:00.000Z' }],
    });
    const twoDayConfirmationLine = twoDays.createdLines[0] as PurchaseOrderConfirmationLine;
    assert.equal(twoDayConfirmationLine.promisedAtVarianceDays, 2);
    assert.equal(twoDayConfirmationLine.requiresApproval, false);
    assert.equal(twoDays.approval, undefined);
    assert.equal(twoDays.aggregate.document.status, 'confirmed');

    const threeDayPo = purchaseOrder('tenant:confirmation-threshold', {
      id: 'po:confirmation-three-days', externalId: 'PO-CONFIRM-3D', status: 'sent', sourceSystem: 'readywork',
    });
    const threeDayLine = poLine({
      id: 'po-line:confirmation-three-days', poId: threeDayPo.id, orderedQty: 10, unitPrice: 5,
      requestedAt: '2026-09-15T00:00:00.000Z',
    });
    store.procurement.saveDocument('purchase_order', threeDayPo);
    store.procurement.saveLine('purchase_order_line', threeDayPo.id, threeDayLine);
    const threeDays = store.procurement.executeProcurementMutation({
      action: 'record_confirmation', idempotencyKey: 'confirmation-three-days', payloadHash: 'confirmation-three-days-hash',
      actorId: 'human:buyer', permission: 'operate', aggregateId: threeDayPo.id, expectedVersion: 1, occurredAt: at,
      lines: [{ poLineId: threeDayLine.id, quantity: 10, unitPrice: 5, promisedAt: '2026-09-18T00:00:00.000Z' }],
    });
    const threeDayConfirmationLine = threeDays.createdLines[0] as PurchaseOrderConfirmationLine;
    assert.equal(threeDayConfirmationLine.promisedAtVarianceDays, 3);
    assert.equal(threeDayConfirmationLine.requiresApproval, true);
    assert.equal(threeDays.approval?.status, 'pending');
    assert.equal(threeDays.aggregate.document.status, 'awaiting_confirmation');
    store.close();
  } finally { temp.cleanup(); }
});

test('Odoo confirmed PO 未有供应商确认时只生成绑定真实回复的缺失单价草稿', () => {
  const temp = tmpDb();
  try {
    const tenantId = 'tenant:confirmation-clarification';
    const store = openPersistence(temp.dbPath, { tenantId });
    configureCommunicationIdentity(store.db, tenantId);
    const clarificationSupplier = supplier(tenantId, {
      id: 'supplier:confirmation-clarification',
      contacts: [{ id: 'contact:confirmation-clarification', name: '供应商联系人', email: 'supplier@supplysentry.invalid', primary: true }],
    });
    const po = purchaseOrder(tenantId, {
      id: 'po:confirmation-clarification', externalId: 'P00021', status: 'confirmed', sourceSystem: 'odoo',
      supplierId: clarificationSupplier.id,
    });
    const line = poLine({
      id: 'po-line:confirmation-clarification', poId: po.id, orderedQty: 300, unitPrice: 80,
      requestedAt: '2026-09-01T00:00:00.000Z',
    });
    const communication: Communication = {
      id: 'communication:confirmation-clarification', tenantId, sourceSystem: 'imap:163',
      externalId: '<clarification@example.com>', status: 'received', createdAt: at, updatedAt: at,
      businessObjectId: po.id, businessObjectType: 'purchase_order', supplierId: clarificationSupplier.id,
      channel: 'email', direction: 'inbound', messageId: '<clarification@example.com>', from: 'supplier@supplysentry.invalid',
      subject: 'Re: P00021', body: '确认数量 150 件，交期 2026-08-10。', attachmentIds: [], occurredAt: at, receivedAt: at,
    };
    store.procurement.saveDocument('supplier', clarificationSupplier);
    store.procurement.saveDocument('purchase_order', po);
    store.procurement.saveLine('purchase_order_line', po.id, line);
    store.procurement.saveDocument('communication', communication);

    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'queue_followup', idempotencyKey: 'clarification-wrong-mail', payloadHash: 'clarification-wrong-mail-hash',
      actorId: 'human:buyer', permission: 'operate', aggregateId: po.id, expectedVersion: 1, occurredAt: at,
      connectorId: 'email', reason: '请补充单价', supplierReference: 'communication:not-current-po',
      confirmationMissingFields: ['unit_price'],
    }), (error: unknown) => error instanceof ProcurementValidationError && /可信入站回复/.test(error.message));

    const result = store.procurement.executeProcurementMutation({
      action: 'queue_followup', idempotencyKey: 'clarification-unit-price', payloadHash: 'clarification-unit-price-hash',
      actorId: 'human:buyer', permission: 'operate', aggregateId: po.id, expectedVersion: 1, occurredAt: at,
      connectorId: 'email', reason: '请补充确认单价', supplierReference: communication.id,
      confirmationMissingFields: ['unit_price'],
    });
    assert.equal(result.aggregate.document.status, 'confirmed', 'Odoo 状态不得被草稿动作伪造推进');
    assert.equal(result.aggregate.version, 1);
    assert.equal(result.outbox, undefined);
    assert.equal(result.messageDraft?.['category'], 'acknowledgement_followup');
    assert.equal(result.messageDraft?.['sourceCommunicationId'], communication.id);
    assert.deepEqual(result.messageDraft?.['confirmationMissingFields'], ['unit_price']);
    const draftId = String(result.messageDraft?.['id']);
    const draft = store.db.prepare(`SELECT subject,body,trigger_evidence_json,status FROM procurement_message_drafts
      WHERE tenant_id=? AND id=?`).get(tenantId, draftId) as Record<string, unknown>;
    assert.equal(draft['status'], 'draft');
    assert.match(String(draft['subject']), /请补充采购订单 P00021 的确认单价/);
    assert.match(String(draft['body']), /当前仍缺少：确认单价/);
    assert.match(String(draft['body']), /QTY:300 \| UNIT_PRICE:80/);
    const evidence = JSON.parse(String(draft['trigger_evidence_json'])) as Record<string, unknown>;
    assert.equal(evidence['sourceCommunicationId'], communication.id);
    assert.deepEqual(evidence['confirmationMissingFields'], ['unit_price']);
    assert.equal(store.procurement.listDocuments('confirmation').length, 0, '草稿不得冒充供应商确认');
    store.close();
  } finally { temp.cleanup(); }
});

test('采购执行主链: 确认差异审批、累计发运收货、三单匹配与阻塞式 outbox', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:execution' });
    configureCommunicationIdentity(store.db, 'tenant:execution');
    const po = purchaseOrder('tenant:execution', { id: 'po:execution', externalId: 'PO-EXECUTION', status: 'draft', sourceSystem: 'readywork' });
    const line = poLine({ id: 'po-line:execution', poId: po.id, orderedQty: 100, unitPrice: 10, requestedAt: '2026-09-01T00:00:00.000Z' });
    store.procurement.saveDocument('supplier', supplier('tenant:execution', {
      contacts: [{ id: 'contact:execution', name: '采购联系人', email: 'supplier@supplysentry.invalid', primary: true }],
    }));
    store.procurement.saveDocument('purchase_order', po);
    store.procurement.saveLine('purchase_order_line', po.id, line);

    const blockedSend = store.procurement.executeProcurementMutation({
      action: 'send_po', idempotencyKey: 'send-blocked', payloadHash: 'send-blocked-hash', actorId: 'human:buyer', permission: 'operate',
      aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'email', connectorReady: false,
    });
    assert.equal(blockedSend.aggregate.document.status, 'draft');
    assert.equal(blockedSend.aggregate.version, 1);
    assert.equal(blockedSend.outbox?.status, 'blocked');
    const blockedReplay = store.procurement.executeProcurementMutation({
      action: 'send_po', idempotencyKey: 'send-blocked', payloadHash: 'send-blocked-hash', actorId: 'human:buyer', permission: 'operate',
      aggregateId: po.id, expectedVersion: 1, occurredAt: '2099-01-01T00:00:00.000Z', connectorId: 'email', connectorReady: true,
    });
    assert.equal(blockedReplay.replayed, true);
    assert.equal(blockedReplay.outbox?.status, 'blocked');
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'send_po', idempotencyKey: 'send-blocked', payloadHash: 'changed', actorId: 'human:buyer', permission: 'operate',
      aggregateId: po.id, expectedVersion: 1, occurredAt: at,
    }), ProcurementExecutionIdempotencyConflictError);

    const sent = store.procurement.executeProcurementMutation({
      action: 'send_po', idempotencyKey: 'send-ready', payloadHash: 'send-ready-hash', actorId: 'human:buyer', permission: 'operate',
      aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'email', connectorReady: true,
    });
    assert.equal(sent.aggregate.document.status, 'draft'); assert.equal(sent.aggregate.version, 1);
    assert.equal(sent.outbox?.status, 'pending');
    const sendClaim = store.procurement.claimOutboxMessages({
      workerId: 'worker:email', claimedAt: at, leaseDurationMs: 60_000, channel: 'email', limit: 1,
    })[0]!;
    assert.equal(sendClaim.id, sent.outbox?.id);
    store.procurement.completeOutboxMessage({
      id: sendClaim.id, leaseToken: sendClaim.leaseToken!, completedAt: '2026-08-21T00:00:01.000Z',
    });
    assert.ok(queuedTwinSources(store.db, 'tenant:execution').some((key) => key.startsWith('procurement_outbox:')));
    assert.ok(queuedTwinSources(store.db, 'tenant:execution').some((key) => key === `procurement_documents:purchase_order:${po.id}`));
    assert.ok(queuedTwinSources(store.db, 'tenant:execution').some((key) => key.startsWith('procurement_po_stage_events:')));
    assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.status, 'sent');
    assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', po.id)?.version, 2);
    const sentStageFacts = (store.db.prepare(`SELECT stage,event_type,state FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND source_kind='outbox' ORDER BY rowid`).all('tenant:execution', po.id) as Array<Record<string, unknown>>)
      .map((row) => ({ stage: row['stage'], event_type: row['event_type'], state: row['state'] }));
    assert.deepEqual(sentStageFacts, [
      { stage: 'po_sent', event_type: 'connector_delivery_confirmed', state: 'completed' },
      { stage: 'supplier_commitment', event_type: 'stage_entered', state: 'active' },
    ]);
    store.procurement.completeOutboxMessage({
      id: sendClaim.id, leaseToken: sendClaim.leaseToken!, completedAt: '2026-08-21T00:00:01.000Z',
    });
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND source_kind='outbox'`).get('tenant:execution', po.id)?.['count'], 2,
    '连接器完成回放不能重复写入阶段事实');

    const confirmation = store.procurement.executeProcurementMutation({
      action: 'record_confirmation', idempotencyKey: 'confirm', payloadHash: 'confirm-hash', actorId: 'human:buyer', permission: 'operate',
      aggregateId: po.id, expectedVersion: 2, occurredAt: at,
      lines: [{ poLineId: line.id, quantity: 100, unitPrice: 11, promisedAt: '2026-09-01T00:00:00.000Z' }],
    });
    assert.equal(confirmation.aggregate.document.status, 'awaiting_confirmation');
    assert.equal(confirmation.aggregate.version, 3);
    assert.equal(confirmation.createdLines[0] && (confirmation.createdLines[0] as any).unitPriceVariance, 1);
    assert.equal(confirmation.approval?.status, 'pending');
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND stage='supplier_commitment' AND state='completed'`).get('tenant:execution', po.id)?.['count'], 0,
    '待审批的供应商回复不能提前完成承诺阶段');
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'decide_confirmation', idempotencyKey: 'confirm-denied', payloadHash: 'confirm-denied-hash', actorId: 'human:buyer', permission: 'operate',
      aggregateId: confirmation.approval!.id, expectedVersion: 3, occurredAt: at, decision: 'approved',
    }), ProcurementExecutionPermissionError);
    const confirmed = store.procurement.executeProcurementMutation({
      action: 'decide_confirmation', idempotencyKey: 'confirm-approved', payloadHash: 'confirm-approved-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: confirmation.approval!.id, expectedVersion: 3, occurredAt: at, decision: 'approved', reason: '接受价格差异',
    });
    assert.equal(confirmed.aggregate.document.status, 'confirmed'); assert.equal(confirmed.aggregate.version, 4);
    assert.equal(store.procurement.getPurchaseOrderLineQuantityProjection(line.id)?.confirmedQty, 100);
    assert.equal(store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage='supplier_commitment' ORDER BY rowid DESC LIMIT 1`)
      .get('tenant:execution', po.id)?.['state'], 'completed');
    assert.equal(store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage='fulfilment_production' ORDER BY rowid DESC LIMIT 1`)
      .get('tenant:execution', po.id)?.['state'], 'active');

    const followup = store.procurement.executeProcurementMutation({
      action: 'queue_followup', idempotencyKey: 'followup', payloadHash: 'followup-hash', actorId: 'human:buyer', permission: 'operate',
      aggregateId: po.id, expectedVersion: 4, occurredAt: at, connectorId: 'email', connectorReady: true, reason: '请确认发货',
    });
    assert.equal(followup.aggregate.version, 4); assert.equal(followup.outbox, undefined);
    assert.equal(followup.messageDraft?.['status'], 'draft');
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_message_drafts WHERE tenant_id=? AND purchase_order_id=? AND status='draft'`)
      .get('tenant:execution', po.id)?.['count'], 1);
    const followupDraft = store.db.prepare(`SELECT body,sender_name,sender_title,sender_organization
      FROM procurement_message_drafts WHERE tenant_id=? AND purchase_order_id=? AND status='draft'`).get('tenant:execution', po.id) as Record<string, unknown>;
    assert.equal(followupDraft['sender_name'], '李娜');
    assert.equal(followupDraft['sender_title'], '高级采购专员');
    assert.equal(followupDraft['sender_organization'], '东方制造有限公司');
    assert.match(String(followupDraft['body']), /李娜\n高级采购专员｜东方制造有限公司/);
    assert.doesNotMatch(String(followupDraft['body']), /Readywork 采购执行助手|AI/);

    store.db.exec(`
      CREATE TRIGGER fail_execution_shipment_line BEFORE INSERT ON procurement_lines
      WHEN NEW.kind='shipment_line' BEGIN SELECT RAISE(ABORT, 'injected execution failure'); END
    `);
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'record_shipment', idempotencyKey: 'ship-rollback', payloadHash: 'ship-rollback-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 4, occurredAt: at, evidenceSource: 'manual_verified', supplierReference: 'ASN-ROLLBACK', evidenceReference: 'attachment:asn-rollback.pdf', reason: '已核对 ASN 附件', lines: [{ poLineId: line.id, quantity: 10 }],
    }), /injected execution failure/);
    assert.equal(store.procurement.listDocuments('shipment').length, 0);
    assert.equal(store.procurement.getPurchaseOrderLineQuantityProjection(line.id)?.shippedQty ?? 0, 0);
    assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', po.id)?.version, 4);
    assert.equal(store.db.prepare(`SELECT 1 FROM procurement_execution_idempotency WHERE tenant_id=? AND action='record_shipment' AND idempotency_key=?`).get('tenant:execution', 'ship-rollback'), undefined);
    store.db.exec('DROP TRIGGER fail_execution_shipment_line');

    const shipped60 = store.procurement.executeProcurementMutation({
      action: 'record_shipment', idempotencyKey: 'ship-60', payloadHash: 'ship-60-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 4, occurredAt: at, evidenceSource: 'manual_verified', evidenceReference: 'mail:asn-exec-001', reason: '已核对供应商 ASN 邮件', supplierReference: 'ASN-EXEC-001', carrier: 'DHL', lines: [{ poLineId: line.id, quantity: 60 }],
    });
    assert.equal(shipped60.aggregate.document.status, 'partially_shipped'); assert.equal(shipped60.aggregate.version, 5);
    assert.equal(shipped60.createdDocuments[0]?.externalId, 'ASN-EXEC-001');
    assert.equal(shipped60.createdDocuments[0]?.sourceSystem, 'readywork-manual-verification');
    assert.equal((shipped60.createdDocuments[0] as any)?.verifiedBy, 'human:manager');
    assert.equal(store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage='dispatch_transit' ORDER BY rowid DESC LIMIT 1`)
      .get('tenant:execution', po.id)?.['state'], 'active');
    assert.equal(store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage='fulfilment_production' ORDER BY rowid DESC LIMIT 1`)
      .get('tenant:execution', po.id)?.['state'], 'active', '部分发运不能提前完成履约阶段');
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'record_shipment', idempotencyKey: 'ship-duplicate-reference', payloadHash: 'ship-duplicate-reference-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 5, occurredAt: at, evidenceSource: 'manual_verified', evidenceReference: 'mail:asn-duplicate', reason: '已核对重复 ASN', supplierReference: 'ASN-EXEC-001', lines: [{ poLineId: line.id, quantity: 1 }],
    }), (error: unknown) => error instanceof ProcurementValidationError && /发运单号已存在/.test(error.message));
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'record_shipment', idempotencyKey: 'ship-over', payloadHash: 'ship-over-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 5, occurredAt: at, evidenceSource: 'manual_verified', supplierReference: 'ASN-OVER', evidenceReference: 'mail:asn-over', reason: '已核对 ASN 数量', lines: [{ poLineId: line.id, quantity: 41 }],
    }), ProcurementValidationError);
    assert.equal(store.procurement.listDocuments('shipment').length, 1, '过量发运必须全部回滚');
    const shipped40 = store.procurement.executeProcurementMutation({
      action: 'record_shipment', idempotencyKey: 'ship-40', payloadHash: 'ship-40-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 5, occurredAt: at, evidenceSource: 'manual_verified', evidenceReference: 'attachment:asn-exec-002.pdf', reason: '已核对第二批 ASN', supplierReference: 'ASN-EXEC-002', lines: [{ poLineId: line.id, quantity: 40 }],
    });
    assert.equal(shipped40.aggregate.document.status, 'shipped'); assert.equal(shipped40.aggregate.version, 6);
    assert.equal(store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage='fulfilment_production' ORDER BY rowid DESC LIMIT 1`)
      .get('tenant:execution', po.id)?.['state'], 'completed');

    const received50 = store.procurement.executeProcurementMutation({
      action: 'record_receipt', idempotencyKey: 'receive-50', payloadHash: 'receive-50-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 6, occurredAt: at, evidenceSource: 'manual_verified', evidenceReference: 'odoo:stock.picking:grn-exec-001', reason: '已核对 Odoo GRN', supplierReference: 'GRN-EXEC-001', warehouseId: 'warehouse:1', lines: [{ poLineId: line.id, quantity: 50 }],
    });
    assert.ok(queuedTwinSources(store.db, 'tenant:execution').some((key) => key.startsWith('procurement_documents:receipt:')));
    assert.ok(queuedTwinSources(store.db, 'tenant:execution').some((key) => key.startsWith('procurement_lines:receipt_line:')));
    assert.ok(queuedTwinSources(store.db, 'tenant:execution').some((key) => key.startsWith('procurement_po_line_quantity_projections:')));
    assert.equal(received50.aggregate.document.status, 'partially_received'); assert.equal(received50.aggregate.version, 7);
    assert.equal(received50.createdDocuments[0]?.externalId, 'GRN-EXEC-001');
    assert.equal(received50.createdDocuments[0]?.sourceSystem, 'readywork-manual-verification');
    assert.equal(store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage='dispatch_transit' ORDER BY rowid DESC LIMIT 1`)
      .get('tenant:execution', po.id)?.['state'], 'active', '部分到货不能提前完成整单在途阶段');
    assert.equal(store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage='delivery_grn' ORDER BY rowid DESC LIMIT 1`)
      .get('tenant:execution', po.id)?.['state'], 'active');
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'record_receipt', idempotencyKey: 'receipt-duplicate-reference', payloadHash: 'receipt-duplicate-reference-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 7, occurredAt: at, evidenceSource: 'manual_verified', evidenceReference: 'odoo:stock.picking:grn-duplicate', reason: '已核对重复 GRN', supplierReference: 'GRN-EXEC-001', warehouseId: 'warehouse:1', lines: [{ poLineId: line.id, quantity: 1 }],
    }), (error: unknown) => error instanceof ProcurementValidationError && /收货单号已存在/.test(error.message));
    const received50b = store.procurement.executeProcurementMutation({
      action: 'record_receipt', idempotencyKey: 'receive-50b', payloadHash: 'receive-50b-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 7, occurredAt: at, evidenceSource: 'manual_verified', evidenceReference: 'warehouse:grn-exec-002', reason: '已核对仓库 GRN', supplierReference: 'GRN-EXEC-002', warehouseId: 'warehouse:1', lines: [{ poLineId: line.id, quantity: 50 }],
    });
    assert.equal(received50b.aggregate.document.status, 'received'); assert.equal(received50b.aggregate.version, 8);
    assert.equal(store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage='dispatch_transit' ORDER BY rowid DESC LIMIT 1`)
      .get('tenant:execution', po.id)?.['state'], 'completed');
    assert.equal(store.db.prepare(`SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage='delivery_grn' ORDER BY rowid DESC LIMIT 1`)
      .get('tenant:execution', po.id)?.['state'], 'completed');
    const receiptLines = [...received50.createdLines, ...received50b.createdLines] as Array<any>;

    const invoiced = store.procurement.executeProcurementMutation({
      action: 'record_invoice', idempotencyKey: 'invoice', payloadHash: 'invoice-hash', actorId: 'human:ap', permission: 'operate',
      aggregateId: po.id, expectedVersion: 8, occurredAt: at, invoiceNumber: 'INV-EXEC-1', currency: 'CNY', invoiceDate: at,
      lines: [{ poLineId: line.id, quantity: 100, unitPrice: 10, netAmount: 1000, receiptAllocations: [
        { receiptLineId: receiptLines[0].id, allocatedQty: 50 }, { receiptLineId: receiptLines[1].id, allocatedQty: 50 },
      ] }],
    });
    assert.equal(invoiced.aggregate.version, 9);
    const invoice = invoiced.createdDocuments[0]!;
    assert.equal(store.procurement.getPurchaseOrderLineQuantityProjection(line.id)?.invoicedQty, 100);
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'record_invoice', idempotencyKey: 'invoice-duplicate', payloadHash: 'invoice-duplicate-hash', actorId: 'human:ap', permission: 'operate',
      aggregateId: po.id, expectedVersion: 9, occurredAt: at, invoiceNumber: 'INV-EXEC-1', currency: 'CNY', invoiceDate: at,
      lines: [{ poLineId: line.id, quantity: 1, unitPrice: 10, netAmount: 10, receiptAllocations: [{ receiptLineId: receiptLines[0].id, allocatedQty: 1 }] }],
    }), ProcurementDuplicateInvoiceError);
    assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', po.id)?.version, 9);

    const matched = store.procurement.executeProcurementMutation({
      action: 'match_invoice', idempotencyKey: 'match', payloadHash: 'match-hash', actorId: 'human:ap', permission: 'operate',
      aggregateId: invoice.id, expectedVersion: 1, occurredAt: at, poId: po.id,
      matchPolicy: {
        tolerance: { quantityPercent: 1, unitPricePercent: 1, amountPercent: 1, amountAbsolute: 1 },
        approval: { quantityPercent: 5, unitPricePercent: 5, amountPercent: 5, amountAbsolute: 100 },
      },
    });
    assert.equal(matched.aggregate.document.status, 'pending_approval'); assert.equal(matched.aggregate.version, 2);
    assert.equal((matched.createdLines[0] as any).disposition, 'exact_match');
    const ap = store.procurement.executeProcurementMutation({
      action: 'decide_ap', idempotencyKey: 'ap-approved', payloadHash: 'ap-approved-hash', actorId: 'human:finance', permission: 'approve',
      aggregateId: matched.approval!.id, expectedVersion: 2, occurredAt: at, decision: 'approved', connectorId: 'erp', connectorReady: true,
    });
    assert.equal(ap.aggregate.document.status, 'payable_approved'); assert.equal(ap.aggregate.version, 3);
    assert.equal(ap.outbox?.status, 'pending', '入队不得返回已回写');
    const erpClaim = store.procurement.claimOutboxMessages({
      workerId: 'worker:erp', claimedAt: at, leaseDurationMs: 60_000, channel: 'erp', limit: 1,
    })[0]!;
    store.procurement.completeOutboxMessage({
      id: erpClaim.id, leaseToken: erpClaim.leaseToken!, completedAt: '2026-08-21T00:00:01.000Z',
    });
    assert.equal(store.procurement.getDocument('invoice', invoice.id)?.document.status, 'erp_written');
    assert.equal(store.procurement.getDocument('invoice', invoice.id)?.version, 4);

    const closed = store.procurement.saveDocument('purchase_order', { ...store.procurement.getDocument<PurchaseOrder>('purchase_order', po.id)!.document, status: 'closed' }, 9);
    assert.equal(closed.version, 10);
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'record_receipt', idempotencyKey: 'closed-receipt', payloadHash: 'closed-receipt-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 10, occurredAt: at, evidenceSource: 'manual_verified', supplierReference: 'GRN-CLOSED', evidenceReference: 'warehouse:grn-closed', reason: '已核对关闭订单 GRN', warehouseId: 'warehouse:1', lines: [{ poLineId: line.id, quantity: 1 }],
    }), ProcurementExecutionStateConflictError);
    const tenantB = createProcurementRepository(store.db, 'tenant:other');
    assert.throws(() => tenantB.executeProcurementMutation({
      action: 'send_po', idempotencyKey: 'cross-tenant', payloadHash: 'cross-tenant-hash', actorId: 'human:other', permission: 'operate',
      aggregateId: po.id, expectedVersion: 1, occurredAt: at,
    }), ProcurementValidationError);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('短交审批必须关闭剩余量，有效数量发运与 GRN 可完整收口', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:short-delivery' });
  try {
    const po = purchaseOrder('tenant:short-delivery', { id: 'po:short', externalId: 'PO-SHORT', status: 'sent', sourceSystem: 'readywork' });
    const line = poLine({ id: 'po-line:short', poId: po.id, orderedQty: 100, unitPrice: 10 });
    store.procurement.saveDocument('purchase_order', po);
    store.procurement.saveLine('purchase_order_line', po.id, line);
    const confirmation = store.procurement.executeProcurementMutation({
      action: 'record_confirmation', idempotencyKey: 'short-confirm', payloadHash: 'short-confirm-hash', actorId: 'human:buyer', permission: 'operate',
      aggregateId: po.id, expectedVersion: 1, occurredAt: at,
      lines: [{ poLineId: line.id, quantity: 80, unitPrice: 10 }],
    });
    assert.equal(confirmation.aggregate.document.status, 'awaiting_confirmation');
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'decide_confirmation', idempotencyKey: 'short-approve-without-disposition', payloadHash: 'short-approve-without-disposition-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: confirmation.approval!.id, expectedVersion: 2, occurredAt: at, decision: 'approved', reason: '需求已调整，关闭余量',
    }), (error: unknown) => error instanceof ProcurementValidationError && /shortfallDisposition/.test(error.message));
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'decide_confirmation', idempotencyKey: 'short-approve-unknown-disposition', payloadHash: 'short-approve-unknown-disposition-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: confirmation.approval!.id, expectedVersion: 2, occurredAt: at, decision: 'approved', reason: '需求已调整，关闭余量', shortfallDisposition: 'keep_open' as never,
    }), (error: unknown) => error instanceof ProcurementValidationError && /shortfallDisposition/.test(error.message));
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'decide_confirmation', idempotencyKey: 'short-reject-with-disposition', payloadHash: 'short-reject-with-disposition-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: confirmation.approval!.id, expectedVersion: 2, occurredAt: at, decision: 'rejected', shortfallDisposition: 'cancel_remainder', reason: '拒绝短交',
    }), (error: unknown) => error instanceof ProcurementValidationError && /只允许用于批准/.test(error.message));
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'decide_confirmation', idempotencyKey: 'short-approve-without-reason', payloadHash: 'short-approve-without-reason-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: confirmation.approval!.id, expectedVersion: 2, occurredAt: at, decision: 'approved', shortfallDisposition: 'cancel_remainder', reason: '   ',
    }), (error: unknown) => error instanceof ProcurementValidationError && /短交/.test(error.message));
    assert.equal(store.procurement.getExecutionApproval(confirmation.approval!.id)?.status, 'pending', '短交处置或关闭原因缺失时审批必须整体回滚');

    const approved = store.procurement.executeProcurementMutation({
      action: 'decide_confirmation', idempotencyKey: 'short-approve', payloadHash: 'short-approve-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: confirmation.approval!.id, expectedVersion: 2, occurredAt: at, decision: 'approved', shortfallDisposition: 'cancel_remainder', reason: '需求已调整，批准关闭剩余 20 件',
    });
    assert.equal(approved.aggregate.document.status, 'confirmed');
    assert.equal(approved.approval?.shortfallDisposition, 'cancel_remainder');
    const projection = store.procurement.getPurchaseOrderLineQuantityProjection(line.id)!;
    assert.equal(projection.confirmedQty, 80);
    assert.equal(projection.cancelledQty, 20);

    const shipment = store.procurement.executeProcurementMutation({
      action: 'record_shipment', idempotencyKey: 'short-shipment', payloadHash: 'short-shipment-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 3, occurredAt: at, evidenceSource: 'manual_verified', evidenceReference: 'mail:asn-short', reason: '已核对短交 ASN', supplierReference: 'ASN-SHORT', lines: [{ poLineId: line.id, quantity: 80 }],
    });
    assert.equal(shipment.aggregate.document.status, 'shipped');
    const receipt = store.procurement.executeProcurementMutation({
      action: 'record_receipt', idempotencyKey: 'short-receipt', payloadHash: 'short-receipt-hash', actorId: 'human:manager', permission: 'approve',
      aggregateId: po.id, expectedVersion: 4, occurredAt: at, evidenceSource: 'manual_verified', evidenceReference: 'warehouse:grn-short', reason: '已核对短交 GRN', supplierReference: 'GRN-SHORT', warehouseId: 'warehouse:short', lines: [{ poLineId: line.id, quantity: 80 }],
    });
    assert.equal(receipt.aggregate.document.status, 'received');
    const evidence = store.db.prepare(`SELECT evidence_json FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=? AND stage='supplier_commitment' AND event_type='confirmation_approved'`)
      .get('tenant:short-delivery', po.id) as { evidence_json: string };
    const stageEvidence = JSON.parse(evidence.evidence_json) as Record<string, unknown>;
    assert.equal(stageEvidence['cancelledRemainderQty'], 20);
    assert.equal(stageEvidence['shortfallDisposition'], 'cancel_remainder');
  } finally { store.close(); }
});

test('procurement outbox: claim 互斥、超时租约、幂等 complete 与重试/终态失败', () => {
  const temp = tmpDb();
  try {
    const first = openPersistence(temp.dbPath, { tenantId: 'tenant:outbox' });
    const second = openPersistence(temp.dbPath, { tenantId: 'tenant:outbox' });
    configureCommunicationIdentity(first.db, 'tenant:outbox');
    const createPendingSend = (id: string, key: string) => {
      const po = purchaseOrder('tenant:outbox', { id, externalId: id, status: 'draft', sourceSystem: 'readywork' });
      first.procurement.saveDocument('purchase_order', po);
      return first.procurement.executeProcurementMutation({
        action: 'send_po', idempotencyKey: key, payloadHash: `${key}-hash`, actorId: 'human:buyer', permission: 'operate',
        aggregateId: id, expectedVersion: 1, occurredAt: at, connectorId: 'email', connectorReady: true,
      }).outbox!;
    };

    const outbox = createPendingSend('po:leased', 'leased-send');
    const firstLease = first.procurement.claimOutboxMessages({
      workerId: 'worker:first', claimedAt: at, leaseDurationMs: 1_000, limit: 1,
    })[0]!;
    assert.equal(firstLease.id, outbox.id);
    assert.equal(firstLease.attempts, 1);
    assert.equal(second.procurement.claimOutboxMessages({
      workerId: 'worker:second', claimedAt: '2026-08-21T00:00:00.500Z', leaseDurationMs: 1_000, limit: 1,
    }).length, 0, '未过期的租约不得被并发 worker 抢占');

    const reclaimed = second.procurement.claimOutboxMessages({
      workerId: 'worker:second', claimedAt: '2026-08-21T00:00:01.000Z', leaseDurationMs: 1_000, limit: 1,
    })[0]!;
    assert.equal(reclaimed.id, outbox.id);
    assert.equal(reclaimed.attempts, 2);
    assert.notEqual(reclaimed.leaseToken, firstLease.leaseToken);
    assert.throws(() => first.procurement.completeOutboxMessage({
      id: firstLease.id, leaseToken: firstLease.leaseToken!, completedAt: '2026-08-21T00:00:01.100Z',
    }), ProcurementOutboxLeaseConflictError);

    const completed = second.procurement.completeOutboxMessage({
      id: reclaimed.id, leaseToken: reclaimed.leaseToken!, completedAt: '2026-08-21T00:00:01.500Z',
    });
    const replayedComplete = first.procurement.completeOutboxMessage({
      id: reclaimed.id, leaseToken: reclaimed.leaseToken!, completedAt: '2026-08-21T00:00:01.900Z',
    });
    assert.equal(completed.status, 'dispatched');
    assert.deepEqual(replayedComplete, completed);
    assert.equal(first.procurement.getDocument<PurchaseOrder>('purchase_order', 'po:leased')?.document.status, 'sent');
    assert.equal(first.procurement.getDocument<PurchaseOrder>('purchase_order', 'po:leased')?.version, 2,
      '幂等 complete 不得重复推进聚合版本');

    const retryOutbox = createPendingSend('po:retry', 'retry-send');
    const retryLease = first.procurement.claimOutboxMessages({
      workerId: 'worker:first', claimedAt: '2026-08-21T00:00:02.000Z', leaseDurationMs: 1_000, limit: 1,
    })[0]!;
    assert.equal(retryLease.id, retryOutbox.id);
    const retry = first.procurement.failOutboxMessage({
      id: retryLease.id, leaseToken: retryLease.leaseToken!, failedAt: '2026-08-21T00:00:02.500Z',
      error: 'temporary connector failure', retryAt: '2026-08-21T00:00:04.000Z',
    });
    assert.equal(retry.status, 'pending');
    assert.equal(second.procurement.claimOutboxMessages({
      workerId: 'worker:second', claimedAt: '2026-08-21T00:00:03.999Z', leaseDurationMs: 1_000, limit: 1,
    }).length, 0);
    const terminalLease = second.procurement.claimOutboxMessages({
      workerId: 'worker:second', claimedAt: '2026-08-21T00:00:04.000Z', leaseDurationMs: 1_000, limit: 1,
    })[0]!;
    assert.equal(terminalLease.attempts, 2);
    const terminal = second.procurement.failOutboxMessage({
      id: terminalLease.id, leaseToken: terminalLease.leaseToken!, failedAt: '2026-08-21T00:00:04.500Z', error: 'permanent failure',
    });
    assert.equal(terminal.status, 'failed');
    assert.equal(first.procurement.getDocument<PurchaseOrder>('purchase_order', 'po:retry')?.document.status, 'draft');

    second.close();
    first.close();
  } finally {
    temp.cleanup();
  }
});

test('内部 PO 创建 Odoo Draft: 冻结映射、持久幂等、版本门禁与完成投影', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:odoo-draft' });
    store.procurement.saveDocument('supplier', supplier('tenant:odoo-draft', {
      sourceSystem: 'odoo', externalId: 'odoo-partner-88',
    }));
    const saveDraft = (id: string) => {
      const po = purchaseOrder('tenant:odoo-draft', {
        id, externalId: `RW-${id}`, status: 'draft', sourceSystem: 'readywork',
      });
      store.procurement.saveDocument('purchase_order', po);
      store.procurement.saveLine('purchase_order_line', id, poLine({
        id: `line:${id}`, poId: id, description: '耐高温轴承', orderedQty: 12, unitPrice: 8.5,
        requestedAt: '2026-09-01T00:00:00.000Z',
      }));
      return po;
    };

    const blockedPo = saveDraft('po:odoo-blocked');
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'create_odoo_po_draft', idempotencyKey: 'permission-denied', payloadHash: 'permission-denied-hash',
      actorId: 'human:buyer', permission: 'operate', aggregateId: blockedPo.id, expectedVersion: 1,
      occurredAt: at, connectorId: 'odoo', connectorReady: false,
    }), ProcurementExecutionPermissionError);
    const blocked = store.procurement.executeProcurementMutation({
      action: 'create_odoo_po_draft', idempotencyKey: 'odoo-blocked', payloadHash: 'odoo-blocked-hash',
      actorId: 'human:manager', permission: 'approve', aggregateId: blockedPo.id, expectedVersion: 1,
      occurredAt: at, connectorId: 'odoo', connectorReady: false,
    });
    assert.equal(blocked.outbox?.status, 'blocked');
    assert.equal(blocked.outbox?.channel, 'erp');
    assert.equal(blocked.outbox?.action, 'purchase_order.create_draft');
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'create_odoo_po_draft', idempotencyKey: 'odoo-blocked-again', payloadHash: 'odoo-blocked-again-hash',
      actorId: 'human:manager', permission: 'approve', aggregateId: blockedPo.id, expectedVersion: 1,
      occurredAt: at, connectorId: 'odoo', connectorReady: true,
    }), ProcurementExecutionSendInFlightError);

    const readyPo = saveDraft('po:odoo-ready');
    const queued = store.procurement.executeProcurementMutation({
      action: 'create_odoo_po_draft', idempotencyKey: 'odoo-ready', payloadHash: 'odoo-ready-hash',
      actorId: 'human:manager', permission: 'approve', aggregateId: readyPo.id, expectedVersion: 1,
      occurredAt: at, connectorId: 'odoo', connectorReady: true,
    });
    assert.equal(queued.outbox?.status, 'pending');
    assert.deepEqual(queued.outbox?.payload['supplierMapping'], {
      supplierId: 'supplier:1', sourceSystem: 'odoo', externalId: 'odoo-partner-88', partnerId: 88,
    });
    assert.equal(queued.outbox?.payload['poVersion'], 1);
    assert.equal(queued.outbox?.payload['currency'], 'CNY');
    assert.equal(queued.outbox?.payload['correlationKey'], 'readywork:tenant:odoo-draft:po:odoo-ready');
    assert.deepEqual(queued.outbox?.payload['lines'], [{
      poLineId: 'line:po:odoo-ready', itemId: 'item:1', description: '耐高温轴承', qty: 12,
      unitPrice: 8.5, currency: 'CNY', requestedAt: '2026-09-01T00:00:00.000Z',
    }]);
    const replay = store.procurement.executeProcurementMutation({
      action: 'create_odoo_po_draft', idempotencyKey: 'odoo-ready', payloadHash: 'odoo-ready-hash',
      actorId: 'human:manager', permission: 'approve', aggregateId: readyPo.id, expectedVersion: 1,
      occurredAt: '2099-01-01T00:00:00.000Z', connectorId: 'changed', connectorReady: false,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.outbox?.id, queued.outbox?.id);
    assert.throws(() => store.procurement.executeProcurementMutation({
      action: 'create_odoo_po_draft', idempotencyKey: 'odoo-ready-again', payloadHash: 'odoo-ready-again-hash',
      actorId: 'human:manager', permission: 'approve', aggregateId: readyPo.id, expectedVersion: 1,
      occurredAt: at, connectorId: 'odoo', connectorReady: true,
    }), ProcurementExecutionSendInFlightError);

    const claimed = store.procurement.claimOutboxMessages({
      workerId: 'worker:odoo', claimedAt: at, leaseDurationMs: 60_000, channel: 'erp', limit: 1,
    })[0]!;
    assert.equal(claimed.id, queued.outbox?.id);
    assert.throws(() => store.procurement.completeOutboxMessage({
      id: claimed.id, leaseToken: claimed.leaseToken!, completedAt: '2026-08-21T00:00:01.000Z',
      connectorResult: { id: 901, name: 'P00901', state: 'purchase', correlationKey: queued.outbox?.payload['correlationKey'] },
    }), ProcurementValidationError);
    assert.equal(store.procurement.getOutboxMessage(claimed.id)?.status, 'processing', '无效回执必须整体回滚');
    const completed = store.procurement.completeOutboxMessage({
      id: claimed.id, leaseToken: claimed.leaseToken!, completedAt: '2026-08-21T00:00:01.000Z',
      connectorResult: {
        id: 901, name: 'P00901', state: 'draft', correlationKey: 'readywork:tenant:odoo-draft:po:odoo-ready',
      },
    });
    assert.equal(completed.status, 'dispatched');
    const projected = store.procurement.getDocument<PurchaseOrder>('purchase_order', readyPo.id)!;
    assert.equal(projected.version, 2);
    assert.equal(projected.document.sourceSystem, 'readywork');
    assert.equal(projected.document.externalId, 'RW-po:odoo-ready');
    assert.deepEqual(projected.document.odooReference, {
      id: 901, name: 'P00901', correlationKey: 'readywork:tenant:odoo-draft:po:odoo-ready',
      createdAt: '2026-08-21T00:00:01.000Z',
    });
    assert.equal(store.activities.list(readyPo.id).at(-1)?.action, 'purchase_order.odoo_draft_created');
    const completedReplay = store.procurement.completeOutboxMessage({
      id: claimed.id, leaseToken: claimed.leaseToken!, completedAt: '2026-08-21T00:00:02.000Z',
      connectorResult: { id: 999, name: 'ignored', state: 'draft', correlationKey: 'wrong' },
    });
    assert.deepEqual(completedReplay, completed);
    assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', readyPo.id)?.version, 2);

    const driftedPo = saveDraft('po:odoo-drifted');
    const drifted = store.procurement.executeProcurementMutation({
      action: 'create_odoo_po_draft', idempotencyKey: 'odoo-drifted', payloadHash: 'odoo-drifted-hash',
      actorId: 'human:manager', permission: 'approve', aggregateId: driftedPo.id, expectedVersion: 1,
      occurredAt: '2026-08-21T00:00:03.000Z', connectorId: 'odoo', connectorReady: true,
    }).outbox!;
    const driftedClaim = store.procurement.claimOutboxMessages({
      workerId: 'worker:odoo', claimedAt: '2026-08-21T00:00:03.000Z', leaseDurationMs: 60_000, channel: 'erp', limit: 1,
    })[0]!;
    assert.equal(driftedClaim.id, drifted.id);
    store.procurement.saveDocument('purchase_order', { ...driftedPo, updatedAt: '2026-08-21T00:00:03.500Z' }, 1);
    assert.throws(() => store.procurement.completeOutboxMessage({
      id: driftedClaim.id, leaseToken: driftedClaim.leaseToken!, completedAt: '2026-08-21T00:00:04.000Z',
      connectorResult: {
        id: 902, name: 'P00902', state: 'draft', correlationKey: 'readywork:tenant:odoo-draft:po:odoo-drifted',
      },
    }), ProcurementExecutionVersionConflictError);
    assert.equal(store.procurement.getOutboxMessage(drifted.id)?.status, 'processing');
    assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', driftedPo.id)?.document.odooReference, undefined);

    const otherTenant = createProcurementRepository(store.db, 'tenant:other');
    assert.equal(otherTenant.getOutboxMessage(queued.outbox!.id), undefined);
    assert.throws(() => otherTenant.completeOutboxMessage({
      id: queued.outbox!.id, leaseToken: claimed.leaseToken!, completedAt: '2026-08-21T00:00:05.000Z',
    }), ProcurementValidationError);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test('Edit RIHD: 审批门禁、Odoo 冻结快照、写后回执与 PO/行/审计原子投影', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:rihd' });
  const po = purchaseOrder('tenant:rihd', {
    id: 'po:rihd', externalId: 'purchase.order:22', sourceSystem: 'odoo', status: 'confirmed',
    requiredInHouseAt: '2026-09-10T00:00:00.000Z', promisedAt: '2026-09-10T00:00:00.000Z',
    number: 'P00022',
  } as Partial<PurchaseOrder> & Record<string, unknown>);
  const line = poLine({
    id: 'po-line:rihd', poId: po.id, lineNumber: '91', orderedQty: 8,
    requestedAt: '2026-09-10T00:00:00.000Z',
  });
  store.procurement.saveDocument('purchase_order', po);
  store.procurement.saveLine('purchase_order_line', po.id, line);
  const mutation = {
    action: 'update_rihd' as const, idempotencyKey: 'rihd-1', payloadHash: 'rihd-hash-1', actorId: 'human:manager',
    permission: 'approve' as const, aggregateId: po.id, expectedVersion: 1, occurredAt: at,
    connectorId: 'erp', connectorReady: true, requiredInHouseAt: '2026-09-30T00:00:00.000Z', reason: '项目需求日已批准调整',
  };
  assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, permission: 'operate' }), ProcurementExecutionPermissionError);
  assert.throws(() => store.procurement.executeProcurementMutation({
    ...mutation, idempotencyKey: 'rihd-same', payloadHash: 'rihd-same', requiredInHouseAt: '2026-09-10T08:00:00.000Z',
  }), ProcurementValidationError);
  const queued = store.procurement.executeProcurementMutation(mutation);
  assert.equal(queued.outbox?.action, 'purchase_order.update_rihd');
  assert.equal(queued.outbox?.status, 'pending');
  assert.deepEqual(queued.outbox?.payload['odooMapping'], {
    sourceSystem: 'odoo', externalId: 'purchase.order:22', odooId: 22, poNumber: 'P00022',
  });
  assert.equal(queued.outbox?.payload['previousRequiredInHouseAt'], '2026-09-10T00:00:00.000Z');
  assert.deepEqual(queued.outbox?.payload['lines'], [{
    poLineId: line.id, lineNumber: '91', orderedQty: 8, requestedAt: '2026-09-10T00:00:00.000Z',
  }]);
  assert.throws(() => store.procurement.executeProcurementMutation({
    ...mutation, idempotencyKey: 'rihd-2', payloadHash: 'rihd-hash-2',
  }), ProcurementExecutionSendInFlightError);
  assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.requiredInHouseAt, '2026-09-10T00:00:00.000Z');

  const claimed = store.procurement.claimOutboxMessages({ workerId: 'worker:rihd', claimedAt: at, leaseDurationMs: 60_000, channel: 'erp' })[0]!;
  assert.throws(() => store.procurement.completeOutboxMessage({
    id: claimed.id, leaseToken: claimed.leaseToken!, completedAt: '2026-08-21T00:00:01.000Z',
    connectorResult: { po_name: 'P00022', required_in_house_at: '2026-09-30T00:00:00.000Z', updated_lines: 1, verified_lines: 2 },
  }), ProcurementValidationError);
  assert.equal(store.procurement.getOutboxMessage(claimed.id)?.status, 'processing');
  const completed = store.procurement.completeOutboxMessage({
    id: claimed.id, leaseToken: claimed.leaseToken!, completedAt: '2026-08-21T00:00:01.000Z',
    connectorResult: {
      po_name: 'P00022', required_in_house_at: '2026-09-30T00:00:00.000Z', updated_lines: 1, verified_lines: 1,
      credential: { credentialId: 'credential:erp', credentialVersion: 'v2', lastTestedAt: at },
    },
  });
  assert.equal(completed.status, 'dispatched');
  const updated = store.procurement.getDocument<PurchaseOrder>('purchase_order', po.id)!;
  assert.equal(updated.version, 2);
  assert.equal(updated.document.requiredInHouseAt, '2026-09-30T00:00:00.000Z');
  assert.equal(updated.document.promisedAt, '2026-09-30T00:00:00.000Z');
  assert.equal(store.procurement.getLine<PurchaseOrderLine>('purchase_order_line', line.id)?.requestedAt, '2026-09-30T00:00:00.000Z');
  const activity = store.activities.list(po.id).at(-1)!;
  assert.equal(activity.action, 'purchase_order.rihd_updated');
  assert.equal(activity.context?.['outboxId'], claimed.id);
  assert.deepEqual(completed.connectorResult?.['credential'], { credentialId: 'credential:erp', credentialVersion: 'v2', lastTestedAt: at });
  store.close();
});

test('document jobs: attachment security defaults, durable lease, retry and parsed result', () => {
  const temp = tmpDb();
  try {
    const first = openPersistence(temp.dbPath, { tenantId: 'tenant:documents' });
    const second = openPersistence(temp.dbPath, { tenantId: 'tenant:documents' });
    first.db.prepare(`INSERT INTO procurement_attachments
      (tenant_id,id,requisition_id,requisition_line_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,
       extraction_status,extracted_text_preview,content,status,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'tenant:documents', 'attachment:1', 'req:1', null, 'drawing.pdf', 'application/pdf', 3,
      'a'.repeat(64), 1, null, 'ready_for_document_agent', null, Buffer.from('pdf'), 'active', 'human:buyer', at,
    );
    const security = first.db.prepare(`SELECT security_status,processing_status FROM procurement_attachments WHERE tenant_id=? AND id=?`)
      .get('tenant:documents', 'attachment:1') as { security_status: string; processing_status: string };
    assert.equal(security.security_status, 'pending_scan');
    assert.equal(security.processing_status, 'not_queued');

    const enqueued = first.procurement.enqueueDocumentJob({ attachmentId: 'attachment:1', id: 'document-job:1', maxAttempts: 2, availableAt: at });
    assert.equal(enqueued.status, 'queued');
    assert.equal(first.procurement.enqueueDocumentJob({ attachmentId: 'attachment:1' }).id, enqueued.id, 'same immutable attachment must not create competing parse jobs');
    const lease = first.procurement.claimDocumentJobs({ workerId: 'worker:first', claimedAt: at, leaseDurationMs: 1_000 })[0]!;
    assert.equal(lease.status, 'processing');
    assert.equal(lease.attempts, 1);
    assert.equal(second.procurement.claimDocumentJobs({ workerId: 'worker:second', claimedAt: '2026-08-21T00:00:00.500Z', leaseDurationMs: 1_000 }).length, 0);
    const retry = first.procurement.failDocumentJob({ id: lease.id, lockToken: lease.lockToken!, failedAt: '2026-08-21T00:00:00.600Z', error: 'temporary parser fault', retryAt: '2026-08-21T00:00:02.000Z' });
    assert.equal(retry.status, 'queued');
    assert.equal(second.procurement.claimDocumentJobs({ workerId: 'worker:second', claimedAt: '2026-08-21T00:00:01.999Z', leaseDurationMs: 1_000 }).length, 0);
    const retryLease = second.procurement.claimDocumentJobs({ workerId: 'worker:second', claimedAt: '2026-08-21T00:00:02.000Z', leaseDurationMs: 1_000 })[0]!;
    assert.equal(retryLease.attempts, 2);
    const completed = second.procurement.completeDocumentJob({
      id: retryLease.id, lockToken: retryLease.lockToken!, completedAt: '2026-08-21T00:00:02.100Z',
      detectedContentType: 'application/pdf', extractedTextPreview: '采购图纸 Rev.C', result: { pages: 1, fields: { material: 'AL6061' } },
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.['pages'], 1);
    const attachment = first.db.prepare(`SELECT security_status,processing_status,detected_content_type,parse_error,parsed_at,extracted_text_preview
      FROM procurement_attachments WHERE tenant_id=? AND id=?`).get('tenant:documents', 'attachment:1') as Record<string, string | null>;
    assert.equal(attachment['security_status'], 'pending_scan', 'successful parsing must not pretend the file was malware-scanned');
    assert.equal(attachment['processing_status'], 'parsed');
    assert.equal(attachment['detected_content_type'], 'application/pdf');
    assert.equal(attachment['extracted_text_preview'], '采购图纸 Rev.C');
    assert.equal(attachment['parse_error'], null);
    assert.equal(attachment['parsed_at'], '2026-08-21T00:00:02.100Z');
    second.close(); first.close();
  } finally { temp.cleanup(); }
});

test('人工标记采购订单风险: operate 权限、校验、原子异常活动与租户幂等隔离', () => {
  const temp = tmpDb();
  try {
    const tenantId = 'tenant:mark-risk';
    const store = openPersistence(temp.dbPath, { tenantId });
    const po = purchaseOrder(tenantId, {
      id: 'po:mark-risk', externalId: 'PO-MARK-RISK', status: 'confirmed',
    });
    store.procurement.saveDocument('purchase_order', po);
    const mutation = {
      action: 'mark_at_risk' as const,
      idempotencyKey: 'mark-risk:1',
      payloadHash: 'mark-risk:payload:1',
      actorId: 'human:buyer',
      permission: 'operate' as const,
      aggregateId: po.id,
      expectedVersion: 1,
      occurredAt: at,
      riskSeverity: 'high' as const,
      riskCategory: 'schedule' as const,
      reason: '供应商尚未确认关键交付节点',
      recommendedAction: '今日与供应商确认恢复计划并指定负责人',
    };
    const count = (table: 'runtime_exceptions' | 'runtime_activities' | 'procurement_execution_idempotency') =>
      (store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id=?`).get(tenantId) as { count: number }).count;

    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, permission: 'read' as never }), ProcurementExecutionPermissionError);
    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, idempotencyKey: 'mark-risk:bad-version', payloadHash: 'bad-version', expectedVersion: 2 }), ProcurementExecutionVersionConflictError);
    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, idempotencyKey: 'mark-risk:bad-severity', payloadHash: 'bad-severity', riskSeverity: 'low' as never }), ProcurementValidationError);
    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, idempotencyKey: 'mark-risk:bad-category', payloadHash: 'bad-category', riskCategory: 'inventory' as never }), ProcurementValidationError);
    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, idempotencyKey: 'mark-risk:short-reason', payloadHash: 'short-reason', reason: '短' }), ProcurementValidationError);
    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, idempotencyKey: 'mark-risk:short-action', payloadHash: 'short-action', recommendedAction: '短' }), ProcurementValidationError);
    assert.deepEqual([count('runtime_exceptions'), count('runtime_activities'), count('procurement_execution_idempotency')], [0, 0, 0], 'failed writes must be atomic');

    const marked = store.procurement.executeProcurementMutation(mutation);
    assert.equal(marked.replayed, false);
    assert.equal(marked.aggregate.version, 1);
    assert.equal(marked.aggregate.document.status, 'confirmed');
    assert.equal(marked.exception?.type, 'manual_purchase_order_risk');
    assert.equal(marked.exception?.status, 'assigned');
    assert.equal(marked.exception?.context?.['source'], 'human_mark_at_risk');
    assert.equal(marked.exception?.context?.['category'], 'schedule');
    assert.equal(marked.exception?.context?.['purchaseOrderVersion'], 1);
    const activity = store.db.prepare(`SELECT json FROM runtime_activities WHERE tenant_id=? AND object_id=?`).get(tenantId, po.id) as { json: string };
    assert.equal(JSON.parse(activity.json)['action'], 'purchase_order.marked_at_risk');
    assert.equal(JSON.parse(activity.json)['context']['exceptionId'], marked.exception?.id);
    assert.deepEqual([count('runtime_exceptions'), count('runtime_activities'), count('procurement_execution_idempotency')], [1, 1, 1]);

    const replay = store.procurement.executeProcurementMutation(mutation);
    assert.equal(replay.replayed, true);
    assert.equal(replay.exception?.id, marked.exception?.id);
    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, payloadHash: 'mark-risk:changed-payload' }), ProcurementExecutionIdempotencyConflictError);
    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, idempotencyKey: 'mark-risk:duplicate', payloadHash: 'mark-risk:duplicate-payload' }), ProcurementExecutionStateConflictError);
    assert.deepEqual([count('runtime_exceptions'), count('runtime_activities'), count('procurement_execution_idempotency')], [1, 1, 1]);
    assert.equal(store.db.prepare(`SELECT 1 FROM procurement_execution_idempotency WHERE tenant_id=? AND action='mark_at_risk' AND idempotency_key=?`)
      .get(tenantId, 'mark-risk:duplicate'), undefined, 'state-conflicted mutations cannot reserve a new key');

    const otherTenantId = 'tenant:mark-risk-b';
    const otherTenant = createProcurementRepository(store.db, otherTenantId);
    otherTenant.saveDocument('purchase_order', { ...po, tenantId: otherTenantId, externalId: 'PO-MARK-RISK-B' });
    const isolated = otherTenant.executeProcurementMutation({
      ...mutation, idempotencyKey: 'mark-risk:b:1', payloadHash: 'mark-risk:b:payload:1', actorId: 'human:buyer-b',
    });
    assert.equal(isolated.replayed, false);
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM runtime_exceptions WHERE tenant_id=?`).get(otherTenantId) as { count: number }).count, 1);
    store.close();
  } finally { temp.cleanup(); }
});

test('复制采购订单: 单事务生成独立 Draft、新行、阶段事件、双向活动与幂等回放', () => {
  const temp = tmpDb();
  try {
    const tenantId = 'tenant:duplicate-po';
    const store = openPersistence(temp.dbPath, { tenantId });
    const sourceSupplier = supplier(tenantId, { id: 'supplier:duplicate-po', externalId: 'supplier-duplicate-po' });
    store.procurement.saveDocument('supplier', sourceSupplier);
    const source = purchaseOrder(tenantId, {
      id: 'po:duplicate-source', externalId: 'purchase.order:701', sourceSystem: 'odoo', status: 'received',
      supplierId: sourceSupplier.id,
      awardId: 'award:must-not-copy', requiredInHouseAt: '2026-09-10T00:00:00.000Z',
      odooReference: { id: 701, name: 'P00701', correlationKey: 'old-correlation', createdAt: at },
    }) as PurchaseOrder & { number: string };
    const sourceWithNumber = { ...source, number: 'P00701' };
    const sourceLines: PurchaseOrderLine[] = [
      poLine({ id: 'po-line:duplicate-10', poId: source.id, lineNumber: '10', itemId: 'VALVE-A', description: '气动阀', orderedQty: 20, unitPrice: 80, requestedAt: '2026-09-10T00:00:00.000Z', requisitionLineId: 'req-line:10', awardLineId: 'award-line:10', quoteLineId: 'quote-line:10', rfqLineId: 'rfq-line:10' }),
      poLine({ id: 'po-line:duplicate-20', poId: source.id, lineNumber: '20', itemId: 'FILTER-B', description: '过滤器', orderedQty: 8, unitPrice: 25, requestedAt: '2026-09-12T00:00:00.000Z' }),
    ];
    store.procurement.saveDocument('purchase_order', sourceWithNumber);
    for (const line of sourceLines) store.procurement.saveLine('purchase_order_line', source.id, line);
    const sourceBefore = store.procurement.getDocument<PurchaseOrder>('purchase_order', source.id)!;
    const mutation = {
      action: 'duplicate_po' as const,
      idempotencyKey: 'duplicate-po:1',
      payloadHash: 'duplicate-po:payload:1',
      actorId: 'human:buyer',
      permission: 'operate' as const,
      aggregateId: source.id,
      expectedVersion: 1,
      occurredAt: '2026-09-01T03:04:05.000Z',
      purchaseOrderNumber: 'PO-NEW-2026-0901',
      requiredInHouseAt: '2026-10-01T00:00:00.000Z',
      reason: '同一物料的新采购批次，需保留原单价与数量',
    };

    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, permission: 'read' as never }), ProcurementExecutionPermissionError);
    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, idempotencyKey: 'duplicate-po:bad-version', payloadHash: 'duplicate-po:bad-version', expectedVersion: 2 }), ProcurementExecutionVersionConflictError);
    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, idempotencyKey: 'duplicate-po:short-reason', payloadHash: 'duplicate-po:short-reason', reason: '短' }), ProcurementValidationError);
    assert.throws(() => store.procurement.executeProcurementMutation({
      ...mutation, aggregateId: 'po:not-found', idempotencyKey: 'duplicate-po:not-found', payloadHash: 'duplicate-po:not-found',
    }), (error: unknown) => error instanceof ProcurementValidationError && error.code === 'PO_NOT_FOUND');

    const existingNumberPo = purchaseOrder(tenantId, { id: 'po:existing-number', sourceSystem: 'odoo', externalId: 'purchase.order:702' }) as PurchaseOrder & { number: string };
    store.procurement.saveDocument('purchase_order', { ...existingNumberPo, number: 'PO-EXISTING-NUMBER' });
    assert.throws(() => store.procurement.executeProcurementMutation({
      ...mutation, idempotencyKey: 'duplicate-po:existing-number', payloadHash: 'duplicate-po:existing-number', purchaseOrderNumber: 'po-existing-number',
    }), (error: unknown) => error instanceof ProcurementValidationError && error.code === 'DUPLICATE_PO_NUMBER');

    const documentCountBeforeRollback = store.procurement.listDocuments('purchase_order').length;
    const activityCountBeforeRollback = Number(store.db.prepare(`SELECT COUNT(*) AS count FROM runtime_activities WHERE tenant_id=?`).get(tenantId)?.['count']);
    store.db.exec(`CREATE TRIGGER fail_duplicate_purchase_order_line BEFORE INSERT ON procurement_lines
      WHEN NEW.kind='purchase_order_line' AND json_extract(NEW.json,'$.poId') LIKE 'purchase-order:readywork:%'
      BEGIN SELECT RAISE(ABORT, 'injected duplicate line failure'); END`);
    assert.throws(() => store.procurement.executeProcurementMutation({
      ...mutation, idempotencyKey: 'duplicate-po:rollback', payloadHash: 'duplicate-po:rollback', purchaseOrderNumber: 'PO-ROLLBACK',
    }), /injected duplicate line failure/);
    store.db.exec('DROP TRIGGER fail_duplicate_purchase_order_line');
    assert.equal(store.procurement.listDocuments('purchase_order').length, documentCountBeforeRollback);
    assert.equal(Number(store.db.prepare(`SELECT COUNT(*) AS count FROM runtime_activities WHERE tenant_id=?`).get(tenantId)?.['count']), activityCountBeforeRollback);
    assert.equal(store.db.prepare(`SELECT 1 FROM procurement_execution_idempotency WHERE tenant_id=? AND action='duplicate_po' AND idempotency_key='duplicate-po:rollback'`).get(tenantId), undefined);

    const created = store.procurement.executeProcurementMutation(mutation);
    assert.equal(created.replayed, false);
    assert.equal(created.aggregate.document.id, source.id);
    assert.equal(created.aggregate.version, 1);
    assert.equal(created.createdDocuments.length, 1);
    assert.equal(created.createdLines.length, 2);
    const duplicate = created.createdDocuments[0] as PurchaseOrder;
    assert.equal(duplicate.sourceSystem, 'readywork');
    assert.equal(duplicate.externalId, 'PO-NEW-2026-0901');
    assert.equal(duplicate.status, 'draft');
    assert.equal(duplicate.requiredInHouseAt, '2026-10-01T00:00:00.000Z');
    assert.equal(duplicate.awardId, undefined);
    assert.equal(duplicate.odooReference, undefined);
    assert.deepEqual(duplicate.duplicatedFrom, {
      purchaseOrderId: source.id,
      purchaseOrderVersion: 1,
      purchaseOrderNumber: 'P00701',
      originalOrderedAt: source.orderedAt,
      duplicatedBy: 'human:buyer',
      duplicatedAt: mutation.occurredAt,
      reason: mutation.reason,
    });
    const copiedLines = created.createdLines as PurchaseOrderLine[];
    assert.deepEqual(copiedLines.map((line) => line.lineNumber), ['10', '20']);
    assert.ok(copiedLines.every((line) => line.poId === duplicate.id && line.requestedAt === mutation.requiredInHouseAt));
    assert.ok(copiedLines.every((line) => !sourceLines.some((sourceLine) => sourceLine.id === line.id)), '复制行必须使用全新 ID');
    assert.equal(copiedLines[0]?.requisitionLineId, undefined);
    assert.equal(copiedLines[0]?.awardLineId, undefined);
    assert.equal(copiedLines[0]?.quoteLineId, undefined);
    assert.equal(copiedLines[0]?.rfqLineId, undefined);
    assert.deepEqual(store.procurement.getDocument<PurchaseOrder>('purchase_order', source.id), sourceBefore, '源 PO 不得改变');
    assert.equal(store.procurement.listLines<PurchaseOrderLine>('purchase_order_line', source.id).length, 2);
    assert.equal(store.procurement.listLines<PurchaseOrderLine>('purchase_order_line', duplicate.id).length, 2);
    const stage = store.db.prepare(`SELECT stage,event_type,state,source_kind,evidence_json FROM procurement_po_stage_events
      WHERE tenant_id=? AND po_id=?`).get(tenantId, duplicate.id) as Record<string, unknown>;
    assert.deepEqual([stage['stage'], stage['event_type'], stage['state'], stage['source_kind']], ['po_sent', 'draft_created_from_duplicate', 'active', 'human_action']);
    assert.equal(JSON.parse(String(stage['evidence_json']))['sourcePurchaseOrderId'], source.id);
    const sourceActivity = JSON.parse(String((store.db.prepare(`SELECT json FROM runtime_activities WHERE tenant_id=? AND object_id=? AND json_extract(json,'$.action')='purchase_order.duplicated'`).get(tenantId, source.id) as { json: string }).json));
    const targetActivity = JSON.parse(String((store.db.prepare(`SELECT json FROM runtime_activities WHERE tenant_id=? AND object_id=? AND json_extract(json,'$.action')='purchase_order.created_from_duplicate'`).get(tenantId, duplicate.id) as { json: string }).json));
    assert.equal(sourceActivity['context']['duplicatedPurchaseOrderId'], duplicate.id);
    assert.equal(targetActivity['context']['sourcePurchaseOrderId'], source.id);
    assert.equal(store.db.prepare(`SELECT 1 FROM procurement_execution_idempotency WHERE tenant_id=? AND action='duplicate_po' AND idempotency_key=?`).get(tenantId, mutation.idempotencyKey)?.['1'], 1);

    const replay = store.procurement.executeProcurementMutation(mutation);
    assert.equal(replay.replayed, true);
    assert.equal(replay.createdDocuments[0]?.id, duplicate.id);
    assert.equal(store.procurement.listDocuments('purchase_order').filter(({ document }) => document.externalId === mutation.purchaseOrderNumber).length, 1);
    assert.throws(() => store.procurement.executeProcurementMutation({ ...mutation, payloadHash: 'duplicate-po:changed-payload' }), ProcurementExecutionIdempotencyConflictError);

    const otherTenantId = 'tenant:duplicate-po-b';
    const otherTenant = createProcurementRepository(store.db, otherTenantId);
    otherTenant.saveDocument('supplier', { ...sourceSupplier, tenantId: otherTenantId, externalId: 'supplier-duplicate-po-b' });
    otherTenant.saveDocument('purchase_order', { ...sourceWithNumber, tenantId: otherTenantId, externalId: 'purchase.order:801', number: 'P00801' });
    for (const line of sourceLines) otherTenant.saveLine('purchase_order_line', source.id, { ...line, id: `${line.id}:b` });
    const isolated = otherTenant.executeProcurementMutation({ ...mutation, idempotencyKey: 'duplicate-po:b:1', payloadHash: 'duplicate-po:b:1', actorId: 'human:buyer-b' });
    assert.equal(isolated.createdDocuments[0]?.externalId, mutation.purchaseOrderNumber, '不同租户可使用同一业务 PO 编号');
    store.close();
  } finally { temp.cleanup(); }
});
