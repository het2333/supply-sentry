import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type {
  Award,
  AwardLine,
  Communication,
  ProcurementRequisition,
  PurchaseOrder,
  PurchaseOrderLine,
  QuoteComparisonSnapshot,
  RequisitionAttachment,
  RequisitionLine,
  RequestForQuotation,
  RequestForQuotationLine,
  Supplier,
  SupplierOperatingProfile,
  SupplierQuote,
  SupplierQuoteCharge,
  SupplierQuoteEvidence,
  SupplierQuoteLine,
} from '@readywork/core';
import { SupplierOperatingProfileValidationError, validateSupplierOperatingProfile } from '@readywork/core';
import type { OdooSupplierMasterResult } from '@readywork/connectors';
import {
  createProcurementRepository,
  createProcurementSupplierOperatingProfile,
  getProcurementSupplierOperatingProfile,
  listProcurementSupplierOperatingProfileEvents,
  updateProcurementSupplierOperatingProfile,
  ProcurementAwardIdempotencyConflictError,
  ProcurementCreateIdempotencyConflictError,
  ProcurementInboundCommunicationIdempotencyConflictError,
  ProcurementQuoteComparisonIdempotencyConflictError,
  ProcurementQuoteVersionConflictError,
  ProcurementRfqAlreadyAwardedError,
  ProcurementRfqStateConflictError,
  ProcurementRfqVersionConflictError,
  ProcurementSupplierOperatingProfileVersionConflictError,
  ProcurementValidationError,
  SupplierSyncIdempotencyConflictError,
  type ProcurementRepository,
  type SupplierSyncResult,
} from '@readywork/persistence';
import {
  compareSupplierQuotes,
  type ExchangeRateSnapshot,
  type QuoteComparisonWeights,
  type QuoteInput,
} from '@readywork/supply-chain';
import { can, type Session } from './auth.js';
import { HttpError, publicIntegrationError, redactSensitive, redactSensitiveValue } from './http-errors.js';

interface RouteContext { readonly db: DatabaseSync; readonly session: Session | null; readonly supplierMasterProvider?: () => Promise<OdooSupplierMasterResult> }
interface SupplierSyncIssue { row: number; reason: string }

interface NormalizedRfq {
  requisitionId: string;
  title: string;
  quoteDueAt: string;
  currency: string;
  supplierIds: string[];
  attachmentIds: string[];
  sourceSystem: string;
  externalId?: string;
}

interface NormalizedQuoteLine {
  rfqLineId: string;
  unitPrice: number;
  priceBasisQuantity: number;
  quotedQuantity: number;
  uom: string;
  taxIncluded?: boolean;
  taxRate?: number;
  moq?: number;
  promisedAt?: string;
  leadTimeDays: number;
  oneTimeCharges: SupplierQuoteCharge[];
  freight?: number;
  paymentTerms: string;
}

interface NormalizedQuote {
  supplierId: string;
  receivedAt: string;
  validUntil: string;
  currency: string;
  evidence?: SupplierQuoteEvidence;
  sourceSystem: string;
  externalId?: string;
  lines: NormalizedQuoteLine[];
}

interface NormalizedManualSupplier {
  name: string;
  currency: string;
  primaryContact: { name: string; email: string; phone?: string };
  externalId?: string;
  operatingProfile?: Omit<SupplierOperatingProfile, 'supplierId' | 'version'>;
}

class SupplierVersionConflictError extends Error {
  constructor(readonly currentVersion: number, readonly currentProfileVersion: number) {
    super('供应商或经营档案已被其他人更新');
    this.name = 'SupplierVersionConflictError';
  }
}

interface NormalizedInboundEmail {
  provider?: string;
  mailbox?: string;
  uid?: string;
  messageId?: string;
  from: string;
  subject?: string;
  body: string;
  receivedAt: string;
  channel: 'email';
  supplierId: string;
}

interface QuoteComparisonInput extends QuoteInput {
  quoteId: string;
  quoteLineId: string;
  quoteVersion: number;
}

interface AwardSelection {
  rfqLineId: string;
  quoteLineId: string;
  awardedQuantity: number;
}

interface NormalizedAward {
  expectedRfqVersion: number;
  comparisonSnapshotId: string;
  reason: string;
  selections: AwardSelection[];
}


function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1_048_576) throw new HttpError(413, '请求体超过 1 MB 限制', 'BODY_TOO_LARGE');
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { throw new HttpError(400, '请求体不是有效 JSON', 'INVALID_JSON'); }
  if (!isRecord(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象', 'INVALID_BODY');
  return parsed;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(422, `${field} 必填`, 'INVALID_PROCUREMENT_INPUT');
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, field);
}

function date(value: unknown, field: string): string {
  const input = text(value, field);
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) throw new HttpError(422, `${field} 必须是有效日期`, 'INVALID_PROCUREMENT_INPUT');
  return new Date(timestamp).toISOString();
}

function numberValue(value: unknown, field: string, options: { positive?: boolean; max?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(422, `${field} 必须是有限数`, 'INVALID_PROCUREMENT_INPUT');
  if (options.positive ? value <= 0 : value < 0) throw new HttpError(422, `${field} ${options.positive ? '必须大于 0' : '不能为负数'}`, 'INVALID_PROCUREMENT_INPUT');
  if (options.max !== undefined && value > options.max) throw new HttpError(422, `${field} 不能超过 ${options.max}`, 'INVALID_PROCUREMENT_INPUT');
  return value;
}

function idempotencyKey(req: IncomingMessage, body: Record<string, unknown>): string {
  const header = req.headers['idempotency-key'];
  const candidate = (Array.isArray(header) ? header[0] : header) ?? body['idempotencyKey'];
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.trim().length > 200) {
    throw new HttpError(400, 'Idempotency-Key 必填且不能超过 200 个字符', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  return candidate.trim();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function supplierSyncPayload(body: Record<string, unknown>): Record<string, unknown> {
  const { idempotencyKey: _idempotencyKey, ...payload } = body;
  return payload;
}

function email(value: unknown, field: string): string {
  const input = text(value, field);
  // This intentionally small check rejects malformed addresses without trying to
  // implement the full (and surprising) RFC grammar.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
    throw new HttpError(422, `${field} 必须是合法邮箱`, 'INVALID_PROCUREMENT_INPUT');
  }
  return input;
}

function normalizeManualSupplier(body: Record<string, unknown>): NormalizedManualSupplier {
  const currency = text(body['currency'], 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(422, 'currency 必须是 3 位货币代码', 'INVALID_PROCUREMENT_INPUT');
  if (!isRecord(body['primaryContact'])) throw new HttpError(422, 'primaryContact 必填且必须是对象', 'INVALID_PROCUREMENT_INPUT');
  const contact = body['primaryContact'];
  const normalized: NormalizedManualSupplier = {
    name: text(body['name'], 'name'),
    currency,
    primaryContact: {
      name: text(contact['name'], 'primaryContact.name'),
      email: email(contact['email'], 'primaryContact.email'),
      ...(contact['phone'] === undefined || contact['phone'] === null ? {} : { phone: text(contact['phone'], 'primaryContact.phone') }),
    },
    ...(body['externalId'] === undefined || body['externalId'] === null ? {} : { externalId: text(body['externalId'], 'externalId') }),
  };
  if (body['operatingProfile'] !== undefined) {
    const profile = normalizeOperatingProfile(body['operatingProfile'], 'supplier:pending', null);
    const { supplierId: _supplierId, version: _version, ...fields } = profile;
    normalized.operatingProfile = fields;
  }
  return normalized;
}

const OPERATING_PROFILE_FIELDS = [
  'countryCode', 'route', 'supplierType', 'industry', 'address', 'primaryMaterialCode', 'primaryMaterialName',
  'defaultLeadTimeDays', 'productCriticality', 'paymentTerms', 'contractStartsOn', 'contractEndsOn',
] as const;

function normalizeOperatingProfile(value: unknown, supplierId: string, current: SupplierOperatingProfile | null): SupplierOperatingProfile {
  if (!isRecord(value)) throw new HttpError(422, 'operatingProfile 必须是对象', 'INVALID_SUPPLIER_PROFILE');
  if (Object.keys(value).some((key) => !(OPERATING_PROFILE_FIELDS as readonly string[]).includes(key))) {
    throw new HttpError(422, 'operatingProfile 包含不允许的字段', 'INVALID_SUPPLIER_PROFILE');
  }
  const base: SupplierOperatingProfile = current ?? {
    supplierId,
    countryCode: null,
    route: 'unclassified',
    supplierType: 'other',
    industry: null,
    address: null,
    primaryMaterialCode: null,
    primaryMaterialName: null,
    defaultLeadTimeDays: null,
    productCriticality: 'unclassified',
    paymentTerms: null,
    contractStartsOn: null,
    contractEndsOn: null,
    status: 'active',
    version: 1,
  };
  const supplied = Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined));
  try {
    return validateSupplierOperatingProfile({
      ...base,
      ...supplied,
      supplierId,
      status: current?.status ?? 'active',
      version: current?.version ?? 1,
    });
  } catch (error) {
    if (error instanceof SupplierOperatingProfileValidationError) {
      throw new HttpError(422, error.message, 'INVALID_SUPPLIER_PROFILE');
    }
    throw error;
  }
}

function expectedInteger(value: unknown, field: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new HttpError(422, `${field} 必须是${allowZero ? '非负' : '正'}整数`, 'INVALID_SUPPLIER_PROFILE');
  }
  return value;
}

function rollbackTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  try { db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
}

function createOrUpdateSupplierProfile(
  db: DatabaseSync,
  tenantId: string,
  input: {
    current: SupplierOperatingProfile;
    normalized: SupplierOperatingProfile;
    actorId: string;
    reason: string;
    at: string;
  },
): SupplierOperatingProfile {
  const { supplierId: _currentSupplierId, version: _currentVersion, ...currentFields } = input.current;
  const { supplierId: _nextSupplierId, version: _nextVersion, ...nextFields } = input.normalized;
  if (stableStringify(currentFields) === stableStringify(nextFields)) return input.current;
  return updateProcurementSupplierOperatingProfile(db, tenantId, {
    supplierId: input.current.supplierId,
    expectedVersion: input.current.version,
    patch: nextFields,
    actorId: input.actorId,
    reason: input.reason,
    source: 'manual',
    at: input.at,
  });
}

function boundedText(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new HttpError(422, `${field} 必须是字符串`, 'INVALID_INBOUND_EMAIL');
  const result = allowEmpty ? value : value.trim();
  if (!allowEmpty && !result) throw new HttpError(422, `${field} 必填`, 'INVALID_INBOUND_EMAIL');
  if (result.length > maximum) throw new HttpError(422, `${field} 不能超过 ${maximum} 个字符`, 'INVALID_INBOUND_EMAIL');
  return result;
}

function normalizeInboundEmail(body: Record<string, unknown>): NormalizedInboundEmail {
  const allowed = new Set(['provider', 'mailbox', 'uid', 'messageId', 'from', 'subject', 'body', 'receivedAt', 'channel', 'supplierId']);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new HttpError(422, '入站邮件请求包含不允许的字段', 'INVALID_INBOUND_EMAIL');
  if (body['channel'] !== 'email') throw new HttpError(422, 'channel 必须为 email', 'INVALID_INBOUND_EMAIL');
  const provider = body['provider'] === undefined ? undefined : boundedText(body['provider'], 'provider', 100);
  const mailbox = body['mailbox'] === undefined ? undefined : boundedText(body['mailbox'], 'mailbox', 320);
  const uid = body['uid'] === undefined ? undefined : boundedText(body['uid'], 'uid', 200);
  const messageId = body['messageId'] === undefined ? undefined : boundedText(body['messageId'], 'messageId', 998);
  const providerIdentityCount = [provider, mailbox, uid].filter(Boolean).length;
  if (providerIdentityCount !== 0 && providerIdentityCount !== 3) {
    throw new HttpError(422, 'provider、mailbox 与 uid 必须同时提供', 'INVALID_INBOUND_EMAIL');
  }
  if (providerIdentityCount === 0 && !messageId) {
    throw new HttpError(422, '必须提供 provider/mailbox/uid 或 messageId', 'INVALID_INBOUND_EMAIL');
  }
  const receivedAt = date(body['receivedAt'], 'receivedAt');
  if (Date.parse(receivedAt) > Date.now() + 5 * 60_000) throw new HttpError(422, 'receivedAt 不能明显晚于当前时间', 'INVALID_INBOUND_EMAIL');
  return {
    ...(provider ? { provider } : {}),
    ...(mailbox ? { mailbox } : {}),
    ...(uid ? { uid } : {}),
    ...(messageId ? { messageId } : {}),
    from: boundedText(body['from'], 'from', 1_000),
    ...(body['subject'] === undefined ? {} : { subject: boundedText(body['subject'], 'subject', 2_000, true) }),
    body: boundedText(body['body'], 'body', 1_000_000, true),
    receivedAt,
    channel: 'email',
    supplierId: boundedText(body['supplierId'], 'supplierId', 500),
  };
}

function publicInboundCommunication(document: Communication, version: number, replayed: boolean): Record<string, unknown> {
  return {
    id: document.id,
    rfqId: document.businessObjectId,
    supplierId: document.supplierId,
    provider: document.provider ?? null,
    mailbox: document.mailbox ?? null,
    uid: document.uid ?? null,
    messageId: document.messageId ?? null,
    from: document.from ?? null,
    subject: document.subject ?? null,
    channel: document.channel,
    receivedAt: document.receivedAt ?? document.occurredAt,
    version,
    replayed,
  };
}

function normalizeRfq(body: Record<string, unknown>): NormalizedRfq {
  if (!Array.isArray(body['supplierIds']) || body['supplierIds'].length === 0) {
    throw new HttpError(422, 'supplierIds 必须至少包含一个供应商', 'INVALID_PROCUREMENT_INPUT');
  }
  const supplierIds = body['supplierIds'].map((value, index) => text(value, `supplierIds[${index}]`));
  if (new Set(supplierIds).size !== supplierIds.length) throw new HttpError(422, 'supplierIds 不能重复', 'INVALID_PROCUREMENT_INPUT');
  const rawAttachmentIds = body['attachmentIds'] ?? [];
  if (!Array.isArray(rawAttachmentIds)) throw new HttpError(422, 'attachmentIds 必须是数组', 'INVALID_PROCUREMENT_INPUT');
  const attachmentIds = rawAttachmentIds.map((value, index) => text(value, `attachmentIds[${index}]`));
  if (new Set(attachmentIds).size !== attachmentIds.length) throw new HttpError(422, 'attachmentIds 不能重复', 'INVALID_PROCUREMENT_INPUT');
  if (body['lines'] !== undefined && !Array.isArray(body['lines'])) throw new HttpError(422, 'lines 必须是数组', 'INVALID_PROCUREMENT_INPUT');
  const quoteDueAt = date(body['quoteDueAt'] ?? body['deadline'], 'deadline');
  if (Date.parse(quoteDueAt) <= Date.now()) throw new HttpError(422, 'quoteDueAt 必须晚于当前时间', 'RFQ_DUE_AT_EXPIRED');
  return {
    requisitionId: text(body['requisitionId'], 'requisitionId'),
    title: text(body['title'], 'title'),
    quoteDueAt,
    currency: text(body['currency'], 'currency').toUpperCase(),
    supplierIds,
    attachmentIds,
    sourceSystem: optionalText(body['sourceSystem'], 'sourceSystem') ?? 'manual',
    ...(body['externalId'] === undefined ? {} : { externalId: text(body['externalId'], 'externalId') }),
  };
}

function normalizeCharge(value: unknown, index: number, chargeIndex: number): SupplierQuoteCharge {
  const prefix = `lines[${index}].oneTimeCharges[${chargeIndex}]`;
  if (!isRecord(value)) throw new HttpError(422, `${prefix} 必须是对象`, 'INVALID_PROCUREMENT_INPUT');
  const kind = text(value['kind'], `${prefix}.kind`);
  if (!['tooling', 'packaging', 'other'].includes(kind)) throw new HttpError(422, `${prefix}.kind 无效`, 'INVALID_PROCUREMENT_INPUT');
  return {
    kind: kind as SupplierQuoteCharge['kind'],
    amount: numberValue(value['amount'], `${prefix}.amount`),
    ...(value['description'] === undefined ? {} : { description: text(value['description'], `${prefix}.description`) }),
  };
}

function normalizeQuoteLine(value: unknown, index: number): NormalizedQuoteLine {
  const prefix = `lines[${index}]`;
  if (!isRecord(value)) throw new HttpError(422, `${prefix} 必须是对象`, 'INVALID_PROCUREMENT_INPUT');
  if (value['taxIncluded'] !== undefined && typeof value['taxIncluded'] !== 'boolean') throw new HttpError(422, `${prefix}.taxIncluded 必须是布尔值`, 'INVALID_PROCUREMENT_INPUT');
  const charges = value['oneTimeCharges'] ?? [];
  if (!Array.isArray(charges)) throw new HttpError(422, `${prefix}.oneTimeCharges 必须是数组`, 'INVALID_PROCUREMENT_INPUT');
  return {
    rfqLineId: text(value['rfqLineId'], `${prefix}.rfqLineId`),
    unitPrice: numberValue(value['unitPrice'], `${prefix}.unitPrice`),
    priceBasisQuantity: numberValue(value['priceBasisQuantity'], `${prefix}.priceBasisQuantity`, { positive: true }),
    quotedQuantity: numberValue(value['quotedQuantity'], `${prefix}.quotedQuantity`, { positive: true }),
    uom: text(value['uom'], `${prefix}.uom`),
    ...(value['taxIncluded'] === undefined ? {} : { taxIncluded: value['taxIncluded'] }),
    ...(value['taxRate'] === undefined ? {} : { taxRate: numberValue(value['taxRate'], `${prefix}.taxRate`, { max: 1 }) }),
    ...(value['moq'] === undefined ? {} : { moq: numberValue(value['moq'], `${prefix}.moq`, { positive: true }) }),
    ...(value['promisedAt'] === undefined ? {} : { promisedAt: date(value['promisedAt'], `${prefix}.promisedAt`) }),
    leadTimeDays: numberValue(value['leadTimeDays'], `${prefix}.leadTimeDays`),
    oneTimeCharges: charges.map((charge, chargeIndex) => normalizeCharge(charge, index, chargeIndex)),
    ...(value['freight'] === undefined ? {} : { freight: numberValue(value['freight'], `${prefix}.freight`) }),
    paymentTerms: text(value['paymentTerms'], `${prefix}.paymentTerms`),
  };
}

function normalizeEvidence(value: unknown): SupplierQuoteEvidence | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new HttpError(422, 'evidence 必须是对象', 'INVALID_QUOTE_EVIDENCE');
  const allowed = new Set(['communicationId', 'messageId', 'attachmentIds', 'sourceChannel']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new HttpError(422, 'evidence 包含不允许的字段', 'INVALID_QUOTE_EVIDENCE');
  if (value['attachmentIds'] !== undefined && !Array.isArray(value['attachmentIds'])) throw new HttpError(422, 'evidence.attachmentIds 必须是数组', 'INVALID_QUOTE_EVIDENCE');
  const attachmentIds = Array.isArray(value['attachmentIds'])
    ? value['attachmentIds'].map((item, index) => text(item, `evidence.attachmentIds[${index}]`))
    : undefined;
  const evidence: SupplierQuoteEvidence = {
    ...(value['communicationId'] === undefined ? {} : { communicationId: text(value['communicationId'], 'evidence.communicationId') }),
    ...(value['messageId'] === undefined ? {} : { messageId: text(value['messageId'], 'evidence.messageId') }),
    ...(attachmentIds === undefined ? {} : { attachmentIds }),
    ...(value['sourceChannel'] === undefined ? {} : { sourceChannel: text(value['sourceChannel'], 'evidence.sourceChannel') }),
  };
  if (Object.keys(evidence).length === 0) throw new HttpError(422, 'evidence 不能为空', 'INVALID_QUOTE_EVIDENCE');
  return evidence;
}

function normalizeQuote(body: Record<string, unknown>): NormalizedQuote {
  if (!Array.isArray(body['lines']) || body['lines'].length === 0) throw new HttpError(422, 'lines 必须至少包含一行', 'INVALID_PROCUREMENT_INPUT');
  const receivedAt = date(body['receivedAt'], 'receivedAt');
  if (Date.parse(receivedAt) > Date.now() + 5 * 60_000) throw new HttpError(422, 'receivedAt 不能明显晚于当前时间', 'INVALID_QUOTE_RECEIVED_AT');
  const validUntil = date(body['validUntil'], 'validUntil');
  if (Date.parse(validUntil) < Date.parse(receivedAt)) throw new HttpError(422, 'validUntil 不能早于 receivedAt', 'INVALID_QUOTE_VALIDITY');
  const lines = body['lines'].map(normalizeQuoteLine);
  if (new Set(lines.map((line) => line.rfqLineId)).size !== lines.length) throw new HttpError(422, 'rfqLineId 不能重复', 'INVALID_PROCUREMENT_INPUT');
  const evidence = normalizeEvidence(body['evidence']);
  return {
    supplierId: text(body['supplierId'], 'supplierId'),
    receivedAt,
    validUntil,
    currency: text(body['currency'], 'currency').toUpperCase(),
    ...(evidence ? { evidence } : {}),
    sourceSystem: optionalText(body['sourceSystem'], 'sourceSystem') ?? 'manual',
    ...(body['externalId'] === undefined ? {} : { externalId: text(body['externalId'], 'externalId') }),
    lines,
  };
}

function publicSupplier(supplier: Supplier): Record<string, unknown> {
  const primary = supplier.contacts.find((contact) => contact.primary) ?? supplier.contacts[0];
  return {
    id: supplier.id, name: supplier.name, currency: supplier.currency, status: supplier.status,
    sourceSystem: supplier.sourceSystem, externalId: supplier.externalId,
    ...(supplier.countryCode ? { countryCode: supplier.countryCode } : {}),
    ...(supplier.countryName ? { countryName: supplier.countryName } : {}),
    ...(supplier.city ? { city: supplier.city } : {}),
    ...(supplier.street ? { street: supplier.street } : {}),
    ...(supplier.street2 ? { street2: supplier.street2 } : {}),
    ...(supplier.postalCode ? { postalCode: supplier.postalCode } : {}),
    ...(primary?.email ? { email: primary.email } : {}),
    contacts: redactSensitiveValue(supplier.contacts), createdAt: supplier.createdAt, updatedAt: supplier.updatedAt,
  };
}

interface RfqAttachmentRow {
  id: string; requisition_line_id: string | null; file_name: string; content_type: string; size_bytes: number;
  sha256: string; version: number; extraction_status: 'text_extracted' | 'ready_for_document_agent';
  extracted_text_preview: string | null; created_by: string; created_at: string;
  security_status: 'pending_scan' | 'clean' | 'quarantined' | 'scan_failed';
  processing_status: string;
  detected_content_type: string | null;
}

function requisitionAttachmentSnapshot(db: DatabaseSync, tenantId: string, requisitionId: string, attachmentIds: readonly string[]): RequisitionAttachment[] {
  if (attachmentIds.length === 0) return [];
  const rows = db.prepare(`SELECT id,requisition_line_id,file_name,content_type,size_bytes,sha256,version,
    extraction_status,extracted_text_preview,security_status,processing_status,detected_content_type,created_by,created_at
    FROM procurement_attachments WHERE tenant_id=? AND requisition_id=? AND status='active'`)
    .all(tenantId, requisitionId) as unknown as RfqAttachmentRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return attachmentIds.map((id) => {
    const row = byId.get(id);
    if (!row) throw new HttpError(422, '所选附件不属于该采购需求或已失效', 'RFQ_ATTACHMENT_MISMATCH');
    if (row.security_status !== 'clean') throw new HttpError(422, `附件 ${row.file_name} 尚未通过恶意软件扫描，不能进入 RFQ`, 'RFQ_ATTACHMENT_SECURITY_PENDING');
    return {
      id: row.id, fileName: row.file_name, contentType: row.content_type, sizeBytes: row.size_bytes,
      url: `/api/procurement/attachments/${encodeURIComponent(row.id)}/content`, sha256: row.sha256, version: row.version,
      ...(row.requisition_line_id ? { requisitionLineId: row.requisition_line_id } : {}),
      uploadedBy: row.created_by, uploadedAt: row.created_at, extractionStatus: row.extraction_status,
      securityStatus: row.security_status, processingStatus: row.processing_status as RequisitionAttachment['processingStatus'],
      ...(row.detected_content_type ? { detectedContentType: row.detected_content_type } : {}),
      ...(row.extracted_text_preview ? { extractedTextPreview: row.extracted_text_preview } : {}),
    } satisfies RequisitionAttachment;
  });
}

function publicRfqLine(line: RequestForQuotationLine): Record<string, unknown> {
  return {
    id: line.id, lineNumber: line.lineNumber, requisitionLineId: line.requisitionLineId,
    itemId: line.itemId, itemCode: line.itemCode ?? line.itemId, itemName: line.itemName ?? line.description ?? line.itemId,
    quantity: line.requestedQty, uom: line.uom, unit: line.uom, targetDate: line.requiredAt,
    ...(line.technicalRequirements ? { technicalRequirements: line.technicalRequirements } : {}),
    attachmentIds: line.attachmentIds ?? [],
    attachments: line.attachments ?? [],
  };
}

function publicRfq(repository: ProcurementRepository, rfq: RequestForQuotation, version: number, lines?: readonly RequestForQuotationLine[]): Record<string, unknown> {
  const comparisonSnapshotId = rfq.comparisonSnapshotId;
  const comparisonSnapshot = comparisonSnapshotId
    ? repository.getDocument<QuoteComparisonSnapshot>('quote_comparison', comparisonSnapshotId)?.document
    : undefined;
  const quotes = repository.listDocuments<SupplierQuote>('quote').filter(({ document }) => document.rfqId === rfq.id);
  const quotedSupplierCount = new Set(quotes.map(({ document }) => document.supplierId)).size;
  return {
    id: rfq.id, requisitionId: rfq.requisitionId, title: rfq.title ?? rfq.externalId,
    quoteDueAt: rfq.quoteDueAt, deadline: rfq.quoteDueAt,
    currency: rfq.currency, supplierIds: rfq.supplierIds, buyerId: rfq.buyerId, status: rfq.status,
    externalId: rfq.externalId, createdAt: rfq.createdAt, updatedAt: rfq.updatedAt, version,
    attachmentIds: rfq.attachmentIds ?? [], attachments: rfq.attachments ?? [],
    supplierCount: rfq.supplierIds.length, quoteCount: quotes.length, quotedSupplierCount,
    pendingSupplierCount: Math.max(0, rfq.supplierIds.length - quotedSupplierCount),
    lines: (lines ?? repository.listLines<RequestForQuotationLine>('rfq_line', rfq.id)).map(publicRfqLine),
    ...(comparisonSnapshot ? { comparisonSnapshot: publicComparisonSnapshot(comparisonSnapshot) } : {}),
  };
}

function publicComparisonSnapshot(snapshot: QuoteComparisonSnapshot): Record<string, unknown> {
  return {
    id: snapshot.id, asOf: snapshot.asOf, comparisonCurrency: snapshot.comparisonCurrency,
    ruleVersion: snapshot.ruleVersion, rateSnapshotVersion: snapshot.rateSnapshot.version,
    lineComparisons: snapshot.lineComparisons,
  };
}

function publicQuoteLine(line: SupplierQuoteLine): Record<string, unknown> {
  return {
    id: line.id, rfqLineId: line.rfqLineId, lineNumber: line.lineNumber,
    unitPrice: line.unitPrice, priceBasisQuantity: line.priceBasisQuantity ?? 1,
    quotedQuantity: line.quotedQty, uom: line.uom,
    ...(line.taxIncluded === undefined ? {} : { taxIncluded: line.taxIncluded }),
    taxStatus: line.taxIncluded === undefined ? 'unknown' : line.taxIncluded ? 'included' : 'excluded',
    ...(line.taxRate === undefined ? {} : { taxRate: line.taxRate }),
    ...(line.moq === undefined ? {} : { moq: line.moq }),
    ...(line.promisedAt === undefined ? {} : { promisedAt: line.promisedAt }),
    leadTimeDays: line.leadTimeDays ?? 0, oneTimeCharges: line.oneTimeCharges ?? [],
    ...(line.freight === undefined ? {} : { freight: line.freight }),
    paymentTerms: line.paymentTerms ?? '',
  };
}

function publicQuote(repository: ProcurementRepository, quote: SupplierQuote, version: number, supplier?: Supplier, lines?: readonly SupplierQuoteLine[]): Record<string, unknown> {
  return {
    id: quote.id, rfqId: quote.rfqId, supplierId: quote.supplierId, supplierName: supplier?.name ?? quote.supplierId,
    receivedAt: quote.receivedAt ?? quote.createdAt, validUntil: quote.validUntil, currency: quote.currency,
    evidence: redactSensitiveValue(quote.evidence ?? {}), status: quote.status, externalId: quote.externalId,
    createdAt: quote.createdAt, updatedAt: quote.updatedAt, version,
    lines: (lines ?? repository.listLines<SupplierQuoteLine>('quote_line', quote.id)).map(publicQuoteLine),
  };
}

function publicAward(award: Award, version: number, lines: readonly AwardLine[]): Record<string, unknown> {
  return {
    id: award.id, rfqId: award.rfqId, status: award.status,
    ...(award.approvedBy ? { approvedBy: award.approvedBy } : {}),
    ...(award.approvedAt ? { approvedAt: award.approvedAt } : {}),
    createdAt: award.createdAt, updatedAt: award.updatedAt, version,
    lines: lines.map((line) => ({
      id: line.id, rfqLineId: line.rfqLineId, quoteLineId: line.quoteLineId, supplierId: line.supplierId,
      awardedQuantity: line.awardedQty, unitPrice: line.unitPrice, currency: line.currency,
      selectionReason: line.selectionReason, quotedUnitPrice: line.quotedUnitPrice,
      priceBasisQuantity: line.priceBasisQuantity, taxIncluded: line.taxIncluded, taxRate: line.taxRate,
    })),
  };
}

function publicPurchaseOrder(po: PurchaseOrder, version: number, lines: readonly PurchaseOrderLine[], supplier?: Supplier): Record<string, unknown> {
  return {
    id: po.id, awardId: po.awardId, supplierId: po.supplierId, currency: po.currency,
    supplierName: supplier?.name ?? po.supplierId,
    total: lines.reduce((sum, line) => sum + line.orderedQty * line.unitPrice, 0),
    status: po.status, orderedAt: po.orderedAt, createdAt: po.createdAt, updatedAt: po.updatedAt, version,
    lines: lines.map((line) => ({
      id: line.id, awardLineId: line.awardLineId, quoteLineId: line.quoteLineId, rfqLineId: line.rfqLineId,
      requisitionLineId: line.requisitionLineId, itemId: line.itemId, orderedQuantity: line.orderedQty,
      unitPrice: line.unitPrice, quotedUnitPrice: line.quotedUnitPrice,
      priceBasisQuantity: line.priceBasisQuantity, taxIncluded: line.taxIncluded, taxRate: line.taxRate,
      currency: line.currency, uom: line.uom,
    })),
  };
}

function getRfq(repository: ProcurementRepository, id: string): { document: RequestForQuotation; version: number } {
  const stored = repository.getDocument<RequestForQuotation>('rfq', id);
  if (!stored) throw new HttpError(404, 'RFQ 不存在', 'RFQ_NOT_FOUND');
  return stored;
}

function normalizeComparison(body: Record<string, unknown>): {
  asOf: string; comparisonCurrency: string; rateSnapshot: ExchangeRateSnapshot;
  weights: QuoteComparisonWeights; ruleVersion: string;
} {
  if (!isRecord(body['rateSnapshot']) || !isRecord(body['rateSnapshot']['rates'])) throw new HttpError(422, 'rateSnapshot.rates 必须是对象', 'INVALID_COMPARISON_INPUT');
  const rates: Record<string, number> = {};
  for (const [pair, value] of Object.entries(body['rateSnapshot']['rates'])) rates[text(pair, '汇率对')] = numberValue(value, `rateSnapshot.rates.${pair}`, { positive: true });
  if (!isRecord(body['weights'])) throw new HttpError(422, 'weights 必须是对象', 'INVALID_COMPARISON_INPUT');
  return {
    asOf: date(body['asOf'], 'asOf'),
    comparisonCurrency: text(body['comparisonCurrency'], 'comparisonCurrency').toUpperCase(),
    rateSnapshot: { version: text(body['rateSnapshot']['version'], 'rateSnapshot.version'), rates },
    weights: {
      price: numberValue(body['weights']['price'], 'weights.price'),
      leadTime: numberValue(body['weights']['leadTime'], 'weights.leadTime'),
      paymentTerms: numberValue(body['weights']['paymentTerms'], 'weights.paymentTerms'),
      performance: numberValue(body['weights']['performance'], 'weights.performance'),
    },
    ruleVersion: text(body['ruleVersion'], 'ruleVersion'),
  };
}

function expectedVersion(value: unknown, field = 'expectedRfqVersion'): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new HttpError(422, `${field} 必须是正整数`, 'INVALID_PROCUREMENT_INPUT');
  return value as number;
}

function normalizeAward(body: Record<string, unknown>): NormalizedAward {
  const allowed = new Set(['idempotencyKey', 'expectedRfqVersion', 'comparisonSnapshotId', 'reason', 'lines']);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new HttpError(422, '定标请求包含不允许的字段', 'INVALID_AWARD_INPUT');
  if (!Array.isArray(body['lines']) || body['lines'].length === 0) throw new HttpError(422, 'lines 必须至少包含一行', 'INVALID_AWARD_INPUT');
  const selections = body['lines'].map((value, index) => {
    if (!isRecord(value)) throw new HttpError(422, `lines[${index}] 必须是对象`, 'INVALID_AWARD_INPUT');
    const lineAllowed = new Set(['rfqLineId', 'quoteLineId', 'awardedQuantity']);
    if (Object.keys(value).some((key) => !lineAllowed.has(key))) throw new HttpError(422, `lines[${index}] 包含不允许的字段`, 'INVALID_AWARD_INPUT');
    return {
      rfqLineId: text(value['rfqLineId'], `lines[${index}].rfqLineId`),
      quoteLineId: text(value['quoteLineId'], `lines[${index}].quoteLineId`),
      awardedQuantity: numberValue(value['awardedQuantity'], `lines[${index}].awardedQuantity`, { positive: true }),
    };
  });
  if (new Set(selections.map((line) => line.rfqLineId)).size !== selections.length) throw new HttpError(422, 'rfqLineId 不能重复', 'INVALID_AWARD_INPUT');
  const reason = text(body['reason'], 'reason');
  if (reason.length > 2_000) throw new HttpError(422, 'reason 不能超过 2000 个字符', 'INVALID_AWARD_INPUT');
  return {
    expectedRfqVersion: expectedVersion(body['expectedRfqVersion']),
    comparisonSnapshotId: text(body['comparisonSnapshotId'], 'comparisonSnapshotId'),
    reason,
    selections,
  };
}

function quoteInput(quote: SupplierQuote, quoteVersion: number, line: SupplierQuoteLine, supplier?: Supplier): QuoteComparisonInput {
  return {
    quoteId: quote.id,
    quoteLineId: line.id,
    quoteVersion,
    supplierId: quote.supplierId, supplierName: supplier?.name,
    unitPrice: line.unitPrice, priceBasisQuantity: line.priceBasisQuantity ?? 1,
    quantity: line.quotedQty, uom: line.uom, currency: quote.currency,
    ...(line.taxIncluded === undefined ? {} : { taxIncluded: line.taxIncluded }), taxRate: line.taxRate, moq: line.moq,
    leadTimeDays: line.leadTimeDays ?? 0,
    oneTimeCharges: line.oneTimeCharges?.map((charge) => ({ ...charge })), freight: line.freight,
    paymentTerms: line.paymentTerms ?? '',
    ...(supplier?.performanceScore === undefined ? {} : { performance: { score: supplier.performanceScore } }),
    validUntil: quote.validUntil ?? quote.createdAt,
  };
}

export async function handleProcurementRfqRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: RouteContext,
): Promise<boolean> {
  const rfqItem = path.match(/^\/api\/procurement\/rfqs\/([^/]+)$/);
  const quotes = path.match(/^\/api\/procurement\/rfqs\/([^/]+)\/quotes$/);
  const compare = path.match(/^\/api\/procurement\/rfqs\/([^/]+)\/compare$/);
  const award = path.match(/^\/api\/procurement\/rfqs\/([^/]+)\/award$/);
  const inboundEmail = path.match(/^\/api\/procurement\/rfqs\/([^/]+)\/communications\/inbound-email$/);
  const supplierSync = path === '/api/procurement/suppliers/sync';
  const manualSupplier = path === '/api/procurement/suppliers';
  const supplierItem = path.match(/^\/api\/procurement\/suppliers\/([^/]+)$/);
  const supplierStatusAction = path.match(/^\/api\/procurement\/suppliers\/([^/]+)\/(deactivate|reactivate)$/);
  const relevant = manualSupplier || supplierSync || supplierItem || supplierStatusAction || path === '/api/procurement/rfqs' || rfqItem || quotes || compare || award || inboundEmail;
  if (!relevant) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  const supplierMutation = (supplierItem && method === 'PATCH') || (supplierStatusAction && method === 'POST');
  const permission = award && method === 'POST' ? 'approve' : supplierSync || (manualSupplier && method === 'POST') || supplierMutation ? 'configure' : method === 'GET' || method === 'HEAD' ? 'read' : 'operate';
  if (!can(context.session, permission)) { sendJson(res, 403, { error: `当前角色无「${permission}」权限`, code: 'FORBIDDEN' }); return true; }
  const repository = createProcurementRepository(context.db, context.session.tenantId);

  try {
    if (method === 'POST' && supplierSync) {
      const body = await readBody(req);
      const key = idempotencyKey(req, body);
      const hash = payloadHash(supplierSyncPayload(body));
      const replay = repository.getSupplierSyncResult(key, hash);
      if (replay) { sendJson(res, 200, replay); return true; }
      if (!context.supplierMasterProvider) throw new HttpError(409, 'Odoo 尚未配置，无法同步现有供应商', 'ODOO_NOT_CONFIGURED');
      const masters = await context.supplierMasterProvider();
      const now = new Date().toISOString();
      const issues: SupplierSyncIssue[] = masters.issues.map((issue) => ({
        row: Number.isSafeInteger(issue.row) ? issue.row : -1,
        reason: issue.reason === 'missing_id' || issue.reason === 'missing_name' ? issue.reason : 'invalid_supplier_row',
      }));
      const suppliers: Supplier[] = [];
      for (const master of masters.items) {
        const match = typeof master.externalId === 'string' ? /^odoo-partner-([1-9]\d{0,19})$/.exec(master.externalId) : null;
        if (!match) { issues.push({ row: -1, reason: 'invalid_external_id' }); continue; }
        const partnerId = match[1]!;
        const id = `supplier:odoo:${partnerId}`;
        const contacts = master.contacts.map((contact, index) => ({ id: `supplier-contact:odoo:${partnerId}:${index}`, name: contact.name, ...(contact.email ? { email: contact.email } : {}), ...(contact.phone ? { phone: contact.phone } : {}), primary: index === 0 }));
        suppliers.push({
          id, tenantId: context.session.tenantId, sourceSystem: master.sourceSystem, externalId: master.externalId,
          status: master.status, createdAt: now, updatedAt: now, name: master.name, currency: master.currency, contacts,
          ...(master.countryCode?.trim() ? { countryCode: master.countryCode.trim().toUpperCase() } : {}),
          ...(master.countryName?.trim() ? { countryName: master.countryName.trim() } : {}),
          ...(master.city?.trim() ? { city: master.city.trim() } : {}),
          ...(master.street?.trim() ? { street: master.street.trim() } : {}),
          ...(master.street2?.trim() ? { street2: master.street2.trim() } : {}),
          ...(master.postalCode?.trim() ? { postalCode: master.postalCode.trim() } : {}),
        });
      }
      const result = repository.syncSuppliersIdempotent({ idempotencyKey: key, payloadHash: hash, suppliers, issues, completedAt: now });
      sendJson(res, 200, result); return true;
    }
    if (method === 'POST' && manualSupplier) {
      const body = await readBody(req);
      const key = idempotencyKey(req, body);
      const normalized = normalizeManualSupplier(body);
      // Only accepted fields enter the idempotency hash: ignored client fields
      // cannot become persisted or reflected through an error/replay response.
      const hash = payloadHash(normalized);
      const replay = repository.getSupplierSyncResult(key, hash);
      if (replay) {
        const item = replay.items[0];
        const stored = item && repository.getDocument<Supplier>('supplier', item.id);
        if (!item || !stored) throw new Error('供应商幂等记录引用的单据不存在');
        const profile = getProcurementSupplierOperatingProfile(context.db, context.session.tenantId, stored.document.id);
        sendJson(res, 200, { supplier: publicSupplier(stored.document), version: stored.version, profile, replayed: true });
        return true;
      }

      const now = new Date().toISOString();
      const id = `supplier:manual:${randomUUID()}`;
      const externalId = normalized.externalId ?? `manual:${randomUUID()}`;
      const supplier: Supplier = {
        id,
        tenantId: context.session.tenantId,
        sourceSystem: 'manual',
        externalId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        name: normalized.name,
        currency: normalized.currency,
        contacts: [{
          id: `${id}:contact:primary`,
          name: normalized.primaryContact.name,
          email: normalized.primaryContact.email,
          ...(normalized.primaryContact.phone ? { phone: normalized.primaryContact.phone } : {}),
          primary: true,
        }],
      };
      // Matching (tenant, sourceSystem, externalId) is intentionally an update,
      // which makes correction of a previously registered manual supplier safe.
      if (normalized.operatingProfile) context.db.exec('BEGIN IMMEDIATE');
      let result: SupplierSyncResult;
      try {
        result = repository.syncSuppliersIdempotent({
          idempotencyKey: key,
          payloadHash: hash,
          suppliers: [supplier],
          issues: [],
          completedAt: now,
        });
        const storedId = result.items[0]?.id;
        if (normalized.operatingProfile && storedId) {
          if (getProcurementSupplierOperatingProfile(context.db, context.session.tenantId, storedId)) {
            throw new HttpError(409, '该供应商已存在经营档案，请使用编辑操作', 'SUPPLIER_PROFILE_EXISTS');
          }
          createProcurementSupplierOperatingProfile(context.db, context.session.tenantId, {
            profile: { ...normalized.operatingProfile, supplierId: storedId, version: 1 },
            actorId: context.session.humanId,
            reason: '创建供应商经营档案',
            source: 'manual',
            at: now,
          });
        }
        if (normalized.operatingProfile) context.db.exec('COMMIT');
      } catch (error) {
        if (normalized.operatingProfile) rollbackTransaction(context.db);
        throw error;
      }
      const item = result.items[0];
      const stored = item && repository.getDocument<Supplier>('supplier', item.id);
      if (!item || !stored) throw new Error('供应商登记后读取失败');
      const profile = getProcurementSupplierOperatingProfile(context.db, context.session.tenantId, stored.document.id);
      sendJson(res, 201, { supplier: publicSupplier(stored.document), version: stored.version, profile, replayed: false });
      return true;
    }
    if ((method === 'GET' || method === 'HEAD') && path === '/api/procurement/suppliers') {
      const items = repository.listDocuments<Supplier>('supplier').map(({ document, version }) => {
        const profile = getProcurementSupplierOperatingProfile(context.db, context.session!.tenantId, document.id);
        return { ...publicSupplier(document), version, profile, operatingStatus: profile?.status ?? document.status };
      });
      sendJson(res, 200, {
        items,
        permissions: {
          read: can(context.session, 'read'),
          configure: can(context.session, 'configure'),
        },
      }); return true;
    }
    if (supplierItem && (method === 'GET' || method === 'HEAD')) {
      const supplierId = decodeURIComponent(supplierItem[1]!);
      const stored = repository.getDocument<Supplier>('supplier', supplierId);
      if (!stored) throw new HttpError(404, '供应商不存在', 'SUPPLIER_NOT_FOUND');
      const profile = getProcurementSupplierOperatingProfile(context.db, context.session.tenantId, supplierId);
      const purchaseOrders = repository.listDocuments<PurchaseOrder>('purchase_order')
        .filter(({ document }) => document.supplierId === supplierId)
        .map(({ document, version }) => publicPurchaseOrder(
          document,
          version,
          repository.listLines<PurchaseOrderLine>('purchase_order_line', document.id),
          stored.document,
        ));
      sendJson(res, 200, {
        supplier: publicSupplier(stored.document),
        version: stored.version,
        profile,
        profileEvents: listProcurementSupplierOperatingProfileEvents(context.db, context.session.tenantId, supplierId),
        purchaseOrders,
      });
      return true;
    }
    if (supplierItem && method === 'PATCH') {
      const supplierId = decodeURIComponent(supplierItem[1]!);
      const body = await readBody(req);
      const expectedVersion = expectedInteger(body['expectedVersion'], 'expectedVersion');
      const expectedProfileVersion = expectedInteger(body['expectedProfileVersion'], 'expectedProfileVersion', true);
      const reason = text(body['reason'], 'reason');
      if (reason.length < 10) throw new HttpError(422, 'reason 至少需要 10 个字符', 'INVALID_SUPPLIER_PROFILE');
      const masterFieldsPresent = ['name', 'currency', 'primaryContact'].some((field) => body[field] !== undefined);
      const requestedProfile = body['operatingProfile'];
      if (!masterFieldsPresent && requestedProfile === undefined) throw new HttpError(422, '没有可保存的供应商变更', 'INVALID_SUPPLIER_PROFILE');

      context.db.exec('BEGIN IMMEDIATE');
      try {
        const current = repository.getDocument<Supplier>('supplier', supplierId);
        if (!current) throw new HttpError(404, '供应商不存在', 'SUPPLIER_NOT_FOUND');
        const currentProfile = getProcurementSupplierOperatingProfile(context.db, context.session.tenantId, supplierId);
        if (current.version !== expectedVersion || (currentProfile?.version ?? 0) !== expectedProfileVersion) {
          throw new SupplierVersionConflictError(current.version, currentProfile?.version ?? 0);
        }
        if (current.document.sourceSystem === 'odoo' && masterFieldsPresent) {
          throw new HttpError(409, 'Odoo 权威主数据只能通过同步或变更提案更新', 'ODOO_AUTHORITATIVE_FIELD');
        }

        const now = new Date().toISOString();
        let stored = current;
        if (masterFieldsPresent) {
          let contacts = current.document.contacts;
          if (body['primaryContact'] !== undefined) {
            if (!isRecord(body['primaryContact'])) throw new HttpError(422, 'primaryContact 必须是对象', 'INVALID_PROCUREMENT_INPUT');
            const contact = body['primaryContact'];
            const previousPrimary = contacts.find((candidate) => candidate.primary) ?? contacts[0];
            contacts = [{
              id: previousPrimary?.id ?? `${supplierId}:contact:primary`,
              name: text(contact['name'], 'primaryContact.name'),
              email: email(contact['email'], 'primaryContact.email'),
              ...(contact['phone'] === undefined || contact['phone'] === null ? {} : { phone: text(contact['phone'], 'primaryContact.phone') }),
              primary: true,
            }];
          }
          const currency = body['currency'] === undefined ? current.document.currency : text(body['currency'], 'currency').toUpperCase();
          if (currency && !/^[A-Z]{3}$/.test(currency)) throw new HttpError(422, 'currency 必须是 3 位货币代码', 'INVALID_PROCUREMENT_INPUT');
          stored = repository.saveDocument('supplier', {
            ...current.document,
            name: body['name'] === undefined ? current.document.name : text(body['name'], 'name'),
            currency,
            contacts,
            updatedAt: now,
          }, current.version);
        }

        let profile = currentProfile;
        if (requestedProfile !== undefined) {
          const normalized = normalizeOperatingProfile(requestedProfile, supplierId, currentProfile);
          if (currentProfile) {
            profile = createOrUpdateSupplierProfile(context.db, context.session.tenantId, {
              current: currentProfile,
              normalized,
              actorId: context.session.humanId,
              reason,
              at: now,
            });
          } else {
            profile = createProcurementSupplierOperatingProfile(context.db, context.session.tenantId, {
              profile: normalized,
              actorId: context.session.humanId,
              reason,
              source: 'manual',
              at: now,
            });
          }
        }
        context.db.exec('COMMIT');
        sendJson(res, 200, { supplier: publicSupplier(stored.document), version: stored.version, profile });
        return true;
      } catch (error) {
        rollbackTransaction(context.db);
        throw error;
      }
    }
    if (supplierStatusAction && method === 'POST') {
      const supplierId = decodeURIComponent(supplierStatusAction[1]!);
      const action = supplierStatusAction[2] as 'deactivate' | 'reactivate';
      const body = await readBody(req);
      const expectedVersion = expectedInteger(body['expectedVersion'], 'expectedVersion');
      const reason = text(body['reason'], 'reason');
      if (reason.length < 10) throw new HttpError(422, 'reason 至少需要 10 个字符', 'INVALID_SUPPLIER_PROFILE');
      const desiredStatus = action === 'deactivate' ? 'inactive' : 'active';
      context.db.exec('BEGIN IMMEDIATE');
      try {
        const current = repository.getDocument<Supplier>('supplier', supplierId);
        const currentProfile = getProcurementSupplierOperatingProfile(context.db, context.session.tenantId, supplierId);
        if (!current || !currentProfile) throw new HttpError(404, '供应商经营档案不存在', 'SUPPLIER_NOT_FOUND');
        if (currentProfile.version !== expectedVersion) throw new SupplierVersionConflictError(current.version, currentProfile.version);
        if (currentProfile.status === desiredStatus) throw new HttpError(422, `供应商已经是${desiredStatus === 'active' ? '启用' : '停用'}状态`, 'SUPPLIER_STATUS_UNCHANGED');
        const profile = createOrUpdateSupplierProfile(context.db, context.session.tenantId, {
          current: currentProfile,
          normalized: { ...currentProfile, status: desiredStatus },
          actorId: context.session.humanId,
          reason,
          at: new Date().toISOString(),
        });
        let stored = current;
        if (current.document.sourceSystem !== 'odoo') {
          stored = repository.saveDocument('supplier', { ...current.document, status: desiredStatus, updatedAt: new Date().toISOString() }, current.version);
        }
        context.db.exec('COMMIT');
        sendJson(res, 200, { supplier: publicSupplier(stored.document), version: stored.version, profile });
        return true;
      } catch (error) {
        rollbackTransaction(context.db);
        throw error;
      }
    }
    if (method === 'POST' && path === '/api/procurement/rfqs') {
      const body = await readBody(req);
      const key = idempotencyKey(req, body);
      const normalized = normalizeRfq(body);
      const requisition = repository.getDocument<ProcurementRequisition>('requisition', normalized.requisitionId);
      if (!requisition) throw new HttpError(404, '采购申请不存在', 'REQUISITION_NOT_FOUND');
      const requisitionLines = repository.listLines<RequisitionLine>('requisition_line', normalized.requisitionId);
      if (requisitionLines.length === 0) throw new HttpError(422, '采购申请没有可询价的行', 'REQUISITION_LINES_EMPTY');
      for (const supplierId of normalized.supplierIds) {
        if (!repository.getDocument<Supplier>('supplier', supplierId)) throw new HttpError(404, '供应商不存在', 'SUPPLIER_NOT_FOUND');
      }
      const attachments = requisitionAttachmentSnapshot(context.db, context.session.tenantId, normalized.requisitionId, normalized.attachmentIds);
      const now = new Date().toISOString();
      const id = `rfq:${randomUUID()}`;
      const document: RequestForQuotation = {
        id, tenantId: context.session.tenantId, sourceSystem: normalized.sourceSystem,
        externalId: normalized.externalId ?? id, status: 'draft', createdAt: now, updatedAt: now,
        requisitionId: normalized.requisitionId, buyerId: context.session.humanId,
        supplierIds: normalized.supplierIds, currency: normalized.currency, quoteDueAt: normalized.quoteDueAt,
        title: normalized.title,
        attachmentIds: attachments.map((attachment) => attachment.id),
        attachments,
      };
      const lines: RequestForQuotationLine[] = requisitionLines.map((line) => {
        const lineAttachments = attachments.filter((attachment) => attachment.requisitionLineId === line.id);
        return {
          id: `rfq-line:${randomUUID()}`, rfqId: id, requisitionLineId: line.id, lineNumber: line.lineNumber,
          itemId: line.itemId, ...(line.description ? { description: line.description } : {}), uom: line.uom,
          requestedQty: line.requestedQty, requiredAt: line.requiredAt,
          ...(line.technicalRequirements ? { technicalRequirements: line.technicalRequirements } : {}),
          ...(line.itemCode === undefined ? {} : { itemCode: line.itemCode }),
          ...(line.itemName === undefined ? {} : { itemName: line.itemName }),
          attachmentIds: lineAttachments.map((attachment) => attachment.id),
          attachments: lineAttachments,
        };
      });
      const result = repository.createRfqIdempotent({
        idempotencyKey: key, payloadHash: payloadHash({ actorId: context.session.humanId, ...normalized }), document, lines,
      });
      sendJson(res, result.replayed ? 200 : 201, { ...publicRfq(repository, result.document.document, result.document.version, result.lines), replayed: result.replayed });
      return true;
    }
    if ((method === 'GET' || method === 'HEAD') && path === '/api/procurement/rfqs') {
      const items = repository.listDocuments<RequestForQuotation>('rfq').map(({ document, version }) => publicRfq(repository, document, version));
      sendJson(res, 200, { items }); return true;
    }
    if ((method === 'GET' || method === 'HEAD') && rfqItem) {
      const stored = getRfq(repository, decodeURIComponent(rfqItem[1]!));
      sendJson(res, 200, publicRfq(repository, stored.document, stored.version)); return true;
    }
    if (method === 'POST' && inboundEmail) {
      const rfqId = decodeURIComponent(inboundEmail[1]!);
      const body = await readBody(req);
      const normalized = normalizeInboundEmail(body);
      const now = new Date().toISOString();
      const identity = normalized.provider && normalized.mailbox && normalized.uid
        ? `${normalized.provider}\u0000${normalized.mailbox}\u0000${normalized.uid}`
        : `message-id\u0000${normalized.messageId}`;
      const identityHash = createHash('sha256').update(identity).digest('hex');
      const communication: Communication = {
        id: `communication:email:${randomUUID()}`,
        tenantId: context.session.tenantId,
        sourceSystem: 'email',
        externalId: `inbound-email:${identityHash}`,
        status: 'received',
        createdAt: now,
        updatedAt: now,
        businessObjectId: rfqId,
        businessObjectType: 'rfq',
        supplierId: normalized.supplierId,
        channel: normalized.channel,
        direction: 'inbound',
        ...(normalized.provider ? { provider: normalized.provider } : {}),
        ...(normalized.mailbox ? { mailbox: normalized.mailbox } : {}),
        ...(normalized.uid ? { uid: normalized.uid } : {}),
        ...(normalized.messageId ? { messageId: normalized.messageId } : {}),
        from: normalized.from,
        ...(normalized.subject === undefined ? {} : { subject: normalized.subject }),
        body: normalized.body,
        attachmentIds: [],
        occurredAt: normalized.receivedAt,
        receivedAt: normalized.receivedAt,
      };
      const result = repository.persistInboundCommunicationIdempotent({
        // Natural mail identifiers select the idempotency row; the hash protects
        // the linked business evidence. This lets the same Message-ID replay when
        // a provider reports it through a second mailbox/UID without creating a
        // duplicate communication.
        payloadHash: payloadHash({
          rfqId,
          supplierId: normalized.supplierId,
          from: normalized.from,
          subject: normalized.subject,
          body: normalized.body,
          receivedAt: normalized.receivedAt,
          channel: normalized.channel,
        }),
        communication,
      });
      sendJson(res, result.replayed ? 200 : 201,
        publicInboundCommunication(result.communication.document, result.communication.version, result.replayed));
      return true;
    }
    if (method === 'POST' && quotes) {
      const rfqId = decodeURIComponent(quotes[1]!);
      const storedRfq = getRfq(repository, rfqId);
      const body = await readBody(req);
      const key = idempotencyKey(req, body);
      const normalized = normalizeQuote(body);
      if (!storedRfq.document.supplierIds.includes(normalized.supplierId)) throw new HttpError(422, '供应商不在该 RFQ 候选范围内', 'SUPPLIER_NOT_CANDIDATE');
      const supplier = repository.getDocument<Supplier>('supplier', normalized.supplierId)?.document;
      if (!supplier) throw new HttpError(404, '供应商不存在', 'SUPPLIER_NOT_FOUND');
      const rfqLines = repository.listLines<RequestForQuotationLine>('rfq_line', rfqId);
      const lineById = new Map(rfqLines.map((line) => [line.id, line]));
      for (const line of normalized.lines) if (!lineById.has(line.rfqLineId)) throw new HttpError(404, 'RFQ 行不存在', 'RFQ_LINE_NOT_FOUND');
      const now = new Date().toISOString();
      const id = `quote:${randomUUID()}`;
      const document: SupplierQuote = {
        id, tenantId: context.session.tenantId, sourceSystem: normalized.sourceSystem,
        externalId: normalized.externalId ?? `${rfqId}:${normalized.supplierId}`, status: 'received',
        createdAt: now, updatedAt: now, rfqId, supplierId: normalized.supplierId,
        currency: normalized.currency, validUntil: normalized.validUntil, receivedAt: normalized.receivedAt,
        ...(normalized.evidence ? { evidence: normalized.evidence } : {}),
      };
      const lines: SupplierQuoteLine[] = normalized.lines.map((line) => {
        const rfqLine = lineById.get(line.rfqLineId)!;
        return {
          id: `quote-line:${randomUUID()}`, quoteId: id, rfqLineId: line.rfqLineId,
          lineNumber: rfqLine.lineNumber, itemId: rfqLine.itemId,
          ...(rfqLine.description ? { description: rfqLine.description } : {}), uom: line.uom,
          quotedQty: line.quotedQuantity, unitPrice: line.unitPrice,
          priceBasisQuantity: line.priceBasisQuantity, taxIncluded: line.taxIncluded,
          ...(line.taxRate === undefined ? {} : { taxRate: line.taxRate }),
          ...(line.moq === undefined ? {} : { moq: line.moq }),
          ...(line.promisedAt === undefined ? {} : { promisedAt: line.promisedAt }),
          leadTimeDays: line.leadTimeDays, oneTimeCharges: line.oneTimeCharges,
          ...(line.freight === undefined ? {} : { freight: line.freight }),
          paymentTerms: line.paymentTerms,
        };
      });
      const result = repository.createQuoteIdempotent({
        idempotencyKey: key, payloadHash: payloadHash({ rfqId, ...normalized }), document, lines,
      });
      const currentRfq = getRfq(repository, rfqId);
      sendJson(res, result.replayed ? 200 : 201, {
        ...publicQuote(repository, result.document.document, result.document.version, supplier, result.lines),
        rfq: publicRfq(repository, currentRfq.document, currentRfq.version),
        replayed: result.replayed,
      });
      return true;
    }
    if ((method === 'GET' || method === 'HEAD') && quotes) {
      const rfqId = decodeURIComponent(quotes[1]!);
      getRfq(repository, rfqId);
      const suppliers = new Map(repository.listDocuments<Supplier>('supplier').map(({ document }) => [document.id, document]));
      const items = repository.listDocuments<SupplierQuote>('quote')
        .filter(({ document }) => document.rfqId === rfqId)
        .map(({ document, version }) => publicQuote(repository, document, version, suppliers.get(document.supplierId)));
      sendJson(res, 200, { items }); return true;
    }
    if (method === 'POST' && compare) {
      const rfqId = decodeURIComponent(compare[1]!);
      getRfq(repository, rfqId);
      const body = await readBody(req);
      const key = idempotencyKey(req, body);
      const expectedRfqVersion = expectedVersion(body['expectedRfqVersion']);
      const comparison = normalizeComparison(body);
      const rfqLines = repository.listLines<RequestForQuotationLine>('rfq_line', rfqId);
      const suppliers = new Map(repository.listDocuments<Supplier>('supplier').map(({ document }) => [document.id, document]));
      const quotesForRfq = repository.listDocuments<SupplierQuote>('quote').filter(({ document }) => document.rfqId === rfqId);
      const lineComparisons = rfqLines.map((rfqLine) => {
        const quoteInputs: QuoteComparisonInput[] = [];
        for (const { document: quote, version } of quotesForRfq) {
          const line = repository.listLines<SupplierQuoteLine>('quote_line', quote.id).find((item) => item.rfqLineId === rfqLine.id);
          if (line) quoteInputs.push(quoteInput(quote, version, line, suppliers.get(quote.supplierId)));
        }
        const result = compareSupplierQuotes({
          quotes: quoteInputs, purchaseQuantity: rfqLine.requestedQty, uom: rfqLine.uom, ...comparison,
        });
        // A supplier may submit a revised quote under a distinct external ID.
        // Bind the computed row back by immutable quote-line ID, never by supplier.
        const identityByQuoteLine = new Map(quoteInputs.map((quote) => [quote.quoteLineId, { quoteId: quote.quoteId, quoteLineId: quote.quoteLineId, quoteVersion: quote.quoteVersion }]));
        const comparedQuotes = result.quotes.map((quote) => {
          const identity = quote.quoteLineId ? identityByQuoteLine.get(quote.quoteLineId) : undefined;
          if (!identity) throw new HttpError(422, '比价结果缺少报价行关联', 'QUOTE_COMPARISON_FAILED');
          return { ...quote, ...identity };
        });
        return {
          rfqLineId: rfqLine.id, lineNumber: rfqLine.lineNumber, itemId: rfqLine.itemId,
          ...result,
          quotes: comparedQuotes,
        };
      });
      const now = new Date().toISOString();
      const snapshot: QuoteComparisonSnapshot = {
        id: `quote-comparison:${randomUUID()}`,
        tenantId: context.session.tenantId,
        sourceSystem: 'readywork',
        externalId: `quote-comparison:${rfqId}:${key}`,
        status: 'final',
        createdAt: now,
        updatedAt: now,
        rfqId,
        rfqVersion: expectedRfqVersion,
        createdBy: context.session.humanId,
        asOf: comparison.asOf,
        comparisonCurrency: comparison.comparisonCurrency,
        rateSnapshot: comparison.rateSnapshot,
        weights: comparison.weights,
        ruleVersion: comparison.ruleVersion,
        lineComparisons,
      };
      const persisted = repository.persistQuoteComparison({
        idempotencyKey: key,
        payloadHash: payloadHash({ actorId: context.session.humanId, rfqId, expectedRfqVersion, comparison }),
        expectedRfqVersion,
        quoteVersions: quotesForRfq.map(({ document, version }) => ({ quoteId: document.id, version })),
        snapshot,
      });
      sendJson(res, persisted.replayed ? 200 : 201, {
        comparisonSnapshot: publicComparisonSnapshot(persisted.snapshot.document),
        rfq: publicRfq(repository, persisted.rfq.document, persisted.rfq.version),
        replayed: persisted.replayed,
      }); return true;
    }
    if (method === 'POST' && award) {
      const rfqId = decodeURIComponent(award[1]!);
      const storedRfq = getRfq(repository, rfqId);
      const body = await readBody(req);
      const key = idempotencyKey(req, body);
      const normalized = normalizeAward(body);
      if (storedRfq.document.comparisonSnapshotId !== normalized.comparisonSnapshotId) {
        throw new HttpError(409, '比较快照与 RFQ 当前待定标快照不一致', 'COMPARISON_SNAPSHOT_CONFLICT');
      }
      const result = repository.awardRfqAndCreateDraftPurchaseOrders({
        idempotencyKey: key,
        payloadHash: payloadHash({ actorId: context.session.humanId, rfqId, ...normalized }),
        rfqId,
        expectedRfqVersion: normalized.expectedRfqVersion,
        approvedBy: context.session.humanId,
        approvedAt: new Date().toISOString(),
        lines: normalized.selections.map((line) => ({ ...line, selectionReason: normalized.reason })),
      });
      sendJson(res, result.replayed ? 200 : 201, {
        award: publicAward(result.award.document, result.award.version, result.lines),
        purchaseOrders: result.purchaseOrders.map((po) => publicPurchaseOrder(
          po.purchaseOrder.document,
          po.purchaseOrder.version,
          po.lines,
          repository.getDocument<Supplier>('supplier', po.purchaseOrder.document.supplierId)?.document,
        )),
        rfq: publicRfq(repository, result.rfq.document, result.rfq.version),
        replayed: result.replayed,
      }); return true;
    }
    sendJson(res, 405, { error: `不支持的方法: ${method}`, code: 'METHOD_NOT_ALLOWED' }); return true;
  } catch (error) {
    if (error instanceof ProcurementInboundCommunicationIdempotencyConflictError) {
      sendJson(res, 409, { error: error.message, code: error.code }); return true;
    }
    if (error instanceof ProcurementQuoteComparisonIdempotencyConflictError || error instanceof ProcurementAwardIdempotencyConflictError) {
      sendJson(res, 409, { error: redactSensitive(error), code: 'IDEMPOTENCY_KEY_REUSED' }); return true;
    }
    if (error instanceof ProcurementRfqVersionConflictError || error instanceof ProcurementQuoteVersionConflictError || error instanceof ProcurementRfqStateConflictError || error instanceof ProcurementRfqAlreadyAwardedError) {
      sendJson(res, 409, { error: redactSensitive(error), code: error.code }); return true;
    }
    if (error instanceof ProcurementValidationError) {
      const status = error.code === 'RFQ_NOT_FOUND' || error.code === 'SUPPLIER_NOT_FOUND' || error.code === 'QUOTE_NOT_FOUND' || error.code === 'QUOTE_LINE_NOT_FOUND' ? 404 : 422;
      sendJson(res, status, { error: redactSensitive(error), code: error.code }); return true;
    }
    if (error instanceof SupplierSyncIdempotencyConflictError) {
      sendJson(res, 409, { error: error.message, code: 'IDEMPOTENCY_KEY_REUSED' }); return true;
    }
    if (error instanceof ProcurementCreateIdempotencyConflictError) {
      sendJson(res, 409, { error: error.message, code: 'IDEMPOTENCY_KEY_REUSED' }); return true;
    }
    if (error instanceof SupplierVersionConflictError) {
      sendJson(res, 409, {
        error: error.message,
        code: 'SUPPLIER_VERSION_CONFLICT',
        currentVersion: error.currentVersion,
        currentProfileVersion: error.currentProfileVersion,
      }); return true;
    }
    if (error instanceof ProcurementSupplierOperatingProfileVersionConflictError) {
      sendJson(res, 409, { error: error.message, code: 'SUPPLIER_VERSION_CONFLICT', currentProfileVersion: error.actualVersion }); return true;
    }
    if (error instanceof SupplierOperatingProfileValidationError) {
      sendJson(res, 422, { error: error.message, code: 'INVALID_SUPPLIER_PROFILE' }); return true;
    }
    if (error instanceof HttpError) { sendJson(res, error.status, { error: error.publicMessage, code: error.code }); return true; }
    if (supplierSync) { sendJson(res, 502, { error: publicIntegrationError(error), code: 'ODOO_SYNC_FAILED' }); return true; }
    if (error instanceof Error && /UNIQUE constraint failed: procurement_documents/.test(error.message)) {
      sendJson(res, 409, { error: '相同外部 ID 的采购单据已存在', code: 'EXTERNAL_ID_CONFLICT' }); return true;
    }
    if (error instanceof Error && /quotes\[|purchaseQuantity|weights|ruleVersion|rateSnapshot|汇率|转换规则/.test(error.message)) {
      sendJson(res, 422, { error: redactSensitive(error), code: 'QUOTE_COMPARISON_FAILED' }); return true;
    }
    throw error;
  }
}
