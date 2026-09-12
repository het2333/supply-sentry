import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PO_STATE_MACHINE,
  canTransition,
  lifecycleStateMachine,
  approvalLevel,
  createRuntimeHub,
} from '@readywork/core';

test('状态机: PO 合法转移 + 部分收货 + 拒单回退', () => {
  assert.equal(canTransition(PO_STATE_MACHINE, 'draft', 'created'), true);
  assert.equal(canTransition(PO_STATE_MACHINE, 'draft', 'sent'), true);
  assert.equal(canTransition(PO_STATE_MACHINE, 'sent', 'awaiting_confirmation'), true);
  assert.equal(canTransition(PO_STATE_MACHINE, 'partially_received', 'received'), true);
  assert.equal(canTransition(PO_STATE_MACHINE, 'awaiting_confirmation', 'rejected'), true); // 拒单回退边
  assert.equal(canTransition(PO_STATE_MACHINE, 'sent', 'received'), false); // 非法跳跃
});

test('状态机: RFQ 支持线上询价与人工离线报价进入待定标', () => {
  const rfq = lifecycleStateMachine('rfq');
  assert.ok(rfq);
  assert.equal(canTransition(rfq, 'draft', 'sent'), true);
  assert.equal(canTransition(rfq, 'draft', 'pending_award'), true);
  assert.equal(canTransition(rfq, 'awaiting_quotes', 'pending_award'), true);
  assert.equal(canTransition(rfq, 'pending_award', 'awarded'), true);
  assert.equal(canTransition(rfq, 'draft', 'awarded'), false);
});

test('状态机: 类型映射', () => {
  assert.equal(lifecycleStateMachine('po')?.name, '采购订单');
  assert.equal(lifecycleStateMachine('invoice')?.name, '发票');
  assert.equal(lifecycleStateMachine('unknown'), undefined);
});

test('业务对象: 生命周期转移（合法 + 非法）', () => {
  const hub = createRuntimeHub();
  const bo = hub.objects.create({ id: 'po:1', type: 'po', status: 'sent' });
  const ok = hub.objects.transition(bo.id, 'awaiting_confirmation', { kind: 'event', summary: '已发送', by: 'ai:procurement' });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok ? ok.bo.status : '', 'awaiting_confirmation');
  const bad = hub.objects.transition(bo.id, 'received', { kind: 'event', summary: '非法', by: 'ai:procurement' });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok ? '' : bad.illegalTransition, true);
});

test('审批阈值: 交期/价格/三单差异', () => {
  assert.equal(approvalLevel('deliveryDelayDays', 2), 'auto');
  assert.equal(approvalLevel('deliveryDelayDays', 4), 'buyer');
  assert.equal(approvalLevel('deliveryDelayDays', 6), 'manager');
  assert.equal(approvalLevel('threeWayVariancePct', 0.5), 'auto');
  assert.equal(approvalLevel('threeWayVariancePct', 2), 'finance');
  assert.equal(approvalLevel('threeWayVariancePct', 5), 'manager');
});

test('统一异常中心: 创建/分配/解决', () => {
  const hub = createRuntimeHub();
  const exc = hub.exceptions.create({ type: 'delivery_delay', objectId: 'po:1', aiJudgment: '延期 6 天', recommendedAction: '采购经理审批', severity: 'high' });
  assert.equal(exc.status, 'open');
  assert.equal(hub.exceptions.listOpen().length, 1);
  hub.exceptions.assign(exc.id, 'h:procurement-manager');
  assert.equal(hub.exceptions.get(exc.id)?.status, 'assigned');
  hub.exceptions.resolve(exc.id, { by: 'h:procurement-manager', summary: '接受新交期' });
  assert.equal(hub.exceptions.get(exc.id)?.status, 'resolved');
  assert.equal(hub.exceptions.listOpen().length, 0);
});

test('统一活动/审计中心: 事件自动写 Activity', () => {
  const hub = createRuntimeHub();
  hub.bus.emit({ type: 'task.created', taskId: 'task:1', employeeId: 'ai:procurement', workflowId: 'po-operations', at: new Date().toISOString() });
  hub.bus.emit({ type: 'task.approved', taskId: 'task:1', approvalId: 'appr:1', by: 'h:procurement-manager', at: new Date().toISOString() });
  const acts = hub.activities.list('task:1');
  assert.equal(acts.length, 2);
  assert.equal(acts[0]!.action, 'task.created');
  assert.equal(acts[1]!.action, 'task.approved');
  assert.equal(acts[1]!.actor, 'h:procurement-manager');
});
