import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Award,
  AwardLine,
  Communication,
  ProcurementDocument,
  ProcurementLine,
  ProcurementOutboxMessage,
  ProductionProgress,
  PurchaseOrder,
  PurchaseOrderConfirmation,
  PurchaseOrderLine,
  Receipt,
  RequestForQuotation,
  RequestForQuotationLine,
  Shipment,
  Supplier,
  SupplierInvoice,
  SupplierQuote,
  SupplierQuoteLine,
  TransportEvent,
  TwinEntity,
  TwinEntityType,
  TwinProjectionJob,
} from '@readywork/core';
import { redactSensitiveValue } from '@readywork/core';
import { purchaseOrderOdooCorrelationKey } from '@readywork/persistence';
import { contextSourceWatermark } from './context-identity.js';
import { purchaseOrderMissingFacts } from './procurement-po-missing-facts.js';
import { SqliteTwinProjectionQueue } from './projection-queue.js';
import {
  canonicalTwinJson,
  SqliteManufacturingContextStore,
  TWIN_CONTEXT_ROOT_ENTITY_ID_KEY,
} from './sqlite-manufacturing-context-store.js';

type RelationType =
  | 'ordered_from' | 'contains_line' | 'for_material' | 'created_from_award'
  | 'selected_quote' | 'sourced_from_rfq' | 'about' | 'fulfilled_by'
  | 'has_transport_event' | 'received_as' | 'invoiced_by';

interface DocumentRow {
  kind: string;
  id: string;
  version: number;
  json: string;
}

interface LineRow {
  kind: string;
  id: string;
  document_id: string;
  json: string;
}

interface SourceFact extends Record<string, unknown> {
  table: string;
  primaryKey: string;
  sourceVersion: string;
  contentHash: string;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalTwinJson(value)).digest('hex');
}

function parseDocument<T extends ProcurementDocument>(row: DocumentRow): T {
  return JSON.parse(row.json) as T;
}

function parseLine<T extends ProcurementLine>(row: LineRow): T {
  return JSON.parse(row.json) as T;
}

function documentFact(row: DocumentRow): SourceFact {
  return {
    table: 'procurement_documents', primaryKey: `${row.kind}:${row.id}`,
    sourceVersion: String(row.version), contentHash: hashCanonical(JSON.parse(row.json)),
  };
}

function lineFact(row: LineRow): SourceFact {
  return {
    table: 'procurement_lines', primaryKey: `${row.kind}:${row.id}`,
    sourceVersion: '1', contentHash: hashCanonical(JSON.parse(row.json)),
  };
}

function contextScopedValue(value: unknown, contextRootEntityId: string): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), [TWIN_CONTEXT_ROOT_ENTITY_ID_KEY]: contextRootEntityId };
  }
  return { [TWIN_CONTEXT_ROOT_ENTITY_ID_KEY]: contextRootEntityId, value };
}

function rowFact(table: string, primaryKey: string, sourceVersion: string, content: unknown): SourceFact {
  return { table, primaryKey, sourceVersion, contentHash: hashCanonical(content) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function hasVerifiedOutboxCompletion(
  outbox: ProcurementOutboxMessage,
  tenantId: string,
  po: PurchaseOrder,
): boolean {
  if (outbox.tenantId !== tenantId || outbox.aggregateId !== po.id || outbox.status !== 'dispatched'
    || !isValidIsoDate(outbox.dispatchedAt) || !isRecord(outbox.connectorResult)) return false;
  const result = outbox.connectorResult;
  if (outbox.action === 'purchase_order.send' && outbox.channel === 'email') {
    return po.status === 'sent'
      && typeof result.message_id === 'string' && result.message_id.trim().length > 0
      && isValidIsoDate(result.accepted_at)
      && result.delivery_status === 'sent';
  }
  if (outbox.action === 'purchase_order.create_draft' && outbox.channel === 'erp') {
    const expectedCorrelationKey = purchaseOrderOdooCorrelationKey(tenantId, po.id);
    const reference = po.odooReference;
    return Number.isSafeInteger(result.id) && Number(result.id) > 0
      && typeof result.name === 'string' && result.name.trim().length > 0
      && result.state === 'draft'
      && result.correlationKey === expectedCorrelationKey
      && outbox.payload.correlationKey === expectedCorrelationKey
      && reference !== undefined
      && reference.id === result.id && reference.name === result.name
      && reference.correlationKey === expectedCorrelationKey && isValidIsoDate(reference.createdAt);
  }
  return false;
}

function requireText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`PO projector ${field} 不能为空`);
  return value.trim();
}

function readDocument(db: DatabaseSync, tenantId: string, kind: string, id: string): DocumentRow | undefined {
  return db.prepare(`SELECT kind,id,version,json FROM procurement_documents
    WHERE tenant_id=? AND kind=? AND id=?`).get(tenantId, kind, id) as unknown as DocumentRow | undefined;
}

function readLines(db: DatabaseSync, tenantId: string, kind: string, documentId: string): LineRow[] {
  return db.prepare(`SELECT kind,id,document_id,json FROM procurement_lines
    WHERE tenant_id=? AND kind=? AND document_id=? ORDER BY line_number,id`)
    .all(tenantId, kind, documentId) as unknown as LineRow[];
}

function readDocumentsForPo(db: DatabaseSync, tenantId: string, kind: string, poId: string): DocumentRow[] {
  return db.prepare(`SELECT kind,id,version,json FROM procurement_documents
    WHERE tenant_id=? AND kind=? AND json_extract(json,'$.poId')=? ORDER BY id`)
    .all(tenantId, kind, poId) as unknown as DocumentRow[];
}

export function enqueuePurchaseOrderBackfill(db: DatabaseSync, tenantId: string, at: string): TwinProjectionJob[] {
  requireText(tenantId, 'tenantId');
  if (!Number.isFinite(Date.parse(at))) throw new Error('PO projector at 必须是有效时间');
  const queue = new SqliteTwinProjectionQueue(db, tenantId);
  const rows = db.prepare(`SELECT kind,id,version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' ORDER BY id`).all(tenantId) as unknown as DocumentRow[];
  return rows.map((row) => queue.enqueue({
    sourceTable: 'procurement_documents',
    sourceKey: row.id,
    sourceRevision: String(row.version),
    eventType: 'purchase_order.backfill',
    payloadHash: hashCanonical(JSON.parse(row.json)),
    availableAt: at,
  }));
}

export class ProcurementPoProjector {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tenantId: string,
    private readonly context: SqliteManufacturingContextStore,
  ) {
    requireText(tenantId, 'tenantId');
    if (context.tenantId !== tenantId) throw new Error('PO projector context store 与当前租户不一致');
  }

  project(job: TwinProjectionJob): TwinEntity {
    const poRow = this.validateJob(job);
    const po = parseDocument<PurchaseOrder>(poRow);
    const sourceRows: Array<DocumentRow | LineRow> = [poRow];
    const poLines = readLines(this.db, this.tenantId, 'purchase_order_line', po.id);
    sourceRows.push(...poLines);
    const parsedPoLines = poLines.map((row) => ({ row, line: parseLine<PurchaseOrderLine>(row) }));
    const supplierRow = readDocument(this.db, this.tenantId, 'supplier', po.supplierId);
    if (supplierRow) sourceRows.push(supplierRow);
    const awardLines = parsedPoLines.flatMap(({ line: poLine }) => {
      if (!po.awardId || !poLine.awardLineId) return [];
      const row = this.readLine('award_line', poLine.awardLineId);
      if (!row || row.document_id !== po.awardId) return [];
      const awardLine = parseLine<AwardLine>(row);
      if (awardLine.awardId !== po.awardId || awardLine.supplierId !== po.supplierId
        || awardLine.itemId !== poLine.itemId
        || (poLine.quoteLineId !== undefined && awardLine.quoteLineId !== poLine.quoteLineId)
        || (poLine.rfqLineId !== undefined && awardLine.rfqLineId !== poLine.rfqLineId)) return [];
      return [row];
    });
    const candidateAwardRow = po.awardId && awardLines.length > 0
      ? readDocument(this.db, this.tenantId, 'award', po.awardId) : undefined;
    const awardRow = candidateAwardRow
      && awardLines.every((row) => parseLine<AwardLine>(row).awardId === candidateAwardRow.id)
      ? candidateAwardRow : undefined;
    if (awardRow) sourceRows.push(awardRow, ...awardLines);
    const candidateQuoteLineRows = parsedPoLines.flatMap(({ line: poLine }) => {
      if (!poLine.quoteLineId) return [];
      const row = this.readLine('quote_line', poLine.quoteLineId);
      if (!row) return [];
      const quoteLine = parseLine<SupplierQuoteLine>(row);
      const awardLine = awardLines.map((candidate) => parseLine<AwardLine>(candidate))
        .find((candidate) => candidate.id === poLine.awardLineId);
      if (quoteLine.itemId !== poLine.itemId
        || (poLine.rfqLineId !== undefined && quoteLine.rfqLineId !== poLine.rfqLineId)
        || (awardLine !== undefined && awardLine.quoteLineId !== quoteLine.id)) return [];
      return [row];
    });
    const quoteRows = [...new Set(candidateQuoteLineRows.map((row) => row.document_id))]
      .map((id) => readDocument(this.db, this.tenantId, 'quote', id))
      .filter((row): row is DocumentRow => row !== undefined)
      .filter((row) => {
        const quote = parseDocument<SupplierQuote>(row);
        return quote.supplierId === po.supplierId;
      });
    const validQuoteIds = new Set(quoteRows.map((row) => row.id));
    const quoteLineRows = candidateQuoteLineRows.filter((row) => validQuoteIds.has(row.document_id));
    sourceRows.push(...quoteLineRows, ...quoteRows);
    const rfqIds = new Set<string>();
    if (awardRow) rfqIds.add(parseDocument<Award>(awardRow).rfqId);
    for (const row of quoteRows) rfqIds.add(parseDocument<SupplierQuote>(row).rfqId);
    const candidateRfqLineRows = parsedPoLines.flatMap(({ line: poLine }) => {
      if (!poLine.rfqLineId) return [];
      const row = this.readLine('rfq_line', poLine.rfqLineId);
      if (!row) return [];
      const rfqLine = parseLine<RequestForQuotationLine>(row);
      if (rfqLine.itemId !== poLine.itemId) return [];
      return [row];
    });
    for (const row of candidateRfqLineRows) rfqIds.add(row.document_id);
    const rfqRows = [...rfqIds].map((id) => readDocument(this.db, this.tenantId, 'rfq', id))
      .filter((row): row is DocumentRow => row !== undefined);
    const validRfqIds = new Set(rfqRows.map((row) => row.id));
    const rfqLineRows = candidateRfqLineRows.filter((row) => {
      const line = parseLine<RequestForQuotationLine>(row);
      return validRfqIds.has(row.document_id) && line.rfqId === row.document_id;
    });
    sourceRows.push(...rfqRows, ...rfqLineRows);
    const confirmationRows = readDocumentsForPo(this.db, this.tenantId, 'confirmation', po.id);
    const progressRows = readDocumentsForPo(this.db, this.tenantId, 'production_progress', po.id);
    const shipmentRows = readDocumentsForPo(this.db, this.tenantId, 'shipment', po.id);
    const transportRows = readDocumentsForPo(this.db, this.tenantId, 'transport_event', po.id)
      .filter((row) => shipmentRows.some((shipment) => shipment.id === parseDocument<TransportEvent>(row).shipmentId));
    const receiptRows = readDocumentsForPo(this.db, this.tenantId, 'receipt', po.id);
    const communicationRows = (this.db.prepare(`SELECT kind,id,version,json FROM procurement_documents
      WHERE tenant_id=? AND kind='communication' AND json_extract(json,'$.businessObjectId')=?
        AND json_extract(json,'$.businessObjectType')='purchase_order' ORDER BY id`)
      .all(this.tenantId, po.id) as unknown as DocumentRow[]);
    const poLineIds = new Set(poLines.map((row) => row.id));
    const invoiceLineRows = (this.db.prepare(`SELECT kind,id,document_id,json FROM procurement_lines
      WHERE tenant_id=? AND kind='invoice_line' ORDER BY document_id,line_number,id`)
      .all(this.tenantId) as unknown as LineRow[])
      .filter((row) => {
        const poLineId = (JSON.parse(row.json) as { poLineId?: string }).poLineId;
        return poLineId !== undefined && poLineIds.has(poLineId);
      });
    const invoiceRows = [...new Set(invoiceLineRows.map((row) => row.document_id))]
      .map((id) => readDocument(this.db, this.tenantId, 'invoice', id))
      .filter((row): row is DocumentRow => row !== undefined);
    const fulfillmentLineRows = [
      ...confirmationRows.flatMap((row) => readLines(this.db, this.tenantId, 'confirmation_line', row.id)),
      ...progressRows.flatMap((row) => readLines(this.db, this.tenantId, 'production_progress_line', row.id)),
      ...shipmentRows.flatMap((row) => readLines(this.db, this.tenantId, 'shipment_line', row.id)),
      ...receiptRows.flatMap((row) => readLines(this.db, this.tenantId, 'receipt_line', row.id)),
      ...invoiceLineRows,
    ].filter((row) => {
      const source = JSON.parse(row.json) as { poLineId?: string };
      return source.poLineId === undefined || poLineIds.has(source.poLineId);
    });
    sourceRows.push(
      ...confirmationRows, ...progressRows, ...shipmentRows, ...transportRows, ...receiptRows,
      ...communicationRows, ...invoiceRows, ...fulfillmentLineRows,
    );
    const stageRows = this.db.prepare(`SELECT id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,
      evidence_json,created_at FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? ORDER BY occurred_at,id`)
      .all(this.tenantId, po.id) as unknown as Array<Record<string, unknown>>;
    const outboxRows = this.db.prepare(`SELECT id,status,json,updated_at FROM procurement_outbox
      WHERE tenant_id=? AND aggregate_id=? ORDER BY created_at,id`).all(this.tenantId, po.id) as unknown as Array<{
        id: string; status: string; json: string; updated_at: string;
      }>;
    const approvalRows = this.db.prepare(`SELECT id,json,updated_at FROM procurement_execution_approvals
      WHERE tenant_id=? AND json_extract(json,'$.poId')=? ORDER BY id`).all(this.tenantId, po.id) as unknown as Array<{
        id: string; json: string; updated_at: string;
      }>;
    const exceptionRows = this.db.prepare(`SELECT id,json,updated_at FROM runtime_exceptions
      WHERE tenant_id=? AND object_id=? ORDER BY id`).all(this.tenantId, po.id) as unknown as Array<{
        id: string; json: string; updated_at: string;
      }>;
    const slaRows = this.db.prepare(`SELECT * FROM procurement_sla_evaluations
      WHERE tenant_id=? AND po_id=?`).all(this.tenantId, po.id) as unknown as Array<Record<string, unknown>>;
    const auxiliarySources = [
      ...stageRows.map((row) => rowFact('procurement_po_stage_events', String(row.id), String(row.created_at), row)),
      ...outboxRows.map((row) => rowFact('procurement_outbox', row.id, row.updated_at, JSON.parse(row.json))),
      ...approvalRows.map((row) => rowFact('procurement_execution_approvals', row.id, row.updated_at, JSON.parse(row.json))),
      ...exceptionRows.map((row) => rowFact('runtime_exceptions', row.id, row.updated_at, JSON.parse(row.json))),
      ...slaRows.map((row) => rowFact('procurement_sla_evaluations', String(row.po_id), String(row.version), row)),
    ];
    const sources = [
      ...sourceRows.map((row) => 'document_id' in row ? lineFact(row) : documentFact(row)),
      ...auxiliarySources,
    ];
    const watermark = contextSourceWatermark(sources.map((source) => ({
      sourceTable: source.table, sourceKey: source.primaryKey,
      sourceRevision: source.sourceVersion, sourceHash: source.contentHash,
    })));

    const root = this.upsertDocumentEntity('purchase_order', poRow, po.externalId || po.id, watermark, {
      businessObjectId: po.id, sourceSystem: po.sourceSystem, externalId: po.externalId,
    }, { status: po.status, missingFacts: purchaseOrderMissingFacts(this.db, this.tenantId, po.id) });
    const verifiedStatusOutboxIndex = outboxRows.findIndex((row) => {
      const outbox = JSON.parse(row.json) as ProcurementOutboxMessage;
      return row.status === 'dispatched' && outbox.action === 'purchase_order.send'
        && hasVerifiedOutboxCompletion(outbox, this.tenantId, po);
    });
    const statusOutbox = verifiedStatusOutboxIndex < 0 ? undefined
      : JSON.parse(outboxRows[verifiedStatusOutboxIndex]!.json) as ProcurementOutboxMessage;
    this.appendEvidence(
      root,
      verifiedStatusOutboxIndex < 0
        ? documentFact(poRow)
        : auxiliarySources[stageRows.length + verifiedStatusOutboxIndex]!,
      'purchase_order.status',
      po.status,
      statusOutbox?.dispatchedAt ?? po.updatedAt,
      verifiedStatusOutboxIndex < 0 ? 'deterministic' : 'verified_external',
    );
    if (supplierRow) {
      const supplier = parseDocument<Supplier>(supplierRow);
      const entity = this.upsertDocumentEntity('supplier', supplierRow, supplier.name, watermark,
        { businessObjectId: supplier.id, externalId: supplier.externalId }, { status: supplier.status });
      this.relate(root, root, entity, 'ordered_from', documentFact(supplierRow), po.orderedAt);
    }
    for (const row of poLines) {
      const line = parseLine<PurchaseOrderLine>(row);
      const entity = this.upsertLineEntity('po_line', row, `PO line ${line.lineNumber}`, watermark,
        { businessObjectId: line.id, poId: po.id, lineNumber: line.lineNumber },
        { orderedQty: line.orderedQty, unitPrice: line.unitPrice, currency: line.currency, uom: line.uom }, po.updatedAt);
      const source = lineFact(row);
      this.appendEvidence(entity, source, 'po_line.ordered_qty', line.orderedQty, po.updatedAt);
      this.appendEvidence(entity, source, 'po_line.unit_price', line.unitPrice, po.updatedAt);
      this.appendEvidence(entity, source, 'po_line.currency', line.currency, po.updatedAt);
      this.appendEvidence(entity, source, 'po_line.uom', line.uom, po.updatedAt);
      this.relate(root, root, entity, 'contains_line', lineFact(row), po.orderedAt);
      const material = this.context.upsertEntity({
        entityType: 'material', canonicalKey: line.itemId, label: line.itemId, lifecycleState: 'referenced',
        attributes: { businessObjectId: line.itemId }, state: {}, sourceWatermark: watermark,
        effectiveAt: po.updatedAt, observedAt: job.updatedAt,
      });
      const materialEvidence = this.appendContextEvidence(
        root, material, lineFact(row), 'material.reference', line.itemId, po.updatedAt,
      );
      this.context.upsertRelation({ relationType: 'for_material', fromEntityId: entity.id, toEntityId: material.id,
        status: 'active', sourceEvidenceId: materialEvidence.id, validFrom: po.orderedAt });
    }
    if (awardRow) {
      const award = parseDocument<Award>(awardRow);
      const entity = this.upsertDocumentEntity('award', awardRow, award.externalId || award.id, watermark,
        { businessObjectId: award.id, rfqId: award.rfqId }, { status: award.status });
      this.relate(root, root, entity, 'created_from_award', documentFact(awardRow), po.orderedAt);
      for (const quoteRow of quoteRows) {
        const quote = parseDocument<SupplierQuote>(quoteRow);
        const quoteEntity = this.upsertDocumentEntity('quote', quoteRow, quote.externalId || quote.id, watermark,
          { businessObjectId: quote.id, rfqId: quote.rfqId, supplierId: quote.supplierId }, { status: quote.status });
        this.relate(root, entity, quoteEntity, 'selected_quote', documentFact(quoteRow), award.approvedAt ?? award.updatedAt);
      }
      for (const lineRow of awardLines) {
        const line = parseLine<AwardLine>(lineRow);
        this.appendContextEvidence(root, entity, lineFact(lineRow), 'award.line', {
          lineId: line.id, rfqLineId: line.rfqLineId, quoteLineId: line.quoteLineId,
          supplierId: line.supplierId, itemId: line.itemId, awardedQty: line.awardedQty,
        }, award.updatedAt);
      }
    }
    for (const row of rfqRows) {
      const rfq = parseDocument<RequestForQuotation>(row);
      const rfqEntity = this.upsertDocumentEntity('rfq', row, rfq.externalId || rfq.id, watermark,
        { businessObjectId: rfq.id }, { status: rfq.status });
      this.relate(root, root, rfqEntity, 'sourced_from_rfq', documentFact(row), rfq.updatedAt);
      for (const quoteRow of quoteRows.filter((candidate) => parseDocument<SupplierQuote>(candidate).rfqId === rfq.id)) {
        const quoteEntity = this.context.getByBusinessObjectId(quoteRow.id);
        if (quoteEntity) this.relate(root, quoteEntity, rfqEntity, 'sourced_from_rfq', documentFact(row), rfq.updatedAt);
      }
      for (const lineRow of rfqLineRows.filter((candidate) => parseLine<{ rfqId: string } & ProcurementLine>(candidate).rfqId === rfq.id)) {
        const line = parseLine<{ rfqId: string; requestedQty: number } & ProcurementLine>(lineRow);
        this.appendContextEvidence(root, rfqEntity, lineFact(lineRow), 'rfq.line', {
          lineId: line.id, itemId: line.itemId, requestedQty: line.requestedQty, uom: line.uom,
        }, rfq.updatedAt);
      }
    }
    for (const quoteRow of quoteRows) {
      const quote = parseDocument<SupplierQuote>(quoteRow);
      const entity = this.context.getByBusinessObjectId(quote.id);
      if (!entity) continue;
      for (const lineRow of quoteLineRows.filter((candidate) => parseLine<{ quoteId: string } & ProcurementLine>(candidate).quoteId === quote.id)) {
        const line = parseLine<{ quoteId: string; rfqLineId: string; quotedQty: number; unitPrice: number } & ProcurementLine>(lineRow);
        this.appendContextEvidence(root, entity, lineFact(lineRow), 'quote.line', {
          lineId: line.id, rfqLineId: line.rfqLineId, itemId: line.itemId,
          quotedQty: line.quotedQty, unitPrice: line.unitPrice, uom: line.uom,
        }, quote.updatedAt);
      }
    }
    for (const row of communicationRows) {
      const communication = parseDocument<Communication>(row);
      const entity = this.upsertDocumentEntity('communication', row,
        `${communication.direction} ${communication.channel}`, watermark,
        { businessObjectId: communication.id, businessObjectType: 'communication', poId: po.id,
          ...(communication.gatewayInboundId ? {gatewayInboundId:communication.gatewayInboundId}:{}),
          channel: communication.channel, direction: communication.direction },
        { status: communication.status, occurredAt: communication.occurredAt });
      this.relate(root, entity, root, 'about', documentFact(row), communication.occurredAt);
    }
    for (const row of confirmationRows) {
      const confirmation = parseDocument<PurchaseOrderConfirmation>(row);
      this.appendEvidence(root, documentFact(row), 'purchase_order.confirmation', {
        confirmationId: confirmation.id, status: confirmation.status,
      }, confirmation.updatedAt);
      for (const lineRow of readLines(this.db, this.tenantId, 'confirmation_line', row.id)) {
        const line = JSON.parse(lineRow.json) as { id: string; poLineId: string; confirmedQty: number; requiresApproval: boolean };
        if (poLineIds.has(line.poLineId)) this.appendEvidence(root, lineFact(lineRow), 'purchase_order.confirmation_line', {
          confirmationLineId: line.id, poLineId: line.poLineId, confirmedQty: line.confirmedQty,
          requiresApproval: line.requiresApproval,
        }, confirmation.updatedAt);
      }
    }
    for (const row of progressRows) {
      const progress = parseDocument<ProductionProgress>(row);
      this.appendEvidence(root, documentFact(row), 'purchase_order.production_progress', {
        progressId: progress.id, status: progress.status, overallStatus: progress.overallStatus,
        reportedAt: progress.reportedAt, evidenceSource: progress.evidenceSource,
      }, progress.reportedAt);
      for (const lineRow of readLines(this.db, this.tenantId, 'production_progress_line', row.id)) {
        const line = JSON.parse(lineRow.json) as { id: string; poLineId: string; progressStatus: string; completionPercent: number };
        if (poLineIds.has(line.poLineId)) this.appendEvidence(root, lineFact(lineRow), 'purchase_order.production_progress_line', {
          progressLineId: line.id, poLineId: line.poLineId, progressStatus: line.progressStatus,
          completionPercent: line.completionPercent,
        }, progress.reportedAt);
      }
    }
    const shipmentEntities = new Map<string, TwinEntity>();
    for (const row of shipmentRows) {
      const shipment = parseDocument<Shipment>(row);
      const entity = this.upsertDocumentEntity('shipment', row, shipment.externalId || shipment.id, watermark,
        { businessObjectId: shipment.id, poId: po.id, entitySubtype: 'shipment' },
        { status: shipment.status, shippedAt: shipment.shippedAt, carrier: shipment.carrier ?? null,
          trackingNumber: shipment.trackingNumber ?? null });
      shipmentEntities.set(shipment.id, entity);
      this.relate(root, root, entity, 'fulfilled_by', documentFact(row), shipment.shippedAt);
      for (const lineRow of readLines(this.db, this.tenantId, 'shipment_line', row.id)) {
        const line = JSON.parse(lineRow.json) as { id: string; poLineId: string; shippedQty: number };
        if (poLineIds.has(line.poLineId)) this.appendContextEvidence(root, entity, lineFact(lineRow), 'shipment.line', {
          shipmentLineId: line.id, poLineId: line.poLineId, shippedQty: line.shippedQty,
        }, shipment.shippedAt);
      }
    }
    for (const row of transportRows) {
      const transport = parseDocument<TransportEvent>(row);
      const shipmentEntity = shipmentEntities.get(transport.shipmentId);
      if (!shipmentEntity) continue;
      const eventEntity = this.upsertDocumentEntity('shipment', row, `Transport ${transport.eventCode}`, watermark,
        { businessObjectId: transport.id, poId: po.id, shipmentId: transport.shipmentId,
          entitySubtype: 'transport_event' },
        { status: transport.status, eventCode: transport.eventCode, occurredAt: transport.occurredAt });
      this.relate(root, shipmentEntity, eventEntity, 'has_transport_event', documentFact(row), transport.occurredAt);
    }
    for (const row of receiptRows) {
      const receipt = parseDocument<Receipt>(row);
      const entity = this.upsertDocumentEntity('receipt', row, receipt.externalId || receipt.id, watermark,
        { businessObjectId: receipt.id, poId: po.id, shipmentId: receipt.shipmentId ?? null },
        { status: receipt.status, receivedAt: receipt.receivedAt, warehouseId: receipt.warehouseId });
      this.relate(root, root, entity, 'received_as', documentFact(row), receipt.receivedAt);
      for (const lineRow of readLines(this.db, this.tenantId, 'receipt_line', row.id)) {
        const line = JSON.parse(lineRow.json) as { id: string; poLineId: string; receivedQty: number };
        if (poLineIds.has(line.poLineId)) this.appendContextEvidence(root, entity, lineFact(lineRow), 'receipt.line', {
          receiptLineId: line.id, poLineId: line.poLineId, receivedQty: line.receivedQty,
        }, receipt.receivedAt);
      }
    }
    for (const row of invoiceRows) {
      const invoice = parseDocument<SupplierInvoice>(row);
      const entity = this.upsertDocumentEntity('invoice', row, invoice.invoiceNumber, watermark,
        { businessObjectId: invoice.id, supplierId: invoice.supplierId },
        { status: invoice.status, invoiceDate: invoice.invoiceDate, currency: invoice.currency });
      this.relate(root, root, entity, 'invoiced_by', documentFact(row), invoice.invoiceDate);
      for (const lineRow of invoiceLineRows.filter((candidate) => candidate.document_id === invoice.id)) {
        const line = JSON.parse(lineRow.json) as { id: string; poLineId?: string; invoicedQty: number; netAmount: number; currency: string };
        this.appendContextEvidence(root, entity, lineFact(lineRow), 'invoice.line', {
          invoiceLineId: line.id, poLineId: line.poLineId, invoicedQty: line.invoicedQty,
          netAmount: line.netAmount, currency: line.currency,
        }, invoice.updatedAt);
      }
    }
    const persistedOutboxById = new Map(outboxRows.map((row) => [row.id, {
      row,
      outbox: JSON.parse(row.json) as ProcurementOutboxMessage,
    }]));
    for (const [index, row] of stageRows.entries()) {
      const source = auxiliarySources[index]!;
      const persistedOutbox = String(row.source_kind) === 'outbox'
        ? persistedOutboxById.get(String(row.source_id)) : undefined;
      const exactConnectorCompletion = persistedOutbox !== undefined
        && persistedOutbox.row.status === 'dispatched'
        && hasVerifiedOutboxCompletion(persistedOutbox.outbox, this.tenantId, po);
      const semantics = ['observed_status_backfill', 'observed_document_status'].includes(String(row.event_type))
        ? 'observed_backfill' as const : exactConnectorCompletion ? 'verified_external' as const : 'deterministic' as const;
      this.appendEvidence(root, source, 'purchase_order.stage_event', {
        stage: row.stage, eventType: row.event_type, state: row.state, occurredAt: row.occurred_at,
        sourceKind: row.source_kind,
      }, String(row.occurred_at), semantics);
    }
    const outboxOffset = stageRows.length;
    for (const [index, row] of outboxRows.entries()) {
      const outbox = JSON.parse(row.json) as ProcurementOutboxMessage;
      const completed = row.status === 'dispatched' && hasVerifiedOutboxCompletion(outbox, this.tenantId, po);
      this.appendEvidence(root, auxiliarySources[outboxOffset + index]!, 'purchase_order.outbox', {
        outboxId: row.id, status: outbox.status, action: outbox.action, channel: outbox.channel,
        connectorId: outbox.connectorId, dispatchedAt: outbox.dispatchedAt ?? null,
      }, outbox.dispatchedAt ?? row.updated_at, completed ? 'verified_external' : 'deterministic');
    }
    const approvalOffset = outboxOffset + outboxRows.length;
    for (const [index, row] of approvalRows.entries()) {
      const approval = JSON.parse(row.json) as { id: string; kind: string; objectId: string; status: string; requestedAt: string;
        decidedAt?: string; decidedBy?: string };
      this.appendEvidence(root, auxiliarySources[approvalOffset + index]!, 'purchase_order.approval', {
        approvalId: approval.id, kind: approval.kind, objectId: approval.objectId, status: approval.status,
        requestedAt: approval.requestedAt, decidedAt: approval.decidedAt ?? null, decidedBy: approval.decidedBy ?? null,
      }, approval.decidedAt ?? approval.requestedAt, approval.status === 'approved' ? 'approved_human' : 'deterministic');
    }
    const exceptionOffset = approvalOffset + approvalRows.length;
    for (const [index, row] of exceptionRows.entries()) {
      const exception = JSON.parse(row.json) as { id: string; type?: string; severity?: string; status: string; createdAt: string };
      this.appendEvidence(root, auxiliarySources[exceptionOffset + index]!, 'purchase_order.exception', {
        exceptionId: exception.id, type: exception.type ?? null, severity: exception.severity ?? null, status: exception.status,
      }, exception.createdAt);
    }
    const slaOffset = exceptionOffset + exceptionRows.length;
    for (const [index, row] of slaRows.entries()) {
      const entity = this.context.upsertEntity({ entityType: 'sla_evaluation', canonicalKey: po.id,
        label: `SLA ${po.externalId || po.id}`, lifecycleState: String(row.status),
        attributes: { businessObjectId: `sla-evaluation:${po.id}`, poId: po.id, policyId: row.policy_id,
          policyVersion: row.policy_version, ruleId: row.rule_id ?? null },
        state: { stage: row.stage, status: row.status, dueAt: row.due_at ?? null,
          graceUntil: row.grace_until ?? null, nextFollowupAt: row.next_followup_at ?? null,
          followupCount: row.followup_count }, sourceWatermark: watermark,
        effectiveAt: String(row.evaluated_at), observedAt: String(row.updated_at) });
      const source = auxiliarySources[slaOffset + index]!;
      this.appendEvidence(entity, source, 'sla_evaluation.snapshot', entity.state, String(row.evaluated_at));
      this.relate(root, entity, root, 'about', source, String(row.evaluated_at));
    }
    return root;
  }

  private validateJob(job: TwinProjectionJob): DocumentRow {
    if (job.tenantId !== this.tenantId) throw new Error('PO projector job 与当前租户不一致');
    if (job.sourceTable !== 'procurement_documents' || job.eventType !== 'purchase_order.backfill') {
      throw new Error('PO projector job 来源类型不受支持');
    }
    const row = readDocument(this.db, this.tenantId, 'purchase_order', job.sourceKey);
    if (!row) throw new Error('PO projector 源 PO 不存在或不属于当前租户');
    if (String(row.version) !== job.sourceRevision) throw new Error('PO projector 源版本与 job 不一致');
    if (hashCanonical(JSON.parse(row.json)) !== job.payloadHash) throw new Error('PO projector 源载荷与 job 摘要不一致');
    return row;
  }

  private readLine(kind: string, id: string): LineRow | undefined {
    return this.db.prepare(`SELECT kind,id,document_id,json FROM procurement_lines
      WHERE tenant_id=? AND kind=? AND id=?`).get(this.tenantId, kind, id) as unknown as LineRow | undefined;
  }

  private upsertDocumentEntity(
    entityType: TwinEntityType, row: DocumentRow, label: string, watermark: string,
    attributes: Record<string, unknown>, state: Record<string, unknown>,
  ): TwinEntity {
    const document = parseDocument<ProcurementDocument>(row);
    const entity = this.context.upsertEntity({ entityType, canonicalKey: document.id, label,
      lifecycleState: document.status, attributes, state, sourceWatermark: watermark,
      effectiveAt: document.updatedAt, observedAt: document.updatedAt });
    this.appendEvidence(entity, documentFact(row), `${entityType}.snapshot`, state, document.updatedAt);
    return entity;
  }

  private upsertLineEntity(
    entityType: TwinEntityType, row: LineRow, label: string, watermark: string,
    attributes: Record<string, unknown>, state: Record<string, unknown>, at: string,
  ): TwinEntity {
    const entity = this.context.upsertEntity({ entityType, canonicalKey: row.id, label,
      lifecycleState: 'active', attributes, state, sourceWatermark: watermark,
      effectiveAt: at, observedAt: at });
    this.appendEvidence(entity, lineFact(row), `${entityType}.snapshot`, state, at);
    return entity;
  }

  private appendEvidence(
    entity: TwinEntity, source: SourceFact, factPath: string, value: unknown, at: string,
    sourceSemantics: 'verified_external' | 'approved_human' | 'deterministic' | 'observed_backfill' = 'deterministic',
  ) {
    return this.context.appendEvidence({ entityId: entity.id, sourceSemantics,
      sourceKind: source.table, sourceId: source.primaryKey, sourceVersion: source.sourceVersion,
      sourceHash: source.contentHash, factPath, value: redactSensitiveValue(value), confidence: 1,
      effectiveAt: at, observedAt: at,
      actorId: 'system:procurement-po-projector', rawReference: source });
  }

  private appendContextEvidence(
    contextRoot: TwinEntity, entity: TwinEntity, source: SourceFact, factPath: string, value: unknown, at: string,
    sourceSemantics: 'verified_external' | 'approved_human' | 'deterministic' | 'observed_backfill' = 'deterministic',
  ) {
    return this.appendEvidence(
      entity, source, `${factPath}.context.${contextRoot.id}`,
      contextScopedValue(value, contextRoot.id), at, sourceSemantics,
    );
  }

  private relate(
    contextRoot: TwinEntity, from: TwinEntity, to: TwinEntity,
    relationType: RelationType, source: SourceFact, at: string,
  ): void {
    const evidence = this.appendContextEvidence(contextRoot, to, source, `relation.${relationType}.${from.id}.${to.id}`, {
      fromBusinessObjectId: from.attributes.businessObjectId, toBusinessObjectId: to.attributes.businessObjectId,
    }, at);
    this.context.upsertRelation({ relationType, fromEntityId: from.id, toEntityId: to.id,
      status: 'active', sourceEvidenceId: evidence.id, validFrom: at });
  }
}
