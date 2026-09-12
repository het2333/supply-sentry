import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AgentRuntimeConfigError,
  AgentRuntimeManager,
  createDefaultAgentRuntime,
  loadAgentRuntimeConfig,
  routeAgentProfile,
} from '@readywork/agent';
import type { AgentRequest, AgentResult, AgentRuntimePort } from '@readywork/core';

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    employeeId: 'ai:test',
    taskId: 'task:test',
    workerId: 'worker:test',
    instruction: '分类事件',
    contextSnapshot: { employeeId: 'ai:test', at: '2026-08-21T00:00:00.000Z', entities: [], relationships: [], memory: {} },
    toolDescriptors: [{ id: 'erp', name: 'ERP', actions: ['po.update'] }],
    skillDescriptors: [],
    workspace: {},
    ...overrides,
  };
}

test('loadAgentRuntimeConfig: 默认选择 DSH 并读取模型/供应商/命令/参数/超时', () => {
  const repo = mkdtempSync(join(tmpdir(), 'rw-dsh-config-'));
  const config = loadAgentRuntimeConfig({
    env: {
      READYWORK_DSH_REPO: repo,
      READYWORK_DSH_COMMAND: '/opt/node',
      READYWORK_DSH_ARGS: '["server.js","config.yml"]',
      READYWORK_DSH_PROVIDER: 'deepseek-test',
      READYWORK_DSH_MODEL: 'deepseek-test-model',
      READYWORK_DSH_MAX_TOKENS: '4096',
      READYWORK_DSH_INITIALIZE_TIMEOUT_MS: '111',
      READYWORK_DSH_TURN_TIMEOUT_MS: '222',
      READYWORK_DSH_REQUEST_TIMEOUT_MS: '333',
      READYWORK_DSH_ENV_ALLOWLIST: 'NODE_EXTRA_CA_CERTS,CUSTOM_MODEL_FLAG',
      DEEPSEEK_API_KEY: 'test-key',
    },
  });
  assert.equal(config.kind, 'dsh');
  assert.equal(config.runtimeOptions.command, '/opt/node');
  assert.deepEqual(config.runtimeOptions.args, ['server.js', 'config.yml']);
  assert.equal(config.runtimeOptions.provider, 'deepseek-test');
  assert.equal(config.runtimeOptions.model, 'deepseek-test-model');
  assert.equal(config.runtimeOptions.maxTokens, 4096);
  assert.equal(config.runtimeOptions.initializeTimeoutMs, 111);
  assert.equal(config.runtimeOptions.turnTimeoutMs, 222);
  assert.equal(config.runtimeOptions.requestTimeoutMs, 333);
  assert.deepEqual(config.runtimeOptions.inheritedEnvAllowlist, ['NODE_EXTRA_CA_CERTS', 'CUSTOM_MODEL_FLAG']);
});

test('loadAgentRuntimeConfig: 模型、推理强度与 token 预算按 worker 优先于员工路由', () => {
  const repo = mkdtempSync(join(tmpdir(), 'rw-dsh-routing-'));
  const config = loadAgentRuntimeConfig({
    env: {
      READYWORK_DSH_REPO: repo,
      READYWORK_DSH_ARGS: '[]',
      DEEPSEEK_API_KEY: 'test-key',
      READYWORK_DSH_MODEL: 'default-model',
      READYWORK_DSH_REASONING_EFFORT: 'low',
      READYWORK_DSH_MAX_TOKENS: '2048',
      READYWORK_DSH_AGENT_PROFILES: JSON.stringify({
        employees: { 'ai:finance': { model: 'finance-model', reasoningEffort: 'high', maxTokens: 8192 } },
        workers: { 'invoice-match': { model: 'invoice-model', reasoningEffort: 'max', maxTokens: 12288 } },
      }),
    },
  });
  assert.equal(config.kind, 'dsh');
  if (config.kind !== 'dsh') return;
  assert.deepEqual(routeAgentProfile(config.routing, 'ai:procurement', 'routine-check'), { model: 'default-model', reasoningEffort: 'low', maxTokens: 2048 });
  assert.deepEqual(routeAgentProfile(config.routing, 'ai:finance', 'payment-check'), { model: 'finance-model', reasoningEffort: 'high', maxTokens: 8192 });
  assert.deepEqual(routeAgentProfile(config.routing, 'ai:finance', 'invoice-match'), { model: 'invoice-model', reasoningEffort: 'max', maxTokens: 12288 });
});

test('loadAgentRuntimeConfig: 拒绝不安全或无界的模型路由配置', () => {
  const repo = mkdtempSync(join(tmpdir(), 'rw-dsh-routing-invalid-'));
  const base = { READYWORK_DSH_REPO: repo, READYWORK_DSH_ARGS: '[]', DEEPSEEK_API_KEY: 'test-key' };
  assert.throws(() => loadAgentRuntimeConfig({ env: { ...base, READYWORK_DSH_REASONING_EFFORT: 'ultra' } }), /仅支持 off、low、medium、high 或 max/);
  assert.throws(() => loadAgentRuntimeConfig({ env: { ...base, READYWORK_DSH_MAX_TOKENS: '127' } }), /128-131072/);
  assert.throws(() => loadAgentRuntimeConfig({ env: { ...base, READYWORK_DSH_AGENT_PROFILES: '{"employees":{"ai:test":{"maxTokens":999999}}}' } }), /128-131072/);
  assert.throws(() => loadAgentRuntimeConfig({ env: { ...base, READYWORK_DSH_AGENT_PROFILES: '{"workers":{"w":{"provider":"untrusted"}}}' } }), /不支持字段/);
});

test('loadAgentRuntimeConfig: DSH 缺失时报错，不静默降级', () => {
  assert.throws(() => loadAgentRuntimeConfig({ env: {} }), /READYWORK_DSH_REPO/);
  assert.throws(
    () => loadAgentRuntimeConfig({ env: { READYWORK_DSH_REPO: join(tmpdir(), 'definitely-not-a-dsh-repository') } }),
    AgentRuntimeConfigError,
  );
  assert.throws(
    () => loadAgentRuntimeConfig({ env: { READYWORK_AGENT_RUNTIME: 'unknown' }, legacyDshRepository: join(tmpdir(), 'missing') }),
    /dsh 或 inmemory/,
  );
});

test('loadAgentRuntimeConfig: 模型密钥缺失明确失败且不回显配置值；本地 mock 可无 key', () => {
  const repo = mkdtempSync(join(tmpdir(), 'rw-dsh-credential-'));
  const remote = 'https://model.example.invalid/contains-sensitive-tenant';
  assert.throws(
    () => loadAgentRuntimeConfig({ env: { READYWORK_DSH_REPO: repo, READYWORK_DSH_ARGS: '[]', DEEPSEEK_BASE_URL: remote } }),
    (error: unknown) => {
      assert.ok(error instanceof AgentRuntimeConfigError);
      assert.match(error.message, /DEEPSEEK_API_KEY/);
      assert.ok(!error.message.includes(remote));
      return true;
    },
  );
  const local = loadAgentRuntimeConfig({
    env: { READYWORK_DSH_REPO: repo, READYWORK_DSH_ARGS: '[]', DEEPSEEK_BASE_URL: 'http://127.0.0.1:18080' },
  });
  assert.equal(local.kind, 'dsh');
  assert.equal(local.runtimeOptions.env['DEEPSEEK_API_KEY'], 'readywork-local-model');
});

test('loadAgentRuntimeConfig: 默认使用 Readywork 的 decision-only Cordis', () => {
  const repo = mkdtempSync(join(tmpdir(), 'rw-dsh-safe-cordis-'));
  const bin = join(repo, 'packages/examples/jsonrpc-demo/src/bin.ts');
  mkdirSync(join(repo, 'packages/examples/jsonrpc-demo/src'), { recursive: true });
  writeFileSync(bin, '// test fixture');
  const config = loadAgentRuntimeConfig({
    env: { READYWORK_DSH_REPO: repo, DEEPSEEK_BASE_URL: 'http://localhost:18080' },
  });
  assert.equal(config.kind, 'dsh');
  const cordis = config.runtimeOptions.args.at(-1) ?? '';
  assert.match(cordis, /packages\/agent\/config\/decision-only\.cordis\.yml$/);
  const composition = readFileSync(cordis, 'utf8');
  assert.match(composition, /toolBash:\s*false/);
  assert.match(composition, /toolJobs:\s*false/);
  assert.doesNotMatch(composition, /dsh-(?:bash|tool-fs|mcp)/);
});

test('createDefaultAgentRuntime: 只有显式 inmemory 才使用确定性桩', async () => {
  const manager = createDefaultAgentRuntime({
    env: { READYWORK_AGENT_RUNTIME: 'inmemory' },
    inMemory: { defaultHandler: () => ({ reasoning: 'ok', actions: [], stateUpdates: { classification: 'po' } }) },
  });
  assert.equal(manager.getDescription().kind, 'inmemory');
  assert.equal(manager.getDescription().directBusinessTools, false);
  assert.equal(manager.getHealth().ready, false);
  const result = await manager.execute(request());
  assert.equal(result.stateUpdates['classification'], 'po');
  assert.equal(manager.getHealth().status, 'ready');
  assert.equal(manager.getHealth().ready, true);
  await manager.close();
  assert.equal(manager.getHealth().status, 'closed');
  assert.equal(manager.getHealth().ready, false);
  await assert.rejects(() => manager.execute(request()), /停止接收/);
});

const FAKE_DSH_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let route = {};
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    route = { model: msg.params.model, maxTokens: msg.params.maxTokens, reasoningEffort: process.env.READYWORK_DSH_REASONING_EFFORT };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } } }) + '\\n');
  } else if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { messageId: 'm1' } }) + '\\n');
    const event = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: sid, event: value } }) + '\\n');
    event({ type: 'agent/inbox/spliced', data: { inserted: [{ id: 'm1' }] } });
    event({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ reasoning: 'dsh', actions: [], stateUpdates: { classification: 'invoice', sessionRoot: process.env.DSH_SESSION_ROOT, route } }) }] } } });
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: sid, status: 'idle' } }) + '\\n');
  }
});`;

test('createDefaultAgentRuntime: DSH 是默认实现，描述和健康状态不泄露密钥', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'rw-dsh-manager-'));
  const secret = 'sk-sensitive-test-value';
  const manager = createDefaultAgentRuntime({
    env: {
      READYWORK_DSH_REPO: repo,
      READYWORK_DSH_COMMAND: process.execPath,
      READYWORK_DSH_ARGS: JSON.stringify(['-e', FAKE_DSH_SCRIPT]),
      READYWORK_DSH_MODEL: 'deepseek-test',
      DEEPSEEK_API_KEY: secret,
      READYWORK_DSH_SESSION_ROOT: join(repo, 'sessions'),
    },
  });
  const descriptionText = JSON.stringify(manager.getDescription());
  assert.equal(manager.getDescription().kind, 'dsh');
  assert.equal(manager.getDescription().isolation, 'per_employee_process');
  assert.equal(manager.getDescription().directBusinessTools, false);
  assert.ok(!descriptionText.includes(secret));
  assert.ok(!descriptionText.includes('DEEPSEEK_API_KEY'));

  const result = await manager.execute(request());
  assert.equal(result.stateUpdates['classification'], 'invoice');
  assert.equal(manager.getHealth().status, 'ready');
  assert.equal(manager.getHealth().ready, true);
  assert.ok(!JSON.stringify(manager.getHealth()).includes(secret));

  const other = await manager.execute(request({ employeeId: 'ai:../../other-employee' }));
  const firstRoot = String(result.stateUpdates['sessionRoot']);
  const otherRoot = String(other.stateUpdates['sessionRoot']);
  assert.notEqual(firstRoot, otherRoot);
  assert.ok(firstRoot.startsWith(join(repo, 'sessions')));
  assert.ok(otherRoot.startsWith(join(repo, 'sessions')));
  assert.ok(!otherRoot.includes('..'));
  await manager.close();
});

test('createDefaultAgentRuntime: worker 路由将模型、推理强度与 token 预算传至各自隔离的 Harness', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'rw-dsh-routed-manager-'));
  const manager = createDefaultAgentRuntime({
    env: {
      READYWORK_DSH_REPO: repo,
      READYWORK_DSH_COMMAND: process.execPath,
      READYWORK_DSH_ARGS: JSON.stringify(['-e', FAKE_DSH_SCRIPT]),
      DEEPSEEK_API_KEY: 'test-key',
      READYWORK_DSH_MODEL: 'routine-model',
      READYWORK_DSH_REASONING_EFFORT: 'low',
      READYWORK_DSH_MAX_TOKENS: '2048',
      READYWORK_DSH_AGENT_PROFILES: JSON.stringify({
        employees: { 'ai:finance': { model: 'finance-model', reasoningEffort: 'high', maxTokens: 8192 } },
        workers: { 'invoice-match': { model: 'invoice-model', reasoningEffort: 'max', maxTokens: 12288 } },
      }),
    },
  });
  try {
    const routine = await manager.execute(request({ employeeId: 'ai:procurement', workerId: 'routine-check' }));
    const finance = await manager.execute(request({ employeeId: 'ai:finance', workerId: 'payment-check' }));
    const invoice = await manager.execute(request({ employeeId: 'ai:finance', workerId: 'invoice-match' }));
    assert.deepEqual(routine.stateUpdates['route'], { model: 'routine-model', maxTokens: 2048, reasoningEffort: 'low' });
    assert.deepEqual(finance.stateUpdates['route'], { model: 'finance-model', maxTokens: 8192, reasoningEffort: 'high' });
    assert.deepEqual(invoice.stateUpdates['route'], { model: 'invoice-model', maxTokens: 12288, reasoningEffort: 'max' });
  } finally {
    await manager.close();
  }
});

test('AgentRuntimeManager: 关闭时停止接单并等待在途执行', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  let closed = false;
  const runtime: AgentRuntimePort & { close(): Promise<void> } = {
    async execute(): Promise<AgentResult> {
      await gate;
      return { reasoning: 'done', actions: [], stateUpdates: {} };
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
  const manager = new AgentRuntimeManager(runtime, {
    kind: 'inmemory',
    implementation: 'InMemoryAgentAdapter',
    isolation: 'in_process',
    directBusinessTools: false,
  });
  const running = manager.execute(request());
  while (manager.getHealth().inFlight === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  const closing = manager.close();
  assert.equal(manager.getHealth().ready, false);
  await assert.rejects(() => manager.execute(request()), /停止接收/);
  assert.equal(closed, false);
  release();
  await running;
  assert.equal(manager.getHealth().ready, false);
  await closing;
  assert.equal(closed, true);
  assert.equal(manager.getHealth().status, 'closed');
});

test('AgentRuntimeManager: 健康错误自动脱敏', async () => {
  const secret = 'top-secret-value';
  const runtime: AgentRuntimePort = {
    async execute(): Promise<AgentResult> {
      throw new Error(`token=${secret}`);
    },
  };
  const manager = new AgentRuntimeManager(
    runtime,
    { kind: 'inmemory', implementation: 'InMemoryAgentAdapter', isolation: 'in_process', directBusinessTools: false },
    { redactValues: [secret] },
  );
  await assert.rejects(() => manager.execute(request()));
  assert.equal(manager.getHealth().status, 'unhealthy');
  assert.equal(manager.getHealth().ready, false);
  assert.ok(!JSON.stringify(manager.getHealth()).includes(secret));
  assert.match(manager.getHealth().detail ?? '', /REDACTED/);
});
