import type { EntityId, ISODateTime } from './types.js';

// ---------------------------------------------------------------- 单据与连续行关联

export interface ProcurementDocument {
  readonly id: EntityId;
  readonly tenantId: EntityId;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly status: string;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface ProcurementLine {
  readonly id: EntityId;
  readonly lineNumber: string;
  readonly itemId: EntityId;
  readonly description?: string;
  readonly uom: string;
}

export interface Item extends ProcurementDocument {
  readonly sku: string;
  readonly name: string;
  readonly uom: string;
  readonly category?: string;
  readonly description?: string;
}

export interface SupplierContact {
  readonly id: EntityId;
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  readonly role?: string;
  readonly primary?: boolean;
}

export interface Supplier extends ProcurementDocument {
  readonly name: string;
  readonly currency: string;
  readonly contacts: readonly SupplierContact[];
  /** ERP 供应商注册/联系地址；缺失时不得根据供应商名称推测。 */
  readonly countryCode?: string;
  readonly countryName?: string;
  readonly city?: string;
  readonly street?: string;
  readonly street2?: string;
  readonly postalCode?: string;
  readonly performanceScore?: number;
}

export type RequisitionSource = 'manual' | 'erp' | 'excel';

/** 文件尚未经过安全门禁时，绝不能被当作可外发的安全文件。 */
export type ProcurementAttachmentSecurityStatus = 'pending_scan' | 'clean' | 'quarantined' | 'scan_failed';
export type ProcurementAttachmentProcessingStatus = 'not_queued' | 'queued' | 'processing' | 'parsed' | 'parse_failed' | 'needs_ocr' | 'needs_specialist';

/** 持久化文档工作项；worker 必须持有 lockToken 才能完成或失败该项。 */
export type ProcurementDocumentJobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface ProcurementDocumentJob {
  readonly id: EntityId;
  readonly tenantId: EntityId;
  readonly attachmentId: EntityId;
  readonly status: ProcurementDocumentJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: ISODateTime;
  readonly lockedAt?: ISODateTime;
  readonly lockToken?: string;
  readonly error?: string;
  /** 文档智能体输出的安全结构化 JSON；原文件仍由附件存储保管。 */
  readonly result?: Readonly<Record<string, unknown>>;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly completedAt?: ISODateTime;
}

/** 采购申请行附件的可移植元数据；文件内容由对象存储或外部系统保管。 */
export interface RequisitionAttachment {
  readonly id: EntityId;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url?: string;
  /** 服务端按原始字节计算的 SHA-256，用于审计与冻结版本。 */
  readonly sha256?: string;
  readonly version?: number;
  /** 附件字节的当前持久化后端；不暴露 bucket 或对象键。 */
  readonly storageBackend?: 'sqlite' | 's3';
  readonly requisitionLineId?: EntityId;
  readonly uploadedBy?: EntityId;
  readonly uploadedAt?: ISODateTime;
  readonly extractionStatus?: 'text_extracted' | 'ready_for_document_agent';
  readonly extractedTextPreview?: string;
  readonly securityStatus?: ProcurementAttachmentSecurityStatus;
  readonly processingStatus?: ProcurementAttachmentProcessingStatus;
  /** 由 magic bytes 或解析器识别的实际类型，不能只信任上传声明。 */
  readonly detectedContentType?: string;
  readonly scanError?: string;
  readonly parseError?: string;
  readonly parsedAt?: ISODateTime;
  readonly parsedSummary?: string;
  readonly structuredData?: Readonly<Record<string, unknown>>;
}

export interface ProcurementRequisition extends ProcurementDocument {
  readonly source: RequisitionSource;
  readonly requesterId: EntityId;
  readonly departmentId?: EntityId;
  readonly requestedAt: ISODateTime;
  readonly currency?: string;
  readonly title?: string;
  readonly requestingDepartment?: string;
  readonly requesterName?: string;
  readonly targetDeliveryDate?: ISODateTime;
}

export interface RequisitionLine extends ProcurementLine {
  readonly requisitionId: EntityId;
  readonly requestedQty: number;
  readonly requiredAt: ISODateTime;
  readonly technicalRequirements?: string;
  readonly attachmentIds: readonly EntityId[];
  readonly attachments?: readonly RequisitionAttachment[];
  readonly itemCode?: string;
  readonly itemName?: string;
}

export type CommunicationDirection = 'inbound' | 'outbound';
export type CommunicationChannel = 'email' | 'whatsapp' | 'wecom' | 'dingtalk' | 'feishu' | 'sms' | 'phone' | 'other';

/** 通讯是业务对象的证据记录，不承担聊天会话或流程状态。 */
export interface Communication extends ProcurementDocument {
  readonly gatewayInboundId?: EntityId;
  readonly businessObjectId: EntityId;
  readonly businessObjectType: string;
  readonly supplierId?: EntityId;
  readonly channel: CommunicationChannel;
  readonly direction: CommunicationDirection;
  /** RFC Message-ID when the source channel provides one. */
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  /** Provider-scoped mailbox identity used to deduplicate inbound email. */
  readonly provider?: string;
  readonly mailbox?: string;
  readonly uid?: string;
  readonly from?: string;
  readonly subject?: string;
  readonly body: string;
  readonly attachmentIds: readonly EntityId[];
  readonly occurredAt: ISODateTime;
  readonly receivedAt?: ISODateTime;
}

export interface RequestForQuotation extends ProcurementDocument {
  readonly requisitionId?: EntityId;
  readonly buyerId: EntityId;
  readonly supplierIds: readonly EntityId[];
  readonly currency: string;
  readonly quoteDueAt: ISODateTime;
  readonly title?: string;
  /** 人工确认后冻结到该 RFQ 的需求附件；不会默认外发全部文档。 */
  readonly attachmentIds?: readonly EntityId[];
  readonly attachments?: readonly RequisitionAttachment[];
  /** Points at the immutable comparison used for the current award decision. */
  readonly comparisonSnapshotId?: EntityId;
}

export interface RequestForQuotationLine extends ProcurementLine {
  readonly rfqId: EntityId;
  readonly requisitionLineId?: EntityId;
  readonly requestedQty: number;
  readonly requiredAt?: ISODateTime;
  readonly technicalRequirements?: string;
  readonly itemCode?: string;
  readonly itemName?: string;
  readonly attachmentIds?: readonly EntityId[];
  readonly attachments?: readonly RequisitionAttachment[];
}

export interface SupplierQuote extends ProcurementDocument {
  readonly rfqId: EntityId;
  readonly supplierId: EntityId;
  readonly currency: string;
  readonly validUntil?: ISODateTime;
  readonly receivedAt?: ISODateTime;
  readonly evidence?: SupplierQuoteEvidence;
}

export interface SupplierQuoteEvidence {
  readonly communicationId?: EntityId;
  readonly messageId?: string;
  readonly attachmentIds?: readonly EntityId[];
  readonly sourceChannel?: string;
}

export interface SupplierQuoteCharge {
  readonly kind: 'tooling' | 'packaging' | 'other';
  readonly amount: number;
  readonly description?: string;
}

export interface SupplierQuoteLine extends ProcurementLine {
  readonly quoteId: EntityId;
  readonly rfqLineId: EntityId;
  readonly quotedQty: number;
  readonly unitPrice: number;
  readonly promisedAt?: ISODateTime;
  readonly priceBasisQuantity?: number;
  readonly taxIncluded?: boolean;
  readonly taxRate?: number;
  readonly moq?: number;
  readonly leadTimeDays?: number;
  readonly oneTimeCharges?: readonly SupplierQuoteCharge[];
  readonly freight?: number;
  readonly paymentTerms?: string;
  readonly performanceScore?: number;
}

export type QuoteComparisonEligibility =
  | 'eligible'
  | 'moq_not_met'
  | 'quoted_quantity_insufficient'
  | 'expired'
  /** Supplier did not state whether the quoted price includes tax; never score or award it silently. */
  | 'tax_review_required';

export type QuoteTaxStatus = 'included' | 'excluded' | 'unknown';

export interface QuoteComparisonRateSnapshot {
  readonly version: string;
  readonly rates: Readonly<Record<string, number>>;
}

export interface QuoteComparisonWeightsSnapshot {
  readonly price: number;
  readonly leadTime: number;
  readonly paymentTerms: number;
  readonly performance: number;
}

/**
 * One quote-line result in an immutable comparison. IDs and quote version are
 * deliberately embedded so an award cannot be rebound to a newer quote later.
 */
export interface QuoteComparisonQuoteSnapshot {
  readonly quoteId: EntityId;
  readonly quoteVersion: number;
  readonly quoteLineId: EntityId;
  readonly supplierId: EntityId;
  readonly supplierName: string;
  readonly currency: string;
  readonly eligibility: QuoteComparisonEligibility;
  readonly reason: string;
  /** Both normalized prices are intentionally unavailable when tax status is unknown. */
  readonly unitPriceUntaxed: number | null;
  readonly unitPriceTaxIncluded: number | null;
  readonly taxStatus: QuoteTaxStatus;
  readonly taxReviewRequired: boolean;
  readonly oneTimeCharges: readonly SupplierQuoteCharge[];
  readonly freight: number;
  readonly leadTimeDays: number;
  readonly paymentTerms: string;
  readonly paymentTermsDays: number;
  readonly paymentTermsNote?: string;
  readonly performanceScore?: number;
  readonly totalCost: number | null;
  readonly scores: Readonly<{
    price?: number;
    leadTime?: number;
    paymentTerms?: number;
    performance?: number;
    total?: number;
  }>;
  readonly rank: number | null;
}

export interface QuoteComparisonLineSnapshot {
  readonly rfqLineId: EntityId;
  readonly lineNumber: string;
  readonly itemId: EntityId;
  readonly comparisonCurrency: string;
  readonly purchaseQuantity: number;
  readonly quotes: readonly QuoteComparisonQuoteSnapshot[];
  readonly recommendedSupplierId: EntityId | null;
  readonly recommendationReason: string;
  readonly ruleVersion: string;
  readonly rateSnapshotVersion: string;
}

/** Immutable, auditable input and output of a complete RFQ comparison. */
export interface QuoteComparisonSnapshot extends ProcurementDocument {
  readonly rfqId: EntityId;
  readonly rfqVersion: number;
  readonly createdBy: EntityId;
  readonly asOf: ISODateTime;
  readonly comparisonCurrency: string;
  readonly rateSnapshot: QuoteComparisonRateSnapshot;
  readonly weights: QuoteComparisonWeightsSnapshot;
  readonly ruleVersion: string;
  readonly lineComparisons: readonly QuoteComparisonLineSnapshot[];
}

export interface Award extends ProcurementDocument {
  readonly rfqId: EntityId;
  readonly approvedBy?: EntityId;
  readonly approvedAt?: ISODateTime;
}

export interface AwardLine extends ProcurementLine {
  readonly awardId: EntityId;
  readonly rfqLineId: EntityId;
  readonly quoteLineId: EntityId;
  readonly supplierId: EntityId;
  readonly awardedQty: number;
  /** Contract price per one line UOM, normalized from quotedUnitPrice/basis. */
  readonly unitPrice: number;
  readonly currency: string;
  /** Human-entered justification for selecting this quote line. */
  readonly selectionReason: string;
  readonly quotedUnitPrice?: number;
  readonly priceBasisQuantity?: number;
  readonly taxIncluded?: boolean;
  readonly taxRate?: number;
}

export interface PurchaseOrder extends ProcurementDocument {
  /** 合同价/ERP 直建 PO 时不存在 Award。 */
  readonly awardId?: EntityId;
  readonly supplierId: EntityId;
  readonly currency: string;
  readonly orderedAt: ISODateTime;
  /** Required in-house date used by the route workbench and SLA engine. */
  readonly requiredInHouseAt?: ISODateTime | null;
  /** ERP promise date mirrored after a verified external write/read receipt. */
  readonly promisedAt?: ISODateTime | null;
  /**
   * Immutable provenance for a Readywork draft created from another PO.
   * Upstream sourcing relations, ERP mappings and execution history are not
   * inherited; this snapshot exists only to audit the human duplication.
   */
  readonly duplicatedFrom?: {
    readonly purchaseOrderId: EntityId;
    readonly purchaseOrderVersion: number;
    readonly purchaseOrderNumber: string;
    readonly originalOrderedAt: ISODateTime;
    readonly duplicatedBy: EntityId;
    readonly duplicatedAt: ISODateTime;
    readonly reason: string;
  };
  /**
   * Odoo identity projected only after the durable create-draft outbox item is
   * acknowledged.  The Readywork document identity remains authoritative and
   * is deliberately kept separate from this external-system reference.
   */
  readonly odooReference?: {
    readonly id: number;
    readonly name: string;
    readonly correlationKey: string;
    readonly createdAt: ISODateTime;
  };
}

export interface PurchaseOrderLine extends ProcurementLine {
  readonly poId: EntityId;
  readonly requisitionLineId?: EntityId;
  readonly awardLineId?: EntityId;
  readonly quoteLineId?: EntityId;
  readonly rfqLineId?: EntityId;
  readonly orderedQty: number;
  /** Contract price per one line UOM, normalized from quotedUnitPrice/basis. */
  readonly unitPrice: number;
  readonly currency: string;
  readonly quotedUnitPrice?: number;
  readonly priceBasisQuantity?: number;
  readonly taxIncluded?: boolean;
  readonly taxRate?: number;
  readonly requestedAt?: ISODateTime;
}

export interface PurchaseOrderConfirmation extends ProcurementDocument {
  readonly poId: EntityId;
  readonly supplierId: EntityId;
  readonly confirmedAt: ISODateTime;
  readonly supplierReference?: string;
  readonly approvalId?: EntityId;
}

export interface PurchaseOrderConfirmationLine extends ProcurementLine {
  readonly confirmationId: EntityId;
  readonly poLineId: EntityId;
  readonly confirmedQty: number;
  readonly promisedAt?: ISODateTime;
  readonly confirmedUnitPrice?: number;
  readonly quantityVariance: number;
  readonly unitPriceVariance: number;
  readonly promisedAtVarianceDays?: number;
  readonly requiresApproval: boolean;
}

export type ProductionProgressStatus =
  | 'materials_ready'
  | 'in_production'
  | 'quality_check'
  | 'ready_to_ship'
  | 'delayed'
  | 'blocked';

/** Provenance for fulfilment facts entered by a human or extracted from a verified supplier email. */
export type ProcurementFulfilmentEvidenceSource = 'manual_verified' | 'supplier_email_ai';

/**
 * Immutable supplier fulfilment checkpoint. A Web-entered checkpoint is
 * always labelled manual_verified and never presented as connector evidence.
 */
export interface ProductionProgress extends ProcurementDocument {
  readonly poId: EntityId;
  readonly supplierId: EntityId;
  readonly reportedAt: ISODateTime;
  readonly overallStatus: ProductionProgressStatus;
  readonly evidenceSource: ProcurementFulfilmentEvidenceSource;
  readonly evidenceReference: string;
  readonly verifiedBy?: EntityId;
  readonly verificationReason?: string;
}

export interface ProductionProgressLine extends ProcurementLine {
  readonly progressId: EntityId;
  readonly poLineId: EntityId;
  readonly progressStatus: ProductionProgressStatus;
  readonly completionPercent: number;
  readonly completedQty: number;
  readonly expectedReadyAt?: ISODateTime;
  readonly note?: string;
}

export interface Shipment extends ProcurementDocument {
  readonly poId: EntityId;
  readonly supplierId: EntityId;
  readonly shippedAt: ISODateTime;
  /** Carrier or supplier-provided ETA captured with the shipment evidence. */
  readonly estimatedArrivalAt?: ISODateTime;
  readonly carrier?: string;
  readonly trackingNumber?: string;
  /** Web-entered evidence is never presented as a connector-originated fact. */
  readonly evidenceSource?: ProcurementFulfilmentEvidenceSource;
  readonly evidenceReference?: string;
  readonly verifiedBy?: EntityId;
  readonly verificationReason?: string;
}

export interface ShipmentLine extends ProcurementLine {
  readonly shipmentId: EntityId;
  readonly poLineId: EntityId;
  readonly shippedQty: number;
}

export type TransportEventCode =
  | 'picked_up'
  | 'departed_origin'
  | 'arrived_port'
  | 'customs_submitted'
  | 'customs_cleared'
  | 'customs_held'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception';

/**
 * Immutable, evidence-backed transport milestone. A carrier delivery event is
 * logistics evidence only and never substitutes for a warehouse / ERP GRN.
 */
export interface TransportEvent extends ProcurementDocument {
  readonly poId: EntityId;
  readonly shipmentId: EntityId;
  readonly eventCode: TransportEventCode;
  readonly occurredAt: ISODateTime;
  readonly location?: string;
  readonly estimatedArrivalAt?: ISODateTime;
  readonly carrierReference?: string;
  readonly note?: string;
  readonly evidenceSource: 'manual_verified';
  readonly evidenceReference: string;
  readonly verifiedBy: EntityId;
  readonly verificationReason: string;
}

export interface Receipt extends ProcurementDocument {
  readonly poId: EntityId;
  /** 无 ASN/Shipment 的直接收货允许为空。 */
  readonly shipmentId?: EntityId;
  readonly warehouseId: EntityId;
  readonly receivedAt: ISODateTime;
  /** Web-entered evidence is never presented as a connector-originated fact. */
  readonly evidenceSource?: 'manual_verified';
  readonly evidenceReference?: string;
  readonly verifiedBy?: EntityId;
  readonly verificationReason?: string;
}

export interface ReceiptLine extends ProcurementLine {
  readonly receiptId: EntityId;
  readonly poLineId: EntityId;
  readonly shipmentLineId?: EntityId;
  readonly receivedQty: number;
}

export interface SupplierInvoice extends ProcurementDocument {
  readonly supplierId: EntityId;
  readonly invoiceNumber: string;
  readonly currency: string;
  readonly invoiceDate: ISODateTime;
}

export interface SupplierInvoiceLine extends ProcurementLine {
  readonly invoiceId: EntityId;
  /** 发票刚到时可尚未完成 PO/收货关联。 */
  readonly poLineId?: EntityId;
  readonly receiptAllocations?: readonly ReceiptMatchAllocation[];
  readonly invoicedQty: number;
  readonly unitPrice: number;
  readonly netAmount: number;
  readonly currency: string;
}

/** 一条发票行对收货行的数量分配；支持同一收货行被多张部分发票逐步核销。 */
export interface ReceiptMatchAllocation {
  readonly receiptLineId: EntityId;
  readonly allocatedQty: number;
}

export interface ThreeWayMatch extends ProcurementDocument {
  readonly poId: EntityId;
  readonly invoiceId: EntityId;
  readonly result: LineMatchDisposition;
}

export interface ThreeWayMatchLine extends ProcurementLine {
  readonly matchId: EntityId;
  readonly poLineId: EntityId;
  readonly receiptAllocations: readonly ReceiptMatchAllocation[];
  readonly invoiceLineId: EntityId;
  readonly disposition: LineMatchDisposition;
  readonly variances: LineMatchVariances;
}

export type ProcurementExecutionApprovalKind = 'supplier_confirmation' | 'accounts_payable';
export type ProcurementExecutionApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ProcurementExecutionApproval {
  readonly id: EntityId;
  readonly tenantId: EntityId;
  readonly kind: ProcurementExecutionApprovalKind;
  readonly objectId: EntityId;
  readonly poId?: EntityId;
  readonly status: ProcurementExecutionApprovalStatus;
  readonly requestedBy: EntityId;
  readonly requestedAt: ISODateTime;
  readonly reason: string;
  readonly decidedBy?: EntityId;
  readonly decidedAt?: ISODateTime;
  readonly decisionReason?: string;
  /** Required evidence when a short confirmation closes the unconfirmed remainder. */
  readonly shortfallDisposition?: 'cancel_remainder';
}

export type ProcurementOutboxChannel = 'email' | 'whatsapp' | 'erp';
export type ProcurementOutboxStatus = 'pending' | 'blocked' | 'processing' | 'dispatched' | 'failed';

/** Immutable attachment identity recorded in an RFQ delivery task. */
export interface ProcurementOutboxAttachmentSnapshot {
  readonly id: EntityId;
  readonly sha256: string;
  readonly version: number;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** Durable external side effect. A pending row means queued, never delivered. */
export interface ProcurementOutboxMessage {
  readonly id: EntityId;
  readonly tenantId: EntityId;
  readonly channel: ProcurementOutboxChannel;
  readonly connectorId: string;
  readonly action: string;
  readonly aggregateId: EntityId;
  readonly idempotencyKey: string;
  readonly status: ProcurementOutboxStatus;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Delivery attempts begin at zero and increment only when a worker acquires a lease. */
  readonly attempts: number;
  readonly nextAttemptAt?: ISODateTime;
  readonly requeuedAt?: ISODateTime;
  readonly leaseOwner?: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: ISODateTime;
  readonly dispatchedAt?: ISODateTime;
  readonly failedAt?: ISODateTime;
  /** Populated only after the connector confirms delivery. */
  readonly sentAttachments?: readonly ProcurementOutboxAttachmentSnapshot[];
  /** Redacted provider acknowledgement persisted atomically with completion. */
  readonly connectorResult?: Readonly<Record<string, unknown>>;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly error?: string;
}

// ---------------------------------------------------------------- PO 行累计数量投影

export type PurchaseOrderQuantityDimension = 'confirmed' | 'shipped' | 'received' | 'invoiced' | 'cancelled';

/**
 * 不可变数量事实。delta 可为负数以表达冲销；投影规则保证任何累计值不会变成负数。
 */
export interface PurchaseOrderLineQuantityEvent {
  readonly tenantId: EntityId;
  readonly sourceSystem: string;
  readonly sourceEventId: string;
  readonly poLineId: EntityId;
  readonly dimension: PurchaseOrderQuantityDimension;
  readonly delta: number;
  readonly occurredAt: ISODateTime;
}

export interface PurchaseOrderLineQuantityProjection {
  readonly tenantId: EntityId;
  readonly poLineId: EntityId;
  readonly orderedQty: number;
  readonly confirmedQty: number;
  readonly shippedQty: number;
  readonly receivedQty: number;
  readonly invoicedQty: number;
  readonly cancelledQty: number;
  readonly events: readonly Readonly<PurchaseOrderLineQuantityEvent>[];
  readonly appliedEventKeys: readonly string[];
}

export interface QuantityProjectionResult {
  readonly projection: PurchaseOrderLineQuantityProjection;
  readonly applied: boolean;
  readonly issues: readonly PurchaseOrderLineQuantityIssue[];
}

export type PurchaseOrderLineQuantityIssueCode =
  | 'confirmed_exceeds_ordered'
  | 'shipped_exceeds_ordered'
  | 'shipped_exceeds_confirmed'
  | 'received_exceeds_ordered'
  | 'received_exceeds_shipped'
  | 'invoiced_exceeds_ordered'
  | 'invoiced_exceeds_received';

export interface PurchaseOrderLineQuantityIssue {
  readonly code: PurchaseOrderLineQuantityIssueCode;
  readonly actual: number;
  readonly reference: number;
  readonly message: string;
}

export function createPurchaseOrderLineQuantityProjection(
  line: Pick<PurchaseOrderLine, 'id' | 'orderedQty'>,
  tenantId: EntityId,
): PurchaseOrderLineQuantityProjection {
  requireNonNegativeFinite('orderedQty', line.orderedQty);
  return freezeProjection({
    tenantId,
    poLineId: line.id,
    orderedQty: line.orderedQty,
    confirmedQty: 0,
    shippedQty: 0,
    receivedQty: 0,
    invoicedQty: 0,
    cancelledQty: 0,
    events: [],
    appliedEventKeys: [],
  });
}

export function applyPurchaseOrderLineQuantityEvent(
  current: PurchaseOrderLineQuantityProjection,
  event: PurchaseOrderLineQuantityEvent,
): QuantityProjectionResult {
  if (event.tenantId !== current.tenantId) throw new Error('数量事件与 PO 行投影租户不一致');
  if (event.poLineId !== current.poLineId) throw new Error('数量事件与 PO 行不一致');
  if (!event.sourceSystem.trim() || !event.sourceEventId.trim()) throw new Error('数量事件缺少 sourceSystem 或 sourceEventId');
  if (!Number.isFinite(event.delta) || event.delta === 0) throw new Error('数量事件 delta 必须是非零有限数');

  const eventKey = quantityEventKey(event);
  if (current.appliedEventKeys.includes(eventKey)) {
    const previous = current.events.find((item) => quantityEventKey(item) === eventKey);
    if (!previous || !sameQuantityEvent(previous, event)) throw new Error('数量事件幂等键已被不同载荷使用');
    return { projection: current, applied: false, issues: deriveQuantityIssues(current) };
  }

  const field = QUANTITY_FIELDS[event.dimension];
  const candidate = { ...current, [field]: current[field] + event.delta };
  validateQuantityProjection(candidate);
  const immutableEvent = Object.freeze({ ...event });
  const projection = freezeProjection({
      ...candidate,
      events: [...current.events, immutableEvent],
      appliedEventKeys: [...current.appliedEventKeys, eventKey],
    });
  return {
    projection,
    applied: true,
    issues: deriveQuantityIssues(projection),
  };
}

const QUANTITY_FIELDS = {
  confirmed: 'confirmedQty',
  shipped: 'shippedQty',
  received: 'receivedQty',
  invoiced: 'invoicedQty',
  cancelled: 'cancelledQty',
} as const satisfies Record<PurchaseOrderQuantityDimension, keyof PurchaseOrderLineQuantityProjection>;

function quantityEventKey(event: PurchaseOrderLineQuantityEvent): string {
  return `${event.tenantId}\u0000${event.sourceSystem}\u0000${event.sourceEventId}`;
}

function sameQuantityEvent(left: PurchaseOrderLineQuantityEvent, right: PurchaseOrderLineQuantityEvent): boolean {
  return left.tenantId === right.tenantId
    && left.sourceSystem === right.sourceSystem
    && left.sourceEventId === right.sourceEventId
    && left.poLineId === right.poLineId
    && left.dimension === right.dimension
    && left.delta === right.delta
    && left.occurredAt === right.occurredAt;
}

function validateQuantityProjection(value: PurchaseOrderLineQuantityProjection): void {
  for (const [name, quantity] of Object.entries({
    orderedQty: value.orderedQty,
    confirmedQty: value.confirmedQty,
    shippedQty: value.shippedQty,
    receivedQty: value.receivedQty,
    invoicedQty: value.invoicedQty,
    cancelledQty: value.cancelledQty,
  })) requireNonNegativeFinite(name, quantity);

  if (value.cancelledQty > value.orderedQty) throw new Error('已取消累计数量不能超过订购数量');
}

/** 外部事实始终落入投影；流程倒挂和超量由此函数派生为异常，不丢弃事件。 */
export function deriveQuantityIssues(value: PurchaseOrderLineQuantityProjection): readonly PurchaseOrderLineQuantityIssue[] {
  const issues: PurchaseOrderLineQuantityIssue[] = [];
  addQuantityIssue(issues, 'confirmed_exceeds_ordered', value.confirmedQty, value.orderedQty, '确认累计数量超过订购数量');
  addQuantityIssue(issues, 'shipped_exceeds_ordered', value.shippedQty, value.orderedQty, '发运累计数量超过订购数量');
  addQuantityIssue(issues, 'shipped_exceeds_confirmed', value.shippedQty, value.confirmedQty, '发运累计数量超过确认数量');
  addQuantityIssue(issues, 'received_exceeds_ordered', value.receivedQty, value.orderedQty, '收货累计数量超过订购数量');
  addQuantityIssue(issues, 'received_exceeds_shipped', value.receivedQty, value.shippedQty, '收货累计数量超过发运数量');
  addQuantityIssue(issues, 'invoiced_exceeds_ordered', value.invoicedQty, value.orderedQty, '开票累计数量超过订购数量');
  addQuantityIssue(issues, 'invoiced_exceeds_received', value.invoicedQty, value.receivedQty, '开票累计数量超过收货数量');
  return Object.freeze(issues.map((issue) => Object.freeze(issue)));
}

function addQuantityIssue(
  issues: PurchaseOrderLineQuantityIssue[],
  code: PurchaseOrderLineQuantityIssueCode,
  actual: number,
  reference: number,
  message: string,
): void {
  if (actual > reference) issues.push({ code, actual, reference, message });
}

function freezeProjection(value: PurchaseOrderLineQuantityProjection): PurchaseOrderLineQuantityProjection {
  return Object.freeze({
    ...value,
    events: Object.freeze([...value.events]),
    appliedEventKeys: Object.freeze([...value.appliedEventKeys]),
  });
}

function requireNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} 必须是非负有限数`);
}

// ---------------------------------------------------------------- 行级三单匹配

export type LineMatchDisposition = 'exact_match' | 'within_tolerance' | 'approval_required' | 'severe_exception';

export interface MatchVariance {
  readonly expected: number;
  readonly actual: number;
  readonly difference: number;
  readonly differencePercent: number;
}

export interface CurrencyVariance {
  readonly expected: string;
  readonly actual: string;
  readonly matches: boolean;
}

export interface LineMatchVariances {
  readonly quantity: MatchVariance;
  readonly unitPrice: MatchVariance;
  readonly amount: MatchVariance;
  readonly currency: CurrencyVariance;
}

export interface LineMatchThresholds {
  readonly quantityPercent: number;
  readonly unitPricePercent: number;
  readonly amountPercent: number;
  readonly amountAbsolute: number;
}

export interface LineMatchPolicy {
  readonly tolerance: LineMatchThresholds;
  readonly approval: LineMatchThresholds;
}

export interface MatchPurchaseOrderLineInput {
  readonly poLine: PurchaseOrderLine;
  readonly receiptLines: readonly ReceiptLine[];
  readonly invoiceLine: SupplierInvoiceLine;
  readonly policy: LineMatchPolicy;
  /** 已由其他发票占用的收货数量；调用方从累计事实投影提供。 */
  readonly previouslyAllocatedQtyByReceiptLineId?: Readonly<Record<EntityId, number>>;
}

export interface LineMatchResult {
  readonly poLineId: EntityId;
  readonly receiptAllocations: readonly ReceiptMatchAllocation[];
  readonly invoiceLineId: EntityId;
  readonly disposition: LineMatchDisposition;
  readonly variances: LineMatchVariances;
}

export function matchPurchaseOrderLine(input: MatchPurchaseOrderLineInput): LineMatchResult {
  validateMatchInput(input);
  const allocatedQty = input.invoiceLine.receiptAllocations!.reduce((sum, allocation) => sum + allocation.allocatedQty, 0);
  const expectedAmount = allocatedQty * input.poLine.unitPrice;
  const variances: LineMatchVariances = {
    quantity: variance(allocatedQty, input.invoiceLine.invoicedQty),
    unitPrice: variance(input.poLine.unitPrice, input.invoiceLine.unitPrice),
    amount: variance(expectedAmount, input.invoiceLine.netAmount),
    currency: {
      expected: input.poLine.currency,
      actual: input.invoiceLine.currency,
      matches: input.poLine.currency === input.invoiceLine.currency,
    },
  };

  let disposition: LineMatchDisposition;
  if (!variances.currency.matches) disposition = 'severe_exception';
  else if (isExact(variances)) disposition = 'exact_match';
  else if (withinThresholds(variances, input.policy.tolerance)) disposition = 'within_tolerance';
  else if (withinThresholds(variances, input.policy.approval)) disposition = 'approval_required';
  else disposition = 'severe_exception';

  return Object.freeze({
    poLineId: input.poLine.id,
    receiptAllocations: Object.freeze(input.invoiceLine.receiptAllocations!.map((allocation) => Object.freeze({ ...allocation }))),
    invoiceLineId: input.invoiceLine.id,
    disposition,
    variances: Object.freeze({
      ...variances,
      quantity: Object.freeze(variances.quantity),
      unitPrice: Object.freeze(variances.unitPrice),
      amount: Object.freeze(variances.amount),
      currency: Object.freeze(variances.currency),
    }),
  });
}

function validateMatchInput(input: MatchPurchaseOrderLineInput): void {
  requireNonNegativeFinite('PO orderedQty', input.poLine.orderedQty);
  requireNonNegativeFinite('PO unitPrice', input.poLine.unitPrice);
  requireNonNegativeFinite('invoice invoicedQty', input.invoiceLine.invoicedQty);
  requireNonNegativeFinite('invoice unitPrice', input.invoiceLine.unitPrice);
  requireNonNegativeFinite('invoice netAmount', input.invoiceLine.netAmount);
  if (!input.invoiceLine.poLineId) throw new Error('发票行尚未关联 PO 行，不能执行三单匹配');
  if (input.invoiceLine.poLineId !== input.poLine.id) throw new Error('发票行未关联目标 PO 行');
  if (!input.invoiceLine.receiptAllocations?.length) throw new Error('发票行尚未分配收货数量，不能执行三单匹配');
  for (const [receiptLineId, previouslyAllocatedQty] of Object.entries(input.previouslyAllocatedQtyByReceiptLineId ?? {})) {
    if (!Number.isFinite(previouslyAllocatedQty) || previouslyAllocatedQty < 0) {
      throw new Error(`收货行 ${receiptLineId} 的历史已分配数量必须是非负有限数`);
    }
  }
  for (const receipt of input.receiptLines) {
    requireNonNegativeFinite('receipt receivedQty', receipt.receivedQty);
    if (receipt.poLineId !== input.poLine.id) throw new Error('收货行未关联目标 PO 行');
  }
  const receiptsById = new Map(input.receiptLines.map((line) => [line.id, line]));
  const allocatedByReceipt = new Map<EntityId, number>();
  for (const allocation of input.invoiceLine.receiptAllocations) {
    if (!Number.isFinite(allocation.allocatedQty) || allocation.allocatedQty <= 0) throw new Error('收货分配数量必须是正有限数');
    const receipt = receiptsById.get(allocation.receiptLineId);
    if (!receipt) throw new Error('收货分配未对应三单匹配输入中的收货行');
    allocatedByReceipt.set(allocation.receiptLineId, (allocatedByReceipt.get(allocation.receiptLineId) ?? 0) + allocation.allocatedQty);
  }
  for (const [receiptLineId, allocatedQty] of allocatedByReceipt) {
    const receivedQty = receiptsById.get(receiptLineId)!.receivedQty;
    const previouslyAllocatedQty = ownNumericValue(input.previouslyAllocatedQtyByReceiptLineId, receiptLineId) ?? 0;
    if (previouslyAllocatedQty + allocatedQty > receivedQty) throw new Error('历史已分配与本次分配数量之和不能超过该收货行实收数量');
  }
  validateThresholds('tolerance', input.policy.tolerance);
  validateThresholds('approval', input.policy.approval);
  for (const key of ['quantityPercent', 'unitPricePercent', 'amountPercent', 'amountAbsolute'] as const) {
    if (input.policy.approval[key] < input.policy.tolerance[key]) throw new Error(`approval.${key} 不能小于 tolerance.${key}`);
  }
}

function ownNumericValue(record: Readonly<Record<EntityId, number>> | undefined, key: EntityId): number | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function validateThresholds(prefix: string, value: LineMatchThresholds): void {
  requireNonNegativeFinite(`${prefix}.quantityPercent`, value.quantityPercent);
  requireNonNegativeFinite(`${prefix}.unitPricePercent`, value.unitPricePercent);
  requireNonNegativeFinite(`${prefix}.amountPercent`, value.amountPercent);
  requireNonNegativeFinite(`${prefix}.amountAbsolute`, value.amountAbsolute);
}

function variance(expected: number, actual: number): MatchVariance {
  const difference = actual - expected;
  const differencePercent = expected === 0 ? (difference === 0 ? 0 : Number.POSITIVE_INFINITY) : (difference / expected) * 100;
  return { expected, actual, difference, differencePercent };
}

function isExact(value: LineMatchVariances): boolean {
  return value.quantity.difference === 0 && value.unitPrice.difference === 0 && value.amount.difference === 0;
}

function withinThresholds(value: LineMatchVariances, thresholds: LineMatchThresholds): boolean {
  return Math.abs(value.quantity.differencePercent) <= thresholds.quantityPercent
    && Math.abs(value.unitPrice.differencePercent) <= thresholds.unitPricePercent
    && (Math.abs(value.amount.difference) <= thresholds.amountAbsolute
      || Math.abs(value.amount.differencePercent) <= thresholds.amountPercent);
}
