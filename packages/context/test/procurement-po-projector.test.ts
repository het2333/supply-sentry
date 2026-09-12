import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  Award,
  AwardLine,
  Communication,
  ProductionProgress,
  ProductionProgressLine,
  PurchaseOrder,
  PurchaseOrderConfirmation,
  PurchaseOrderConfirmationLine,
  PurchaseOrderLine,
  Receipt,
  ReceiptLine,
  RequestForQuotation,
  RequestForQuotationLine,
  Shipment,
  ShipmentLine,
  Supplier,
  SupplierInvoice,
  SupplierInvoiceLine,
  SupplierQuote,
  SupplierQuoteLine,
  TransportEvent,
  TwinEntity,
  TwinEvidence,
} from '@readywork/core';
import { openPersistence, type PersistenceStore } from '@readywork/persistence';
import {
  enqueuePurchaseOrderBackfill,
  purchaseOrderMissingFacts,
  ProcurementPoProjector,
  SqliteManufacturingContextStore,
  SqliteTwinProjectionQueue,
} from '../src/index.js';

const at = '2026-08-29T00:00:00.000Z';

function seedPoSourcingChain(
  store: PersistenceStore,
  input: { poId: string; supplierId: string; itemId: string; status: PurchaseOrder['status'] },
): void {
  const common = { tenantId: store.tenantId, sourceSystem: 'readywork', createdAt: at, updatedAt: at };
  const supplier: Supplier = {
    ...common, id: input.supplierId, externalId: 'SUP-1', status: 'active', name: '上海卓越阀门', currency: 'CNY', contacts: [],
  };
  const rfq: RequestForQuotation = {
    ...common, id: 'rfq:1', externalId: 'RFQ-1', status: 'awarded', buyerId: 'human:buyer',
    supplierIds: [supplier.id], currency: 'CNY', quoteDueAt: at,
  };
  const rfqLine: RequestForQuotationLine = {
    id: 'rfq-line:1', rfqId: rfq.id, lineNumber: '10', itemId: input.itemId, uom: '件', requestedQty: 200,
  };
  const quote: SupplierQuote = {
    ...common, id: 'quote:1', externalId: 'QUOTE-1', status: 'received', rfqId: rfq.id,
    supplierId: supplier.id, currency: 'CNY', receivedAt: at,
  };
  const quoteLine: SupplierQuoteLine = {
    id: 'quote-line:1', quoteId: quote.id, rfqLineId: rfqLine.id, lineNumber: '10', itemId: input.itemId,
    uom: '件', quotedQty: 200, unitPrice: 127,
  };
  const award: Award = {
    ...common, id: 'award:1', externalId: 'AWARD-1', status: 'approved', rfqId: rfq.id,
    approvedBy: 'human:manager', approvedAt: at,
  };
  const awardLine: AwardLine = {
    id: 'award-line:1', awardId: award.id, rfqLineId: rfqLine.id, quoteLineId: quoteLine.id,
    supplierId: supplier.id, lineNumber: '10', itemId: input.itemId, uom: '件', awardedQty: 200,
    unitPrice: 127, currency: 'CNY', selectionReason: '批准报价',
  };
  const po: PurchaseOrder = {
    ...common, id: input.poId, externalId: input.poId, status: input.status, awardId: award.id,
    supplierId: supplier.id, currency: 'CNY', orderedAt: at,
  };
  const poLine: PurchaseOrderLine = {
    id: 'po-line:1', poId: po.id, awardLineId: awardLine.id, quoteLineId: quoteLine.id,
    rfqLineId: rfqLine.id, lineNumber: '10', itemId: input.itemId,
    description: '气动阀 PV-30，按制造规格验收', uom: '件', orderedQty: 200,
    unitPrice: 127, currency: 'CNY',
  };
  store.procurement.saveDocument('supplier', supplier);
  store.procurement.saveDocument('rfq', rfq);
  store.procurement.saveLine('rfq_line', rfq.id, rfqLine);
  store.procurement.saveDocument('quote', quote);
  store.procurement.saveLine('quote_line', quote.id, quoteLine);
  store.procurement.saveDocument('award', award);
  store.procurement.saveLine('award_line', award.id, awardLine);
  store.procurement.saveDocument('purchase_order', po);
  store.procurement.saveLine('purchase_order_line', po.id, poLine);
}

function copyAsLegacyUnscopedEvidence(
  context: SqliteManufacturingContextStore,
  entity: TwinEntity,
  scoped: TwinEvidence,
  factPath: string,
): TwinEvidence {
  const value = { ...(scoped.value as Record<string, unknown>) };
  delete value.contextRootEntityId;
  return context.appendEvidence({
    entityId: entity.id,
    sourceSemantics: scoped.sourceSemantics,
    sourceKind: scoped.sourceKind,
    sourceId: scoped.sourceId,
    sourceVersion: scoped.sourceVersion,
    sourceHash: scoped.sourceHash,
    factPath,
    value,
    confidence: scoped.confidence,
    effectiveAt: scoped.effectiveAt,
    observedAt: scoped.observedAt,
    actorId: scoped.actorId,
    rawReference: scoped.rawReference,
  });
}

function claimPurchaseOrderBackfills(queue: SqliteTwinProjectionQueue, limit = 1) {
  return queue.claim({ workerId: 'projector:1', claimedAt: at, leaseDurationMs: 30_000, limit: 500 })
    .filter((job) => job.eventType === 'purchase_order.backfill')
    .slice(0, limit);
}

test('PO projector links the sourcing chain and does not invent unobserved fulfilment facts', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  seedPoSourcingChain(store, { poId: 'po:1', supplierId: 'supplier:1', itemId: 'PV-30', status: 'sent' });
  const queue = new SqliteTwinProjectionQueue(store.db, 'tenant:a');
  const context = new SqliteManufacturingContextStore(store.db, 'tenant:a');

  enqueuePurchaseOrderBackfill(store.db, 'tenant:a', at);
  const job = claimPurchaseOrderBackfills(queue)[0]!;
  new ProcurementPoProjector(store.db, 'tenant:a', context).project(job);

  const root = context.getByBusinessObjectId('po:1')!;
  const graph = context.getNeighborhood(root.id, { depth: 2, entityLimit: 500, evidenceLimit: 2_000 });
  assert.ok(graph.entities.some((entity) => entity.entityType === 'supplier'));
  assert.ok(graph.entities.some((entity) => entity.entityType === 'award'));
  assert.ok(graph.entities.some((entity) => entity.entityType === 'quote'));
  assert.ok(graph.entities.some((entity) => entity.entityType === 'rfq'));
  assert.ok(graph.entities.some((entity) => entity.entityType === 'material'));
  assert.deepEqual(root.state.missingFacts, [
    'odoo_purchase_order', 'supplier_confirmation', 'production_progress', 'shipment', 'grn',
  ]);
  assert.equal(graph.entities.some((entity) => entity.entityType === 'receipt'), false);
  assert.deepEqual(
    new Set(graph.relations.map((relation) => relation.relationType)),
    new Set(['ordered_from', 'contains_line', 'for_material', 'created_from_award', 'selected_quote', 'sourced_from_rfq']),
  );
  store.close();
});

test('PO projector emits source-valid field facts including the 127 CNY line price', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  seedPoSourcingChain(store, { poId: 'po:1', supplierId: 'supplier:1', itemId: 'PV-30', status: 'sent' });
  const receipt = {
    id: 'outbox:verified-send', tenantId: 'tenant:a', channel: 'email', connectorId: 'smtp:1',
    action: 'purchase_order.send', aggregateId: 'po:1', idempotencyKey: 'send:verified', status: 'dispatched',
    payload: { poId: 'po:1' }, attempts: 1, dispatchedAt: at,
    connectorResult: { message_id: 'message:verified', accepted_at: at, delivery_status: 'sent' },
    createdAt: at, updatedAt: at,
  };
  store.db.prepare(`INSERT INTO procurement_outbox
    (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,created_at,updated_at,
     attempt,dispatched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'tenant:a', receipt.id, receipt.channel, receipt.connectorId, receipt.action, receipt.aggregateId,
    receipt.idempotencyKey, receipt.status, JSON.stringify(receipt.payload), JSON.stringify(receipt), at, at, 1, at,
  );
  const queue = new SqliteTwinProjectionQueue(store.db, 'tenant:a');
  enqueuePurchaseOrderBackfill(store.db, 'tenant:a', at);
  const job = claimPurchaseOrderBackfills(queue)[0]!;
  const context = new SqliteManufacturingContextStore(store.db, 'tenant:a');
  const projector = new ProcurementPoProjector(store.db, 'tenant:a', context);
  projector.project(job);
  const root = context.getByBusinessObjectId('po:1')!;
  const line = context.getByBusinessObjectId('po-line:1')!;
  assert.deepEqual(line.state, { orderedQty: 200, unitPrice: 127, currency: 'CNY', uom: '件' });
  const fieldFacts = context.getNeighborhood(root.id, { depth: 2, entityLimit: 500, evidenceLimit: 2_000 }).evidence
    .filter((item) => ['purchase_order.status', 'po_line.ordered_qty', 'po_line.unit_price', 'po_line.currency', 'po_line.uom'].includes(item.factPath));
  assert.deepEqual(new Set(fieldFacts.map((item) => item.factPath)), new Set([
    'purchase_order.status', 'po_line.ordered_qty', 'po_line.unit_price', 'po_line.currency', 'po_line.uom',
  ]));
  assert.ok(fieldFacts.every((item) => {
    const reference = item.rawReference;
    return typeof item.sourceVersion === 'string' && item.sourceVersion.length > 0
      && typeof item.sourceHash === 'string' && item.sourceHash.length === 64
      && Object.keys(reference).sort().join(',') === 'contentHash,primaryKey,sourceVersion,table';
  }));
  assert.equal(context.resolveFact(line.id, 'po_line.unit_price')?.value, 127);
  assert.equal(context.resolveFact(line.id, 'po_line.currency')?.value, 'CNY');
  assert.equal(context.resolveFact(line.id, 'po_line.uom')?.value, '件');
  assert.equal(context.resolveFact(root.id, 'purchase_order.status')?.evidence.sourceSemantics, 'verified_external');
  assert.equal(context.resolveFact(root.id, 'purchase_order.status')?.evidence.priority, 400);
  context.appendEvidence({
    entityId: root.id, sourceSemantics: 'approved_human', sourceKind: 'approval', sourceId: 'approval:status',
    sourceVersion: '1', sourceHash: 'hash:approved-status', factPath: 'purchase_order.status', value: 'confirmed',
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'human:manager', rawReference: {},
  });
  assert.equal(context.resolveFact(root.id, 'purchase_order.status')?.value, 'sent');
  assert.deepEqual(root.state.missingFacts, ['odoo_purchase_order', 'supplier_confirmation', 'production_progress', 'shipment', 'grn']);
  const once = Number(store.db.prepare(`SELECT COUNT(*) AS count FROM twin_evidence WHERE tenant_id='tenant:a'`).get()?.['count']);
  projector.project(job);
  assert.equal(Number(store.db.prepare(`SELECT COUNT(*) AS count FROM twin_evidence WHERE tenant_id='tenant:a'`).get()?.['count']), once);
  store.close();

  const unverified = openPersistence(':memory:', { tenantId: 'tenant:a' });
  seedPoSourcingChain(unverified, { poId: 'po:1', supplierId: 'supplier:1', itemId: 'PV-30', status: 'sent' });
  const unverifiedQueue = new SqliteTwinProjectionQueue(unverified.db, 'tenant:a');
  enqueuePurchaseOrderBackfill(unverified.db, 'tenant:a', at);
  const unverifiedContext = new SqliteManufacturingContextStore(unverified.db, 'tenant:a');
  new ProcurementPoProjector(unverified.db, 'tenant:a', unverifiedContext).project(claimPurchaseOrderBackfills(unverifiedQueue)[0]!);
  const unverifiedRoot = unverifiedContext.getByBusinessObjectId('po:1')!;
  unverifiedContext.appendEvidence({
    entityId: unverifiedRoot.id, sourceSemantics: 'approved_human', sourceKind: 'approval', sourceId: 'approval:status',
    sourceVersion: '1', sourceHash: 'hash:approved-status', factPath: 'purchase_order.status', value: 'confirmed',
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'human:manager', rawReference: {},
  });
  assert.equal(unverifiedContext.resolveFact(unverifiedRoot.id, 'purchase_order.status')?.value, 'confirmed');
  assert.equal(unverifiedContext.listEvidence(unverifiedRoot.id)
    .find((item) => item.factPath === 'purchase_order.status' && item.sourceKind === 'procurement_documents')?.priority, 200);
  unverified.close();
});

test('PO projector traces only exact PO fulfilment facts with honest evidence semantics', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  seedPoSourcingChain(store, { poId: 'po:1', supplierId: 'supplier:1', itemId: 'PV-30', status: 'sent' });
  const common = { tenantId: store.tenantId, sourceSystem: 'readywork', createdAt: at, updatedAt: at };
  const confirmation: PurchaseOrderConfirmation = {
    ...common, id: 'confirmation:1', externalId: 'CONF-1', status: 'confirmed', poId: 'po:1',
    supplierId: 'supplier:1', confirmedAt: at,
  };
  const confirmationLine: PurchaseOrderConfirmationLine = {
    id: 'confirmation-line:1', confirmationId: confirmation.id, poLineId: 'po-line:1', lineNumber: '10',
    itemId: 'PV-30', uom: '件', confirmedQty: 200, quantityVariance: 0, unitPriceVariance: 0,
    requiresApproval: false,
  };
  const progress: ProductionProgress = {
    ...common, id: 'progress:1', externalId: 'PROGRESS-1', status: 'recorded', poId: 'po:1',
    supplierId: 'supplier:1', reportedAt: at, overallStatus: 'ready_to_ship', evidenceSource: 'manual_verified',
    evidenceReference: 'factory-call:1', verifiedBy: 'human:buyer', verificationReason: '电话核验',
  };
  const progressLine: ProductionProgressLine = {
    id: 'progress-line:1', progressId: progress.id, poLineId: 'po-line:1', lineNumber: '10', itemId: 'PV-30',
    uom: '件', progressStatus: 'ready_to_ship', completionPercent: 100, completedQty: 200,
  };
  const shipment: Shipment = {
    ...common, id: 'shipment:1', externalId: 'SHIP-1', status: 'in_transit', poId: 'po:1',
    supplierId: 'supplier:1', shippedAt: at, carrier: 'SF', trackingNumber: 'SF-1',
  };
  const shipmentLine: ShipmentLine = {
    id: 'shipment-line:1', shipmentId: shipment.id, poLineId: 'po-line:1', lineNumber: '10', itemId: 'PV-30',
    uom: '件', shippedQty: 200,
  };
  const transport: TransportEvent = {
    ...common, id: 'transport:1', externalId: 'TRANS-1', status: 'recorded', poId: 'po:1',
    shipmentId: shipment.id, eventCode: 'delivered', occurredAt: at, evidenceSource: 'manual_verified',
    evidenceReference: 'carrier:1', verifiedBy: 'human:buyer', verificationReason: '承运商回执',
  };
  const receipt: Receipt = {
    ...common, id: 'receipt:1', externalId: 'GRN-1', status: 'received', poId: 'po:1', shipmentId: shipment.id,
    warehouseId: 'warehouse:1', receivedAt: at,
  };
  const receiptLine: ReceiptLine = {
    id: 'receipt-line:1', receiptId: receipt.id, poLineId: 'po-line:1', shipmentLineId: shipmentLine.id,
    lineNumber: '10', itemId: 'PV-30', uom: '件', receivedQty: 200,
  };
  const invoice: SupplierInvoice = {
    ...common, id: 'invoice:1', externalId: 'INV-1', status: 'received', supplierId: 'supplier:1',
    invoiceNumber: 'INV-1', currency: 'CNY', invoiceDate: at,
  };
  const invoiceLine: SupplierInvoiceLine = {
    id: 'invoice-line:1', invoiceId: invoice.id, poLineId: 'po-line:1', lineNumber: '10', itemId: 'PV-30',
    uom: '件', invoicedQty: 200, unitPrice: 127, netAmount: 25_400, currency: 'CNY',
  };
  const communication: Communication = {
    gatewayInboundId: 'messaging-inbound:source',
    ...common, id: 'communication:1', externalId: 'MAIL-1', status: 'received', businessObjectId: 'po:1',
    businessObjectType: 'purchase_order', supplierId: 'supplier:1', channel: 'email', direction: 'inbound',
    from: 'supplier@example.com', subject: 'PO confirmation', body: 'SECRET MAIL BODY credential=must-not-project',
    attachmentIds: ['attachment:secret'], occurredAt: at,
  };
  store.procurement.saveDocument('confirmation', confirmation);
  store.procurement.saveLine('confirmation_line', confirmation.id, confirmationLine);
  store.procurement.saveDocument('production_progress', progress);
  store.procurement.saveLine('production_progress_line', progress.id, progressLine);
  store.procurement.saveDocument('shipment', shipment);
  store.procurement.saveLine('shipment_line', shipment.id, shipmentLine);
  store.procurement.saveDocument('transport_event', transport);
  store.procurement.saveDocument('receipt', receipt);
  store.procurement.saveLine('receipt_line', receipt.id, receiptLine);
  store.procurement.saveDocument('invoice', invoice);
  store.procurement.saveLine('invoice_line', invoice.id, invoiceLine);
  store.procurement.saveDocument('communication', communication);

  const unrelatedShipment = { ...shipment, id: 'shipment:other', externalId: 'SHIP-OTHER', poId: 'po:other' };
  const unrelatedReceipt = { ...receipt, id: 'receipt:other', externalId: 'GRN-OTHER', poId: 'po:other', shipmentId: unrelatedShipment.id };
  store.procurement.saveDocument('shipment', unrelatedShipment);
  store.procurement.saveDocument('receipt', unrelatedReceipt);
  store.db.prepare(`INSERT INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'tenant:a', 'stage:backfill:1', 'po:1', 'po_sent', 'observed_status_backfill', 'completed', at,
    'migration', 'po:1:v1', 'system:migration', JSON.stringify({ secret: 'must-not-project' }), at,
  );
  const outbox = {
    id: 'outbox:1', tenantId: 'tenant:a', channel: 'erp', connectorId: 'odoo:1', action: 'purchase_order.create_draft',
    aggregateId: 'po:1', idempotencyKey: 'odoo-po:1', status: 'dispatched',
    payload: { correlationKey: 'readywork:tenant:a:po:1', credential: 'must-not-project' },
    attempts: 1, dispatchedAt: at, connectorResult: {
      id: 99, name: 'PO099', state: 'draft', correlationKey: 'readywork:tenant:a:po:1', token: 'must-not-project',
    },
    createdAt: at, updatedAt: at,
  };
  store.db.prepare(`INSERT INTO procurement_outbox
    (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,created_at,updated_at,
     attempt,dispatched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'tenant:a', outbox.id, outbox.channel, outbox.connectorId, outbox.action, outbox.aggregateId,
    outbox.idempotencyKey, outbox.status, JSON.stringify(outbox.payload), JSON.stringify(outbox), at, at, 1, at,
  );
  const currentPo = store.procurement.getDocument<PurchaseOrder>('purchase_order', 'po:1')!;
  store.procurement.saveDocument('purchase_order', {
    ...currentPo.document,
    odooReference: { id: 99, name: 'PO099', correlationKey: 'readywork:tenant:a:po:1', createdAt: at },
  }, currentPo.version);
  store.db.prepare(`INSERT INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'tenant:a', 'stage:connector:1', 'po:1', 'po_sent', 'connector_delivery_confirmed', 'completed', at,
    'outbox', outbox.id, 'connector:odoo', '{}', at,
  );
  const approval = {
    id: 'execution-approval:1', tenantId: 'tenant:a', kind: 'supplier_confirmation', objectId: confirmation.id,
    poId: 'po:1', status: 'approved', requestedBy: 'human:buyer', requestedAt: at, reason: '价格无偏差',
    decidedBy: 'human:manager', decidedAt: at,
  };
  store.db.prepare(`INSERT INTO procurement_execution_approvals
    (tenant_id,id,kind,object_id,status,json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(
    'tenant:a', approval.id, approval.kind, approval.objectId, approval.status, JSON.stringify(approval), at, at,
  );
  store.db.prepare(`INSERT INTO runtime_exceptions
    (tenant_id,id,object_id,status,json,updated_at) VALUES (?,?,?,?,?,?)`).run(
    'tenant:a', 'exception:1', 'po:1', 'open', JSON.stringify({
      id: 'exception:1', objectId: 'po:1', status: 'open', type: 'api_key=must-not-project', aiJudgment: 'late',
      recommendedAction: 'follow up', context: { credential: 'must-not-project' }, needsApproval: false, createdAt: at,
    }), at,
  );
  store.db.prepare(`INSERT INTO procurement_sla_evaluations
    (tenant_id,po_id,policy_id,policy_version,rule_id,stage,status,due_at,grace_until,next_followup_at,
     followup_count,evidence_json,fingerprint,version,evaluated_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'tenant:a', 'po:1', 'sla-policy:1', 3, 'rule:1', 'dispatch_transit', 'breached', at, null, at,
    1, JSON.stringify({ source: 'facts' }), 'sla:fingerprint:1', 2, at, at,
  );

  const queue = new SqliteTwinProjectionQueue(store.db, 'tenant:a');
  const context = new SqliteManufacturingContextStore(store.db, 'tenant:a');
  enqueuePurchaseOrderBackfill(store.db, 'tenant:a', at);
  const job = claimPurchaseOrderBackfills(queue)[0]!;
  new ProcurementPoProjector(store.db, 'tenant:a', context).project(job);

  const root = context.getByBusinessObjectId('po:1')!;
  const graph = context.getNeighborhood(root.id, { depth: 2, entityLimit: 500, evidenceLimit: 2_000 });
  assert.deepEqual(root.state.missingFacts, []);
  assert.ok(graph.entities.some((entity) => entity.entityType === 'communication'));
  assert.equal(graph.entities.find((entity)=>entity.entityType==='communication')?.attributes['gatewayInboundId'],'messaging-inbound:source');
  assert.ok(graph.entities.some((entity) => entity.entityType === 'shipment' && entity.attributes.businessObjectId === 'shipment:1'));
  assert.ok(graph.entities.some((entity) => entity.entityType === 'receipt' && entity.attributes.businessObjectId === 'receipt:1'));
  assert.ok(graph.entities.some((entity) => entity.entityType === 'invoice'));
  assert.ok(graph.entities.some((entity) => entity.entityType === 'sla_evaluation'));
  assert.equal(graph.entities.some((entity) => entity.attributes.businessObjectId === 'shipment:other'), false);
  assert.equal(graph.entities.some((entity) => entity.attributes.businessObjectId === 'receipt:other'), false);
  assert.ok(graph.evidence.some((evidence) => evidence.factPath === 'purchase_order.stage_event'
    && evidence.sourceSemantics === 'observed_backfill' && evidence.priority === 200));
  assert.ok(graph.evidence.some((evidence) => evidence.factPath === 'purchase_order.outbox'
    && evidence.sourceSemantics === 'verified_external' && evidence.priority === 400));
  assert.ok(graph.evidence.some((evidence) => evidence.rawReference.primaryKey === 'stage:connector:1'
    && evidence.sourceSemantics === 'verified_external' && evidence.priority === 400));
  assert.deepEqual(
    new Set(graph.relations.map((relation) => relation.relationType)),
    new Set([
      'ordered_from', 'contains_line', 'for_material', 'created_from_award', 'selected_quote', 'about',
      'sourced_from_rfq', 'fulfilled_by', 'has_transport_event', 'received_as', 'invoiced_by',
    ]),
  );
  for (const evidence of graph.evidence) {
    assert.deepEqual(Object.keys(evidence.rawReference).sort(), ['contentHash', 'primaryKey', 'sourceVersion', 'table']);
  }
  const projected = JSON.stringify({
    entities: graph.entities, evidence: graph.evidence, relations: graph.relations,
  });
  assert.doesNotMatch(projected, /SECRET MAIL BODY|must-not-project|attachment:secret|supplier@example\.com/);
  store.close();
});

test('missing facts require a validated Odoo identity and never treat carrier delivery as a GRN', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  seedPoSourcingChain(store, { poId: 'po:1', supplierId: 'supplier:1', itemId: 'PV-30', status: 'sent' });
  const stored = store.procurement.getDocument<PurchaseOrder>('purchase_order', 'po:1')!;
  store.procurement.saveDocument('purchase_order', {
    ...stored.document,
    odooReference: {} as PurchaseOrder['odooReference'],
    updatedAt: '2026-08-29T00:01:00.000Z',
  }, stored.version);
  const common = { tenantId: store.tenantId, sourceSystem: 'readywork', createdAt: at, updatedAt: at };
  const shipment: Shipment = {
    ...common, id: 'shipment:1', externalId: 'SHIP-1', status: 'delivered', poId: 'po:1',
    supplierId: 'supplier:1', shippedAt: at,
  };
  const transport: TransportEvent = {
    ...common, id: 'transport:1', externalId: 'TRANS-1', status: 'recorded', poId: 'po:1',
    shipmentId: shipment.id, eventCode: 'delivered', occurredAt: at, evidenceSource: 'manual_verified',
    evidenceReference: 'carrier:1', verifiedBy: 'human:buyer', verificationReason: '承运商签收',
  };
  store.procurement.saveDocument('shipment', shipment);
  store.procurement.saveDocument('transport_event', transport);

  assert.deepEqual(purchaseOrderMissingFacts(store.db, 'tenant:a', 'po:1'), [
    'odoo_purchase_order', 'supplier_confirmation', 'production_progress', 'grn',
  ]);

  const invalid = store.procurement.getDocument<PurchaseOrder>('purchase_order', 'po:1')!;
  store.procurement.saveDocument('purchase_order', {
    ...invalid.document,
    odooReference: { id: 99, name: 'PO099', correlationKey: 'po:1:v2', createdAt: at },
    updatedAt: '2026-08-29T00:02:00.000Z',
  }, invalid.version);
  assert.deepEqual(purchaseOrderMissingFacts(store.db, 'tenant:a', 'po:1'), [
    'odoo_purchase_order', 'supplier_confirmation', 'production_progress', 'grn',
  ]);
  const wrongCorrelation = store.procurement.getDocument<PurchaseOrder>('purchase_order', 'po:1')!;
  store.procurement.saveDocument('purchase_order', {
    ...wrongCorrelation.document,
    odooReference: { id: 99, name: 'PO099', correlationKey: 'readywork:tenant:a:po:1', createdAt: at },
    updatedAt: '2026-08-29T00:03:00.000Z',
  }, wrongCorrelation.version);
  assert.deepEqual(purchaseOrderMissingFacts(store.db, 'tenant:a', 'po:1'), [
    'supplier_confirmation', 'production_progress', 'grn',
  ]);
  store.close();
});

test('only a formally confirmed supplier confirmation clears supplier_confirmation', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  seedPoSourcingChain(store, { poId: 'po:1', supplierId: 'supplier:1', itemId: 'PV-30', status: 'sent' });
  const common = { tenantId: store.tenantId, sourceSystem: 'supplier', createdAt: at, updatedAt: at };
  const pending: PurchaseOrderConfirmation = {
    ...common, id: 'confirmation:1', externalId: 'CONF-1', status: 'pending_approval', poId: 'po:1',
    supplierId: 'supplier:1', confirmedAt: at,
  };
  const saved = store.procurement.saveDocument('confirmation', pending);
  assert.ok(purchaseOrderMissingFacts(store.db, 'tenant:a', 'po:1').includes('supplier_confirmation'));

  const rejected = store.procurement.saveDocument('confirmation', {
    ...pending, status: 'rejected', updatedAt: '2026-08-29T00:01:00.000Z',
  }, saved.version);
  assert.ok(purchaseOrderMissingFacts(store.db, 'tenant:a', 'po:1').includes('supplier_confirmation'));

  store.procurement.saveDocument('confirmation', {
    ...rejected.document, status: 'confirmed', updatedAt: '2026-08-29T00:02:00.000Z',
  }, rejected.version);
  assert.equal(purchaseOrderMissingFacts(store.db, 'tenant:a', 'po:1').includes('supplier_confirmation'), false);
  store.close();
});

test('projector rejects a context store for a different tenant before writing any graph row', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  seedPoSourcingChain(store, { poId: 'po:1', supplierId: 'supplier:1', itemId: 'PV-30', status: 'sent' });
  const queue = new SqliteTwinProjectionQueue(store.db, 'tenant:a');
  enqueuePurchaseOrderBackfill(store.db, 'tenant:a', at);
  const job = claimPurchaseOrderBackfills(queue)[0]!;
  const wrongContext = new SqliteManufacturingContextStore(store.db, 'tenant:b');

  assert.throws(
    () => new ProcurementPoProjector(store.db, 'tenant:a', wrongContext).project(job),
    /tenant|\u79df\u6237/i,
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM twin_entities').get()?.['count'], 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM twin_relations').get()?.['count'], 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM twin_evidence').get()?.['count'], 0);
  store.close();
});

test('backfill and projection are canonical, source-validated, idempotent, and read-only', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  seedPoSourcingChain(store, { poId: 'po:1', supplierId: 'supplier:1', itemId: 'PV-30', status: 'sent' });
  const sourceCounts = () => ({
    documents: store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_documents WHERE tenant_id='tenant:a'`).get()?.['count'],
    lines: store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_lines WHERE tenant_id='tenant:a'`).get()?.['count'],
    stages: store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_stage_events WHERE tenant_id='tenant:a'`).get()?.['count'],
    outbox: store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id='tenant:a'`).get()?.['count'],
  });
  const beforeSources = sourceCounts();
  const firstEnqueue = enqueuePurchaseOrderBackfill(store.db, 'tenant:a', at)[0]!;
  const poRow = store.db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id='tenant:a' AND kind='purchase_order' AND id='po:1'`).get() as { json: string };
  const parsed = JSON.parse(poRow.json) as Record<string, unknown>;
  const reordered = Object.fromEntries(Object.entries(parsed).reverse());
  store.db.prepare(`UPDATE procurement_documents SET json=?
    WHERE tenant_id='tenant:a' AND kind='purchase_order' AND id='po:1'`).run(JSON.stringify(reordered));
  const replayEnqueue = enqueuePurchaseOrderBackfill(store.db, 'tenant:a', at)[0]!;
  assert.equal(replayEnqueue.id, firstEnqueue.id);
  assert.equal(replayEnqueue.payloadHash, firstEnqueue.payloadHash);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM twin_projection_jobs
    WHERE tenant_id='tenant:a' AND event_type='purchase_order.backfill'`).get()?.['count'], 1);

  const queue = new SqliteTwinProjectionQueue(store.db, 'tenant:a');
  const job = claimPurchaseOrderBackfills(queue)[0]!;
  const context = new SqliteManufacturingContextStore(store.db, 'tenant:a');
  const projector = new ProcurementPoProjector(store.db, 'tenant:a', context);
  projector.project(job);
  const graphCounts = () => ({
    entities: store.db.prepare(`SELECT COUNT(*) AS count FROM twin_entities WHERE tenant_id='tenant:a'`).get()?.['count'],
    relations: store.db.prepare(`SELECT COUNT(*) AS count FROM twin_relations WHERE tenant_id='tenant:a'`).get()?.['count'],
    evidence: store.db.prepare(`SELECT COUNT(*) AS count FROM twin_evidence WHERE tenant_id='tenant:a'`).get()?.['count'],
  });
  const once = graphCounts();
  const entityVersionsOnce = store.db.prepare(`SELECT id,current_revision,source_watermark,updated_at
    FROM twin_entities WHERE tenant_id='tenant:a' ORDER BY id`).all();
  const relationVersionsOnce = store.db.prepare(`SELECT id,updated_at
    FROM twin_relations WHERE tenant_id='tenant:a' ORDER BY id`).all();
  projector.project(job);
  assert.deepEqual(graphCounts(), once);
  assert.deepEqual(store.db.prepare(`SELECT id,current_revision,source_watermark,updated_at
    FROM twin_entities WHERE tenant_id='tenant:a' ORDER BY id`).all(), entityVersionsOnce);
  assert.deepEqual(store.db.prepare(`SELECT id,updated_at
    FROM twin_relations WHERE tenant_id='tenant:a' ORDER BY id`).all(), relationVersionsOnce);
  assert.deepEqual(sourceCounts(), beforeSources);

  assert.throws(() => projector.project({ ...job, sourceKey: 'po:other' }), /source|\u6e90|PO/i);
  assert.throws(() => projector.project({ ...job, sourceRevision: '999' }), /version|\u7248\u672c/i);
  assert.throws(() => projector.project({ ...job, payloadHash: '0'.repeat(64) }), /hash|\u6458\u8981|\u8f7d\u8377/i);
  assert.deepEqual(graphCounts(), once);
  assert.deepEqual(sourceCounts(), beforeSources);
  store.close();
});

test('a shared multi-supplier Award projects only lineage explicitly referenced by the current PO lines', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  const common = { tenantId: store.tenantId, sourceSystem: 'readywork', createdAt: at, updatedAt: at };
  const supplier1: Supplier = {
    ...common, id: 'supplier:1', externalId: 'SUP-1', status: 'active', name: 'Supplier One', currency: 'CNY', contacts: [],
  };
  const supplier2: Supplier = {
    ...common, id: 'supplier:2', externalId: 'SUP-2', status: 'active', name: 'Supplier Two', currency: 'CNY', contacts: [],
  };
  const rfq: RequestForQuotation = {
    ...common, id: 'rfq:shared', externalId: 'RFQ-SHARED', status: 'awarded', buyerId: 'human:buyer',
    supplierIds: [supplier1.id, supplier2.id], currency: 'CNY', quoteDueAt: at,
  };
  const rfqLine1: RequestForQuotationLine = {
    id: 'rfq-line:1', rfqId: rfq.id, lineNumber: '10', itemId: 'ITEM-1', uom: 'pcs', requestedQty: 10,
  };
  const rfqLine2: RequestForQuotationLine = {
    id: 'rfq-line:2', rfqId: rfq.id, lineNumber: '20', itemId: 'ITEM-2', uom: 'pcs', requestedQty: 20,
  };
  const quote1: SupplierQuote = {
    ...common, id: 'quote:1', externalId: 'QUOTE-1', status: 'received', rfqId: rfq.id,
    supplierId: supplier1.id, currency: 'CNY', receivedAt: at,
  };
  const quote2: SupplierQuote = {
    ...common, id: 'quote:2', externalId: 'QUOTE-2', status: 'received', rfqId: rfq.id,
    supplierId: supplier2.id, currency: 'CNY', receivedAt: at,
  };
  const quoteLine1: SupplierQuoteLine = {
    id: 'quote-line:1', quoteId: quote1.id, rfqLineId: rfqLine1.id, lineNumber: '10', itemId: 'ITEM-1',
    uom: 'pcs', quotedQty: 10, unitPrice: 11,
  };
  const quoteLine2: SupplierQuoteLine = {
    id: 'quote-line:2', quoteId: quote2.id, rfqLineId: rfqLine2.id, lineNumber: '20', itemId: 'ITEM-2',
    uom: 'pcs', quotedQty: 20, unitPrice: 22,
  };
  const award: Award = {
    ...common, id: 'award:shared', externalId: 'AWARD-SHARED', status: 'approved', rfqId: rfq.id,
    approvedBy: 'human:manager', approvedAt: at,
  };
  const awardLine1: AwardLine = {
    id: 'award-line:1', awardId: award.id, rfqLineId: rfqLine1.id, quoteLineId: quoteLine1.id,
    supplierId: supplier1.id, lineNumber: '10', itemId: 'ITEM-1', uom: 'pcs', awardedQty: 10,
    unitPrice: 11, currency: 'CNY', selectionReason: 'line one',
  };
  const awardLine2: AwardLine = {
    id: 'award-line:2', awardId: award.id, rfqLineId: rfqLine2.id, quoteLineId: quoteLine2.id,
    supplierId: supplier2.id, lineNumber: '20', itemId: 'ITEM-2', uom: 'pcs', awardedQty: 20,
    unitPrice: 22, currency: 'CNY', selectionReason: 'line two',
  };
  const po1: PurchaseOrder = {
    ...common, id: 'po:1', externalId: 'PO-1', status: 'sent', awardId: award.id,
    supplierId: supplier1.id, currency: 'CNY', orderedAt: at,
  };
  const po2: PurchaseOrder = {
    ...common, id: 'po:2', externalId: 'PO-2', status: 'sent', awardId: award.id,
    supplierId: supplier2.id, currency: 'CNY', orderedAt: at,
  };
  const poLine1: PurchaseOrderLine = {
    id: 'po-line:1', poId: po1.id, awardLineId: awardLine1.id, quoteLineId: quoteLine1.id,
    rfqLineId: rfqLine1.id, lineNumber: '10', itemId: 'ITEM-1', uom: 'pcs', orderedQty: 10,
    unitPrice: 11, currency: 'CNY',
  };
  const poLine2: PurchaseOrderLine = {
    id: 'po-line:2', poId: po2.id, awardLineId: awardLine2.id, quoteLineId: quoteLine2.id,
    rfqLineId: rfqLine2.id, lineNumber: '20', itemId: 'ITEM-2', uom: 'pcs', orderedQty: 20,
    unitPrice: 22, currency: 'CNY',
  };
  store.procurement.saveDocument('supplier', supplier1);
  store.procurement.saveDocument('supplier', supplier2);
  store.procurement.saveDocument('rfq', rfq);
  store.procurement.saveLine('rfq_line', rfq.id, rfqLine1);
  store.procurement.saveLine('rfq_line', rfq.id, rfqLine2);
  store.procurement.saveDocument('quote', quote1);
  store.procurement.saveDocument('quote', quote2);
  store.procurement.saveLine('quote_line', quote1.id, quoteLine1);
  store.procurement.saveLine('quote_line', quote2.id, quoteLine2);
  store.procurement.saveDocument('award', award);
  store.procurement.saveLine('award_line', award.id, awardLine1);
  store.procurement.saveLine('award_line', award.id, awardLine2);
  store.procurement.saveDocument('purchase_order', po1);
  store.procurement.saveDocument('purchase_order', po2);
  store.procurement.saveLine('purchase_order_line', po1.id, poLine1);
  store.procurement.saveLine('purchase_order_line', po2.id, poLine2);

  const jobs = enqueuePurchaseOrderBackfill(store.db, 'tenant:a', at);
  const queue = new SqliteTwinProjectionQueue(store.db, 'tenant:a');
  const claimed = claimPurchaseOrderBackfills(queue, 2);
  const context = new SqliteManufacturingContextStore(store.db, 'tenant:a');
  const projector = new ProcurementPoProjector(store.db, 'tenant:a', context);
  for (const job of claimed) projector.project(job);

  assert.equal(jobs.length, 2);
  const root = context.getByBusinessObjectId('po:1')!;
  const po2Root = context.getByBusinessObjectId('po:2')!;
  const awardEntity = context.getByBusinessObjectId('award:shared')!;
  const quote1Entity = context.getByBusinessObjectId('quote:1')!;
  const quote2Entity = context.getByBusinessObjectId('quote:2')!;
  const rfqEntity = context.getByBusinessObjectId('rfq:shared')!;
  const scopedRelationEvidence = (
    contextRoot: TwinEntity, from: TwinEntity, to: TwinEntity, relationType: string,
  ): TwinEvidence => context.listEvidence(to.id).find((evidence) =>
    evidence.factPath.startsWith(`relation.${relationType}.${from.id}.${to.id}.context.`)
      && (evidence.value as Record<string, unknown>).contextRootEntityId === contextRoot.id) as TwinEvidence;
  const addLegacyRelation = (
    contextRoot: TwinEntity, from: TwinEntity, to: TwinEntity, relationType: string,
  ): void => {
    const scoped = scopedRelationEvidence(contextRoot, from, to, relationType);
    assert.ok(scoped);
    const legacy = copyAsLegacyUnscopedEvidence(
      context, to, scoped, `relation.${relationType}.${from.id}.${to.id}`,
    );
    context.upsertRelation({
      relationType, fromEntityId: from.id, toEntityId: to.id, status: 'active',
      sourceEvidenceId: legacy.id, validFrom: at,
    });
  };
  const addLegacyLineEvidence = (
    contextRoot: TwinEntity, entity: TwinEntity, primaryKey: string, factPath: string,
  ): void => {
    const scoped = context.listEvidence(entity.id).find((evidence) =>
      evidence.rawReference.primaryKey === primaryKey
        && evidence.factPath.startsWith(`${factPath}.context.`)
        && (evidence.value as Record<string, unknown>).contextRootEntityId === contextRoot.id);
    assert.ok(scoped);
    copyAsLegacyUnscopedEvidence(context, entity, scoped, factPath);
  };

  addLegacyRelation(root, root, awardEntity, 'created_from_award');
  addLegacyRelation(root, awardEntity, quote1Entity, 'selected_quote');
  addLegacyRelation(root, quote1Entity, rfqEntity, 'sourced_from_rfq');
  context.upsertRelation({
    relationType: 'created_from_award', fromEntityId: po2Root.id, toEntityId: awardEntity.id, status: 'active',
    sourceEvidenceId: 'legacy:missing:po2-award', validFrom: at,
  });
  context.upsertRelation({
    relationType: 'selected_quote', fromEntityId: awardEntity.id, toEntityId: quote2Entity.id, status: 'active',
    sourceEvidenceId: 'legacy:missing:award-quote2', validFrom: at,
  });
  context.upsertRelation({
    relationType: 'sourced_from_rfq', fromEntityId: quote2Entity.id, toEntityId: rfqEntity.id, status: 'active',
    sourceEvidenceId: 'legacy:missing:quote2-rfq', validFrom: at,
  });
  addLegacyLineEvidence(root, awardEntity, 'award_line:award-line:1', 'award.line');
  addLegacyLineEvidence(po2Root, awardEntity, 'award_line:award-line:2', 'award.line');
  addLegacyLineEvidence(root, quote1Entity, 'quote_line:quote-line:1', 'quote.line');
  addLegacyLineEvidence(po2Root, quote2Entity, 'quote_line:quote-line:2', 'quote.line');
  addLegacyLineEvidence(root, rfqEntity, 'rfq_line:rfq-line:1', 'rfq.line');
  addLegacyLineEvidence(po2Root, rfqEntity, 'rfq_line:rfq-line:2', 'rfq.line');

  for (const job of claimed) projector.project(job);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM twin_relations
    WHERE tenant_id='tenant:a' AND source_evidence_id LIKE 'legacy:missing:%'`).get()?.['count'], 3);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM twin_evidence
    WHERE tenant_id='tenant:a' AND actor_id='system:procurement-po-projector'
      AND json_extract(value_json,'$.contextRootEntityId') IS NULL
      AND fact_path IN ('award.line','quote.line','rfq.line')`).get()?.['count'], 6);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM twin_evidence
    WHERE tenant_id='tenant:a' AND actor_id='system:procurement-po-projector'
      AND json_extract(value_json,'$.contextRootEntityId') IS NULL
      AND fact_path LIKE 'relation.%'`).get()?.['count'], 3);

  const graph = context.getNeighborhood(root.id, { depth: 2, entityLimit: 500, evidenceLimit: 2_000 });
  const businessIds = graph.entities.map((entity) => entity.attributes.businessObjectId);
  assert.ok(businessIds.includes('supplier:1'));
  assert.ok(businessIds.includes('award:shared'));
  assert.ok(businessIds.includes('quote:1'));
  assert.ok(businessIds.includes('rfq:shared'));
  assert.ok(businessIds.includes('po-line:1'));
  assert.ok(businessIds.includes('ITEM-1'));
  assert.equal(businessIds.includes('po:2'), false);
  assert.equal(businessIds.includes('supplier:2'), false);
  assert.equal(businessIds.includes('quote:2'), false);
  assert.equal(businessIds.includes('po-line:2'), false);
  const primaryKeys = graph.evidence.map((evidence) => evidence.rawReference.primaryKey);
  assert.ok(primaryKeys.includes('award_line:award-line:1'));
  assert.ok(primaryKeys.includes('quote_line:quote-line:1'));
  assert.ok(primaryKeys.includes('rfq_line:rfq-line:1'));
  assert.equal(primaryKeys.includes('award_line:award-line:2'), false);
  assert.equal(primaryKeys.includes('quote_line:quote-line:2'), false);
  assert.equal(primaryKeys.includes('rfq_line:rfq-line:2'), false);
  assert.ok(graph.evidence.some((evidence) => evidence.factPath === 'award.snapshot'
    && evidence.rawReference.primaryKey === 'award:award:shared'));

  const po2Graph = context.getNeighborhood(po2Root.id, { depth: 2, entityLimit: 500, evidenceLimit: 2_000 });
  const po2BusinessIds = po2Graph.entities.map((entity) => entity.attributes.businessObjectId);
  assert.ok(po2BusinessIds.includes('supplier:2'));
  assert.ok(po2BusinessIds.includes('award:shared'));
  assert.ok(po2BusinessIds.includes('quote:2'));
  assert.ok(po2BusinessIds.includes('rfq:shared'));
  assert.ok(po2BusinessIds.includes('po-line:2'));
  assert.ok(po2BusinessIds.includes('ITEM-2'));
  assert.equal(po2BusinessIds.includes('po:1'), false);
  assert.equal(po2BusinessIds.includes('supplier:1'), false);
  assert.equal(po2BusinessIds.includes('quote:1'), false);
  assert.equal(po2BusinessIds.includes('po-line:1'), false);
  const po2PrimaryKeys = po2Graph.evidence.map((evidence) => evidence.rawReference.primaryKey);
  assert.ok(po2PrimaryKeys.includes('award_line:award-line:2'));
  assert.ok(po2PrimaryKeys.includes('quote_line:quote-line:2'));
  assert.ok(po2PrimaryKeys.includes('rfq_line:rfq-line:2'));
  assert.equal(po2PrimaryKeys.includes('award_line:award-line:1'), false);
  assert.equal(po2PrimaryKeys.includes('quote_line:quote-line:1'), false);
  assert.equal(po2PrimaryKeys.includes('rfq_line:rfq-line:1'), false);

  const awardGraph = context.getNeighborhood(awardEntity.id, { depth: 1, entityLimit: 500, evidenceLimit: 2_000 });
  const awardBusinessIds = awardGraph.entities.map((entity) => entity.attributes.businessObjectId);
  assert.ok(awardBusinessIds.includes('po:1'));
  assert.ok(awardBusinessIds.includes('po:2'));
  assert.ok(awardBusinessIds.includes('quote:1'));
  assert.ok(awardBusinessIds.includes('quote:2'));
  const awardPrimaryKeys = awardGraph.evidence.map((evidence) => evidence.rawReference.primaryKey);
  assert.ok(awardPrimaryKeys.includes('award_line:award-line:1'));
  assert.ok(awardPrimaryKeys.includes('award_line:award-line:2'));
  store.close();
});

test('two POs ordering from one supplier keep endpoint-specific relation evidence', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  const common = { tenantId: store.tenantId, sourceSystem: 'readywork', createdAt: at, updatedAt: at };
  const supplier: Supplier = {
    ...common, id: 'supplier:shared', externalId: 'SUP-SHARED', status: 'active',
    name: 'Shared Supplier', currency: 'CNY', contacts: [],
  };
  store.procurement.saveDocument('supplier', supplier);
  for (const suffix of ['1', '2']) {
    const po: PurchaseOrder = {
      ...common, id: `po:${suffix}`, externalId: `PO-${suffix}`, status: 'sent', supplierId: supplier.id,
      currency: 'CNY', orderedAt: at,
    };
    const line: PurchaseOrderLine = {
      id: `po-line:${suffix}`, poId: po.id, lineNumber: '10', itemId: `ITEM-${suffix}`, uom: 'pcs',
      orderedQty: 1, unitPrice: 10, currency: 'CNY',
    };
    store.procurement.saveDocument('purchase_order', po);
    store.procurement.saveLine('purchase_order_line', po.id, line);
  }
  enqueuePurchaseOrderBackfill(store.db, 'tenant:a', at);
  const queue = new SqliteTwinProjectionQueue(store.db, 'tenant:a');
  const jobs = claimPurchaseOrderBackfills(queue, 2);
  const context = new SqliteManufacturingContextStore(store.db, 'tenant:a');
  const projector = new ProcurementPoProjector(store.db, 'tenant:a', context);
  for (const job of jobs) projector.project(job);

  const relations = store.db.prepare(`SELECT source_evidence_id,from_entity_id,to_entity_id FROM twin_relations
    WHERE tenant_id='tenant:a' AND relation_type='ordered_from' ORDER BY from_entity_id`).all() as Array<{
      source_evidence_id: string; from_entity_id: string; to_entity_id: string;
    }>;
  assert.equal(relations.length, 2);
  assert.notEqual(relations[0]!.source_evidence_id, relations[1]!.source_evidence_id);
  for (const relation of relations) {
    const from = context.getEntity(relation.from_entity_id)!;
    const to = context.getEntity(relation.to_entity_id)!;
    const evidence = store.db.prepare(`SELECT value_json FROM twin_evidence
      WHERE tenant_id='tenant:a' AND id=?`).get(relation.source_evidence_id) as { value_json: string };
    assert.deepEqual(JSON.parse(evidence.value_json), {
      contextRootEntityId: from.id,
      fromBusinessObjectId: from.attributes.businessObjectId,
      toBusinessObjectId: to.attributes.businessObjectId,
    });
  }
  store.close();
});

test('stage and Outbox evidence stay low-priority without an action-specific persisted connector receipt', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  seedPoSourcingChain(store, { poId: 'po:1', supplierId: 'supplier:1', itemId: 'PV-30', status: 'sent' });
  const incompleteOutbox = {
    id: 'outbox:incomplete', tenantId: 'tenant:a', channel: 'email', connectorId: 'smtp:1',
    action: 'purchase_order.send', aggregateId: 'po:1', idempotencyKey: 'send:1', status: 'dispatched',
    payload: { poId: 'po:1' }, attempts: 1, dispatchedAt: at, connectorResult: {}, createdAt: at, updatedAt: at,
  };
  store.db.prepare(`INSERT INTO procurement_outbox
    (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,created_at,updated_at,
     attempt,dispatched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'tenant:a', incompleteOutbox.id, incompleteOutbox.channel, incompleteOutbox.connectorId,
    incompleteOutbox.action, incompleteOutbox.aggregateId, incompleteOutbox.idempotencyKey,
    incompleteOutbox.status, JSON.stringify(incompleteOutbox.payload), JSON.stringify(incompleteOutbox), at, at, 1, at,
  );
  const insertStage = store.db.prepare(`INSERT INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertStage.run('tenant:a', 'stage:no-row', 'po:1', 'po_sent', 'connector_delivery_confirmed', 'completed', at,
    'outbox', 'outbox:missing', 'connector:smtp', '{}', at);
  insertStage.run('tenant:a', 'stage:incomplete', 'po:1', 'po_sent', 'connector_delivery_confirmed', 'completed', at,
    'outbox', incompleteOutbox.id, 'connector:smtp', '{}', at);

  const queue = new SqliteTwinProjectionQueue(store.db, 'tenant:a');
  enqueuePurchaseOrderBackfill(store.db, 'tenant:a', at);
  const job = claimPurchaseOrderBackfills(queue)[0]!;
  const context = new SqliteManufacturingContextStore(store.db, 'tenant:a');
  new ProcurementPoProjector(store.db, 'tenant:a', context).project(job);
  const root = context.getByBusinessObjectId('po:1')!;
  const evidence = context.getNeighborhood(root.id, { depth: 2, entityLimit: 500, evidenceLimit: 2_000 }).evidence
    .filter((item) => ['stage:no-row', 'stage:incomplete', incompleteOutbox.id]
      .includes(String(item.rawReference.primaryKey)));

  assert.equal(evidence.length, 3);
  assert.ok(evidence.every((item) => item.sourceSemantics === 'deterministic' && item.priority === 200));
  store.close();
});
