import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonValue, WorkflowNodeDefinition } from '@readywork/graph-runtime';
import { WorkflowSignalGate, approvalWaitFor, externalEventWaitFor } from '../src/signal-correlation.js';

function waitNode(parameters: Record<string, string> = {}): WorkflowNodeDefinition {
  return {
    id: 'wait:receipt',
    kind: 'logic',
    label: '等待收货',
    detail: '等待关联收货事件',
    name: '等待收货',
    type: 'logic.wait_event',
    typeVersion: 1,
    parameters,
  };
}

function approvalNode(parameters: Record<string, JsonValue> = {}): WorkflowNodeDefinition {
  return {
    id: 'approval:payable',
    kind: 'approval',
    label: '财务审批',
    detail: '审批应付差异',
    name: '财务审批',
    type: 'human.approval',
    typeVersion: 1,
    parameters,
  };
}

test('Temporal signal gate: 审批信号必须绑定身份、当前节点、对象、决策和版本，且首个有效信号才放行', () => {
  const gate = new WorkflowSignalGate();
  const binding = approvalWaitFor(approvalNode({ assigneeRole: 'finance', escalationRoles: ['cfo'] }), {
    businessObjectId: 'invoice:42', lineId: 'line:10', decisionId: 'decision:42', ruleVersion: 'rules.v3', snapshotVersion: 'snapshot:v7',
  }, { runId: 'run:1', workflowVersionId: 'wf:v7' });
  const approved = {
    nodeId: binding.nodeId,
    decision: 'approved' as const,
    approverId: 'human:cfo',
    approverRole: 'cfo',
    businessObjectId: binding.businessObjectId,
    lineId: binding.lineId,
    decisionId: binding.decisionId,
    ruleVersion: binding.ruleVersion,
    snapshotVersion: binding.snapshotVersion,
  };

  assert.equal(gate.offerApproval(approved), false);
  gate.beginApproval(binding);
  assert.equal(gate.offerApproval({ ...approved, nodeId: 'approval:other' }), false);
  assert.equal(gate.offerApproval({ ...approved, businessObjectId: 'invoice:other' }), false);
  assert.equal(gate.offerApproval({ ...approved, lineId: undefined }), false);
  assert.equal(gate.offerApproval({ ...approved, decisionId: 'decision:other' }), false);
  assert.equal(gate.offerApproval({ ...approved, ruleVersion: 'rules.v2' }), false);
  assert.equal(gate.offerApproval({ ...approved, snapshotVersion: 'snapshot:v6' }), false);
  assert.equal(gate.offerApproval({ ...approved, approverId: '' }), false);
  assert.equal(gate.offerApproval({ ...approved, approverRole: 'buyer' }), false);
  assert.equal(gate.hasApproval(binding.nodeId), false);
  // cfo 是节点显式声明的升级角色；同一等待中的第二个/并发信号仍不能覆盖首个结论。
  assert.equal(gate.offerApproval(approved), true);
  assert.equal(gate.offerApproval({ ...approved, decision: 'rejected', approverId: 'human:duplicate' }), false);
  assert.deepEqual(gate.takeApproval(binding.nodeId), approved);
  assert.equal(gate.offerApproval(approved), false);
});

test('Temporal signal gate: 旧图使用明确安全默认值，仍要求完整的新审批身份与绑定键', () => {
  const binding = approvalWaitFor(approvalNode(), {}, { runId: 'run:legacy', workflowVersionId: 'wf:v1' });
  assert.deepEqual(binding, {
    nodeId: 'approval:payable', assigneeRole: 'manager', allowedApproverRoles: ['manager', 'director'],
    businessObjectId: 'run:run:legacy', decisionId: 'approval:run:legacy:approval:payable:wf:v1', ruleVersion: 'workflow:wf:v1', snapshotVersion: 'wf:v1',
  });
  const gate = new WorkflowSignalGate();
  gate.beginApproval(binding);
  assert.equal(gate.offerApproval({ nodeId: binding.nodeId, decision: 'approved', by: 'legacy-user' }), false);
  assert.equal(gate.offerApproval({
    nodeId: binding.nodeId, decision: 'approved', approverId: 'human:manager', approverRole: 'manager',
    businessObjectId: binding.businessObjectId, decisionId: binding.decisionId, ruleVersion: binding.ruleVersion, snapshotVersion: binding.snapshotVersion,
  }), true);
});

test('Temporal signal gate: 外部事件必须匹配等待节点、事件类型和业务对象', () => {
  const gate = new WorkflowSignalGate();
  const wait = externalEventWaitFor(waitNode({ eventType: 'receipt.created' }), { businessObjectId: 'invoice:42' });
  gate.beginExternalEvent(wait);

  // 错节点可作为未来节点候选缓存，但绝不会放行当前 wait:receipt。
  assert.equal(gate.offerExternalEvent({ nodeId: 'wait:other', eventType: 'receipt.created', objectId: 'invoice:42' }), true);
  assert.equal(gate.offerExternalEvent({ nodeId: 'wait:receipt', eventType: 'receipt.updated', objectId: 'invoice:42' }), false);
  assert.equal(gate.offerExternalEvent({ nodeId: 'wait:receipt', eventType: 'receipt.created', payload: { objectId: 'invoice:other' } }), false);
  assert.equal(gate.hasExternalEvent('wait:receipt'), false);
  assert.equal(gate.offerExternalEvent({ nodeId: 'wait:receipt', eventType: 'receipt.created', payload: { businessObjectId: 'invoice:42' } }), true);
  assert.equal(gate.offerExternalEvent({ nodeId: 'wait:receipt', eventType: 'receipt.created', objectId: 'invoice:42', payload: { duplicate: true } }), false);
  assert.deepEqual(gate.takeExternalEvent('wait:receipt'), { nodeId: 'wait:receipt', eventType: 'receipt.created', payload: { businessObjectId: 'invoice:42' } });
});

test('Temporal signal gate: 有效早到外部事件在进入对应等待后可消费，错误早到不会放行', () => {
  const wait = externalEventWaitFor(waitNode({ eventType: 'receipt.created' }), { objectId: 'invoice:42' });
  const validEarly = new WorkflowSignalGate();
  assert.equal(validEarly.offerExternalEvent({ nodeId: 'wait:receipt', eventType: 'receipt.created', objectId: 'invoice:42' }), true);
  assert.equal(validEarly.offerExternalEvent({ nodeId: 'wait:receipt', eventType: 'receipt.created', objectId: 'invoice:other' }), true);
  validEarly.beginExternalEvent(wait);
  assert.equal(validEarly.hasExternalEvent('wait:receipt'), true);
  assert.deepEqual(validEarly.takeExternalEvent('wait:receipt'), { nodeId: 'wait:receipt', eventType: 'receipt.created', objectId: 'invoice:42' });

  const wrongEarly = new WorkflowSignalGate();
  assert.equal(wrongEarly.offerExternalEvent({ nodeId: 'wait:receipt', eventType: 'receipt.updated', objectId: 'invoice:42' }), true);
  wrongEarly.beginExternalEvent(wait);
  assert.equal(wrongEarly.hasExternalEvent('wait:receipt'), false);
  assert.equal(wrongEarly.takeExternalEvent('wait:receipt'), undefined);
});

test('Temporal signal gate: 错误早到候选不阻塞正确候选，等待 A 时也可缓存未来 B', () => {
  const waitA = externalEventWaitFor({ ...waitNode({ eventType: 'approval.completed' }), id: 'wait:a' }, { objectId: 'invoice:42' });
  const waitB = externalEventWaitFor({ ...waitNode({ eventType: 'receipt.created' }), id: 'wait:b' }, { objectId: 'invoice:42' });
  const gate = new WorkflowSignalGate();
  gate.beginExternalEvent(waitA);
  assert.equal(gate.offerExternalEvent({ nodeId: 'wait:b', eventType: 'receipt.updated', objectId: 'invoice:42' }), true);
  assert.equal(gate.offerExternalEvent({ nodeId: 'wait:b', eventType: 'receipt.created', objectId: 'invoice:42' }), true);
  assert.equal(gate.hasExternalEvent('wait:a'), false);
  assert.equal(gate.pendingExternalEventCount('wait:b'), 2);
  gate.takeExternalEvent('wait:a');
  gate.beginExternalEvent(waitB);
  assert.equal(gate.hasExternalEvent('wait:b'), true);
  assert.deepEqual(gate.takeExternalEvent('wait:b'), { nodeId: 'wait:b', eventType: 'receipt.created', objectId: 'invoice:42' });
});

test('Temporal signal gate: 早到候选按事件内容去重且每节点最多保留 32 条', () => {
  const gate = new WorkflowSignalGate();
  const duplicate = { nodeId: 'wait:receipt', eventType: 'receipt.created', objectId: 'invoice:42', payload: { id: 'same', amount: 1 } };
  assert.equal(gate.offerExternalEvent(duplicate), true);
  assert.equal(gate.offerExternalEvent({ ...duplicate, payload: { amount: 1, id: 'same' } }), false);
  for (let index = 0; index < 32; index += 1) {
    assert.equal(gate.offerExternalEvent({ nodeId: 'wait:receipt', eventType: 'receipt.created', objectId: 'invoice:42', payload: { id: `extra-${index}` } }), true);
  }
  assert.equal(gate.pendingExternalEventCount('wait:receipt'), 32);
});
