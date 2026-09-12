import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelRequestError, publicModelFailure, routeChatModel } from '../src/chat.js';

test('聊天模型路由：普通查询走快速模型，复杂或高风险任务走推理模型', () => {
  const originalFast = process.env.DEEPSEEK_FAST_MODEL;
  const originalReasoning = process.env.DEEPSEEK_REASONING_MODEL;
  process.env.DEEPSEEK_FAST_MODEL = 'fast-test';
  process.env.DEEPSEEK_REASONING_MODEL = 'reasoning-test';
  try {
    assert.deepEqual(routeChatModel('查看今天待办', []), { model: 'fast-test', complexity: 'fast' });
    assert.deepEqual(routeChatModel('请分析异常报价的审批风险并给出计划', []), { model: 'reasoning-test', complexity: 'reasoning' });
  } finally {
    if (originalFast === undefined) delete process.env.DEEPSEEK_FAST_MODEL; else process.env.DEEPSEEK_FAST_MODEL = originalFast;
    if (originalReasoning === undefined) delete process.env.DEEPSEEK_REASONING_MODEL; else process.env.DEEPSEEK_REASONING_MODEL = originalReasoning;
  }
});

test('聊天模型错误统一脱敏，超时不泄露上游响应或凭据', () => {
  assert.equal(publicModelFailure(new ModelRequestError('timeout', 'token=must-not-leak timed out')), '模型响应超时，请稍后重试。');
  const result = publicModelFailure(new Error('authorization=Bearer must-not-leak provider failed'));
  assert.equal(result, '模型服务暂不可用，请稍后重试。');
  assert.equal(result.includes('must-not-leak'), false);
});
