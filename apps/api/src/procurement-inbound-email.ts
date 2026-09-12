import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Communication, PurchaseOrder, PurchaseOrderLine } from '@readywork/core';
import { stripQuotedSupplierReply } from '@readywork/core';
import type { InboundEmail } from '@readywork/connectors';
import {
  createProcurementRepository,
  type ProcurementExecutionMutationResult,
  type VersionedProcurementDocument,
} from '@readywork/persistence';
import { refreshSlaEvaluations } from './procurement-sla.js';

const CONFIRMATION_START = '[READYWORK-CONFIRMATION]';
const CONFIRMATION_END = '[/READYWORK-CONFIRMATION]';

export interface InboundPurchaseOrderEmailInput {
  readonly gatewayInboundId?: string;
  readonly db: DatabaseSync;
  readonly tenantId: string;
  readonly provider: string;
  readonly mailbox: string;
  readonly email: InboundEmail;
  readonly poNumber: string;
  readonly actorId?: string;
  /** The production AI pipeline persists and validates sender identity before calling the model. */
  readonly deferConfirmation?: boolean;
}

export interface InboundPurchaseOrderEmailResult {
  readonly status: 'confirmation_recorded' | 'confirmation_requires_approval' | 'evidence_only' | 'already_past_commitment';
  readonly purchaseOrderId: string;
  readonly purchaseOrderNumber: string;
  readonly communicationId: string;
  readonly communicationReplayed: boolean;
  readonly confirmation?: ProcurementExecutionMutationResult;
  readonly reason?: string;
}

/**
 * Persist a supplier email as PO evidence and, only when the supplier kept the
 * complete machine-readable block, advance the durable confirmation state.
 * Free-form prose is never guessed into quantities, prices, or dates.
 */
export function ingestInboundPurchaseOrderEmail(input: InboundPurchaseOrderEmailInput): InboundPurchaseOrderEmailResult {
  const provider = requiredText(input.provider, 'provider', 100);
  const mailbox = requiredText(input.mailbox, 'mailbox', 320).toLowerCase();
  const uid = requiredText(input.email.id, 'email.id', 320);
  const from = requiredText(input.email.from, 'email.from', 500);
  const subject = requiredText(input.email.subject || '(无主题)', 'email.subject', 1_000);
  const body = boundedBody(input.email.body);
  const receivedAt = isoDate(input.email.receivedAt, 'email.receivedAt');
  const poNumber = requiredText(input.poNumber, 'poNumber', 320);
  const po = findPurchaseOrder(input.db, input.tenantId, poNumber);
  if (!po) throw new InboundPurchaseOrderEmailError('PO_NOT_FOUND', '邮件中的采购订单不存在');

  const repository = createProcurementRepository(input.db, input.tenantId);
  const messageId = normalizedMessageId(input.email.messageId);
  const inReplyTo = normalizedMessageId(input.email.inReplyTo);
  const references = [...new Set((input.email.references ?? []).map(normalizedMessageId).filter((value): value is string => Boolean(value)))];
  const identity = `${provider}\u0000${mailbox}\u0000${uid}`;
  const communicationId = `communication:inbound-email:${createHash('sha256').update(identity).digest('hex')}`;
  const payloadHash = hash({ provider, mailbox, uid, messageId, inReplyTo, references, from, subject, body, receivedAt, poId: po.document.id });
  const communication: Communication = {
    ...(input.gatewayInboundId ? {gatewayInboundId:input.gatewayInboundId}:{}),
    id: communicationId,
    tenantId: input.tenantId,
    sourceSystem: provider,
    externalId: messageId ?? `${provider}:${mailbox}:${uid}`,
    status: 'received',
    createdAt: receivedAt,
    updatedAt: receivedAt,
    businessObjectId: po.document.id,
    businessObjectType: 'purchase_order',
    supplierId: po.document.supplierId,
    channel: 'email',
    direction: 'inbound',
    provider,
    mailbox,
    uid,
    ...(messageId ? { messageId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
    from,
    subject,
    body,
    attachmentIds: [],
    occurredAt: receivedAt,
    receivedAt,
  };
  const persisted = repository.persistInboundCommunicationIdempotent({ communication, payloadHash });

  if (input.deferConfirmation) return {
    status: 'evidence_only', purchaseOrderId: po.document.id,
    purchaseOrderNumber: po.document.externalId || po.document.id,
    communicationId, communicationReplayed: persisted.replayed, reason: '等待 AI 解析供应商回信',
  };

  const parsed = parsePurchaseOrderConfirmation(body, poNumber, po.document.currency, repository.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id));
  if (!parsed.lines) {
    recordReplyEvidence(input.db, input.tenantId, po.document.id, communicationId, input.actorId ?? 'connector:email', receivedAt,
      parsed.blockFound ? 'supplier_reply_requires_review' : 'supplier_reply_received', parsed.reason);
    return {
      status: 'evidence_only',
      purchaseOrderId: po.document.id,
      purchaseOrderNumber: po.document.externalId || po.document.id,
      communicationId,
      communicationReplayed: persisted.replayed,
      reason: parsed.reason,
    };
  }

  const current = repository.getDocument<PurchaseOrder>('purchase_order', po.document.id)!;
  if (!persisted.replayed && !['sent', 'awaiting_confirmation'].includes(current.document.status)) {
    recordReplyEvidence(input.db, input.tenantId, po.document.id, communicationId, input.actorId ?? 'connector:email', receivedAt,
      'supplier_reply_received_after_commitment', `PO 当前状态为 ${current.document.status}，未重复推进承诺阶段`);
    return {
      status: 'already_past_commitment',
      purchaseOrderId: po.document.id,
      purchaseOrderNumber: po.document.externalId || po.document.id,
      communicationId,
      communicationReplayed: persisted.replayed,
      reason: `PO 当前状态为 ${current.document.status}`,
    };
  }

  const idempotencyKey = `inbound-email-confirmation:${createHash('sha256').update(identity).digest('hex')}`;
  const confirmation = repository.executeProcurementMutation({
    action: 'record_confirmation',
    idempotencyKey,
    payloadHash: hash({ poId: current.document.id, lines: parsed.lines, communicationId }),
    actorId: input.actorId ?? 'connector:email',
    permission: 'operate',
    aggregateId: current.document.id,
    expectedVersion: current.version,
    occurredAt: receivedAt,
    supplierReference: messageId ?? `${provider}:${mailbox}:${uid}`,
    lines: parsed.lines,
  });
  const publishedSla = input.db.prepare(`SELECT 1 AS ok FROM procurement_sla_policies WHERE tenant_id=? AND status='published'`).get(input.tenantId);
  if (publishedSla) refreshSlaEvaluations(input.db, input.tenantId, input.actorId ?? 'connector:email', new Date(receivedAt));
  return {
    status: confirmation.approval ? 'confirmation_requires_approval' : 'confirmation_recorded',
    purchaseOrderId: current.document.id,
    purchaseOrderNumber: current.document.externalId || current.document.id,
    communicationId,
    communicationReplayed: persisted.replayed,
    confirmation,
  };
}

/** Resolve a PO from a real outbound SMTP Message-ID when a reply subject no longer contains the PO number. */
export function resolvePurchaseOrderNumberFromEmailThread(db: DatabaseSync, tenantId: string, email: InboundEmail): string | undefined {
  const candidates = [...new Set([email.inReplyTo, ...(email.references ?? [])]
    .map(normalizedMessageId)
    .filter((value): value is string => Boolean(value)))];
  if (candidates.length === 0) return undefined;
  const placeholders = candidates.map(() => '?').join(',');
  const row = db.prepare(`SELECT d.external_id,d.id FROM procurement_outbox o
    JOIN procurement_documents d ON d.tenant_id=o.tenant_id AND d.kind='purchase_order' AND d.id=o.aggregate_id
    WHERE o.tenant_id=? AND o.channel='email' AND o.status='dispatched'
      AND json_extract(o.json,'$.connectorResult.message_id') IN (${placeholders})
    ORDER BY o.dispatched_at DESC,o.id DESC LIMIT 1`)
    .get(tenantId, ...candidates) as { external_id: string; id: string } | undefined;
  return row ? row.external_id || row.id : undefined;
}

export function buildPurchaseOrderConfirmationReplyBlock(
  poNumber: string,
  currency: string,
  lines: readonly PurchaseOrderLine[],
): string {
  const entries = lines.map((line) => {
    const promisedDate = line.requestedAt?.slice(0, 10) ?? 'YYYY-MM-DD';
    return `LINE:${line.lineNumber} | QTY:${line.orderedQty} | UNIT_PRICE:${line.unitPrice} | CURRENCY:${currency} | PROMISED_DATE:${promisedDate}`;
  });
  return [
    CONFIRMATION_START,
    `PO:${poNumber}`,
    ...entries,
    CONFIRMATION_END,
  ].join('\n');
}

export function parsePurchaseOrderConfirmation(
  body: string,
  poNumber: string,
  currency: string,
  poLines: readonly PurchaseOrderLine[],
): { blockFound: boolean; lines?: Array<{ poLineId: string; quantity: number; unitPrice: number; promisedAt: string }>; reason: string } {
  // QQ may emit HTML space entities even in its text/plain MIME part.
  // Normalize only formatting; retain the original persisted email as evidence.
  const currentReply = stripQuotedSupplierReply(body.replace(/&(?:nbsp|#160|#x0*a0|#32|#x0*20);/gi, ' ')).text;
  const replyLines = currentReply.split('\n');
  const quotedAt = replyLines.findIndex((line) => /^\s*>/.test(line) || /^\s*On\b.+\bwrote:\s*$/i.test(line));
  const reply = (quotedAt < 0 ? replyLines : replyLines.slice(0, quotedAt)).join('\n');
  // Accept a missing opening bracket only on the exact standalone marker;
  // PO identity and every required line field remain mandatory below.
  const opening = /^(?:\[)?READYWORK-CONFIRMATION\]\s*$/m.exec(reply);
  const start = opening ? opening.index + opening[0].length : -1;
  const end = start < 0 ? -1 : reply.indexOf(CONFIRMATION_END, start);
  if (start < 0 || end < 0) return { blockFound: false, reason: '邮件已关联 PO；未发现完整结构化确认块，等待人工复核' };
  const block = reply.slice(start, end).trim();
  const rows = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const poRow = rows.find((line) => /^PO\s*:/i.test(line));
  if (!poRow || poRow.slice(poRow.indexOf(':') + 1).trim().toLowerCase() !== poNumber.trim().toLowerCase()) {
    return { blockFound: true, reason: '结构化确认块中的 PO 编号与邮件路由结果不一致' };
  }
  const byLineNumber = new Map(poLines.map((line) => [line.lineNumber.trim().toLowerCase(), line]));
  const parsed: Array<{ poLineId: string; quantity: number; unitPrice: number; promisedAt: string }> = [];
  const seen = new Set<string>();
  for (const row of rows.filter((line) => /^LINE\s*:/i.test(line))) {
    const fields = new Map(row.split('|').map((part) => {
      const separator = part.indexOf(':');
      return separator < 0 ? ['', ''] : [part.slice(0, separator).trim().toUpperCase(), part.slice(separator + 1).trim()];
    }));
    const lineNumber = fields.get('LINE')?.toLowerCase() ?? '';
    const poLine = byLineNumber.get(lineNumber);
    if (!poLine || seen.has(lineNumber)) return { blockFound: true, reason: `结构化确认块包含未知或重复 PO 行：${lineNumber || '空行号'}` };
    seen.add(lineNumber);
    const quantity = Number(fields.get('QTY'));
    const unitPrice = Number(fields.get('UNIT_PRICE'));
    const lineCurrency = fields.get('CURRENCY')?.toUpperCase();
    const promisedDate = fields.get('PROMISED_DATE') ?? '';
    const promisedTime = Date.parse(promisedDate);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      return { blockFound: true, reason: `PO 行 ${poLine.lineNumber} 的数量或单价无效` };
    }
    if (lineCurrency !== currency.toUpperCase()) return { blockFound: true, reason: `PO 行 ${poLine.lineNumber} 的币种与采购订单不一致` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(promisedDate) || !Number.isFinite(promisedTime)) {
      return { blockFound: true, reason: `PO 行 ${poLine.lineNumber} 缺少有效承诺日期` };
    }
    parsed.push({ poLineId: poLine.id, quantity, unitPrice, promisedAt: new Date(`${promisedDate}T00:00:00.000Z`).toISOString() });
  }
  if (parsed.length !== poLines.length || seen.size !== byLineNumber.size) {
    return { blockFound: true, reason: '结构化确认块必须精确覆盖采购订单全部行' };
  }
  return { blockFound: true, lines: parsed, reason: '结构化确认块完整' };
}

function findPurchaseOrder(db: DatabaseSync, tenantId: string, poNumber: string): VersionedProcurementDocument<PurchaseOrder> | undefined {
  const row = db.prepare(`SELECT version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order'
      AND (lower(id)=lower(?) OR lower(external_id)=lower(?) OR lower(COALESCE(json_extract(json,'$.number'),''))=lower(?))
    ORDER BY CASE WHEN lower(external_id)=lower(?) THEN 0 ELSE 1 END,id LIMIT 1`)
    .get(tenantId, poNumber, poNumber, poNumber, poNumber) as { version: number; json: string } | undefined;
  return row ? { document: JSON.parse(row.json) as PurchaseOrder, version: row.version } : undefined;
}

function recordReplyEvidence(
  db: DatabaseSync,
  tenantId: string,
  poId: string,
  communicationId: string,
  actorId: string,
  occurredAt: string,
  eventType: string,
  reason: string,
): void {
  const eventId = `po-stage-event:email:${createHash('sha256').update(`${communicationId}:${eventType}`).digest('hex')}`;
  db.prepare(`INSERT OR IGNORE INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,'supplier_commitment',?,'active',?,'communication',?,?,?,?)`)
    .run(tenantId, eventId, poId, eventType, occurredAt, communicationId, actorId,
      JSON.stringify({ communicationId, reason, exactTransitionTime: true }), occurredAt);
}

function normalizedMessageId(value: string | undefined): string | undefined {
  if (!value || /[\r\n]/.test(value)) return undefined;
  const match = /<([^<>\s]+@[^<>\s]+)>/.exec(value.trim());
  return match ? `<${match[1]}>` : undefined;
}

function requiredText(value: string, field: string, maximum: number): string {
  const text = value.trim();
  if (!text) throw new InboundPurchaseOrderEmailError('INVALID_INBOUND_EMAIL', `${field} 必填`);
  if (text.length > maximum || /\u0000/.test(text)) throw new InboundPurchaseOrderEmailError('INVALID_INBOUND_EMAIL', `${field} 超出限制`);
  return text;
}

function boundedBody(value: string): string {
  if (value.length > 200_000 || /\u0000/.test(value)) throw new InboundPurchaseOrderEmailError('INVALID_INBOUND_EMAIL', '邮件正文超出限制');
  return value;
}

function isoDate(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new InboundPurchaseOrderEmailError('INVALID_INBOUND_EMAIL', `${field} 不是有效日期`);
  return new Date(timestamp).toISOString();
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class InboundPurchaseOrderEmailError extends Error {
  constructor(readonly code: 'INVALID_INBOUND_EMAIL' | 'PO_NOT_FOUND', message: string) {
    super(message);
    this.name = 'InboundPurchaseOrderEmailError';
  }
}
