import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Activity,
  Award,
  ApprovalRequest,
  Communication,
  Exception as BusinessException,
  Item,
  ProcurementDocument,
  ProcurementRequisition,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderConfirmation,
  ProductionProgress,
  QuoteComparisonSnapshot,
  Receipt,
  RequestForQuotation,
  Shipment,
  TransportEvent,
  Supplier,
  SupplierInvoice,
  SupplierQuote,
  Task,
  ThreeWayMatch,
} from '@readywork/core';
import { calculateRiskModelV2, type RiskComponentInput } from '@readywork/core';
import { can, type Session } from './auth.js';
import { HttpError, redactSensitiveValue } from './http-errors.js';
import { routeEvidenceCandidates } from './procurement-route-evidence.js';
import { loadProcurementLeadTimeResolver } from './procurement-lead-times.js';
import { buildPoHistoryEvents } from './procurement-po-history.js';
import { effectiveProcurementTenantPreferences, getProcurementTenantPreferences } from './procurement-tenant-preferences.js';

interface WorkbenchContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly now?: () => Date;
  readonly connectorReady?: (connectorId: string) => boolean;
}

type SendPoReadinessCode =
  | 'ready'
  | 'communication_identity_missing'
  | 'email_connector_unavailable'
  | 'attachment_security_blocked'
  | 'send_in_flight'
  | 'invalid_state';

interface SendPoActionReadiness {
  readonly ready: boolean;
  readonly code: SendPoReadinessCode;
  readonly message: string;
  readonly target?: 'communication-identity' | 'connector-email' | 'documents';
}

type QueueFollowupReadinessCode =
  | 'ready'
  | 'communication_identity_missing'
  | 'supplier_email_missing'
  | 'invalid_state';

interface QueueFollowupActionReadiness {
  readonly ready: boolean;
  readonly code: QueueFollowupReadinessCode;
  readonly message: string;
  readonly target?: 'communication-identity';
}

type UpdateRihdReadinessCode =
  | 'ready'
  | 'invalid_state'
  | 'odoo_mapping_missing'
  | 'po_lines_missing'
  | 'update_in_flight'
  | 'erp_connector_unavailable';

interface UpdateRihdActionReadiness {
  readonly ready: boolean;
  readonly code: UpdateRihdReadinessCode;
  readonly message: string;
  readonly target?: 'connector-erp';
}

type MarkAtRiskReadinessCode = 'ready' | 'invalid_state' | 'already_marked';

interface MarkAtRiskActionReadiness {
  readonly ready: boolean;
  readonly code: MarkAtRiskReadinessCode;
  readonly message: string;
  readonly exceptionId?: string;
}

type DuplicatePoReadinessCode = 'ready' | 'supplier_missing' | 'po_lines_missing';

interface DuplicatePoActionReadiness {
  readonly ready: boolean;
  readonly code: DuplicatePoReadinessCode;
  readonly message: string;
}

interface CountRow { status: string; count: number }
interface JsonRow { json: string }
interface VersionedJsonRow extends JsonRow { version: number }
interface DocumentJsonRow extends VersionedJsonRow { kind: ProcurementWorkbenchKind }

/**
 * Visual-acceptance fixtures are retained in SQLite for auditability, but they
 * are not procurement facts and must never enter the V1 operational read
 * model, risk calculation, counters, or task context.
 */
const NON_VISUAL_TEST_EXCEPTION = "COALESCE(json_extract(json,'$.context.visualTest'),0) <> 1";
const NON_VISUAL_TEST_ACTIVITY = "COALESCE(json_extract(json,'$.actor'),'') <> 'visual-test' AND COALESCE(json_extract(json,'$.action'),'') <> 'visual.acceptance_created'";

type ProcurementWorkbenchKind =
  | 'item'
  | 'supplier'
  | 'requisition'
  | 'rfq'
  | 'quote'
  | 'quote_comparison'
  | 'award'
  | 'purchase_order'
  | 'confirmation'
  | 'production_progress'
  | 'shipment'
  | 'transport_event'
  | 'receipt'
  | 'invoice'
  | 'match'
  | 'communication';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function listLimit(req: IncomingMessage): number {
  const url = new URL(req.url ?? '/api/procurement/workbench', 'http://127.0.0.1');
  const raw = url.searchParams.get('limit');
  if (raw === null) return 20;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'limit 必须是 1 到 100 的整数', 'INVALID_WORKBENCH_LIMIT');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new HttpError(400, 'limit 必须是 1 到 100 的整数', 'INVALID_WORKBENCH_LIMIT');
  return value;
}

function countsByStatus(db: DatabaseSync, table: string, tenantId: string, extraWhere = '', args: readonly (string | number | null)[] = []): Record<string, number> {
  const rows = db.prepare(`
    SELECT status,COUNT(*) AS count FROM ${table}
    WHERE tenant_id=? ${extraWhere}
    GROUP BY status ORDER BY status
  `).all(tenantId, ...args) as unknown as CountRow[];
  return Object.fromEntries(rows.map((row) => [row.status || 'unknown', Number(row.count)]));
}

function total(byStatus: Record<string, number>): number {
  return Object.values(byStatus).reduce((sum, value) => sum + value, 0);
}

function parseJson<T>(row: JsonRow): T {
  const parsed = JSON.parse(row.json) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('持久化记录不是有效对象');
  return parsed as T;
}

function parseNullableJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const parsed = JSON.parse(String(value)) as unknown;
  if (parsed === null) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('持久化记录不是有效对象');
  return parsed as Record<string, unknown>;
}

function sqliteTableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonBlankText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function commonDocument(document: ProcurementDocument, version: number): Record<string, unknown> {
  return {
    id: document.id,
    externalId: document.externalId,
    sourceSystem: document.sourceSystem,
    status: document.status,
    version,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

/** Human-friendly source number (such as Odoo's P00022), never an identity key. */
function documentNumber(document: ProcurementDocument): string | null {
  const rawNumber = (document as unknown as Record<string, unknown>)['number'];
  return typeof rawNumber === 'string' ? rawNumber.trim() || null : null;
}

function documentSummary(kind: ProcurementWorkbenchKind, row: VersionedJsonRow): Record<string, unknown> {
  if (kind === 'item') {
    const document = parseJson<Item>(row);
    return {
      ...commonDocument(document, row.version),
      sku: document.sku,
      name: document.name,
      uom: document.uom,
      category: document.category ?? null,
      description: document.description ?? null,
    };
  }
  if (kind === 'supplier') {
    const document = parseJson<Supplier>(row);
    return {
      ...commonDocument(document, row.version),
      name: document.name,
      currency: document.currency,
      performanceScore: document.performanceScore ?? null,
      contactCount: Array.isArray(document.contacts) ? document.contacts.length : 0,
    };
  }
  if (kind === 'requisition') {
    const document = parseJson<ProcurementRequisition>(row);
    return {
      ...commonDocument(document, row.version),
      title: document.title ?? null,
      requesterId: document.requesterId,
      requestingDepartment: document.requestingDepartment ?? null,
      currency: document.currency ?? null,
      targetDeliveryDate: document.targetDeliveryDate ?? null,
    };
  }
  if (kind === 'rfq') {
    const document = parseJson<RequestForQuotation>(row);
    return {
      ...commonDocument(document, row.version),
      requisitionId: document.requisitionId ?? null,
      title: document.title ?? null,
      buyerId: document.buyerId,
      currency: document.currency,
      quoteDueAt: document.quoteDueAt,
      supplierCount: Array.isArray(document.supplierIds) ? document.supplierIds.length : 0,
    };
  }
  if (kind === 'quote') {
    const document = parseJson<SupplierQuote>(row);
    return {
      ...commonDocument(document, row.version),
      rfqId: document.rfqId,
      supplierId: document.supplierId,
      currency: document.currency,
      validUntil: document.validUntil ?? null,
      receivedAt: document.receivedAt ?? null,
    };
  }
  if (kind === 'award') {
    const document = parseJson<Award>(row);
    return {
      ...commonDocument(document, row.version),
      rfqId: document.rfqId,
      approvedBy: document.approvedBy ?? null,
      approvedAt: document.approvedAt ?? null,
    };
  }
  if (kind === 'quote_comparison') {
    const document = parseJson<QuoteComparisonSnapshot>(row);
    return {
      ...commonDocument(document, row.version),
      rfqId: document.rfqId,
      rfqVersion: document.rfqVersion,
      asOf: document.asOf,
      comparisonCurrency: document.comparisonCurrency,
    };
  }
  if (kind === 'purchase_order') {
    const document = parseJson<PurchaseOrder>(row);
    // Imported ERPs often provide financial totals as extension fields.  These
    // are safe, first-class read-model facts for the AP workbench; withholding
    // them forces the UI to invent a comparison state from incomplete data.
    const imported = document as unknown as Record<string, unknown>;
    // `externalId` is the immutable connector identity (for example
    // `purchase.order:22`).  Odoo's human PO number is persisted separately
    // by the connector and must be exposed as a display field rather than
    // replacing that stable mapping key.
    const number = documentNumber(document);
    return {
      ...commonDocument(document, row.version),
      number,
      displayNumber: number ?? document.externalId,
      awardId: document.awardId ?? null,
      supplierId: document.supplierId,
      currency: document.currency,
      orderedAt: document.orderedAt,
      amountTotal: imported['amountTotal'] ?? null,
      amountUntaxed: imported['amountUntaxed'] ?? null,
    };
  }
  if (kind === 'confirmation') {
    const document = parseJson<PurchaseOrderConfirmation>(row);
    return {
      ...commonDocument(document, row.version),
      poId: document.poId,
      supplierId: document.supplierId,
      confirmedAt: document.confirmedAt,
      supplierReference: document.supplierReference ?? null,
    };
  }
  if (kind === 'production_progress') {
    const document = parseJson<ProductionProgress>(row);
    return {
      ...commonDocument(document, row.version),
      poId: document.poId,
      supplierId: document.supplierId,
      reportedAt: document.reportedAt,
      overallStatus: document.overallStatus,
      evidenceSource: document.evidenceSource,
      evidenceReference: document.evidenceReference,
      verifiedBy: document.verifiedBy,
      verificationReason: document.verificationReason,
    };
  }
  if (kind === 'shipment') {
    const document = parseJson<Shipment>(row);
    return {
      ...commonDocument(document, row.version),
      poId: document.poId,
      supplierId: document.supplierId,
      shippedAt: document.shippedAt,
      estimatedArrivalAt: document.estimatedArrivalAt ?? null,
      carrier: document.carrier ?? null,
      trackingNumber: document.trackingNumber ?? null,
    };
  }
  if (kind === 'transport_event') {
    const document = parseJson<TransportEvent>(row);
    return {
      ...commonDocument(document, row.version),
      poId: document.poId,
      shipmentId: document.shipmentId,
      eventCode: document.eventCode,
      occurredAt: document.occurredAt,
      location: document.location ?? null,
      estimatedArrivalAt: document.estimatedArrivalAt ?? null,
      carrierReference: document.carrierReference ?? null,
      evidenceSource: document.evidenceSource,
      evidenceReference: document.evidenceReference,
      verifiedBy: document.verifiedBy,
      verificationReason: document.verificationReason,
    };
  }
  if (kind === 'receipt') {
    const document = parseJson<Receipt>(row);
    return {
      ...commonDocument(document, row.version),
      poId: document.poId,
      shipmentId: document.shipmentId ?? null,
      warehouseId: document.warehouseId,
      receivedAt: document.receivedAt,
    };
  }
  if (kind === 'match') {
    const document = parseJson<ThreeWayMatch>(row);
    return {
      ...commonDocument(document, row.version),
      poId: document.poId,
      invoiceId: document.invoiceId,
      result: document.result,
    };
  }
  if (kind === 'communication') {
    const document = parseJson<Communication>(row);
    return {
      ...commonDocument(document, row.version),
      businessObjectId: document.businessObjectId,
      businessObjectType: document.businessObjectType,
      supplierId: document.supplierId ?? null,
      channel: document.channel,
      direction: document.direction,
      messageId: document.messageId ?? null,
      from: document.from ?? null,
      subject: document.subject ?? null,
      attachmentCount: Array.isArray(document.attachmentIds) ? document.attachmentIds.length : 0,
      occurredAt: document.occurredAt,
      receivedAt: document.receivedAt ?? document.occurredAt,
    };
  }
  const document = parseJson<SupplierInvoice>(row);
  const imported = document as unknown as Record<string, unknown>;
  return {
    ...commonDocument(document, row.version),
    supplierId: document.supplierId,
    invoiceNumber: document.invoiceNumber,
    currency: document.currency,
    invoiceDate: document.invoiceDate,
    poId: imported['poId'] ?? null,
    poReference: imported['poReference'] ?? null,
    amountTotal: imported['amountTotal'] ?? null,
    amountUntaxed: imported['amountUntaxed'] ?? null,
    paymentState: imported['paymentState'] ?? null,
  };
}

function documentSection(db: DatabaseSync, tenantId: string, kind: ProcurementWorkbenchKind, limit: number): Record<string, unknown> {
  const byStatus = countsByStatus(db, 'procurement_documents', tenantId, 'AND kind=?', [kind]);
  const rows = db.prepare(`
    SELECT version,json FROM procurement_documents
    WHERE tenant_id=? AND kind=?
    ORDER BY updated_at DESC,id LIMIT ?
  `).all(tenantId, kind, limit) as unknown as VersionedJsonRow[];
  return { total: total(byStatus), byStatus, items: rows.map((row) => documentSummary(kind, row)) };
}

/** Resolve names only for the POs being returned.  This intentionally does
 * not reuse the (limited) supplier list that is rendered beside the POs: a
 * valid PO must not lose its supplier name merely because that supplier fell
 * outside the supplier-list page. */
function enrichPurchaseOrdersWithSupplierNames(
  db: DatabaseSync,
  tenantId: string,
  purchaseOrders: Record<string, unknown>,
): Record<string, unknown> {
  const items = purchaseOrders['items'] as Array<Record<string, unknown>> | undefined ?? [];
  const supplierIds = [...new Set(items
    .map((purchaseOrder) => purchaseOrder['supplierId'])
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0))];
  if (supplierIds.length === 0) return { ...purchaseOrders, items };
  const suppliers = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='supplier' AND id IN (${supplierIds.map(() => '?').join(',')})`)
    .all(tenantId, ...supplierIds) as unknown as JsonRow[];
  const supplierNameById = new Map(suppliers.map((row) => {
    const supplier = parseJson<Supplier>(row);
    return [supplier.id, supplier.name] as const;
  }));
  return {
    ...purchaseOrders,
    items: items.map((purchaseOrder) => {
      const supplierId = purchaseOrder['supplierId'];
      return {
        ...purchaseOrder,
        supplierName: typeof supplierId === 'string' ? supplierNameById.get(supplierId) ?? null : null,
      };
    }),
  };
}

function contactView(db: DatabaseSync, tenantId: string, limit: number): Record<string, unknown> {
  const rows = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='supplier' ORDER BY updated_at DESC,id`).all(tenantId) as unknown as JsonRow[];
  const items = rows.flatMap((row) => {
    const supplier = parseJson<Supplier>(row);
    return (supplier.contacts ?? []).map((contact) => ({
      id: contact.id,
      name: contact.name,
      supplierId: supplier.id,
      supplierName: supplier.name,
      role: contact.role ?? null,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
      primary: Boolean(contact.primary),
      status: supplier.status,
      updatedAt: supplier.updatedAt,
    }));
  });
  return { total: items.length, items: items.slice(0, limit) };
}

function itemView(db: DatabaseSync, tenantId: string, limit: number): Record<string, unknown> {
  const explicitRows = db.prepare(`SELECT version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='item' ORDER BY updated_at DESC,id`).all(tenantId) as unknown as VersionedJsonRow[];
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of explicitRows) {
    const item = documentSummary('item', row);
    byId.set(String(item['id']), item);
  }
  const lineRows = db.prepare(`SELECT document_id,json FROM procurement_lines
    WHERE tenant_id=? ORDER BY CASE kind WHEN 'requisition_line' THEN 0 WHEN 'rfq_line' THEN 1
      WHEN 'purchase_order_line' THEN 2 ELSE 3 END,document_id,line_number,id`).all(tenantId) as unknown as Array<{ document_id: string; json: string }>;
  for (const row of lineRows) {
    const line = parseJson<Record<string, unknown>>(row);
    const itemId = typeof line['itemId'] === 'string' ? line['itemId'].trim() : '';
    if (!itemId || byId.has(itemId)) continue;
    const itemName = typeof line['itemName'] === 'string' && line['itemName'].trim()
      ? line['itemName'].trim()
      : typeof line['description'] === 'string' && line['description'].trim() ? line['description'].trim() : itemId;
    const sku = typeof line['itemCode'] === 'string' && line['itemCode'].trim() ? line['itemCode'].trim() : itemId;
    byId.set(itemId, {
      id: itemId,
      sku,
      name: itemName,
      uom: typeof line['uom'] === 'string' ? line['uom'] : null,
      status: 'observed',
      sourceDocumentId: row.document_id,
      summary: `来自采购单据 ${row.document_id}`,
    });
  }
  const items = [...byId.values()];
  return { total: items.length, items: items.slice(0, limit) };
}

function inboxView(db: DatabaseSync, tenantId: string, limit: number): Record<string, unknown> {
  const count = db.prepare(`SELECT COUNT(*) AS count FROM procurement_documents
    WHERE tenant_id=? AND kind='communication' AND json_extract(json,'$.direction')='inbound'`).get(tenantId) as { count: number };
  const rows = db.prepare(`SELECT version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='communication' AND json_extract(json,'$.direction')='inbound'
    ORDER BY updated_at DESC,id LIMIT ?`).all(tenantId, limit) as unknown as VersionedJsonRow[];
  return { total: Number(count.count), items: rows.map((row) => documentSummary('communication', row)) };
}

function alertView(db: DatabaseSync, tenantId: string, limit: number): Record<string, unknown> {
  const exceptions = (exceptionSection(db, tenantId, limit)['items'] as Array<Record<string, unknown>> | undefined ?? [])
    .map((item) => ({ ...item, title: item['type'] ?? '业务异常', message: item['aiJudgment'] ?? item['recommendedAction'], source: 'exception' }));
  const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();
  const staleRuns = db.prepare(`SELECT id,workflow_id,status,updated_at FROM control_workflow_runs
    WHERE tenant_id=? AND status IN ('queued','running') AND updated_at<=?
    ORDER BY updated_at DESC LIMIT ?`).all(tenantId, staleBefore, limit) as unknown as Array<{ id: string; workflow_id: string; status: string; updated_at: string }>;
  const runAlerts = staleRuns.map((row) => ({
    id: `alert:stale:${row.id}`,
    type: 'stale_workflow_run',
    severity: 'critical',
    status: 'open',
    objectId: row.id,
    title: '工作流运行超过 15 分钟未更新',
    message: row.workflow_id,
    createdAt: row.updated_at,
    source: 'runtime',
  }));
  const securityRows = db.prepare(`SELECT seq,event_type,severity,message,created_at FROM control_security_events
    WHERE tenant_id=? AND severity IN ('warning','critical')
    ORDER BY created_at DESC,seq DESC LIMIT ?`).all(tenantId, limit) as unknown as Array<{ seq: number; event_type: string; severity: string; message: string; created_at: string }>;
  const securityAlerts = securityRows.map((row) => ({
    id: `alert:security:${row.seq}`,
    type: row.event_type,
    severity: row.severity,
    status: 'open',
    title: '安全监控告警',
    message: row.message,
    createdAt: row.created_at,
    source: 'security',
  }));
  const items: Array<Record<string, unknown>> = [...exceptions, ...runAlerts, ...securityAlerts];
  items.sort((left, right) => String(right['createdAt'] ?? '').localeCompare(String(left['createdAt'] ?? '')));
  return { total: items.length, items: items.slice(0, limit) };
}

function newsView(db: DatabaseSync, tenantId: string): Record<string, unknown> {
  const connected = db.prepare(`SELECT COUNT(*) AS count FROM control_connector_installations
    WHERE tenant_id=? AND status='installed' AND lower(connector_id) IN ('news','rss','supply-chain-news')`).get(tenantId) as { count: number };
  if (Number(connected.count) === 0) {
    return { total: 0, items: [], status: 'unconfigured', message: '尚未配置可信供应链资讯源' };
  }
  return { total: 0, items: [], status: 'connected', message: '资讯连接器已安装，当前没有已持久化内容' };
}

function taskSection(db: DatabaseSync, tenantId: string, limit: number): Record<string, unknown> {
  const byStatus = countsByStatus(db, 'runtime_tasks', tenantId);
  const pending = Object.entries(byStatus)
    .filter(([status]) => !['completed', 'failed', 'cancelled'].includes(status))
    .reduce((sum, [, count]) => sum + count, 0);
  const rows = db.prepare(`
    SELECT json FROM runtime_tasks
    WHERE tenant_id=? AND status NOT IN ('completed','failed','cancelled')
    ORDER BY updated_at DESC,id LIMIT ?
  `).all(tenantId, limit) as unknown as JsonRow[];
  const items = rows.map((row) => {
    const task = parseJson<Task>(row);
    return {
      id: task.id,
      status: task.status,
      employeeId: task.employeeId,
      workflowId: task.workflowId,
      businessObjectId: task.businessObjectId,
      attempts: task.attempts,
      waitingReason: task.checkpoint?.waitingReason ?? null,
      error: task.error ?? null,
      createdAt: task.createdAt,
      startedAt: task.startedAt ?? null,
    };
  });
  return { total: total(byStatus), pending, byStatus, items };
}

function approvalSection(db: DatabaseSync, tenantId: string, limit: number): Record<string, unknown> {
  const byStatus = countsByStatus(db, 'runtime_approvals', tenantId);
  const rows = db.prepare(`
    SELECT json FROM runtime_approvals
    WHERE tenant_id=? AND status='pending'
    ORDER BY updated_at DESC,id LIMIT ?
  `).all(tenantId, limit) as unknown as JsonRow[];
  const items = rows.map((row) => {
    const approval = parseJson<ApprovalRequest>(row);
    return {
      id: approval.id,
      taskId: approval.taskId,
      ruleId: approval.ruleId,
      title: approval.title,
      message: approval.message,
      payload: approval.payload ?? {},
      requestedAt: approval.requestedAt,
    };
  });
  return { total: total(byStatus), pending: byStatus['pending'] ?? 0, byStatus, items };
}

function executionApprovalSection(db: DatabaseSync, tenantId: string, limit: number): Record<string, unknown> {
  const byStatus = countsByStatus(db, 'procurement_execution_approvals', tenantId);
  const rows = db.prepare(`SELECT json FROM procurement_execution_approvals
    WHERE tenant_id=? AND status='pending' ORDER BY updated_at DESC,id LIMIT ?`)
    .all(tenantId, limit) as unknown as JsonRow[];
  const items = rows.map((row) => {
    const approval = parseJson<Record<string, unknown>>(row);
    return {
      id: approval['id'], kind: approval['kind'], objectId: approval['objectId'], poId: approval['poId'] ?? null,
      status: approval['status'], reason: approval['reason'] ?? null, requestedBy: approval['requestedBy'] ?? null,
      requestedAt: approval['requestedAt'] ?? null,
    };
  });
  return { total: total(byStatus), pending: byStatus['pending'] ?? 0, byStatus, items };
}

function exceptionSection(db: DatabaseSync, tenantId: string, limit: number): Record<string, unknown> {
  const byStatus = countsByStatus(db, 'runtime_exceptions', tenantId, `AND ${NON_VISUAL_TEST_EXCEPTION}`);
  const rows = db.prepare(`
    SELECT json FROM runtime_exceptions
    WHERE tenant_id=? AND status IN ('open','assigned') AND ${NON_VISUAL_TEST_EXCEPTION}
    ORDER BY updated_at DESC,id LIMIT ?
  `).all(tenantId, limit) as unknown as JsonRow[];
  const items = rows.map((row) => {
    const exception = parseJson<BusinessException>(row);
    return {
      id: exception.id,
      type: exception.type,
      severity: exception.severity,
      objectId: exception.objectId,
      objectType: exception.objectType ?? null,
      owner: exception.owner ?? null,
      aiJudgment: exception.aiJudgment,
      recommendedAction: exception.recommendedAction,
      needsApproval: exception.needsApproval,
      approvalId: exception.approvalId ?? null,
      status: exception.status,
      createdAt: exception.createdAt,
    };
  });
  const open = (byStatus['open'] ?? 0) + (byStatus['assigned'] ?? 0);
  return { total: total(byStatus), open, byStatus, items };
}

function activitySection(db: DatabaseSync, tenantId: string, limit: number): Record<string, unknown> {
  const count = db.prepare(`SELECT COUNT(*) AS count FROM runtime_activities WHERE tenant_id=? AND ${NON_VISUAL_TEST_ACTIVITY}`).get(tenantId) as { count: number };
  const rows = db.prepare(`
    SELECT json FROM runtime_activities
    WHERE tenant_id=? AND ${NON_VISUAL_TEST_ACTIVITY} ORDER BY rowid DESC LIMIT ?
  `).all(tenantId, limit) as unknown as JsonRow[];
  const items = rows.map((row) => {
    const activity = parseJson<Activity>(row);
    return {
      id: activity.id,
      at: activity.at,
      objectId: activity.objectId ?? null,
      actor: activity.actor,
      action: activity.action,
      summary: activity.summary,
      context: activity.context ?? {},
    };
  });
  return { total: Number(count.count), items };
}

/**
 * PO 供应商运营员首屏指标。这些值只由已持久化的任务、审批、
 * 异常、PO 和 Outbox 事实派生，前端不再拼凑演示数字。
 */
function procurementOperationsMetrics(db: DatabaseSync, tenantId: string, now: Date): Record<string, unknown> {
  const taskStatus = countsByStatus(db, 'runtime_tasks', tenantId);
  const poStatus = countsByStatus(db, 'procurement_documents', tenantId, "AND kind='purchase_order'");
  const approvalStatus = countsByStatus(db, 'runtime_approvals', tenantId);
  const exceptionStatus = countsByStatus(db, 'runtime_exceptions', tenantId, `AND ${NON_VISUAL_TEST_EXCEPTION}`);
  const outboxStatus = countsByStatus(db, 'procurement_outbox', tenantId);
  const completedCutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const completedTasks = db.prepare(`SELECT COUNT(*) AS count FROM runtime_tasks
    WHERE tenant_id=? AND status='completed' AND json_extract(json,'$.completedAt')>=?`)
    .get(tenantId, completedCutoff) as { count: number };
  const completedPurchaseOrders = db.prepare(`SELECT COUNT(*) AS count FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' AND status IN ('received','closed') AND updated_at>=?`)
    .get(tenantId, completedCutoff) as { count: number };
  const waitingExternalObjects = db.prepare(`SELECT json_extract(json,'$.businessObjectId') AS object_id FROM runtime_tasks
      WHERE tenant_id=? AND status='waiting_external'
    UNION
    SELECT id AS object_id FROM procurement_documents
      WHERE tenant_id=? AND kind='purchase_order'
        AND status IN ('sent','awaiting_confirmation','confirmed','in_production','awaiting_shipment','partially_shipped','shipped','partially_received')`)
    .all(tenantId, tenantId) as Array<{ object_id: string | null }>;
  const pendingActionObjects = db.prepare(`SELECT json_extract(t.json,'$.businessObjectId') AS object_id
      FROM runtime_approvals a JOIN runtime_tasks t ON t.tenant_id=a.tenant_id AND t.id=a.task_id
      WHERE a.tenant_id=? AND a.status='pending'
    UNION
    SELECT object_id FROM runtime_exceptions WHERE tenant_id=? AND status IN ('open','assigned') AND ${NON_VISUAL_TEST_EXCEPTION}
    UNION
    SELECT json_extract(json,'$.businessObjectId') AS object_id FROM runtime_tasks
      WHERE tenant_id=? AND status IN ('waiting_approval','waiting_human')`)
    .all(tenantId, tenantId, tenantId) as Array<{ object_id: string | null }>;
  const executionApprovalObjects = db.prepare(`SELECT COALESCE(json_extract(json,'$.poId'),object_id) AS object_id
    FROM procurement_execution_approvals WHERE tenant_id=? AND status='pending'`)
    .all(tenantId) as Array<{ object_id: string | null }>;
  const waitingActionObjectIds = new Set([...pendingActionObjects, ...executionApprovalObjects]
    .map((row) => row.object_id).filter((id): id is string => Boolean(id)));
  const totalTasks = total(taskStatus);
  const totalPurchaseOrders = total(poStatus);
  return {
    tracked: totalTasks + totalPurchaseOrders,
    running: (taskStatus['created'] ?? 0) + (taskStatus['queued'] ?? 0) + (taskStatus['running'] ?? 0) + (outboxStatus['processing'] ?? 0),
    waitingExternal: waitingExternalObjects.filter((row) => Boolean(row.object_id)).length,
    waitingAction: waitingActionObjectIds.size,
    exceptions: (exceptionStatus['open'] ?? 0) + (exceptionStatus['assigned'] ?? 0) + (taskStatus['failed'] ?? 0) + (outboxStatus['failed'] ?? 0),
    completedLast7Days: Number(completedTasks.count) + Number(completedPurchaseOrders.count),
    byStatus: { tasks: taskStatus, purchaseOrders: poStatus, approvals: approvalStatus, exceptions: exceptionStatus, outbox: outboxStatus },
  };
}

type ProcurementRoute = 'local' | 'import' | 'unclassified';
type ProcurementStage = 'po_sent' | 'supplier_commitment' | 'fulfilment_production' | 'dispatch_transit' | 'delivery_grn';
type PortfolioRisk = 'high' | 'medium' | 'low';
type RouteRiskBucket = 'high_risk' | 'awaiting_supplier' | 'delivery_risk' | 'on_track';
interface RouteAssignmentRow {
  po_id: string; route: 'local' | 'import'; source: string; evidence_json: string; version: number;
  updated_by: string; updated_at: string;
}

const portfolioStageLabels: Record<ProcurementStage, string> = {
  // This is a workflow stage name, not a completion claim. A draft PO is
  // active in this stage until the outbound connector confirms delivery.
  po_sent: 'PO 发出',
  supplier_commitment: '供应商承诺',
  fulfilment_production: '履约 / 生产',
  dispatch_transit: '发运 / 在途',
  delivery_grn: '交付 / 收货',
};

function normalizedRoute(po: Record<string, unknown>, assignment?: RouteAssignmentRow): {
  route: ProcurementRoute; source: 'manual' | 'supplier_email_ai' | 'erp_field' | 'unclassified'; version: number; evidence: Record<string, unknown>;
} {
  if (assignment) return {
    route: assignment.route,
    source: assignment.source === 'supplier_email_ai' ? 'supplier_email_ai' : 'manual',
    version: assignment.version,
    evidence: { ...parseJson<Record<string, unknown>>({ json: assignment.evidence_json }), updatedBy: assignment.updated_by, updatedAt: assignment.updated_at },
  };
  for (const field of ['procurementRoute', 'route'] as const) {
    const explicit = String(po[field] ?? '').trim().toLowerCase();
    if (['local', 'domestic', '本地', '国内'].includes(explicit)) return { route: 'local', source: 'erp_field', version: 0, evidence: { field, value: po[field] } };
    if (['import', 'international', '进口', '海外'].includes(explicit)) return { route: 'import', source: 'erp_field', version: 0, evidence: { field, value: po[field] } };
  }
  return { route: 'unclassified', source: 'unclassified', version: 0, evidence: { reason: 'PO 未提供路线字段，且尚无人工确认记录' } };
}

function isoTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function latestIso(values: readonly unknown[]): string | null {
  const candidates = values.filter((value): value is string => typeof value === 'string' && isoTime(value) !== undefined);
  return candidates.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function requiredInHouseAt(po: Record<string, unknown>, lines: readonly PurchaseOrderLine[]): string | null {
  const explicit = latestIso([po['requiredInHouseAt'], po['promisedAt']]);
  if (explicit) return explicit;
  return latestIso(lines.map((line) => line.requestedAt));
}

function purchaseOrderAmount(po: Record<string, unknown>, lines: readonly PurchaseOrderLine[]): number | null {
  if (typeof po['amountTotal'] === 'number' && Number.isFinite(po['amountTotal']) && po['amountTotal'] >= 0) return po['amountTotal'];
  if (!lines.length || lines.some((line) => !Number.isFinite(line.orderedQty) || !Number.isFinite(line.unitPrice))) return null;
  return lines.reduce((sum, line) => sum + line.orderedQty * line.unitPrice, 0);
}

function riskEvidence(
  score: number | null,
  evidenceState: RiskComponentInput['evidenceState'],
  evidenceReferences: RiskComponentInput['evidenceReferences'],
  observedAt: string | null,
): RiskComponentInput {
  return { score, evidenceState, evidenceReferences, observedAt };
}

function criticalityRank(value: 'high' | 'medium' | 'low'): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

export function procurementPortfolio(
  db: DatabaseSync,
  tenantId: string,
  evaluatedAt: Date | number = Date.now(),
  connectorReady?: (connectorId: string) => boolean,
): Record<string, unknown> {
  const storedPreferences = getProcurementTenantPreferences(db, tenantId);
  const tenantPreferences = effectiveProcurementTenantPreferences(db, tenantId);
  const leadTimeConfiguration = {
    autoCalculateLeadTime: tenantPreferences.autoCalculateLeadTime,
    preferenceVersion: storedPreferences?.version ?? null,
    inheritedDefault: !storedPreferences,
  };
  const leadTimeResolver = tenantPreferences.autoCalculateLeadTime
    ? loadProcurementLeadTimeResolver(db, tenantId)
    : null;
  const poRows = db.prepare(`SELECT version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' ORDER BY updated_at DESC,id LIMIT 1000`)
    .all(tenantId) as unknown as VersionedJsonRow[];
  const supplierRows = db.prepare(`SELECT version,json FROM procurement_documents WHERE tenant_id=? AND kind='supplier'`)
    .all(tenantId) as unknown as VersionedJsonRow[];
  const suppliers = new Map(supplierRows.map((row) => {
    const supplier = parseJson<Supplier & Record<string, unknown>>(row);
    return [supplier.id, supplier] as const;
  }));
  const supplierVersions = new Map(supplierRows.map((row) => {
    const supplier = parseJson<Supplier & Record<string, unknown>>(row);
    return [supplier.id, row.version] as const;
  }));
  const supplierRiskProfiles = new Map<string, { version: number; productCriticality: string; status: string; updatedAt: string }>();
  if (sqliteTableExists(db, 'procurement_supplier_operating_profiles')) {
    const profileRows = db.prepare(`SELECT supplier_id,version,product_criticality,status,updated_at
      FROM procurement_supplier_operating_profiles WHERE tenant_id=?`).all(tenantId) as Array<{
        supplier_id: string; version: number; product_criticality: string; status: string; updated_at: string;
      }>;
    for (const row of profileRows) supplierRiskProfiles.set(row.supplier_id, {
      version: row.version, productCriticality: row.product_criticality, status: row.status, updatedAt: row.updated_at,
    });
  }
  const routeAssignmentRows = db.prepare(`SELECT po_id,route,source,evidence_json,version,updated_by,updated_at
    FROM procurement_route_assignments WHERE tenant_id=?`).all(tenantId) as unknown as RouteAssignmentRow[];
  const routeAssignments = new Map(routeAssignmentRows.map((row) => [row.po_id, row] as const));
  const importEvaluationRows = db.prepare(`SELECT po_id,status,summary_json,updated_at FROM procurement_import_document_evaluations WHERE tenant_id=?`)
    .all(tenantId) as Array<{ po_id: string; status: string; summary_json: string; updated_at: string }>;
  const importEvaluations = new Map(importEvaluationRows.map((row) => [row.po_id, row] as const));
  const lineRows = db.prepare(`SELECT document_id,json FROM procurement_lines
    WHERE tenant_id=? AND kind='purchase_order_line' ORDER BY document_id,line_number`)
    .all(tenantId) as unknown as Array<{ document_id: string; json: string }>;
  const linesByPo = new Map<string, PurchaseOrderLine[]>();
  for (const row of lineRows) {
    const line = parseJson<PurchaseOrderLine>({ json: row.json });
    const list = linesByPo.get(row.document_id) ?? [];
    list.push(line);
    linesByPo.set(row.document_id, list);
  }
  const shipmentRows = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='shipment' ORDER BY updated_at,id`).all(tenantId) as unknown as JsonRow[];
  const shipmentsByPo = new Map<string, Shipment[]>();
  for (const row of shipmentRows) {
    const shipment = parseJson<Shipment>(row);
    const list = shipmentsByPo.get(shipment.poId) ?? [];
    list.push(shipment);
    shipmentsByPo.set(shipment.poId, list);
  }
  const productionProgressRows = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='production_progress' ORDER BY updated_at,id`).all(tenantId) as unknown as JsonRow[];
  const productionProgressByPo = new Map<string, ProductionProgress[]>();
  for (const row of productionProgressRows) {
    const progress = parseJson<ProductionProgress>(row);
    const list = productionProgressByPo.get(progress.poId) ?? [];
    list.push(progress);
    productionProgressByPo.set(progress.poId, list);
  }
  const transportEventRows = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='transport_event' ORDER BY updated_at,id`).all(tenantId) as unknown as JsonRow[];
  const transportEventsByPo = new Map<string, TransportEvent[]>();
  for (const row of transportEventRows) {
    const event = parseJson<TransportEvent>(row);
    const list = transportEventsByPo.get(event.poId) ?? [];
    list.push(event);
    transportEventsByPo.set(event.poId, list);
  }
  const receiptRows = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='receipt' ORDER BY updated_at,id`).all(tenantId) as unknown as JsonRow[];
  const receiptsByPo = new Map<string, Receipt[]>();
  for (const row of receiptRows) {
    const receipt = parseJson<Receipt>(row);
    const list = receiptsByPo.get(receipt.poId) ?? [];
    list.push(receipt);
    receiptsByPo.set(receipt.poId, list);
  }
  const exceptionRows = db.prepare(`SELECT object_id,json FROM runtime_exceptions
    WHERE tenant_id=? AND status IN ('open','assigned') AND ${NON_VISUAL_TEST_EXCEPTION}`).all(tenantId) as unknown as Array<{ object_id: string; json: string }>;
  const exceptionsByPo = new Map<string, Array<Record<string, unknown>>>();
  for (const row of exceptionRows) {
    const list = exceptionsByPo.get(row.object_id) ?? [];
    list.push(parseJson<Record<string, unknown>>({ json: row.json }));
    exceptionsByPo.set(row.object_id, list);
  }
  const executionApprovalRows = db.prepare(`SELECT COALESCE(json_extract(json,'$.poId'),object_id) AS po_id,json
    FROM procurement_execution_approvals WHERE tenant_id=? AND status='pending'`).all(tenantId) as unknown as Array<{ po_id: string; json: string }>;
  const approvalPoIds = new Set(executionApprovalRows.map((row) => row.po_id).filter(Boolean));
  const outboxRows = db.prepare(`SELECT aggregate_id,status,updated_at FROM procurement_outbox
    WHERE tenant_id=? AND aggregate_id IS NOT NULL`).all(tenantId) as unknown as Array<{ aggregate_id: string; status: string; updated_at: string }>;
  const outboxByPo = new Map<string, Array<{ status: string; updatedAt: string }>>();
  for (const row of outboxRows) {
    const list = outboxByPo.get(row.aggregate_id) ?? [];
    list.push({ status: row.status, updatedAt: row.updated_at });
    outboxByPo.set(row.aggregate_id, list);
  }
  const communicationRows = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='communication'`).all(tenantId) as unknown as JsonRow[];
  const communicationByPo = new Map<string, Communication[]>();
  for (const row of communicationRows) {
    const communication = parseJson<Communication>(row);
    if (communication.businessObjectType !== 'purchase_order') continue;
    const list = communicationByPo.get(communication.businessObjectId) ?? [];
    list.push(communication);
    communicationByPo.set(communication.businessObjectId, list);
  }
  const stageEventRows = db.prepare(`SELECT id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json
    FROM procurement_po_stage_events WHERE tenant_id=? ORDER BY occurred_at,rowid`)
    .all(tenantId) as unknown as Array<PoStageEventRow & { po_id: string }>;
  const stageEventsByPo = new Map<string, PoStageEventRow[]>();
  for (const row of stageEventRows) {
    const list = stageEventsByPo.get(row.po_id) ?? [];
    list.push(row);
    stageEventsByPo.set(row.po_id, list);
  }
  const now = evaluatedAt instanceof Date ? evaluatedAt.getTime() : evaluatedAt;
  const dayMs = 86_400_000;
  const activeStatuses = new Set(['sent', 'awaiting_confirmation', 'confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped', 'shipped', 'partially_received']);
  const amountByPo = new Map<string, number | null>();
  const maxAmountByCurrency = new Map<string, number>();
  for (const row of poRows) {
    const document = parseJson<PurchaseOrder & Record<string, unknown>>(row);
    const amount = purchaseOrderAmount(document, linesByPo.get(document.id) ?? []);
    amountByPo.set(document.id, amount);
    if (amount !== null) maxAmountByCurrency.set(document.currency, Math.max(maxAmountByCurrency.get(document.currency) ?? 0, amount));
  }
  const portfolioItems = poRows.map((row) => {
    const document = parseJson<PurchaseOrder & Record<string, unknown>>(row);
    const supplier = suppliers.get(document.supplierId);
    const lines = linesByPo.get(document.id) ?? [];
    const productionProgress = productionProgressByPo.get(document.id) ?? [];
    const shipments = shipmentsByPo.get(document.id) ?? [];
    const transportEvents = transportEventsByPo.get(document.id) ?? [];
    const receipts = receiptsByPo.get(document.id) ?? [];
    const latestShipment = [...shipments].sort((left, right) =>
      Date.parse(right.shippedAt ?? right.updatedAt) - Date.parse(left.shippedAt ?? left.updatedAt))[0];
    const latestReceipt = [...receipts].sort((left, right) =>
      Date.parse(right.receivedAt ?? right.updatedAt) - Date.parse(left.receivedAt ?? left.updatedAt))[0];
    const latestProductionProgress = [...productionProgress].sort((left, right) =>
      Date.parse(right.reportedAt ?? right.updatedAt) - Date.parse(left.reportedAt ?? left.updatedAt))[0];
    const latestTransportEvent = [...transportEvents].sort((left, right) =>
      Date.parse(right.occurredAt) - Date.parse(left.occurredAt))[0];
    const latestEta = [...transportEvents].sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
      .find((event) => event.estimatedArrivalAt)?.estimatedArrivalAt ?? latestShipment?.estimatedArrivalAt ?? null;
    const latestCustomsEvent = [...transportEvents].sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
      .find((event) => event.eventCode.startsWith('customs_'));
    const stage = resolveExecutionStage(document.status, stageEventsByPo.get(document.id) ?? []).stage;
    const routeFact = normalizedRoute(document, routeAssignments.get(document.id));
    const route = routeFact.route;
    const importEvaluation = importEvaluations.get(document.id);
    const rihd = requiredInHouseAt(document, lines);
    const rihdTime = isoTime(rihd);
    const isComplete = ['received', 'closed', 'cancelled'].includes(document.status);
    const overdueDays = !isComplete && rihdTime !== undefined && rihdTime < now ? Math.max(1, Math.ceil((now - rihdTime) / dayMs)) : 0;
    const exceptions = exceptionsByPo.get(document.id) ?? [];
    const outbox = outboxByPo.get(document.id) ?? [];
    const communications = communicationByPo.get(document.id) ?? [];
    const factors: Array<{ code: string; label: string; score: number; evidence: string; evidenceDetail?: Record<string, unknown> }> = [];
    for (const exception of exceptions) {
      const severity = String(exception['severity'] ?? 'medium');
      const score = severity === 'critical' ? 100 : severity === 'high' ? 85 : severity === 'medium' ? 60 : 35;
      const manualRisk = exception['type'] === 'manual_purchase_order_risk';
      const exceptionContext = exception['context'] && typeof exception['context'] === 'object' && !Array.isArray(exception['context'])
        ? exception['context'] as Record<string, unknown> : {};
      factors.push({
        code: `exception:${String(exception['type'] ?? 'other')}`,
        label: manualRisk ? '人工风险标记' : '未解决业务异常',
        score,
        evidence: manualRisk ? String(exceptionContext['reason'] ?? exception['aiJudgment'] ?? '人工风险待处理') : String(exception['aiJudgment'] ?? exception['type'] ?? '异常待处理'),
        evidenceDetail: manualRisk ? {
          exceptionId: exception['id'],
          category: exceptionContext['category'] ?? null,
          markedBy: exceptionContext['markedBy'] ?? exception['owner'] ?? null,
          markedAt: exceptionContext['markedAt'] ?? exception['createdAt'] ?? null,
          recommendedAction: exception['recommendedAction'] ?? null,
        } : undefined,
      });
    }
    if (overdueDays > 0) factors.push({ code: 'rihd_overdue', label: '要求到货日已逾期', score: Math.min(100, 70 + overdueDays * 3), evidence: `已逾期 ${overdueDays} 天` });
    const orderedTime = isoTime(document.orderedAt);
    const leadTimeEvidence = leadTimeResolver ? lines.flatMap((line) => {
      const template = leadTimeResolver.resolve({
        supplierId: document.supplierId,
        route,
        line: line as PurchaseOrderLine & Record<string, unknown>,
      });
      if (!template) return [];
      const requiredAt = line.requestedAt ?? rihd;
      const requiredTime = isoTime(requiredAt);
      const availableDays = orderedTime !== undefined && requiredTime !== undefined
        ? Math.max(0, Math.ceil((requiredTime - orderedTime) / dayMs))
        : null;
      const shortfallDays = availableDays === null ? null : Math.max(0, template.standardLeadTimeDays - availableDays);
      return [{ ...template, orderedAt: document.orderedAt, requiredAt, availableDays, shortfallDays }];
    }) : [];
    const worstLeadTimeShortfall = leadTimeEvidence
      .filter((item) => typeof item.shortfallDays === 'number' && item.shortfallDays > 0)
      .sort((left, right) => (right.shortfallDays ?? 0) - (left.shortfallDays ?? 0))[0];
    if (!isComplete && worstLeadTimeShortfall) {
      const shortage = worstLeadTimeShortfall.shortfallDays!;
      factors.push({
        code: 'manufacturing_lead_time_shortfall',
        label: '标准制造周期不足',
        score: Math.min(95, 55 + shortage * 3),
        evidence: `${worstLeadTimeShortfall.matchValue || worstLeadTimeShortfall.itemId} 需 ${worstLeadTimeShortfall.standardLeadTimeDays} 天，可用 ${worstLeadTimeShortfall.availableDays} 天，缺口 ${shortage} 天`,
        evidenceDetail: worstLeadTimeShortfall,
      });
    }
    const quietSince = isoTime(document.updatedAt) ?? isoTime(document.orderedAt) ?? now;
    const quietHours = Math.max(0, Math.floor((now - quietSince) / 3_600_000));
    if (['sent', 'awaiting_confirmation'].includes(document.status) && quietHours >= 48 && !communications.some((item) => item.direction === 'inbound')) {
      factors.push({ code: 'supplier_no_response', label: '供应商未确认', score: Math.min(82, 55 + Math.floor((quietHours - 48) / 12) * 3), evidence: `${quietHours} 小时无有效回复` });
    }
    if (approvalPoIds.has(document.id)) factors.push({ code: 'approval_pending', label: '等待人工审批', score: 60, evidence: '存在未处理的执行审批' });
    if (latestProductionProgress?.overallStatus === 'delayed') factors.push({ code: 'production_delayed', label: '生产 / 备货延期', score: 82, evidence: latestProductionProgress.externalId });
    if (latestProductionProgress?.overallStatus === 'blocked') factors.push({ code: 'production_blocked', label: '生产 / 备货受阻', score: 90, evidence: latestProductionProgress.externalId });
    if (outbox.some((entry) => entry.status === 'failed')) factors.push({ code: 'connector_failed', label: '连接器执行失败', score: 88, evidence: '外部动作尚未确认成功' });
    if (latestTransportEvent?.eventCode === 'exception') factors.push({ code: 'transport_exception', label: '运输异常', score: 90, evidence: `${latestTransportEvent.location ?? '位置未提供'} · ${latestTransportEvent.externalId}` });
    if (latestCustomsEvent?.eventCode === 'customs_held') factors.push({ code: 'customs_held', label: '清关受阻', score: 92, evidence: `${latestCustomsEvent.location ?? '口岸未提供'} · ${latestCustomsEvent.externalId}` });
    if (!isComplete && latestEta && Date.parse(latestEta) < now) {
      const etaOverdueDays = Math.max(1, Math.ceil((now - Date.parse(latestEta)) / dayMs));
      factors.push({ code: 'shipment_eta_overdue', label: '运输 ETA 已逾期', score: Math.min(90, 72 + etaOverdueDays * 2), evidence: `ETA 已逾期 ${etaOverdueDays} 天` });
    }
    if (route === 'import' && importEvaluation && !['passed', 'on_track'].includes(importEvaluation.status)) {
      const summary = parseJson<Record<string, unknown>>({ json: importEvaluation.summary_json });
      const score = importEvaluation.status === 'security_blocked' ? 92 : importEvaluation.status === 'expired' ? 88 : importEvaluation.status === 'missing' ? 82 : 65;
      factors.push({ code: `import_documents:${importEvaluation.status}`, label: '进口单证门禁', score, evidence: `单证校验状态：${importEvaluation.status}；阶段：${String(summary['stage'] ?? stage)}` });
    }
    const amount = amountByPo.get(document.id) ?? null;
    const amountMaximum = maxAmountByCurrency.get(document.currency) ?? 0;
    const amountScore = amount === null ? null : amountMaximum > 0 ? Math.round(amount / amountMaximum * 100) : 0;
    const supplierFactorScore = Math.max(0, ...factors.filter((factor) => factor.code === 'supplier_no_response').map((factor) => factor.score));
    const supplierPerformanceRisk = typeof supplier?.performanceScore === 'number' && Number.isFinite(supplier.performanceScore)
      ? Math.max(0, Math.min(100, 100 - supplier.performanceScore)) : null;
    const supplierScore = supplierPerformanceRisk === null && supplierFactorScore === 0 ? null : Math.max(supplierPerformanceRisk ?? 0, supplierFactorScore);
    const supplierReference = supplier ? [{ type: 'supplier', id: supplier.id, version: supplierVersions.get(supplier.id) ?? null }] : [];
    const deliveryFactors = factors.filter((factor) => ['rihd_overdue', 'manufacturing_lead_time_shortfall', 'production_delayed', 'production_blocked', 'shipment_eta_overdue', 'transport_exception'].includes(factor.code));
    const deliveryHasEvidence = rihdTime !== undefined || deliveryFactors.length > 0;
    const deliveryScore = deliveryHasEvidence ? Math.max(0, ...deliveryFactors.map((factor) => factor.score)) : null;
    const profile = supplierRiskProfiles.get(document.supplierId);
    const leadTimeCriticality = [...leadTimeEvidence].sort((left, right) => criticalityRank(right.criticality) - criticalityRank(left.criticality))[0];
    const productCriticality = leadTimeCriticality?.criticality ?? profile?.productCriticality;
    const criticalityScore = productCriticality === 'high' ? 100
      : productCriticality === 'medium' ? 60
        : productCriticality === 'low' ? 20 : null;
    const criticalityState = leadTimeCriticality ? 'observed' : criticalityScore === null ? 'missing' : profile?.status === 'active' ? 'observed' : 'stale';
    const criticalityReferences = leadTimeCriticality
      ? [{ type: 'procurement_material_lead_time', id: leadTimeCriticality.templateId, version: leadTimeCriticality.templateVersion }]
      : criticalityScore === null || !profile ? [] : [{ type: 'supplier_operating_profile', id: document.supplierId, version: profile.version }];
    const criticalityObservedAt = leadTimeCriticality?.templateUpdatedAt ?? (criticalityScore === null ? null : profile?.updatedAt ?? null);
    const complianceFactors = factors.filter((factor) => factor.code === 'approval_pending' || factor.code === 'connector_failed'
      || factor.code.startsWith('import_documents:') || factor.code === 'customs_held' || factor.code.startsWith('exception:'));
    const riskModel = calculateRiskModelV2({
      S: riskEvidence(supplierScore, supplierScore === null ? 'missing' : supplierFactorScore > 0 ? 'derived' : 'observed', supplierReference, supplierScore === null ? null : supplier?.updatedAt ?? document.updatedAt),
      D: riskEvidence(deliveryScore, deliveryScore === null ? 'missing' : deliveryFactors.length ? 'observed' : 'derived', deliveryScore === null ? [] : [{ type: 'purchase_order', id: document.id, version: row.version }], deliveryScore === null ? null : latestIso([latestTransportEvent?.occurredAt, latestProductionProgress?.reportedAt, rihd, document.updatedAt])),
      V: riskEvidence(amountScore, amountScore === null ? 'missing' : 'derived', amountScore === null ? [] : [{ type: 'purchase_order', id: document.id, version: row.version }], amountScore === null ? null : document.updatedAt),
      C: riskEvidence(criticalityScore, criticalityState, criticalityReferences, criticalityObservedAt),
      A: riskEvidence(Math.max(0, ...complianceFactors.map((factor) => factor.score)), complianceFactors.length ? 'observed' : 'derived', [{ type: 'purchase_order', id: document.id, version: row.version }], latestIso([importEvaluation?.updated_at, ...outbox.map((entry) => entry.updatedAt), document.updatedAt])),
    });
    const riskScore = isComplete ? 0 : riskModel.totalScore ?? riskModel.provisionalScore ?? 0;
    const risk: PortfolioRisk = isComplete ? 'low' : riskModel.band === 'unpublished' ? riskModel.provisionalBand ?? 'low' : riskModel.band;
    const riskPublicationState = isComplete || riskModel.totalScore !== null ? 'published' : riskModel.provisionalScore !== null ? 'provisional' : 'not_published';
    const routeRiskBucket: RouteRiskBucket = risk === 'high' ? 'high_risk'
      : factors.some((factor) => factor.code === 'supplier_no_response') ? 'awaiting_supplier'
        : risk === 'medium' || overdueDays > 0 ? 'delivery_risk' : 'on_track';
    const materialType = String(document['materialType'] ?? leadTimeEvidence.find((item) => item.materialType)?.materialType ?? lines[0]?.description ?? lines[0]?.itemId ?? '未分类');
    const nextAction = document.status === 'draft' ? '发送采购订单'
      : stage === 'supplier_commitment' ? '获取供应商确认'
        : stage === 'fulfilment_production' ? '确认生产 / 备货进度'
          : stage === 'dispatch_transit' ? '跟踪发运与在途状态'
            : stage === 'delivery_grn' && !isComplete ? '核验收货与 ERP GRN'
              : isComplete ? '查看完整审计' : '检查当前执行状态';
    const amountTotal = amount ?? 0;
    return {
      id: document.id,
      version: row.version,
      number: documentNumber(document) ?? document.externalId,
      supplierId: document.supplierId,
      supplierName: supplier?.name ?? document.supplierId,
      route,
      routeSource: routeFact.source,
      routeAssignmentVersion: routeFact.version,
      routeEvidence: routeFact.evidence,
      routeEvidenceCandidates: routeEvidenceCandidates(db, tenantId, document.id),
      routeRiskBucket,
      materialType,
      status: document.status,
      stage,
      stageLabel: portfolioStageLabels[stage],
      requiredInHouseAt: rihd,
      overdueDays,
      risk,
      riskScore,
      riskModel,
      riskPublicationState,
      missingRiskComponents: Object.entries(riskModel.components)
        .filter(([, component]) => component.evidenceState === 'missing' || component.evidenceState === 'stale')
        .map(([name]) => name),
      riskFactors: factors.sort((left, right) => right.score - left.score),
      leadTimeEvidence,
      leadTimeConfiguration,
      nextAction,
      actionReadiness: {
        duplicate_po: duplicatePoActionReadiness(db, tenantId, document, lines),
        queue_followup: queueFollowupActionReadiness(db, tenantId, document),
        update_rihd: updateRihdActionReadiness(db, tenantId, document, lines, connectorReady),
        mark_at_risk: markAtRiskActionReadiness(db, tenantId, document),
      },
      currency: document.currency,
      amountTotal,
      supplierPerformanceScore: supplier?.performanceScore ?? null,
      communicationCount: communications.length,
      lastCommunicationAt: latestIso(communications.map((item) => item.receivedAt ?? item.occurredAt)),
      productionProgressCount: productionProgress.length,
      latestProductionProgress: latestProductionProgress ? {
        id: latestProductionProgress.id,
        externalId: latestProductionProgress.externalId,
        reportedAt: latestProductionProgress.reportedAt,
        overallStatus: latestProductionProgress.overallStatus,
        evidenceSource: latestProductionProgress.evidenceSource,
      } : null,
      shipmentCount: shipments.length,
      transportEventCount: transportEvents.length,
      receiptCount: receipts.length,
      latestShipment: latestShipment ? {
        id: latestShipment.id,
        externalId: latestShipment.externalId,
        status: latestShipment.status,
        shippedAt: latestShipment.shippedAt,
        estimatedArrivalAt: latestEta,
        carrier: latestShipment.carrier ?? null,
        trackingNumber: latestShipment.trackingNumber ?? null,
        sourceSystem: latestShipment.sourceSystem,
        evidenceSource: latestShipment.evidenceSource ?? null,
      } : null,
      latestTransportEvent: latestTransportEvent ? {
        id: latestTransportEvent.id,
        externalId: latestTransportEvent.externalId,
        shipmentId: latestTransportEvent.shipmentId,
        eventCode: latestTransportEvent.eventCode,
        occurredAt: latestTransportEvent.occurredAt,
        location: latestTransportEvent.location ?? null,
        estimatedArrivalAt: latestTransportEvent.estimatedArrivalAt ?? null,
        carrierReference: latestTransportEvent.carrierReference ?? null,
        evidenceSource: latestTransportEvent.evidenceSource,
      } : null,
      customsStatus: latestCustomsEvent?.eventCode ?? null,
      latestReceipt: latestReceipt ? {
        id: latestReceipt.id,
        externalId: latestReceipt.externalId,
        status: latestReceipt.status,
        receivedAt: latestReceipt.receivedAt,
        warehouseId: latestReceipt.warehouseId,
        sourceSystem: latestReceipt.sourceSystem,
        evidenceSource: latestReceipt.evidenceSource ?? null,
      } : null,
      importDocumentEvaluation: importEvaluation ? {
        status: importEvaluation.status,
        updatedAt: importEvaluation.updated_at,
        summary: parseJson<Record<string, unknown>>({ json: importEvaluation.summary_json }),
      } : null,
      lastActivityAt: latestIso([
        document.updatedAt,
        routeAssignments.get(document.id)?.updated_at,
        importEvaluation?.updated_at,
        ...outbox.map((entry) => entry.updatedAt),
        ...communications.map((item) => item.receivedAt ?? item.occurredAt),
        ...productionProgress.flatMap((item) => [item.reportedAt, item.updatedAt]),
        ...shipments.flatMap((item) => [item.shippedAt, item.updatedAt]),
        ...transportEvents.flatMap((item) => [item.occurredAt, item.updatedAt]),
        ...receipts.flatMap((item) => [item.receivedAt, item.updatedAt]),
        ...leadTimeEvidence.map((item) => item.templateUpdatedAt),
        ...exceptions.map((item) => typeof item['createdAt'] === 'string' ? item['createdAt'] : null),
      ]),
      active: activeStatuses.has(document.status),
    };
  });
  const active = portfolioItems.filter((item) => item.active);
  const atRisk = active.filter((item) => item.risk !== 'low');
  const byCurrency = new Map<string, number>();
  for (const item of atRisk) byCurrency.set(item.currency, (byCurrency.get(item.currency) ?? 0) + item.amountTotal);
  const distribution = {
    high: active.filter((item) => item.risk === 'high').length,
    medium: active.filter((item) => item.risk === 'medium').length,
    low: active.filter((item) => item.risk === 'low').length,
  };
  const routeSummary = (route: ProcurementRoute) => {
    const items = active.filter((item) => item.route === route);
    return {
      total: items.length,
      high: items.filter((item) => item.routeRiskBucket === 'high_risk').length,
      awaitingSupplier: items.filter((item) => item.routeRiskBucket === 'awaiting_supplier').length,
      deliveryRisk: items.filter((item) => item.routeRiskBucket === 'delivery_risk').length,
      onTrack: items.filter((item) => item.routeRiskBucket === 'on_track').length,
    };
  };
  const highlights: Array<{ code: string; count: number; severity: PortfolioRisk; message: string }> = [];
  const noResponse = active.filter((item) => item.riskFactors.some((factor) => factor.code === 'supplier_no_response')).length;
  const overdue = active.filter((item) => item.overdueDays > 0).length;
  const approvalPending = active.filter((item) => item.riskFactors.some((factor) => factor.code === 'approval_pending')).length;
  const readyForProduction = active.filter((item) => item.stage === 'fulfilment_production' && item.risk === 'low').length;
  if (noResponse) highlights.push({ code: 'supplier_no_response', count: noResponse, severity: 'high', message: `${noResponse} 个采购订单仍未获得供应商确认` });
  if (overdue) highlights.push({ code: 'rihd_overdue', count: overdue, severity: 'high', message: `${overdue} 个采购订单已超过要求到货日` });
  if (approvalPending) highlights.push({ code: 'approval_pending', count: approvalPending, severity: 'medium', message: `${approvalPending} 个采购订单正在等待人工决策` });
  if (readyForProduction) highlights.push({ code: 'ready_for_production', count: readyForProduction, severity: 'low', message: `${readyForProduction} 个采购订单正在按计划履约` });
  const generatedAt = latestIso(portfolioItems.map((item) => item.lastActivityAt)) ?? '1970-01-01T00:00:00.000Z';
  return {
    // This is the source snapshot watermark, not the HTTP response time. It
    // stays stable across repeated reads until a persisted procurement fact
    // changes, which makes the portfolio auditable and cache-safe.
    generatedAt,
    configurationWatermark: `tenant-preferences:${storedPreferences?.version ?? 0}:auto-lead-time:${tenantPreferences.autoCalculateLeadTime ? 1 : 0}`,
    configuration: { leadTime: leadTimeConfiguration },
    metrics: {
      highRisk: distribution.high,
      overdue,
      requireAttention: distribution.high + distribution.medium,
      activePurchaseOrders: active.length,
      localProcurement: active.filter((item) => item.route === 'local').length,
      importProcurement: active.filter((item) => item.route === 'import').length,
      unclassifiedRoute: active.filter((item) => item.route === 'unclassified').length,
      atRiskValueByCurrency: Object.fromEntries([...byCurrency.entries()].sort(([left], [right]) => left.localeCompare(right))),
    },
    riskDistribution: distribution,
    routes: { local: routeSummary('local'), import: routeSummary('import'), unclassified: routeSummary('unclassified') },
    highlights,
    items: portfolioItems,
  };
}

function resolveBusinessObjectId(db: DatabaseSync, tenantId: string, requestedId: string): string {
  const direct = db.prepare('SELECT id FROM procurement_documents WHERE tenant_id=? AND id=?').get(tenantId, requestedId) as { id: string } | undefined;
  if (direct) return direct.id;
  const byDisplayNumber = db.prepare(`SELECT id FROM procurement_documents
    WHERE tenant_id=? AND (
      json_extract(json,'$.number')=? OR
      json_extract(json,'$.invoiceNumber')=? OR
      json_extract(json,'$.externalId')=?
    )
    ORDER BY CASE kind WHEN 'purchase_order' THEN 0 WHEN 'invoice' THEN 1 ELSE 2 END,id
    LIMIT 1`).get(tenantId, requestedId, requestedId, requestedId) as { id: string } | undefined;
  if (byDisplayNumber) return byDisplayNumber.id;
  const task = db.prepare('SELECT json FROM runtime_tasks WHERE tenant_id=? AND id=?').get(tenantId, requestedId) as JsonRow | undefined;
  if (task) return String(parseJson<Task>(task).businessObjectId ?? requestedId);
  const exception = db.prepare(`SELECT object_id FROM runtime_exceptions WHERE tenant_id=? AND id=? AND ${NON_VISUAL_TEST_EXCEPTION}`).get(tenantId, requestedId) as { object_id: string } | undefined;
  if (exception) return exception.object_id;
  const approval = db.prepare('SELECT task_id FROM runtime_approvals WHERE tenant_id=? AND id=?').get(tenantId, requestedId) as { task_id: string } | undefined;
  if (approval) {
    const approvalTask = db.prepare('SELECT json FROM runtime_tasks WHERE tenant_id=? AND id=?').get(tenantId, approval.task_id) as JsonRow | undefined;
    if (approvalTask) return String(parseJson<Task>(approvalTask).businessObjectId ?? requestedId);
  }
  return requestedId;
}

const poExecutionStages = [
  { id: 'po_sent', label: 'PO Sent', description: '采购订单发出，并保留连接器回执或 ERP 状态证据' },
  { id: 'supplier_commitment', label: 'Supplier Commitment', description: '收集供应商对数量、价格与承诺交期的确认' },
  { id: 'fulfilment_production', label: 'Fulfilment / Production', description: '跟踪供应商备货、生产与履约进度' },
  { id: 'dispatch_transit', label: 'Dispatch / Transit', description: '记录发运事实并持续跟踪在途状态' },
  { id: 'delivery_grn', label: 'Delivery / GRN', description: '用 ERP / 仓库收货事实核验最终到货' },
] as const;

type PoExecutionStageId = typeof poExecutionStages[number]['id'];
type PoExecutionStageState = 'completed' | 'active' | 'pending' | 'blocked';

interface PoStageEventRow {
  id: string;
  stage: PoExecutionStageId;
  event_type: string;
  state: PoExecutionStageState;
  occurred_at: string;
  source_kind: string;
  source_id: string;
  actor_id: string;
  evidence_json: string;
}

interface PoSlaEvaluationRow {
  stage: PoExecutionStageId;
  status: string;
  due_at: string | null;
  grace_until: string | null;
  next_followup_at: string | null;
  followup_count: number;
  policy_id: string;
  policy_version: number;
  rule_id: string | null;
  evidence_json: string;
  evaluated_at: string;
}

function observedStageFromPoStatus(status: string): { stage: PoExecutionStageId; state: PoExecutionStageState } {
  if (status === 'draft') return { stage: 'po_sent', state: 'active' };
  if (status === 'rejected') return { stage: 'supplier_commitment', state: 'blocked' };
  if (['sent', 'awaiting_confirmation'].includes(status)) return { stage: 'supplier_commitment', state: 'active' };
  if (['confirmed', 'in_production', 'awaiting_shipment'].includes(status)) return { stage: 'fulfilment_production', state: 'active' };
  if (['partially_shipped', 'shipped'].includes(status)) return { stage: 'dispatch_transit', state: 'active' };
  if (status === 'partially_received') return { stage: 'delivery_grn', state: 'active' };
  if (status === 'received') return { stage: 'delivery_grn', state: 'completed' };
  return { stage: 'po_sent', state: 'active' };
}

function resolveExecutionStage(status: string, eventRows: readonly PoStageEventRow[]): { stage: PoExecutionStageId; state: PoExecutionStageState; source: 'exact_event' | 'observed_status' } {
  const observed = observedStageFromPoStatus(status);
  const observedIndex = poExecutionStages.findIndex((stage) => stage.id === observed.stage);
  const latestExactByStage = new Map<PoExecutionStageId, PoStageEventRow>();
  for (const event of eventRows) {
    const evidence = parseJson<Record<string, unknown>>({ json: event.evidence_json });
    if (evidence['exactTransitionTime'] === true) latestExactByStage.set(event.stage, event);
  }
  const highestExact = [...latestExactByStage.entries()]
    .map(([stage, event]) => ({ index: poExecutionStages.findIndex((definition) => definition.id === stage), stage, event }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => right.index - left.index)[0];
  if (!highestExact) return { ...observed, source: 'observed_status' };
  if (highestExact.event.state === 'active' || highestExact.event.state === 'blocked') {
    return { stage: highestExact.stage, state: highestExact.event.state, source: 'exact_event' };
  }
  if (highestExact.event.state === 'completed') {
    if (highestExact.index === poExecutionStages.length - 1) {
      return { stage: highestExact.stage, state: 'completed', source: 'exact_event' };
    }
    if (observedIndex > highestExact.index) return { ...observed, source: 'observed_status' };
    return { stage: poExecutionStages[highestExact.index + 1]!.id, state: 'pending', source: 'exact_event' };
  }
  return { ...observed, source: 'observed_status' };
}

function poStageTimeline(db: DatabaseSync, tenantId: string, po: Record<string, unknown> | undefined) {
  if (!po || typeof po['id'] !== 'string') return [];
  const poId = po['id'];
  const status = typeof po['status'] === 'string' ? po['status'] : 'unknown';
  const eventRows = db.prepare(`SELECT id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json
    FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? ORDER BY occurred_at,rowid`)
    .all(tenantId, poId) as unknown as PoStageEventRow[];
  const eventsByStage = new Map<PoExecutionStageId, Array<PoStageEventRow & { evidence: Record<string, unknown> }>>();
  for (const row of eventRows) {
    const list = eventsByStage.get(row.stage) ?? [];
    list.push({ ...row, evidence: parseJson<Record<string, unknown>>({ json: row.evidence_json }) });
    eventsByStage.set(row.stage, list);
  }
  const resolved = resolveExecutionStage(status, eventRows);
  const resolvedIndex = poExecutionStages.findIndex((stage) => stage.id === resolved.stage);
  const sla = db.prepare(`SELECT stage,status,due_at,grace_until,next_followup_at,followup_count,policy_id,policy_version,rule_id,evidence_json,evaluated_at
    FROM procurement_sla_evaluations WHERE tenant_id=? AND po_id=?`).get(tenantId, poId) as unknown as PoSlaEvaluationRow | undefined;

  return poExecutionStages.map((definition, index) => {
    const events = eventsByStage.get(definition.id) ?? [];
    const inferredState: PoExecutionStageState = index < resolvedIndex
      ? 'completed'
      : index === resolvedIndex ? resolved.state : 'pending';
    // The timeline is a linear state machine: exact evidence can hold an
    // earlier stage open even when ERP status observation suggests a later
    // stage, but it must never render two Active stages simultaneously.
    const state = inferredState;
    const completed = [...events].reverse().find((event) => event.state === 'completed');
    const entered = events.find((event) => event.state === 'active' || event.state === 'completed' || event.state === 'blocked');
    const hasExactEvidence = events.some((event) => event.evidence['exactTransitionTime'] === true);
    const stageSla = sla?.stage === definition.id ? {
      status: sla.status,
      dueAt: sla.due_at,
      graceUntil: sla.grace_until,
      nextFollowupAt: sla.next_followup_at,
      followupCount: sla.followup_count,
      policyId: sla.policy_id,
      policyVersion: sla.policy_version,
      ruleId: sla.rule_id,
      evidence: parseJson<Record<string, unknown>>({ json: sla.evidence_json }),
      evaluatedAt: sla.evaluated_at,
    } : null;
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      state,
      enteredAt: entered?.occurred_at ?? (index === resolvedIndex && resolved.source === 'observed_status' ? po['updatedAt'] ?? null : null),
      completedAt: completed?.occurred_at ?? null,
      evidenceConfidence: events.length
        ? (hasExactEvidence ? 'exact' : 'observed')
        : index < resolvedIndex || (index === resolvedIndex && resolved.source === 'observed_status')
          ? 'inferred_from_observed_status'
          : 'none',
      observedPoStatus: status,
      sla: stageSla,
      events: events.map((event) => ({
        id: event.id,
        type: event.event_type,
        state: event.state,
        occurredAt: event.occurred_at,
        sourceKind: event.source_kind,
        sourceId: event.source_id,
        actorId: event.actor_id,
        evidence: event.evidence,
      })),
    };
  });
}

function duplicatePoActionReadiness(
  db: DatabaseSync,
  tenantId: string,
  po: PurchaseOrder & Record<string, unknown>,
  lines: readonly PurchaseOrderLine[],
): DuplicatePoActionReadiness {
  const supplier = db.prepare(`SELECT 1 AS present FROM procurement_documents
    WHERE tenant_id=? AND kind='supplier' AND id=?`).get(tenantId, po.supplierId) as { present: number } | undefined;
  if (!supplier) return { ready: false, code: 'supplier_missing', message: '当前 PO 的供应商不存在，不能生成可执行草稿。' };
  if (lines.length === 0) return { ready: false, code: 'po_lines_missing', message: '当前 PO 没有可复制的订单行。' };
  return { ready: true, code: 'ready', message: '将复制供应商、币种和订单行，并生成独立 Readywork PO Draft。' };
}

function sendPoActionReadiness(
  db: DatabaseSync,
  tenantId: string,
  po: PurchaseOrder & Record<string, unknown>,
  connectorReady: ((connectorId: string) => boolean) | undefined,
): SendPoActionReadiness {
  if (po.status !== 'draft') {
    return { ready: false, code: 'invalid_state', message: `当前 PO 状态为 ${po.status}，只有草稿可发送。` };
  }
  const activeSend = db.prepare(`SELECT id FROM procurement_outbox
    WHERE tenant_id=? AND action='purchase_order.send' AND aggregate_id=?
      AND status IN ('pending','processing')
    ORDER BY created_at,id LIMIT 1`).get(tenantId, po.id) as { id: string } | undefined;
  if (activeSend) {
    return { ready: false, code: 'send_in_flight', message: '该采购订单已有发送任务正在执行，请等待连接器回执。' };
  }
  const identity = db.prepare(`SELECT status FROM procurement_communication_identities WHERE tenant_id=?`)
    .get(tenantId) as { status: string } | undefined;
  if (!identity || identity.status !== 'active') {
    return {
      ready: false,
      code: 'communication_identity_missing',
      message: '尚未配置供应商可见的采购专业联系人，不能发送采购订单。',
      target: 'communication-identity',
    };
  }
  const rawAttachmentId = po['sourceAttachmentId'];
  if (rawAttachmentId !== undefined && rawAttachmentId !== null && rawAttachmentId !== '') {
    const attachmentId = String(rawAttachmentId).trim();
    const attachment = attachmentId ? db.prepare(`SELECT status,security_status,processing_status,owner_type,owner_id,sha256,version,size_bytes
      FROM procurement_attachments WHERE tenant_id=? AND id=?`).get(tenantId, attachmentId) as {
        status: string; security_status: string; processing_status: string; owner_type: string; owner_id: string | null;
        sha256: string; version: number; size_bytes: number;
      } | undefined : undefined;
    const attachmentReady = Boolean(attachment
      && attachment.status === 'active'
      && attachment.owner_type === 'purchase_order'
      && attachment.owner_id === po.id
      && attachment.security_status === 'clean'
      && attachment.processing_status === 'parsed'
      && /^[a-f0-9]{64}$/i.test(attachment.sha256)
      && Number.isSafeInteger(attachment.version) && attachment.version > 0
      && Number.isSafeInteger(attachment.size_bytes) && attachment.size_bytes > 0);
    if (!attachmentReady) {
      return {
        ready: false,
        code: 'attachment_security_blocked',
        message: '采购订单原始附件尚未通过安全扫描、解析或完整性校验，不能发送。',
        target: 'documents',
      };
    }
  }
  if (connectorReady?.('email') !== true) {
    return {
      ready: false,
      code: 'email_connector_unavailable',
      message: '真实邮箱连接器尚未通过外部连通性验证，不能发送采购订单。',
      target: 'connector-email',
    };
  }
  return { ready: true, code: 'ready', message: '发送前置条件已满足。' };
}

function queueFollowupActionReadiness(
  db: DatabaseSync,
  tenantId: string,
  po: PurchaseOrder & Record<string, unknown>,
): QueueFollowupActionReadiness {
  if (!['sent', 'awaiting_confirmation', 'confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped'].includes(po.status)) {
    return { ready: false, code: 'invalid_state', message: `当前 PO 状态为 ${po.status}，不能生成供应商跟进草稿。` };
  }
  const identity = db.prepare(`SELECT status FROM procurement_communication_identities WHERE tenant_id=?`)
    .get(tenantId) as { status: string } | undefined;
  if (!identity || identity.status !== 'active') {
    return {
      ready: false,
      code: 'communication_identity_missing',
      message: '尚未配置供应商可见的采购专业联系人，不能生成可外发跟进草稿。',
      target: 'communication-identity',
    };
  }
  const supplierRow = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='supplier' AND id=?`).get(tenantId, po.supplierId) as JsonRow | undefined;
  const supplier = supplierRow ? parseJson<Supplier>(supplierRow) : undefined;
  const recipient = supplier?.contacts.find((contact) => contact.primary && contact.email)?.email
    ?? supplier?.contacts.find((contact) => contact.email)?.email;
  if (!recipient || placeholderSupplierEmail(recipient)) {
    return { ready: false, code: 'supplier_email_missing', message: '当前供应商没有可用的真实邮箱，不能生成可外发跟进草稿。' };
  }
  return { ready: true, code: 'ready', message: '供应商跟进草稿前置条件已满足。' };
}

function updateRihdActionReadiness(
  db: DatabaseSync,
  tenantId: string,
  po: PurchaseOrder & Record<string, unknown>,
  lines: readonly PurchaseOrderLine[],
  connectorReady: ((connectorId: string) => boolean) | undefined,
): UpdateRihdActionReadiness {
  if (!['sent', 'awaiting_confirmation', 'confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped', 'shipped', 'partially_received'].includes(po.status)) {
    return { ready: false, code: 'invalid_state', message: `当前 PO 状态为 ${po.status}，不能修改 RIHD。` };
  }
  const odooMapped = po.sourceSystem === 'odoo'
    ? /^purchase\.order:[1-9]\d*$/.test(po.externalId) && typeof po['number'] === 'string' && Boolean(po['number'].trim())
    : po.sourceSystem === 'readywork' && Boolean(po.odooReference?.id && po.odooReference.name.trim());
  if (!odooMapped) {
    return { ready: false, code: 'odoo_mapping_missing', message: '当前 PO 没有可回写的 Odoo 单号映射。' };
  }
  if (lines.length === 0) return { ready: false, code: 'po_lines_missing', message: '当前 PO 没有可核验的订单行。' };
  const active = db.prepare(`SELECT id FROM procurement_outbox
    WHERE tenant_id=? AND action='purchase_order.update_rihd' AND aggregate_id=?
      AND status IN ('blocked','pending','processing')
    ORDER BY created_at,id LIMIT 1`).get(tenantId, po.id) as { id: string } | undefined;
  if (active) return { ready: false, code: 'update_in_flight', message: '该 PO 已有 RIHD 更新正在等待 Odoo 回执。' };
  if (connectorReady?.('erp') !== true) {
    return { ready: false, code: 'erp_connector_unavailable', message: 'Odoo 连接器未通过真实外部验证，不能修改 RIHD。', target: 'connector-erp' };
  }
  return { ready: true, code: 'ready', message: 'RIHD 写入与写后核验前置条件已满足。' };
}

function markAtRiskActionReadiness(
  db: DatabaseSync,
  tenantId: string,
  po: PurchaseOrder & Record<string, unknown>,
): MarkAtRiskActionReadiness {
  if (!['sent', 'awaiting_confirmation', 'confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped', 'shipped', 'partially_received'].includes(po.status)) {
    return { ready: false, code: 'invalid_state', message: `当前 PO 状态为 ${po.status}，不能新增人工风险标记。` };
  }
  const existing = db.prepare(`SELECT id FROM runtime_exceptions
    WHERE tenant_id=? AND object_id=? AND status IN ('open','assigned')
      AND json_extract(json,'$.type')='manual_purchase_order_risk'
    ORDER BY updated_at DESC,id LIMIT 1`).get(tenantId, po.id) as { id: string } | undefined;
  if (existing) {
    return {
      ready: false,
      code: 'already_marked',
      message: '该 PO 已有未解决的人工风险标记，请先在统一异常中心处理现有记录。',
      exceptionId: existing.id,
    };
  }
  return { ready: true, code: 'ready', message: '可创建人工风险事实并进入统一异常与审计链。' };
}

function placeholderSupplierEmail(value: string): boolean {
  const domain = value.trim().toLowerCase().split('@')[1] ?? '';
  return !domain || domain === 'example.com' || domain.endsWith('.example.com')
    || domain === 'example.org' || domain === 'example.net'
    || domain === 'demo.cn' || domain.endsWith('.demo.cn') || domain.endsWith('.test');
}

/**
 * Authoritative tenant-scoped procurement context used by both the workbench
 * and PO chat.  Callers must still enforce their own session/object policy;
 * this query never crosses the supplied tenant boundary.
 */
export function procurementContextForObject(
  db: DatabaseSync,
  tenantId: string,
  requestedId: string,
  connectorReady?: (connectorId: string) => boolean,
): Record<string, unknown> | undefined {
  const objectId = resolveBusinessObjectId(db, tenantId, requestedId);
  const initial = db.prepare('SELECT kind,version,json FROM procurement_documents WHERE tenant_id=? AND id=?')
    .get(tenantId, objectId) as DocumentJsonRow | undefined;
  const legacy = db.prepare('SELECT json FROM runtime_business_objects WHERE tenant_id=? AND id=?').get(tenantId, objectId) as JsonRow | undefined;
  if (!initial && !legacy) return undefined;
  const initialDocument = initial ? parseJson<Record<string, unknown>>(initial) : undefined;
  let poId: string | undefined = initialDocument && initial?.kind === 'purchase_order'
    ? objectId
    : typeof initialDocument?.['poId'] === 'string' ? initialDocument['poId'] : undefined;
  let rfqId: string | undefined = initialDocument && initial?.kind === 'rfq'
    ? objectId
    : typeof initialDocument?.['rfqId'] === 'string' ? initialDocument['rfqId'] : undefined;
  let requisitionId: string | undefined = initialDocument && initial?.kind === 'requisition'
    ? objectId
    : typeof initialDocument?.['requisitionId'] === 'string' ? initialDocument['requisitionId'] : undefined;
  if (initialDocument?.['businessObjectType'] === 'purchase_order' && typeof initialDocument['businessObjectId'] === 'string') poId = initialDocument['businessObjectId'];
  if (initialDocument?.['businessObjectType'] === 'rfq' && typeof initialDocument['businessObjectId'] === 'string') rfqId = initialDocument['businessObjectId'];
  if (initial?.kind === 'communication' && typeof initialDocument?.['businessObjectId'] === 'string') {
    const businessObject = db.prepare('SELECT kind,json FROM procurement_documents WHERE tenant_id=? AND id=?')
      .get(tenantId, initialDocument['businessObjectId']) as { kind: ProcurementWorkbenchKind; json: string } | undefined;
    const businessDocument = businessObject ? parseJson<Record<string, unknown>>({ json: businessObject.json }) : undefined;
    if (businessObject?.kind === 'purchase_order') poId = initialDocument['businessObjectId'];
    if (businessObject?.kind === 'rfq') rfqId = initialDocument['businessObjectId'];
    if (businessObject?.kind === 'quote' && typeof businessDocument?.['rfqId'] === 'string') rfqId = businessDocument['rfqId'];
    if (businessObject?.kind === 'invoice' && typeof businessDocument?.['poId'] === 'string') poId = businessDocument['poId'];
  }
  if (initial) {
    if (!poId && initial.kind === 'invoice') {
      const match = db.prepare(`SELECT json FROM procurement_documents
        WHERE tenant_id=? AND kind='match' AND json_extract(json,'$.invoiceId')=? ORDER BY created_at,id LIMIT 1`)
        .get(tenantId, objectId) as JsonRow | undefined;
      if (match) {
        const matchDocument = parseJson<Record<string, unknown>>(match);
        if (typeof matchDocument['poId'] === 'string') poId = matchDocument['poId'];
      }
    }
    if (!rfqId && initial.kind === 'requisition') {
      const rfq = db.prepare(`SELECT json FROM procurement_documents
        WHERE tenant_id=? AND kind='rfq' AND json_extract(json,'$.requisitionId')=? ORDER BY created_at,id LIMIT 1`)
        .get(tenantId, objectId) as JsonRow | undefined;
      if (rfq) rfqId = String(parseJson<Record<string, unknown>>(rfq)['id'] ?? '');
    }
  }
  const related = poId
    ? db.prepare(`SELECT kind,version,json FROM procurement_documents
        WHERE tenant_id=? AND (id=? OR id=? OR json_extract(json,'$.poId')=?) ORDER BY created_at,id`)
      .all(tenantId, poId, objectId, poId) as unknown as DocumentJsonRow[]
    : initial ? [initial] : [];
  const parsed = related.map((row) => ({ row, document: parseJson<ProcurementDocument & Record<string, unknown>>(row) }));
  const addDocument = (row: DocumentJsonRow | undefined): void => {
    if (!row) return;
    const document = parseJson<ProcurementDocument & Record<string, unknown>>(row);
    if (!parsed.some((item) => item.document.id === document.id)) parsed.push({ row, document });
  };
  const addDocuments = (rows: unknown): void => {
    for (const row of rows as DocumentJsonRow[]) addDocument(row);
  };
  const byId = (kind: ProcurementWorkbenchKind, id: string | undefined): DocumentJsonRow | undefined => {
    if (!id) return undefined;
    return db.prepare('SELECT kind,version,json FROM procurement_documents WHERE tenant_id=? AND kind=? AND id=?')
      .get(tenantId, kind, id) as DocumentJsonRow | undefined;
  };
  const byJson = (kind: ProcurementWorkbenchKind, field: string, value: string | undefined): DocumentJsonRow[] => {
    if (!value) return [];
    return db.prepare(`SELECT kind,version,json FROM procurement_documents WHERE tenant_id=? AND kind=? AND json_extract(json, ?) = ? ORDER BY created_at,id`)
      .all(tenantId, kind, `$.${field}`, value) as unknown as DocumentJsonRow[];
  };
  // Expand from any procurement document root, not only a PO/task root. Every
  // lookup remains tenant-scoped so a supplied RFQ/quote ID cannot cross tenants.
  addDocument(byId('purchase_order', poId));
  addDocument(byId('rfq', rfqId));
  addDocument(byId('requisition', requisitionId));
  if (!rfqId && requisitionId) {
    const rfqFromRequisition = byJson('rfq', 'requisitionId', requisitionId)[0];
    addDocument(rfqFromRequisition);
    if (rfqFromRequisition) rfqId = parseJson<Record<string, unknown>>(rfqFromRequisition)['id'] as string | undefined;
  }
  if (rfqId) {
    addDocuments(byJson('quote', 'rfqId', rfqId));
    addDocuments(byJson('quote_comparison', 'rfqId', rfqId));
    const awards = byJson('award', 'rfqId', rfqId);
    addDocuments(awards);
    for (const awardRow of awards) {
      const award = parseJson<Record<string, unknown>>(awardRow);
      addDocuments(byJson('purchase_order', 'awardId', typeof award['id'] === 'string' ? award['id'] : undefined));
    }
  }
  if (poId) {
    addDocuments(byJson('purchase_order', 'poId', poId));
    addDocuments(byJson('confirmation', 'poId', poId));
    addDocuments(byJson('shipment', 'poId', poId));
    addDocuments(byJson('transport_event', 'poId', poId));
    addDocuments(byJson('receipt', 'poId', poId));
    addDocuments(byJson('invoice', 'poId', poId));
    addDocuments(byJson('match', 'poId', poId));
  }
  // RFQ/quote roots may discover the requisition and supplier only after the
  // first expansion; derive those IDs from the now-visible documents.
  const discoveredRfqDocument = parsed.find(({ row }) => row.kind === 'rfq')?.document;
  if (!requisitionId && typeof discoveredRfqDocument?.['requisitionId'] === 'string') requisitionId = discoveredRfqDocument['requisitionId'];
  addDocument(byId('requisition', requisitionId));
  const supplierIds = new Set<string>();
  for (const { document } of parsed) {
    if (typeof document['supplierId'] === 'string') supplierIds.add(document['supplierId']);
    if (Array.isArray(document['supplierIds'])) for (const id of document['supplierIds']) if (typeof id === 'string') supplierIds.add(id);
  }
  for (const supplierId of supplierIds) addDocument(byId('supplier', supplierId));
  const relatedIds = new Set(parsed.map(({ document }) => document.id));
  const communications = db.prepare(`SELECT kind,version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='communication' ORDER BY created_at,id`).all(tenantId) as unknown as DocumentJsonRow[];
  addDocuments(communications.filter((row) => {
    const document = parseJson<Record<string, unknown>>(row);
    return (typeof document['businessObjectId'] === 'string' && (relatedIds.has(document['businessObjectId']) || document['businessObjectId'] === rfqId || document['businessObjectId'] === poId))
      || (typeof document['rfqId'] === 'string' && document['rfqId'] === rfqId);
  }));
  const invoiceIds = [...new Set(parsed
    .filter(({ row }) => row.kind === 'match')
    .map(({ document }) => document['invoiceId'])
    .filter((id): id is string => typeof id === 'string'))];
  for (const invoiceId of invoiceIds) {
    if (parsed.some(({ document }) => document.id === invoiceId)) continue;
    const invoice = db.prepare(`SELECT kind,version,json FROM procurement_documents
      WHERE tenant_id=? AND kind='invoice' AND id=?`).get(tenantId, invoiceId) as DocumentJsonRow | undefined;
    addDocument(invoice);
  }
  const po = parsed.find(({ row }) => row.kind === 'purchase_order')?.document;
  const stageTimeline = poStageTimeline(db, tenantId, po);
  const awardId = typeof po?.['awardId'] === 'string' ? po['awardId'] : undefined;
  const award = awardId ? db.prepare(`SELECT kind,version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='award' AND id=?`).get(tenantId, awardId) as DocumentJsonRow | undefined : undefined;
  addDocument(award);
  const awardDocument = award ? parseJson<Award & Record<string, unknown>>(award) : undefined;
  rfqId = rfqId ?? (typeof awardDocument?.rfqId === 'string' ? awardDocument.rfqId : undefined);
  const rfq = rfqId ? db.prepare(`SELECT kind,version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='rfq' AND id=?`).get(tenantId, rfqId) as DocumentJsonRow | undefined : undefined;
  addDocument(rfq);
  const rfqDocument = rfq ? parseJson<RequestForQuotation & Record<string, unknown>>(rfq) : undefined;
  if (rfqDocument?.requisitionId) {
    addDocument(db.prepare(`SELECT kind,version,json FROM procurement_documents
      WHERE tenant_id=? AND kind='requisition' AND id=?`).get(tenantId, rfqDocument.requisitionId) as DocumentJsonRow | undefined);
  }
  if (rfqId) {
    const quotes = db.prepare(`SELECT kind,version,json FROM procurement_documents
      WHERE tenant_id=? AND kind='quote' AND json_extract(json,'$.rfqId')=? ORDER BY created_at,id`)
      .all(tenantId, rfqId) as unknown as DocumentJsonRow[];
    for (const quote of quotes) addDocument(quote);
    const comparisons = db.prepare(`SELECT kind,version,json FROM procurement_documents
      WHERE tenant_id=? AND kind='quote_comparison'
        AND (id=? OR json_extract(json,'$.rfqId')=?) ORDER BY created_at,id`)
      .all(tenantId, rfqDocument?.comparisonSnapshotId ?? '', rfqId) as unknown as DocumentJsonRow[];
    for (const comparison of comparisons) addDocument(comparison);
  }
  const supplierId = typeof po?.['supplierId'] === 'string' ? po['supplierId'] : undefined;
  if (supplierId) {
    const supplier = db.prepare("SELECT kind,version,json FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?")
      .get(tenantId, supplierId) as DocumentJsonRow | undefined;
    addDocument(supplier);
  }
  const documentIds = [...new Set([objectId, ...parsed.map(({ document }) => document.id)])];
  const placeholders = documentIds.map(() => '?').join(',');
  const lines = documentIds.length ? db.prepare(`SELECT document_id,json FROM procurement_lines WHERE tenant_id=? AND document_id IN (${placeholders}) ORDER BY document_id,line_number,id`)
    .all(tenantId, ...documentIds) as unknown as Array<{ document_id: string; json: string }> : [];
  const linesByDocument = Object.fromEntries(documentIds.map((id) => [id, lines.filter((line) => line.document_id === id).map((line) => parseJson<Record<string, unknown>>(line))]));
  const lineIds = lines.map((line) => {
    const parsedLine = parseJson<Record<string, unknown>>(line);
    return typeof parsedLine['id'] === 'string' ? parsedLine['id'] : undefined;
  }).filter((id): id is string => Boolean(id));
  const quantityProjections = lineIds.length ? db.prepare(`SELECT projection_json FROM procurement_po_line_quantity_projections
    WHERE tenant_id=? AND po_line_id IN (${lineIds.map(() => '?').join(',')}) ORDER BY po_line_id`)
    .all(tenantId, ...lineIds).map((row) => parseJson<Record<string, unknown>>({ json: String((row as { projection_json: string }).projection_json) })) : [];
  const attachments = collectContextAttachments(db, tenantId, parsed, linesByDocument);
  const activities = documentIds.length ? db.prepare(`SELECT json FROM runtime_activities WHERE tenant_id=? AND object_id IN (${placeholders}) AND ${NON_VISUAL_TEST_ACTIVITY} ORDER BY rowid`)
    .all(tenantId, ...documentIds).map((row) => parseJson<Activity>(row as unknown as JsonRow)) : [];
  const exceptions = documentIds.length ? db.prepare(`SELECT json FROM runtime_exceptions WHERE tenant_id=? AND object_id IN (${placeholders}) AND ${NON_VISUAL_TEST_EXCEPTION} ORDER BY updated_at,id`)
    .all(tenantId, ...documentIds).map((row) => parseJson<BusinessException>(row as unknown as JsonRow)) : [];
  const tasks = db.prepare('SELECT json FROM runtime_tasks WHERE tenant_id=?').all(tenantId)
    .map((row) => parseJson<Task>(row as unknown as JsonRow)).filter((task) => documentIds.includes(task.businessObjectId));
  const taskIds = tasks.map((task) => task.id);
  const approvals = taskIds.length ? db.prepare(`SELECT json FROM runtime_approvals WHERE tenant_id=? AND task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY updated_at,id`)
    .all(tenantId, ...taskIds).map((row) => parseJson<ApprovalRequest>(row as unknown as JsonRow)) : [];
  const executionApprovals = documentIds.length ? db.prepare(`SELECT json FROM procurement_execution_approvals
    WHERE tenant_id=? AND (object_id IN (${placeholders}) OR json_extract(json,'$.poId') IN (${placeholders}))
    ORDER BY updated_at,id`).all(tenantId, ...documentIds, ...documentIds)
    .map((row) => parseJson<Record<string, unknown>>(row as unknown as JsonRow)) : [];
  const outbox = documentIds.length ? db.prepare(`SELECT id,channel,connector_id,action,aggregate_id,status,attempt,
      created_at,updated_at,dispatched_at,failed_at,json FROM procurement_outbox
    WHERE tenant_id=? AND aggregate_id IN (${placeholders}) ORDER BY created_at,id`)
    .all(tenantId, ...documentIds).map((row) => {
      const value = row as Record<string, unknown>;
      const document = parseJson<Record<string, unknown>>({ json: String(value['json']) });
      return {
        id: value['id'], channel: value['channel'], connectorId: value['connector_id'], action: value['action'],
        aggregateId: value['aggregate_id'], status: value['status'], attempts: value['attempt'],
        createdAt: value['created_at'], updatedAt: value['updated_at'], dispatchedAt: value['dispatched_at'], failedAt: value['failed_at'],
        nextAttemptAt: document['nextAttemptAt'] ?? null, error: document['error'] ?? null,
      };
    }) : [];
  const groups: Record<string, unknown[]> = {
    requisitions: [], rfqs: [], quotes: [], awards: [], comparisons: [], purchaseOrders: [], confirmations: [],
    productionProgress: [], shipments: [], transportEvents: [], receipts: [], invoices: [], matches: [], suppliers: [], communications: [],
  };
  const groupByKind: Partial<Record<ProcurementWorkbenchKind, keyof typeof groups>> = {
    requisition: 'requisitions', rfq: 'rfqs', quote: 'quotes', award: 'awards', quote_comparison: 'comparisons',
    purchase_order: 'purchaseOrders', confirmation: 'confirmations', production_progress: 'productionProgress', shipment: 'shipments', receipt: 'receipts',
    transport_event: 'transportEvents',
    invoice: 'invoices', match: 'matches', supplier: 'suppliers', communication: 'communications',
  };
  for (const { row, document } of parsed) {
    const key = groupByKind[row.kind];
    if (key) {
      const number = row.kind === 'purchase_order' ? documentNumber(document) : null;
      groups[key]!.push({
        ...document,
        ...(row.kind === 'purchase_order' ? { number, displayNumber: number ?? document.externalId } : {}),
        version: row.version,
        lines: linesByDocument[document.id] ?? [],
      });
    }
  }
  // Edit PO needs a tenant-scoped supplier selector, not only suppliers already
  // referenced by the current PO context graph.
  groups['suppliers'] = (db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='supplier' AND status='active' ORDER BY updated_at DESC,id`)
    .all(tenantId) as unknown as JsonRow[]).map((row) => parseJson<Record<string, unknown>>(row));
  const exactSupplier = supplierId
    ? (groups['suppliers'] as Array<Record<string, unknown>>).find((item) => item['id'] === supplierId) ?? null
    : null;
  const supplierProfileRow = supplierId && sqliteTableExists(db, 'procurement_supplier_operating_profiles')
    ? db.prepare(`SELECT version,country_code,route,supplier_type,industry,address_json,primary_material_code,primary_material_name,
        default_lead_time_days,product_criticality,payment_terms,contract_starts_on,contract_ends_on,status,created_at,updated_at
      FROM procurement_supplier_operating_profiles WHERE tenant_id=? AND supplier_id=?`).get(tenantId, supplierId) as Record<string, unknown> | undefined
    : undefined;
  const supplierProfile = supplierProfileRow ? {
    version: Number(supplierProfileRow['version']),
    countryCode: nonBlankText(supplierProfileRow['country_code']),
    route: supplierProfileRow['route'],
    supplierType: supplierProfileRow['supplier_type'],
    industry: nonBlankText(supplierProfileRow['industry']),
    address: parseNullableJsonObject(supplierProfileRow['address_json']),
    primaryMaterialCode: nonBlankText(supplierProfileRow['primary_material_code']),
    primaryMaterialName: nonBlankText(supplierProfileRow['primary_material_name']),
    defaultLeadTimeDays: finiteNumber(supplierProfileRow['default_lead_time_days']),
    productCriticality: supplierProfileRow['product_criticality'],
    paymentTerms: nonBlankText(supplierProfileRow['payment_terms']),
    contractStartsOn: supplierProfileRow['contract_starts_on'] ?? null,
    contractEndsOn: supplierProfileRow['contract_ends_on'] ?? null,
    status: supplierProfileRow['status'],
    createdAt: supplierProfileRow['created_at'],
    updatedAt: supplierProfileRow['updated_at'],
  } : null;
  const projectionByLineId = new Map(quantityProjections.map((item) => [nonBlankText(item['poLineId']), item]));
  const poItemRows = po ? (linesByDocument[po.id] ?? []).map((line) => {
    const lineId = nonBlankText(line['id']);
    const projection = lineId ? projectionByLineId.get(lineId) : undefined;
    const ordered = finiteNumber(projection?.['orderedQty']) ?? finiteNumber(line['orderedQty']);
    const unitPrice = finiteNumber(line['unitPrice']);
    return {
      id: lineId,
      item: nonBlankText(line['itemName']) ?? nonBlankText(line['description']) ?? nonBlankText(line['itemId']),
      description: nonBlankText(line['description']),
      category: nonBlankText(line['category']) ?? nonBlankText(line['itemCategory']),
      ordered,
      confirmed: finiteNumber(projection?.['confirmedQty']),
      unit: nonBlankText(line['uom']),
      unitPrice,
      tax: finiteNumber(line['tax']) ?? finiteNumber(line['taxRate']),
      total: finiteNumber(line['total']) ?? finiteNumber(line['lineTotal']) ?? (ordered !== null && unitPrice !== null ? ordered * unitPrice : null),
      shipped: finiteNumber(projection?.['shippedQty']),
      received: finiteNumber(projection?.['receivedQty']),
      status: nonBlankText(line['status']) ?? nonBlankText(projection?.['status']),
      currency: nonBlankText(line['currency']) ?? nonBlankText(po['currency']),
      lineNumber: nonBlankText(line['lineNumber']),
    };
  }) : [];
  const snapshotRows = po && sqliteTableExists(db, 'procurement_purchase_order_document_snapshots')
    ? db.prepare(`SELECT id,document_id,snapshot_kind,source_po_version,template_version,content_sha256,object_key,size_bytes,generated_by,generated_at
      FROM procurement_purchase_order_document_snapshots WHERE tenant_id=? AND po_id=? ORDER BY generated_at,id`).all(tenantId, po.id) as unknown as Array<Record<string, unknown>>
    : [];
  const importDocumentBindings = po && sqliteTableExists(db, 'procurement_import_documents')
    ? db.prepare(`SELECT id,requirement_code,attachment_id,document_number,issued_at,expires_at,version,created_by,created_at,updated_at
      FROM procurement_import_documents WHERE tenant_id=? AND po_id=? AND status='active' ORDER BY requirement_code,id`)
      .all(tenantId, po.id) as unknown as Array<Record<string, unknown>>
    : [];
  const importBindingByAttachment = new Map(importDocumentBindings.map((item) => [String(item['attachment_id']), item]));
  const importEvaluationRow = po && sqliteTableExists(db, 'procurement_import_document_evaluations')
    ? db.prepare(`SELECT policy_id,policy_version,status,summary_json,evaluated_at,updated_at
      FROM procurement_import_document_evaluations WHERE tenant_id=? AND po_id=?`).get(tenantId, po.id) as Record<string, unknown> | undefined
    : undefined;
  const importEvaluationSummary = importEvaluationRow
    ? parseJson<Record<string, unknown>>({ json: String(importEvaluationRow['summary_json']) })
    : undefined;
  const evaluatedRequirements = Array.isArray(importEvaluationSummary?.['requirements'])
    ? importEvaluationSummary['requirements'].filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const evaluatedRequirementByCode = new Map(evaluatedRequirements.map((item) => [String(item['code']), item]));
  const evaluatedPolicy = importEvaluationRow?.['policy_id'] && Number.isSafeInteger(Number(importEvaluationRow['policy_version']))
    && sqliteTableExists(db, 'procurement_import_document_policies')
    ? db.prepare(`SELECT id,version FROM procurement_import_document_policies
      WHERE tenant_id=? AND id=? AND version=? AND status='published'`).get(
        tenantId,
        String(importEvaluationRow['policy_id']),
        Number(importEvaluationRow['policy_version']),
      ) as { id: string; version: number } | undefined
    : undefined;
  const hasAuthoritativeImportEvaluation = Boolean(evaluatedPolicy && Array.isArray(importEvaluationSummary?.['requirements']));
  const evaluatedDocumentRequirements = hasAuthoritativeImportEvaluation ? evaluatedRequirements
    .filter((item) => item['required'] === true)
    .map((item) => {
      const code = nonBlankText(item['code']) ?? 'unknown_requirement';
      const status = nonBlankText(item['status']) ?? 'missing';
      return {
        id: code,
        label: nonBlankText(item['name']) ?? code,
        description: nonBlankText(item['description']),
        required: true,
        requiredStage: nonBlankText(item['requiredStage']),
        expiryRequired: item['expiryRequired'] === true,
        state: status === 'passed' ? 'present' : status,
        evidence: nonBlankText(item['evidence']),
        policyId: evaluatedPolicy!.id,
        policyVersion: evaluatedPolicy!.version,
      };
    }) : [];
  const persistedDocumentRows: Array<Record<string, unknown>> = [
    ...attachments.filter((item) => !po || item.sourceDocumentId === po.id).map((item) => {
      const verified = item.securityStatus === 'clean' && item.processingStatus === 'parsed';
      const binding = importBindingByAttachment.get(item.id);
      const requirementCode = binding ? String(binding['requirement_code']) : null;
      const requirement = requirementCode ? evaluatedRequirementByCode.get(requirementCode) : undefined;
      return {
        id: item.id, name: item.fileName, category: requirementCode ?? 'attachment', requirementLabel: nonBlankText(requirement?.['name']), status: verified ? 'verified' : 'pending', verified,
        source: item.version === undefined ? 'attachment_reference' : 'stored_attachment', sourceDocumentId: item.sourceDocumentId,
        version: item.version ?? null, securityStatus: item.securityStatus ?? null, processingStatus: item.processingStatus ?? null,
        contentType: item.contentType, detectedContentType: item.detectedContentType ?? null,
        sizeBytes: item.sizeBytes, createdAt: item.createdAt ?? null, createdBy: item.createdBy ?? null,
        importDocumentId: binding?.['id'] ?? null, documentNumber: binding?.['document_number'] ?? null,
        issuedAt: binding?.['issued_at'] ?? null, expiresAt: binding?.['expires_at'] ?? null,
        // There is no scan-completion timestamp in storage; expose only known creation/parse times.
        updatedAt: [item.createdAt, item.parsedAt].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
        url: item.url ?? null,
      };
    }),
    ...snapshotRows.map((item) => ({
      id: item['document_id'], snapshotId: item['id'], name: String(item['object_key']), category: item['snapshot_kind'], status: 'verified', verified: true,
      source: 'generated_snapshot', sourceDocumentId: po!.id, version: Number(item['source_po_version']), templateVersion: Number(item['template_version']),
      securityStatus: null, processingStatus: 'generated', contentType: 'application/pdf', updatedAt: item['generated_at'],
      sizeBytes: Number(item['size_bytes']), createdAt: item['generated_at'], createdBy: item['generated_by'],
      url: `/api/procurement/purchase-order-document-snapshots/${encodeURIComponent(String(item['id']))}/pdf`,
    })),
  ];
  const confirmationsForPo = (groups['confirmations'] as Array<Record<string, unknown>>).filter((item) => item['poId'] === po?.id);
  const shipmentsForPo = (groups['shipments'] as Array<Record<string, unknown>>).filter((item) => item['poId'] === po?.id);
  const invoicesForPo = (groups['invoices'] as Array<Record<string, unknown>>).filter((item) => item['poId'] === po?.id);
  const fallbackDocumentRequirements = po ? [
    { id: 'purchase_order', label: 'Purchase Order', required: true, state: snapshotRows.length ? 'present' : 'missing' },
    { id: 'supplier_confirmation', label: 'Supplier Confirmation', required: ['sent', 'awaiting_confirmation', 'confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped', 'shipped', 'partially_received', 'received', 'completed'].includes(String(po['status'])), state: confirmationsForPo.length ? 'present' : 'missing' },
    { id: 'packing_list', label: 'Packing List', required: shipmentsForPo.length > 0, state: persistedDocumentRows.some((item) => /packing/i.test(String(item['name'])) || item['category'] === 'packing_list') ? 'present' : 'missing' },
    { id: 'invoice', label: 'Invoice', required: invoicesForPo.length > 0, state: invoicesForPo.length ? 'present' : 'missing' },
  ].filter((item) => item.required) : [];
  const documentRequirements = hasAuthoritativeImportEvaluation ? evaluatedDocumentRequirements : fallbackDocumentRequirements;
  const missingRequirementRows = (hasAuthoritativeImportEvaluation ? documentRequirements : [])
    .filter((item) => item.state === 'missing' && !persistedDocumentRows.some((row) => row['category'] === item.id))
    .map((item) => ({
      id: `requirement:${item.id}`,
      name: item.label,
      category: item.id,
      requirementLabel: item.label,
      status: 'missing',
      verified: false,
      source: 'required_rule',
      sourceDocumentId: po?.id ?? null,
      createdAt: null,
      createdBy: null,
      sizeBytes: null,
      url: null,
    }));
  const documentRows: Array<Record<string, unknown>> = [...persistedDocumentRows, ...missingRequirementRows];
  const amendmentRows = po && sqliteTableExists(db, 'procurement_purchase_order_amendments')
    ? db.prepare(`SELECT id,action,state,source_po_version,outbox_id,idempotency_key,actor_id,reason,created_at,updated_at,applied_at FROM procurement_purchase_order_amendments
      WHERE tenant_id=? AND po_id=? ORDER BY created_at,id`).all(tenantId, po.id) as unknown as Array<Record<string, unknown>>
    : [];
  const stageHistoryRows = po && sqliteTableExists(db, 'procurement_po_stage_events')
    ? db.prepare(`SELECT id,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json
      FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? ORDER BY occurred_at,id`)
      .all(tenantId, po.id) as unknown as Array<Record<string, unknown>>
    : [];
  const routeHistoryRows = po && sqliteTableExists(db, 'procurement_route_events')
    ? db.prepare(`SELECT id,actor_id,action,detail_json,created_at
      FROM procurement_route_events WHERE tenant_id=? AND po_id=? ORDER BY created_at,id`)
      .all(tenantId, po.id) as unknown as Array<Record<string, unknown>>
    : [];
  const routeEvidenceHistoryRows = po && sqliteTableExists(db, 'procurement_route_evidence_document_events')
    ? db.prepare(`SELECT id,document_id,actor_id,action,detail_json,created_at
      FROM procurement_route_evidence_document_events WHERE tenant_id=? AND po_id=? ORDER BY created_at,id`)
      .all(tenantId, po.id) as unknown as Array<Record<string, unknown>>
    : [];
  const slaHistoryRows = po && sqliteTableExists(db, 'procurement_sla_evaluation_events')
    ? db.prepare(`SELECT id,policy_id,rule_id,action,detail_json,created_at
      FROM procurement_sla_evaluation_events WHERE tenant_id=? AND po_id=? ORDER BY created_at,id`)
      .all(tenantId, po.id) as unknown as Array<Record<string, unknown>>
    : [];
  const importDocumentHistoryRows = po && sqliteTableExists(db, 'procurement_import_document_events')
    ? db.prepare(`SELECT id,import_document_id,actor_id,action,detail_json,created_at
      FROM procurement_import_document_events WHERE tenant_id=? AND po_id=? ORDER BY created_at,id`)
      .all(tenantId, po.id) as unknown as Array<Record<string, unknown>>
    : [];
  const quantityHistoryRows = po && lineIds.length && sqliteTableExists(db, 'procurement_po_line_quantity_events')
    ? db.prepare(`SELECT source_system,source_event_id,po_line_id,dimension,delta,occurred_at,json
      FROM procurement_po_line_quantity_events WHERE tenant_id=? AND po_line_id IN (${lineIds.map(() => '?').join(',')})
      ORDER BY occurred_at,source_system,source_event_id`)
      .all(tenantId, ...lineIds) as unknown as Array<Record<string, unknown>>
    : [];
  const cancellationRow = amendmentRows.filter((item) => item['action'] === 'cancel').at(-1);
  const purchaseOrderCancellation = cancellationRow ? {
    requestId: cancellationRow['id'],
    state: cancellationRow['state'],
    sourcePoVersion: Number(cancellationRow['source_po_version']),
    outboxId: cancellationRow['outbox_id'] ?? null,
    idempotencyKey: cancellationRow['idempotency_key'],
    reason: cancellationRow['reason'],
  } : null;
  const historyEvents = buildPoHistoryEvents(activities, outbox, amendmentRows, {
    stageEvents: stageHistoryRows,
    routeEvents: routeHistoryRows,
    routeEvidenceEvents: routeEvidenceHistoryRows,
    slaEvents: slaHistoryRows,
    importDocumentEvents: importDocumentHistoryRows,
    quantityEvents: quantityHistoryRows,
  });
  const poCommunications = (groups['communications'] as Array<Record<string, unknown>>)
    .filter((item) => item['businessObjectId'] === po?.id)
    .map((item): Record<string, unknown> => {
      const analysis = sqliteTableExists(db, 'procurement_ai_reply_analyses')
        ? db.prepare('SELECT status,model,result_json,updated_at FROM procurement_ai_reply_analyses WHERE tenant_id=? AND communication_id=?').get(tenantId, String(item['id'])) as { status: string; model: string; result_json: string | null; updated_at: string } | undefined
        : undefined;
      return { ...item, ...(analysis ? { aiAnalysis: { ...(analysis.result_json ? JSON.parse(analysis.result_json) : {}), status: analysis.status, model: analysis.model, updatedAt: analysis.updated_at } } : {}) };
    })
    .sort((left, right) => String(right['receivedAt'] ?? right['occurredAt'] ?? right['createdAt'] ?? '').localeCompare(String(left['receivedAt'] ?? left['occurredAt'] ?? left['createdAt'] ?? '')) || String(left['id']).localeCompare(String(right['id'])));
  const relatedThreads = [...new Set(poCommunications.map((item) => nonBlankText(item['inReplyTo']) ?? nonBlankText(item['messageId'])).filter((id): id is string => Boolean(id)))]
    .map((id) => {
      const messages = poCommunications.filter((item) => item['messageId'] === id || item['inReplyTo'] === id);
      const first = messages[0] ?? poCommunications.find((item) => item['messageId'] === id)!;
      return { id, subject: nonBlankText(first?.['subject']), messageCount: Math.max(1, messages.length), latestAt: first?.['receivedAt'] ?? first?.['occurredAt'] ?? first?.['createdAt'] ?? null };
    });
  const inboundCount = poCommunications.filter((item) => item['direction'] === 'inbound').length;
  const outboundCount = poCommunications.filter((item) => item['direction'] === 'outbound').length;
  const pendingDraftCount = poCommunications.filter((item) => item['status'] === 'draft' || item['status'] === 'pending').length;
  const poDetail = po ? {
    supplier: exactSupplier,
    supplierProfile,
    items: { rows: poItemRows },
    documents: {
      rows: documentRows,
      requirements: documentRequirements,
      kpis: {
        total: documentRows.length,
        verified: documentRows.filter((item) => item.status === 'verified').length,
        pending: documentRows.filter((item) => item.status === 'pending').length,
        missing: documentRequirements.filter((item) => item.state === 'missing').length,
      },
    },
    history: { events: historyEvents },
    communication: {
      messages: poCommunications,
      relatedThreads,
      kpis: { total: poCommunications.length, inbound: inboundCount, outbound: outboundCount, pendingDrafts: pendingDraftCount },
    },
  } : null;
  return {
    requestedId, objectId, root: initial ? { ...parseJson<Record<string, unknown>>(initial), kind: initial.kind, version: initial.version } : parseJson<Record<string, unknown>>(legacy!),
    ...groups, tasks, approvals, executionApprovals, exceptions, activities, outbox, quantityProjections, attachments, linesByDocument, stageTimeline, poDetail,
    purchaseOrderCancellation,
    actionReadiness: po ? {
      duplicate_po: duplicatePoActionReadiness(
        db,
        tenantId,
        po as PurchaseOrder & Record<string, unknown>,
        (linesByDocument[po.id] ?? []) as unknown as PurchaseOrderLine[],
      ),
      send_po: sendPoActionReadiness(db, tenantId, po as PurchaseOrder & Record<string, unknown>, connectorReady),
      queue_followup: queueFollowupActionReadiness(db, tenantId, po as PurchaseOrder & Record<string, unknown>),
      update_rihd: updateRihdActionReadiness(
        db,
        tenantId,
        po as PurchaseOrder & Record<string, unknown>,
        (linesByDocument[po.id] ?? []) as unknown as PurchaseOrderLine[],
        connectorReady,
      ),
      mark_at_risk: markAtRiskActionReadiness(db, tenantId, po as PurchaseOrder & Record<string, unknown>),
    } : {},
  };
}

interface ContextAttachment {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url?: string;
  readonly sourceDocumentId: string;
  readonly securityStatus?: string;
  readonly processingStatus?: string;
  readonly detectedContentType?: string;
  readonly version?: number;
  readonly createdBy?: string;
  readonly createdAt?: string;
  readonly parsedAt?: string;
}

function collectContextAttachments(
  db: DatabaseSync,
  tenantId: string,
  documents: Array<{ document: ProcurementDocument & Record<string, unknown> }>,
  linesByDocument: Record<string, Array<Record<string, unknown>>>,
): ContextAttachment[] {
  const found = new Map<string, ContextAttachment & { metadata: boolean }>();
  const addReferences = (value: unknown, sourceDocumentId: string): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim() || found.has(item)) continue;
      found.set(item, {
        id: item, fileName: item, contentType: 'application/octet-stream', sizeBytes: 0, sourceDocumentId, metadata: false,
      });
    }
  };
  const addMetadata = (value: unknown, sourceDocumentId: string): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const attachment = item as Record<string, unknown>;
      const id = attachment['id'];
      const fileName = attachment['fileName'];
      const contentType = attachment['contentType'];
      const sizeBytes = attachment['sizeBytes'];
      const url = attachment['url'];
      if (typeof id !== 'string' || !id.trim() || typeof fileName !== 'string' || !fileName.trim()
        || typeof contentType !== 'string' || !contentType.trim()
        || !Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0
        || (url !== undefined && (typeof url !== 'string' || !url.trim()))) continue;
      found.set(id, {
        id, fileName, contentType, sizeBytes: sizeBytes as number, sourceDocumentId, metadata: true,
        ...(typeof url === 'string' ? { url } : {}),
      });
    }
  };
  const collect = (container: Record<string, unknown>, sourceDocumentId: string): void => {
    addReferences(container['attachmentIds'], sourceDocumentId);
    addMetadata(container['attachments'], sourceDocumentId);
    const evidence = container['evidence'];
    if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
      addReferences((evidence as Record<string, unknown>)['attachmentIds'], sourceDocumentId);
    }
  };
  for (const { document } of documents) {
    collect(document, document.id);
    for (const line of linesByDocument[document.id] ?? []) collect(line, document.id);
  }

  // PO intake and import-document flows persist binaries separately from the
  // procurement document JSON. Query those owner/requisition links so a real
  // stored attachment cannot disappear merely because the source document did
  // not embed an attachment snapshot.
  const documentIds = [...new Set(documents.map(({ document }) => document.id))];
  if (documentIds.length) {
    const placeholders = documentIds.map(() => '?').join(',');
    const stored = db.prepare(`SELECT id,requisition_id,owner_id,file_name,content_type,size_bytes,
        security_status,processing_status,detected_content_type,version,created_by,created_at,parsed_at
      FROM procurement_attachments
      WHERE tenant_id=? AND status='active'
        AND (requisition_id IN (${placeholders}) OR owner_id IN (${placeholders}))
      ORDER BY created_at,id`)
      .all(tenantId, ...documentIds, ...documentIds) as unknown as Array<{
        id: string; requisition_id: string; owner_id: string | null; file_name: string;
        content_type: string; size_bytes: number; security_status: string;
        processing_status: string; detected_content_type: string | null;
        version: number; created_by: string; created_at: string; parsed_at: string | null;
      }>;
    for (const attachment of stored) {
      const sourceDocumentId = attachment.owner_id && documentIds.includes(attachment.owner_id)
        ? attachment.owner_id
        : attachment.requisition_id;
      found.set(attachment.id, {
        id: attachment.id,
        fileName: attachment.file_name,
        contentType: attachment.content_type,
        sizeBytes: attachment.size_bytes,
        sourceDocumentId,
        metadata: true,
        securityStatus: attachment.security_status,
        processingStatus: attachment.processing_status,
        version: attachment.version,
        createdBy: attachment.created_by,
        createdAt: attachment.created_at,
        ...(attachment.parsed_at ? { parsedAt: attachment.parsed_at } : {}),
        ...(attachment.detected_content_type ? { detectedContentType: attachment.detected_content_type } : {}),
        // Only malware-scanned files receive an operational content address.
        // Pending/quarantined binaries remain visible facts but are not opened.
        ...(attachment.security_status === 'clean'
          ? { url: `/api/procurement/attachments/${encodeURIComponent(attachment.id)}/content` }
          : {}),
      });
    }
  }
  return [...found.values()].map(({ metadata: _metadata, ...attachment }) => attachment);
}

function rollback(db: DatabaseSync): void {
  try { db.exec('ROLLBACK'); } catch { /* read transaction was not active */ }
}

export async function handleProcurementWorkbenchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: WorkbenchContext,
): Promise<boolean> {
  const contextMatch = path.match(/^\/api\/procurement\/workbench\/context\/([^/]+)$/);
  if (path !== '/api/procurement/workbench' && !contextMatch) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  if (!can(context.session, 'read')) { sendJson(res, 403, { error: '当前角色无「read」权限', code: 'FORBIDDEN' }); return true; }
  if (method !== 'GET') { sendJson(res, 405, { error: `不支持的方法: ${method}`, code: 'METHOD_NOT_ALLOWED' }); return true; }

  let transactionStarted = false;
  try {
    const limit = listLimit(req);
    context.db.exec('BEGIN');
    transactionStarted = true;
    if (contextMatch) {
      let requestedId: string;
      try {
        requestedId = decodeURIComponent(contextMatch[1]!);
      } catch {
        throw new HttpError(400, '业务对象 ID 无效', 'INVALID_CONTEXT_ID');
      }
      if (!requestedId || requestedId.length > 300) throw new HttpError(400, '业务对象 ID 无效', 'INVALID_CONTEXT_ID');
      const detail = procurementContextForObject(context.db, context.session.tenantId, requestedId, context.connectorReady);
      context.db.exec('COMMIT');
      transactionStarted = false;
      if (!detail) { sendJson(res, 404, { error: '业务上下文不存在', code: 'PROCUREMENT_CONTEXT_NOT_FOUND' }); return true; }
      sendJson(res, 200, redactSensitiveValue(detail));
      return true;
    }
    const itemDocuments = documentSection(context.db, context.session.tenantId, 'item', limit);
    const suppliers = documentSection(context.db, context.session.tenantId, 'supplier', limit);
    const requisitions = documentSection(context.db, context.session.tenantId, 'requisition', limit);
    const rfqs = documentSection(context.db, context.session.tenantId, 'rfq', limit);
    const quotes = documentSection(context.db, context.session.tenantId, 'quote', limit);
    const awards = documentSection(context.db, context.session.tenantId, 'award', limit);
    const purchaseOrders = documentSection(context.db, context.session.tenantId, 'purchase_order', limit);
    const confirmations = documentSection(context.db, context.session.tenantId, 'confirmation', limit);
    const productionProgress = documentSection(context.db, context.session.tenantId, 'production_progress', limit);
    const shipments = documentSection(context.db, context.session.tenantId, 'shipment', limit);
    const receipts = documentSection(context.db, context.session.tenantId, 'receipt', limit);
    const invoices = documentSection(context.db, context.session.tenantId, 'invoice', limit);
    const matches = documentSection(context.db, context.session.tenantId, 'match', limit);
    const communications = documentSection(context.db, context.session.tenantId, 'communication', limit);
    const tasks = taskSection(context.db, context.session.tenantId, limit);
    const approvals = approvalSection(context.db, context.session.tenantId, limit);
    const executionApprovals = executionApprovalSection(context.db, context.session.tenantId, limit);
    const exceptions = exceptionSection(context.db, context.session.tenantId, limit);
    const recentActivities = activitySection(context.db, context.session.tenantId, limit);
    const contacts = contactView(context.db, context.session.tenantId, limit);
    const items = itemView(context.db, context.session.tenantId, limit);
    const inbox = inboxView(context.db, context.session.tenantId, limit);
    const alerts = alertView(context.db, context.session.tenantId, limit);
    const news = newsView(context.db, context.session.tenantId);
    const operations = procurementOperationsMetrics(context.db, context.session.tenantId, context.now?.() ?? new Date());
    const portfolio = procurementPortfolio(context.db, context.session.tenantId, context.now?.() ?? Date.now(), context.connectorReady);
    const purchaseOrdersWithSuppliers = enrichPurchaseOrdersWithSupplierNames(
      context.db,
      context.session.tenantId,
      purchaseOrders,
    );
    context.db.exec('COMMIT');
    transactionStarted = false;
    const counts = {
      items: items['total'],
      contacts: contacts['total'],
      suppliers: suppliers['total'],
      requisitions: requisitions['total'],
      rfqs: rfqs['total'],
      quotes: quotes['total'],
      awards: awards['total'],
      purchaseOrders: purchaseOrders['total'],
      confirmations: confirmations['total'],
      productionProgress: productionProgress['total'],
      shipments: shipments['total'],
      receipts: receipts['total'],
      invoices: invoices['total'],
      matches: matches['total'],
      communications: communications['total'],
      inbox: inbox['total'],
      alerts: alerts['total'],
      pendingTasks: tasks['pending'],
      pendingApprovals: approvals['pending'],
      openExceptions: exceptions['open'],
    };
    sendJson(res, 200, redactSensitiveValue({
      counts,
      documents: {
        items: itemDocuments,
        suppliers,
        requisitions,
        rfqs,
        quotes,
        awards,
        purchaseOrders: purchaseOrdersWithSuppliers,
        confirmations,
        productionProgress,
        shipments,
        receipts,
        invoices,
        matches,
        communications,
      },
      tasks,
      approvals,
      executionApprovals,
      exceptions,
      recentActivities,
      operations,
      portfolio,
      permissions: {
        operate: can(context.session, 'operate'),
        approve: can(context.session, 'approve'),
        configure: can(context.session, 'configure'),
      },
      views: { contacts, items, inbox, alerts, news },
    }));
    return true;
  } catch (error) {
    if (transactionStarted) rollback(context.db);
    if (error instanceof HttpError) { sendJson(res, error.status, { error: error.publicMessage, code: error.code }); return true; }
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (/busy|locked|timeout|timed out|超时/.test(message)) {
      sendJson(res, 503, { error: '工作台数据读取超时，请稍后重试', code: 'WORKBENCH_READ_TIMEOUT' }); return true;
    }
    sendJson(res, 503, { error: '工作台数据暂时不可用', code: 'WORKBENCH_READ_FAILED' });
    return true;
  }
}
