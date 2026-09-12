import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type {
  OdooGoodsReceipt,
  OdooPo,
  OdooSupplierMasterResult,
  OdooVendorInvoice,
} from '@readywork/connectors';
import type {
  ProcurementDocument,
  ProcurementLine,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderLineQuantityEvent,
  PurchaseOrderLineQuantityProjection,
  Receipt,
  ReceiptLine,
  Supplier,
  SupplierInvoice,
  SupplierInvoiceLine,
} from '@readywork/core';
import {
  applyPurchaseOrderLineQuantityEvent,
  createPurchaseOrderLineQuantityProjection,
} from '@readywork/core';
import {
  enqueueTwinProjectionInCurrentTransaction,
  persistProcurementLineProjectionInCurrentTransaction,
  twinProjectionPayloadHash,
} from '@readywork/persistence';
import { can, type Session } from './auth.js';
import { publicIntegrationError } from './http-errors.js';

export interface OdooProcurementReader {
  listSupplierMasters(): Promise<OdooSupplierMasterResult>;
  listPOs(): Promise<OdooPo[]>;
  listGoodsReceipts(): Promise<OdooGoodsReceipt[]>;
  listVendorInvoices(): Promise<OdooVendorInvoice[]>;
}

export interface OdooProcurementSnapshot {
  suppliers: OdooSupplierMasterResult;
  purchaseOrders: OdooPo[];
  receipts: OdooGoodsReceipt[];
  invoices: OdooVendorInvoice[];
}

export type OdooImportKind = 'suppliers' | 'purchaseOrders' | 'purchaseOrderLines' | 'receipts' | 'receiptLines' | 'invoices' | 'invoiceLines';

export interface OdooImportStats {
  seen: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

export interface OdooImportIssue {
  kind: OdooImportKind;
  externalId: string;
  code: string;
  message: string;
}

export interface OdooProcurementSyncResult {
  ok: true;
  source: 'odoo';
  tenantId: string;
  snapshotHash: string;
  replayed: boolean;
  syncedAt: string;
  stats: Record<OdooImportKind, OdooImportStats>;
  issues: OdooImportIssue[];
}

interface SyncContext {
  db: DatabaseSync;
  session: Session | null;
  /** Resolve at request time; never retain a startup tenant's ERP client. */
  readerForTenant?: (tenantId: string) => OdooProcurementReader | undefined;
}

interface CandidateDocument<T extends ProcurementDocument = ProcurementDocument> {
  kind: 'supplier' | 'purchase_order' | 'receipt' | 'invoice';
  statKind: Extract<OdooImportKind, 'suppliers' | 'purchaseOrders' | 'receipts' | 'invoices'>;
  document: T;
}

interface CandidateLine<T extends ProcurementLine = ProcurementLine> {
  kind: 'purchase_order_line' | 'receipt_line' | 'invoice_line';
  statKind: Extract<OdooImportKind, 'purchaseOrderLines' | 'receiptLines' | 'invoiceLines'>;
  documentId: string;
  line: T;
}

const IMPORT_KINDS: OdooImportKind[] = ['suppliers', 'purchaseOrders', 'purchaseOrderLines', 'receipts', 'receiptLines', 'invoices', 'invoiceLines'];

function emptyStats(): Record<OdooImportKind, OdooImportStats> {
  return Object.fromEntries(IMPORT_KINDS.map((kind) => [kind, { seen: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 }])) as Record<OdooImportKind, OdooImportStats>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readIdempotencyKey(req: IncomingMessage): string | undefined {
  const raw = req.headers['idempotency-key'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return undefined;
  if (value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error('INVALID_IDEMPOTENCY_KEY');
  return value;
}

export async function handleOdooProcurementSyncRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: SyncContext,
): Promise<boolean> {
  if (path !== '/api/procurement/odoo/sync') return false;
  if (method !== 'POST') { sendJson(res, 405, { error: `不支持的方法: ${method}`, code: 'METHOD_NOT_ALLOWED' }); return true; }
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  if (!can(context.session, 'operate')) { sendJson(res, 403, { error: '当前角色无「operate」权限', code: 'FORBIDDEN' }); return true; }
  const reader = context.readerForTenant?.(context.session.tenantId);
  if (!reader) { sendJson(res, 503, { error: '当前租户的 Odoo 连接未配置、未验证或不可用', code: 'ODOO_UNAVAILABLE' }); return true; }
  let idempotencyKey: string | undefined;
  try { idempotencyKey = readIdempotencyKey(req); }
  catch { sendJson(res, 400, { error: 'Idempotency-Key 无效', code: 'INVALID_IDEMPOTENCY_KEY' }); return true; }
  try {
    const snapshot = await pullOdooProcurementSnapshot(reader);
    const result = importOdooProcurementSnapshot(context.db, context.session.tenantId, snapshot, {
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof OdooSyncIdempotencyConflictError) {
      sendJson(res, 409, { error: '幂等键已用于不同的 Odoo 快照', code: 'ODOO_SYNC_IDEMPOTENCY_CONFLICT' });
      return true;
    }
    sendJson(res, 502, { error: publicIntegrationError(error), code: 'ODOO_SYNC_FAILED' });
  }
  return true;
}

export async function pullOdooProcurementSnapshot(reader: OdooProcurementReader): Promise<OdooProcurementSnapshot> {
  const [suppliers, purchaseOrders, receipts, invoices] = await Promise.all([
    reader.listSupplierMasters(),
    reader.listPOs(),
    reader.listGoodsReceipts(),
    reader.listVendorInvoices(),
  ]);
  return { suppliers, purchaseOrders, receipts, invoices };
}

export class OdooSyncIdempotencyConflictError extends Error {
  constructor() { super('Odoo sync idempotency conflict'); this.name = 'OdooSyncIdempotencyConflictError'; }
}

export function importOdooProcurementSnapshot(
  db: DatabaseSync,
  tenantId: string,
  snapshot: OdooProcurementSnapshot,
  options: { idempotencyKey?: string; syncedAt?: string } = {},
): OdooProcurementSyncResult {
  if (!tenantId.trim()) throw new Error('租户 ID 不能为空');
  const syncedAt = options.syncedAt ?? new Date().toISOString();
  if (!validDate(syncedAt)) throw new Error('syncedAt 必须是有效日期');
  const snapshotHash = hashSnapshot(snapshot);
  const idempotencyKey = options.idempotencyKey ?? `odoo-snapshot:${snapshotHash}`;
  const stats = emptyStats();
  const issues: OdooImportIssue[] = snapshot.suppliers.issues.map((issue) => ({
    kind: 'suppliers', externalId: `row:${issue.row}`, code: issue.reason, message: '该 Odoo 供应商主数据行缺少必填标识',
  }));

  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare(`SELECT snapshot_hash,response_json FROM procurement_odoo_sync_runs
      WHERE tenant_id=? AND idempotency_key=?`).get(tenantId, idempotencyKey) as { snapshot_hash: string; response_json: string } | undefined;
    if (previous) {
      if (previous.snapshot_hash !== snapshotHash) throw new OdooSyncIdempotencyConflictError();
      const replay = JSON.parse(previous.response_json) as OdooProcurementSyncResult;
      db.exec('COMMIT');
      return { ...replay, replayed: true };
    }

    const candidates = buildCandidates(tenantId, snapshot, syncedAt, stats, issues);
    const acceptedDocumentIds = new Set<string>();
    for (const candidate of candidates.documents) {
      if (upsertDocument(db, tenantId, candidate, syncedAt, stats, issues)) acceptedDocumentIds.add(candidate.document.id);
    }
    const acceptedLineIds = new Set<string>();
    for (const candidate of candidates.lines) {
      if (!acceptedDocumentIds.has(candidate.documentId)) {
        skip(stats, issues, candidate.statKind, candidate.line.id, 'PARENT_NOT_IMPORTED', '行单据的头单未导入');
        continue;
      }
      if (upsertLine(db, tenantId, candidate, stats, issues)) acceptedLineIds.add(candidate.line.id);
    }
    projectOdooPurchaseOrderLifecycle(db, tenantId, candidates, acceptedDocumentIds, acceptedLineIds, syncedAt);

    const result: OdooProcurementSyncResult = {
      ok: true, source: 'odoo', tenantId, snapshotHash, replayed: false, syncedAt, stats, issues,
    };
    db.prepare(`INSERT INTO procurement_odoo_sync_runs
      (tenant_id,idempotency_key,snapshot_hash,response_json,created_at) VALUES (?,?,?,?,?)`)
      .run(tenantId, idempotencyKey, snapshotHash, JSON.stringify(result), syncedAt);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

function buildCandidates(
  tenantId: string,
  snapshot: OdooProcurementSnapshot,
  syncedAt: string,
  stats: Record<OdooImportKind, OdooImportStats>,
  issues: OdooImportIssue[],
): { documents: CandidateDocument[]; lines: CandidateLine[] } {
  const documents: CandidateDocument[] = [];
  const lines: CandidateLine[] = [];
  const supplierByPartnerId = new Map<number, Supplier>();

  for (const master of snapshot.suppliers.items) {
    stats.suppliers.seen += 1;
    const match = /^odoo-partner-([1-9]\d*)$/.exec(master.externalId);
    if (!match || !master.name.trim()) { skip(stats, issues, 'suppliers', master.externalId, 'INVALID_SUPPLIER', '供应商缺少稳定 Odoo ID 或名称'); continue; }
    const partnerId = Number(match[1]);
    const supplier: Supplier = {
      id: supplierId(partnerId), tenantId, sourceSystem: 'odoo', externalId: master.externalId,
      status: master.status, createdAt: syncedAt, updatedAt: syncedAt, name: master.name.trim(),
      currency: master.currency.trim(),
      contacts: master.contacts.map((contact, index) => ({
        id: `supplier-contact:odoo:${partnerId}:${index}`, name: contact.name.trim() || master.name.trim(),
        ...(contact.email.trim() ? { email: contact.email.trim() } : {}),
        ...(contact.phone.trim() ? { phone: contact.phone.trim() } : {}), primary: index === 0,
      })),
      ...(master.countryCode?.trim() ? { countryCode: master.countryCode.trim().toUpperCase() } : {}),
      ...(master.countryName?.trim() ? { countryName: master.countryName.trim() } : {}),
      ...(master.city?.trim() ? { city: master.city.trim() } : {}),
      ...(master.street?.trim() ? { street: master.street.trim() } : {}),
      ...(master.street2?.trim() ? { street2: master.street2.trim() } : {}),
      ...(master.postalCode?.trim() ? { postalCode: master.postalCode.trim() } : {}),
    };
    supplierByPartnerId.set(partnerId, supplier);
  }

  for (const po of snapshot.purchaseOrders) {
    const partnerId = parsePoPartnerId(po.supplierId);
    if (partnerId && !supplierByPartnerId.has(partnerId) && po.supplierName.trim()) {
      stats.suppliers.seen += 1;
      supplierByPartnerId.set(partnerId, {
        id: supplierId(partnerId), tenantId, sourceSystem: 'odoo', externalId: `odoo-partner-${partnerId}`,
        status: 'observed', createdAt: syncedAt, updatedAt: syncedAt, name: po.supplierName.trim(), currency: po.currency.trim(),
        contacts: po.supplierEmail.trim() ? [{ id: `supplier-contact:odoo:${partnerId}:0`, name: po.supplierName.trim(), email: po.supplierEmail.trim(), primary: true }] : [],
      });
    }
  }
  for (const invoice of snapshot.invoices) {
    if (invoice.supplierId > 0 && !supplierByPartnerId.has(invoice.supplierId) && invoice.supplierName.trim()) {
      stats.suppliers.seen += 1;
      supplierByPartnerId.set(invoice.supplierId, {
        id: supplierId(invoice.supplierId), tenantId, sourceSystem: 'odoo', externalId: `odoo-partner-${invoice.supplierId}`,
        status: 'observed', createdAt: syncedAt, updatedAt: syncedAt, name: invoice.supplierName.trim(), currency: invoice.currency.trim(), contacts: [],
      });
    }
  }
  for (const supplier of supplierByPartnerId.values()) documents.push({ kind: 'supplier', statKind: 'suppliers', document: supplier });

  const poByOdooId = new Map<number, string>();
  const poByName = new Map<string, string>();
  const duplicatePoNames = duplicateValues(snapshot.purchaseOrders.map((po) => po.name.trim()).filter(Boolean));
  const poLineByOdooId = new Map<number, { id: string; poId: string }>();
  for (const po of snapshot.purchaseOrders) {
    stats.purchaseOrders.seen += 1;
    const externalId = `purchase.order:${po.id}`;
    const partnerId = parsePoPartnerId(po.supplierId);
    if (!positiveInteger(po.id) || !po.name.trim() || !partnerId || !po.currency.trim() || !po.state.trim() || !validDate(po.dateOrder)) {
      skip(stats, issues, 'purchaseOrders', externalId, 'INVALID_PURCHASE_ORDER', '采购单缺少 Odoo ID、编号、供应商、币种或下单日期');
      continue;
    }
    if (!supplierByPartnerId.has(partnerId)) {
      skip(stats, issues, 'purchaseOrders', externalId, 'SUPPLIER_NOT_FOUND', '采购单关联的 Odoo 供应商不完整');
      continue;
    }
    const id = `purchase-order:odoo:${po.id}`;
    const orderedAt = iso(po.dateOrder)!;
    const confirmedAt = iso(po.confirmedAt);
    const document: PurchaseOrder & Record<string, unknown> = {
      id, tenantId, sourceSystem: 'odoo', externalId, status: mapPoStatus(po.state), createdAt: orderedAt,
      updatedAt: syncedAt, supplierId: supplierId(partnerId), currency: po.currency.trim(), orderedAt,
      number: po.name.trim(), amountTotal: po.amountTotal, amountUntaxed: po.amountUntaxed,
      odooState: po.state, promisedAt: iso(po.promiseDate) ?? null,
      ...(confirmedAt ? { confirmedAt } : {}),
      ...(po.incotermId !== undefined && positiveInteger(po.incotermId) ? { incotermId: po.incotermId } : {}),
      ...(po.incotermName?.trim() ? { incotermName: po.incotermName.trim() } : {}),
      ...(po.incotermLocation?.trim() ? { incotermLocation: po.incotermLocation.trim() } : {}),
      ...(po.dropshipAddressId !== undefined && positiveInteger(po.dropshipAddressId) ? { dropshipAddressId: po.dropshipAddressId } : {}),
      ...(po.dropshipAddressName?.trim() ? { dropshipAddressName: po.dropshipAddressName.trim() } : {}),
      ...(po.deliveryOperationTypeId !== undefined && positiveInteger(po.deliveryOperationTypeId) ? { deliveryOperationTypeId: po.deliveryOperationTypeId } : {}),
      ...(po.deliveryOperationTypeName?.trim() ? { deliveryOperationTypeName: po.deliveryOperationTypeName.trim() } : {}),
    };
    documents.push({ kind: 'purchase_order', statKind: 'purchaseOrders', document });
    poByOdooId.set(po.id, id);
    if (!duplicatePoNames.has(po.name.trim())) poByName.set(po.name.trim(), id);
    for (const line of po.lines) {
      stats.purchaseOrderLines.seen += 1;
      if (!positiveInteger(line.id) || !Number.isFinite(line.qty) || line.qty <= 0 || !Number.isFinite(line.priceUnit)) {
        skip(stats, issues, 'purchaseOrderLines', `purchase.order.line:${line.id}`, 'INVALID_PO_LINE', '采购单行缺少稳定 ID 或数量/价格无效'); continue;
      }
      const lineId = `purchase-order-line:odoo:${line.id}`;
      const poLine: PurchaseOrderLine = {
        id: lineId, poId: id, lineNumber: String(line.id), itemId: itemId('purchase.order.line', line.productId, line.id),
        ...(line.product.trim() ? { description: line.product.trim() } : {}), uom: line.unit.trim(), orderedQty: line.qty,
        unitPrice: line.priceUnit, currency: po.currency.trim(), ...(iso(line.datePlanned) ? { requestedAt: iso(line.datePlanned)! } : {}),
      };
      lines.push({ kind: 'purchase_order_line', statKind: 'purchaseOrderLines', documentId: id, line: poLine });
      poLineByOdooId.set(line.id, { id: lineId, poId: id });
    }
  }

  for (const receipt of snapshot.receipts) {
    stats.receipts.seen += 1;
    const externalId = `stock.picking:${receipt.id}`;
    if (receipt.state !== 'done') { skip(stats, issues, 'receipts', externalId, 'RECEIPT_NOT_DONE', '未完成的 Odoo 入库单不记为实际收货'); continue; }
    const poIds = new Set(receipt.lines.map((line) => line.poLineId ? poLineByOdooId.get(line.poLineId)?.poId : undefined).filter((id): id is string => Boolean(id)));
    const poId = poIds.size === 1 ? [...poIds][0]! : poByName.get(receipt.poName.trim());
    if (!positiveInteger(receipt.id) || !poId || !validDate(receipt.doneDate) || !receipt.warehouseLocationId) {
      skip(stats, issues, 'receipts', externalId, 'INVALID_RECEIPT', '收货单缺少 Odoo ID、采购单行关联、完成时间或收货库位'); continue;
    }
    const id = `receipt:odoo:${receipt.id}`;
    const receivedAt = iso(receipt.doneDate)!;
    const document: Receipt & Record<string, unknown> = {
      id, tenantId, sourceSystem: 'odoo', externalId, status: 'received', createdAt: iso(receipt.createdAt) ?? receivedAt,
      updatedAt: iso(receipt.updatedAt) ?? receivedAt, poId, warehouseId: `warehouse-location:odoo:${receipt.warehouseLocationId}`, receivedAt,
      reference: receipt.name, warehouseLocationName: receipt.warehouseLocationName, odooState: receipt.state,
    };
    documents.push({ kind: 'receipt', statKind: 'receipts', document });
    for (const line of receipt.lines) {
      stats.receiptLines.seen += 1;
      const linked = line.poLineId ? poLineByOdooId.get(line.poLineId) : undefined;
      if (!positiveInteger(line.id) || !linked || linked.poId !== poId || !Number.isFinite(line.quantity) || line.quantity <= 0) {
        skip(stats, issues, 'receiptLines', `stock.move.line:${line.id}`, 'INVALID_RECEIPT_LINE', '收货行缺少采购单行关联或实收数量无效'); continue;
      }
      const receiptLine: ReceiptLine = {
        id: `receipt-line:odoo:${line.id}`, receiptId: id, poLineId: linked.id, lineNumber: String(line.id),
        itemId: itemId('stock.move.line', line.productId, line.id), ...(line.product.trim() ? { description: line.product.trim() } : {}),
        uom: line.unit.trim(), receivedQty: line.quantity,
      };
      lines.push({ kind: 'receipt_line', statKind: 'receiptLines', documentId: id, line: receiptLine });
    }
  }

  for (const invoice of snapshot.invoices) {
    stats.invoices.seen += 1;
    const externalId = `account.move:${invoice.id}`;
    const linkedPoIds = new Set(invoice.lines.map((line) => line.poLineId ? poLineByOdooId.get(line.poLineId)?.poId : line.poId ? poByOdooId.get(line.poId) : undefined).filter((id): id is string => Boolean(id)));
    const poId = linkedPoIds.size === 1 ? [...linkedPoIds][0]! : poByName.get(invoice.poName.trim());
    if (!positiveInteger(invoice.id) || !positiveInteger(invoice.supplierId) || !invoice.name.trim() || !invoice.currency.trim() || !invoice.state.trim() || !validDate(invoice.date) || !supplierByPartnerId.has(invoice.supplierId)) {
      skip(stats, issues, 'invoices', externalId, 'INVALID_INVOICE', '发票缺少 Odoo ID、供应商、发票号、币种或发票日期'); continue;
    }
    const id = `invoice:odoo:${invoice.id}`;
    const invoiceDate = iso(invoice.date)!;
    const document: SupplierInvoice & Record<string, unknown> = {
      id, tenantId, sourceSystem: 'odoo', externalId, status: mapInvoiceStatus(invoice.state),
      createdAt: iso(invoice.createdAt) ?? invoiceDate, updatedAt: iso(invoice.updatedAt) ?? invoiceDate,
      supplierId: supplierId(invoice.supplierId), invoiceNumber: invoice.name.trim(), currency: invoice.currency.trim(), invoiceDate,
      ...(poId ? { poId } : {}), poReference: invoice.poName.trim(), amountTotal: invoice.amountTotal,
      amountUntaxed: invoice.amountUntaxed, paymentState: invoice.paymentState, odooState: invoice.state,
    };
    documents.push({ kind: 'invoice', statKind: 'invoices', document });
    for (const line of invoice.lines) {
      stats.invoiceLines.seen += 1;
      const linked = line.poLineId ? poLineByOdooId.get(line.poLineId) : undefined;
      if (!positiveInteger(line.id) || !Number.isFinite(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.unitPrice) || !Number.isFinite(line.subtotal)) {
        skip(stats, issues, 'invoiceLines', `account.move.line:${line.id}`, 'INVALID_INVOICE_LINE', '发票行缺少稳定 ID 或数量/金额无效'); continue;
      }
      const invoiceLine: SupplierInvoiceLine = {
        id: `invoice-line:odoo:${line.id}`, invoiceId: id, lineNumber: String(line.id),
        itemId: itemId('account.move.line', line.productId, line.id), ...(line.product.trim() ? { description: line.product.trim() } : {}),
        uom: line.unit.trim(), ...(linked ? { poLineId: linked.id } : {}), invoicedQty: line.quantity,
        unitPrice: line.unitPrice, netAmount: line.subtotal, currency: line.currency.trim() || invoice.currency.trim(),
      };
      lines.push({ kind: 'invoice_line', statKind: 'invoiceLines', documentId: id, line: invoiceLine });
    }
  }
  return { documents, lines };
}

function upsertDocument(
  db: DatabaseSync,
  tenantId: string,
  candidate: CandidateDocument,
  syncedAt: string,
  stats: Record<OdooImportKind, OdooImportStats>,
  issues: OdooImportIssue[],
): boolean {
  const { document, kind, statKind } = candidate;
  const external = db.prepare(`SELECT id,version,json FROM procurement_documents
    WHERE tenant_id=? AND kind=? AND source_system=? AND external_id=?`)
    .get(tenantId, kind, document.sourceSystem, document.externalId) as { id: string; version: number; json: string } | undefined;
  const idRow = db.prepare(`SELECT source_system,external_id FROM procurement_documents WHERE tenant_id=? AND kind=? AND id=?`)
    .get(tenantId, kind, document.id) as { source_system: string; external_id: string } | undefined;
  if (!external && idRow && (idRow.source_system !== document.sourceSystem || idRow.external_id !== document.externalId)) {
    skip(stats, issues, statKind, document.externalId, 'DOCUMENT_ID_CONFLICT', '本地单据 ID 已被其他外部对象使用'); return false;
  }
  if (!external && kind === 'invoice') {
    const invoice = document as SupplierInvoice;
    const duplicate = db.prepare(`SELECT source_system,external_id FROM procurement_documents
      WHERE tenant_id=? AND kind='invoice' AND json_extract(json,'$.supplierId')=? AND json_extract(json,'$.invoiceNumber')=?`)
      .get(tenantId, invoice.supplierId, invoice.invoiceNumber) as { source_system: string; external_id: string } | undefined;
    if (duplicate) { skip(stats, issues, statKind, document.externalId, 'DUPLICATE_INVOICE_IDENTITY', '相同供应商与发票号已关联其他来源记录'); return false; }
  }
  if (!external) {
    db.prepare(`INSERT INTO procurement_documents
      (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(tenantId, kind, document.id, document.sourceSystem, document.externalId, document.status, 1, JSON.stringify(document), document.createdAt, document.updatedAt);
    enqueueDocumentProjection(db, tenantId, kind, document, 1);
    stats[statKind].created += 1;
    return true;
  }
  if (external.id !== document.id) {
    skip(stats, issues, statKind, document.externalId, 'EXTERNAL_ID_MAPPING_CONFLICT', '该 Odoo 外部 ID 已绑定另一个本地单据 ID'); return false;
  }
  const stored = JSON.parse(external.json) as ProcurementDocument;
  const mergedStatus = kind === 'purchase_order'
    ? mergeImportedPurchaseOrderStatus(stored.status, document.status)
    : document.status;
  const merged = { ...document, status: mergedStatus, createdAt: stored.createdAt, updatedAt: syncedAt } as ProcurementDocument;
  if (sameBusinessContent(stored, merged)) { stats[statKind].unchanged += 1; return true; }
  db.prepare(`UPDATE procurement_documents SET status=?,version=?,json=?,updated_at=?
    WHERE tenant_id=? AND kind=? AND id=? AND version=?`)
    .run(merged.status, external.version + 1, JSON.stringify(merged), syncedAt, tenantId, kind, document.id, external.version);
  enqueueDocumentProjection(db, tenantId, kind, merged, external.version + 1);
  stats[statKind].updated += 1;
  return true;
}

function upsertLine(
  db: DatabaseSync,
  tenantId: string,
  candidate: CandidateLine,
  stats: Record<OdooImportKind, OdooImportStats>,
  issues: OdooImportIssue[],
): boolean {
  const parent = db.prepare('SELECT 1 AS ok FROM procurement_documents WHERE tenant_id=? AND id=?').get(tenantId, candidate.documentId);
  if (!parent) { skip(stats, issues, candidate.statKind, candidate.line.id, 'PARENT_NOT_IMPORTED', '行单据的头单未导入'); return false; }
  const existing = db.prepare('SELECT document_id FROM procurement_lines WHERE tenant_id=? AND kind=? AND id=?')
    .get(tenantId, candidate.kind, candidate.line.id) as { document_id: string } | undefined;
  if (!existing) {
    const lineNumberConflict = db.prepare('SELECT id FROM procurement_lines WHERE tenant_id=? AND kind=? AND document_id=? AND line_number=?')
      .get(tenantId, candidate.kind, candidate.documentId, candidate.line.lineNumber);
    if (lineNumberConflict) { skip(stats, issues, candidate.statKind, candidate.line.id, 'LINE_NUMBER_CONFLICT', '单据行号已绑定其他外部行'); return false; }
    const parentRow = db.prepare(`SELECT updated_at FROM procurement_documents WHERE tenant_id=? AND id=?`)
      .get(tenantId, candidate.documentId) as { updated_at: string };
    persistProcurementLineProjectionInCurrentTransaction(db, {
      tenantId, kind: candidate.kind, lineId: candidate.line.id, documentId: candidate.documentId,
      lineNumber: candidate.line.lineNumber, line: candidate.line, availableAt: parentRow.updated_at,
    });
    stats[candidate.statKind].created += 1;
    return true;
  }
  if (existing.document_id !== candidate.documentId) { skip(stats, issues, candidate.statKind, candidate.line.id, 'LINE_PARENT_CONFLICT', '外部行已绑定其他头单'); return false; }
  const parentRow = db.prepare(`SELECT updated_at FROM procurement_documents WHERE tenant_id=? AND id=?`)
    .get(tenantId, candidate.documentId) as { updated_at: string };
  const persisted = persistProcurementLineProjectionInCurrentTransaction(db, {
    tenantId, kind: candidate.kind, lineId: candidate.line.id, documentId: candidate.documentId,
    lineNumber: candidate.line.lineNumber, line: candidate.line, availableAt: parentRow.updated_at,
  });
  stats[candidate.statKind][persisted.disposition === 'unchanged' ? 'unchanged' : 'updated'] += 1;
  return true;
}

function projectOdooPurchaseOrderLifecycle(
  db: DatabaseSync,
  tenantId: string,
  candidates: { documents: CandidateDocument[]; lines: CandidateLine[] },
  acceptedDocumentIds: ReadonlySet<string>,
  acceptedLineIds: ReadonlySet<string>,
  syncedAt: string,
): void {
  const poDocuments = candidates.documents
    .filter((candidate): candidate is CandidateDocument<PurchaseOrder> => candidate.kind === 'purchase_order' && acceptedDocumentIds.has(candidate.document.id));
  const poLines = candidates.lines
    .filter((candidate): candidate is CandidateLine<PurchaseOrderLine> => candidate.kind === 'purchase_order_line' && acceptedLineIds.has(candidate.line.id));
  const poLineById = new Map(poLines.map((candidate) => [candidate.line.id, candidate.line]));

  // Odoo purchase/done is an authoritative PO commitment observation. Fill
  // only the unconfirmed remainder so an earlier supplier confirmation is not
  // counted twice merely because the ERP snapshot contains the same PO.
  for (const candidate of poDocuments) {
    if (candidate.document.status !== 'confirmed') continue;
    const confirmedAt = (candidate.document as PurchaseOrder & { confirmedAt?: string }).confirmedAt;
    if (confirmedAt) {
      insertOdooStageEvent(
        db, tenantId, candidate.document.id, 'po_sent', 'odoo_purchase_order_confirmed', 'completed',
        confirmedAt, `${candidate.document.externalId}:${confirmedAt}`, 'odoo_purchase_order', {
          externalId: candidate.document.externalId,
          purchaseOrderNumber: (candidate.document as PurchaseOrder & { number?: string }).number,
          confirmedAt,
          sourceSystem: 'odoo',
          exactTransitionTime: true,
        },
      );
    }
    for (const lineCandidate of poLines.filter((line) => line.documentId === candidate.document.id)) {
      const current = loadQuantityProjection(db, tenantId, lineCandidate.line);
      const delta = lineCandidate.line.orderedQty - current.confirmedQty;
      if (delta > 0) persistOdooQuantityEvent(db, tenantId, lineCandidate.line, {
        sourceEntityId: lineCandidate.line.id,
        dimension: 'confirmed',
        delta,
        occurredAt: candidate.document.orderedAt,
        sourceRevision: candidate.document.updatedAt,
      });
    }
  }

  const receipts = candidates.documents
    .filter((candidate): candidate is CandidateDocument<Receipt> => candidate.kind === 'receipt' && acceptedDocumentIds.has(candidate.document.id))
    .sort((left, right) => left.document.receivedAt.localeCompare(right.document.receivedAt) || left.document.id.localeCompare(right.document.id));
  const receiptLines = candidates.lines
    .filter((candidate): candidate is CandidateLine<ReceiptLine> => candidate.kind === 'receipt_line' && acceptedLineIds.has(candidate.line.id));

  for (const candidate of receiptLines) {
    const line = poLineById.get(candidate.line.poLineId);
    const receipt = receipts.find((item) => item.document.id === candidate.documentId)?.document;
    if (!line || !receipt) continue;
    const currentSourceTotal = sourceEntityQuantity(db, tenantId, candidate.line.id, 'received');
    const delta = candidate.line.receivedQty - currentSourceTotal;
    if (delta !== 0) persistOdooQuantityEvent(db, tenantId, line, {
      sourceEntityId: candidate.line.id,
      dimension: 'received',
      delta,
      occurredAt: receipt.updatedAt,
      sourceRevision: receipt.updatedAt,
    });
  }

  const receiptsByPo = new Map<string, Receipt[]>();
  for (const candidate of receipts) {
    const list = receiptsByPo.get(candidate.document.poId) ?? [];
    list.push(candidate.document);
    receiptsByPo.set(candidate.document.poId, list);
  }
  for (const candidate of poDocuments) {
    const lines = poLines.filter((line) => line.documentId === candidate.document.id).map((line) => line.line);
    if (!lines.length) continue;
    const projections = lines.map((line) => loadQuantityProjection(db, tenantId, line));
    const hasReceipt = projections.some((projection) => projection.receivedQty > 0);
    if (!hasReceipt && !['partially_received', 'received'].includes(candidate.document.status)) continue;
    const complete = projections.every((projection) => projection.receivedQty + projection.cancelledQty >= projection.orderedQty);
    const nextStatus = complete ? 'received' : 'partially_received';
    const poReceipts = receiptsByPo.get(candidate.document.id) ?? [];
    const latestReceipt = poReceipts.at(-1);
    updateOdooPurchaseOrderStatus(db, tenantId, candidate.document.id, nextStatus, latestReceipt?.updatedAt ?? syncedAt);
    poReceipts.forEach((receipt, index) => {
      const completesPo = complete && index === poReceipts.length - 1;
      const evidence = {
        receiptId: receipt.id,
        externalId: receipt.externalId,
        receivedAt: receipt.receivedAt,
        warehouseId: receipt.warehouseId,
        receiptLineIds: receiptLines.filter((line) => line.documentId === receipt.id).map((line) => line.line.id),
        receiptComplete: completesPo,
        sourceSystem: 'odoo',
        exactTransitionTime: true,
      };
      const stageSourceId = `${receipt.id}:${receipt.updatedAt}`;
      insertOdooStageEvent(db, tenantId, candidate.document.id, 'dispatch_transit', completesPo ? 'final_arrival_recorded' : 'partial_arrival_recorded', completesPo ? 'completed' : 'active', receipt.updatedAt, stageSourceId, 'odoo_grn', evidence);
      insertOdooStageEvent(db, tenantId, candidate.document.id, 'delivery_grn', completesPo ? 'grn_completed' : 'partial_grn_recorded', completesPo ? 'completed' : 'active', receipt.updatedAt, stageSourceId, 'odoo_grn', evidence);
    });
  }
}

function persistOdooQuantityEvent(
  db: DatabaseSync,
  tenantId: string,
  line: PurchaseOrderLine,
  input: { sourceEntityId: string; dimension: 'confirmed' | 'received'; delta: number; occurredAt: string; sourceRevision: string },
): void {
  const fingerprint = createHash('sha256').update(stableJson(input)).digest('hex').slice(0, 24);
  const event: PurchaseOrderLineQuantityEvent = {
    tenantId,
    sourceSystem: 'odoo',
    sourceEventId: `${input.sourceEntityId}:${input.dimension}:${fingerprint}`,
    poLineId: line.id,
    dimension: input.dimension,
    delta: input.delta,
    occurredAt: input.occurredAt,
  };
  const current = loadQuantityProjection(db, tenantId, line);
  const result = applyPurchaseOrderLineQuantityEvent(current, event);
  if (!result.applied) return;
  db.prepare(`INSERT INTO procurement_po_line_quantity_events
    (tenant_id,source_system,source_event_id,po_line_id,dimension,delta,occurred_at,json)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    tenantId, event.sourceSystem, event.sourceEventId, event.poLineId, event.dimension, event.delta, event.occurredAt,
    JSON.stringify({ ...event, sourceEntityId: input.sourceEntityId, sourceRevision: input.sourceRevision }),
  );
  const eventPayload = { ...event, sourceEntityId: input.sourceEntityId, sourceRevision: input.sourceRevision };
  enqueueTwinProjectionInCurrentTransaction(db, {
    tenantId, sourceTable: 'procurement_po_line_quantity_events', sourceKey: `${event.sourceSystem}:${event.sourceEventId}`,
    sourceRevision: '1', eventType: 'procurement_po_line_quantity_event.created',
    payloadHash: twinProjectionPayloadHash(eventPayload), availableAt: input.occurredAt,
  });
  persistQuantityProjection(db, result.projection, input.sourceRevision);
}

function loadQuantityProjection(db: DatabaseSync, tenantId: string, line: PurchaseOrderLine): PurchaseOrderLineQuantityProjection {
  const row = db.prepare(`SELECT projection_json FROM procurement_po_line_quantity_projections WHERE tenant_id=? AND po_line_id=?`)
    .get(tenantId, line.id) as { projection_json: string } | undefined;
  if (!row) return createPurchaseOrderLineQuantityProjection(line, tenantId);
  const projection = JSON.parse(row.projection_json) as PurchaseOrderLineQuantityProjection;
  if (projection.orderedQty !== line.orderedQty) throw new Error(`Odoo PO 行 ${line.id} 数量已变更，需要显式的 PO 修订事件`);
  return projection;
}

function persistQuantityProjection(db: DatabaseSync, value: PurchaseOrderLineQuantityProjection, updatedAt: string): void {
  db.prepare(`INSERT INTO procurement_po_line_quantity_projections
    (tenant_id,po_line_id,ordered_qty,confirmed_qty,shipped_qty,received_qty,invoiced_qty,cancelled_qty,projection_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,po_line_id) DO UPDATE SET
      ordered_qty=excluded.ordered_qty,confirmed_qty=excluded.confirmed_qty,shipped_qty=excluded.shipped_qty,
      received_qty=excluded.received_qty,invoiced_qty=excluded.invoiced_qty,cancelled_qty=excluded.cancelled_qty,
      projection_json=excluded.projection_json,updated_at=excluded.updated_at`).run(
    value.tenantId, value.poLineId, value.orderedQty, value.confirmedQty, value.shippedQty,
    value.receivedQty, value.invoicedQty, value.cancelledQty, JSON.stringify(value), updatedAt,
  );
  const payloadHash = twinProjectionPayloadHash(value);
  enqueueTwinProjectionInCurrentTransaction(db, {
    tenantId: value.tenantId, sourceTable: 'procurement_po_line_quantity_projections', sourceKey: value.poLineId,
    sourceRevision: payloadHash, eventType: 'procurement_po_line_quantity_projection.changed', payloadHash, availableAt: updatedAt,
  });
}

function sourceEntityQuantity(db: DatabaseSync, tenantId: string, sourceEntityId: string, dimension: string): number {
  const row = db.prepare(`SELECT COALESCE(SUM(delta),0) AS total FROM procurement_po_line_quantity_events
    WHERE tenant_id=? AND source_system='odoo' AND dimension=? AND json_extract(json,'$.sourceEntityId')=?`)
    .get(tenantId, dimension, sourceEntityId) as { total: number };
  return Number(row.total);
}

function updateOdooPurchaseOrderStatus(db: DatabaseSync, tenantId: string, poId: string, status: string, updatedAt: string): void {
  const row = db.prepare(`SELECT version,status,json FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND id=?`)
    .get(tenantId, poId) as { version: number; status: string; json: string } | undefined;
  if (!row || row.status === status) return;
  const document = JSON.parse(row.json) as PurchaseOrder;
  const updated = { ...document, status, updatedAt };
  db.prepare(`UPDATE procurement_documents SET status=?,version=?,json=?,updated_at=?
    WHERE tenant_id=? AND kind='purchase_order' AND id=? AND version=?`)
    .run(status, row.version + 1, JSON.stringify(updated), updatedAt, tenantId, poId, row.version);
  enqueueDocumentProjection(db, tenantId, 'purchase_order', updated, row.version + 1);
}

function insertOdooStageEvent(
  db: DatabaseSync,
  tenantId: string,
  poId: string,
  stage: 'po_sent' | 'dispatch_transit' | 'delivery_grn',
  eventType: string,
  state: 'completed' | 'active',
  occurredAt: string,
  sourceId: string,
  sourceKind: 'odoo_purchase_order' | 'odoo_grn',
  evidence: Readonly<Record<string, unknown>>,
): void {
  const id = `po-stage-event:odoo:${createHash('sha256').update(`${poId}\0${stage}\0${eventType}\0${sourceId}`).digest('hex').slice(0, 32)}`;
  const inserted = db.prepare(`INSERT OR IGNORE INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,'connector:odoo',?,?)`)
    .run(tenantId, id, poId, stage, eventType, state, occurredAt, sourceKind, sourceId, JSON.stringify(evidence), occurredAt);
  if (Number(inserted.changes) === 1) enqueueTwinProjectionInCurrentTransaction(db, {
    tenantId, sourceTable: 'procurement_po_stage_events', sourceKey: id, sourceRevision: '1',
    eventType: 'procurement_po_stage_event.created', payloadHash: twinProjectionPayloadHash({
      id, poId, stage, eventType, state, occurredAt, sourceKind, sourceId,
      actorId: 'connector:odoo', evidence,
    }), availableAt: occurredAt,
  });
}

function enqueueDocumentProjection(
  db: DatabaseSync,
  tenantId: string,
  kind: string,
  document: ProcurementDocument,
  version: number,
): void {
  enqueueTwinProjectionInCurrentTransaction(db, {
    tenantId, sourceTable: 'procurement_documents', sourceKey: `${kind}:${document.id}`,
    sourceRevision: String(version), eventType: `${kind}.changed`,
    payloadHash: twinProjectionPayloadHash(document), availableAt: document.updatedAt,
  });
}

function mergeImportedPurchaseOrderStatus(storedStatus: string, importedStatus: string): string {
  if (importedStatus !== 'confirmed') return importedStatus;
  return ['in_production', 'awaiting_shipment', 'partially_shipped', 'shipped', 'partially_received', 'received'].includes(storedStatus)
    ? storedStatus
    : importedStatus;
}

function sameBusinessContent(left: ProcurementDocument, right: ProcurementDocument): boolean {
  const { createdAt: _lc, updatedAt: _lu, ...leftValue } = left;
  const { createdAt: _rc, updatedAt: _ru, ...rightValue } = right;
  return isDeepStrictEqual(leftValue, rightValue);
}

function skip(
  stats: Record<OdooImportKind, OdooImportStats>, issues: OdooImportIssue[], kind: OdooImportKind,
  externalId: string, code: string, message: string,
): void {
  stats[kind].skipped += 1;
  issues.push({ kind, externalId: String(externalId).slice(0, 200), code, message });
}

function parsePoPartnerId(value: string): number | undefined {
  const match = /^odoo-([1-9]\d*)$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

function supplierId(partnerId: number): string { return `supplier:odoo:${partnerId}`; }
function itemId(model: string, productId: number | undefined, lineId: number): string {
  return productId && positiveInteger(productId) ? `item:odoo:${productId}` : `item-reference:odoo:${model}:${lineId}`;
}

function mapPoStatus(state: string): string {
  switch (state) {
    case 'draft': case 'to approve': return 'draft';
    case 'sent': return 'sent';
    case 'purchase': return 'confirmed';
    // Odoo `done` means the purchase order is locked, not that GRN quantity is
    // complete. Receipt projection below derives partially_received/received.
    case 'done': return 'confirmed';
    case 'cancel': return 'cancelled';
    default: return state;
  }
}

function mapInvoiceStatus(state: string): string {
  if (state === 'cancel') return 'exception';
  if (state === 'draft' || state === 'posted') return 'received';
  return state;
}

function positiveInteger(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function validDate(value: string | null | undefined): boolean { return Boolean(value && Number.isFinite(Date.parse(value))); }
function iso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return validDate(normalized) ? new Date(Date.parse(normalized)).toISOString() : undefined;
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) { if (seen.has(value)) duplicates.add(value); else seen.add(value); }
  return duplicates;
}

function hashSnapshot(snapshot: OdooProcurementSnapshot): string {
  return createHash('sha256').update(stableJson(snapshot)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
