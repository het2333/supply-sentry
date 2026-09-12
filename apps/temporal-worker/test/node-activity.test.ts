import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { AgentRequest, AgentRuntimePort } from '@readywork/agent';
import { procurementNodeAsset } from '@readywork/supply-chain';
import type { TemporalNodeActivityInput } from '@readywork/temporal-runtime';
import { AiNodeExecutionError, executeWorkforceNode, type NodeActivityContextPort } from '../src/node-activity.js';

function activityInput(assetId: string, mode: TemporalNodeActivityInput['mode'], values: Record<string, unknown>): TemporalNodeActivityInput {
  const asset = procurementNodeAsset(assetId)!;
  const node = {
    id: `node:${assetId}`,
    kind: asset.kind,
    label: asset.descriptor.name,
    detail: asset.descriptor.description,
    name: asset.descriptor.name,
    type: asset.descriptor.type,
    typeVersion: asset.descriptor.version,
    config: {},
    sideEffects: asset.descriptor.sideEffects,
  };
  return {
    runId: 'run:test', mode, node, input: values, callbackBaseUrl: 'http://unused', attempt: 1,
    definition: { tenantId: 't1', employeeId: 'ai:test', workflowId: 'wf', workflowName: '测试', versionId: 'wf:v1', version: 'v1', nodes: [node], edges: [] },
  };
}

async function requestJson(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

test('Temporal Node Activity: 条件节点由 NodeFactory 返回选中分支', async () => {
  const result = await executeWorkforceNode(activityInput('l:cond', 'simulate', { value: true }), { executeGateway: async () => ({}) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.selectedEdgeLabels, ['true']);
});

test('Temporal Node Activity: 演练拦截副作用，自动模式统一走 Action Gateway', async () => {
  let calls = 0;
  const gateway = { executeGateway: async () => { calls += 1; return { ok: true, message_id: 'm1' }; } };
  const input = { supplier_id: 's1', subject: '询价', body: '请报价' };
  const simulated = await executeWorkforceNode(activityInput('tool:mail', 'simulate', input), gateway);
  assert.equal(simulated.sideEffectStatus, 'blocked');
  assert.equal(calls, 0);
  const automatic = await executeWorkforceNode(activityInput('tool:mail', 'autonomous', input), gateway);
  assert.equal(automatic.sideEffectStatus, 'executed');
  assert.equal(calls, 1);
});

test('Temporal Node Activity: ERP 节点的可信 action 留在冻结节点定义，调用方输入不能覆盖它', async () => {
  const input = activityInput('tool:erp', 'autonomous', { invoiceId: 42, disposition: 'exact_match', action: 'po.update' });
  input.node.label = 'ERP回写应付结果';
  input.node.parameters = { action: 'invoice.update' };
  input.node.config = { action: 'invoice.update' };
  let gatewayInput: Record<string, unknown> | undefined;
  const result = await executeWorkforceNode(input, {
    executeGateway: async (value) => {
      gatewayInput = value;
      // The API receives input.node independently; the trusted action remains in it,
      // while untrusted action control is deliberately absent from business input.
      assert.equal(input.node.parameters?.['action'], 'invoice.update');
      return { ok: true };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(gatewayInput?.['action'], undefined);
  assert.equal(gatewayInput?.['invoiceId'], 42);
  assert.equal(gatewayInput?.['disposition'], 'exact_match');
});

test('Temporal Node Activity: AI 节点调用 AgentRuntimePort 并映射结构化输出', async () => {
  const requests: AgentRequest[] = [];
  const agent: AgentRuntimePort = {
    async execute(request) {
      requests.push(request);
      return {
        reasoning: '邮件中承诺在 2026-09-03 送达',
        actions: [],
        stateUpdates: { promise_date: '2026-09-03', confidence: 0.94 },
      };
    },
  };
  const result = await executeWorkforceNode(
    activityInput('ai:eta-extract', 'supervised', { text: '我们承诺 2026-09-03 送达。' }),
    { executeGateway: async () => ({ ok: true }), agent, agentMetadata: { provider: 'deepseek-harness' } },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.workerId, 'eta-extractor');
  assert.deepEqual(requests[0]!.toolDescriptors, []);
  assert.match(requests[0]!.instruction, /actions 必须为空/);
  assert.equal(result.output['promise_date'], '2026-09-03');
  assert.equal(result.output['confidence'], 0.94);
  assert.deepEqual(result.output['agentRuntime'], { provider: 'deepseek-harness', execution: 'analysis_only' });
  assert.match(result.message, /邮件中承诺/);
});

test('Temporal Node Activity: AI node uses one immutable Twin snapshot and records the decision against it', async () => {
  const at = '2026-08-30T00:00:00.000Z';
  const events: Array<Record<string, unknown>> = [];
  let snapshotCalls = 0;
  const context: NodeActivityContextPort = {
    createSnapshot: async () => {
      snapshotCalls += 1;
      return {
        id: 'snapshot:1',
        sourceWatermark: 'watermark:1',
        contextSnapshot: {
          employeeId: 'ai:test', at, entities: [], relationships: [],
          memory: { rootEntityId: 'po:1', sourceWatermark: 'watermark:1' },
        },
      };
    },
    appendAgentEvent: async (event) => { events.push(event); },
  };
  const requests: AgentRequest[] = [];
  const agent: AgentRuntimePort = {
    async execute(request) {
      requests.push(request);
      return {
        reasoning: '承诺日期已提取',
        actions: [],
        stateUpdates: { promise_date: '2026-09-03', confidence: 0.94 },
      };
    },
  };
  const input = activityInput('ai:eta-extract', 'supervised', {
    businessObjectId: 'po:1', text: '承诺 9 月 3 日到货',
  });

  await executeWorkforceNode(input, {
    executeGateway: async () => ({ ok: true }), agent, context,
  });

  assert.equal(snapshotCalls, 1);
  assert.deepEqual(requests[0]!.contextSnapshot, {
    employeeId: 'ai:test', at, entities: [], relationships: [],
    memory: { rootEntityId: 'po:1', sourceWatermark: 'watermark:1' },
  });
  assert.deepEqual(events.map((event) => [event['eventType'], event['inputSnapshotId']]), [
    ['context_read', 'snapshot:1'],
    ['decision', 'snapshot:1'],
  ]);
  assert.equal(events[0]!['promptHash'], events[1]!['promptHash']);
});

test('Temporal Node Activity: an allowed Context root without a Context port fails before model execution', async () => {
  let modelCalls = 0;
  const agent: AgentRuntimePort = {
    async execute() {
      modelCalls += 1;
      return { reasoning: '不应执行', actions: [], stateUpdates: {} };
    },
  };

  await assert.rejects(
    () => executeWorkforceNode(
      activityInput('ai:eta-extract', 'supervised', { businessObjectId: 'po:fail-closed' }),
      { executeGateway: async () => ({ ok: true }), agent },
    ),
    /Context 端口未配置/,
  );
  assert.equal(modelCalls, 0);
});

test('Temporal Node Activity: no allowed root keeps the existing empty Context without false correlation', async () => {
  let snapshotCalls = 0;
  let eventCalls = 0;
  let request: AgentRequest | undefined;
  await executeWorkforceNode(
    activityInput('ai:eta-extract', 'supervised', {
      objectId: 'not-an-allowed-root', rootEntityId: 'also-not-allowed', nested: { poId: 'not-top-level' },
    }),
    {
      context: {
        async createSnapshot() {
          snapshotCalls += 1;
          throw new Error('must not create');
        },
        async appendAgentEvent() { eventCalls += 1; },
      },
      agent: {
        async execute(value) {
          request = value;
          return { reasoning: '无根分析', actions: [], stateUpdates: {} };
        },
      },
      executeGateway: async () => ({}),
    },
  );
  assert.equal(snapshotCalls, 0);
  assert.equal(eventCalls, 0);
  assert.deepEqual(request!.contextSnapshot.entities, []);
  assert.equal(request!.contextSnapshot.memory['rootEntityId'], undefined);
});

test('Temporal Node Activity: Context root resolution accepts only the four ruled sources', async () => {
  const roots: string[] = [];
  const context: NodeActivityContextPort = {
    async createSnapshot(input) {
      roots.push(input.rootBusinessObjectId);
      return {
        id: `snapshot:${input.rootBusinessObjectId}`, sourceWatermark: 'watermark:roots',
        contextSnapshot: {
          employeeId: input.employeeId, at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
        },
      };
    },
    async appendAgentEvent() {},
  };
  const agent: AgentRuntimePort = {
    async execute() { return { reasoning: '根已解析', actions: [], stateUpdates: {} }; },
  };
  for (const values of [
    { businessObjectId: 'po:business' },
    { aggregateId: 'po:aggregate' },
    { poId: 'po:direct' },
  ]) {
    await executeWorkforceNode(activityInput('ai:eta-extract', 'supervised', values), {
      context, agent, executeGateway: async () => ({}),
    });
  }
  const parameterInput = activityInput('ai:eta-extract', 'supervised', { objectId: 'not-allowed' });
  parameterInput.node.parameters = { rootBusinessObjectId: 'po:parameter' };
  await executeWorkforceNode(parameterInput, { context, agent, executeGateway: async () => ({}) });

  assert.deepEqual(roots, ['po:business', 'po:aggregate', 'po:direct', 'po:parameter']);
});

test('Temporal Node Activity: conflicting allowed roots fail before snapshot, model, or Gateway while normalized duplicates agree', async () => {
  let snapshotCalls = 0;
  let modelCalls = 0;
  let gatewayCalls = 0;
  const context: NodeActivityContextPort = {
    async createSnapshot(input) {
      snapshotCalls += 1;
      return {
        id: 'snapshot:root-agreement', sourceWatermark: 'watermark:root-agreement',
        contextSnapshot: {
          employeeId: input.employeeId, at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
        },
      };
    },
    async appendAgentEvent() {},
  };
  const agent: AgentRuntimePort = {
    async execute() {
      modelCalls += 1;
      return { reasoning: '根一致', actions: [], stateUpdates: {} };
    },
  };
  const conflicting = activityInput('ai:followup', 'autonomous', {
    businessObjectId: 'po:one', aggregateId: 'po:two', poId: 'po:one',
  });
  conflicting.node.parameters = { rootBusinessObjectId: 'po:three' };
  conflicting.node.sideEffects = ['发送外部邮件'];

  await assert.rejects(
    () => executeWorkforceNode(conflicting, {
      context,
      agent,
      executeGateway: async () => { gatewayCalls += 1; return { ok: true }; },
    }),
    /Context 根关联冲突/,
  );
  assert.deepEqual([snapshotCalls, modelCalls, gatewayCalls], [0, 0, 0]);

  const agreeing = activityInput('ai:eta-extract', 'supervised', {
    businessObjectId: ' po:same ', aggregateId: 'po:same', poId: 'po:same ',
  });
  agreeing.node.parameters = { rootBusinessObjectId: ' po:same' };
  await executeWorkforceNode(agreeing, { context, agent, executeGateway: async () => ({}) });
  assert.deepEqual([snapshotCalls, modelCalls, gatewayCalls], [1, 1, 0]);
});

test('Temporal Node Activity: snapshot or context_read write failure prevents model execution', async () => {
  for (const failurePoint of ['snapshot', 'context_read'] as const) {
    let modelCalls = 0;
    await assert.rejects(
      () => executeWorkforceNode(
        activityInput('ai:eta-extract', 'supervised', { businessObjectId: `po:${failurePoint}` }),
        {
          context: {
            async createSnapshot() {
              if (failurePoint === 'snapshot') throw new Error('snapshot write failed');
              return {
                id: 'snapshot:write-failure', sourceWatermark: 'watermark:write-failure',
                contextSnapshot: {
                  employeeId: 'ai:test', at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
                },
              };
            },
            async appendAgentEvent(event) {
              if (event['eventType'] === 'context_read') throw new Error('context_read write failed');
            },
          },
          agent: {
            async execute() {
              modelCalls += 1;
              return { reasoning: '不应执行', actions: [], stateUpdates: {} };
            },
          },
          executeGateway: async () => ({}),
        },
      ),
      new RegExp(`${failurePoint} write failed`),
    );
    assert.equal(modelCalls, 0);
  }
});

test('Temporal Node Activity: Agent Events never expose endpoint or credential-shaped runtime metadata', async () => {
  const events: Array<Record<string, unknown>> = [];
  const context: NodeActivityContextPort = {
    async createSnapshot() {
      return {
        id: 'snapshot:credentials', sourceWatermark: 'watermark:credentials',
        contextSnapshot: {
          employeeId: 'ai:test', at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
        },
      };
    },
    async appendAgentEvent(event) { events.push(event); },
  };
  const agent: AgentRuntimePort = {
    async execute() {
      return { reasoning: '已完成', actions: [], stateUpdates: { result: '安全结果' } };
    },
  };

  await executeWorkforceNode(
    activityInput('ai:eta-extract', 'supervised', { businessObjectId: 'po:credentials' }),
    {
      executeGateway: async () => ({ ok: true }), agent, context,
      agentMetadata: {
        provider: 'apiKey=provider-key-must-not-leak',
        model: 'https://models.internal.example/v1',
        reasoningProfile: 'off',
      },
    },
  );

  assert.doesNotMatch(JSON.stringify(events), /provider-key-must-not-leak|apiKey|models\.internal|https:/i);
  assert.equal(events.every((event) => event['model'] === 'configured-agent-model'), true);
  assert.equal(events.every((event) => (event['payload'] as Record<string, unknown>)['provider'] === 'configured-agent-runtime'), true);
  assert.equal(events.every((event) => /^[a-f0-9]{64}$/.test(String(event['promptHash']))), true);
});

test('Temporal Node Activity: Agent Events reject port and malformed-scheme model endpoints while preserving namespaced IDs', async () => {
  const recordedModels: string[] = [];
  const context: NodeActivityContextPort = {
    async createSnapshot(input) {
      return {
        id: `snapshot:${input.rootBusinessObjectId}`, sourceWatermark: 'watermark:model-identifiers',
        contextSnapshot: {
          employeeId: input.employeeId, at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
        },
      };
    },
    async appendAgentEvent(event) {
      if (event['eventType'] === 'decision') recordedModels.push(String(event['model']));
    },
  };
  const agent: AgentRuntimePort = {
    async execute() {
      return { reasoning: '已完成', actions: [], stateUpdates: { result: '安全结果' } };
    },
  };
  const cases = [
    { model: 'models.internal.example:443/v1', expected: 'configured-agent-model' },
    { model: 'https:/models.internal.example/v1', expected: 'configured-agent-model' },
    { model: 'deepseek/model_v1.2', expected: 'deepseek/model_v1.2' },
  ];

  for (const [index, value] of cases.entries()) {
    await executeWorkforceNode(
      activityInput('ai:eta-extract', 'supervised', { businessObjectId: `po:model-identifier:${index}` }),
      {
        executeGateway: async () => ({ ok: true }), agent, context,
        agentMetadata: { provider: 'safe-provider', model: value.model, reasoningProfile: 'off' },
      },
    );
  }

  assert.deepEqual(recordedModels, cases.map((value) => value.expected));
});

test('Temporal Node Activity: trusted worker profiles record actual model and reasoning while input cannot override routing', async () => {
  const events: Array<Record<string, unknown>> = [];
  const routed: string[] = [];
  const context: NodeActivityContextPort = {
    async createSnapshot(input) {
      return {
        id: `snapshot:${input.rootBusinessObjectId}`, sourceWatermark: 'watermark:profile',
        contextSnapshot: {
          employeeId: input.employeeId, at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
        },
      };
    },
    async appendAgentEvent(event) { events.push(event); },
  };
  const agent: AgentRuntimePort = {
    async execute() { return { reasoning: '已完成', actions: [], stateUpdates: {} }; },
  };
  const agentMetadata = {
    provider: 'deepseek-official',
    resolveProfile(employeeId: string, workerId: string) {
      routed.push(`${employeeId}:${workerId}`);
      return workerId === 'invoice-parser'
        ? { model: 'invoice-model', reasoningProfile: 'max' }
        : { model: 'eta-model', reasoningProfile: 'low' };
    },
  };

  await executeWorkforceNode(
    activityInput('ai:eta-extract', 'supervised', {
      businessObjectId: 'po:profile:eta', model: 'attacker-model', reasoningEffort: 'off',
    }),
    { executeGateway: async () => ({}), agent, context, agentMetadata },
  );
  await executeWorkforceNode(
    activityInput('ai:inv-parse', 'supervised', {
      businessObjectId: 'invoice:profile', model: 'attacker-model', reasoningEffort: 'off',
    }),
    { executeGateway: async () => ({}), agent, context, agentMetadata },
  );

  assert.deepEqual(routed, ['ai:test:eta-extractor', 'ai:test:invoice-parser']);
  const decisions = events.filter((event) => event['eventType'] === 'decision');
  assert.deepEqual(decisions.map((event) => [
    event['model'], event['reasoningProfile'], (event['payload'] as Record<string, unknown>)['provider'],
  ]), [
    ['eta-model', 'low', 'deepseek-official'],
    ['invoice-model', 'max', 'deepseek-official'],
  ]);
  assert.doesNotMatch(JSON.stringify(decisions), /attacker-model/);
});

test('Temporal Node Activity: Agent Event payloads bound model-controlled output keys', async () => {
  const events: Array<Record<string, unknown>> = [];
  await executeWorkforceNode(
    activityInput('ai:eta-extract', 'supervised', { businessObjectId: 'po:bounded-event' }),
    {
      context: {
        async createSnapshot() {
          return {
            id: 'snapshot:bounded-event', sourceWatermark: 'watermark:bounded-event',
            contextSnapshot: {
              employeeId: 'ai:test', at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
            },
          };
        },
        async appendAgentEvent(event) { events.push(event); },
      },
      agent: {
        async execute() {
          return { reasoning: '已完成', actions: [], stateUpdates: { ['x'.repeat(10_000)]: true } };
        },
      },
      executeGateway: async () => ({}),
    },
  );
  const decision = events.find((event) => event['eventType'] === 'decision')!;
  const payload = decision['payload'] as Record<string, unknown>;
  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') < 4_096);
  assert.ok((payload['outputKeys'] as string[]).every((key) => key.length <= 200));
});

test('Temporal Node Activity: worker HTTP client binds tenant and sends redacted correlated Context writes', async (t) => {
  const previousInternalToken = process.env['READYWORK_INTERNAL_TOKEN'];
  const previousRuntime = process.env['READYWORK_AGENT_RUNTIME'];
  const previousTemporalAddress = process.env['TEMPORAL_ADDRESS'];
  process.env['READYWORK_INTERNAL_TOKEN'] = 'context-internal-token';
  process.env['READYWORK_AGENT_RUNTIME'] = 'inmemory';
  process.env['TEMPORAL_ADDRESS'] = '127.0.0.1:1';
  t.after(() => {
    if (previousInternalToken === undefined) delete process.env['READYWORK_INTERNAL_TOKEN'];
    else process.env['READYWORK_INTERNAL_TOKEN'] = previousInternalToken;
    if (previousRuntime === undefined) delete process.env['READYWORK_AGENT_RUNTIME'];
    else process.env['READYWORK_AGENT_RUNTIME'] = previousRuntime;
    if (previousTemporalAddress === undefined) delete process.env['TEMPORAL_ADDRESS'];
    else process.env['TEMPORAL_ADDRESS'] = previousTemporalAddress;
  });

  const operations: string[] = [];
  const contextBodies: Record<string, unknown>[] = [];
  const contextTokens: Array<string | undefined> = [];
  const server = createServer(async (request, response) => {
    const path = request.url ?? '';
    const body = await requestJson(request);
    if (path === '/api/internal/context/v1/snapshots') {
      operations.push('snapshot');
      contextBodies.push(body);
      contextTokens.push(request.headers['x-readywork-internal-token'] as string | undefined);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        data: {
          id: 'snapshot:http:1', sourceWatermark: 'watermark:http:1', createdAt: '2026-08-30T00:00:00.000Z',
          snapshot: {
            schemaVersion: 'manufacturing-context/v1',
            root: {
              id: 'entity:po:1', entityType: 'purchase_order', attributes: { businessObjectId: 'po:1' },
              state: { missingFacts: ['shipment'] }, observedAt: '2026-08-29T23:00:00.000Z',
            },
            entities: [], relations: [], evidence: [], sourceWatermark: 'watermark:http:1',
          },
        },
      }));
      return;
    }
    if (path === '/api/internal/context/v1/agent-events') {
      const eventType = String(body['eventType']);
      operations.push(eventType);
      contextBodies.push(body);
      contextTokens.push(request.headers['x-readywork-internal-token'] as string | undefined);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { id: `event:${eventType}` } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  let requestContext: AgentRequest['contextSnapshot'] | undefined;
  const agent: AgentRuntimePort = {
    async execute(request) {
      operations.push('model');
      requestContext = request.contextSnapshot;
      return { reasoning: '交期已提取', actions: [], stateUpdates: { promise_date: '2026-09-03' } };
    },
  };
  const { createTemporalActivities } = await import('../src/index.js');
  const activities = createTemporalActivities({
    agent,
    agentMetadata: { provider: 'inmemory', model: 'inmemory-deterministic', reasoningProfile: 'off' },
  });
  const input = activityInput('ai:eta-extract', 'supervised', {
    businessObjectId: 'po:1', apiKey: 'model-key-must-not-leak',
    rawEmailBody: 'raw-email-body-must-not-leak', attachmentBytes: 'attachment-bytes-must-not-leak',
  });
  input.callbackBaseUrl = `http://127.0.0.1:${address.port}`;
  input.callbackToken = 'legacy-callback-token';

  await activities.executeNode(input);

  assert.deepEqual(operations, ['snapshot', 'context_read', 'model', 'decision']);
  assert.equal((requestContext!.memory['manufacturingContext'] as Record<string, any>)['root']['id'], 'entity:po:1');
  assert.equal(contextBodies[0]!['tenantId'], 't1');
  assert.equal(contextBodies[0]!['rootEntityId'], undefined);
  assert.equal(contextBodies[0]!['rootBusinessObjectId'], 'po:1');
  assert.equal(contextBodies[0]!['permission'], undefined);
  assert.equal(contextBodies[0]!['entityTypes'], undefined);
  assert.deepEqual(contextTokens, ['context-internal-token', 'context-internal-token', 'context-internal-token']);
  const serializedEvents = JSON.stringify(contextBodies.slice(1));
  assert.doesNotMatch(serializedEvents, /model-key-must-not-leak|raw-email-body-must-not-leak|attachment-bytes-must-not-leak|legacy-callback-token|context-internal-token/i);
  assert.match(String(contextBodies[1]!['promptHash']), /^[a-f0-9]{64}$/);
  assert.match(String(contextBodies[2]!['responseHash']), /^[a-f0-9]{64}$/);
  assert.equal(contextBodies[2]!['model'], 'inmemory-deterministic');
  assert.equal(contextBodies[2]!['reasoningProfile'], 'off');
});

test('Temporal Node Activity: worker Context HTTP errors fail closed with safe messages before model execution', async (t) => {
  const previousInternalToken = process.env['READYWORK_INTERNAL_TOKEN'];
  process.env['READYWORK_INTERNAL_TOKEN'] = 'context-failure-token';
  t.after(() => {
    if (previousInternalToken === undefined) delete process.env['READYWORK_INTERNAL_TOKEN'];
    else process.env['READYWORK_INTERNAL_TOKEN'] = previousInternalToken;
  });
  const server = createServer(async (request, response) => {
    await requestJson(request);
    if (request.url === '/api/internal/context/v1/snapshots') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'upstream token=context-secret-must-not-leak' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let modelCalls = 0;
  const { createTemporalActivities } = await import('../src/index.js');
  const input = activityInput('ai:eta-extract', 'supervised', { businessObjectId: 'po:http-failure' });
  input.callbackBaseUrl = `http://127.0.0.1:${address.port}`;
  input.callbackToken = 'legacy-token-must-not-leak';

  await assert.rejects(
    () => createTemporalActivities({
      agent: {
        async execute() {
          modelCalls += 1;
          return { reasoning: '不应执行', actions: [], stateUpdates: {} };
        },
      },
    }).executeNode(input),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Context 内部写入失败 (503)');
      assert.doesNotMatch(JSON.stringify(error), /context-secret-must-not-leak|legacy-token-must-not-leak/);
      return true;
    },
  );
  assert.equal(modelCalls, 0);
});

test('Temporal Node Activity: worker HTTP client preserves deterministic 422 Gateway receipt for failed action_result', async (t) => {
  const previousInternalToken = process.env['READYWORK_INTERNAL_TOKEN'];
  process.env['READYWORK_INTERNAL_TOKEN'] = 'context-failed-receipt-token';
  t.after(() => {
    if (previousInternalToken === undefined) delete process.env['READYWORK_INTERNAL_TOKEN'];
    else process.env['READYWORK_INTERNAL_TOKEN'] = previousInternalToken;
  });
  const events: Array<Record<string, unknown>> = [];
  const receipt = {
    ok: false,
    idempotencyKey: 'run:test:node:ai:followup:email.send',
    connector: 'email',
    action: 'send',
    error: '权限拒绝: email.send',
  };
  const server = createServer(async (request, response) => {
    const body = await requestJson(request);
    if (request.url === '/api/internal/context/v1/snapshots') {
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        data: {
          id: 'snapshot:http-failed-receipt', sourceWatermark: 'watermark:http-failed-receipt',
          createdAt: '2026-08-30T00:00:00.000Z',
          snapshot: { entities: [], relations: [], root: { id: 'entity:po:failed-receipt' } },
        },
      }));
      return;
    }
    if (request.url === '/api/internal/context/v1/agent-events') {
      events.push(body);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { id: `event:${String(body['eventType'])}` } }));
      return;
    }
    if (request.url === '/api/internal/actions/execute') {
      response.writeHead(422, { 'content-type': 'application/json' });
      response.end(JSON.stringify(receipt));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { createTemporalActivities } = await import('../src/index.js');
  const input = activityInput('ai:followup', 'autonomous', { businessObjectId: 'po:http-failed-receipt' });
  input.node.sideEffects = ['发送外部邮件'];
  input.callbackBaseUrl = `http://127.0.0.1:${address.port}`;
  input.callbackToken = 'callback-failed-receipt-token';

  const result = await createTemporalActivities({
    agent: {
      async execute() {
        return { reasoning: '等待受控执行', actions: [], stateUpdates: { subject: '催交', body: '请回复' } };
      },
    },
  }).executeNode(input);

  assert.deepEqual(result.output['action'], receipt);
  const actionResult = events.find((event) => event['eventType'] === 'action_result');
  assert.ok(actionResult);
  assert.equal(actionResult['status'], 'failed');
});

test('Temporal Node Activity: 模型建议只作为数据返回，不能绕过 Action Gateway', async () => {
  let gatewayCalls = 0;
  let gatewayInput: Record<string, unknown> | undefined;
  const agent: AgentRuntimePort = {
    async execute() {
      return {
        reasoning: '已生成催交邮件，等待受控发送',
        actions: [{ type: 'tool', tool: 'email', action: 'send', args: { supplier_id: 's1', body: '请催交' } }],
        stateUpdates: { subject: '请确认交期', body: '请尽快回复新的交期。' },
        output: { action: { tool: 'email', action: 'send' } },
      };
    },
  };
  const input = activityInput('ai:followup', 'autonomous', { po: { id: 'PO-1' } });
  // 模拟未来配置了副作用的 AI 节点：唯一可执行路径仍应是现有 Gateway。
  input.node.sideEffects = ['发送外部邮件'];
  const result = await executeWorkforceNode(input, {
    agent,
    executeGateway: async (value) => {
      gatewayCalls += 1;
      gatewayInput = value;
      return { ok: true, message_id: 'm-controlled' };
    },
  });

  assert.equal(gatewayCalls, 1);
  assert.equal(result.sideEffectStatus, 'executed');
  assert.equal((gatewayInput as Record<string, unknown>)['actions'], undefined);
  assert.equal((gatewayInput as Record<string, unknown>)['action'], undefined);
  assert.equal((gatewayInput as Record<string, unknown>)['actionSuggestions'], undefined);
  assert.equal(result.output['actions'], undefined);
  assert.deepEqual(result.output['actionSuggestions'], [{ type: 'tool', tool: 'email', action: 'send', args: { supplier_id: 's1', body: '请催交' } }]);
  assert.deepEqual(result.output['action'], { ok: true, message_id: 'm-controlled' });
});

test('Temporal Node Activity: post-Gateway Agent Event failure reuses the idempotent Gateway result on retry', async () => {
  const operations: string[] = [];
  let gatewayRequests = 0;
  let externalEffects = 0;
  let cachedGatewayResult: Record<string, unknown> | undefined;
  let failFirstActionResult = true;
  const context: NodeActivityContextPort = {
    async createSnapshot() {
      operations.push('snapshot');
      return {
        id: 'snapshot:side-effect', sourceWatermark: 'watermark:side-effect',
        contextSnapshot: {
          employeeId: 'ai:test', at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [],
          memory: { rootEntityId: 'po:side-effect' },
        },
      };
    },
    async appendAgentEvent(event) {
      const eventType = String(event['eventType']);
      operations.push(eventType);
      if (eventType === 'action_result' && failFirstActionResult) {
        failFirstActionResult = false;
        throw new Error('Agent Event store unavailable');
      }
    },
  };
  const agent: AgentRuntimePort = {
    async execute() {
      operations.push('model');
      return {
        reasoning: '已生成受控催交邮件', actions: [],
        stateUpdates: { subject: '请确认交期', body: '请尽快回复新的交期。' },
      };
    },
  };
  const input = activityInput('ai:followup', 'autonomous', { businessObjectId: 'po:side-effect' });
  input.node.sideEffects = ['发送外部邮件'];
  const executeGateway = async (): Promise<Record<string, unknown>> => {
    operations.push('gateway');
    gatewayRequests += 1;
    if (cachedGatewayResult) return { ...cachedGatewayResult, replayed: true };
    externalEffects += 1;
    cachedGatewayResult = {
      ok: true, idempotencyKey: 'run:test:node:ai:followup:email.send',
      connector: 'email', action: 'send', output: { messageId: 'm-once' },
    };
    return cachedGatewayResult;
  };

  await assert.rejects(
    () => executeWorkforceNode(input, { agent, context, executeGateway }),
    /Agent Event store unavailable/,
  );
  const result = await executeWorkforceNode(input, { agent, context, executeGateway });

  assert.equal(result.status, 'completed');
  assert.equal(gatewayRequests, 2);
  assert.equal(externalEffects, 1);
  assert.deepEqual(operations.slice(0, 7), [
    'snapshot', 'context_read', 'model', 'decision', 'action_requested', 'gateway', 'action_result',
  ]);
  assert.deepEqual(operations.slice(7), [
    'snapshot', 'context_read', 'model', 'decision', 'action_requested', 'gateway', 'action_result',
  ]);
});

test('Temporal Node Activity: deterministic failed Gateway receipt records failed action_result', async () => {
  const events: Array<Record<string, unknown>> = [];
  const context: NodeActivityContextPort = {
    async createSnapshot() {
      return {
        id: 'snapshot:failed-receipt', sourceWatermark: 'watermark:failed-receipt',
        contextSnapshot: {
          employeeId: 'ai:test', at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
        },
      };
    },
    async appendAgentEvent(event) { events.push(event); },
  };
  const input = activityInput('ai:followup', 'autonomous', { businessObjectId: 'po:failed-receipt' });
  input.node.sideEffects = ['发送外部邮件'];
  await executeWorkforceNode(input, {
    context,
    agent: {
      async execute() {
        return { reasoning: '等待受控执行', actions: [], stateUpdates: { subject: '催交', body: '请回复' } };
      },
    },
    executeGateway: async () => ({
      ok: false, idempotencyKey: 'gateway:permission-denied', connector: 'email', action: 'send',
      error: '权限拒绝: email.send', retryable: false,
    }),
  });

  const actionResult = events.find((event) => event['eventType'] === 'action_result');
  assert.ok(actionResult);
  assert.equal(actionResult['status'], 'failed');
  assert.equal((actionResult['payload'] as Record<string, unknown>)['ok'], false);
});

test('Temporal Node Activity: uncertain Gateway return does not record action_result', async () => {
  const events: string[] = [];
  const context: NodeActivityContextPort = {
    async createSnapshot() {
      return {
        id: 'snapshot:uncertain', sourceWatermark: 'watermark:uncertain',
        contextSnapshot: {
          employeeId: 'ai:test', at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
        },
      };
    },
    async appendAgentEvent(event) { events.push(String(event['eventType'])); },
  };
  const input = activityInput('ai:followup', 'autonomous', { businessObjectId: 'po:uncertain' });
  input.node.sideEffects = ['发送外部邮件'];
  await executeWorkforceNode(input, {
    context,
    agent: {
      async execute() {
        return { reasoning: '等待受控执行', actions: [], stateUpdates: { subject: '催交', body: '请回复' } };
      },
    },
    executeGateway: async () => ({
      ok: false, idempotencyKey: 'gateway:uncertain', connector: 'email', action: 'send',
      recoveryState: 'manual_reconciliation', error: '外部结果不确定',
    }),
  });

  assert.deepEqual(events, ['context_read', 'decision', 'action_requested']);
});

test('Temporal Node Activity: unknown nonempty Gateway recoveryState does not record action_result', async () => {
  const events: string[] = [];
  const context: NodeActivityContextPort = {
    async createSnapshot() {
      return {
        id: 'snapshot:unknown-recovery', sourceWatermark: 'watermark:unknown-recovery',
        contextSnapshot: {
          employeeId: 'ai:test', at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
        },
      };
    },
    async appendAgentEvent(event) { events.push(String(event['eventType'])); },
  };
  const input = activityInput('ai:followup', 'autonomous', { businessObjectId: 'po:unknown-recovery' });
  input.node.sideEffects = ['发送外部邮件'];

  await executeWorkforceNode(input, {
    context,
    agent: {
      async execute() {
        return { reasoning: '等待受控执行', actions: [], stateUpdates: { subject: '催交', body: '请回复' } };
      },
    },
    executeGateway: async () => ({
      ok: false, idempotencyKey: 'gateway:unknown-recovery', connector: 'email', action: 'send',
      recoveryState: 'uncertain', error: '外部结果不确定',
    }),
  });

  assert.deepEqual(events, ['context_read', 'decision', 'action_requested']);
});

test('Temporal Node Activity: Gateway transport throw does not record action_result', async () => {
  const events: string[] = [];
  const context: NodeActivityContextPort = {
    async createSnapshot() {
      return {
        id: 'snapshot:transport-throw', sourceWatermark: 'watermark:transport-throw',
        contextSnapshot: {
          employeeId: 'ai:test', at: '2026-08-30T00:00:00.000Z', entities: [], relationships: [], memory: {},
        },
      };
    },
    async appendAgentEvent(event) { events.push(String(event['eventType'])); },
  };
  const input = activityInput('ai:followup', 'autonomous', { businessObjectId: 'po:transport-throw' });
  input.node.sideEffects = ['发送外部邮件'];

  await assert.rejects(
    () => executeWorkforceNode(input, {
      context,
      agent: {
        async execute() {
          return { reasoning: '等待受控执行', actions: [], stateUpdates: { subject: '催交', body: '请回复' } };
        },
      },
      executeGateway: async () => { throw new Error('transport unavailable'); },
    }),
    /transport unavailable/,
  );

  assert.deepEqual(events, ['context_read', 'decision', 'action_requested']);
});

test('Temporal Node Activity: AI Runtime 错误使用安全且可重试的节点错误语义', async () => {
  const agent: AgentRuntimePort = {
    async execute() {
      throw new Error('provider token=secret-value timeout');
    },
  };
  await assert.rejects(
    () => executeWorkforceNode(activityInput('ai:eta-extract', 'autonomous', { text: '交期未知' }), { agent, executeGateway: async () => ({}) }),
    (error: unknown) => {
      assert.ok(error instanceof AiNodeExecutionError);
      assert.match(error.message, /AI 节点推理失败：交期提取/);
      assert.doesNotMatch(error.message, /secret-value/);
      assert.equal(error.code, 'AI_RUNTIME_EXECUTION_FAILED');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack ?? '', /secret-value/);
      assert.doesNotMatch(JSON.stringify(error), /secret-value/);
      return true;
    },
  );
});

test('Temporal Node Activity: 非 AI 节点不会调用 AgentRuntimePort', async () => {
  let calls = 0;
  const agent: AgentRuntimePort = {
    async execute() {
      calls += 1;
      return { reasoning: '不应调用', actions: [], stateUpdates: {} };
    },
  };
  const result = await executeWorkforceNode(activityInput('l:cond', 'simulate', { value: true }), {
    agent,
    executeGateway: async () => ({}),
  });
  assert.equal(result.status, 'completed');
  assert.equal(calls, 0);
});
