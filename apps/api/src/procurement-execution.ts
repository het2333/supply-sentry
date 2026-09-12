import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { analyzeSupplierReply, type SupplierReplyField } from '@readywork/core';
import {
  createProcurementRepository,
  getProcurementPurchaseOrderAmendment,
  ProcurementExecutionIdempotencyConflictError,
  ProcurementExecutionPermissionError,
  ProcurementExecutionSendInFlightError,
  ProcurementExecutionStateConflictError,
  ProcurementExecutionVersionConflictError,
  ProcurementDuplicateInvoiceError,
  ProcurementValidationError,
  type ExecutionLineInput,
  type PurchaseOrderEditPatch,
  type ProcurementExecutionAction,
  type ProcurementExecutionMutationInput,
} from '@readywork/persistence';
import { projectPurchaseOrderCancellationStatus } from '@readywork/temporal-runtime';
import { can, type Session } from './auth.js';
import { redactSensitive } from './http-errors.js';

export interface ProcurementExecutionRouteContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  /** Trusted server-side readiness. Missing callback always means unavailable. */
  readonly connectorReady?: (channel: 'email' | 'erp', connectorId: string) => boolean;
}

const ACTIONS = new Set<ProcurementExecutionAction>([
  'send_rfq', 'send_po', 'edit_po', 'cancel_po', 'duplicate_po', 'record_confirmation', 'decide_confirmation', 'queue_followup',
  'update_rihd', 'mark_at_risk',
  'record_production_progress', 'record_shipment', 'record_transport_event', 'record_receipt', 'record_invoice', 'match_invoice', 'decide_ap', 'create_odoo_po_draft',
]);

const ALLOWED_FIELDS = new Set([
  'aggregateId', 'expectedVersion', 'reason', 'evidenceReference', 'supplierId', 'supplierReference', 'warehouseId', 'shipmentId',
  'carrier', 'trackingNumber', 'estimatedArrivalAt', 'invoiceNumber', 'currency', 'invoiceDate', 'poId', 'lines',
  'requiredInHouseAt',
  'purchaseOrderNumber',
  'riskSeverity', 'riskCategory', 'recommendedAction',
  'eventCode', 'eventOccurredAt', 'eventReference', 'location', 'carrierReference',
  'matchPolicy', 'decision', 'shortfallDisposition', 'confirmationMissingFields', 'connectorId', 'patch',
]);

export async function handleProcurementExecutionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementExecutionRouteContext,
): Promise<boolean> {
  const mutation = path.match(/^\/api\/procurement\/execution\/([^/]+)$/);
  const approval = path.match(/^\/api\/procurement\/execution\/approvals\/([^/]+)$/);
  const outbox = path === '/api/procurement/execution/outbox';
  if (!mutation && !approval && !outbox) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  const repository = createProcurementRepository(context.db, context.session.tenantId);

  if (method === 'GET' && approval) {
    if (!can(context.session, 'read')) { sendJson(res, 403, { error: '无读取权限', code: 'FORBIDDEN' }); return true; }
    const item = repository.getExecutionApproval(decodeURIComponent(approval[1]!));
    if (!item) sendJson(res, 404, { error: '审批不存在', code: 'APPROVAL_NOT_FOUND' });
    else sendJson(res, 200, { approval: item });
    return true;
  }
  if (method === 'GET' && outbox) {
    if (!can(context.session, 'read')) { sendJson(res, 403, { error: '无读取权限', code: 'FORBIDDEN' }); return true; }
    sendJson(res, 200, { items: repository.listOutboxMessages() }); return true;
  }
  if (!mutation || method !== 'POST') { sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' }); return true; }

  const action = decodeURIComponent(mutation[1]!) as ProcurementExecutionAction;
  if (!ACTIONS.has(action)) { sendJson(res, 404, { error: '未知采购执行动作', code: 'EXECUTION_ACTION_NOT_FOUND' }); return true; }
  if (action === 'cancel_po' && (!can(context.session, 'operate') || !can(context.session, 'approve'))) {
    sendJson(res, 403, { error: '取消采购订单同时需要操作与审批权限', code: 'FORBIDDEN' }); return true;
  }
  const required = action === 'decide_confirmation' || action === 'decide_ap' || action === 'create_odoo_po_draft' || action === 'update_rihd'
    || action === 'record_production_progress' || action === 'record_shipment' || action === 'record_transport_event' || action === 'record_receipt' ? 'approve' : 'operate';
  if (!can(context.session, required)) { sendJson(res, 403, { error: `当前角色无「${required}」权限`, code: 'FORBIDDEN' }); return true; }

  try {
    const body = await readJsonBody(req);
    for (const key of Object.keys(body)) if (!ALLOWED_FIELDS.has(key)) throw new ApiInputError(`不允许的字段: ${key}`);
    if (action === 'create_odoo_po_draft') {
      for (const key of Object.keys(body)) if (!new Set(['aggregateId', 'expectedVersion', 'connectorId']).has(key)) {
        throw new ApiInputError(`Odoo 草稿创建不接受客户端映射字段: ${key}`);
      }
    }
    if (action === 'update_rihd') {
      for (const key of Object.keys(body)) if (!new Set(['aggregateId', 'expectedVersion', 'requiredInHouseAt', 'reason', 'connectorId']).has(key)) {
        throw new ApiInputError(`RIHD 修改不接受客户端冻结或 Odoo 映射字段: ${key}`);
      }
      if (!body['requiredInHouseAt']) throw new ApiInputError('requiredInHouseAt 必填');
      if (!body['reason']) throw new ApiInputError('修改原因必填');
    }
    if (action === 'duplicate_po') {
      for (const key of Object.keys(body)) if (!new Set(['aggregateId', 'expectedVersion', 'purchaseOrderNumber', 'requiredInHouseAt', 'reason']).has(key)) {
        throw new ApiInputError(`复制采购订单不接受上游关系、ERP 映射或执行历史字段: ${key}`);
      }
      if (!body['purchaseOrderNumber']) throw new ApiInputError('purchaseOrderNumber 必填');
      if (!body['requiredInHouseAt']) throw new ApiInputError('requiredInHouseAt 必填');
      if (!body['reason']) throw new ApiInputError('复制原因必填');
    }
    if (action === 'edit_po') {
      for (const key of Object.keys(body)) if (!new Set(['aggregateId', 'expectedVersion', 'patch', 'reason']).has(key)) {
        throw new ApiInputError(`编辑采购订单不接受冻结字段或执行事实: ${key}`);
      }
      if (!body['patch']) throw new ApiInputError('patch 必填');
      if (!body['reason']) throw new ApiInputError('修改原因必填');
    }
    if (action === 'cancel_po') {
      for (const key of Object.keys(body)) if (!new Set(['aggregateId', 'expectedVersion', 'reason']).has(key)) {
        throw new ApiInputError(`取消采购订单不接受状态、履约事实或 ERP 映射字段: ${key}`);
      }
      if (!body['reason']) throw new ApiInputError('取消原因必填');
    }
    if (action === 'mark_at_risk') {
      for (const key of Object.keys(body)) if (!new Set(['aggregateId', 'expectedVersion', 'riskSeverity', 'riskCategory', 'reason', 'recommendedAction']).has(key)) {
        throw new ApiInputError(`风险标记不接受外部副作用或状态覆盖字段: ${key}`);
      }
      if (!body['riskSeverity']) throw new ApiInputError('riskSeverity 必填');
      if (!body['riskCategory']) throw new ApiInputError('riskCategory 必填');
      if (!body['reason']) throw new ApiInputError('风险原因必填');
    }
    const key = idempotencyKey(req);
    const normalized = normalizeMutation(action, body);
    if (action === 'record_confirmation') {
      assertInboundConfirmationEvidence(
        context.db,
        context.session.tenantId,
        normalized.aggregateId,
        normalized.supplierReference,
      );
    }
    if (action === 'queue_followup' && normalized.confirmationMissingFields) {
      assertConfirmationClarificationEvidence(
        context.db,
        context.session.tenantId,
        normalized.aggregateId,
        normalized.supplierReference,
        normalized.confirmationMissingFields,
      );
    }
    if (action === 'record_shipment' || action === 'record_receipt') {
      if (!normalized.supplierReference) throw new ApiInputError(action === 'record_shipment' ? 'ASN / 发运单号必填' : 'GRN / 收货单号必填');
      if (!normalized.evidenceReference) throw new ApiInputError('人工核验依据必填');
      if (!normalized.reason) throw new ApiInputError('人工核验原因必填');
    }
    if (action === 'record_transport_event') {
      if (!normalized.shipmentId) throw new ApiInputError('关联 Shipment 必填');
      if (!normalized.eventReference) throw new ApiInputError('运输节点证据编号必填');
      if (!normalized.eventOccurredAt) throw new ApiInputError('运输节点发生时间必填');
      if (!normalized.eventCode) throw new ApiInputError('运输节点类型必填');
      if (!normalized.evidenceReference) throw new ApiInputError('人工核验依据必填');
      if (!normalized.reason) throw new ApiInputError('人工核验原因必填');
    }
    if (action === 'record_production_progress') {
      if (!normalized.supplierReference) throw new ApiInputError('生产进度证据编号必填');
      if (!normalized.evidenceReference) throw new ApiInputError('人工核验依据必填');
      if (!normalized.reason) throw new ApiInputError('人工核验原因必填');
    }
    const erpAction = action === 'decide_ap' || action === 'create_odoo_po_draft' || action === 'update_rihd' || action === 'edit_po' || action === 'cancel_po';
    const emailAction = action === 'send_rfq' || action === 'send_po' || action === 'queue_followup';
    const connectorId = normalized.connectorId ?? (erpAction ? 'erp' : emailAction ? 'email' : undefined);
    const channel = erpAction ? 'erp' : 'email';
    if ((action === 'send_rfq' || action === 'send_po' || action === 'queue_followup') && connectorId !== 'email') throw new ApiInputError('邮件副作用只允许使用 email 连接器');
    if (action === 'decide_ap' && connectorId !== 'erp') throw new ApiInputError('ERP 回写只允许使用 erp 连接器');
    if (action === 'create_odoo_po_draft' && connectorId !== 'erp') throw new ApiInputError('Odoo 草稿创建只允许使用 erp 连接器');
    if (action === 'update_rihd' && connectorId !== 'erp') throw new ApiInputError('RIHD 修改只允许使用 erp 连接器');
    const connectorReady = emailAction || erpAction
      ? context.connectorReady?.(channel, connectorId!) === true
      : undefined;
    const input: ProcurementExecutionMutationInput = {
      ...normalized, action, idempotencyKey: key,
      payloadHash: hash({ action, actorId: context.session.humanId, ...normalized }),
      actorId: context.session.humanId, permission: action === 'cancel_po' ? 'operate_and_approve' : required,
      occurredAt: new Date().toISOString(), ...(connectorId ? { connectorId } : {}), ...(connectorReady === undefined ? {} : { connectorReady }),
      ...((action === 'record_production_progress' || action === 'record_shipment' || action === 'record_transport_event' || action === 'record_receipt') ? { evidenceSource: 'manual_verified' as const } : {}),
    };
    const result = repository.executeProcurementMutation(input);
    if (action === 'cancel_po') {
      const current = repository.getDocument('purchase_order', normalized.aggregateId);
      const amendment = result.amendment
        ? getProcurementPurchaseOrderAmendment(context.db, context.session.tenantId, result.amendment.id)
        : null;
      sendJson(res, result.replayed ? 200 : 201, {
        requestId: result.requestId ?? amendment?.id,
        status: projectPurchaseOrderCancellationStatus({
          source: amendment ? 'odoo' : 'local',
          purchaseOrderStatus: current?.document.status ?? result.aggregate.document.status,
          ...(amendment ? { amendmentState: amendment.state } : {}),
        }),
        purchaseOrderVersion: current?.version ?? result.aggregate.version,
        outboxId: result.outbox?.id ?? amendment?.outboxId ?? null,
      });
      return true;
    }
    sendJson(res, result.replayed ? 200 : 201, result);
    return true;
  } catch (error) {
    if (error instanceof ApiInputError) { sendJson(res, 422, { error: error.message, code: 'INVALID_EXECUTION_INPUT' }); return true; }
    if (error instanceof ProcurementExecutionPermissionError) { sendJson(res, 403, { error: error.message, code: error.code }); return true; }
    if (error instanceof ProcurementExecutionIdempotencyConflictError || error instanceof ProcurementExecutionVersionConflictError || error instanceof ProcurementExecutionStateConflictError || error instanceof ProcurementExecutionSendInFlightError) {
      sendJson(res, 409, {
        error: redactSensitive(error), code: error.code,
        ...(error instanceof ProcurementExecutionVersionConflictError ? { currentVersion: error.actualVersion } : {}),
      }); return true;
    }
    if (error instanceof ProcurementDuplicateInvoiceError) { sendJson(res, 409, { error: error.message, code: error.code }); return true; }
    if (error instanceof ProcurementValidationError) {
      sendJson(res, error.code === 'DUPLICATE_PO_NUMBER' ? 409 : error.code === 'PO_NOT_FOUND' ? 404 : 422, { error: redactSensitive(error), code: error.code });
      return true;
    }
    if (error instanceof Error && /UNIQUE constraint failed.*invoiceNumber|uq_procurement_invoice_number/.test(error.message)) {
      sendJson(res, 409, { error: '发票号已存在', code: 'DUPLICATE_INVOICE' }); return true;
    }
    throw error;
  }
}

function normalizeMutation(action: ProcurementExecutionAction, body: Record<string, unknown>): Omit<ProcurementExecutionMutationInput, 'action' | 'idempotencyKey' | 'payloadHash' | 'actorId' | 'permission' | 'occurredAt' | 'connectorReady'> {
  const aggregateId = text(body['aggregateId'], 'aggregateId');
  const expectedVersion = positiveInteger(body['expectedVersion'], 'expectedVersion');
  const lines = body['lines'] === undefined ? undefined : normalizeLines(body['lines'], action);
  const decision = body['decision'];
  if (decision !== undefined && decision !== 'approved' && decision !== 'rejected') throw new ApiInputError('decision 必须为 approved 或 rejected');
  const shortfallDisposition = body['shortfallDisposition'];
  if (shortfallDisposition !== undefined && shortfallDisposition !== 'cancel_remainder') {
    throw new ApiInputError('shortfallDisposition 必须为 cancel_remainder');
  }
  if (shortfallDisposition !== undefined && (action !== 'decide_confirmation' || decision !== 'approved')) {
    throw new ApiInputError('shortfallDisposition 只允许用于批准供应商短交确认');
  }
  const confirmationMissingFields = normalizeConfirmationMissingFields(body['confirmationMissingFields'], action);
  const matchPolicy = body['matchPolicy'];
  if (matchPolicy !== undefined && !isRecord(matchPolicy)) throw new ApiInputError('matchPolicy 必须是对象');
  const eventCode = body['eventCode'];
  const allowedEventCodes = new Set(['picked_up', 'departed_origin', 'arrived_port', 'customs_submitted', 'customs_cleared', 'customs_held', 'out_for_delivery', 'delivered', 'exception']);
  if (eventCode !== undefined && (typeof eventCode !== 'string' || !allowedEventCodes.has(eventCode))) throw new ApiInputError('eventCode 不是允许的运输节点');
  const riskSeverity = body['riskSeverity'];
  if (riskSeverity !== undefined && riskSeverity !== 'medium' && riskSeverity !== 'high' && riskSeverity !== 'critical') {
    throw new ApiInputError('riskSeverity 必须为 medium、high 或 critical');
  }
  const riskCategory = body['riskCategory'];
  const allowedRiskCategories = new Set(['supplier_response', 'schedule', 'production', 'logistics', 'quality', 'commercial', 'compliance', 'other']);
  if (riskCategory !== undefined && (typeof riskCategory !== 'string' || !allowedRiskCategories.has(riskCategory))) {
    throw new ApiInputError('riskCategory 不是允许的采购风险类别');
  }
  return {
    aggregateId, expectedVersion,
    ...(body['reason'] === undefined ? {} : { reason: text(body['reason'], 'reason') }),
    ...(body['evidenceReference'] === undefined ? {} : { evidenceReference: text(body['evidenceReference'], 'evidenceReference') }),
    ...(body['supplierId'] === undefined ? {} : { supplierId: text(body['supplierId'], 'supplierId') }),
    ...(body['supplierReference'] === undefined ? {} : { supplierReference: text(body['supplierReference'], 'supplierReference') }),
    ...(body['warehouseId'] === undefined ? {} : { warehouseId: text(body['warehouseId'], 'warehouseId') }),
    ...(body['shipmentId'] === undefined ? {} : { shipmentId: text(body['shipmentId'], 'shipmentId') }),
    ...(body['carrier'] === undefined ? {} : { carrier: text(body['carrier'], 'carrier') }),
    ...(body['trackingNumber'] === undefined ? {} : { trackingNumber: text(body['trackingNumber'], 'trackingNumber') }),
    ...(body['estimatedArrivalAt'] === undefined ? {} : { estimatedArrivalAt: date(body['estimatedArrivalAt'], 'estimatedArrivalAt') }),
    ...(body['requiredInHouseAt'] === undefined ? {} : { requiredInHouseAt: date(body['requiredInHouseAt'], 'requiredInHouseAt') }),
    ...(body['purchaseOrderNumber'] === undefined ? {} : { purchaseOrderNumber: text(body['purchaseOrderNumber'], 'purchaseOrderNumber') }),
    ...(riskSeverity === undefined ? {} : { riskSeverity: riskSeverity as NonNullable<ProcurementExecutionMutationInput['riskSeverity']> }),
    ...(riskCategory === undefined ? {} : { riskCategory: riskCategory as NonNullable<ProcurementExecutionMutationInput['riskCategory']> }),
    ...(body['recommendedAction'] === undefined ? {} : { recommendedAction: text(body['recommendedAction'], 'recommendedAction') }),
    ...(eventCode === undefined ? {} : { eventCode: eventCode as ProcurementExecutionMutationInput['eventCode'] }),
    ...(body['eventOccurredAt'] === undefined ? {} : { eventOccurredAt: date(body['eventOccurredAt'], 'eventOccurredAt') }),
    ...(body['eventReference'] === undefined ? {} : { eventReference: text(body['eventReference'], 'eventReference') }),
    ...(body['location'] === undefined ? {} : { location: text(body['location'], 'location') }),
    ...(body['carrierReference'] === undefined ? {} : { carrierReference: text(body['carrierReference'], 'carrierReference') }),
    ...(body['invoiceNumber'] === undefined ? {} : { invoiceNumber: text(body['invoiceNumber'], 'invoiceNumber') }),
    ...(body['currency'] === undefined ? {} : { currency: text(body['currency'], 'currency').toUpperCase() }),
    ...(body['invoiceDate'] === undefined ? {} : { invoiceDate: date(body['invoiceDate'], 'invoiceDate') }),
    ...(body['poId'] === undefined ? {} : { poId: text(body['poId'], 'poId') }),
    ...(body['connectorId'] === undefined ? {} : { connectorId: text(body['connectorId'], 'connectorId') }),
    ...(lines ? { lines } : {}), ...(decision ? { decision } : {}),
    ...(shortfallDisposition ? { shortfallDisposition } : {}),
    ...(confirmationMissingFields ? { confirmationMissingFields } : {}),
    ...(matchPolicy ? { matchPolicy: matchPolicy as unknown as ProcurementExecutionMutationInput['matchPolicy'] } : {}),
    ...(body['patch'] === undefined ? {} : { patch: normalizeEditPatch(body['patch']) }),
  };
}

function normalizeEditPatch(value: unknown): PurchaseOrderEditPatch {
  if (!isRecord(value)) throw new ApiInputError('patch 必须是对象');
  const allowed = new Set(['supplierId', 'requiredInHouseAt', 'materialType', 'contactId', 'lines']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ApiInputError(`patch 不允许字段: ${key}`);
  if (Object.keys(value).length === 0) throw new ApiInputError('patch 至少包含一个允许字段');
  const materialType = value['materialType'];
  if (materialType !== undefined && materialType !== 'direct' && materialType !== 'indirect') {
    throw new ApiInputError('patch.materialType 必须为 direct 或 indirect');
  }
  const contactId = value['contactId'];
  if (contactId !== undefined && contactId !== null && (typeof contactId !== 'string' || !contactId.trim())) {
    throw new ApiInputError('patch.contactId 必须为联系人 ID 或 null');
  }
  const lines = value['lines'];
  if (lines !== undefined && (!Array.isArray(lines) || lines.length === 0)) throw new ApiInputError('patch.lines 必须是非空数组');
  const normalizedLines = lines === undefined ? undefined : lines.map((line, index) => {
    if (!isRecord(line)) throw new ApiInputError(`patch.lines[${index}] 必须是对象`);
    const lineAllowed = new Set(['id', 'itemCode', 'description', 'quantity', 'unit', 'unitPrice', 'taxRate']);
    for (const key of Object.keys(line)) if (!lineAllowed.has(key)) throw new ApiInputError(`patch.lines[${index}] 不允许字段: ${key}`);
    const unitPrice = line['unitPrice']; const taxRate = line['taxRate'];
    if (unitPrice !== null && (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice < 0)) throw new ApiInputError(`patch.lines[${index}].unitPrice 必须为非负有限数或 null`);
    if (taxRate !== null && (typeof taxRate !== 'number' || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1)) throw new ApiInputError(`patch.lines[${index}].taxRate 必须为 0 到 1 的有限数或 null`);
    return { id: text(line['id'], `patch.lines[${index}].id`), itemCode: text(line['itemCode'], `patch.lines[${index}].itemCode`),
      description: text(line['description'], `patch.lines[${index}].description`), quantity: positiveNumber(line['quantity'], `patch.lines[${index}].quantity`),
      unit: text(line['unit'], `patch.lines[${index}].unit`), unitPrice: unitPrice as number | null, taxRate: taxRate as number | null };
  });
  return {
    ...(value['supplierId'] === undefined ? {} : { supplierId: text(value['supplierId'], 'patch.supplierId') }),
    ...(value['requiredInHouseAt'] === undefined ? {} : { requiredInHouseAt: date(value['requiredInHouseAt'], 'patch.requiredInHouseAt') }),
    ...(materialType === undefined ? {} : { materialType }),
    ...(contactId === undefined ? {} : { contactId: contactId === null ? null : contactId.trim() }),
    ...(normalizedLines === undefined ? {} : { lines: normalizedLines }),
  };
}

function normalizeConfirmationMissingFields(value: unknown, action: ProcurementExecutionAction): SupplierReplyField[] | undefined {
  if (value === undefined) return undefined;
  if (action !== 'queue_followup') throw new ApiInputError('confirmationMissingFields 只允许用于供应商确认补充草稿');
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new ApiInputError('confirmationMissingFields 必须包含 1–2 个缺失确认字段');
  }
  const allowed = new Set<SupplierReplyField>(['quantity', 'unit_price', 'promised_date']);
  const fields = value.map((field, index) => {
    if (typeof field !== 'string' || !allowed.has(field as SupplierReplyField)) {
      throw new ApiInputError(`confirmationMissingFields[${index}] 不是允许的确认字段`);
    }
    return field as SupplierReplyField;
  });
  if (new Set(fields).size !== fields.length) throw new ApiInputError('confirmationMissingFields 不能重复');
  return fields;
}

function normalizeLines(value: unknown, action: ProcurementExecutionAction): ExecutionLineInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new ApiInputError('lines 必须是非空数组');
  const lines = value.map((entry, index) => {
    if (!isRecord(entry)) throw new ApiInputError(`lines[${index}] 必须是对象`);
    const allowed = new Set(['poLineId', 'quantity', 'unitPrice', 'promisedAt', 'receiptAllocations', 'netAmount', 'currency',
      'progressStatus', 'completionPercent', 'expectedReadyAt', 'note']);
    for (const key of Object.keys(entry)) if (!allowed.has(key)) throw new ApiInputError(`lines[${index}] 包含不允许字段 ${key}`);
    const allocations = entry['receiptAllocations'];
    if (allocations !== undefined && !Array.isArray(allocations)) throw new ApiInputError(`lines[${index}].receiptAllocations 必须是数组`);
    const progressStatus = entry['progressStatus'];
    const allowedProgress = new Set(['materials_ready', 'in_production', 'quality_check', 'ready_to_ship', 'delayed', 'blocked']);
    if (progressStatus !== undefined && (typeof progressStatus !== 'string' || !allowedProgress.has(progressStatus))) {
      throw new ApiInputError(`lines[${index}].progressStatus 不是允许的生产进度状态`);
    }
    const completionPercent = entry['completionPercent'];
    if (completionPercent !== undefined && (typeof completionPercent !== 'number' || !Number.isFinite(completionPercent) || completionPercent < 0 || completionPercent > 100)) {
      throw new ApiInputError(`lines[${index}].completionPercent 必须是 0 到 100 的有限数`);
    }
    if (action !== 'record_production_progress' && (progressStatus !== undefined || completionPercent !== undefined || entry['expectedReadyAt'] !== undefined || entry['note'] !== undefined)) {
      throw new ApiInputError(`lines[${index}] 的生产进度字段只允许用于 record_production_progress`);
    }
    return {
      poLineId: text(entry['poLineId'], `lines[${index}].poLineId`),
      quantity: action === 'record_production_progress'
        ? nonNegativeNumber(entry['quantity'], `lines[${index}].quantity`)
        : positiveNumber(entry['quantity'], `lines[${index}].quantity`),
      ...(entry['unitPrice'] === undefined ? {} : { unitPrice: nonNegativeNumber(entry['unitPrice'], `lines[${index}].unitPrice`) }),
      ...(entry['netAmount'] === undefined ? {} : { netAmount: nonNegativeNumber(entry['netAmount'], `lines[${index}].netAmount`) }),
      ...(entry['promisedAt'] === undefined ? {} : { promisedAt: date(entry['promisedAt'], `lines[${index}].promisedAt`) }),
      ...(entry['currency'] === undefined ? {} : { currency: text(entry['currency'], `lines[${index}].currency`).toUpperCase() }),
      ...(progressStatus === undefined ? {} : { progressStatus: progressStatus as ExecutionLineInput['progressStatus'] }),
      ...(completionPercent === undefined ? {} : { completionPercent }),
      ...(entry['expectedReadyAt'] === undefined ? {} : { expectedReadyAt: date(entry['expectedReadyAt'], `lines[${index}].expectedReadyAt`) }),
      ...(entry['note'] === undefined ? {} : { note: text(entry['note'], `lines[${index}].note`) }),
      ...(allocations === undefined ? {} : { receiptAllocations: allocations.map((item, allocationIndex) => {
        if (!isRecord(item)) throw new ApiInputError(`receiptAllocations[${allocationIndex}] 必须是对象`);
        return { receiptLineId: text(item['receiptLineId'], 'receiptLineId'), allocatedQty: positiveNumber(item['allocatedQty'], 'allocatedQty') };
      }) }),
    };
  });
  if (new Set(lines.map((line) => line.poLineId)).size !== lines.length) throw new ApiInputError('poLineId 不能重复');
  return lines;
}

function idempotencyKey(req: IncomingMessage): string {
  const value = req.headers['idempotency-key'];
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.trim().length > 200) throw new ApiInputError('Idempotency-Key 必填');
  return candidate.trim();
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += String(chunk); if (raw.length > 1_000_000) throw new ApiInputError('请求体过大'); }
  try { const value = JSON.parse(raw || '{}'); if (!isRecord(value)) throw new Error(); return value; }
  catch { throw new ApiInputError('请求体必须是 JSON 对象'); }
}

function hash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`; if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function safeJson(value: string): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : null; }
  catch { return null; }
}
function assertInboundConfirmationEvidence(
  db: DatabaseSync,
  tenantId: string,
  purchaseOrderId: string,
  communicationId: string | undefined,
): void {
  trustedInboundConfirmationEvidence(db, tenantId, purchaseOrderId, communicationId);
}

function trustedInboundConfirmationEvidence(
  db: DatabaseSync,
  tenantId: string,
  purchaseOrderId: string,
  communicationId: string | undefined,
): { communication: Record<string, unknown>; purchaseOrder: Record<string, unknown> } {
  if (!communicationId) throw new ApiInputError('必须选择一封已关联当前 PO 的供应商入站回复作为确认依据');
  const communicationRow = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='communication' AND id=?`).get(tenantId, communicationId) as { json: string } | undefined;
  const purchaseOrderRow = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, purchaseOrderId) as { json: string } | undefined;
  const communication = communicationRow ? safeJson(communicationRow.json) : null;
  const purchaseOrder = purchaseOrderRow ? safeJson(purchaseOrderRow.json) : null;
  if (!communication || !purchaseOrder
    || communication['businessObjectType'] !== 'purchase_order'
    || communication['businessObjectId'] !== purchaseOrderId
    || communication['direction'] !== 'inbound'
    || communication['status'] !== 'received'
    || typeof communication['supplierId'] !== 'string'
    || communication['supplierId'] !== purchaseOrder['supplierId']) {
    throw new ApiInputError('所选供应商回复不是当前 PO 与供应商的可信入站证据');
  }
  return { communication, purchaseOrder };
}

function assertConfirmationClarificationEvidence(
  db: DatabaseSync,
  tenantId: string,
  purchaseOrderId: string,
  communicationId: string | undefined,
  requestedMissingFields: readonly SupplierReplyField[],
): void {
  const { communication } = trustedInboundConfirmationEvidence(db, tenantId, purchaseOrderId, communicationId);
  const lines = (db.prepare(`SELECT json FROM procurement_lines
    WHERE tenant_id=? AND kind='purchase_order_line' AND document_id=? ORDER BY line_number,id`)
    .all(tenantId, purchaseOrderId) as Array<{ json: string }>)
    .map((row) => safeJson(row.json))
    .filter((line): line is Record<string, unknown> => Boolean(line));
  const body = communication['body'];
  if (typeof body !== 'string' || !body.trim() || lines.length === 0) {
    throw new ApiInputError('所选回复没有可复核正文或当前 PO 缺少行项目');
  }
  const analysis = analyzeSupplierReply({
    communication: {
      id: communicationId,
      body,
      ...(typeof communication['receivedAt'] === 'string' ? { receivedAt: communication['receivedAt'] } : {}),
    },
    poLines: lines.map((line, index) => ({
      poLineId: typeof line['id'] === 'string' ? line['id'] : `line:${index + 1}`,
      orderedQty: typeof line['orderedQty'] === 'number' ? line['orderedQty'] : Number.NaN,
      poUnitPrice: typeof line['unitPrice'] === 'number' ? line['unitPrice'] : null,
      requestedAt: typeof line['requestedAt'] === 'string' ? line['requestedAt'] : null,
      description: typeof line['description'] === 'string' ? line['description'] : undefined,
      itemId: typeof line['itemId'] === 'string' ? line['itemId'] : undefined,
      uom: typeof line['uom'] === 'string' ? line['uom'] : undefined,
    })),
  });
  const expected = [...analysis.missingFields].sort();
  const requested = [...requestedMissingFields].sort();
  if (analysis.reliableSuggestionCount === 0 || expected.length === 0 || expected.length > 2
    || expected.join('|') !== requested.join('|')) {
    throw new ApiInputError('confirmationMissingFields 与所选真实回复的确定性解析结果不一致');
  }
}
function text(value: unknown, field: string): string { if (typeof value !== 'string' || !value.trim()) throw new ApiInputError(`${field} 必填`); return value.trim(); }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new ApiInputError(`${field} 必须是正整数`); return value as number; }
function positiveNumber(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new ApiInputError(`${field} 必须大于 0`); return value; }
function nonNegativeNumber(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ApiInputError(`${field} 必须是非负有限数`); return value; }
function date(value: unknown, field: string): string { const result = text(value, field); const time = Date.parse(result); if (!Number.isFinite(time)) throw new ApiInputError(`${field} 必须是有效日期`); return new Date(time).toISOString(); }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
class ApiInputError extends Error {}
