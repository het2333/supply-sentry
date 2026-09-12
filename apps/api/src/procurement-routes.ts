import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';
import { assessProcurementDocumentSecurity } from './procurement-document-security.js';
import { routeEvidenceCandidates } from './procurement-route-evidence.js';

export interface ProcurementRouteContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly now?: () => Date;
  readonly clamAvConfigured?: boolean;
}
type ProcurementRoute = 'local' | 'import';
type RouteEvidenceType = 'contract' | 'incoterm' | 'erp_field' | 'manual_review' | 'manual_verification';
interface RouteEvidenceInput {
  type: RouteEvidenceType;
  reference: string;
  notes?: string;
  reason?: string;
}
interface AssignmentRow {
  tenant_id: string; po_id: string; route: ProcurementRoute; source: string; evidence_json: string; version: number;
  created_by: string; updated_by: string; created_at: string; updated_at: string;
}
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface SupplierEmailRouteAssignmentInput {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  readonly poId: string;
  readonly communicationId: string;
  readonly route: ProcurementRoute;
  readonly quote: string;
  readonly model: string;
  readonly occurredAt: string;
}

export interface SupplierEmailRouteAssignmentResult {
  readonly status: 'applied' | 'replayed' | 'unchanged' | 'conflict';
  readonly assignment: {
    purchaseOrderId: string;
    route: ProcurementRoute;
    source: string;
    evidence: Record<string, unknown>;
    version: number;
    createdBy: string;
    updatedBy: string;
    createdAt: string;
    updatedAt: string;
  };
}

/** Internal, source-bound route mutation used only after AI quote validation. */
export function recordSupplierEmailRouteAssignment(input: SupplierEmailRouteAssignmentInput): SupplierEmailRouteAssignmentResult {
  const quote = requiredText(input.quote, 'quote', 2_000);
  const model = requiredText(input.model, 'model', 200);
  const at = requiredIsoDate(input.occurredAt, 'occurredAt');
  if (!explicitRouteQuote(quote, input.route)) throw new RouteInputError('供应商邮件没有明确支持所选采购路线');
  const payloadHash = routeEvidencePayloadHash({
    poId: input.poId, communicationId: input.communicationId, route: input.route, quote, model,
  });
  const idempotencyKey = `ai-reply-route:${input.communicationId}`;
  input.db.exec('BEGIN IMMEDIATE');
  try {
    const po = input.db.prepare(`SELECT id,version,json FROM procurement_documents
      WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(input.tenantId, input.poId) as { id: string; version: number; json: string } | undefined;
    if (!po) throw new RoutePoNotFoundError();
    const communicationRow = input.db.prepare(`SELECT json FROM procurement_documents
      WHERE tenant_id=? AND kind='communication' AND id=?`).get(input.tenantId, input.communicationId) as { json: string } | undefined;
    const communication = communicationRow ? safeJson(communicationRow.json) : {};
    const poDocument = safeJson(po.json);
    if (communication['direction'] !== 'inbound' || communication['channel'] !== 'email'
        || communication['businessObjectType'] !== 'purchase_order' || communication['businessObjectId'] !== input.poId
        || communication['supplierId'] !== poDocument['supplierId']) {
      throw new RouteInputError('供应商邮件证据与采购订单或供应商不一致');
    }
    if (!String(communication['body'] ?? '').includes(quote)) throw new RouteInputError('采购路线原文引用不在供应商邮件中');
    const replay = routeAssignmentIdempotency(input.db, input.tenantId, idempotencyKey, payloadHash);
    if (replay) {
      input.db.exec('COMMIT');
      return { ...(replay as unknown as SupplierEmailRouteAssignmentResult), status: 'replayed' };
    }
    const current = getAssignment(input.db, input.tenantId, input.poId);
    let status: SupplierEmailRouteAssignmentResult['status'];
    if (!current) {
      const evidence = {
        sourceType: 'supplier_email_ai', communicationId: input.communicationId, quote, model,
        purchaseOrderVersion: Number(po.version),
      };
      input.db.prepare(`INSERT INTO procurement_route_assignments
        (tenant_id,po_id,route,source,evidence_json,version,created_by,updated_by,created_at,updated_at)
        VALUES (?,?,?,'supplier_email_ai',?,1,'ai:supplier-reply','ai:supplier-reply',?,?)`)
        .run(input.tenantId, input.poId, input.route, JSON.stringify(evidence), at, at);
      insertEvent(input.db, input.tenantId, input.poId, 'ai:supplier-reply', 'route_assigned_from_supplier_email', {
        route: input.route, previousRoute: null, evidence, previousVersion: 0,
      }, at);
      status = 'applied';
    } else {
      status = current.route === input.route ? 'unchanged' : 'conflict';
      insertEvent(input.db, input.tenantId, input.poId, 'ai:supplier-reply',
        status === 'unchanged' ? 'supplier_email_route_confirmed_existing' : 'supplier_email_route_conflict', {
          proposedRoute: input.route, existingRoute: current.route, communicationId: input.communicationId, quote,
          existingVersion: current.version,
        }, at);
    }
    const assignment = presentAssignment(getAssignment(input.db, input.tenantId, input.poId)!) as SupplierEmailRouteAssignmentResult['assignment'];
    const response: SupplierEmailRouteAssignmentResult = { status, assignment };
    input.db.prepare(`INSERT INTO procurement_route_assignment_idempotency
      (tenant_id,idempotency_key,payload_hash,response_json,created_at) VALUES (?,?,?,?,?)`)
      .run(input.tenantId, idempotencyKey, payloadHash, JSON.stringify(response), at);
    input.db.exec('COMMIT');
    return response;
  } catch (error) {
    input.db.exec('ROLLBACK');
    throw error;
  }
}

export async function handleProcurementRouteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementRouteContext,
): Promise<boolean> {
  const list = path === '/api/procurement/routes/assignments';
  const uploadEvidence = path.match(/^\/api\/procurement\/routes\/([^/]+)\/evidence-documents$/);
  const bindEvidence = path.match(/^\/api\/procurement\/routes\/([^/]+)\/evidence-documents\/bind$/);
  const revokeEvidence = path.match(/^\/api\/procurement\/routes\/([^/]+)\/evidence-documents\/([^/]+)$/);
  const assign = path.match(/^\/api\/procurement\/routes\/([^/]+)\/assign$/);
  if (!list && !uploadEvidence && !bindEvidence && !revokeEvidence && !assign) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  const { db, session } = context;
  try {
    if (list && method === 'GET') {
      if (!can(session, 'read')) return forbidden(res, '无读取采购路线权限');
      const rows = db.prepare(`SELECT * FROM procurement_route_assignments WHERE tenant_id=? ORDER BY updated_at DESC,po_id`)
        .all(session.tenantId) as unknown as AssignmentRow[];
      const watermark = db.prepare(`SELECT MAX(updated_at) AS value FROM procurement_route_assignments WHERE tenant_id=?`).get(session.tenantId) as { value: string | null } | undefined;
      sendJson(res, 200, { items: rows.map(presentAssignment), generatedAt: watermark?.value ?? null });
      return true;
    }
    if (uploadEvidence && method === 'GET') {
      if (!can(session, 'read')) return forbidden(res, '无读取采购路线证据权限');
      const poId = decodePath(uploadEvidence[1]!);
      assertPurchaseOrder(db, session.tenantId, poId);
      sendJson(res, 200, routeEvidenceDocumentPayload(db, session, poId, context.clamAvConfigured === true));
      return true;
    }
    if (bindEvidence && method === 'POST') {
      if (!can(session, 'operate')) return forbidden(res, '无绑定采购路线证据权限');
      const poId = decodePath(bindEvidence[1]!);
      assertPurchaseOrder(db, session.tenantId, poId);
      const body = await readJsonBody(req);
      assertOnlyKeys(body, ['evidenceType', 'businessReference', 'attachmentId', 'expectedAttachmentVersion', 'expectedSha256']);
      const evidenceType = routeDocumentEvidenceType(body['evidenceType']);
      const businessReference = requiredText(body['businessReference'], 'businessReference', 160);
      const attachmentId = requiredText(body['attachmentId'], 'attachmentId', 300);
      const expectedAttachmentVersion = positiveInteger(body['expectedAttachmentVersion'], 'expectedAttachmentVersion');
      const expectedSha256 = sha256Text(body['expectedSha256'], 'expectedSha256');
      const key = idempotencyKey(req);
      const payloadHash = routeEvidencePayloadHash({ operation: 'bind', poId, evidenceType, businessReference,
        attachmentId, expectedAttachmentVersion, expectedSha256 });
      const replay = routeEvidenceIdempotency(db, session.tenantId, key, payloadHash);
      if (replay) { sendJson(res, 200, { ...replay, replayed: true }); return true; }

      const attachment = db.prepare(`SELECT id,requisition_id,owner_type,owner_id,file_name,content_type,size_bytes,sha256,version,status,
          security_status,processing_status,detected_content_type,scan_error,parse_error,parsed_at
        FROM procurement_attachments WHERE tenant_id=? AND id=?`).get(session.tenantId, attachmentId) as Record<string, unknown> | undefined;
      if (!attachment || !attachmentBelongsToPo(attachment, poId)) throw new RouteInputError('附件不存在或不属于当前采购订单');
      assertReusableAttachment(attachment, expectedAttachmentVersion, expectedSha256);
      const existing = db.prepare(`SELECT id,evidence_type,reference,status,version FROM procurement_route_evidence_documents
        WHERE tenant_id=? AND attachment_id=?`).get(session.tenantId, attachmentId) as Record<string, unknown> | undefined;
      if (existing) throw new RouteEvidenceConflictError('该附件已经绑定过路线证据，不能重复绑定', Number(existing['version'] ?? 0));

      const now = (context.now?.() ?? new Date()).toISOString();
      const documentId = `route-evidence-document:${randomUUID()}`;
      let response: Record<string, unknown>;
      db.exec('BEGIN IMMEDIATE');
      try {
        assertReusableAttachment(db.prepare(`SELECT id,requisition_id,owner_type,owner_id,file_name,content_type,size_bytes,sha256,version,status,
            security_status,processing_status,detected_content_type,scan_error,parse_error,parsed_at
          FROM procurement_attachments WHERE tenant_id=? AND id=?`).get(session.tenantId, attachmentId) as Record<string, unknown> | undefined,
          expectedAttachmentVersion, expectedSha256, poId);
        const concurrentBinding = db.prepare(`SELECT id,version FROM procurement_route_evidence_documents WHERE tenant_id=? AND attachment_id=?`)
          .get(session.tenantId, attachmentId) as { id: string; version: number } | undefined;
        if (concurrentBinding) throw new RouteEvidenceConflictError('该附件已经绑定过路线证据，不能重复绑定', concurrentBinding.version);
        db.prepare(`INSERT INTO procurement_route_evidence_documents
          (tenant_id,id,po_id,evidence_type,attachment_id,reference,status,version,created_by,updated_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'active',1,?,?,?,?)`)
          .run(session.tenantId, documentId, poId, evidenceType, attachmentId, businessReference,
            session.humanId, session.humanId, now, now);
        db.prepare(`INSERT INTO procurement_attachment_audit
          (tenant_id,id,attachment_id,requisition_id,actor_id,action,owner_type,owner_id,detail_json,created_at)
          VALUES (?,?,?,?,?,?,'purchase_order',?,?,?)`)
          .run(session.tenantId, `attachment-audit:${randomUUID()}`, attachmentId, poId, session.humanId,
            'route_evidence_bound', poId, JSON.stringify({ documentId, evidenceType, businessReference,
              attachmentVersion: expectedAttachmentVersion, sha256: expectedSha256 }), now);
        routeEvidenceDocumentEvent(db, session.tenantId, poId, documentId, session.humanId, 'existing_attachment_bound', {
          evidenceType, businessReference, attachmentId, attachmentVersion: expectedAttachmentVersion, sha256: expectedSha256,
        }, now);
        response = { item: routeEvidenceDocumentView(db, session.tenantId, documentId), message: '现有 PO 附件已绑定为路线证据。' };
        saveRouteEvidenceIdempotency(db, session.tenantId, key, payloadHash, response, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      sendJson(res, 201, { ...response, replayed: false });
      return true;
    }
    if (revokeEvidence && method === 'DELETE') {
      if (!can(session, 'configure')) return forbidden(res, '只有采购经理或管理员可以撤销采购路线证据');
      const poId = decodePath(revokeEvidence[1]!);
      const documentId = decodePath(revokeEvidence[2]!);
      assertPurchaseOrder(db, session.tenantId, poId);
      const body = await readJsonBody(req);
      assertOnlyKeys(body, ['expectedVersion', 'reason']);
      const expectedVersion = positiveInteger(body['expectedVersion'], 'expectedVersion');
      const reason = requiredText(body['reason'], 'reason', 500);
      const key = idempotencyKey(req);
      const payloadHash = routeEvidencePayloadHash({ operation: 'revoke', poId, documentId, expectedVersion, reason });
      const replay = routeEvidenceIdempotency(db, session.tenantId, key, payloadHash);
      if (replay) { sendJson(res, 200, { ...replay, replayed: true }); return true; }
      const current = db.prepare(`SELECT id,po_id,attachment_id,evidence_type,reference,status,version FROM procurement_route_evidence_documents
        WHERE tenant_id=? AND po_id=? AND id=?`).get(session.tenantId, poId, documentId) as Record<string, unknown> | undefined;
      if (!current) throw new RouteEvidenceNotFoundError();
      if (current['status'] !== 'active') throw new RouteEvidenceConflictError('路线证据已经失效', Number(current['version'] ?? 0));
      if (Number(current['version']) !== expectedVersion) throw new RouteEvidenceConflictError('路线证据版本已变化', Number(current['version'] ?? 0));

      const now = (context.now?.() ?? new Date()).toISOString();
      let response: Record<string, unknown>;
      db.exec('BEGIN IMMEDIATE');
      try {
        const changed = db.prepare(`UPDATE procurement_route_evidence_documents SET status='revoked',version=version+1,updated_by=?,updated_at=?
          WHERE tenant_id=? AND po_id=? AND id=? AND status='active' AND version=?`)
          .run(session.humanId, now, session.tenantId, poId, documentId, expectedVersion);
        if (changed.changes !== 1) {
          const latest = db.prepare(`SELECT version FROM procurement_route_evidence_documents WHERE tenant_id=? AND po_id=? AND id=?`)
            .get(session.tenantId, poId, documentId) as { version: number } | undefined;
          throw new RouteEvidenceConflictError('路线证据版本已变化', Number(latest?.version ?? 0));
        }
        const assignment = getAssignment(db, session.tenantId, poId);
        const routeUnclassified = Boolean(assignment && assignmentUsesDocument(assignment, documentId));
        if (assignment && routeUnclassified) {
          const removed = db.prepare(`DELETE FROM procurement_route_assignments WHERE tenant_id=? AND po_id=? AND version=?`)
            .run(session.tenantId, poId, assignment.version);
          if (removed.changes !== 1) throw new RouteVersionError(getAssignment(db, session.tenantId, poId)?.version ?? assignment.version);
          insertEvent(db, session.tenantId, poId, session.humanId, 'route_unclassified_due_to_evidence_revocation', {
            previousRoute: assignment.route, previousVersion: assignment.version, previousEvidence: safeJson(assignment.evidence_json),
            revokedDocumentId: documentId, reason,
          }, now);
        }
        db.prepare(`INSERT INTO procurement_attachment_audit
          (tenant_id,id,attachment_id,requisition_id,actor_id,action,owner_type,owner_id,detail_json,created_at)
          VALUES (?,?,?,?,?,?,'purchase_order',?,?,?)`)
          .run(session.tenantId, `attachment-audit:${randomUUID()}`, String(current['attachment_id']), poId, session.humanId,
            'route_evidence_revoked', poId, JSON.stringify({ documentId, previousVersion: expectedVersion, reason, routeUnclassified }), now);
        routeEvidenceDocumentEvent(db, session.tenantId, poId, documentId, session.humanId, 'document_revoked', {
          previousVersion: expectedVersion, reason, routeUnclassified,
        }, now);
        response = { item: routeEvidenceDocumentView(db, session.tenantId, documentId), routeUnclassified,
          message: routeUnclassified ? '证据已撤销，依赖该证据的采购路线已退回未分类。' : '路线证据已撤销。' };
        saveRouteEvidenceIdempotency(db, session.tenantId, key, payloadHash, response, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      sendJson(res, 200, { ...response, replayed: false });
      return true;
    }
    if (uploadEvidence && method === 'POST') {
      if (!can(session, 'operate')) return forbidden(res, '无上传采购路线证据权限');
      const poId = decodePath(uploadEvidence[1]!);
      const po = db.prepare(`SELECT id FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND id=?`)
        .get(session.tenantId, poId) as { id: string } | undefined;
      if (!po) throw new RoutePoNotFoundError();
      const body = await readJsonBody(req, 12 * 1024 * 1024);
      assertOnlyKeys(body, ['evidenceType', 'businessReference', 'fileName', 'contentType', 'contentBase64']);
      const evidenceType = routeDocumentEvidenceType(body['evidenceType']);
      const businessReference = requiredText(body['businessReference'], 'businessReference', 160);
      const fileName = requiredText(body['fileName'], 'fileName', 240);
      const contentType = requiredText(body['contentType'], 'contentType', 160).toLowerCase();
      const content = base64(body['contentBase64']);
      if (content.length > MAX_FILE_BYTES) throw new RouteInputError('单个文件不能超过 8 MB');
      const key = idempotencyKey(req);
      const sha256 = createHash('sha256').update(content).digest('hex');
      const payloadHash = createHash('sha256').update(JSON.stringify({
        poId, evidenceType, businessReference, fileName, contentType, sha256,
      })).digest('hex');
      const replay = db.prepare(`SELECT payload_hash,response_json FROM procurement_route_evidence_document_idempotency
        WHERE tenant_id=? AND idempotency_key=?`).get(session.tenantId, key) as { payload_hash: string; response_json: string } | undefined;
      if (replay) {
        if (replay.payload_hash !== payloadHash) throw new RouteIdempotencyConflictError();
        sendJson(res, 200, { ...safeJson(replay.response_json), replayed: true });
        return true;
      }

      const security = assessProcurementDocumentSecurity({ fileName, declaredMimeType: contentType, bytes: content });
      const now = (context.now?.() ?? new Date()).toISOString();
      const attachmentId = `attachment:${randomUUID()}`;
      const documentId = `route-evidence-document:${randomUUID()}`;
      let response: Record<string, unknown>;
      db.exec('BEGIN IMMEDIATE');
      try {
        const previousAttachment = db.prepare(`SELECT id,version FROM procurement_attachments
          WHERE tenant_id=? AND requisition_id=? AND owner_type='purchase_order' AND owner_id=? AND file_name=? AND status='active'
          ORDER BY version DESC LIMIT 1`).get(session.tenantId, poId, poId, fileName) as { id: string; version: number } | undefined;
        const attachmentVersion = (previousAttachment?.version ?? 0) + 1;
        if (previousAttachment) {
          db.prepare(`UPDATE procurement_attachments SET status='superseded' WHERE tenant_id=? AND id=? AND status='active'`)
            .run(session.tenantId, previousAttachment.id);
          db.prepare(`UPDATE procurement_route_evidence_documents SET status='revoked',version=version+1,updated_by=?,updated_at=?
            WHERE tenant_id=? AND attachment_id=? AND status='active'`)
            .run(session.humanId, now, session.tenantId, previousAttachment.id);
        }
        db.prepare(`INSERT INTO procurement_attachments
          (tenant_id,id,requisition_id,requisition_line_id,owner_type,owner_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,
           extraction_status,extracted_text_preview,content,status,security_status,processing_status,detected_content_type,scan_error,parse_error,
           storage_backend,created_by,created_at)
          VALUES (?,?,?,NULL,'purchase_order',?,?,?,?,?,?,?,'ready_for_document_agent',NULL,?,'active',?,?,?,?,?,'sqlite',?,?)`)
          .run(session.tenantId, attachmentId, poId, poId, fileName, contentType, content.length, sha256, attachmentVersion,
            previousAttachment?.id ?? null, content, security.securityStatus, security.safeForProcessing ? 'queued' : 'parse_failed',
            security.detectedContentType, security.safeForProcessing ? null : security.reason,
            security.safeForProcessing ? null : security.reason, session.humanId, now);
        if (security.safeForProcessing) {
          db.prepare(`INSERT INTO procurement_document_jobs
            (tenant_id,id,attachment_id,status,attempts,max_attempts,available_at,created_at,updated_at)
            VALUES (?,?,?,'queued',0,3,?,?,?)`)
            .run(session.tenantId, `document-job:${randomUUID()}`, attachmentId, now, now, now);
        }
        db.prepare(`INSERT INTO procurement_route_evidence_documents
          (tenant_id,id,po_id,evidence_type,attachment_id,reference,status,version,created_by,updated_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'active',1,?,?,?,?)`)
          .run(session.tenantId, documentId, poId, evidenceType, attachmentId, businessReference,
            session.humanId, session.humanId, now, now);
        db.prepare(`INSERT INTO procurement_attachment_audit
          (tenant_id,id,attachment_id,requisition_id,actor_id,action,owner_type,owner_id,detail_json,created_at)
          VALUES (?,?,?,?,?,?,'purchase_order',?,?,?)`)
          .run(session.tenantId, `attachment-audit:${randomUUID()}`, attachmentId, poId, session.humanId,
            'route_evidence_uploaded', poId, JSON.stringify({ documentId, evidenceType, businessReference, attachmentVersion,
              securityStatus: security.securityStatus, processingStatus: security.safeForProcessing ? 'queued' : 'parse_failed' }), now);
        routeEvidenceDocumentEvent(db, session.tenantId, poId, documentId, session.humanId,
          previousAttachment ? 'document_version_uploaded' : 'document_uploaded', {
            evidenceType, businessReference, attachmentId, attachmentVersion, sha256,
            supersedesAttachmentId: previousAttachment?.id ?? null,
            securityStatus: security.securityStatus,
          }, now);
        response = {
          item: routeEvidenceDocumentView(db, session.tenantId, documentId),
          clamAvConfigured: context.clamAvConfigured === true,
          message: security.safeForProcessing
            ? '文件已保存并进入 ClamAV 与解析队列；明确通过前不能作为路线证据。'
            : '文件已隔离，不能作为路线证据。',
        };
        db.prepare(`INSERT INTO procurement_route_evidence_document_idempotency
          (tenant_id,idempotency_key,payload_hash,response_json,created_at) VALUES (?,?,?,?,?)`)
          .run(session.tenantId, key, payloadHash, JSON.stringify(response), now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      sendJson(res, 201, { ...response, replayed: false });
      return true;
    }
    if (assign && method === 'POST') {
      if (!can(session, 'configure')) return forbidden(res, '只有采购经理或管理员可以确认采购路线');
      const poId = decodePath(assign[1]!);
      const body = await readJsonBody(req);
      assertOnlyKeys(body, ['route', 'evidence', 'expectedVersion']);
      const route = procurementRoute(body['route']);
      const evidenceInput = routeEvidence(body['evidence']);
      const expectedVersion = nonNegativeInteger(body['expectedVersion'], 'expectedVersion');
      const key = idempotencyKey(req);
      const payloadHash = routeEvidencePayloadHash({ poId, route, evidence: evidenceInput, expectedVersion });
      const existingReceipt = routeAssignmentIdempotency(db, session.tenantId, key, payloadHash);
      if (existingReceipt) {
        sendJson(res, 200, { ...existingReceipt, replayed: true });
        return true;
      }
      const po = db.prepare(`SELECT id,status,json FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND id=?`)
        .get(session.tenantId, poId) as { id: string; status: string; json: string } | undefined;
      if (!po) throw new RoutePoNotFoundError();
      const now = (context.now?.() ?? new Date()).toISOString();
      let response: Record<string, unknown>;
      let replayed = false;
      db.exec('BEGIN IMMEDIATE');
      try {
        const concurrentReceipt = routeAssignmentIdempotency(db, session.tenantId, key, payloadHash);
        if (concurrentReceipt) {
          response = concurrentReceipt;
          replayed = true;
        } else {
          const current = getAssignment(db, session.tenantId, poId);
          const previousRoute = currentRoute(po, current);
          if (previousRoute === 'import' && route === 'local') assertImportRouteDowngradeAllowed(db, session.tenantId, poId);
          if (!current) {
            if (expectedVersion !== 0) throw new RouteVersionError(0);
            const evidence = assignmentEvidence(db, session.tenantId, poId, evidenceInput, po, documentVersion(db, session.tenantId, poId));
            db.prepare(`INSERT INTO procurement_route_assignments
              (tenant_id,po_id,route,source,evidence_json,version,created_by,updated_by,created_at,updated_at)
              VALUES (?,?,?,?,?,1,?,?,?,?)`)
              .run(session.tenantId, poId, route, 'manual', JSON.stringify(evidence), session.humanId, session.humanId, now, now);
            insertEvent(db, session.tenantId, poId, session.humanId, 'route_assigned', { route, previousRoute: null, evidence, previousVersion: 0 }, now);
          } else {
            if (current.version !== expectedVersion) throw new RouteVersionError(current.version);
            const evidence = assignmentEvidence(db, session.tenantId, poId, evidenceInput, po, documentVersion(db, session.tenantId, poId));
            const result = db.prepare(`UPDATE procurement_route_assignments SET route=?,source='manual',evidence_json=?,version=version+1,updated_by=?,updated_at=?
              WHERE tenant_id=? AND po_id=? AND version=?`)
              .run(route, JSON.stringify(evidence), session.humanId, now, session.tenantId, poId, expectedVersion);
            if (result.changes !== 1) throw new RouteVersionError(getAssignment(db, session.tenantId, poId)?.version ?? expectedVersion);
            insertEvent(db, session.tenantId, poId, session.humanId, 'route_reassigned', { route, previousRoute: current.route, evidence, previousVersion: expectedVersion }, now);
          }
          const updated = getAssignment(db, session.tenantId, poId)!;
          response = { item: presentAssignment(updated), events: listEvents(db, session.tenantId, poId) };
          db.prepare(`INSERT INTO procurement_route_assignment_idempotency
            (tenant_id,idempotency_key,payload_hash,response_json,created_at) VALUES (?,?,?,?,?)`)
            .run(session.tenantId, key, payloadHash, JSON.stringify(response), now);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      sendJson(res, replayed ? 200 : expectedVersion === 0 ? 201 : 200, { ...response, replayed });
      return true;
    }
    sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
  } catch (error) { sendRouteError(res, error); }
  return true;
}

function getAssignment(db: DatabaseSync, tenantId: string, poId: string): AssignmentRow | undefined {
  return db.prepare(`SELECT * FROM procurement_route_assignments WHERE tenant_id=? AND po_id=?`).get(tenantId, poId) as unknown as AssignmentRow | undefined;
}
function documentVersion(db: DatabaseSync, tenantId: string, poId: string): number {
  const row = db.prepare(`SELECT version FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, poId) as { version: number } | undefined;
  return Number(row?.version ?? 0);
}
function assignmentEvidence(
  db: DatabaseSync,
  tenantId: string,
  purchaseOrderId: string,
  input: RouteEvidenceInput,
  po: { status: string },
  purchaseOrderVersion: number,
): Record<string, unknown> {
  const evidence = { ...input, sourceType: input.type, purchaseOrderStatus: po.status, purchaseOrderVersion };
  if (input.type === 'manual_review' || input.type === 'manual_verification') return evidence;
  const candidate = routeEvidenceCandidates(db, tenantId, purchaseOrderId)
    .find((item) => item.reference === input.reference);
  if (input.type === 'erp_field') {
    if (!candidate || candidate.type !== 'erp_field' || candidate.evidenceType !== 'erp_field' || !candidate.eligible) {
      throw new RouteInputError('ERP 证据不存在或对应的 PO / 供应商版本已变更，请刷新后重新选择');
    }
    return { ...evidence, erpEvidence: candidate };
  }
  if (!candidate || candidate.type !== 'route_document' || candidate.evidenceType !== input.type || !candidate.eligible) {
    throw new RouteInputError(`${input.type === 'contract' ? '合同' : 'Incoterm'}证据必须引用当前 PO 已完成 ClamAV 扫描和解析的有效文件`);
  }
  return { ...evidence, documentEvidence: candidate };
}
function currentRoute(po: { json: string }, assignment?: AssignmentRow): ProcurementRoute | 'unclassified' {
  if (assignment?.route === 'local' || assignment?.route === 'import') return assignment.route;
  const document = safeJson(po.json);
  for (const field of ['procurementRoute', 'route']) {
    const value = String(document[field] ?? '').trim().toLowerCase();
    if (['import', 'international', '进口', '海外'].includes(value)) return 'import';
    if (['local', 'domestic', '本地', '国内'].includes(value)) return 'local';
  }
  return 'unclassified';
}
function assertImportRouteDowngradeAllowed(db: DatabaseSync, tenantId: string, poId: string): void {
  const shipment = db.prepare(`SELECT 1 FROM procurement_documents WHERE tenant_id=? AND kind='shipment' AND json_extract(json,'$.poId')=? LIMIT 1`).get(tenantId, poId);
  const transportEvent = db.prepare(`SELECT 1 FROM procurement_documents WHERE tenant_id=? AND kind='transport_event' AND json_extract(json,'$.poId')=? LIMIT 1`).get(tenantId, poId);
  const importDocument = db.prepare(`SELECT 1 FROM procurement_import_documents WHERE tenant_id=? AND po_id=? LIMIT 1`).get(tenantId, poId);
  const publishedImportGate = db.prepare(`SELECT 1 FROM procurement_import_document_policies WHERE tenant_id=? AND status='published' LIMIT 1`).get(tenantId);
  if (shipment || transportEvent || importDocument || publishedImportGate) throw new ImportRouteDowngradeError();
}
function presentAssignment(row: AssignmentRow): Record<string, unknown> {
  return {
    purchaseOrderId: row.po_id, route: row.route, source: row.source, evidence: safeJson(row.evidence_json), version: row.version,
    createdBy: row.created_by, updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function listEvents(db: DatabaseSync, tenantId: string, poId: string): unknown[] {
  const rows = db.prepare(`SELECT id,actor_id,action,detail_json,created_at FROM procurement_route_events WHERE tenant_id=? AND po_id=? ORDER BY created_at,rowid`)
    .all(tenantId, poId) as Array<{ id: string; actor_id: string; action: string; detail_json: string; created_at: string }>;
  return rows.map((row) => ({ id: row.id, actorId: row.actor_id, action: row.action, detail: safeJson(row.detail_json), createdAt: row.created_at }));
}
function insertEvent(db: DatabaseSync, tenantId: string, poId: string, actorId: string, action: string, detail: unknown, at: string): void {
  db.prepare(`INSERT INTO procurement_route_events (tenant_id,id,po_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(tenantId, `procurement-route-event:${randomUUID()}`, poId, actorId, action, JSON.stringify(detail), at);
}
function assertPurchaseOrder(db: DatabaseSync, tenantId: string, poId: string): void {
  const row = db.prepare(`SELECT 1 AS ok FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND id=?`)
    .get(tenantId, poId) as { ok: number } | undefined;
  if (!row) throw new RoutePoNotFoundError();
}
function attachmentBelongsToPo(attachment: Record<string, unknown>, poId: string): boolean {
  return (attachment['owner_type'] === 'purchase_order' && attachment['owner_id'] === poId)
    || attachment['requisition_id'] === poId;
}
function assertReusableAttachment(
  attachment: Record<string, unknown> | undefined,
  expectedVersion: number,
  expectedSha256: string,
  poId?: string,
): asserts attachment is Record<string, unknown> {
  if (!attachment || (poId && !attachmentBelongsToPo(attachment, poId))) throw new RouteInputError('附件不存在或不属于当前采购订单');
  if (attachment['status'] !== 'active') throw new RouteInputError('附件已失效，不能绑定为路线证据');
  if (Number(attachment['version']) !== expectedVersion || attachment['sha256'] !== expectedSha256) {
    throw new RouteInputError('附件版本或 SHA-256 已变化，请刷新后重新选择');
  }
  if (attachment['security_status'] !== 'clean' || attachment['processing_status'] !== 'parsed') {
    throw new RouteInputError('附件必须完成 ClamAV 扫描和解析后才能绑定为路线证据');
  }
  if (!Number.isSafeInteger(Number(attachment['size_bytes'])) || Number(attachment['size_bytes']) <= 0) {
    throw new RouteInputError('附件大小无效，不能绑定为路线证据');
  }
}
function routeEvidenceDocumentPayload(db: DatabaseSync, session: Session, poId: string, clamAvConfigured: boolean): Record<string, unknown> {
  const documentRows = db.prepare(`SELECT id FROM procurement_route_evidence_documents WHERE tenant_id=? AND po_id=?
    ORDER BY updated_at DESC,id DESC`).all(session.tenantId, poId) as Array<{ id: string }>;
  const availableRows = db.prepare(`SELECT a.id,a.requisition_id,a.owner_type,a.owner_id,a.file_name,a.content_type,a.size_bytes,a.sha256,a.version,
      a.status,a.security_status,a.processing_status,a.detected_content_type,a.scan_error,a.parse_error,a.parsed_at,a.extracted_text_preview,a.created_at
    FROM procurement_attachments a
    WHERE a.tenant_id=? AND a.status='active'
      AND ((a.owner_type='purchase_order' AND a.owner_id=?) OR a.requisition_id=?)
      AND NOT EXISTS (SELECT 1 FROM procurement_route_evidence_documents d WHERE d.tenant_id=a.tenant_id AND d.attachment_id=a.id)
    ORDER BY a.created_at DESC,a.id DESC`).all(session.tenantId, poId, poId) as Array<Record<string, unknown>>;
  const eventRows = db.prepare(`SELECT id,document_id,actor_id,action,detail_json,created_at
    FROM procurement_route_evidence_document_events WHERE tenant_id=? AND po_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100`)
    .all(session.tenantId, poId) as Array<{ id: string; document_id: string; actor_id: string; action: string; detail_json: string; created_at: string }>;
  return {
    purchaseOrderId: poId,
    clamAvConfigured,
    documents: documentRows.map((row) => routeEvidenceDocumentView(db, session.tenantId, row.id)).filter(Boolean),
    availableAttachments: availableRows.map((row) => ({
      id: row['id'], fileName: row['file_name'], contentType: row['content_type'], sizeBytes: Number(row['size_bytes']),
      sha256: row['sha256'], version: Number(row['version']), securityStatus: row['security_status'],
      processingStatus: row['processing_status'], detectedContentType: row['detected_content_type'], scanError: row['scan_error'],
      parseError: row['parse_error'], parsedAt: row['parsed_at'], createdAt: row['created_at'],
      eligible: row['security_status'] === 'clean' && row['processing_status'] === 'parsed'
        && /^[a-f0-9]{64}$/iu.test(String(row['sha256'])) && Number(row['size_bytes']) > 0,
      ...(typeof row['extracted_text_preview'] === 'string' && row['extracted_text_preview']
        ? { extractedTextPreview: row['extracted_text_preview'] }
        : {}),
      ...(row['security_status'] === 'clean'
        ? { contentUrl: `/api/procurement/attachments/${encodeURIComponent(String(row['id']))}/content` }
        : {}),
    })),
    events: eventRows.map((row) => ({ id: row.id, documentId: row.document_id, actorId: row.actor_id,
      action: row.action, detail: safeJson(row.detail_json), createdAt: row.created_at })),
    permissions: { operate: can(session, 'operate'), configure: can(session, 'configure') },
  };
}
function routeEvidencePayloadHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function routeAssignmentIdempotency(db: DatabaseSync, tenantId: string, key: string, payloadHash: string): Record<string, unknown> | null {
  const row = db.prepare(`SELECT payload_hash,response_json FROM procurement_route_assignment_idempotency
    WHERE tenant_id=? AND idempotency_key=?`).get(tenantId, key) as { payload_hash: string; response_json: string } | undefined;
  if (!row) return null;
  if (row.payload_hash !== payloadHash) throw new RouteAssignmentIdempotencyConflictError();
  return safeJson(row.response_json);
}
function routeEvidenceIdempotency(db: DatabaseSync, tenantId: string, key: string, payloadHash: string): Record<string, unknown> | null {
  const row = db.prepare(`SELECT payload_hash,response_json FROM procurement_route_evidence_document_idempotency
    WHERE tenant_id=? AND idempotency_key=?`).get(tenantId, key) as { payload_hash: string; response_json: string } | undefined;
  if (!row) return null;
  if (row.payload_hash !== payloadHash) throw new RouteIdempotencyConflictError();
  return safeJson(row.response_json);
}
function saveRouteEvidenceIdempotency(db: DatabaseSync, tenantId: string, key: string, payloadHash: string, response: Record<string, unknown>, at: string): void {
  db.prepare(`INSERT INTO procurement_route_evidence_document_idempotency
    (tenant_id,idempotency_key,payload_hash,response_json,created_at) VALUES (?,?,?,?,?)`)
    .run(tenantId, key, payloadHash, JSON.stringify(response), at);
}
function assignmentUsesDocument(assignment: AssignmentRow, documentId: string): boolean {
  const evidence = safeJson(assignment.evidence_json);
  const documentEvidence = evidence['documentEvidence'];
  if (!documentEvidence || typeof documentEvidence !== 'object' || Array.isArray(documentEvidence)) return false;
  const fields = (documentEvidence as Record<string, unknown>)['fields'];
  return Boolean(fields && typeof fields === 'object' && !Array.isArray(fields)
    && (fields as Record<string, unknown>)['documentId'] === documentId);
}
function routeEvidenceDocumentView(db: DatabaseSync, tenantId: string, id: string): Record<string, unknown> | null {
  const row = db.prepare(`SELECT d.id,d.po_id,d.evidence_type,d.reference,d.status,d.version,d.created_by,d.updated_by,d.created_at,d.updated_at,
      a.id AS attachment_id,a.file_name,a.content_type,a.size_bytes,a.sha256,a.version AS attachment_version,a.status AS attachment_status,
      a.security_status,a.processing_status,a.detected_content_type,a.scan_error,a.parse_error,a.parsed_at,a.extracted_text_preview
    FROM procurement_route_evidence_documents d JOIN procurement_attachments a ON a.tenant_id=d.tenant_id AND a.id=d.attachment_id
    WHERE d.tenant_id=? AND d.id=?`).get(tenantId, id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row['id'], purchaseOrderId: row['po_id'], evidenceType: row['evidence_type'], businessReference: row['reference'],
    status: row['status'], version: Number(row['version']), attachmentId: row['attachment_id'], fileName: row['file_name'],
    contentType: row['content_type'], sizeBytes: Number(row['size_bytes']), sha256: row['sha256'],
    attachmentVersion: Number(row['attachment_version']), attachmentStatus: row['attachment_status'],
    securityStatus: row['security_status'], processingStatus: row['processing_status'], detectedContentType: row['detected_content_type'],
    scanError: row['scan_error'], parseError: row['parse_error'], parsedAt: row['parsed_at'],
    ...(typeof row['extracted_text_preview'] === 'string' && row['extracted_text_preview'] ? { extractedTextPreview: row['extracted_text_preview'] } : {}),
    ...(row['security_status'] === 'clean' ? { contentUrl: `/api/procurement/attachments/${encodeURIComponent(String(row['attachment_id']))}/content` } : {}),
    createdBy: row['created_by'], updatedBy: row['updated_by'], createdAt: row['created_at'], updatedAt: row['updated_at'],
  };
}
function routeEvidenceDocumentEvent(db: DatabaseSync, tenantId: string, poId: string, documentId: string, actorId: string, action: string, detail: unknown, at: string): void {
  db.prepare(`INSERT INTO procurement_route_evidence_document_events
    (tenant_id,id,po_id,document_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(tenantId, `route-evidence-document-event:${randomUUID()}`, poId, documentId, actorId, action, JSON.stringify(detail), at);
}
async function readJsonBody(req: IncomingMessage, max = 200_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > max) throw new RouteInputError('请求体过大'); chunks.push(part); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new RouteInputError('请求体必须是 JSON 对象'); }
}
function base64(value: unknown): Buffer { if (typeof value !== 'string' || !value.trim()) throw new RouteInputError('contentBase64 必填'); try { const content = Buffer.from(value, 'base64'); if (!content.length || content.toString('base64').replace(/=+$/u, '') !== value.replace(/\s+/gu, '').replace(/=+$/u, '')) throw new Error(); return content; } catch { throw new RouteInputError('contentBase64 无效'); } }
function idempotencyKey(req: IncomingMessage): string { const value = req.headers['idempotency-key']; const candidate = Array.isArray(value) ? value[0] : value; if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 200) throw new RouteInputError('Idempotency-Key 必填'); return candidate.trim(); }
function routeDocumentEvidenceType(value: unknown): 'contract' | 'incoterm' { if (value !== 'contract' && value !== 'incoterm') throw new RouteInputError('evidenceType 只能是 contract 或 incoterm'); return value; }
function assertOnlyKeys(value: Record<string, unknown>, keys: string[]): void { const allowed = new Set(keys); for (const key of Object.keys(value)) if (!allowed.has(key)) throw new RouteInputError(`不允许的字段: ${key}`); }
function procurementRoute(value: unknown): ProcurementRoute { if (value !== 'local' && value !== 'import') throw new RouteInputError('route 只能是 local 或 import'); return value; }
function routeEvidence(value: unknown): RouteEvidenceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RouteInputError('evidence 必须是对象');
  const evidence = value as Record<string, unknown>;
  assertOnlyKeys(evidence, ['type', 'reference', 'notes', 'reason']);
  const type = evidence['type'];
  if (!['contract', 'incoterm', 'erp_field', 'manual_review', 'manual_verification'].includes(String(type))) throw new RouteInputError('evidence.type 无效');
  const reference = requiredText(evidence['reference'], 'evidence.reference', 500);
  const notes = optionalText(evidence['notes'], 'evidence.notes', 2_000);
  const reason = optionalText(evidence['reason'], 'evidence.reason', 500);
  return { type: type as RouteEvidenceType, reference, ...(notes ? { notes } : {}), ...(reason ? { reason } : {}) };
}
function requiredText(value: unknown, field: string, max: number): string { if (typeof value !== 'string' || value.trim().length < 2) throw new RouteInputError(`${field} 至少需要 2 个字符`); if (value.trim().length > max) throw new RouteInputError(`${field} 超过 ${max} 字符`); return value.trim(); }
function requiredIsoDate(value: unknown, field: string): string { const text = requiredText(value, field, 100); const parsed = new Date(text); if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) throw new RouteInputError(`${field} 必须是 ISO 日期时间`); return text; }
function explicitRouteQuote(quote: string, route: ProcurementRoute): boolean {
  const local = /(?:境内|国内|本地).{0,8}(?:采购|供货|发货|交付|路线|订单)|(?:采购|供货|发货|交付|路线|订单).{0,8}(?:境内|国内|本地)/u.test(quote);
  const imported = /(?:进口|境外|海外|国际).{0,8}(?:采购|供货|发货|交付|路线|订单|清关)|(?:采购|供货|发货|交付|路线|订单).{0,8}(?:进口|境外|海外|国际)|(?:需要|涉及).{0,4}清关/u.test(quote);
  return route === 'local' ? local && !imported : imported && !local;
}
function optionalText(value: unknown, field: string, max: number): string | undefined { if (value === undefined) return undefined; return requiredText(value, field, max); }
function nonNegativeInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new RouteInputError(`${field} 必须是非负整数`); return Number(value); }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new RouteInputError(`${field} 必须是正整数`); return Number(value); }
function sha256Text(value: unknown, field: string): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value.trim())) throw new RouteInputError(`${field} 必须是 SHA-256`); return value.trim().toLowerCase(); }
function safeJson(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function decodePath(value: string): string { try { const decoded = decodeURIComponent(value); if (!decoded || decoded.length > 300) throw new Error(); return decoded; } catch { throw new RouteInputError('采购订单 ID 编码无效'); } }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function forbidden(res: ServerResponse, message: string): true { sendJson(res, 403, { error: message, code: 'FORBIDDEN' }); return true; }
function sendRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof RoutePoNotFoundError) return sendJson(res, 404, { error: error.message, code: 'PURCHASE_ORDER_NOT_FOUND' });
  if (error instanceof RouteVersionError) return sendJson(res, 409, { error: error.message, code: 'ROUTE_VERSION_CONFLICT', currentVersion: error.currentVersion });
  if (error instanceof RouteEvidenceNotFoundError) return sendJson(res, 404, { error: error.message, code: 'ROUTE_EVIDENCE_NOT_FOUND' });
  if (error instanceof RouteEvidenceConflictError) return sendJson(res, 409, { error: error.message, code: 'ROUTE_EVIDENCE_VERSION_CONFLICT', currentVersion: error.currentVersion });
  if (error instanceof RouteAssignmentIdempotencyConflictError) return sendJson(res, 409, { error: error.message, code: 'ROUTE_ASSIGNMENT_IDEMPOTENCY_CONFLICT' });
  if (error instanceof RouteIdempotencyConflictError) return sendJson(res, 409, { error: error.message, code: 'ROUTE_EVIDENCE_IDEMPOTENCY_CONFLICT' });
  if (error instanceof ImportRouteDowngradeError) return sendJson(res, 409, { error: error.message, code: 'IMPORT_ROUTE_DOWNGRADE_BLOCKED' });
  if (error instanceof RouteInputError) return sendJson(res, 422, { error: error.message, code: 'INVALID_ROUTE_INPUT' });
  throw error;
}
class RouteInputError extends Error {}
class RoutePoNotFoundError extends Error { constructor() { super('采购订单不存在'); } }
class RouteVersionError extends Error { constructor(readonly currentVersion: number) { super(`采购路线版本已变更，当前版本为 ${currentVersion}`); } }
class RouteAssignmentIdempotencyConflictError extends Error { constructor() { super('幂等键已用于不同的采购路线确认'); } }
class RouteIdempotencyConflictError extends Error { constructor() { super('幂等键已用于不同的路线证据文件'); } }
class RouteEvidenceNotFoundError extends Error { constructor() { super('采购路线证据不存在'); } }
class RouteEvidenceConflictError extends Error { constructor(message: string, readonly currentVersion: number) { super(message); } }
class ImportRouteDowngradeError extends Error { constructor() { super('进口 PO 已有关联运输、单证或已发布进口单证门禁，禁止直接改为本地路线'); } }
