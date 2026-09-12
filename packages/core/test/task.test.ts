import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntimeHub } from '@readywork/core';

test('Task 状态机: create → start → wait → resume → complete', () => {
  const hub = createRuntimeHub();
  const t = hub.machine.create({ tenantId: 't1', employeeId: 'e1', workflowId: 'w1', businessObjectId: 'b1' });
  assert.equal(t.status, 'created');
  hub.machine.start(t.id);
  assert.equal(hub.machine.get(t.id)?.status, 'running');
  hub.machine.wait(t.id, { reason: '等供应商', forEvent: { eventType: 'supplier_confirmed' } });
  assert.equal(hub.machine.get(t.id)?.status, 'waiting_external');
  hub.machine.resume(t.id);
  assert.equal(hub.machine.get(t.id)?.status, 'running');
  hub.machine.complete(t.id, { onTime: true });
  const done = hub.machine.get(t.id)!;
  assert.equal(done.status, 'completed');
  assert.equal(done.metadata.onTime, true);
  assert.ok(done.completedAt);
});

test('Task 状态机: 失败重试 → 重试耗尽 → 终态 failed', () => {
  const hub = createRuntimeHub();
  const t = hub.machine.create({ tenantId: 't1', employeeId: 'e1', workflowId: 'w1', businessObjectId: 'b1', maxRetries: 2 });
  hub.machine.start(t.id);
  hub.machine.fail(t.id, '供应商无响应');
  let cur = hub.machine.get(t.id)!;
  assert.equal(cur.status, 'running', '首次失败应重试');
  assert.equal(cur.attempts, 1);
  hub.machine.fail(t.id, '供应商无响应');
  cur = hub.machine.get(t.id)!;
  assert.equal(cur.status, 'running', '第二次失败仍应重试');
  assert.equal(cur.attempts, 2);
  hub.machine.fail(t.id, '供应商无响应');
  cur = hub.machine.get(t.id)!;
  assert.equal(cur.status, 'failed', '重试耗尽应终态');
  assert.equal(cur.attempts, 3);
  assert.ok(cur.error);
});

test('Task 状态机: 审批流 approve / reject', () => {
  const hub = createRuntimeHub();
  const t = hub.machine.create({ tenantId: 't1', employeeId: 'e1', workflowId: 'w1', businessObjectId: 'b1' });
  hub.machine.start(t.id);
  hub.machine.requestApproval(t.id, { ruleId: 'r1', title: '延期审批', message: '', payload: { days: 11 } });
  const pending = hub.approvals.listPending();
  assert.equal(pending.length, 1);
  assert.equal(hub.machine.get(t.id)?.status, 'waiting_approval');
  hub.machine.approve(t.id, pending[0]!.id, 'h:manager');
  assert.equal(hub.machine.get(t.id)?.status, 'running');
  assert.equal(hub.machine.get(t.id)?.checkpoint.pendingApprovalId, undefined);

  const t2 = hub.machine.create({ tenantId: 't1', employeeId: 'e1', workflowId: 'w1', businessObjectId: 'b2' });
  hub.machine.start(t2.id);
  hub.machine.requestApproval(t2.id, { ruleId: 'r1', title: '延期审批', message: '', payload: {} });
  const p2 = hub.approvals.listByTask(t2.id)[0]!;
  hub.machine.reject(t2.id, p2.id, 'h:manager', '交期不可接受');
  const rejected = hub.machine.get(t2.id)!;
  assert.equal(rejected.status, 'failed');
  assert.ok(rejected.error?.includes('审批拒绝'));
});

test('Task 状态机: 非法迁移抛错', () => {
  const hub = createRuntimeHub();
  const t = hub.machine.create({ tenantId: 't1', employeeId: 'e1', workflowId: 'w1', businessObjectId: 'b1' });
  assert.throws(() => hub.machine.complete(t.id), /非法状态迁移/);
  hub.machine.start(t.id);
  hub.machine.complete(t.id);
  assert.throws(() => hub.machine.start(t.id), /非法状态迁移/);
});

test('Task 状态机: 事件总线记录审计日志', () => {
  const hub = createRuntimeHub();
  const before = hub.eventLog.length;
  const t = hub.machine.create({ tenantId: 't1', employeeId: 'e1', workflowId: 'w1', businessObjectId: 'b1' });
  hub.machine.start(t.id);
  hub.machine.wait(t.id, { reason: '等' });
  hub.machine.resume(t.id);
  hub.machine.complete(t.id);
  const types = hub.eventLog.slice(before).map((e) => e.type);
  assert.deepEqual(types, ['task.created', 'task.started', 'task.waiting', 'task.resumed', 'task.completed']);
});

test('调度器: 定时任务触发', async () => {
  const hub = createRuntimeHub();
  let fired = false;
  await new Promise<void>((resolve) => {
    hub.scheduler.schedule(10, () => {
      fired = true;
      resolve();
    });
  });
  assert.equal(fired, true);
});
