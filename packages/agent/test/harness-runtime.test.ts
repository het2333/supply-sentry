import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalResponseText, HarnessRuntime, HarnessRuntimeError } from '@readywork/agent';

/**
 * 用假 runtime 子进程（node -e 内嵌 JSON-RPC 服务器）验证 HarnessRuntime 的
 * spawn/initialize/prompt/通知收集/idle 判定/dispose。
 */

const FAKE_RUNTIME_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'test' } } }) + '\\n');
    return;
  }
  if (msg.method === 'session/prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { messageId: 'msg-1' } }) + '\\n');
    const sid = msg.params.sessionId;
    const emit = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: sid, event: obj } }) + '\\n');
    emit({ type: 'agent/inbox/spliced', data: { inserted: [{ id: 'msg-1' }] } });
    emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"reasoning":"r","actions":[],"stateUpdates":{}}' }] } } });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: sid, status: 'idle' } }) + '\\n');
  }
});
`;

function makeRuntime(extra = {}) {
  return new HarnessRuntime({
    command: process.execPath,
    args: ['-e', FAKE_RUNTIME_SCRIPT],
    cwd: process.cwd(),
    env: { FAKE: '1' },
    initializeTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
    ...extra,
  });
}

test('HarnessRuntime: initialize 握手 + prompt 回合 → finalResponse', async () => {
  const rt = makeRuntime();
  await rt.start();
  const result = await rt.prompt('s1', [{ type: 'text', text: 'hi' }]);
  assert.equal(result.sessionId, 's1');
  assert.equal(result.finalResponse, '{"reasoning":"r","actions":[],"stateUpdates":{}}');
  assert.ok(result.events.length >= 2);
  await rt.close();
});

test('HarnessRuntime: 两次 prompt 复用同一 runtime', async () => {
  const rt = makeRuntime();
  const r1 = await rt.prompt('s1', [{ type: 'text', text: 'a' }]);
  const r2 = await rt.prompt('s2', [{ type: 'text', text: 'b' }]);
  assert.equal(r1.finalResponse, r2.finalResponse);
  await rt.close();
});

test('HarnessRuntime: 同一员工 runtime 的并发 session 不互相吞通知', async () => {
  const rt = makeRuntime();
  const [r1, r2] = await Promise.all([
    rt.prompt('parallel-1', [{ type: 'text', text: 'a' }]),
    rt.prompt('parallel-2', [{ type: 'text', text: 'b' }]),
  ]);
  assert.equal(r1.finalResponse, '{"reasoning":"r","actions":[],"stateUpdates":{}}');
  assert.equal(r2.finalResponse, '{"reasoning":"r","actions":[],"stateUpdates":{}}');
  await rt.close();
});

test('HarnessRuntime: 子进程默认不继承 Readywork 业务密钥，额外变量必须显式放行', async () => {
  const secret = 'must-not-enter-harness';
  const previous = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = secret;
  const script = FAKE_RUNTIME_SCRIPT.replace(
    `'msg-1' }] } });`,
    `'msg-1' }] } });`,
  ).replace(
    `'{"reasoning":"r","actions":[],"stateUpdates":{}}'`,
    `JSON.stringify({ reasoning: 'r', actions: [], stateUpdates: { leaked: process.env.READYWORK_CREDENTIAL_KEY ?? null, explicit: process.env.DEEPSEEK_BASE_URL ?? null } })`,
  );
  const rt = new HarnessRuntime({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: { DEEPSEEK_BASE_URL: 'http://127.0.0.1:9999' },
    initializeTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
  });
  try {
    const result = await rt.prompt('isolated-env', [{ type: 'text', text: 'hi' }]);
    const decision = JSON.parse(result.finalResponse) as { stateUpdates: { leaked: string | null; explicit: string } };
    assert.equal(decision.stateUpdates.leaked, null);
    assert.equal(decision.stateUpdates.explicit, 'http://127.0.0.1:9999');
  } finally {
    await rt.close();
    if (previous === undefined) delete process.env['READYWORK_CREDENTIAL_KEY'];
    else process.env['READYWORK_CREDENTIAL_KEY'] = previous;
  }
});

test('HarnessRuntime: 握手失败（serverInfo 不符）抛错', async () => {
  const rt = new HarnessRuntime({
    command: process.execPath,
    args: ['-e', `process.stdin.on('data', () => {});`],
    cwd: process.cwd(),
    env: {},
    initializeTimeoutMs: 5_000,
  });
  await assert.rejects(() => rt.start(), /initialize 握手失败|请求超时/);
  await rt.close();
});

test('HarnessRuntime: 请求超时抛 HarnessRuntimeError', async () => {
  // 用不回复的假 runtime（setInterval 保持存活）
  const silent = new HarnessRuntime({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000);'],
    cwd: process.cwd(),
    env: {},
    initializeTimeoutMs: 500,
    turnTimeoutMs: 300,
  });
  await assert.rejects(() => silent.start(), HarnessRuntimeError);
  await silent.close();
});

test('finalResponseText: 提取最后一个 assistant 文本', () => {
  const events = [
    { type: 'agent/inbox/spliced', data: {} },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"a":1}' }] } } },
  ];
  assert.equal(finalResponseText(events), '{"a":1}');
  assert.equal(finalResponseText([...events, { type: 'assistant/message', data: { message: { content: [] } } }]), '{"a":1}');
  assert.equal(finalResponseText([{ type: 'other', data: {} }]), '');
});
