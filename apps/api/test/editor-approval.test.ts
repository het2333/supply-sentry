import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { ApprovalWaitBinding, TemporalRunState } from '@readywork/temporal-runtime';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import { claimEditorApprovalDecision, existingEditorApprovalDecision, markEditorApprovalDecisionFailed, markEditorApprovalDecisionSent, prepareEditorApprovalSignal, temporalStateRecordedApproval } from '../src/editor-approval.js';

const pending: ApprovalWaitBinding = {
  nodeId: 'appr:tw',
  assigneeRole: 'finance',
  allowedApproverRoles: ['finance', 'cfo'],
  businessObjectId: 'invoice:42',
  lineId: 'line:10',
  decisionId: 'decision:42',
  ruleVersion: 'rules.v3',
  snapshotVersion: 'snapshot:v7',
};

function waitingState(overrides: Partial<TemporalRunState> = {}): TemporalRunState {
  return { runId: 'run:42', status: 'waiting_approval', currentNodeId: 'appr:tw', visitedNodeIds: [], message: '等待审批', pendingApproval: pending, ...overrides };
}

test('Editor 审批 API: 只以 Temporal 绑定和当前会话构造批准/驳回信号', () => {
  const session = { humanId: 'human:finance-1', role: '财务' };
  const prepared = prepareEditorApprovalSignal(waitingState(), session, {
    nodeId: 'appr:tw', note: '  可以付款  ', approverId: 'attacker', approverRole: 'cfo', businessObjectId: 'invoice:other',
    decisionId: 'decision:other', ruleVersion: 'rules.old', snapshotVersion: 'snapshot:old', lineId: 'line:other',
  }, 'approved');
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.deepEqual(prepared.payload, {
    nodeId: 'appr:tw', decision: 'approved', approverId: 'human:finance-1', approverRole: '财务',
    businessObjectId: 'invoice:42', lineId: 'line:10', decisionId: 'decision:42', ruleVersion: 'rules.v3', snapshotVersion: 'snapshot:v7', note: '可以付款',
  });

  const rejected = prepareEditorApprovalSignal(waitingState(), session, { nodeId: 'appr:tw' }, 'rejected');
  assert.equal(rejected.ok, true);
  if (rejected.ok) assert.equal(rejected.payload.decision, 'rejected');
});

test('Editor 审批 API: 无等待、节点变化或角色不匹配时不构造信号', () => {
  const session = { humanId: 'human:buyer-1', role: '采购专员' };
  const notWaiting = prepareEditorApprovalSignal(waitingState({ status: 'running', pendingApproval: undefined }), session, { nodeId: 'appr:tw' }, 'approved');
  assert.deepEqual(notWaiting, { ok: false, status: 409, code: 'APPROVAL_NOT_WAITING', error: '当前运行没有等待中的审批' });

  const wrongNode = prepareEditorApprovalSignal(waitingState(), session, { nodeId: 'appr:other' }, 'approved');
  assert.deepEqual(wrongNode, { ok: false, status: 409, code: 'APPROVAL_NODE_MISMATCH', error: '审批节点已变化，请刷新后重试' });

  const wrongRole = prepareEditorApprovalSignal(waitingState(), session, { nodeId: 'appr:tw' }, 'approved');
  assert.deepEqual(wrongRole, { ok: false, status: 403, code: 'APPROVAL_ROLE_FORBIDDEN', error: '当前角色无权处理此审批' });
});

test('Editor 审批决定：原子 claim 只接受第一个结论，相同结论可幂等重放', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const approved = prepareEditorApprovalSignal(waitingState(), { humanId: 'human:finance-1', role: '财务' }, { nodeId: 'appr:tw' }, 'approved');
  const rejected = prepareEditorApprovalSignal(waitingState(), { humanId: 'human:finance-1', role: '财务' }, { nodeId: 'appr:tw' }, 'rejected');
  assert.equal(approved.ok, true);
  assert.equal(rejected.ok, true);
  if (!approved.ok || !rejected.ok) return;

  assert.deepEqual(claimEditorApprovalDecision(db, 'tenant:test', 'run:42', approved.payload), { kind: 'owner' });
  assert.deepEqual(claimEditorApprovalDecision(db, 'tenant:test', 'run:42', rejected.payload), { kind: 'conflict' });
  assert.deepEqual(existingEditorApprovalDecision(db, 'tenant:test', 'run:42', 'appr:tw', 'approved'), { kind: 'processing' });
  markEditorApprovalDecisionSent(db, 'tenant:test', 'run:42', approved.payload);
  const replay = claimEditorApprovalDecision(db, 'tenant:test', 'run:42', approved.payload);
  assert.equal(replay.kind, 'replayed');
  assert.deepEqual(existingEditorApprovalDecision(db, 'tenant:test', 'run:42', 'appr:tw', 'rejected'), { kind: 'conflict' });
  db.close();
});

test('Editor 审批决定：同一结论按租户隔离，且成功重放只返回给原审批人', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const approved = prepareEditorApprovalSignal(waitingState(), { humanId: 'human:finance-1', role: '财务' }, { nodeId: 'appr:tw' }, 'approved');
  assert.equal(approved.ok, true);
  if (!approved.ok) return;

  // 相同 run/decision ID 在不同租户必须各自取得发送权，不能互相占用。
  assert.deepEqual(claimEditorApprovalDecision(db, 'tenant:a', 'run:shared', approved.payload), { kind: 'owner' });
  assert.deepEqual(claimEditorApprovalDecision(db, 'tenant:b', 'run:shared', approved.payload), { kind: 'owner' });
  markEditorApprovalDecisionSent(db, 'tenant:a', 'run:shared', approved.payload);

  assert.deepEqual(existingEditorApprovalDecision(db, 'tenant:a', 'run:shared', 'appr:tw', 'approved', 'human:finance-1'), { kind: 'replayed', decision: 'approved' });
  assert.equal(existingEditorApprovalDecision(db, 'tenant:a', 'run:shared', 'appr:tw', 'approved', 'human:finance-2'), undefined);
  db.close();
});

test('Editor 审批决定：Temporal 发送失败只允许相同结论安全重试', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const approved = prepareEditorApprovalSignal(waitingState(), { humanId: 'human:finance-1', role: '财务' }, { nodeId: 'appr:tw' }, 'approved');
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  assert.deepEqual(claimEditorApprovalDecision(db, 'tenant:test', 'run:retry', approved.payload), { kind: 'owner' });
  markEditorApprovalDecisionFailed(db, 'tenant:test', 'run:retry', approved.payload);
  assert.deepEqual(claimEditorApprovalDecision(db, 'tenant:test', 'run:retry', approved.payload), { kind: 'owner' });
  db.close();
});

test('Editor 审批决定：信号已送达但进程中断时，过期 pending 由 Temporal 审计收敛为重放成功', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const prepared = prepareEditorApprovalSignal(waitingState(), { humanId: 'human:finance-1', role: '财务' }, { nodeId: 'appr:tw' }, 'approved');
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.deepEqual(claimEditorApprovalDecision(db, 'tenant:test', 'run:crash', prepared.payload), { kind: 'owner' });
  // 模拟 Temporal 已接收信号、但控制面尚未来得及 mark sent 就退出。
  db.prepare("UPDATE control_temporal_approval_decisions SET lease_expires_at=? WHERE tenant_id=? AND run_id=?").run(new Date(0).toISOString(), 'tenant:test', 'run:crash');
  const stale = existingEditorApprovalDecision(db, 'tenant:test', 'run:crash', 'appr:tw', 'approved');
  assert.equal(stale?.kind, 'recoverable');
  const advanced = waitingState({
    status: 'running', pendingApproval: undefined,
    approvalAudit: [{ ...pending, approverId: 'human:finance-1', approverRole: '财务', decision: 'approved', decidedAt: new Date().toISOString() }],
  });
  assert.equal(temporalStateRecordedApproval(advanced, prepared.payload), true);
  markEditorApprovalDecisionSent(db, 'tenant:test', 'run:crash', prepared.payload);
  assert.deepEqual(existingEditorApprovalDecision(db, 'tenant:test', 'run:crash', 'appr:tw', 'approved'), { kind: 'replayed', decision: 'approved' });
  db.close();
});
