import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ProcurementRequisition,
  RequisitionAttachment,
  RequisitionLine,
  RequisitionSource,
} from '@readywork/core';
import {
  createProcurementRepository,
  ProcurementIdempotencyConflictError,
  type IdempotentRequisitionResult,
  type ProcurementRepository,
} from '@readywork/persistence';
import { can, type Session } from './auth.js';
import { HttpError } from './http-errors.js';
import { assessProcurementDocumentSecurity } from './procurement-document-security.js';
import type { AttachmentObjectMetadata, AttachmentObjectStorage } from './attachment-object-storage.js';
import { loadProcurementAttachmentContent } from './procurement-attachment-content.js';

interface RequisitionRouteContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly attachmentObjectStorage?: AttachmentObjectStorage;
}

interface StoredAttachmentRow {
  readonly id: string;
  readonly requisition_id: string;
  readonly requisition_line_id: string | null;
  readonly file_name: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly version: number;
  readonly supersedes_id: string | null;
  readonly extraction_status: 'text_extracted' | 'ready_for_document_agent';
  readonly extracted_text_preview: string | null;
  readonly security_status: 'pending_scan' | 'clean' | 'quarantined' | 'scan_failed';
  readonly processing_status: 'not_queued' | 'queued' | 'processing' | 'parsed' | 'parse_failed' | 'needs_ocr' | 'needs_specialist';
  readonly detected_content_type: string | null;
  readonly scan_error: string | null;
  readonly parse_error: string | null;
  readonly parsed_at: string | null;
  readonly storage_backend: 'sqlite' | 's3';
  readonly object_key: string | null;
  readonly storage_etag: string | null;
  readonly storage_encryption: string | null;
  readonly result_json?: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly content?: Uint8Array;
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_REQUISITION = 30;
const MAX_ATTACHMENT_BYTES_PER_TENANT = 512 * 1024 * 1024;
const BLOCKED_ATTACHMENT_TYPES = new Set(['text/html', 'image/svg+xml', 'application/javascript', 'text/javascript', 'application/x-msdownload']);
const SAFE_INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain']);

interface NormalizedLine {
  readonly lineNumber: string;
  readonly itemId: string;
  readonly itemCode?: string;
  readonly itemName?: string;
  readonly description?: string;
  readonly quantity: number;
  readonly uom: string;
  readonly targetDate: string;
  readonly technicalRequirements?: string;
}

interface NormalizedCreateRequisition {
  readonly source: RequisitionSource;
  readonly externalId?: string;
  readonly departmentId?: string;
  readonly currency?: string;
  readonly title?: string;
  readonly requestingDepartment?: string;
  readonly requesterName?: string;
  readonly targetDeliveryDate?: string;
  readonly lines: readonly NormalizedLine[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: IncomingMessage, maximumBytes = 1_048_576): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maximumBytes) throw new HttpError(413, `请求体超过 ${Math.floor(maximumBytes / 1024 / 1024)} MB 限制`, 'BODY_TOO_LARGE');
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, '请求体不是有效 JSON', 'INVALID_JSON');
  }
  if (!isRecord(parsed)) throw new HttpError(400, '请求体必须是 JSON 对象', 'INVALID_BODY');
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} 必填`, 'INVALID_REQUISITION');
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} 不能为空`, 'INVALID_REQUISITION');
  return value.trim();
}

function normalizedDate(value: unknown, field: string): string {
  const input = requiredString(value, field);
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) throw new HttpError(400, `${field} 必须是有效日期`, 'INVALID_REQUISITION');
  return new Date(timestamp).toISOString();
}

function normalizeLine(value: unknown, index: number, uiContract: boolean, fallbackTargetDate?: string): NormalizedLine {
  const prefix = `lines[${index}]`;
  if (!isRecord(value)) throw new HttpError(400, `${prefix} 必须是对象`, 'INVALID_REQUISITION');
  const quantity = value['quantity'] ?? value['requestedQty'];
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    throw new HttpError(400, `${prefix}.quantity 必须是正数`, 'INVALID_REQUISITION');
  }
  const attachmentsValue = value['attachments'] ?? [];
  if (!Array.isArray(attachmentsValue)) throw new HttpError(400, `${prefix}.attachments 必须是数组`, 'INVALID_REQUISITION');
  if (attachmentsValue.length > 0) {
    throw new HttpError(422, '采购需求必须先保存，再通过真实附件接口上传文件', 'ATTACHMENT_UPLOAD_REQUIRED');
  }
  const itemCode = typeof value['itemCode'] === 'string' ? value['itemCode'].trim() : undefined;
  const itemName = value['itemName'] === undefined
    ? undefined
    : requiredString(value['itemName'], `${prefix}.itemName`);
  if (uiContract && !itemName) throw new HttpError(400, `${prefix}.itemName 必填`, 'INVALID_REQUISITION');
  const itemId = uiContract
    ? itemCode || itemName!
    : requiredString(value['item'] ?? value['itemId'] ?? itemCode ?? itemName, `${prefix}.item`);
  const targetDateValue = value['targetDate'] ?? value['requiredAt'];
  const targetDate = targetDateValue === undefined || targetDateValue === null || targetDateValue === ''
    ? fallbackTargetDate
    : normalizedDate(targetDateValue, `${prefix}.targetDate`);
  if (!targetDate) {
    throw new HttpError(400, `${prefix}.targetDate 必填`, 'INVALID_REQUISITION');
  }
  return {
    lineNumber: optionalString(value['lineNumber'], `${prefix}.lineNumber`) ?? String((index + 1) * 10),
    itemId,
    ...(itemCode === undefined ? {} : { itemCode }),
    ...(itemName === undefined ? {} : { itemName }),
    ...(value['description'] === undefined && itemName === undefined
      ? {}
      : { description: value['description'] === undefined ? itemName! : requiredString(value['description'], `${prefix}.description`) }),
    quantity,
    uom: requiredString(value['unit'] ?? value['uom'], `${prefix}.${uiContract ? 'unit' : 'uom'}`),
    targetDate,
    ...(value['technicalRequirements'] === undefined
      ? {}
      : { technicalRequirements: requiredString(value['technicalRequirements'], `${prefix}.technicalRequirements`) }),
  };
}

function normalizeCreate(body: Record<string, unknown>, uiContract: boolean): NormalizedCreateRequisition {
  const source = requiredString(body['source'], 'source');
  if (!['manual', 'erp', 'excel'].includes(source)) {
    throw new HttpError(400, 'source 必须是 manual、erp 或 excel', 'INVALID_REQUISITION_SOURCE');
  }
  if (!Array.isArray(body['lines']) || body['lines'].length === 0) {
    throw new HttpError(400, 'lines 必须至少包含一行', 'INVALID_REQUISITION');
  }
  const targetDeliveryDate = body['targetDeliveryDate'] === undefined || body['targetDeliveryDate'] === null || body['targetDeliveryDate'] === ''
    ? undefined
    : normalizedDate(body['targetDeliveryDate'], 'targetDeliveryDate');
  const lines = body['lines'].map((line, index) => normalizeLine(line, index, uiContract, targetDeliveryDate));
  if (new Set(lines.map((line) => line.lineNumber)).size !== lines.length) {
    throw new HttpError(400, 'lineNumber 不能重复', 'INVALID_REQUISITION');
  }
  return {
    source: source as RequisitionSource,
    ...(body['externalId'] === undefined ? {} : { externalId: requiredString(body['externalId'], 'externalId') }),
    ...(body['departmentId'] === undefined && body['requestingDepartment'] === undefined
      ? {}
      : { departmentId: requiredString(body['departmentId'] ?? body['requestingDepartment'], 'departmentId') }),
    ...(body['currency'] === undefined
      ? (uiContract ? { currency: 'CNY' } : {})
      : { currency: requiredString(body['currency'], 'currency').toUpperCase() }),
    ...(body['title'] === undefined
      ? (uiContract ? { title: requiredString(body['title'], 'title') } : {})
      : { title: requiredString(body['title'], 'title') }),
    ...(body['requestingDepartment'] === undefined
      ? (uiContract ? { requestingDepartment: requiredString(body['requestingDepartment'], 'requestingDepartment') } : {})
      : { requestingDepartment: requiredString(body['requestingDepartment'], 'requestingDepartment') }),
    ...(body['requesterName'] === undefined
      ? (uiContract ? { requesterName: requiredString(body['requesterName'], 'requesterName') } : {})
      : { requesterName: requiredString(body['requesterName'], 'requesterName') }),
    ...(targetDeliveryDate ? { targetDeliveryDate } : {}),
    lines,
  };
}

function idempotencyKey(req: IncomingMessage, body: Record<string, unknown>): string {
  const header = req.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  const key = value ?? (typeof body['idempotencyKey'] === 'string' ? body['idempotencyKey'] : undefined);
  if (!key?.trim() || key.trim().length > 200) {
    throw new HttpError(400, 'Idempotency-Key 必填且不能超过 200 个字符', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  return key.trim();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cleanFileName(value: unknown): string {
  const raw = requiredString(value, 'fileName');
  const name = raw.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, '').trim() ?? '';
  if (!name || name.length > 255) throw new HttpError(400, '附件名称无效或超过 255 个字符', 'INVALID_ATTACHMENT');
  return name;
}

function normalizeUpload(body: Record<string, unknown>): {
  fileName: string; contentType: string; requisitionLineId?: string; content: Buffer;
} {
  const fileName = cleanFileName(body['fileName']);
  const contentType = requiredString(body['contentType'], 'contentType').toLowerCase().split(';', 1)[0]!;
  if (BLOCKED_ATTACHMENT_TYPES.has(contentType)) throw new HttpError(415, '该附件类型不允许上传', 'ATTACHMENT_TYPE_BLOCKED');
  const encoded = requiredString(body['dataBase64'], 'dataBase64');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new HttpError(400, '附件内容不是有效 Base64', 'INVALID_ATTACHMENT');
  const content = Buffer.from(encoded, 'base64');
  if (content.length === 0) throw new HttpError(400, '附件不能为空', 'INVALID_ATTACHMENT');
  if (content.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, '单个附件不能超过 8 MB', 'ATTACHMENT_TOO_LARGE');
  if (body['sizeBytes'] !== undefined && body['sizeBytes'] !== content.length) throw new HttpError(400, '附件大小与上传内容不一致', 'ATTACHMENT_SIZE_MISMATCH');
  return {
    fileName,
    contentType,
    ...(body['requisitionLineId'] === undefined || body['requisitionLineId'] === null || body['requisitionLineId'] === ''
      ? {}
      : { requisitionLineId: requiredString(body['requisitionLineId'], 'requisitionLineId') }),
    content,
  };
}

function publicAttachment(row: StoredAttachmentRow): RequisitionAttachment {
  return {
    id: row.id,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    url: `/api/procurement/attachments/${encodeURIComponent(row.id)}/content`,
    sha256: row.sha256,
    version: row.version,
    storageBackend: row.storage_backend,
    ...(row.requisition_line_id ? { requisitionLineId: row.requisition_line_id } : {}),
    uploadedBy: row.created_by,
    uploadedAt: row.created_at,
    extractionStatus: row.extraction_status,
    ...(row.extracted_text_preview ? { extractedTextPreview: row.extracted_text_preview } : {}),
    securityStatus: row.security_status,
    processingStatus: row.processing_status,
    ...(row.detected_content_type ? { detectedContentType: row.detected_content_type } : {}),
    ...(row.scan_error ? { scanError: row.scan_error } : {}),
    ...(row.parse_error ? { parseError: row.parse_error } : {}),
    ...(row.parsed_at ? { parsedAt: row.parsed_at } : {}),
    ...(row.result_json ? documentResultFields(row.result_json) : {}),
  };
}

function documentResultFields(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const structuredData = parsed['structuredData'];
    const parser = typeof parsed['parser'] === 'string' ? parsed['parser'] : undefined;
    const status = typeof parsed['status'] === 'string' ? parsed['status'] : undefined;
    return {
      ...(structuredData && typeof structuredData === 'object' ? { structuredData } : {}),
      ...(parser || status ? { parsedSummary: [parser ? `解析器 ${parser}` : '', status ? `结果 ${status}` : ''].filter(Boolean).join(' · ') } : {}),
    };
  } catch {
    return {};
  }
}

function listAttachments(db: DatabaseSync, tenantId: string, requisitionId: string): RequisitionAttachment[] {
  const rows = db.prepare(`SELECT a.id,a.requisition_id,a.requisition_line_id,a.file_name,a.content_type,a.size_bytes,a.sha256,a.version,
    a.supersedes_id,a.extraction_status,a.extracted_text_preview,a.security_status,a.processing_status,a.detected_content_type,
    a.scan_error,a.parse_error,a.parsed_at,a.storage_backend,a.object_key,a.storage_etag,a.storage_encryption,a.created_by,a.created_at,j.result_json
    FROM procurement_attachments a LEFT JOIN procurement_document_jobs j ON j.tenant_id=a.tenant_id AND j.attachment_id=a.id
    WHERE a.tenant_id=? AND a.requisition_id=? AND a.status='active'
    ORDER BY a.created_at,a.id`).all(tenantId, requisitionId) as unknown as StoredAttachmentRow[];
  return rows.map(publicAttachment);
}

function attachmentAudit(db: DatabaseSync, tenantId: string, requisitionId: string): Record<string, unknown>[] {
  return (db.prepare(`SELECT id,attachment_id,actor_id,action,detail_json,created_at
    FROM procurement_attachment_audit WHERE tenant_id=? AND requisition_id=? ORDER BY created_at,id`)
    .all(tenantId, requisitionId) as unknown as Array<{ id: string; attachment_id: string; actor_id: string; action: string; detail_json: string; created_at: string }>)
    .map((row) => ({ id: row.id, attachmentId: row.attachment_id, actorId: row.actor_id, action: row.action, detail: JSON.parse(row.detail_json), createdAt: row.created_at }));
}

function publicLine(line: RequisitionLine): Record<string, unknown> {
  return {
    id: line.id,
    lineNumber: line.lineNumber,
    item: line.itemId,
    itemCode: line.itemCode ?? line.itemId,
    itemName: line.itemName ?? line.description ?? line.itemId,
    ...(line.description ? { description: line.description } : {}),
    quantity: line.requestedQty,
    uom: line.uom,
    unit: line.uom,
    targetDate: line.requiredAt,
    ...(line.technicalRequirements ? { technicalRequirements: line.technicalRequirements } : {}),
    attachments: line.attachments ?? [],
  };
}

function publicRequisition(
  repository: ProcurementRepository,
  requisition: ProcurementRequisition,
  version: number,
  lines?: readonly RequisitionLine[],
  attachments: readonly RequisitionAttachment[] = [],
  attachmentEvents: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    id: requisition.id,
    source: requisition.source,
    externalId: requisition.externalId,
    status: requisition.status,
    requesterId: requisition.requesterId,
    title: requisition.title ?? `采购申请 ${requisition.externalId}`,
    requestingDepartment: requisition.requestingDepartment ?? requisition.departmentId ?? '',
    requesterName: requisition.requesterName ?? requisition.requesterId,
    ...(requisition.departmentId ? { departmentId: requisition.departmentId } : {}),
    requestedAt: requisition.requestedAt,
    currency: requisition.currency ?? 'CNY',
    ...(requisition.targetDeliveryDate ? { targetDeliveryDate: requisition.targetDeliveryDate } : {}),
    createdAt: requisition.createdAt,
    updatedAt: requisition.updatedAt,
    version,
    attachmentCount: attachments.length,
    attachments,
    attachmentEvents,
    lines: (lines ?? repository.listLines<RequisitionLine>('requisition_line', requisition.id)).map(publicLine),
  };
}

function buildRequisition(
  tenantId: string,
  requesterId: string,
  normalized: NormalizedCreateRequisition,
): { requisition: ProcurementRequisition; lines: RequisitionLine[] } {
  const now = new Date().toISOString();
  const requisitionId = `requisition:${randomUUID()}`;
  const requisition: ProcurementRequisition = {
    id: requisitionId,
    tenantId,
    sourceSystem: normalized.source,
    externalId: normalized.externalId ?? requisitionId,
    status: 'submitted',
    createdAt: now,
    updatedAt: now,
    source: normalized.source,
    requesterId,
    ...(normalized.departmentId ? { departmentId: normalized.departmentId } : {}),
    requestedAt: now,
    ...(normalized.currency ? { currency: normalized.currency } : {}),
    ...(normalized.title ? { title: normalized.title } : {}),
    ...(normalized.requestingDepartment ? { requestingDepartment: normalized.requestingDepartment } : {}),
    ...(normalized.requesterName ? { requesterName: normalized.requesterName } : {}),
    ...(normalized.targetDeliveryDate ? { targetDeliveryDate: normalized.targetDeliveryDate } : {}),
  };
  const lines = normalized.lines.map((line): RequisitionLine => {
    return {
      id: `requisition-line:${randomUUID()}`,
      requisitionId,
      lineNumber: line.lineNumber,
      itemId: line.itemId,
      ...(line.itemCode === undefined ? {} : { itemCode: line.itemCode }),
      ...(line.itemName === undefined ? {} : { itemName: line.itemName }),
      ...(line.description ? { description: line.description } : {}),
      requestedQty: line.quantity,
      uom: line.uom,
      requiredAt: line.targetDate,
      ...(line.technicalRequirements ? { technicalRequirements: line.technicalRequirements } : {}),
      attachmentIds: [],
      attachments: [],
    };
  });
  return { requisition, lines };
}

function sendCreatedResult(
  res: ServerResponse,
  repository: ProcurementRepository,
  result: IdempotentRequisitionResult,
): void {
  sendJson(res, result.replayed ? 200 : 201, {
    requisition: publicRequisition(repository, result.requisition.document, result.requisition.version, result.lines),
    replayed: result.replayed,
  });
}

/** 处理 Requisition 业务路由；不匹配时返回 false 交还给主路由。 */
export async function handleRequisitionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: RequisitionRouteContext,
): Promise<boolean> {
  const attachmentCollectionMatch = path.match(/^\/api\/procurement\/requisitions\/([^/]+)\/attachments$/);
  const attachmentContentMatch = path.match(/^\/api\/procurement\/attachments\/([^/]+)\/content$/);
  const attachmentRetryMatch = path.match(/^\/api\/procurement\/attachments\/([^/]+)\/retry$/);
  const uiContract = path === '/api/procurement/requisitions' || path.startsWith('/api/procurement/requisitions/');
  const collectionPath = uiContract ? '/api/procurement/requisitions' : '/api/requisitions';
  const itemMatch = uiContract
    ? path.match(/^\/api\/procurement\/requisitions\/([^/]+)$/)
    : path.match(/^\/api\/requisitions\/([^/]+)$/);
  if (path !== collectionPath && !itemMatch && !attachmentCollectionMatch && !attachmentContentMatch && !attachmentRetryMatch) return false;

  const session = context.session;
  if (!session) {
    sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
    return true;
  }
  const permission = method === 'GET' || method === 'HEAD' ? 'read' : 'operate';
  if (!can(session, permission)) {
    sendJson(res, 403, { error: `当前角色无「${permission}」权限`, code: 'FORBIDDEN' });
    return true;
  }

  const repository = createProcurementRepository(context.db, session.tenantId);
  try {
    if (method === 'POST' && attachmentCollectionMatch) {
      const requisitionId = decodeURIComponent(attachmentCollectionMatch[1]!);
      const requisition = repository.getDocument<ProcurementRequisition>('requisition', requisitionId);
      if (!requisition) throw new HttpError(404, '采购需求不存在', 'REQUISITION_NOT_FOUND');
      const body = await readBody(req, MAX_ATTACHMENT_REQUEST_BYTES);
      const key = idempotencyKey(req, body);
      const normalized = normalizeUpload(body);
      const lineIds = new Set(repository.listLines<RequisitionLine>('requisition_line', requisitionId).map((line) => line.id));
      if (normalized.requisitionLineId && !lineIds.has(normalized.requisitionLineId)) {
        throw new HttpError(400, '附件关联的物料行不属于该采购需求', 'ATTACHMENT_LINE_MISMATCH');
      }
      const sha256 = createHash('sha256').update(normalized.content).digest('hex');
      const security = assessProcurementDocumentSecurity({ fileName: normalized.fileName, declaredMimeType: normalized.contentType, bytes: normalized.content });
      const hash = createHash('sha256').update(stableStringify({ requisitionId, fileName: normalized.fileName, contentType: normalized.contentType, requisitionLineId: normalized.requisitionLineId ?? null, sha256 })).digest('hex');
      const now = new Date().toISOString();
      const id = `attachment:${randomUUID()}`;
      const isText = normalized.contentType === 'text/plain' || normalized.contentType === 'text/csv' || normalized.contentType === 'application/json';
      const extractedTextPreview = isText ? normalized.content.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500) : undefined;
      const extractionStatus = isText ? 'text_extracted' : 'ready_for_document_agent';
      const processingStatus = security.safeForProcessing ? 'queued' : 'parse_failed';
      const existingReplay = context.db.prepare(`SELECT payload_hash,result_json FROM procurement_attachment_idempotency WHERE tenant_id=? AND idempotency_key=?`)
        .get(session.tenantId, key) as { payload_hash: string; result_json: string } | undefined;
      if (existingReplay) {
        if (existingReplay.payload_hash !== hash) throw new HttpError(409, '幂等键已用于不同附件', 'IDEMPOTENCY_KEY_REUSED');
        sendJson(res, 200, { ...JSON.parse(existingReplay.result_json), replayed: true });
        return true;
      }
      const requisitionUsageBeforeUpload = context.db.prepare(`SELECT COUNT(*) AS count FROM procurement_attachments
        WHERE tenant_id=? AND requisition_id=? AND status='active'`).get(session.tenantId, requisitionId) as { count: number };
      if (Number(requisitionUsageBeforeUpload.count) >= MAX_ATTACHMENTS_PER_REQUISITION) {
        throw new HttpError(413, `每条采购需求最多保存 ${MAX_ATTACHMENTS_PER_REQUISITION} 个附件版本`, 'REQUISITION_ATTACHMENT_QUOTA_EXCEEDED');
      }
      const tenantUsageBeforeUpload = context.db.prepare(`SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM procurement_attachments
        WHERE tenant_id=? AND status='active'`).get(session.tenantId) as { bytes: number };
      if (Number(tenantUsageBeforeUpload.bytes) + normalized.content.length > MAX_ATTACHMENT_BYTES_PER_TENANT) {
        throw new HttpError(413, '当前租户的采购附件容量已达 512 MB 上限', 'TENANT_ATTACHMENT_QUOTA_EXCEEDED');
      }
      const previousBeforeUpload = context.db.prepare(`SELECT id,version FROM procurement_attachments
        WHERE tenant_id=? AND requisition_id=? AND ifnull(requisition_line_id,'')=ifnull(?,'') AND file_name=? AND status='active'
        ORDER BY version DESC LIMIT 1`).get(session.tenantId, requisitionId, normalized.requisitionLineId ?? null, normalized.fileName) as { id: string; version: number } | undefined;
      const reservedVersion = (previousBeforeUpload?.version ?? 0) + 1;
      let storedObject: AttachmentObjectMetadata | undefined;
      if (context.attachmentObjectStorage) {
        storedObject = await context.attachmentObjectStorage.put({
          tenantId: session.tenantId,
          attachmentId: id,
          version: reservedVersion,
          sha256,
          sizeBytes: normalized.content.length,
          body: normalized.content,
          contentType: normalized.contentType,
        });
      }
      let committed = false;
      context.db.exec('BEGIN IMMEDIATE');
      try {
        const replay = context.db.prepare(`SELECT payload_hash,result_json FROM procurement_attachment_idempotency WHERE tenant_id=? AND idempotency_key=?`)
          .get(session.tenantId, key) as { payload_hash: string; result_json: string } | undefined;
        if (replay) {
          if (replay.payload_hash !== hash) throw new HttpError(409, '幂等键已用于不同附件', 'IDEMPOTENCY_KEY_REUSED');
          context.db.exec('COMMIT');
          committed = true;
          if (storedObject && context.attachmentObjectStorage) {
            await context.attachmentObjectStorage.delete({ tenantId: session.tenantId, attachmentId: id, version: reservedVersion });
          }
          sendJson(res, 200, { ...JSON.parse(replay.result_json), replayed: true });
          return true;
        }
        const requisitionUsage = context.db.prepare(`SELECT COUNT(*) AS count FROM procurement_attachments
          WHERE tenant_id=? AND requisition_id=? AND status='active'`).get(session.tenantId, requisitionId) as { count: number };
        if (Number(requisitionUsage.count) >= MAX_ATTACHMENTS_PER_REQUISITION) {
          throw new HttpError(413, `每条采购需求最多保存 ${MAX_ATTACHMENTS_PER_REQUISITION} 个附件版本`, 'REQUISITION_ATTACHMENT_QUOTA_EXCEEDED');
        }
        const tenantUsage = context.db.prepare(`SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM procurement_attachments
          WHERE tenant_id=? AND status='active'`).get(session.tenantId) as { bytes: number };
        if (Number(tenantUsage.bytes) + normalized.content.length > MAX_ATTACHMENT_BYTES_PER_TENANT) {
          throw new HttpError(413, '当前租户的采购附件容量已达 512 MB 上限', 'TENANT_ATTACHMENT_QUOTA_EXCEEDED');
        }
        const previous = context.db.prepare(`SELECT id,version FROM procurement_attachments
          WHERE tenant_id=? AND requisition_id=? AND ifnull(requisition_line_id,'')=ifnull(?,'') AND file_name=? AND status='active'
          ORDER BY version DESC LIMIT 1`).get(session.tenantId, requisitionId, normalized.requisitionLineId ?? null, normalized.fileName) as { id: string; version: number } | undefined;
        const version = (previous?.version ?? 0) + 1;
        if (version !== reservedVersion) {
          throw new HttpError(409, '同名附件在上传期间已产生新版本，请重试', 'ATTACHMENT_VERSION_CONFLICT');
        }
        const storageBackend = storedObject ? 's3' : 'sqlite';
        const result = publicAttachment({
          id, requisition_id: requisitionId, requisition_line_id: normalized.requisitionLineId ?? null,
          file_name: normalized.fileName, content_type: normalized.contentType, size_bytes: normalized.content.length,
          sha256, version, supersedes_id: previous?.id ?? null, extraction_status: extractionStatus,
          extracted_text_preview: extractedTextPreview ?? null, security_status: security.securityStatus,
          processing_status: processingStatus, detected_content_type: security.detectedContentType,
          scan_error: security.safeForProcessing ? null : security.reason, parse_error: security.safeForProcessing ? null : security.reason,
          parsed_at: null, result_json: null, created_by: session.humanId, created_at: now,
          storage_backend: storageBackend, object_key: storedObject?.key ?? null, storage_etag: storedObject?.etag ?? null,
          storage_encryption: storedObject?.serverSideEncryption ?? null,
        });
        context.db.prepare(`INSERT INTO procurement_attachments
          (tenant_id,id,requisition_id,requisition_line_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,extraction_status,extracted_text_preview,
           security_status,processing_status,detected_content_type,scan_error,parse_error,storage_backend,object_key,storage_etag,storage_encryption,content,status,created_by,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`).run(
          session.tenantId, id, requisitionId, normalized.requisitionLineId ?? null, normalized.fileName,
          normalized.contentType, normalized.content.length, sha256, version, previous?.id ?? null,
          extractionStatus, extractedTextPreview ?? null, security.securityStatus, processingStatus, security.detectedContentType,
          security.safeForProcessing ? null : security.reason, security.safeForProcessing ? null : security.reason,
          storageBackend, storedObject?.key ?? null, storedObject?.etag ?? null, storedObject?.serverSideEncryption ?? null,
          storedObject ? Buffer.alloc(0) : normalized.content, session.humanId, now,
        );
        if (security.safeForProcessing) {
          context.db.prepare(`INSERT INTO procurement_document_jobs
            (tenant_id,id,attachment_id,status,attempts,max_attempts,available_at,created_at,updated_at)
            VALUES (?,?,?,'queued',0,3,?,?,?)`).run(session.tenantId, `document-job:${randomUUID()}`, id, now, now, now);
        }
        const auditId = `attachment-audit:${randomUUID()}`;
        context.db.prepare(`INSERT INTO procurement_attachment_audit
          (tenant_id,id,attachment_id,requisition_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(session.tenantId, auditId, id, requisitionId, session.humanId, 'uploaded', JSON.stringify({ fileName: normalized.fileName, version, sha256, requisitionLineId: normalized.requisitionLineId ?? null, storageBackend, securityStatus: security.securityStatus, securityReason: security.reason }), now);
        context.db.prepare(`INSERT INTO procurement_attachment_idempotency
          (tenant_id,idempotency_key,payload_hash,result_json,created_at) VALUES (?,?,?,?,?)`)
          .run(session.tenantId, key, hash, JSON.stringify({ attachment: result }), now);
        context.db.exec('COMMIT');
        committed = true;
        sendJson(res, 201, { attachment: result, replayed: false });
        return true;
      } catch (error) {
        if (!committed) context.db.exec('ROLLBACK');
        if (!committed && storedObject && context.attachmentObjectStorage) {
          try { await context.attachmentObjectStorage.delete({ tenantId: session.tenantId, attachmentId: id, version: reservedVersion }); } catch { /* orphan cleanup is best effort */ }
        }
        throw error;
      }
    }

    if (method === 'POST' && attachmentRetryMatch) {
      const attachmentId = decodeURIComponent(attachmentRetryMatch[1]!);
      const row = context.db.prepare(`SELECT a.requisition_id,a.security_status,j.id AS job_id FROM procurement_attachments a
        LEFT JOIN procurement_document_jobs j ON j.tenant_id=a.tenant_id AND j.attachment_id=a.id
        WHERE a.tenant_id=? AND a.id=? AND a.status='active'`).get(session.tenantId, attachmentId) as { requisition_id: string; security_status: string; job_id: string | null } | undefined;
      if (!row) throw new HttpError(404, '附件不存在', 'ATTACHMENT_NOT_FOUND');
      if (row.security_status === 'quarantined') throw new HttpError(409, '已隔离附件不能重试解析', 'ATTACHMENT_QUARANTINED');
      const now = new Date().toISOString();
      context.db.exec('BEGIN IMMEDIATE');
      try {
        if (row.job_id) {
          context.db.prepare(`UPDATE procurement_document_jobs SET status='queued',attempts=0,available_at=?,locked_at=NULL,lock_token=NULL,
            lease_expires_at=NULL,error=NULL,result_json=NULL,completed_at=NULL,updated_at=? WHERE tenant_id=? AND id=?`)
            .run(now, now, session.tenantId, row.job_id);
        } else {
          context.db.prepare(`INSERT INTO procurement_document_jobs
            (tenant_id,id,attachment_id,status,attempts,max_attempts,available_at,created_at,updated_at)
            VALUES (?,?,?,'queued',0,3,?,?,?)`).run(session.tenantId, `document-job:${randomUUID()}`, attachmentId, now, now, now);
        }
        context.db.prepare(`UPDATE procurement_attachments SET processing_status='queued',parse_error=NULL,parsed_at=NULL WHERE tenant_id=? AND id=?`)
          .run(session.tenantId, attachmentId);
        context.db.prepare(`INSERT INTO procurement_attachment_audit
          (tenant_id,id,attachment_id,requisition_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(session.tenantId, `attachment-audit:${randomUUID()}`, attachmentId, row.requisition_id, session.humanId, 'document_retry_requested', '{}', now);
        context.db.exec('COMMIT');
      } catch (error) { context.db.exec('ROLLBACK'); throw error; }
      sendJson(res, 202, { attachmentId, processingStatus: 'queued' });
      return true;
    }

    if ((method === 'GET' || method === 'HEAD') && attachmentCollectionMatch) {
      const requisitionId = decodeURIComponent(attachmentCollectionMatch[1]!);
      if (!repository.getDocument<ProcurementRequisition>('requisition', requisitionId)) throw new HttpError(404, '采购需求不存在', 'REQUISITION_NOT_FOUND');
      sendJson(res, 200, { items: listAttachments(context.db, session.tenantId, requisitionId), audit: attachmentAudit(context.db, session.tenantId, requisitionId) });
      return true;
    }

    if ((method === 'GET' || method === 'HEAD') && attachmentContentMatch) {
      const attachmentId = decodeURIComponent(attachmentContentMatch[1]!);
      const row = context.db.prepare(`SELECT id,requisition_id,requisition_line_id,file_name,content_type,size_bytes,sha256,version,
        supersedes_id,extraction_status,extracted_text_preview,security_status,processing_status,detected_content_type,scan_error,parse_error,parsed_at,
        storage_backend,object_key,storage_etag,storage_encryption,created_by,created_at,content
        FROM procurement_attachments WHERE tenant_id=? AND id=? AND status='active'`)
        .get(session.tenantId, attachmentId) as unknown as StoredAttachmentRow | undefined;
      if (!row) throw new HttpError(404, '附件不存在', 'ATTACHMENT_NOT_FOUND');
      if (row.security_status === 'quarantined') throw new HttpError(423, '附件已进入隔离区，禁止下载', 'ATTACHMENT_QUARANTINED');
      let content: Uint8Array;
      try {
        content = await loadProcurementAttachmentContent({
          tenantId: session.tenantId,
          attachmentId: row.id,
          version: row.version,
          sha256: row.sha256,
          sizeBytes: row.size_bytes,
          storageBackend: row.storage_backend,
          objectKey: row.object_key,
          content: row.content,
        }, context.attachmentObjectStorage);
      } catch (error) {
        throw new HttpError(503, error instanceof Error ? error.message : '附件存储不可用', 'ATTACHMENT_STORAGE_UNAVAILABLE');
      }
      if (method === 'GET') {
        const now = new Date().toISOString();
        context.db.prepare(`INSERT INTO procurement_attachment_audit
          (tenant_id,id,attachment_id,requisition_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(session.tenantId, `attachment-audit:${randomUUID()}`, attachmentId, row.requisition_id, session.humanId, 'downloaded', JSON.stringify({ version: row.version }), now);
      }
      res.writeHead(200, {
        'content-type': row.content_type,
        'content-length': String(row.size_bytes),
        'content-disposition': `${SAFE_INLINE_TYPES.has(row.content_type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'cache-control': 'private, no-store',
        etag: `"sha256-${row.sha256}"`,
      });
      if (method === 'HEAD') res.end(); else res.end(Buffer.from(content));
      return true;
    }

    if (method === 'POST' && path === collectionPath) {
      const body = await readBody(req);
      const key = idempotencyKey(req, body);
      const normalized = normalizeCreate(body, uiContract);
      const payloadHash = createHash('sha256')
        .update(stableStringify({ requesterId: session.humanId, ...normalized }))
        .digest('hex');
      const created = buildRequisition(session.tenantId, session.humanId, normalized);
      const result = repository.createRequisitionIdempotent({
        idempotencyKey: key,
        payloadHash,
        ...created,
      });
      if (uiContract) {
        sendJson(res, result.replayed ? 200 : 201, {
          ...publicRequisition(repository, result.requisition.document, result.requisition.version, result.lines,
            listAttachments(context.db, session.tenantId, result.requisition.document.id),
            attachmentAudit(context.db, session.tenantId, result.requisition.document.id)),
          replayed: result.replayed,
        });
      } else {
        sendCreatedResult(res, repository, result);
      }
      return true;
    }

    if ((method === 'GET' || method === 'HEAD') && path === collectionPath) {
      const items = repository.listDocuments<ProcurementRequisition>('requisition').map(({ document, version }) =>
        publicRequisition(repository, document, version, undefined,
          listAttachments(context.db, session.tenantId, document.id),
          attachmentAudit(context.db, session.tenantId, document.id)));
      sendJson(res, 200, { items });
      return true;
    }

    if ((method === 'GET' || method === 'HEAD') && itemMatch) {
      const id = decodeURIComponent(itemMatch[1]!);
      const stored = repository.getDocument<ProcurementRequisition>('requisition', id);
      if (!stored) {
        sendJson(res, 404, { error: '采购申请不存在', code: 'REQUISITION_NOT_FOUND' });
        return true;
      }
      const requisition = publicRequisition(repository, stored.document, stored.version, undefined,
        listAttachments(context.db, session.tenantId, stored.document.id),
        attachmentAudit(context.db, session.tenantId, stored.document.id));
      sendJson(res, 200, uiContract ? requisition : { requisition });
      return true;
    }

    sendJson(res, 405, { error: `不支持的方法: ${method}`, code: 'METHOD_NOT_ALLOWED' });
    return true;
  } catch (error) {
    if (error instanceof ProcurementIdempotencyConflictError) {
      sendJson(res, 409, { error: error.message, code: 'IDEMPOTENCY_KEY_REUSED' });
      return true;
    }
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.publicMessage, code: error.code });
      return true;
    }
    if (error instanceof Error && /UNIQUE constraint failed: procurement_documents/.test(error.message)) {
      sendJson(res, 409, { error: '相同来源的采购申请已存在', code: 'REQUISITION_ALREADY_EXISTS' });
      return true;
    }
    throw error;
  }
}
