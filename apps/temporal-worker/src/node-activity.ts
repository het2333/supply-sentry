import { createHash } from 'node:crypto';
import type { NodeExecutionContext, NodeExecutionResult } from '@readywork/graph-runtime';
import type { AgentRequest, AgentResult, AgentRuntimePort } from '@readywork/agent';
import { createProcurementNodeFactory, procurementNodeExecutorResolver } from '@readywork/supply-chain';
import type { TemporalNodeActivityInput, TemporalNodeActivityResult } from '@readywork/temporal-runtime';

export interface AgentRuntimeMetadata {
  /** 用于运行记录展示的公开 provider 名称，不能放 API Key、endpoint 或内部事件。 */
  provider?: string;
  /** 仅允许受信 worker 装配传入；不得从 Activity input 或模型结果读取。 */
  model?: string;
  reasoningProfile?: string;
  resolveProfile?: (employeeId: string, workerId: string) => { model: string; reasoningProfile: string };
}

export interface NodeActivityContextPort {
  createSnapshot(input: {
    tenantId: string;
    employeeId: string;
    rootBusinessObjectId: string;
    purpose: string;
  }): Promise<{
    id: string;
    sourceWatermark: string;
    contextSnapshot: AgentRequest['contextSnapshot'];
  }>;
  appendAgentEvent(input: Record<string, unknown>): Promise<void>;
}

export interface NodeActivityPorts {
  executeGateway(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * 可注入的 AI 推理端口。未配置时 AI 节点保留确定性内置实现，方便本地演练。
   * Runtime 的装配由 worker 入口负责，业务图不依赖任何 Harness 内部实现。
   */
  agent?: AgentRuntimePort;
  agentMetadata?: AgentRuntimeMetadata;
  context?: NodeActivityContextPort;
}

/**
 * AI Runtime 的原始错误可能包含模型、子进程或凭据细节，绝不能挂到 Error.cause。
 * Temporal FailureConverter 可能序列化 cause 链；这里只保留稳定、可重试的公开语义。
 */
export class AiNodeExecutionError extends Error {
  readonly code = 'AI_RUNTIME_EXECUTION_FAILED';

  constructor(nodeLabel: string) {
    super(`AI 节点推理失败：${nodeLabel}，请稍后重试`);
    this.name = 'AiNodeExecutionError';
  }
}

const AI_WORKERS: Record<string, string> = {
  'ai.quote_collect': 'rfq-collect',
  'ai.quote_recommend': 'rfq-recommend',
  'ai.po_check': 'po-check',
  'ai.supplier_reply_parse': 'po-reply-parse',
  'ai.delivery_date_extract': 'eta-extractor',
  'ai.followup_compose': 'followup-worker',
  'ai.invoice_recognize': 'invoice-parser',
  'ai.three_way_match': 'threeway-match',
  'ai.procurement_event_classify': 'procurement-intake',
};

const AI_CONTEXT_PURPOSES: Record<string, string> = {
  'ai.quote_collect': 'quote_comparison',
  'ai.quote_recommend': 'quote_comparison',
  'ai.po_check': 'send_po',
  'ai.supplier_reply_parse': 'record_confirmation',
  'ai.delivery_date_extract': 'po_supplier_commitment',
  'ai.followup_compose': 'po_supplier_commitment',
  'ai.invoice_recognize': 'record_invoice',
  'ai.three_way_match': 'match_invoice',
  'ai.procurement_event_classify': 'po_supplier_commitment',
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Context roots are an explicit allowlist; arbitrary IDs in the workspace are never guessed. */
function contextRootFor(input: TemporalNodeActivityInput): string | undefined {
  const candidates = [
    nonEmptyString(input.input['businessObjectId']),
    nonEmptyString(input.input['aggregateId']),
    nonEmptyString(input.input['poId']),
    nonEmptyString(input.node.parameters?.['rootBusinessObjectId']),
  ].filter((value): value is string => value !== undefined);
  if (new Set(candidates).size > 1) throw new Error('Context 根关联冲突，AI 节点已终止');
  return candidates[0];
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (typeof value === 'undefined') return '"[undefined]"';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(`[${typeof value}]`);
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function publicRuntimeIdentifier(value: unknown, maxLength: number): string | undefined {
  const identifier = typeof value === 'string' ? value.trim() : '';
  if (!identifier || identifier.length > maxLength
    || identifier.includes('://') || identifier.includes('@') || identifier.includes('?')
    || !/^[A-Za-z0-9._:/-]+$/.test(identifier)
    || /(authorization|api[-_]?key|token|secret|password|credential|bearer)\s*[=:]/i.test(identifier)) {
    return undefined;
  }
  return identifier;
}

function publicProvider(metadata: AgentRuntimeMetadata | undefined): string {
  return publicRuntimeIdentifier(metadata?.provider, 100) ?? 'configured-agent-runtime';
}

function publicModelIdentifier(value: unknown): string | undefined {
  const identifier = typeof value === 'string' ? value.trim() : '';
  if (!identifier || identifier.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(identifier)) return undefined;
  const components = identifier.split('/');
  if (components.some((component) => !component || component === '.' || component === '..')) return undefined;
  return identifier;
}

interface AgentEventRuntimeMetadata {
  provider: string;
  model: string;
  reasoningProfile: string;
}

function eventRuntimeMetadata(
  metadata: AgentRuntimeMetadata | undefined,
  employeeId: string,
  workerId: string,
): AgentEventRuntimeMetadata {
  const routed = metadata?.resolveProfile?.(employeeId, workerId);
  const model = routed?.model ?? metadata?.model;
  const reasoningProfile = routed?.reasoningProfile ?? metadata?.reasoningProfile;
  return {
    provider: publicProvider(metadata),
    model: publicModelIdentifier(model) ?? 'configured-agent-model',
    reasoningProfile: typeof reasoningProfile === 'string'
      && ['off', 'low', 'medium', 'high', 'max'].includes(reasoningProfile)
      ? reasoningProfile : 'unspecified',
  };
}

function eventBase(input: TemporalNodeActivityInput, snapshotId: string, rootBusinessObjectId: string): Record<string, unknown> {
  return {
    tenantId: input.definition.tenantId,
    employeeId: input.definition.employeeId,
    temporalWorkflowId: input.runId,
    runId: input.runId,
    taskId: `node-run:${input.runId}:${input.node.id}:${input.attempt}`,
    businessObjectId: rootBusinessObjectId,
    inputSnapshotId: snapshotId,
    status: 'completed',
    evidenceIds: [],
  };
}

function agentRequestFor(input: TemporalNodeActivityInput, descriptorName: string, descriptorDescription: string): AgentRequest {
  const nodeRunId = `node-run:${input.runId}:${input.node.id}:${input.attempt}`;
  return {
    employeeId: input.definition.employeeId,
    taskId: nodeRunId,
    workerId: AI_WORKERS[input.node.type] ?? input.node.type,
    instruction: `${descriptorName}：${descriptorDescription}。仅完成分析、判断或结构化提取；不要执行工具、技能或任何外部动作。将结论写入 stateUpdates 或 output，actions 必须为空。`,
    contextSnapshot: {
      employeeId: input.definition.employeeId,
      at: new Date().toISOString(),
      entities: [],
      relationships: [],
      memory: {
        workflowId: input.definition.workflowId,
        workflowVersionId: input.definition.versionId,
        nodeId: input.node.id,
        nodeType: input.node.type,
      },
    },
    // AI 节点没有可直接执行的工具；任何副作用只能由 Activity 后续调用 Action Gateway。
    toolDescriptors: [],
    skillDescriptors: [],
    workspace: {
      input: input.input,
      config: input.node.config ?? {},
      parameters: input.node.parameters ?? {},
    },
  };
}

function analysisOutputs(descriptorOutputs: string[], result: AgentResult, metadata: AgentRuntimeMetadata | undefined): Record<string, unknown> {
  // 只把模型的 actions 作为不可执行的建议公开；绝不能把它们当作 Gateway 指令。
  const structured = { ...result.stateUpdates, ...(result.output ?? {}) };
  delete structured['actions'];
  delete structured['action'];
  delete structured['actionSuggestions'];
  const outputs: Record<string, unknown> = { ...structured };

  // 对只有一个对象输出口的节点，允许模型返回扁平事实，仍能满足节点端口契约。
  if (descriptorOutputs.length === 1 && outputs[descriptorOutputs[0]!] === undefined) {
    outputs[descriptorOutputs[0]!] = { ...structured };
  }
  outputs['agentRuntime'] = {
    provider: publicProvider(metadata),
    execution: 'analysis_only',
  };
  if (result.actions.length > 0) outputs['actionSuggestions'] = structuredClone(result.actions);
  return outputs;
}

/** 模型建议及调用方输入中的控制字段都不得被透传为 Action Gateway 的执行参数。 */
function gatewayInputFor(input: Record<string, unknown>, nodeOutputs: Record<string, unknown>): Record<string, unknown> {
  const gatewayInput = { ...input, ...nodeOutputs };
  delete gatewayInput['actions'];
  delete gatewayInput['action'];
  delete gatewayInput['actionSuggestions'];
  return gatewayInput;
}

function agentMessage(label: string, reasoning: string): string {
  const concise = reasoning.replace(/\s+/g, ' ').trim().slice(0, 500);
  return concise ? `${label}分析完成：${concise}` : `${label}分析完成`;
}

/** 可独立测试的单节点执行单元；Temporal Activity 只负责回调与重试边界。 */
export async function executeWorkforceNode(input: TemporalNodeActivityInput, ports: NodeActivityPorts): Promise<TemporalNodeActivityResult> {
  let sideEffectBlocked = false;
  let agentCorrelation: {
    snapshotId: string;
    rootBusinessObjectId: string;
    promptHash: string;
    responseHash: string;
    runtime: AgentEventRuntimeMetadata;
  } | undefined;
  const executeGateway = async (gatewayInput: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const correlation = agentCorrelation;
    if (correlation && ports.context) {
      await ports.context.appendAgentEvent({
        ...eventBase(input, correlation.snapshotId, correlation.rootBusinessObjectId),
        eventType: 'action_requested',
        promptHash: correlation.promptHash,
        responseHash: correlation.responseHash,
        actionName: input.node.type,
        model: correlation.runtime.model,
        reasoningProfile: correlation.runtime.reasoningProfile,
        payload: { nodeId: input.node.id, mode: input.mode, provider: correlation.runtime.provider },
        createdAt: new Date().toISOString(),
      });
    }
    const gatewayResult = await ports.executeGateway(gatewayInput);
    const hasDeterministicReceipt = typeof gatewayResult['ok'] === 'boolean'
      && gatewayResult['recoveryState'] === undefined;
    if (correlation && ports.context && hasDeterministicReceipt) {
      await ports.context.appendAgentEvent({
        ...eventBase(input, correlation.snapshotId, correlation.rootBusinessObjectId),
        eventType: 'action_result',
        promptHash: correlation.promptHash,
        responseHash: canonicalHash(gatewayResult),
        actionName: input.node.type,
        model: correlation.runtime.model,
        reasoningProfile: correlation.runtime.reasoningProfile,
        status: gatewayResult['ok'] === true ? 'completed' : 'failed',
        payload: {
          nodeId: input.node.id,
          provider: correlation.runtime.provider,
          ok: gatewayResult['ok'] === true,
          replayed: gatewayResult['replayed'] === true,
          ...(nonEmptyString(gatewayResult['idempotencyKey'])
            ? { idempotencyKey: nonEmptyString(gatewayResult['idempotencyKey'])!.slice(0, 256) } : {}),
        },
        createdAt: new Date().toISOString(),
      });
    }
    return gatewayResult;
  };
  const factory = createProcurementNodeFactory(procurementNodeExecutorResolver({
    executeConnector: async (_descriptor, _node, nodeInput): Promise<NodeExecutionResult> => {
      if (sideEffectBlocked) return { status: 'blocked', outputs: {}, message: `${input.node.label} 已演练，副作用已拦截` };
      return { status: 'completed', outputs: { action: await executeGateway(gatewayInputFor(nodeInput, {})) }, message: `${input.node.label}执行完成` };
    },
    ...(ports.agent ? {
      executeAi: async (descriptor, _node, nodeInput): Promise<NodeExecutionResult> => {
        const activityInput = { ...input, input: nodeInput };
        const rootBusinessObjectId = contextRootFor(activityInput);
        if (rootBusinessObjectId && !ports.context) throw new Error('Context 端口未配置，AI 节点已终止');
        const saved = rootBusinessObjectId
          ? await ports.context!.createSnapshot({
            tenantId: input.definition.tenantId,
            employeeId: input.definition.employeeId,
            rootBusinessObjectId,
            purpose: AI_CONTEXT_PURPOSES[input.node.type] ?? 'po_supplier_commitment',
          })
          : undefined;
        const request = agentRequestFor(activityInput, descriptor.name, descriptor.description);
        if (saved) request.contextSnapshot = saved.contextSnapshot;
        const promptHash = canonicalHash(request);
        const runtime = eventRuntimeMetadata(ports.agentMetadata, request.employeeId, request.workerId);
        if (saved && rootBusinessObjectId) {
          await ports.context!.appendAgentEvent({
            ...eventBase(input, saved.id, rootBusinessObjectId),
            eventType: 'context_read',
            promptHash,
            model: runtime.model,
            reasoningProfile: runtime.reasoningProfile,
            payload: {
              nodeId: input.node.id,
              sourceWatermark: saved.sourceWatermark,
              provider: runtime.provider,
            },
            createdAt: new Date().toISOString(),
          });
        }
        let result: AgentResult;
        try {
          result = await ports.agent!.execute(request);
        } catch {
          throw new AiNodeExecutionError(input.node.label);
        }
        if (saved && rootBusinessObjectId) {
          const responseHash = canonicalHash(result);
          const confidence = typeof result.stateUpdates['confidence'] === 'number'
            && result.stateUpdates['confidence'] >= 0 && result.stateUpdates['confidence'] <= 1
            ? result.stateUpdates['confidence'] : undefined;
          await ports.context!.appendAgentEvent({
            ...eventBase(input, saved.id, rootBusinessObjectId),
            eventType: 'decision',
            promptHash,
            responseHash,
            model: runtime.model,
            reasoningProfile: runtime.reasoningProfile,
            ...(confidence === undefined ? {} : { confidence }),
            payload: {
              nodeId: input.node.id,
              provider: runtime.provider,
              outputKeys: Object.keys({ ...result.stateUpdates, ...(result.output ?? {}) })
                .sort().slice(0, 64).map((key) => key.slice(0, 200)),
              actionSuggestionCount: Math.min(result.actions.length, 1_000),
            },
            createdAt: new Date().toISOString(),
          });
          agentCorrelation = {
            snapshotId: saved.id,
            rootBusinessObjectId,
            promptHash,
            responseHash,
            runtime,
          };
        }
        return {
          status: 'completed',
          outputs: analysisOutputs(descriptor.outputs.map((output) => output.id), result, ports.agentMetadata),
          message: agentMessage(descriptor.name, result.reasoning),
        };
      },
    } : {}),
  }));
  const descriptor = factory.describe(input.node.type, input.node.typeVersion);
  if (!descriptor) throw new Error(`节点类型未注册: ${input.node.type}@${input.node.typeVersion}`);
  const hasSideEffect = (input.node.sideEffects?.length ?? 0) > 0 || (descriptor.sideEffects?.length ?? 0) > 0 || input.node.kind === 'tool';
  sideEffectBlocked = hasSideEffect && (input.mode === 'simulate' || input.mode === 'shadow');
  const context: NodeExecutionContext = {
    tenantId: input.definition.tenantId,
    employeeId: input.definition.employeeId,
    workflowId: input.definition.workflowId,
    workflowVersionId: input.definition.versionId,
    runId: input.runId,
    nodeRunId: `node-run:${input.runId}:${input.node.id}:${input.attempt}`,
    mode: input.mode,
    variables: input.input,
    credentials: {},
  };
  const nodeResult = await factory.create(input.node).execute(input.node, input.input, context);
  if (nodeResult.status === 'failed') throw new Error(nodeResult.message ?? `${input.node.label}执行失败`);
  const output: Record<string, unknown> = { ...nodeResult.outputs, nodeId: input.node.id, label: input.node.label, executedAt: new Date().toISOString(), mode: input.mode };
  let sideEffectStatus: TemporalNodeActivityResult['sideEffectStatus'] = 'none';
  let message = nodeResult.message ?? `${input.node.label} 执行完成`;
  if (sideEffectBlocked) {
    sideEffectStatus = 'blocked';
    message = `${input.node.label} 已演练，副作用已拦截`;
  } else if (hasSideEffect && descriptor.runtime !== 'connector') {
    Object.assign(output, { action: await executeGateway(gatewayInputFor(input.input, nodeResult.outputs)) });
    sideEffectStatus = 'executed';
  } else if (hasSideEffect) {
    sideEffectStatus = 'executed';
  }
  return { status: sideEffectBlocked ? 'blocked' : 'completed', output, selectedEdgeLabels: nodeResult.selectedEdgeLabels, sideEffectStatus, message };
}
