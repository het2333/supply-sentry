import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepseekChat, modelApiConfigured, ModelRequestError, publicModelFailure, routeChatModel } from '../src/chat.js';

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

test('公开演示可通过通用本地模型配置调用确定性模型，不需要 DeepSeek 环境变量', async () => {
  const previous = {
    base: process.env.READYWORK_MODEL_BASE_URL,
    key: process.env.READYWORK_MODEL_API_KEY,
    deepseekBase: process.env.DEEPSEEK_BASE_URL,
    deepseekKey: process.env.DEEPSEEK_API_KEY,
  };
  const originalFetch = globalThis.fetch;
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_API_KEY;
  process.env.READYWORK_MODEL_BASE_URL = 'http://mock-model.test:18080';
  process.env.READYWORK_MODEL_API_KEY = 'local-demo-placeholder';
  let request: Request | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request = new Request(input, init);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    assert.equal(modelApiConfigured(), true);
    const result = await deepseekChat([{ role: 'user', content: 'status' }], [], 'demo-model');
    assert.equal(result.message.content, '{"ok":true}');
    assert.equal(request?.url, 'http://mock-model.test:18080/chat/completions');
    assert.equal(request?.headers.get('authorization'), 'Bearer local-demo-placeholder');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      READYWORK_MODEL_BASE_URL: previous.base,
      READYWORK_MODEL_API_KEY: previous.key,
      DEEPSEEK_BASE_URL: previous.deepseekBase,
      DEEPSEEK_API_KEY: previous.deepseekKey,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
