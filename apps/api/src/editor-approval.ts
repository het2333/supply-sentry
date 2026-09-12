import { approvalRoleAllowed } from '@readywork/temporal-runtime';
import type { ApprovalSignalPayload, TemporalRunState } from '@readywork/temporal-runtime';
import type { DatabaseSync } from 'node:sqlite';
import type { Session } from './auth.js';

export type EditorApprovalPreparation =
  | { ok: true; payload: ApprovalSignalPayload }
  | { ok: false; status: 403 | 409; code: 'APPROVAL_ROLE_FORBIDDEN' | 'APPROVAL_NOT_WAITING' | 'APPROVAL_NODE_MISMATCH'; error: string };

export type EditorApprovalDecisionClaim =
  | { kind: 'owner' }
  | { kind: 'replayed'; payload: ApprovalSignalPayload }
  | { kind: 'processing' }
  | { kind: 'conflict' };

export type ExistingEditorApprovalDecision =
  | { kind: 'replayed'; decision: 'approved' | 'rejected' }
  | { kind: 'processing' }
  | { kind: 'recoverable'; decision: 'approved' | 'rejected'; payload: ApprovalSignalPayload }
  | { kind: 'conflict' }
  | undefined;

const APPROVAL_DECISION_LEASE_MS = 60_000;

/**
 * 仅从 Temporal 的 pendingApproval 和当前可信 Session 生成审批信号。
 * 请求体中的对象、决策、版本与审批者字段一律忽略，避免客户端伪造关联或提权。
 */
export function prepareEditorApprovalSignal(
  state: TemporalRunState,
  session: Pick<Session, 'humanId' | 'role'>,
  input: Record<string, unknown>,
  decision: 'approved' | 'rejected',
): EditorApprovalPreparation {
  const pending = state.pendingApproval;
  if (state.status !== 'waiting_approval' || !pending) {
    return { ok: false, status: 409, code: 'APPROVAL_NOT_WAITING', error: '当前运行没有等待中的审批' };
  }
  const nodeId = typeof input.nodeId === 'string' ? input.nodeId.trim() : '';
  if (!nodeId || nodeId !== pending.nodeId) {
    return { ok: false, status: 409, code: 'APPROVAL_NODE_MISMATCH', error: '审批节点已变化，请刷新后重试' };
  }
  if (!approvalRoleAllowed(session.role, pending)) {
    return { ok: false, status: 403, code: 'APPROVAL_ROLE_FORBIDDEN', error: '当前角色无权处理此审批' };
  }
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 2_000) : undefined;
  return {
    ok: true,
    payload: {
      nodeId: pending.nodeId,
      decision,
      approverId: session.humanId,
      approverRole: session.role,
      businessObjectId: pending.businessObjectId,
      ...(pending.lineId ? { lineId: pending.lineId } : {}),
      decisionId: pending.decisionId,
      ruleVersion: pending.ruleVersion,
      snapshotVersion: pending.snapshotVersion,
      ...(note ? { note } : {}),
    },
  };
}

/**
 * 将同一个 Temporal decision 的结论线性化。事务中只允许第一个结论取得发送权；
 * 相同结论在成功后可幂等重放，反向结论始终冲突。
 */
export function claimEditorApprovalDecision(db: DatabaseSync, tenantId: string, runId: string, payload: ApprovalSignalPayload): EditorApprovalDecisionClaim {
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + APPROVAL_DECISION_LEASE_MS).toISOString();
  const decisionId = payload.decisionId;
  if (!decisionId || !payload.nodeId) throw new Error('审批信号缺少决策关联键');
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT decision,status,payload_json,lease_expires_at FROM control_temporal_approval_decisions WHERE tenant_id=? AND run_id=? AND decision_id=?').get(tenantId, runId, decisionId) as { decision: string; status: string; payload_json: string; lease_expires_at: string | null } | undefined;
    if (!row) {
      db.prepare("INSERT INTO control_temporal_approval_decisions (tenant_id,run_id,decision_id,node_id,decision,status,payload_json,created_at,updated_at,lease_expires_at,error) VALUES (?,?,?,?,?,'pending',?,?,?,?,NULL)").run(tenantId, runId, decisionId, payload.nodeId, payload.decision, JSON.stringify(payload), now, now, leaseExpiresAt);
      db.exec('COMMIT');
      return { kind: 'owner' };
    }
    if (row.decision !== payload.decision) {
      db.exec('COMMIT');
      return { kind: 'conflict' };
    }
    if (row.status === 'sent') {
      db.exec('COMMIT');
      try { return { kind: 'replayed', payload: JSON.parse(row.payload_json) as ApprovalSignalPayload }; }
      catch { return { kind: 'replayed', payload }; }
    }
    if (row.status === 'failed') {
      // 同一决策的发送失败允许安全重试；反向结论已在上面拒绝。
      db.prepare("UPDATE control_temporal_approval_decisions SET status='pending',payload_json=?,updated_at=?,lease_expires_at=?,error=NULL WHERE tenant_id=? AND run_id=? AND decision_id=? AND status='failed'").run(JSON.stringify(payload), now, leaseExpiresAt, tenantId, runId, decisionId);
      db.exec('COMMIT');
      return { kind: 'owner' };
    }
    if (row.status === 'pending' && (!row.lease_expires_at || Date.parse(row.lease_expires_at) <= Date.now())) {
      // 发送进程可能已在 Temporal 接收信号后中断。调用方会先重新查询
      // Temporal 状态；仍等待时才安全重发完全相同的绑定信号。
      db.prepare("UPDATE control_temporal_approval_decisions SET payload_json=?,updated_at=?,lease_expires_at=?,error=NULL WHERE tenant_id=? AND run_id=? AND decision_id=? AND status='pending'").run(JSON.stringify(payload), now, leaseExpiresAt, tenantId, runId, decisionId);
      db.exec('COMMIT');
      return { kind: 'owner' };
    }
    db.exec('COMMIT');
    return { kind: 'processing' };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction was not opened */ }
    throw error;
  }
}

/** 在 Temporal 状态已经推进后，仍让同一 API 请求获得稳定的幂等答复。 */
export function existingEditorApprovalDecision(db: DatabaseSync, tenantId: string, runId: string, nodeId: string, decision: 'approved' | 'rejected', approverId?: string): ExistingEditorApprovalDecision {
  const row = db.prepare('SELECT decision,status,lease_expires_at,payload_json FROM control_temporal_approval_decisions WHERE tenant_id=? AND run_id=? AND node_id=? ORDER BY updated_at DESC LIMIT 1').get(tenantId, runId, nodeId) as { decision: string; status: string; lease_expires_at: string | null; payload_json: string } | undefined;
  if (!row) return undefined;
  if (approverId) {
    try {
      const payload = JSON.parse(row.payload_json) as ApprovalSignalPayload;
      // 幂等成功只回放给原审批人；其他会话应走常规 Temporal 授权路径，
      // 避免在已推进状态下泄露财务审批结论。
      if (payload.approverId !== approverId) return undefined;
    } catch { return undefined; }
  }
  if (row.decision !== decision) return { kind: 'conflict' };
  if (row.status === 'sent') return { kind: 'replayed', decision: row.decision as 'approved' | 'rejected' };
  if (row.status === 'pending' && (!row.lease_expires_at || Date.parse(row.lease_expires_at) <= Date.now())) {
    try { return { kind: 'recoverable', decision: row.decision as 'approved' | 'rejected', payload: JSON.parse(row.payload_json) as ApprovalSignalPayload }; }
    catch { return { kind: 'processing' }; }
  }
  return { kind: 'processing' };
}

export function markEditorApprovalDecisionSent(db: DatabaseSync, tenantId: string, runId: string, payload: ApprovalSignalPayload): void {
  const decisionId = payload.decisionId;
  if (!decisionId) throw new Error('审批信号缺少决策关联键');
  db.prepare("UPDATE control_temporal_approval_decisions SET status='sent',updated_at=?,lease_expires_at=NULL,error=NULL WHERE tenant_id=? AND run_id=? AND decision_id=? AND decision=?").run(new Date().toISOString(), tenantId, runId, decisionId, payload.decision);
}

export function markEditorApprovalDecisionFailed(db: DatabaseSync, tenantId: string, runId: string, payload: ApprovalSignalPayload): void {
  const decisionId = payload.decisionId;
  if (!decisionId) throw new Error('审批信号缺少决策关联键');
  db.prepare("UPDATE control_temporal_approval_decisions SET status='failed',updated_at=?,lease_expires_at=NULL,error=? WHERE tenant_id=? AND run_id=? AND decision_id=? AND decision=?").run(new Date().toISOString(), 'TEMPORAL_APPROVAL_SIGNAL_UNAVAILABLE', tenantId, runId, decisionId, payload.decision);
}

/** 仅在 Temporal 审计已记录完全相同的绑定和结论时，才能把中断窗口收敛为成功。 */
export function temporalStateRecordedApproval(state: TemporalRunState, payload: ApprovalSignalPayload): boolean {
  return Boolean(payload.decisionId && state.approvalAudit?.some((audit) =>
    audit.decisionId === payload.decisionId
      && audit.decision === payload.decision
      && audit.nodeId === payload.nodeId
      && audit.businessObjectId === payload.businessObjectId,
  ));
}
