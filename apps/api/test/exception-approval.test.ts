import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApprovalRequest, Task } from '@readywork/core';
import { preflightExceptionApproval } from '../src/exception-approval.js';

const task: Task = {
  id: 'task:exception', tenantId: 'tenant:a', employeeId: 'ai:procurement', workflowId: 'wf', businessObjectId: 'invoice:42',
  status: 'waiting_approval', attempts: 0, maxRetries: 3, checkpoint: { stepIndex: 1, pendingApprovalId: 'approval:exception', workspace: {} },
  createdAt: '2026-08-21T00:00:00.000Z', metadata: {},
};

const approval: ApprovalRequest = {
  id: 'approval:exception', taskId: task.id, ruleId: 'finance', title: '财务审批', message: '请确认', payload: {}, status: 'pending', requestedAt: task.createdAt,
};

test('异常审批：只推进当前租户的当前等待项；同结论重放、相反结论冲突', () => {
  assert.deepEqual(preflightExceptionApproval(approval, task, 'tenant:a', 'approved'), { kind: 'proceed' });
  assert.deepEqual(preflightExceptionApproval({ ...approval, status: 'approved' }, { ...task, status: 'running', checkpoint: { ...task.checkpoint, pendingApprovalId: undefined } }, 'tenant:a', 'approved'), { kind: 'replayed', taskStatus: 'running' });
  assert.deepEqual(preflightExceptionApproval({ ...approval, status: 'approved' }, { ...task, status: 'running', checkpoint: { ...task.checkpoint, pendingApprovalId: undefined } }, 'tenant:a', 'rejected'), { kind: 'conflict' });
});

test('异常审批：租户、任务或等待键异常时绝不推进任务', () => {
  assert.deepEqual(preflightExceptionApproval(approval, task, 'tenant:b', 'approved'), { kind: 'invalid', error: '审批关联任务不存在或不属于当前租户' });
  assert.deepEqual(preflightExceptionApproval({ ...approval, taskId: 'task:other' }, task, 'tenant:a', 'approved'), { kind: 'invalid', error: '审批与关联任务不一致' });
  assert.deepEqual(preflightExceptionApproval(approval, { ...task, checkpoint: { ...task.checkpoint, pendingApprovalId: 'approval:other' } }, 'tenant:a', 'approved'), { kind: 'invalid', error: '审批不再是当前任务的等待项' });
});
