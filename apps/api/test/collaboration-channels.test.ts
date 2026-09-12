import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task } from '@readywork/core';
import { CollaborationControlPlane, isConfirmationRequired } from '../src/collaboration-channels.js';

const now = new Date('2026-08-21T01:00:00.000Z').getTime();
const buyer = { tenantId: 'tenant:a', humanId: 'human:buyer', role: '采购专员' };
const manager = { tenantId: 'tenant:a', humanId: 'human:manager', role: '采购经理' };
const otherTenantBuyer = { tenantId: 'tenant:b', humanId: 'human:buyer', role: '采购专员' };

function task(id: string, tenantId = 'tenant:a', metadata: Record<string, unknown> = {}): Task {
  return {
    id, tenantId, employeeId: 'ai:procurement', workflowId: 'wf:follow-up', businessObjectId: 'po:42', status: 'waiting_human',
    attempts: 0, maxRetries: 3, checkpoint: { stepIndex: 2, workspace: { note: '可见上下文', apiKey: 'must-not-leak' } },
    createdAt: '2026-08-21T00:00:00.000Z', metadata,
  };
}

function control(tasks: Task[], committed: unknown[] = []): CollaborationControlPlane {
  return new CollaborationControlPlane({
    tasks: { list: () => tasks, get: (id) => tasks.find((item) => item.id === id) },
    approvals: { listByTask: (taskId) => taskId === 'task:buyer' ? [{ id: 'approval:1', taskId, ruleId: 'buyer', title: '确认', message: '请确认', payload: { token: 'must-not-leak' }, status: 'pending', requestedAt: '2026-08-21T00:00:00.000Z' }] : [] },
    signingSecret: 'test-signing-secret-that-is-long-enough', now: () => now,
    teams: (tenantId) => tenantId === 'tenant:a' ? { tenantId, enabled: true, allowedHumanIds: ['human:buyer'] } : undefined,
    onCommitted: (record) => { committed.push(record); },
  });
}

test('我的工作按会话人员/角色过滤，详情仅向同租户可见且敏感上下文脱敏', () => {
  const tasks = [
    task('task:buyer', 'tenant:a', { assigneeHumanId: 'human:buyer' }),
    task('task:role', 'tenant:a', { assigneeRole: '采购经理' }),
    task('task:foreign', 'tenant:b', { assigneeHumanId: 'human:buyer' }),
  ];
  const channel = control(tasks);
  assert.deepEqual(channel.myWork(buyer).map((item) => item.id), ['task:buyer']);
  assert.deepEqual(channel.myWork(manager).map((item) => item.id), ['task:role']);
  const detail = channel.taskDetail(buyer, 'task:buyer');
  assert.ok(detail);
  assert.equal(JSON.stringify(detail).includes('must-not-leak'), false);
  assert.equal(channel.taskDetail(otherTenantBuyer, 'task:buyer'), undefined);
  assert.equal(channel.taskDetail(buyer, 'task:foreign'), undefined, 'tenant:a 的会话不得按相同 humanId 穿透到 tenant:b');
});

test('我的工作默认不返回完成、失败或取消任务；显式状态查询才返回任务历史', () => {
  const completed = { ...task('task:completed', 'tenant:a', { assigneeHumanId: 'human:buyer' }), status: 'completed' as const, completedAt: '2026-08-21T01:00:00.000Z' };
  const failed = { ...task('task:failed', 'tenant:a', { assigneeHumanId: 'human:buyer' }), status: 'failed' as const, failedAt: '2026-08-21T01:00:00.000Z' };
  const cancelled = { ...task('task:cancelled', 'tenant:a', { assigneeHumanId: 'human:buyer' }), status: 'cancelled' as const };
  const active = task('task:active', 'tenant:a', { assigneeHumanId: 'human:buyer' });
  const channel = control([completed, failed, cancelled, active]);
  assert.deepEqual(channel.myWork(buyer).map((item) => item.id), ['task:active']);
  assert.deepEqual(channel.myWork(buyer, { statuses: ['completed'] }).map((item) => item.id), ['task:completed']);
  assert.deepEqual(channel.myWork(buyer, { includeTerminal: true }).map((item) => item.id), ['task:completed', 'task:failed', 'task:cancelled', 'task:active']);
});

test('协同动作必须二次确认，确认凭据绑定 tenant/user/载荷，并稳定幂等', async () => {
  const committed: unknown[] = [];
  const channel = control([task('task:buyer', 'tenant:a', { assigneeHumanId: 'human:buyer' })], committed);
  const request = { taskId: 'task:buyer', action: 'accept' as const, idempotencyKey: 'accept-1' };
  const pending = await channel.requestAction(buyer, request);
  assert.equal(pending.ok, false);
  assert.equal(pending.code, 'CONFIRMATION_REQUIRED');
  if (!isConfirmationRequired(pending)) return;
  assert.equal(committed.length, 0, '首轮不得改变协同状态');
  const bypass = await channel.requestAction(buyer, { ...request, confirmationToken: 'not-a-valid-token' });
  assert.deepEqual(bypass, { ok: false, code: 'CONFIRMATION_INVALID', error: '确认凭据无效、过期，或不属于当前会话/动作' });
  const stolen = await channel.requestAction({ ...buyer, humanId: 'human:attacker' }, { ...request, confirmationToken: pending.confirmationToken });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.code, 'ACTION_FORBIDDEN');
  const committedResult = await channel.requestAction(buyer, { ...request, confirmationToken: pending.confirmationToken });
  assert.equal(committedResult.ok, true);
  if (!committedResult.ok) return;
  assert.equal(committedResult.state, 'accepted');
  assert.equal(committed.length, 1);
  const replay = await channel.requestAction(buyer, request);
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.replayed, true);
  const reuse = await channel.requestAction(buyer, { taskId: 'task:buyer', action: 'dismiss', idempotencyKey: 'accept-1' });
  assert.equal(reuse.ok, false);
  assert.equal(reuse.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('重新分配仅允许主管角色，并使用同一确认/幂等契约', async () => {
  const channel = control([task('task:buyer', 'tenant:a', { assigneeHumanId: 'human:buyer' })]);
  const denied = await channel.requestAction(buyer, { taskId: 'task:buyer', action: 'reassign', idempotencyKey: 'reassign-1', assigneeRole: '采购经理' });
  assert.deepEqual(denied, { ok: false, code: 'ACTION_FORBIDDEN', error: '当前会话无权处理该任务动作' });
  const pending = await channel.requestAction(manager, { taskId: 'task:buyer', action: 'reassign', idempotencyKey: 'reassign-1', assigneeRole: '采购经理' });
  assert.equal(pending.ok, false);
  if (!isConfirmationRequired(pending)) return;
  const result = await channel.requestAction(manager, { taskId: 'task:buyer', action: 'reassign', idempotencyKey: 'reassign-1', assigneeRole: '采购经理', confirmationToken: pending.confirmationToken });
  assert.equal(result.ok, true);
  assert.deepEqual(channel.myWork(manager).map((item) => item.id), ['task:buyer']);
});

test('Teams 仅产生 queued/unavailable payload；卡片动作签名绑定身份且不触发网络', async () => {
  const tasks = [task('task:buyer', 'tenant:a', { assigneeHumanId: 'human:buyer' })];
  const channel = control(tasks);
  const queued = channel.prepareTeamsNotification(buyer, 'task:buyer');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.code, 'TEAMS_QUEUED');
  assert.equal(JSON.stringify(queued).includes('must-not-leak'), false);
  if (!queued.payload) return;
  const actions = queued.payload.adaptiveCard['actions'] as Array<{ data: { teamsActionToken: string } }>;
  const actionToken = actions[0]!.data.teamsActionToken;
  const invalidIdentity = await channel.handleTeamsAction({ ...buyer, humanId: 'human:other' }, { taskId: 'task:buyer', action: 'accept', idempotencyKey: 'teams-1', teamsActionToken: actionToken });
  assert.equal(invalidIdentity.ok, false);
  assert.equal(invalidIdentity.code, 'TEAMS_ACTION_INVALID');
  const pending = await channel.handleTeamsAction(buyer, { taskId: 'task:buyer', action: 'accept', idempotencyKey: 'teams-1', teamsActionToken: actionToken });
  assert.equal(pending.ok, false);
  assert.equal(pending.code, 'CONFIRMATION_REQUIRED');
  if (!isConfirmationRequired(pending)) return;
  assert.deepEqual(channel.prepareTeamsNotification(otherTenantBuyer, 'task:buyer'), { status: 'unavailable', code: 'TEAMS_UNAVAILABLE', error: '任务不存在或收件人无权查看' });
});

test('协同分配和幂等结果可由权威 Task 元数据跨重启恢复', async () => {
  const stored = task('task:persistent', 'tenant:a', { assigneeHumanId: 'human:buyer' });
  const make = () => new CollaborationControlPlane({
    tasks: { list: () => [stored], get: () => stored },
    signingSecret: 'test-signing-secret-that-is-long-enough', now: () => now,
    onCommitted: (commit) => {
      const previous = stored.metadata['collaboration'];
      const old = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous as Record<string, unknown> : {};
      const previousActions = old['actions'];
      const actions = previousActions && typeof previousActions === 'object' && !Array.isArray(previousActions) ? previousActions as Record<string, unknown> : {};
      const result = { ok: true, replayed: false, taskId: commit.task.id, action: commit.action, state: commit.state, assignment: commit.assignment, committedAt: commit.committedAt };
      stored.metadata['collaboration'] = {
        assigneeHumanId: commit.assignment.humanId, assigneeRole: commit.assignment.role, state: commit.state, updatedAt: commit.committedAt,
        actions: { ...actions, [commit.idempotencyKey]: { actorTenantId: commit.actor.tenantId, actorHumanId: commit.actor.humanId, fingerprint: commit.fingerprint, result } },
      };
    },
  });
  const request = { taskId: stored.id, action: 'accept' as const, idempotencyKey: 'persistent-1' };
  const first = make();
  const pending = await first.requestAction(buyer, request);
  assert.ok(isConfirmationRequired(pending));
  if (!isConfirmationRequired(pending)) return;
  assert.equal((await first.requestAction(buyer, { ...request, confirmationToken: pending.confirmationToken })).ok, true);

  const restarted = make();
  const replay = await restarted.requestAction(buyer, request);
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.replayed, true);
  assert.equal(restarted.myWork(buyer)[0]?.collaborationStatus, 'accepted');
  const conflict = await restarted.requestAction(buyer, { taskId: stored.id, action: 'dismiss', idempotencyKey: request.idempotencyKey });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'IDEMPOTENCY_KEY_REUSED');
});
