import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryAgentAdapter } from '@readywork/agent';
import { InMemoryContextStore } from '@readywork/context';
import type { EmployeeSpec } from '@readywork/core';
import { createRuntimeHub, emptyStats, nowIso } from '@readywork/core';
import { SkillRegistry } from '@readywork/skills';
import type { ToolDef } from '@readywork/tools';
import { ToolRegistry } from '@readywork/tools';
import { WorkflowEngine } from '@readywork/workflow';

function setup() {
  const hub = createRuntimeHub();
  hub.org.registerTenant({ id: 't1', name: '测试租户' });
  hub.org.registerDepartment({ id: 'd1', tenantId: 't1', name: '测试部' });
  hub.org.registerHuman({ id: 'h:manager', tenantId: 't1', deptId: 'd1', name: '经理', email: 'm@t.cn', role: '经理' });
  hub.org.registerAI({
    id: 'ai:test',
    tenantId: 't1',
    deptId: 'd1',
    specId: 'spec:test',
    name: '测试员工',
    role: '测试',
    status: 'idle',
    managerId: 'h:manager',
    stats: emptyStats(),
    createdAt: nowIso(),
  });
  const spec: EmployeeSpec = {
    id: 'spec:test',
    name: '测试员工',
    departmentId: 'd1',
    version: '1',
    role: '测试',
    goals: [],
    workers: ['w1'],
    workflows: ['wf'],
    skills: [],
    tools: ['fake'],
    permissions: [{ effect: 'allow', action: '*', resource: '*' }],
    policies: [],
    approvalRules: [],
    budget: { monthlyCap: 100, currency: 'CNY' },
    contextScope: [],
    evalCriteria: [],
    humanEscalation: { contactIds: [] },
  };
  hub.specs.register(spec);
  const bo = hub.objects.create({ id: 'bo:1', type: 'po', status: 'sent', attributes: { x: 1 } });
  const context = new InMemoryContextStore();
  const skills = new SkillRegistry();
  const tools = new ToolRegistry();
  const fakeTool: ToolDef = {
    id: 'fake',
    name: 'fake',
    description: '',
    actions: ['do'],
    async execute(action, args) {
      if (action === 'fail') return { ok: false, error: '模拟失败' };
      return { ok: true, data: { done: true, args }, cost: 0.1 };
    },
  };
  tools.register(fakeTool);
  const agent = new InMemoryAgentAdapter({ defaultHandler: (req) => ({ reasoning: req.instruction, actions: [], stateUpdates: {} }) });
  const engine = new WorkflowEngine({ hub, agent, skills, tools, context });
  return { hub, engine, context, tools, bo };
}

test('Workflow 引擎: agent → wait(事件恢复) → tool → end', async () => {
  const { hub, engine, bo } = setup();
  engine.register({
    id: 'wf',
    name: '测试流',
    steps: [
      { type: 'agent', worker: 'w1', instruction: '干活' },
      { type: 'wait', reason: '等外部事件', forEvent: { eventType: 'supplier_replied', objectId: '{{bo.id}}' }, untilMs: 60_000 },
      { type: 'tool', tool: 'fake', action: 'do', args: { via: '事件恢复后执行' } },
      { type: 'end' },
    ],
  });
  const task = await engine.runTask({ tenantId: 't1', employeeId: 'ai:test', workflowId: 'wf', businessObjectId: bo.id });
  assert.equal(task.status, 'waiting_external');
  assert.equal(task.checkpoint.workspace['tool.fake.do'], undefined, '等待期间不应执行后续步骤');

  hub.bus.emit({ type: 'context.event', eventType: 'supplier_replied', objectId: bo.id, at: nowIso() });
  await new Promise((r) => setTimeout(r, 50));
  const done = hub.machine.get(task.id)!;
  assert.equal(done.status, 'completed');
  const toolResult = done.checkpoint.workspace['tool.fake.do'] as { args: Record<string, unknown> };
  assert.equal(toolResult.args['via'], '事件恢复后执行');
  const emp = hub.org.getAI('ai:test')!;
  assert.equal(emp.stats.tasksCompleted, 1);
  assert.equal(emp.stats.totalCost, 0.1, '工具成本应记账');
});

test('Workflow 引擎: approval → approve → 继续 → completed', async () => {
  const { hub, engine, bo } = setup();
  engine.register({
    id: 'wf2',
    name: '审批流',
    steps: [
      { type: 'approval', ruleId: 'r1', title: '人工审批', payload: () => ({ x: 1 }) },
      { type: 'end' },
    ],
  });
  const task = await engine.runTask({ tenantId: 't1', employeeId: 'ai:test', workflowId: 'wf2', businessObjectId: bo.id });
  assert.equal(task.status, 'waiting_approval');
  const pending = hub.approvals.listPending()[0]!;
  await engine.approve(task.id, pending.id, 'h:manager');
  assert.equal(hub.machine.get(task.id)?.status, 'completed');
});

test('Workflow 引擎: 批准后副作用失败时，关联异常保持待处理而不伪装为已解决', async () => {
  const { hub, engine, bo } = setup();
  engine.register({
    id: 'wf-approval-failure',
    name: '批准后失败流',
    steps: [
      { type: 'approval', ruleId: 'r1', title: '人工审批', payload: () => ({ invoiceId: bo.id }) },
      { type: 'tool', tool: 'fake', action: 'fail', args: {} },
      { type: 'end' },
    ],
  });
  const task = await engine.runTask({ tenantId: 't1', employeeId: 'ai:test', workflowId: 'wf-approval-failure', businessObjectId: bo.id, maxRetries: 0 });
  const pending = hub.approvals.listPending()[0]!;
  const exception = hub.exceptions.listOpen().find((item) => item.approvalId === pending.id)!;

  const result = await engine.approve(task.id, pending.id, 'h:manager');
  assert.equal(result.status, 'failed');
  assert.equal(hub.exceptions.get(exception.id)?.status, 'open');
});

test('Workflow 引擎: 权限拒绝 → 重试耗尽 → failed', async () => {
  const { hub, engine, bo } = setup();
  const spec = hub.specs.get('spec:test')!;
  spec.permissions = [{ effect: 'allow', action: 'do', resource: 'fake' }];
  engine.register({
    id: 'wf3',
    name: '权限流',
    steps: [{ type: 'tool', tool: 'fake', action: 'denied-action', args: {} }, { type: 'end' }],
  });
  const task = await engine.runTask({
    tenantId: 't1',
    employeeId: 'ai:test',
    workflowId: 'wf3',
    businessObjectId: bo.id,
    maxRetries: 1,
  });
  const cur = hub.machine.get(task.id)!;
  assert.equal(cur.status, 'failed');
  assert.ok(cur.error?.includes('权限拒绝'));
  assert.equal(hub.org.getAI('ai:test')?.status, 'failed');
});
