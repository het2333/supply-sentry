import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import {
  createDefaultAgentRuntime,
  loadAgentRuntimeConfig,
  routeAgentProfile,
  type AgentRequest,
  type AgentRuntimePort,
} from '@readywork/agent';
import type { ApprovalWaitBinding, TemporalNodeActivityInput, TemporalNodeActivityResult, TemporalRunState } from '@readywork/temporal-runtime';
import { executeWorkforceNode, type AgentRuntimeMetadata, type NodeActivityContextPort } from './node-activity.js';
import { createTemporalWorkerLifecycle } from './worker-lifecycle.js';

const address = process.env['TEMPORAL_ADDRESS'] ?? '127.0.0.1:7233';
const namespace = process.env['TEMPORAL_NAMESPACE'] ?? 'default';
const taskQueue = process.env['TEMPORAL_TASK_QUEUE'] ?? 'readywork-workforce';
const workflowsPath = fileURLToPath(new URL('../../../packages/temporal-runtime/src/workflows.ts', import.meta.url));

async function callback(baseUrl: string, path: string, token: string | undefined, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-readywork-internal-token': token } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Control Plane 回调失败 ${response.status}: ${await response.text()}`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

async function internalContextWrite(
  baseUrl: string,
  path: '/api/internal/context/v1/snapshots' | '/api/internal/context/v1/agent-events',
  token: string | undefined,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!token) throw new Error('Context 内部写入未配置授权');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-readywork-internal-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Context 内部写入超时或网络失败');
  }
  if (!response.ok) throw new Error(`Context 内部写入失败 (${response.status})`);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 1_048_576) throw new Error('Context 内部响应超过 1 MiB 上限');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Context 内部响应格式无效');
  }
  const data = record(record(parsed)?.['data']);
  if (!data) throw new Error('Context 内部响应缺少 data');
  return data;
}

function agentContextSnapshot(
  employeeId: string,
  saved: Record<string, unknown>,
): AgentRequest['contextSnapshot'] {
  const snapshot = record(saved['snapshot']);
  const entities = Array.isArray(snapshot?.['entities']) ? snapshot['entities'] : [];
  const relationships = Array.isArray(snapshot?.['relations']) ? snapshot['relations'] : [];
  const at = typeof saved['createdAt'] === 'string' ? saved['createdAt'] : new Date().toISOString();
  return {
    employeeId,
    at,
    entities: entities.flatMap((item) => {
      const entity = record(item);
      const id = typeof entity?.['id'] === 'string' ? entity['id'] : undefined;
      const type = typeof entity?.['entityType'] === 'string' ? entity['entityType'] : undefined;
      if (!entity || !id || !type) return [];
      return [{
        id,
        type,
        attributes: record(entity['attributes']) ?? {},
        state: record(entity['state']) ?? {},
        updatedAt: typeof entity['observedAt'] === 'string' ? entity['observedAt'] : at,
      }];
    }),
    relationships: relationships.flatMap((item) => {
      const relation = record(item);
      const from = typeof relation?.['fromEntityId'] === 'string' ? relation['fromEntityId'] : undefined;
      const to = typeof relation?.['toEntityId'] === 'string' ? relation['toEntityId'] : undefined;
      const type = typeof relation?.['relationType'] === 'string' ? relation['relationType'] : undefined;
      if (!relation || !from || !to || !type) return [];
      return [{ from, to, type, since: typeof relation['validFrom'] === 'string' ? relation['validFrom'] : at }];
    }),
    memory: {
      manufacturingContext: snapshot ?? {},
      snapshotId: saved['id'],
      sourceWatermark: saved['sourceWatermark'],
    },
  };
}

async function actionGatewayReceipt(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 1_048_576) throw new Error('Action Gateway 响应超过 1 MiB 上限');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Action Gateway 响应格式无效 (${response.status})`);
  }
  const receipt = record(parsed);
  if (!receipt) throw new Error(`Action Gateway 响应格式无效 (${response.status})`);
  if (response.ok) return receipt;
  const isDeterministicFailureReceipt = response.status === 422
    && receipt['ok'] === false
    && typeof receipt['idempotencyKey'] === 'string'
    && typeof receipt['connector'] === 'string'
    && typeof receipt['action'] === 'string';
  if (isDeterministicFailureReceipt) return receipt;
  throw new Error(`Action Gateway 调用失败 (${response.status})`);
}

/** 应用装配点；空 agent 仅供单元测试，生产入口必须传入默认 Runtime Manager。 */
export interface TemporalWorkerRuntimePorts {
  agent?: AgentRuntimePort;
  agentMetadata?: AgentRuntimeMetadata;
}

export function createTemporalActivities(runtimePorts: TemporalWorkerRuntimePorts = {}) {
  return {
  async executeNode(input: TemporalNodeActivityInput): Promise<TemporalNodeActivityResult> {
    const startedAt = new Date().toISOString();
    await callback(input.callbackBaseUrl, `/api/internal/runs/${encodeURIComponent(input.runId)}/nodes/start`, input.callbackToken, {
      nodeId: input.node.id,
      nodeLabel: input.node.label,
      nodeKind: input.node.kind,
      attempt: input.attempt,
      input: input.input,
      startedAt,
    });
    try {
      const internalToken = process.env['READYWORK_INTERNAL_TOKEN'] ?? input.callbackToken;
      const context: NodeActivityContextPort = {
        async createSnapshot(request) {
          const saved = await internalContextWrite(
            input.callbackBaseUrl,
            '/api/internal/context/v1/snapshots',
            internalToken,
            {
              tenantId: input.definition.tenantId,
              employeeId: input.definition.employeeId,
              rootBusinessObjectId: request.rootBusinessObjectId,
              purpose: request.purpose,
            },
          );
          if (typeof saved['id'] !== 'string' || typeof saved['sourceWatermark'] !== 'string' || !record(saved['snapshot'])) {
            throw new Error('Context 快照响应缺少必需字段');
          }
          return {
            id: saved['id'],
            sourceWatermark: saved['sourceWatermark'],
            contextSnapshot: agentContextSnapshot(input.definition.employeeId, saved),
          };
        },
        async appendAgentEvent(event) {
          await internalContextWrite(
            input.callbackBaseUrl,
            '/api/internal/context/v1/agent-events',
            internalToken,
            { ...event, tenantId: input.definition.tenantId, employeeId: input.definition.employeeId },
          );
        },
      };
      const executeGateway = async (nodeInput: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const actionResponse = await fetch(`${input.callbackBaseUrl}/api/internal/actions/execute`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(input.callbackToken ? { 'x-readywork-internal-token': input.callbackToken } : {}) },
          body: JSON.stringify({ runId: input.runId, tenantId: input.definition.tenantId, employeeId: input.definition.employeeId, node: input.node, input: nodeInput, mode: input.mode }),
        });
        return actionGatewayReceipt(actionResponse);
      };

      const result = await executeWorkforceNode(input, { executeGateway, agent: runtimePorts.agent, agentMetadata: runtimePorts.agentMetadata, context });
      await callback(input.callbackBaseUrl, `/api/internal/runs/${encodeURIComponent(input.runId)}/nodes/finish`, input.callbackToken, { nodeId: input.node.id, status: result.status, output: result.output, sideEffectStatus: result.sideEffectStatus, message: result.message, finishedAt: new Date().toISOString() });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await callback(input.callbackBaseUrl, `/api/internal/runs/${encodeURIComponent(input.runId)}/nodes/finish`, input.callbackToken, { nodeId: input.node.id, status: 'failed', error: message, sideEffectStatus: 'none', message, finishedAt: new Date().toISOString() });
      // 让 Temporal 看到真实 Activity 失败并使用既有 retry policy；回调只负责
      // 控制面可观测性，不能把运行时错误降级成一个“成功返回的 failed 结果”。
      throw error;
    }
  },

  async updateRun(input: { runId: string; status: TemporalRunState['status']; message: string; output?: Record<string, unknown>; approval?: ApprovalWaitBinding; callbackBaseUrl: string; callbackToken?: string }): Promise<void> {
    // approval 只含关联键和角色信息；不要把审批 note 或运行上下文写入控制面回调。
    await callback(input.callbackBaseUrl, `/api/internal/runs/${encodeURIComponent(input.runId)}/status`, input.callbackToken, { status: input.status, message: input.message, output: input.output, approval: input.approval, updatedAt: new Date().toISOString() });
  },
  };
}

// 默认由 Agent Runtime Manager 选择 DSH（READYWORK_AGENT_RUNTIME=dsh）；
// 只有显式设为 inmemory 才启用确定性测试桩。
async function main(): Promise<void> {
  const runtimeConfig = loadAgentRuntimeConfig();
  const agentRuntime = createDefaultAgentRuntime();
  let connection: NativeConnection | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    const agentDescription = agentRuntime.getDescription();
    await agentRuntime.start();
    const activities = createTemporalActivities({
      agent: agentRuntime,
      agentMetadata: runtimeConfig.kind === 'dsh'
        ? {
          provider: agentDescription.provider ?? runtimeConfig.runtimeOptions.provider,
          resolveProfile(employeeId, workerId) {
            const profile = routeAgentProfile(runtimeConfig.routing, employeeId, workerId);
            return { model: profile.model, reasoningProfile: profile.reasoningEffort };
          },
        }
        : {
          provider: 'inmemory',
          model: 'inmemory-deterministic',
          reasoningProfile: 'off',
        },
    });
    connection = await NativeConnection.connect({ address });
    const worker = await Worker.create({ connection, namespace, taskQueue, workflowsPath, activities });
    const workerRun = worker.run();
    const lifecycle = createTemporalWorkerLifecycle({
      worker,
      waitForWorkerDrain: () => workerRun,
      agentRuntime,
      connection,
    });
    close = lifecycle.close;
    // 此处只让 Worker 停止领取新任务；AI Runtime 必须继续存活到 worker.run() 排空。
    const onSignal = () => { void lifecycle.requestShutdown().catch((error) => console.error('Readywork Temporal Worker 停止请求失败', error)); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    console.log(`Readywork Temporal Worker 已启动 → ${address} / ${namespace} / ${taskQueue} / agent=${agentDescription.kind}`);
    await workerRun;
  } finally {
    if (close) await close();
    else {
      // 启动过程中失败也要回收已预热的 DSH 进程和已创建的连接。
      await agentRuntime.close();
      await connection?.close();
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error('Readywork Temporal Worker 未能启动或已异常退出', error);
    process.exitCode = 1;
  });
}
