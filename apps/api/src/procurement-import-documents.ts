import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';
import { assessProcurementDocumentSecurity } from './procurement-document-security.js';

export interface ProcurementImportDocumentContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly now?: () => Date;
  readonly clamAvConfigured?: boolean;
}

type Stage = 'dispatch_transit' | 'delivery_grn';
type ProcurementStage = 'po_sent' | 'supplier_commitment' | 'fulfilment_production' | Stage;
type Requirement = { code: string; name: string; description: string; required: boolean; requiredStage: Stage; expiryRequired: boolean };
type PolicyRow = {
  tenant_id: string; id: string; name: string; description: string; status: 'draft' | 'published' | 'retired'; version: number;
  requirements_json: string; created_by: string; updated_by: string; published_by: string | null;
  created_at: string; updated_at: string; published_at: string | null;
};
type EvaluationStatus = 'passed' | 'on_track' | 'missing' | 'expired' | 'security_blocked' | 'policy_missing';

const STAGE_INDEX: Record<ProcurementStage, number> = { po_sent: 0, supplier_commitment: 1, fulfilment_production: 2, dispatch_transit: 3, delivery_grn: 4 };
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function handleProcurementImportDocumentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementImportDocumentContext,
): Promise<boolean> {
  const root = path === '/api/procurement/import-documents';
  const policies = path === '/api/procurement/import-documents/policies';
  const policyItem = path.match(/^\/api\/procurement\/import-documents\/policies\/([^/]+)$/);
  const publish = path.match(/^\/api\/procurement\/import-documents\/policies\/([^/]+)\/publish$/);
  const evaluate = path === '/api/procurement/import-documents/evaluate';
  const upload = path.match(/^\/api\/procurement\/import-documents\/pos\/([^/]+)\/documents$/);
  const remove = path.match(/^\/api\/procurement\/import-documents\/pos\/([^/]+)\/documents\/([^/]+)$/);
  if (!root && !policies && !policyItem && !publish && !evaluate && !upload && !remove) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  const { db, session } = context;
  try {
    if (root && method === 'GET') {
      if (!can(session, 'read')) return forbidden(res, '无读取进口单证权限');
      sendJson(res, 200, importDocumentPayload(db, session, context.clamAvConfigured === true)); return true;
    }
    if (policies && method === 'POST') {
      if (!can(session, 'configure')) return forbidden(res, '无配置进口单证策略权限');
      const body = await readJsonBody(req);
      assertOnlyKeys(body, ['name', 'description', 'requirements']);
      const now = (context.now?.() ?? new Date()).toISOString();
      const id = `import-document-policy:${randomUUID()}`;
      const name = requiredText(body['name'], 'name', 120);
      const description = optionalText(body['description'], 'description', 500) ?? '';
      const requirements = normalizeRequirements(body['requirements']);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT INTO procurement_import_document_policies
          (tenant_id,id,name,description,status,version,requirements_json,created_by,updated_by,created_at,updated_at)
          VALUES (?,?,?,?,'draft',1,?,?,?,?,?)`)
          .run(session.tenantId, id, name, description, JSON.stringify(requirements), session.humanId, session.humanId, now, now);
        policyEvent(db, session.tenantId, id, session.humanId, 'draft_created', { requirements: requirements.map((item) => item.code) }, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      sendJson(res, 201, { item: presentPolicy(policy(db, session.tenantId, id)!) }); return true;
    }
    if (policyItem && method === 'PATCH') {
      if (!can(session, 'configure')) return forbidden(res, '无配置进口单证策略权限');
      const id = decode(policyItem[1]!); const body = await readJsonBody(req);
      assertOnlyKeys(body, ['expectedVersion', 'name', 'description', 'requirements']);
      const expectedVersion = positiveInteger(body['expectedVersion'], 'expectedVersion');
      const current = policy(db, session.tenantId, id); if (!current) throw new ImportDocumentNotFoundError('策略不存在');
      if (current.status !== 'draft') throw new ImportDocumentConflictError('已发布或已退役策略不可编辑', current.version);
      if (current.version !== expectedVersion) throw new ImportDocumentConflictError('策略版本已变化', current.version);
      const name = body['name'] === undefined ? current.name : requiredText(body['name'], 'name', 120);
      const description = body['description'] === undefined ? current.description : optionalText(body['description'], 'description', 500) ?? '';
      const requirements = body['requirements'] === undefined ? parseRequirements(current.requirements_json) : normalizeRequirements(body['requirements']);
      const now = (context.now?.() ?? new Date()).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const changed = db.prepare(`UPDATE procurement_import_document_policies SET name=?,description=?,requirements_json=?,version=version+1,updated_by=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='draft' AND version=?`)
          .run(name, description, JSON.stringify(requirements), session.humanId, now, session.tenantId, id, expectedVersion);
        if (changed.changes !== 1) throw new ImportDocumentConflictError('策略版本已变化', policy(db, session.tenantId, id)?.version ?? expectedVersion);
        policyEvent(db, session.tenantId, id, session.humanId, 'draft_updated', { previousVersion: expectedVersion, requirements: requirements.map((item) => item.code) }, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      sendJson(res, 200, { item: presentPolicy(policy(db, session.tenantId, id)!) }); return true;
    }
    if (publish && method === 'POST') {
      if (!can(session, 'configure') || !can(session, 'approve')) return forbidden(res, '发布单证门禁需要配置与审批权限');
      const id = decode(publish[1]!); const body = await readJsonBody(req); assertOnlyKeys(body, ['expectedVersion']);
      const expectedVersion = positiveInteger(body['expectedVersion'], 'expectedVersion');
      const current = policy(db, session.tenantId, id); if (!current) throw new ImportDocumentNotFoundError('策略不存在');
      if (current.status !== 'draft' || current.version !== expectedVersion) throw new ImportDocumentConflictError('策略状态或版本已变化', current.version);
      const requirements = parseRequirements(current.requirements_json);
      if (!requirements.some((item) => item.required)) throw new ImportDocumentInputError('正式策略至少需要一项必需单证');
      const now = (context.now?.() ?? new Date()).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const retired = db.prepare(`SELECT id,version FROM procurement_import_document_policies WHERE tenant_id=? AND status='published'`).all(session.tenantId) as Array<{ id: string; version: number }>;
        db.prepare(`UPDATE procurement_import_document_policies SET status='retired',version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND status='published'`)
          .run(session.humanId, now, session.tenantId);
        for (const item of retired) policyEvent(db, session.tenantId, item.id, session.humanId, 'retired', { replacedBy: id, previousVersion: item.version }, now);
        const changed = db.prepare(`UPDATE procurement_import_document_policies SET status='published',version=version+1,published_by=?,published_at=?,updated_by=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='draft' AND version=?`)
          .run(session.humanId, now, session.humanId, now, session.tenantId, id, expectedVersion);
        if (changed.changes !== 1) throw new ImportDocumentConflictError('策略版本已变化', policy(db, session.tenantId, id)?.version ?? expectedVersion);
        policyEvent(db, session.tenantId, id, session.humanId, 'published', { previousVersion: expectedVersion }, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const evaluated = evaluateAll(db, session.tenantId, context.now?.() ?? new Date());
      sendJson(res, 200, { item: presentPolicy(policy(db, session.tenantId, id)!), evaluated }); return true;
    }
    if (evaluate && method === 'POST') {
      if (!can(session, 'operate')) return forbidden(res, '无刷新进口单证校验权限');
      const body = await readJsonBody(req); assertOnlyKeys(body, ['purchaseOrderId']);
      const now = context.now?.() ?? new Date();
      const purchaseOrderId = body['purchaseOrderId'] === undefined ? undefined : requiredText(body['purchaseOrderId'], 'purchaseOrderId', 240);
      const evaluated = purchaseOrderId ? (evaluatePo(db, session.tenantId, purchaseOrderId, now), 1) : evaluateAll(db, session.tenantId, now);
      sendJson(res, 200, { evaluated, ...importDocumentPayload(db, session, context.clamAvConfigured === true) }); return true;
    }
    if (upload && method === 'POST') {
      if (!can(session, 'operate')) return forbidden(res, '无上传进口单证权限');
      const poId = decode(upload[1]!); assertImportPo(db, session.tenantId, poId);
      const body = await readJsonBody(req, 12 * 1024 * 1024); assertOnlyKeys(body, ['requirementCode', 'fileName', 'contentType', 'contentBase64', 'documentNumber', 'issuedAt', 'expiresAt']);
      const key = idempotencyKey(req);
      const requirementCode = requiredText(body['requirementCode'], 'requirementCode', 80);
      const activePolicy = publishedPolicy(db, session.tenantId); if (!activePolicy) throw new ImportDocumentInputError('请先发布进口单证策略');
      const requirement = parseRequirements(activePolicy.requirements_json).find((item) => item.code === requirementCode);
      if (!requirement) throw new ImportDocumentInputError('单证类型不属于当前已发布策略');
      const fileName = requiredText(body['fileName'], 'fileName', 240); const contentType = requiredText(body['contentType'], 'contentType', 160).toLowerCase();
      const content = base64(body['contentBase64']); if (content.length > MAX_FILE_BYTES) throw new ImportDocumentInputError('单个文件不能超过 8 MB');
      const documentNumber = optionalText(body['documentNumber'], 'documentNumber', 160);
      const issuedAt = optionalDate(body['issuedAt'], 'issuedAt'); const expiresAt = optionalDate(body['expiresAt'], 'expiresAt');
      if (requirement.expiryRequired && !expiresAt) throw new ImportDocumentInputError(`${requirement.name}必须填写失效日期`);
      const security = assessProcurementDocumentSecurity({ fileName, declaredMimeType: contentType, bytes: content });
      const payloadHash = createHash('sha256').update(JSON.stringify({ poId, requirementCode, fileName, contentType, sha256: createHash('sha256').update(content).digest('hex'), documentNumber, issuedAt, expiresAt })).digest('hex');
      const replay = db.prepare(`SELECT payload_hash,response_json FROM procurement_import_document_idempotency WHERE tenant_id=? AND idempotency_key=?`).get(session.tenantId, key) as { payload_hash: string; response_json: string } | undefined;
      if (replay) { if (replay.payload_hash !== payloadHash) throw new ImportDocumentConflictError('幂等键已用于不同文件', 0); sendJson(res, 200, { ...JSON.parse(replay.response_json), replayed: true }); return true; }
      const now = (context.now?.() ?? new Date()).toISOString(); const attachmentId = `attachment:${randomUUID()}`; const importDocumentId = `import-document:${randomUUID()}`;
      const sha256 = createHash('sha256').update(content).digest('hex');
      db.exec('BEGIN IMMEDIATE');
      try {
        const previousAttachment = db.prepare(`SELECT id,version FROM procurement_attachments WHERE tenant_id=? AND requisition_id=? AND file_name=? AND status='active' ORDER BY version DESC LIMIT 1`)
          .get(session.tenantId, poId, fileName) as { id: string; version: number } | undefined;
        const attachmentVersion = (previousAttachment?.version ?? 0) + 1;
        db.prepare(`INSERT INTO procurement_attachments
          (tenant_id,id,requisition_id,requisition_line_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,extraction_status,extracted_text_preview,content,status,security_status,processing_status,detected_content_type,scan_error,parse_error,storage_backend,created_by,created_at)
          VALUES (?,?,?,NULL,?,?,?,?,?,?,'ready_for_document_agent',NULL,?,'active',?,?,?,?,?,'sqlite',?,?)`)
          .run(session.tenantId, attachmentId, poId, fileName, contentType, content.length, sha256, attachmentVersion, previousAttachment?.id ?? null, content,
            security.securityStatus, security.safeForProcessing ? 'queued' : 'parse_failed', security.detectedContentType,
            security.safeForProcessing ? null : security.reason, security.safeForProcessing ? null : security.reason, session.humanId, now);
        if (security.safeForProcessing) db.prepare(`INSERT INTO procurement_document_jobs
          (tenant_id,id,attachment_id,status,attempts,max_attempts,available_at,created_at,updated_at) VALUES (?,?,?,'queued',0,3,?,?,?)`)
          .run(session.tenantId, `document-job:${randomUUID()}`, attachmentId, now, now, now);
        const previous = db.prepare(`SELECT id,version FROM procurement_import_documents WHERE tenant_id=? AND po_id=? AND requirement_code=? AND status='active'`)
          .get(session.tenantId, poId, requirementCode) as { id: string; version: number } | undefined;
        if (previous) db.prepare(`UPDATE procurement_import_documents SET status='superseded',version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND id=? AND status='active'`)
          .run(session.humanId, now, session.tenantId, previous.id);
        db.prepare(`INSERT INTO procurement_import_documents
          (tenant_id,id,po_id,requirement_code,attachment_id,document_number,issued_at,expires_at,status,version,created_by,updated_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,'active',1,?,?,?,?)`)
          .run(session.tenantId, importDocumentId, poId, requirementCode, attachmentId, documentNumber ?? null, issuedAt ?? null, expiresAt ?? null, session.humanId, session.humanId, now, now);
        db.prepare(`INSERT INTO procurement_attachment_audit (tenant_id,id,attachment_id,requisition_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(session.tenantId, `attachment-audit:${randomUUID()}`, attachmentId, poId, session.humanId, 'import_document_uploaded', JSON.stringify({ importDocumentId, requirementCode, attachmentVersion, securityStatus: security.securityStatus }), now);
        importDocumentEvent(db, session.tenantId, poId, importDocumentId, session.humanId, previous ? 'document_replaced' : 'document_bound', { requirementCode, attachmentId, previousImportDocumentId: previous?.id ?? null }, now);
        const response = { item: { id: importDocumentId, poId, requirementCode, attachmentId, status: 'active', version: 1, securityStatus: security.securityStatus, processingStatus: security.safeForProcessing ? 'queued' : 'parse_failed' } };
        db.prepare(`INSERT INTO procurement_import_document_idempotency (tenant_id,idempotency_key,payload_hash,response_json,created_at) VALUES (?,?,?,?,?)`)
          .run(session.tenantId, key, payloadHash, JSON.stringify(response), now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      evaluatePo(db, session.tenantId, poId, context.now?.() ?? new Date());
      sendJson(res, 201, { item: documentView(db, session.tenantId, importDocumentId), replayed: false }); return true;
    }
    if (remove && method === 'DELETE') {
      if (!can(session, 'operate')) return forbidden(res, '无解除进口单证权限');
      const poId = decode(remove[1]!); const id = decode(remove[2]!); const body = await readJsonBody(req); assertOnlyKeys(body, ['expectedVersion', 'reason']);
      const expectedVersion = positiveInteger(body['expectedVersion'], 'expectedVersion'); const reason = requiredText(body['reason'], 'reason', 500);
      const current = db.prepare(`SELECT id,version,requirement_code FROM procurement_import_documents WHERE tenant_id=? AND po_id=? AND id=? AND status='active'`)
        .get(session.tenantId, poId, id) as { id: string; version: number; requirement_code: string } | undefined;
      if (!current) throw new ImportDocumentNotFoundError('有效单证绑定不存在'); if (current.version !== expectedVersion) throw new ImportDocumentConflictError('单证版本已变化', current.version);
      const now = (context.now?.() ?? new Date()).toISOString();
      const changed = db.prepare(`UPDATE procurement_import_documents SET status='removed',version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND id=? AND version=? AND status='active'`)
        .run(session.humanId, now, session.tenantId, id, expectedVersion);
      if (changed.changes !== 1) throw new ImportDocumentConflictError('单证版本已变化', expectedVersion);
      importDocumentEvent(db, session.tenantId, poId, id, session.humanId, 'document_removed', { reason, requirementCode: current.requirement_code, previousVersion: expectedVersion }, now);
      evaluatePo(db, session.tenantId, poId, context.now?.() ?? new Date());
      sendJson(res, 200, { removed: true, evaluation: evaluationView(db, session.tenantId, poId) }); return true;
    }
    sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' }); return true;
  } catch (error) {
    if (error instanceof ImportDocumentNotFoundError) { sendJson(res, 404, { error: error.message, code: 'IMPORT_DOCUMENT_NOT_FOUND' }); return true; }
    if (error instanceof ImportDocumentConflictError) { sendJson(res, 409, { error: error.message, code: 'IMPORT_DOCUMENT_VERSION_CONFLICT', currentVersion: error.currentVersion }); return true; }
    if (error instanceof ImportDocumentInputError) { sendJson(res, 422, { error: error.message, code: 'INVALID_IMPORT_DOCUMENT_INPUT' }); return true; }
    throw error;
  }
}

export function evaluateAll(db: DatabaseSync, tenantId: string, now: Date): number {
  const rows = db.prepare(`SELECT id,json FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order'`).all(tenantId) as Array<{ id: string; json: string }>;
  let count = 0; for (const row of rows) if (isImportPo(db, tenantId, row.id, safeJson(row.json))) { evaluatePo(db, tenantId, row.id, now); count += 1; } return count;
}

export function evaluatePo(db: DatabaseSync, tenantId: string, poId: string, now: Date): Record<string, unknown> {
  const poRow = db.prepare(`SELECT status,json FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, poId) as { status: string; json: string } | undefined;
  if (!poRow) throw new ImportDocumentNotFoundError('采购订单不存在');
  if (!isImportPo(db, tenantId, poId, safeJson(poRow.json))) throw new ImportDocumentInputError('采购订单没有可靠的进口路线证据');
  const activePolicy = publishedPolicy(db, tenantId); const stage = poStage(poRow.status); const requirementStates: Array<Record<string, unknown>> = [];
  let status: EvaluationStatus = 'policy_missing';
  if (activePolicy) {
    const requirements = parseRequirements(activePolicy.requirements_json);
    const applicable = requirements.filter((item) => item.required && STAGE_INDEX[item.requiredStage] <= STAGE_INDEX[stage]);
    for (const requirement of applicable) requirementStates.push(requirementState(db, tenantId, poId, requirement, now));
    status = aggregateStatus(requirementStates);
  }
  const summary = { stage, status, requirements: requirementStates, policyMissing: !activePolicy };
  const fingerprint = createHash('sha256').update(JSON.stringify({ policyId: activePolicy?.id ?? null, policyVersion: activePolicy?.version ?? null, summary })).digest('hex');
  const at = now.toISOString(); const current = db.prepare(`SELECT fingerprint,version FROM procurement_import_document_evaluations WHERE tenant_id=? AND po_id=?`).get(tenantId, poId) as { fingerprint: string; version: number } | undefined;
  if (!current) db.prepare(`INSERT INTO procurement_import_document_evaluations (tenant_id,po_id,policy_id,policy_version,status,summary_json,fingerprint,version,evaluated_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)`)
    .run(tenantId, poId, activePolicy?.id ?? null, activePolicy?.version ?? null, status, JSON.stringify(summary), fingerprint, at, at);
  else if (current.fingerprint !== fingerprint) db.prepare(`UPDATE procurement_import_document_evaluations SET policy_id=?,policy_version=?,status=?,summary_json=?,fingerprint=?,version=version+1,evaluated_at=?,updated_at=? WHERE tenant_id=? AND po_id=?`)
    .run(activePolicy?.id ?? null, activePolicy?.version ?? null, status, JSON.stringify(summary), fingerprint, at, at, tenantId, poId);
  else db.prepare(`UPDATE procurement_import_document_evaluations SET evaluated_at=? WHERE tenant_id=? AND po_id=?`).run(at, tenantId, poId);
  return evaluationView(db, tenantId, poId) ?? {};
}

function importDocumentPayload(db: DatabaseSync, session: Session, clamAvConfigured: boolean): Record<string, unknown> {
  const rows = db.prepare(`SELECT * FROM procurement_import_document_policies WHERE tenant_id=? ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,updated_at DESC,id`).all(session.tenantId) as unknown as PolicyRow[];
  const poRows = db.prepare(`SELECT id,status,version,json,updated_at FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' ORDER BY updated_at DESC,id`).all(session.tenantId) as Array<{ id: string; status: string; version: number; json: string; updated_at: string }>;
  const purchaseOrders = poRows.filter((row) => isImportPo(db, session.tenantId, row.id, safeJson(row.json))).map((row) => {
    const po = safeJson(row.json); return { id: row.id, number: po['number'] ?? po['externalId'] ?? row.id, supplierId: po['supplierId'], status: row.status, stage: poStage(row.status), version: row.version, updatedAt: row.updated_at, evaluation: evaluationView(db, session.tenantId, row.id), documents: documentsForPo(db, session.tenantId, row.id), events: documentEvents(db, session.tenantId, row.id) };
  });
  const events = db.prepare(`SELECT id,policy_id,actor_id,action,detail_json,created_at FROM procurement_import_document_policy_events WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 100`).all(session.tenantId) as Array<{ id: string; policy_id: string; actor_id: string; action: string; detail_json: string; created_at: string }>;
  return { generatedAt: latest([rows[0]?.updated_at, ...purchaseOrders.map((item) => item.updatedAt)]), clamAvConfigured, policies: rows.map(presentPolicy), publishedPolicy: rows.find((row) => row.status === 'published') ? presentPolicy(rows.find((row) => row.status === 'published')!) : null, purchaseOrders, policyEvents: events.map((row) => ({ id: row.id, policyId: row.policy_id, actorId: row.actor_id, action: row.action, detail: safeJson(row.detail_json), createdAt: row.created_at })), permissions: { configure: can(session, 'configure'), approve: can(session, 'approve'), operate: can(session, 'operate') } };
}

function requirementState(db: DatabaseSync, tenantId: string, poId: string, requirement: Requirement, now: Date): Record<string, unknown> {
  const row = db.prepare(`SELECT d.id,d.version,d.attachment_id,d.document_number,d.issued_at,d.expires_at,d.updated_at,a.file_name,a.size_bytes,a.security_status,a.processing_status,a.scan_error,a.status AS attachment_status
    FROM procurement_import_documents d JOIN procurement_attachments a ON a.tenant_id=d.tenant_id AND a.id=d.attachment_id
    WHERE d.tenant_id=? AND d.po_id=? AND d.requirement_code=? AND d.status='active'`)
    .get(tenantId, poId, requirement.code) as Record<string, any> | undefined;
  if (!row || row['attachment_status'] !== 'active') return { ...requirement, status: 'missing', evidence: '尚未绑定有效文件' };
  if (row['security_status'] !== 'clean') return { ...requirement, status: 'security_blocked', evidence: row['scan_error'] ?? '附件尚未通过 ClamAV 安全扫描', document: presentDocumentRow(row) };
  if (requirement.expiryRequired && !row['expires_at']) return { ...requirement, status: 'missing', evidence: '缺少失效日期', document: presentDocumentRow(row) };
  if (row['expires_at'] && Date.parse(row['expires_at']) < now.getTime()) return { ...requirement, status: 'expired', evidence: `已于 ${String(row['expires_at']).slice(0, 10)} 失效`, document: presentDocumentRow(row) };
  return { ...requirement, status: 'passed', evidence: '文件有效且安全扫描通过', document: presentDocumentRow(row) };
}

function aggregateStatus(states: Array<Record<string, unknown>>): EvaluationStatus {
  if (!states.length) return 'on_track';
  if (states.some((item) => item['status'] === 'security_blocked')) return 'security_blocked';
  if (states.some((item) => item['status'] === 'expired')) return 'expired';
  if (states.some((item) => item['status'] === 'missing')) return 'missing';
  return 'passed';
}

function documentsForPo(db: DatabaseSync, tenantId: string, poId: string): Record<string, unknown>[] {
  const rows = db.prepare(`SELECT d.*,a.file_name,a.content_type,a.size_bytes,a.sha256,a.security_status,a.processing_status,a.scan_error,a.parsed_at
    FROM procurement_import_documents d JOIN procurement_attachments a ON a.tenant_id=d.tenant_id AND a.id=d.attachment_id
    WHERE d.tenant_id=? AND d.po_id=? AND d.status='active' ORDER BY d.requirement_code`).all(tenantId, poId) as Array<Record<string, any>>;
  return rows.map(presentDocumentRow);
}
function documentView(db: DatabaseSync, tenantId: string, id: string): Record<string, unknown> | null {
  const row = db.prepare(`SELECT d.*,a.file_name,a.content_type,a.size_bytes,a.sha256,a.security_status,a.processing_status,a.scan_error,a.parsed_at
    FROM procurement_import_documents d JOIN procurement_attachments a ON a.tenant_id=d.tenant_id AND a.id=d.attachment_id WHERE d.tenant_id=? AND d.id=?`).get(tenantId, id) as Record<string, any> | undefined;
  return row ? presentDocumentRow(row) : null;
}
function presentDocumentRow(row: Record<string, any>): Record<string, unknown> { return { id: row['id'], poId: row['po_id'], requirementCode: row['requirement_code'], attachmentId: row['attachment_id'], documentNumber: row['document_number'], issuedAt: row['issued_at'], expiresAt: row['expires_at'], status: row['status'] ?? 'active', version: Number(row['version']), fileName: row['file_name'], contentType: row['content_type'], sizeBytes: Number(row['size_bytes'] ?? 0), sha256: row['sha256'], securityStatus: row['security_status'], processingStatus: row['processing_status'], scanError: row['scan_error'], parsedAt: row['parsed_at'], updatedAt: row['updated_at'] }; }
function evaluationView(db: DatabaseSync, tenantId: string, poId: string): Record<string, unknown> | null { const row = db.prepare(`SELECT * FROM procurement_import_document_evaluations WHERE tenant_id=? AND po_id=?`).get(tenantId, poId) as Record<string, any> | undefined; return row ? { purchaseOrderId: row['po_id'], policyId: row['policy_id'], policyVersion: row['policy_version'], status: row['status'], summary: safeJson(row['summary_json']), fingerprint: row['fingerprint'], version: Number(row['version']), evaluatedAt: row['evaluated_at'], updatedAt: row['updated_at'] } : null; }
function documentEvents(db: DatabaseSync, tenantId: string, poId: string): Record<string, unknown>[] { const rows = db.prepare(`SELECT id,import_document_id,actor_id,action,detail_json,created_at FROM procurement_import_document_events WHERE tenant_id=? AND po_id=? ORDER BY created_at DESC,id DESC LIMIT 100`).all(tenantId, poId) as Array<Record<string, any>>; return rows.map((row) => ({ id: row['id'], importDocumentId: row['import_document_id'], actorId: row['actor_id'], action: row['action'], detail: safeJson(row['detail_json']), createdAt: row['created_at'] })); }

function presentPolicy(row: PolicyRow): Record<string, unknown> { return { id: row.id, name: row.name, description: row.description, status: row.status, version: row.version, requirements: parseRequirements(row.requirements_json), createdBy: row.created_by, updatedBy: row.updated_by, publishedBy: row.published_by, createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at }; }
function policy(db: DatabaseSync, tenantId: string, id: string): PolicyRow | undefined { return db.prepare(`SELECT * FROM procurement_import_document_policies WHERE tenant_id=? AND id=?`).get(tenantId, id) as unknown as PolicyRow | undefined; }
function publishedPolicy(db: DatabaseSync, tenantId: string): PolicyRow | undefined { return db.prepare(`SELECT * FROM procurement_import_document_policies WHERE tenant_id=? AND status='published' ORDER BY published_at DESC,id LIMIT 1`).get(tenantId) as unknown as PolicyRow | undefined; }
function policyEvent(db: DatabaseSync, tenantId: string, policyId: string, actorId: string, action: string, detail: unknown, at: string): void { db.prepare(`INSERT INTO procurement_import_document_policy_events (tenant_id,id,policy_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`).run(tenantId, `import-document-policy-event:${randomUUID()}`, policyId, actorId, action, JSON.stringify(detail), at); }
function importDocumentEvent(db: DatabaseSync, tenantId: string, poId: string, documentId: string | null, actorId: string, action: string, detail: unknown, at: string): void { db.prepare(`INSERT INTO procurement_import_document_events (tenant_id,id,po_id,import_document_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(tenantId, `import-document-event:${randomUUID()}`, poId, documentId, actorId, action, JSON.stringify(detail), at); }

function assertImportPo(db: DatabaseSync, tenantId: string, poId: string): void { const row = db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, poId) as { json: string } | undefined; if (!row) throw new ImportDocumentNotFoundError('采购订单不存在'); if (!isImportPo(db, tenantId, poId, safeJson(row.json))) throw new ImportDocumentInputError('采购订单没有可靠的进口路线证据'); }
function isImportPo(db: DatabaseSync, tenantId: string, poId: string, po: Record<string, unknown>): boolean { const assignment = db.prepare(`SELECT route FROM procurement_route_assignments WHERE tenant_id=? AND po_id=?`).get(tenantId, poId) as { route: string } | undefined; if (assignment) return assignment.route === 'import'; return ['import', 'international', '进口', '海外'].includes(String(po['procurementRoute'] ?? po['route'] ?? '').trim().toLowerCase()); }
function poStage(status: string): ProcurementStage { if (['partially_received', 'received', 'closed'].includes(status)) return 'delivery_grn'; if (['partially_shipped', 'shipped'].includes(status)) return 'dispatch_transit'; if (['confirmed', 'in_production', 'awaiting_shipment'].includes(status)) return 'fulfilment_production'; if (['sent', 'awaiting_confirmation'].includes(status)) return 'supplier_commitment'; return 'po_sent'; }
function normalizeRequirements(value: unknown): Requirement[] { if (!Array.isArray(value) || value.length === 0 || value.length > 30) throw new ImportDocumentInputError('requirements 必须包含 1–30 项'); const items: Requirement[] = value.map((entry, index) => { if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ImportDocumentInputError(`requirements[${index}] 必须是对象`); const item = entry as Record<string, unknown>; const code = requiredText(item['code'], `requirements[${index}].code`, 80).toLowerCase(); if (!/^[a-z0-9][a-z0-9_-]*$/.test(code)) throw new ImportDocumentInputError(`requirements[${index}].code 格式无效`); const stageValue = item['requiredStage']; if (stageValue !== 'dispatch_transit' && stageValue !== 'delivery_grn') throw new ImportDocumentInputError(`requirements[${index}].requiredStage 无效`); const stage: Stage = stageValue; return { code, name: requiredText(item['name'], `requirements[${index}].name`, 120), description: optionalText(item['description'], `requirements[${index}].description`, 500) ?? '', required: item['required'] !== false, requiredStage: stage, expiryRequired: item['expiryRequired'] === true }; }); if (new Set(items.map((item) => item.code)).size !== items.length) throw new ImportDocumentInputError('单证代码不能重复'); return items; }
function parseRequirements(value: string): Requirement[] { try { return normalizeRequirements(JSON.parse(value)); } catch (error) { if (error instanceof ImportDocumentInputError) throw error; throw new ImportDocumentInputError('策略 requirements 无法解析'); } }
async function readJsonBody(req: IncomingMessage, max = 200_000): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > max) throw new ImportDocumentInputError('请求体过大'); chunks.push(part); } try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; } catch { throw new ImportDocumentInputError('请求体必须是 JSON 对象'); } }
function base64(value: unknown): Buffer { if (typeof value !== 'string' || !value.trim()) throw new ImportDocumentInputError('contentBase64 必填'); try { const content = Buffer.from(value, 'base64'); if (!content.length || content.toString('base64').replace(/=+$/u, '') !== value.replace(/\s+/gu, '').replace(/=+$/u, '')) throw new Error(); return content; } catch { throw new ImportDocumentInputError('contentBase64 无效'); } }
function idempotencyKey(req: IncomingMessage): string { const value = req.headers['idempotency-key']; const candidate = Array.isArray(value) ? value[0] : value; if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 200) throw new ImportDocumentInputError('Idempotency-Key 必填'); return candidate.trim(); }
function assertOnlyKeys(value: Record<string, unknown>, keys: string[]): void { const allowed = new Set(keys); for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ImportDocumentInputError(`不允许的字段: ${key}`); }
function requiredText(value: unknown, field: string, max: number): string { if (typeof value !== 'string' || !value.trim()) throw new ImportDocumentInputError(`${field} 必填`); const result = value.trim(); if (result.length > max) throw new ImportDocumentInputError(`${field} 过长`); return result; }
function optionalText(value: unknown, field: string, max: number): string | undefined { if (value === undefined || value === null || value === '') return undefined; return requiredText(value, field, max); }
function optionalDate(value: unknown, field: string): string | undefined { const text = optionalText(value, field, 80); if (!text) return undefined; const time = Date.parse(text); if (!Number.isFinite(time)) throw new ImportDocumentInputError(`${field} 必须是有效日期`); return new Date(time).toISOString(); }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new ImportDocumentInputError(`${field} 必须是正整数`); return Number(value); }
function safeJson(value: string): Record<string, any> { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {}; } catch { return {}; } }
function latest(values: Array<string | undefined>): string | null { return values.filter((value): value is string => Boolean(value)).sort((a, b) => b.localeCompare(a))[0] ?? null; }
function decode(value: string): string { try { return decodeURIComponent(value); } catch { throw new ImportDocumentInputError('路径编码无效'); } }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function forbidden(res: ServerResponse, message: string): true { sendJson(res, 403, { error: message, code: 'FORBIDDEN' }); return true; }
class ImportDocumentInputError extends Error {}
class ImportDocumentNotFoundError extends Error {}
class ImportDocumentConflictError extends Error { constructor(message: string, readonly currentVersion: number) { super(message); } }
