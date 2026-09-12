import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { twinProjectionPayloadHash } from '@readywork/persistence';
import {
  canonicalTwinJson,
  isSqliteManufacturingContextStoreBoundTo,
  isSqliteTwinProjectionQueueBoundTo,
  sanitizeContextValue,
  SqliteManufacturingContextStore,
  SqliteTwinProjectionQueue,
} from '@readywork/context';

type CorrectionStatus = 'pending' | 'approved' | 'rejected';

export interface ManufacturingContextCorrectionContext {
  db: DatabaseSync;
  tenantId: string;
  store: SqliteManufacturingContextStore;
  queue: SqliteTwinProjectionQueue;
}

export interface TwinCorrectionApproval {
  tenantId: string;
  id: string;
  kind: 'twin_fact_correction';
  objectId: string;
  status: CorrectionStatus;
  entityId: string;
  factPath: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  evidenceReference: string;
  requestedBy: string;
  requestedAt: string;
  version: number;
  decidedBy?: string;
  decidedAt?: string;
}

export interface RequestTwinCorrectionInput {
  entityId: string;
  factPath: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  evidenceReference: string;
  requestedBy: string;
  requesterPermission: string;
  requestedAt: string;
}

export interface DecideTwinCorrectionInput {
  approvalId: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
  approverPermission: string;
  decidedAt: string;
}

interface ApprovalRow {
  kind: string;
  status: string;
  json: string;
}

const MAX_EVIDENCE_REFERENCE_LENGTH = 128;
const MAX_REASON_LENGTH = 500;
const MAX_FACT_STRING_LENGTH = 512;
const OPAQUE_EVIDENCE_REFERENCE = /^(?:attachment|document|message|evidence|confirmation):[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TWIN_FACT_PATH = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/;
const TWIN_IDENTIFIER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ISO_INSTANT_VALUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EMAIL_OR_MIME_CONTENT = /(?:^|\s)(?:from|to|cc|bcc|subject|content-type|mime-version)\s*:|<\/?(?:html|body|mime)\b/i;
const ATTACHMENT_CONTENT = /(?:data:[^,\s]+;base64,|base64\b)/i;

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Twin correction ${field} 不能为空`);
  return value.trim();
}

function requireHumanIdentity(value: string, field: string): string {
  const identity = requireText(value, field);
  if (!identity.startsWith('human:') || identity.length === 'human:'.length) {
    throw new Error(`Twin correction ${field} 必须是人工身份`);
  }
  return identity;
}

function requireIsoDate(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || !value || !Number.isFinite(parsed)) {
    throw new Error(`Twin correction ${field} 必须是有效时间`);
  }
  return new Date(parsed).toISOString();
}

function withImmediateTransaction<T>(db: DatabaseSync, body: () => T): T {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    if (ownsTransaction) db.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function assertContextBoundary(context: ManufacturingContextCorrectionContext): void {
  requireText(context.tenantId, 'tenantId');
  if (!isSqliteManufacturingContextStoreBoundTo(context.store, context.db, context.tenantId)
    || !isSqliteTwinProjectionQueueBoundTo(context.queue, context.db, context.tenantId)) {
    throw new Error('Twin correction Store 或 Queue 与上下文 DB/租户不一致');
  }
}

function looksLikeBase64(value: string): boolean {
  return value.length >= 24 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function sanitizedText(value: string, field: string, maximumLength: number): string {
  const text = requireText(value, field);
  if (text.length > maximumLength || /[\u0000\r\n]/.test(text)
    || EMAIL_OR_MIME_CONTENT.test(text) || ATTACHMENT_CONTENT.test(text) || looksLikeBase64(text)) {
    throw new Error(`Twin correction ${field} 超出安全边界`);
  }
  const sanitized = sanitizeContextValue({ [field]: text }, {
    includeContactDetails: true,
    includeCommercialTerms: true,
  }) as Record<string, unknown>;
  if (sanitized[field] !== text) throw new Error(`Twin correction ${field} 包含敏感内容`);
  return text;
}

function safeEvidenceReference(value: string): string {
  const reference = requireText(value, '证据引用');
  if (reference.length > MAX_EVIDENCE_REFERENCE_LENGTH || !OPAQUE_EVIDENCE_REFERENCE.test(reference)) {
    throw new Error('Twin correction 证据引用必须是受限的 opaque reference');
  }
  return reference;
}

function safeFactValue(value: unknown, field: string): string | number | boolean | null {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Twin correction ${field} 必须是安全标量`);
    return value;
  }
  if (typeof value !== 'string' || value.length > MAX_FACT_STRING_LENGTH || /[\u0000\r\n]/.test(value)
    || EMAIL_OR_MIME_CONTENT.test(value) || ATTACHMENT_CONTENT.test(value) || looksLikeBase64(value)
    || (!ISO_INSTANT_VALUE.test(value) && !TWIN_IDENTIFIER_VALUE.test(value))) {
    throw new Error(`Twin correction ${field} 必须是安全标量事实值`);
  }
  const sanitized = sanitizeContextValue({ [field]: value }, {
    includeContactDetails: true,
    includeCommercialTerms: true,
  }) as Record<string, unknown>;
  if (sanitized[field] !== value) throw new Error(`Twin correction ${field} 包含敏感内容`);
  return value;
}

function sanitizedTwinPayload(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeContextValue(value, {
    includeContactDetails: true,
    includeCommercialTerms: true,
  }) as Record<string, unknown>;
}

function correctionApprovalFromRow(row: ApprovalRow, tenantId: string): TwinCorrectionApproval {
  if (row.kind !== 'twin_fact_correction') throw new Error('Twin correction 审批类型不匹配');
  const approval = JSON.parse(row.json) as TwinCorrectionApproval;
  if (approval.tenantId !== tenantId || approval.kind !== 'twin_fact_correction') {
    throw new Error('Twin correction 审批不存在或不属于当前租户');
  }
  return approval;
}

function correctionSourceHash(approval: TwinCorrectionApproval): string {
  return createHash('sha256').update(canonicalTwinJson({
    approvalId: approval.id,
    entityId: approval.entityId,
    factPath: approval.factPath,
    oldValue: approval.oldValue,
    newValue: approval.newValue,
    reason: approval.reason,
    evidenceReference: approval.evidenceReference,
    requestedBy: approval.requestedBy,
    decidedBy: approval.decidedBy,
    decidedAt: approval.decidedAt,
    version: approval.version,
  })).digest('hex');
}

/** Creates a governed, tenant-bound correction request without changing source facts. */
export function requestTwinCorrection(
  context: ManufacturingContextCorrectionContext,
  input: RequestTwinCorrectionInput,
): TwinCorrectionApproval {
  assertContextBoundary(context);
  if (input.requesterPermission !== 'operate') throw new Error('Twin correction 请求需要 operate 权限');
  const entityId = requireText(input.entityId, 'entityId');
  const entity = context.store.getEntity(entityId);
  if (!entity) throw new Error('Twin correction 实体不存在或不属于当前租户');
  const factPath = requireText(input.factPath, 'factPath');
  if (!TWIN_FACT_PATH.test(factPath)) throw new Error('Twin correction factPath 不受支持');
  const reason = sanitizedText(input.reason, 'reason', MAX_REASON_LENGTH);
  const evidenceReference = safeEvidenceReference(input.evidenceReference);
  const requestedBy = requireHumanIdentity(input.requestedBy, 'requestedBy');
  const requestedAt = requireIsoDate(input.requestedAt, 'requestedAt');
  const oldValue = safeFactValue(input.oldValue, 'oldValue');
  const newValue = safeFactValue(input.newValue, 'newValue');
  const objectId = typeof entity.attributes['businessObjectId'] === 'string' && entity.attributes['businessObjectId'].trim()
    ? entity.attributes['businessObjectId'].trim() : entity.id;
  const approval: TwinCorrectionApproval = {
    tenantId: context.tenantId,
    id: `twin-correction:${randomUUID()}`,
    kind: 'twin_fact_correction',
    objectId,
    status: 'pending',
    entityId,
    factPath,
    oldValue,
    newValue,
    reason,
    evidenceReference,
    requestedBy,
    requestedAt,
    version: 1,
  };
  context.db.prepare(`INSERT INTO procurement_execution_approvals
    (tenant_id,id,kind,object_id,status,json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    context.tenantId, approval.id, approval.kind, approval.objectId, approval.status,
    JSON.stringify(approval), approval.requestedAt, approval.requestedAt,
  );
  return approval;
}

/**
 * Decides a correction under one owner transaction. The Store and queue both
 * join that transaction, so no partial approval can become visible.
 */
export function decideTwinCorrection(
  context: ManufacturingContextCorrectionContext,
  input: DecideTwinCorrectionInput,
): TwinCorrectionApproval {
  assertContextBoundary(context);
  if (input.approverPermission !== 'approve') throw new Error('Twin correction 审批需要 approve 权限');
  const approvalId = requireText(input.approvalId, 'approvalId');
  const decidedBy = requireHumanIdentity(input.decidedBy, 'decidedBy');
  if (input.decision !== 'approved' && input.decision !== 'rejected') {
    throw new Error('Twin correction decision 不受支持');
  }
  const decidedAt = requireIsoDate(input.decidedAt, 'decidedAt');
  return withImmediateTransaction(context.db, () => {
    const row = context.db.prepare(`SELECT kind,status,json FROM procurement_execution_approvals
      WHERE tenant_id=? AND id=?`).get(context.tenantId, approvalId) as ApprovalRow | undefined;
    if (!row) throw new Error('Twin correction 审批不存在或不属于当前租户');
    const approval = correctionApprovalFromRow(row, context.tenantId);
    if (approval.status !== 'pending') {
      if (approval.status === input.decision && approval.decidedBy === decidedBy) return approval;
      throw new Error('Twin correction 审批结论冲突');
    }
    if (approval.requestedBy === decidedBy) throw new Error('请求人不能审批自己');

    const decided: TwinCorrectionApproval = {
      ...approval,
      status: input.decision,
      decidedBy,
      decidedAt,
    };
    const changed = context.db.prepare(`UPDATE procurement_execution_approvals
      SET status=?,json=?,updated_at=?
      WHERE tenant_id=? AND id=? AND kind='twin_fact_correction' AND status='pending'`).run(
      decided.status, JSON.stringify(decided), decidedAt, context.tenantId, approvalId,
    );
    if (Number(changed.changes) !== 1) throw new Error('Twin correction 审批状态冲突');

    if (decided.status === 'approved') {
      const evidence = context.store.appendEvidence({
        entityId: decided.entityId,
        sourceSemantics: 'approved_human',
        sourceKind: 'twin_fact_correction',
        sourceId: decided.id,
        sourceVersion: String(decided.version),
        sourceHash: correctionSourceHash(decided),
        factPath: decided.factPath,
        value: decided.newValue,
        confidence: 1,
        effectiveAt: decidedAt,
        observedAt: decidedAt,
        actorId: decidedBy,
        rawReference: sanitizedTwinPayload({
          approvalId: decided.id,
          evidenceReference: decided.evidenceReference,
          requestedBy: decided.requestedBy,
        }),
      });
      context.queue.enqueue({
        sourceTable: 'procurement_execution_approvals',
        sourceKey: decided.id,
        sourceRevision: String(decided.version),
        eventType: 'twin_fact_correction.approved',
        payloadHash: twinProjectionPayloadHash({ approval: decided, evidenceId: evidence.id }),
        availableAt: decidedAt,
      });
      context.store.appendAgentEvent({
        employeeId: decidedBy,
        runId: `twin-correction:${decided.id}`,
        taskId: decided.id,
        businessObjectId: decided.objectId,
        entityId: decided.entityId,
        eventType: 'human_feedback',
        actionName: 'twin.correction_approved',
        status: 'approved',
        confidence: 1,
        evidenceIds: [evidence.id],
        payload: sanitizedTwinPayload({
          approvalId: decided.id,
          factPath: decided.factPath,
          newValue: decided.newValue,
          evidenceReference: decided.evidenceReference,
          requestedBy: decided.requestedBy,
          decidedBy,
        }),
        createdAt: decidedAt,
      });
    }

    const action = decided.status === 'approved' ? 'twin.correction_approved' : 'twin.correction_rejected';
    context.db.prepare(`INSERT INTO runtime_activities
      (tenant_id,id,object_id,json,updated_at) VALUES (?,?,?,?,?)`).run(
      context.tenantId,
      `activity:twin-correction:${decided.id}:${decided.status}`,
      decided.objectId,
      JSON.stringify({
        id: `activity:twin-correction:${decided.id}:${decided.status}`,
        at: decidedAt,
        objectId: decided.objectId,
        actor: decidedBy,
        action,
        summary: decided.status === 'approved' ? 'Twin 人工纠正已批准' : 'Twin 人工纠正已拒绝',
        context: { approvalId: decided.id, entityId: decided.entityId, factPath: decided.factPath },
      }),
      decidedAt,
    );
    return decided;
  });
}
