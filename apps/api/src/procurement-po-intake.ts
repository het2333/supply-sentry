import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { InboundEmail } from '@readywork/connectors';
import type { PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { can, type Session } from './auth.js';
import { assessProcurementDocumentSecurity } from './procurement-document-security.js';

type OwnerType = 'po_intake' | 'purchase_order';
type IntakeStatus = 'received' | 'scanning' | 'parsing' | 'needs_review' | 'rejected' | 'accepted';

interface IntakeContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly now?: () => Date;
}

interface IntakeRow {
  tenant_id: string; id: string; provider: string; mailbox: string; provider_uid: string; message_id: string | null;
  sender: string; subject: string; received_at: string; attachment_id: string; status: IntakeStatus;
  parsed_header_json: string | null; parsed_lines_json: string | null; parser_confidence: number | null;
  warnings_json: string; supplier_match_json: string | null; accepted_po_id: string | null; rejection_reason: string | null;
  version: number; created_by: string; updated_by: string; created_at: string; updated_at: string;
}

interface AttachmentRow {
  id: string; file_name: string; content_type: string; size_bytes: number; sha256: string; security_status: string;
  processing_status: string; detected_content_type: string | null; scan_error: string | null; parse_error: string | null;
  parsed_at: string | null; extracted_text_preview: string | null; result_json: string | null;
}

export function persistInboundEmailAttachments(input: {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  readonly provider: string;
  readonly mailbox: string;
  readonly email: InboundEmail;
  readonly ownerType: OwnerType;
  readonly ownerId?: string;
}): { attachmentIds: string[]; candidateIds: string[]; replayed: boolean } {
  const attachments = input.email.attachments ?? [];
  if (attachments.length === 0) return { attachmentIds: [], candidateIds: [], replayed: false };
  if (input.ownerType === 'purchase_order' && !input.ownerId) throw new Error('PO 附件必须关联采购订单');
  const at = validDate(input.email.receivedAt) ?? new Date().toISOString();
  const attachmentIds: string[] = [];
  const candidateIds: string[] = [];
  let replayed = true;
  input.db.exec('BEGIN IMMEDIATE');
  try {
    attachments.forEach((attachment, index) => {
      const bytes = Buffer.from(attachment.content);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const identity = createHash('sha256').update(`${input.tenantId}\0${input.provider}\0${input.mailbox}\0${input.email.id}\0${index}\0${sha256}`).digest('hex').slice(0, 32);
      const attachmentId = `attachment:email:${identity}`;
      const candidateId = `po-intake:${identity}`;
      const ownerId = input.ownerType === 'po_intake' ? candidateId : input.ownerId!;
      attachmentIds.push(attachmentId);
      const exists = input.db.prepare(`SELECT 1 AS ok FROM procurement_attachments WHERE tenant_id=? AND id=?`)
        .get(input.tenantId, attachmentId);
      if (!exists) {
        replayed = false;
        const security = assessProcurementDocumentSecurity({ fileName: attachment.filename, declaredMimeType: attachment.contentType, bytes });
        input.db.prepare(`INSERT INTO procurement_attachments
          (tenant_id,id,requisition_id,requisition_line_id,owner_type,owner_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,
           extraction_status,extracted_text_preview,content,status,security_status,processing_status,detected_content_type,scan_error,parse_error,
           storage_backend,created_by,created_at)
          VALUES (?,?,?,NULL,?,?,?,?,?,?,1,NULL,'ready_for_document_agent',NULL,?,'active',?,?,?,?,?,'sqlite','connector:email',?)`)
          .run(input.tenantId, attachmentId, ownerId, input.ownerType, ownerId, attachment.filename, attachment.contentType.toLowerCase(), bytes.length, sha256, bytes,
            security.securityStatus, security.safeForProcessing ? 'queued' : 'parse_failed', security.detectedContentType,
            security.safeForProcessing ? null : security.reason, security.safeForProcessing ? null : security.reason, at);
        input.db.prepare(`INSERT INTO procurement_attachment_audit
          (tenant_id,id,attachment_id,requisition_id,actor_id,action,owner_type,owner_id,detail_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.tenantId, `attachment-audit:${randomUUID()}`, attachmentId, ownerId,
            'connector:email', input.ownerType === 'po_intake' ? 'email_po_attachment_received' : 'po_email_attachment_received', input.ownerType, ownerId,
            JSON.stringify({ provider: input.provider, mailbox: input.mailbox, providerUid: input.email.id, messageId: input.email.messageId ?? null, index, securityStatus: security.securityStatus }), at);
        if (security.safeForProcessing) input.db.prepare(`INSERT INTO procurement_document_jobs
          (tenant_id,id,attachment_id,status,attempts,max_attempts,available_at,created_at,updated_at)
          VALUES (?,?,?,'queued',0,3,?,?,?)`).run(input.tenantId, `document-job:${identity}`, attachmentId, at, at, at);
        if (input.ownerType === 'po_intake') {
          candidateIds.push(candidateId);
          input.db.prepare(`INSERT INTO procurement_po_intake_candidates
            (tenant_id,id,provider,mailbox,provider_uid,message_id,sender,subject,received_at,attachment_id,status,warnings_json,version,created_by,updated_by,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,'[]',1,'connector:email','connector:email',?,?)`)
            .run(input.tenantId, candidateId, input.provider, input.mailbox, input.email.id, input.email.messageId ?? null,
              input.email.from, input.email.subject, at, attachmentId, security.safeForProcessing ? 'scanning' : 'rejected', at, at);
          if (!security.safeForProcessing) input.db.prepare(`UPDATE procurement_po_intake_candidates SET rejection_reason=? WHERE tenant_id=? AND id=?`)
            .run(security.reason, input.tenantId, candidateId);
        }
      } else if (input.ownerType === 'po_intake') candidateIds.push(candidateId);
    });
    input.db.exec('COMMIT');
    return { attachmentIds, candidateIds, replayed };
  } catch (error) {
    try { input.db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
    throw error;
  }
}

export function refreshPoIntakeCandidateForAttachment(db: DatabaseSync, tenantId: string, attachmentId: string): void {
  const row = db.prepare(`SELECT a.security_status,a.processing_status,a.scan_error,a.parse_error,j.status AS job_status,j.result_json
    FROM procurement_attachments a LEFT JOIN procurement_document_jobs j ON j.tenant_id=a.tenant_id AND j.attachment_id=a.id
    WHERE a.tenant_id=? AND a.id=?`).get(tenantId, attachmentId) as Record<string, string | null> | undefined;
  if (!row) return;
  const terminal = db.prepare(`SELECT status FROM procurement_po_intake_candidates WHERE tenant_id=? AND attachment_id=?`)
    .get(tenantId, attachmentId) as { status: IntakeStatus } | undefined;
  if (!terminal || terminal.status === 'accepted' || terminal.status === 'rejected') return;
  let status: IntakeStatus = 'parsing';
  let reason: string | null = null;
  if (row['security_status'] === 'quarantined') { status = 'rejected'; reason = row['scan_error'] ?? '文件未通过安全检查'; }
  else if (row['job_status'] === 'failed' && row['processing_status'] === 'parse_failed') { status = 'rejected'; reason = row['parse_error'] ?? '文档解析失败'; }
  else if (row['security_status'] === 'clean' && row['processing_status'] === 'parsed') status = 'needs_review';
  else if (row['security_status'] !== 'clean') status = 'scanning';
  db.prepare(`UPDATE procurement_po_intake_candidates SET status=?,rejection_reason=COALESCE(?,rejection_reason),version=version+1,updated_by='document-worker',updated_at=?
    WHERE tenant_id=? AND attachment_id=? AND status NOT IN ('accepted','rejected') AND status<>?`)
    .run(status, reason, new Date().toISOString(), tenantId, attachmentId, status);
}

export async function handleProcurementPoIntakeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: IntakeContext,
): Promise<boolean> {
  const root = path === '/api/procurement/po-intake';
  const item = path.match(/^\/api\/procurement\/po-intake\/([^/]+)$/);
  const accept = path.match(/^\/api\/procurement\/po-intake\/([^/]+)\/accept$/);
  const reject = path.match(/^\/api\/procurement\/po-intake\/([^/]+)\/reject$/);
  if (!root && !item && !accept && !reject) return false;
  if (!context.session) return json(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { db, session } = context;
  if (!can(session, 'read')) return json(res, 403, { error: '无读取 PO 待核验队列权限', code: 'FORBIDDEN' });
  try {
    if (root && method === 'GET') {
      synchronizeTenantCandidates(db, session.tenantId);
      const rows = db.prepare(`SELECT * FROM procurement_po_intake_candidates WHERE tenant_id=? ORDER BY received_at DESC,id DESC`)
        .all(session.tenantId) as unknown as IntakeRow[];
      return json(res, 200, { items: rows.map((row) => present(db, row)), suppliers: supplierOptions(db, session.tenantId), permissions: { operate: can(session, 'operate'), approve: can(session, 'approve') } });
    }
    if (item && method === 'GET') {
      const id = decodeURIComponent(item[1]!); synchronizeCandidate(db, session.tenantId, id);
      const row = findCandidate(db, session.tenantId, id); if (!row) return json(res, 404, { error: 'PO 待核验记录不存在', code: 'PO_INTAKE_NOT_FOUND' });
      return json(res, 200, { item: present(db, row), suppliers: supplierOptions(db, session.tenantId), permissions: { operate: can(session, 'operate'), approve: can(session, 'approve') } });
    }
    if (accept && method === 'POST') {
      if (!can(session, 'approve')) return json(res, 403, { error: '人工核验并生成 PO 需要审批权限', code: 'FORBIDDEN' });
      const id = decodeURIComponent(accept[1]!); const body = await readJson(req); const result = acceptCandidate(db, session, id, body, context.now?.() ?? new Date());
      return json(res, result.replayed ? 200 : 201, result);
    }
    if (reject && method === 'POST') {
      if (!can(session, 'operate')) return json(res, 403, { error: '无驳回 PO 待核验记录权限', code: 'FORBIDDEN' });
      const id = decodeURIComponent(reject[1]!); const body = await readJson(req);
      const expectedVersion = positiveInt(body['expectedVersion'], 'expectedVersion'); const reason = text(body['reason'], 'reason', 500);
      const current = findCandidate(db, session.tenantId, id); if (!current) return json(res, 404, { error: 'PO 待核验记录不存在', code: 'PO_INTAKE_NOT_FOUND' });
      if (current.version !== expectedVersion) return json(res, 409, { error: '记录版本已变化', code: 'PO_INTAKE_VERSION_CONFLICT', currentVersion: current.version });
      if (current.status === 'accepted') return json(res, 409, { error: '已接受的 PO 不能驳回', code: 'PO_INTAKE_STATE_CONFLICT' });
      db.prepare(`UPDATE procurement_po_intake_candidates SET status='rejected',rejection_reason=?,version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND id=? AND version=?`)
        .run(reason, session.humanId, (context.now?.() ?? new Date()).toISOString(), session.tenantId, id, expectedVersion);
      return json(res, 200, { item: present(db, findCandidate(db, session.tenantId, id)!) });
    }
    return json(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    if (error instanceof IntakeError) return json(res, error.status, { error: error.message, code: error.code, ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) });
    throw error;
  }
}

function acceptCandidate(db: DatabaseSync, session: Session, id: string, body: Record<string, unknown>, now: Date): { item: unknown; purchaseOrder: PurchaseOrder; lines: PurchaseOrderLine[]; replayed: boolean } {
  const current = findCandidate(db, session.tenantId, id); if (!current) throw new IntakeError(404, 'PO_INTAKE_NOT_FOUND', 'PO 待核验记录不存在');
  if (current.status === 'accepted' && current.accepted_po_id) {
    const stored = document<PurchaseOrder>(db, session.tenantId, 'purchase_order', current.accepted_po_id);
    if (!stored) throw new IntakeError(409, 'PO_INTAKE_STATE_CONFLICT', '已接受记录引用的 PO 不存在');
    return { item: present(db, current), purchaseOrder: stored, lines: lines(db, session.tenantId, stored.id), replayed: true };
  }
  const expectedVersion = positiveInt(body['expectedVersion'], 'expectedVersion');
  if (current.version !== expectedVersion) throw new IntakeError(409, 'PO_INTAKE_VERSION_CONFLICT', '记录版本已变化', current.version);
  synchronizeCandidate(db, session.tenantId, id);
  const ready = findCandidate(db, session.tenantId, id)!;
  if (ready.version !== expectedVersion && ready.status !== current.status) throw new IntakeError(409, 'PO_INTAKE_VERSION_CONFLICT', '安全处理状态已变化，请刷新后重试', ready.version);
  if (ready.status !== 'needs_review') throw new IntakeError(422, 'PO_INTAKE_NOT_READY', 'PO 附件必须通过 ClamAV 且完成解析后才能接受');
  const attachment = attachmentRow(db, session.tenantId, ready.attachment_id);
  if (!attachment || attachment.security_status !== 'clean' || attachment.processing_status !== 'parsed') throw new IntakeError(422, 'PO_INTAKE_NOT_READY', '附件安全或解析状态未就绪');
  const purchaseOrderNumber = text(body['purchaseOrderNumber'], 'purchaseOrderNumber', 120);
  const supplierId = text(body['supplierId'], 'supplierId', 240); const currency = text(body['currency'], 'currency', 8).toUpperCase();
  const orderedAt = iso(body['orderedAt'], 'orderedAt');
  const supplier = document<Supplier>(db, session.tenantId, 'supplier', supplierId); if (!supplier) throw new IntakeError(422, 'SUPPLIER_NOT_FOUND', '所选供应商不存在');
  if (!Array.isArray(body['lines']) || body['lines'].length === 0) throw new IntakeError(422, 'INVALID_PO_INTAKE', 'PO 至少需要一行物料');
  const at = now.toISOString(); const poId = `po:email:${randomUUID()}`;
  const po: PurchaseOrder & Record<string, unknown> = { id: poId, tenantId: session.tenantId, sourceSystem: 'email-intake', externalId: purchaseOrderNumber, status: 'draft', createdAt: at, updatedAt: at, supplierId, currency, orderedAt, sourceAttachmentId: ready.attachment_id, intakeCandidateId: ready.id };
  const poLines = body['lines'].map((value, index) => normalizeLine(value, index, poId, session.tenantId, currency));
  if (new Set(poLines.map((line) => line.lineNumber)).size !== poLines.length) throw new IntakeError(422, 'INVALID_PO_INTAKE', 'PO 行号不能重复');
  db.exec('BEGIN IMMEDIATE');
  try {
    const duplicate = db.prepare(`SELECT id FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND source_system='email-intake' AND external_id=?`).get(session.tenantId, purchaseOrderNumber);
    if (duplicate) throw new IntakeError(409, 'PO_NUMBER_CONFLICT', '该邮箱 PO 编号已存在');
    db.prepare(`INSERT INTO procurement_documents (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at) VALUES (?,'purchase_order',?,?,?,?,1,?,?,?)`)
      .run(session.tenantId, po.id, po.sourceSystem, po.externalId, po.status, JSON.stringify(po), at, at);
    const insertLine = db.prepare(`INSERT INTO procurement_lines (tenant_id,kind,id,document_id,line_number,json) VALUES (?,'purchase_order_line',?,?,?,?)`);
    for (const line of poLines) insertLine.run(session.tenantId, line.id, po.id, line.lineNumber, JSON.stringify(line));
    db.prepare(`INSERT INTO procurement_po_stage_events (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
      VALUES (?,?,?,'po_sent','email_intake_accepted','active',?,'attachment',?,?,?,?)`)
      .run(session.tenantId, `po-stage-event:${randomUUID()}`, po.id, at, ready.attachment_id, session.humanId,
        JSON.stringify({ candidateId: ready.id, attachmentId: ready.attachment_id, messageId: ready.message_id, note: '人工核验已生成 PO 草稿，尚未对外发送' }), at);
    const changed = db.prepare(`UPDATE procurement_po_intake_candidates SET status='accepted',accepted_po_id=?,parsed_header_json=?,parsed_lines_json=?,version=version+1,updated_by=?,updated_at=?
      WHERE tenant_id=? AND id=? AND version=? AND status='needs_review'`)
      .run(po.id, JSON.stringify({ purchaseOrderNumber, supplierId, currency, orderedAt }), JSON.stringify(poLines), session.humanId, at, session.tenantId, id, expectedVersion);
    if (changed.changes !== 1) throw new IntakeError(409, 'PO_INTAKE_VERSION_CONFLICT', '记录版本或状态已变化', findCandidate(db, session.tenantId, id)?.version);
    db.prepare(`UPDATE procurement_attachments SET requisition_id=?,owner_type='purchase_order',owner_id=? WHERE tenant_id=? AND id=?`).run(po.id, po.id, session.tenantId, ready.attachment_id);
    db.prepare(`INSERT INTO procurement_attachment_audit (tenant_id,id,attachment_id,requisition_id,actor_id,action,owner_type,owner_id,detail_json,created_at)
      VALUES (?,?,?,?,?,'po_intake_accepted','purchase_order',?,?,?)`).run(session.tenantId, `attachment-audit:${randomUUID()}`, ready.attachment_id, po.id, session.humanId, po.id, JSON.stringify({ candidateId: id, poId: po.id }), at);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* no-op */ } throw error; }
  return { item: present(db, findCandidate(db, session.tenantId, id)!), purchaseOrder: po, lines: poLines, replayed: false };
}

function normalizeLine(value: unknown, index: number, poId: string, tenantId: string, currency: string): PurchaseOrderLine {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntakeError(422, 'INVALID_PO_INTAKE', `lines[${index}] 必须是对象`);
  const row = value as Record<string, unknown>; const orderedQty = positiveNumber(row['orderedQty'], `lines[${index}].orderedQty`); const unitPrice = nonNegativeNumber(row['unitPrice'], `lines[${index}].unitPrice`);
  const lineNumber = row['lineNumber'] === undefined ? String((index + 1) * 10) : text(row['lineNumber'], `lines[${index}].lineNumber`, 40);
  const requestedAt = iso(row['requestedAt'], `lines[${index}].requestedAt`);
  return { id: `po-line:email:${randomUUID()}`, poId, lineNumber, itemId: text(row['itemId'], `lines[${index}].itemId`, 240),
    ...(typeof row['description'] === 'string' && row['description'].trim() ? { description: row['description'].trim().slice(0, 500) } : {}),
    uom: text(row['uom'], `lines[${index}].uom`, 40), orderedQty, unitPrice, currency, requestedAt };
}

function synchronizeTenantCandidates(db: DatabaseSync, tenantId: string): void {
  const rows = db.prepare(`SELECT attachment_id FROM procurement_po_intake_candidates WHERE tenant_id=? AND status NOT IN ('accepted','rejected')`).all(tenantId) as Array<{ attachment_id: string }>;
  for (const row of rows) refreshPoIntakeCandidateForAttachment(db, tenantId, row.attachment_id);
}
function synchronizeCandidate(db: DatabaseSync, tenantId: string, id: string): void {
  const row = findCandidate(db, tenantId, id); if (row) refreshPoIntakeCandidateForAttachment(db, tenantId, row.attachment_id);
}
function findCandidate(db: DatabaseSync, tenantId: string, id: string): IntakeRow | undefined {
  return db.prepare(`SELECT * FROM procurement_po_intake_candidates WHERE tenant_id=? AND id=?`).get(tenantId, id) as unknown as IntakeRow | undefined;
}
function attachmentRow(db: DatabaseSync, tenantId: string, id: string): AttachmentRow | undefined {
  return db.prepare(`SELECT a.id,a.file_name,a.content_type,a.size_bytes,a.sha256,a.security_status,a.processing_status,a.detected_content_type,a.scan_error,a.parse_error,a.parsed_at,a.extracted_text_preview,j.result_json
    FROM procurement_attachments a LEFT JOIN procurement_document_jobs j ON j.tenant_id=a.tenant_id AND j.attachment_id=a.id WHERE a.tenant_id=? AND a.id=?`)
    .get(tenantId, id) as unknown as AttachmentRow | undefined;
}
function present(db: DatabaseSync, row: IntakeRow): Record<string, unknown> {
  const attachment = attachmentRow(db, row.tenant_id, row.attachment_id);
  return { id: row.id, provider: row.provider, mailbox: row.mailbox, providerUid: row.provider_uid, messageId: row.message_id,
    sender: row.sender, subject: row.subject, receivedAt: row.received_at, status: row.status, version: row.version,
    parsedHeader: safeJson(row.parsed_header_json), parsedLines: safeJson(row.parsed_lines_json), parserConfidence: row.parser_confidence,
    warnings: safeJson(row.warnings_json) ?? [], supplierMatch: safeJson(row.supplier_match_json), acceptedPoId: row.accepted_po_id,
    rejectionReason: row.rejection_reason, attachment: attachment ? { id: attachment.id, fileName: attachment.file_name, contentType: attachment.content_type,
      sizeBytes: attachment.size_bytes, sha256: attachment.sha256, securityStatus: attachment.security_status, processingStatus: attachment.processing_status,
      detectedContentType: attachment.detected_content_type, scanError: attachment.scan_error, parseError: attachment.parse_error,
      parsedAt: attachment.parsed_at, extractedTextPreview: attachment.extracted_text_preview, parserOutput: safeJson(attachment.result_json),
      contentUrl: `/api/procurement/attachments/${encodeURIComponent(attachment.id)}/content` } : null,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function document<T>(db: DatabaseSync, tenantId: string, kind: string, id: string): T | undefined { const row = db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND kind=? AND id=?`).get(tenantId, kind, id) as { json: string } | undefined; return row ? JSON.parse(row.json) as T : undefined; }
function lines(db: DatabaseSync, tenantId: string, poId: string): PurchaseOrderLine[] { return (db.prepare(`SELECT json FROM procurement_lines WHERE tenant_id=? AND kind='purchase_order_line' AND document_id=? ORDER BY line_number`).all(tenantId, poId) as Array<{ json: string }>).map((row) => JSON.parse(row.json) as PurchaseOrderLine); }
function supplierOptions(db: DatabaseSync, tenantId: string): Array<{ id: string; name: string; currency: string }> { return (db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='supplier' ORDER BY updated_at DESC,id`).all(tenantId) as Array<{ json: string }>).map((row) => JSON.parse(row.json) as Supplier).map((supplier) => ({ id: supplier.id, name: supplier.name, currency: supplier.currency })); }
function safeJson(value: string | null): unknown { if (!value) return null; try { return JSON.parse(value) as unknown; } catch { return null; } }
function validDate(value: string): string | undefined { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : undefined; }
function iso(value: unknown, field: string): string { if (typeof value !== 'string' || !validDate(value)) throw new IntakeError(422, 'INVALID_PO_INTAKE', `${field} 必须是有效日期`); return validDate(value)!; }
function text(value: unknown, field: string, max: number): string { if (typeof value !== 'string' || !value.trim()) throw new IntakeError(422, 'INVALID_PO_INTAKE', `${field} 必填`); return value.trim().slice(0, max); }
function positiveInt(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new IntakeError(422, 'INVALID_PO_INTAKE', `${field} 必须是正整数`); return Number(value); }
function positiveNumber(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new IntakeError(422, 'INVALID_PO_INTAKE', `${field} 必须是正数`); return value; }
function nonNegativeNumber(value: unknown, field: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new IntakeError(422, 'INVALID_PO_INTAKE', `${field} 必须是非负数`); return value; }
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > 1_048_576) throw new IntakeError(413, 'BODY_TOO_LARGE', '请求体超过 1 MB'); chunks.push(bytes); } try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; } catch { throw new IntakeError(400, 'INVALID_JSON', '请求体不是有效 JSON 对象'); } }
function json(res: ServerResponse, status: number, body: unknown): true { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); return true; }
class IntakeError extends Error { constructor(readonly status: number, readonly code: string, message: string, readonly currentVersion?: number) { super(message); this.name = 'IntakeError'; } }
