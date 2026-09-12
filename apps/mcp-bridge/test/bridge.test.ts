import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCallMap, createBridgeServer, sanitize } from '@readywork/app-mcp-bridge';
import { createRuntimeHub } from '@readywork/core';
import { SkillRegistry } from '@readywork/skills';
import type { ToolDef } from '@readywork/tools';
import { ToolRegistry } from '@readywork/tools';

const fakeTool: ToolDef = {
  id: 'erp',
  name: 'ERP',
  description: '',
  actions: ['po.get', 'po.update'],
  async execute(action) {
    return action === 'po.get' ? { ok: true, data: { po: { id: 'po:1' } }, cost: 0.1 } : { ok: false, error: 'denied' };
  },
};

function setup() {
  const hub = createRuntimeHub();
  const skills = new SkillRegistry();
  skills.register({ id: 'compose-follow-up', name: '催交', description: '', invoke: async (i) => ({ text: `催${String(i.poId)}` }) });
  const tools = new ToolRegistry();
  tools.register(fakeTool);
  return { hub, skills, tools };
}

test('MCP 桥: 工具/技能名映射', () => {
  const { skills, tools } = setup();
  const map = buildCallMap(tools, skills);
  assert.deepEqual(map.get('erp__po_get'), { kind: 'tool', toolId: 'erp', action: 'po.get' });
  assert.deepEqual(map.get('skill__compose_follow_up'), { kind: 'skill', skillId: 'compose-follow-up' });
  assert.equal(sanitize('compose-follow-up'), 'compose_follow_up');
});

test('MCP 桥: 鉴权与工具执行', async () => {
  const { hub, skills, tools } = setup();
  hub.org.registerTenant({ id: 't1', name: 'T' });
  hub.org.registerDepartment({ id: 'd1', tenantId: 't1', name: 'D' });
  hub.org.registerHuman({ id: 'h1', tenantId: 't1', deptId: 'd1', name: 'M', email: 'm@t', role: 'M' });
  hub.org.registerAI({ id: 'ai:1', tenantId: 't1', deptId: 'd1', specId: 'spec:1', name: 'E', role: 'E', status: 'idle', managerId: 'h1', stats: { tasksTotal: 0, tasksCompleted: 0, tasksFailed: 0, humanTakeovers: 0, onTimeCompleted: 0, totalCost: 0 }, createdAt: new Date().toISOString() });
  hub.specs.register({ id: 'spec:1', name: 'E', departmentId: 'd1', version: '1', role: 'E', goals: [], workers: [], workflows: [], skills: [], tools: ['erp'], permissions: [{ effect: 'allow', action: 'po.get', resource: 'erp' }], policies: [], approvalRules: [], contextScope: [], evalCriteria: [], humanEscalation: { contactIds: [] } });

  const bridge = await createBridgeServer({ hub, tools, skills, token: 'tok' });

  const call = async (path: string, body: Record<string, unknown>) => {
    const r = await fetch(`${bridge.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.json()) as { ok?: boolean; content?: string; tools?: unknown[]; error?: string };
  };

  // 鉴权失败
  const bad = await call('/list', { token: 'wrong' });
  assert.equal(bad['ok'], undefined);
  assert.equal(bad['error'], 'invalid token');

  // tools/list
  const list = await call('/list', { token: 'tok' });
  assert.ok(Array.isArray(list.tools));
  assert.ok((list.tools as { name: string }[]).some((t) => t.name === 'skill__compose_follow_up'));

  // 允许的调用
  const okRes = await call('/call', { token: 'tok', name: 'erp__po_get', arguments: { poId: 'po:1' }, employeeId: 'ai:1' });
  assert.equal(okRes.ok, true);
  assert.ok(okRes.content?.includes('po:1'));

  // 权限拒绝
  const deny = await call('/call', { token: 'tok', name: 'erp__po_update', arguments: {}, employeeId: 'ai:1' });
  assert.equal(deny.ok, false);
  assert.ok(deny.content?.includes('权限拒绝'));

  // 技能调用
  const skill = await call('/call', { token: 'tok', name: 'skill__compose_follow_up', arguments: { poId: 'po:9' }, employeeId: 'ai:1' });
  assert.equal(skill.ok, true);
  assert.ok(skill.content?.includes('催po:9'));

  await bridge.close();
});
