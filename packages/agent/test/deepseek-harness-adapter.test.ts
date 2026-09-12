import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeepSeekHarnessAdapter, parseAgentDecision } from '@readywork/agent';
import type { HarnessRuntimeLike } from '@readywork/agent';
import type { AgentRequest } from '@readywork/core';

class FakeRuntime implements HarnessRuntimeLike {
  calls: { sessionId: string; contentBlocks: { type: 'text'; text: string }[] }[] = [];
  response: string;
  events: unknown[] = [];

  constructor(response: string) {
    this.response = response;
  }

  async start(): Promise<void> {}

  async prompt(sessionId: string, contentBlocks: { type: 'text'; text: string }[]): Promise<{
    sessionId: string;
    finalResponse: string;
    events: unknown[];
  }> {
    this.calls.push({ sessionId, contentBlocks });
    return { sessionId, finalResponse: this.response, events: this.events };
  }

  async close(): Promise<void> {}
}

function makeRequest(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    employeeId: 'ai:po-ops',
    taskId: 'task:1',
    workerId: 'po-check',
    instruction: '核对订单信息与供应商确认状态',
    contextSnapshot: { employeeId: 'ai:po-ops', at: '2025-08-20T00:00:00.000Z', entities: [], relationships: [], memory: {} },
    toolDescriptors: [{ id: 'erp', name: 'ERP', actions: ['po.get'] }],
    skillDescriptors: [{ id: 'parse-delivery-date', name: '交期解析' }],
    workspace: { delay: { days: 11 } },
    ...over,
  };
}

test('DeepSeekHarnessAdapter: 组装系统提示（含快照/工具/技能标记）并解析决策 JSON', async () => {
  const fake = new FakeRuntime('```json\n{"reasoning":"已收到回复","actions":[{"type":"skill","skill":"detect-delay","input":{"baseline":"2025-08-25"}}],"stateUpdates":{"replyReceived":true}}\n```');
  const adapter = new DeepSeekHarnessAdapter({ runtime: fake });
  const req = makeRequest();
  const result = await adapter.execute(req);
  assert.equal(result.reasoning, '已收到回复');
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0]!.type, 'skill');
  assert.equal(result.stateUpdates['replyReceived'], true);
  // 系统提示应包含上下文快照与可用工具/技能
  const text = fake.calls[0]!.contentBlocks.map((b) => b.text).join('\n');
  assert.ok(text.includes('[上下文快照]'), '应有上下文快照标记');
  assert.ok(text.includes('"id":"erp"'), '应有工具清单');
  assert.ok(text.includes('parse-delivery-date'), '应有技能清单');
  assert.ok(text.includes('[任务指令] 核对订单信息与供应商确认状态'), '用户提示应含任务指令');
});

test('DeepSeekHarnessAdapter: 每次执行使用独立 session', async () => {
  const fake = new FakeRuntime('{"reasoning":"x","actions":[],"stateUpdates":{}}');
  const adapter = new DeepSeekHarnessAdapter({ runtime: fake });
  await adapter.execute(makeRequest());
  await adapter.execute(makeRequest({ workerId: 'po-reply-parse' }));
  assert.notEqual(fake.calls[0]!.sessionId, fake.calls[1]!.sessionId);
});

test('DeepSeekHarnessAdapter: 空输出抛错（交引擎重试）', async () => {
  const fake = new FakeRuntime('   ');
  const adapter = new DeepSeekHarnessAdapter({ runtime: fake });
  await assert.rejects(() => adapter.execute(makeRequest()), /未产生文本输出/);
});

test('DeepSeekHarnessAdapter: DSH turn error 仅返回安全错误码', async () => {
  const fake = new FakeRuntime('');
  fake.events = [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'token=do-not-leak' } } } }];
  const adapter = new DeepSeekHarnessAdapter({ runtime: fake });
  await assert.rejects(
    () => adapter.execute(makeRequest()),
    (error: unknown) => error instanceof Error && /code=MISSING_CREDENTIAL/.test(error.message) && !error.message.includes('do-not-leak'),
  );
});

test('DeepSeekHarnessAdapter: 非 JSON 输出抛解析错误', async () => {
  const fake = new FakeRuntime('好的，我来看一下这个订单。');
  const adapter = new DeepSeekHarnessAdapter({ runtime: fake });
  await assert.rejects(() => adapter.execute(makeRequest()), /AI 决策解析失败/);
});

test('DeepSeekHarnessAdapter: Harness 内部工具调用视为安全边界违规', async () => {
  const fake = new FakeRuntime('{"reasoning":"伪装完成","actions":[],"stateUpdates":{}}');
  fake.events = [{ type: 'tool/call', data: { name: 'email.send', arguments: '{"to":"supplier@example.com"}' } }];
  const adapter = new DeepSeekHarnessAdapter({ runtime: fake });
  await assert.rejects(() => adapter.execute(makeRequest()), /安全边界违规.*email\.send/);
});

test('parseAgentDecision: 围栏 JSON 与裸 JSON 均可解析', () => {
  const a = parseAgentDecision('```json\n{"reasoning":"r","actions":[],"stateUpdates":{"k":1}}\n```');
  assert.equal(a.stateUpdates['k'], 1);
  const b = parseAgentDecision('{"reasoning":"r2","actions":[{"type":"tool","tool":"erp","action":"po.get","args":{}}]}');
  assert.equal(b.actions[0]!.type, 'tool');
  assert.throws(() => parseAgentDecision('not json at all'));
});
