import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from '@temporalio/workflow';
import { selectWorkflowEdges, workflowOutgoingEdges, workflowRootNodeIds } from '@readywork/graph-runtime';
import { WorkflowSignalGate, approvalWaitFor, externalEventWaitFor } from './signal-correlation.js';
import type {
  ApprovalAuditEntry,
  ApprovalWaitBinding,
  ApprovalSignalPayload,
  ExternalEventSignalPayload,
  TemporalGraphRunInput,
  TemporalGraphRunResult,
  TemporalNodeActivityInput,
  TemporalNodeActivityResult,
  TemporalRunState,
} from './types.js';

export interface ReadyworkActivities {
  executeNode(input: TemporalNodeActivityInput): Promise<TemporalNodeActivityResult>;
  updateRun(input: {
    runId: string;
    status: TemporalRunState['status'];
    message: string;
    output?: Record<string, unknown>;
    approval?: ApprovalWaitBinding;
    callbackBaseUrl: string;
    callbackToken?: string;
  }): Promise<void>;
}

const activities = proxyActivities<ReadyworkActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3, initialInterval: '1 second', maximumInterval: '10 seconds' },
});

export const approvalSignal = defineSignal<[ApprovalSignalPayload]>('approval');
export const externalEventSignal = defineSignal<[ExternalEventSignalPayload]>('externalEvent');
export const runStateQuery = defineQuery<TemporalRunState>('runState');

export type PurchaseOrderCancellationStatus = 'cancelled' | 'pending_external' | 'failed' | 'unknown';

/**
 * Deterministic cancellation projection shared by the HTTP boundary and
 * Temporal workflow code. Dispatch is never treated as success: an Odoo PO
 * becomes cancelled only when the local projection records the verified
 * authoritative readback.
 */
export function projectPurchaseOrderCancellationStatus(input: {
  source: 'local' | 'odoo';
  purchaseOrderStatus: string;
  amendmentState?: string;
}): PurchaseOrderCancellationStatus {
  if (input.source === 'local') return input.purchaseOrderStatus === 'cancelled' ? 'cancelled' : 'failed';
  if (input.amendmentState === 'unknown') return 'unknown';
  if (input.amendmentState === 'failed' || input.amendmentState === 'rejected' || input.amendmentState === 'cancelled') return 'failed';
  if (input.amendmentState === 'applied') return input.purchaseOrderStatus === 'cancelled' ? 'cancelled' : 'unknown';
  return 'pending_external';
}

export async function workforceGraphWorkflow(input: TemporalGraphRunInput): Promise<TemporalGraphRunResult> {
  const state: TemporalRunState = {
    runId: input.runId,
    status: 'running',
    visitedNodeIds: [],
    message: '已进入 Temporal 持久化运行引擎',
  };
  const signals = new WorkflowSignalGate();
  setHandler(runStateQuery, () => ({ ...state, visitedNodeIds: [...state.visitedNodeIds] }));
  setHandler(approvalSignal, (payload) => { signals.offerApproval(payload); });
  setHandler(externalEventSignal, (payload) => { signals.offerExternalEvent(payload); });

  const byId = new Map(input.definition.nodes.map((node) => [node.id, node]));
  const roots = workflowRootNodeIds(input.definition);
  const queue = roots.length > 0 ? roots : [input.definition.nodes[0]?.id].filter(Boolean) as string[];
  const queued = new Set(queue);
  const visited = new Set<string>();
  // 这些字段只能由 Workflow 在信号校验完成后写入，绝不能接受启动请求伪造的值。
  const initialWorkspace = { ...input.input };
  delete initialWorkspace['approvalAudit'];
  delete initialWorkspace['__readyworkApprovalAudit'];
  let workspace: Record<string, unknown> = initialWorkspace;
  let approvedSideEffectBudget = 0;
  const approvalAudit: ApprovalAuditEntry[] = [];

  const waitForApproval = async (node: TemporalNodeActivityInput['node']): Promise<ApprovalSignalPayload> => {
    const binding = approvalWaitFor(node, input.input, { runId: input.runId, workflowVersionId: input.definition.versionId });
    state.pendingApproval = binding;
    state.approvalAudit = [...approvalAudit];
    await activities.updateRun({ runId: input.runId, status: state.status, message: state.message, approval: binding, callbackBaseUrl: input.callbackBaseUrl, callbackToken: input.callbackToken });
    signals.beginApproval(binding);
    await condition(() => signals.hasApproval(node.id));
    const decision = signals.takeApproval(node.id);
    // hasApproval 为真才会 take；此断言也避免未来实现变更导致未绑定信号误放行。
    if (!decision || !decision.approverId || !decision.approverRole) throw new Error('审批信号缺少已验证的审批身份');
    const audit: ApprovalAuditEntry = {
      ...binding,
      approverId: decision.approverId,
      approverRole: decision.approverRole,
      decision: decision.decision,
      decidedAt: new Date(Date.now()).toISOString(),
    };
    approvalAudit.push(audit);
    state.pendingApproval = undefined;
    state.approvalAudit = [...approvalAudit];
    // 审计只保存身份、结论、时间和绑定键；不要将 note 或工作区上下文送入审计输出。
    workspace = { ...workspace, approvalAudit: [...approvalAudit], __readyworkApprovalAudit: [...approvalAudit] };
    return decision;
  };

  try {
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      queued.delete(nodeId);
      if (visited.has(nodeId)) continue;
      const node = byId.get(nodeId);
      if (!node) continue;
      state.currentNodeId = node.id;
      state.status = 'running';
      state.message = `正在执行：${node.label}`;

      const isSideEffect = (node.sideEffects?.length ?? 0) > 0 || node.kind === 'tool';
      if (input.mode === 'supervised' && isSideEffect && approvedSideEffectBudget === 0) {
        state.status = 'waiting_approval';
        state.message = `等待审批后执行：${node.label}`;
        const supervisedDecision = await waitForApproval(node);
        if (supervisedDecision?.decision === 'rejected') {
          state.status = 'rejected';
          state.message = `已驳回：${node.label}`;
          await activities.updateRun({ runId: input.runId, status: state.status, message: state.message, output: workspace, callbackBaseUrl: input.callbackBaseUrl, callbackToken: input.callbackToken });
          return { runId: input.runId, status: 'rejected', visitedNodeIds: [...visited], output: workspace };
        }
      }
      if (input.mode === 'supervised' && isSideEffect && approvedSideEffectBudget > 0) approvedSideEffectBudget -= 1;

      if (node.kind === 'approval' && input.mode !== 'simulate' && input.mode !== 'shadow') {
        state.status = 'waiting_approval';
        state.message = `审批节点等待处理：${node.label}`;
        const nodeDecision = await waitForApproval(node);
        if (nodeDecision?.decision === 'rejected') {
          state.status = 'rejected';
          state.message = `审批驳回：${node.label}`;
          await activities.updateRun({ runId: input.runId, status: state.status, message: state.message, output: workspace, callbackBaseUrl: input.callbackBaseUrl, callbackToken: input.callbackToken });
          return { runId: input.runId, status: 'rejected', visitedNodeIds: [...visited], output: workspace };
        }
        approvedSideEffectBudget = 1;
      }

      if (node.type === 'logic.wait_event' && input.mode !== 'simulate' && input.mode !== 'shadow') {
        state.status = 'waiting_external';
        state.message = `等待外部事件：${node.label}`;
        await activities.updateRun({ runId: input.runId, status: state.status, message: state.message, callbackBaseUrl: input.callbackBaseUrl, callbackToken: input.callbackToken });
        signals.beginExternalEvent(externalEventWaitFor(node, input.input));
        if (node.timeoutMs && node.timeoutMs > 0) {
          const received = await condition(() => signals.hasExternalEvent(node.id), node.timeoutMs);
          if (!received) workspace = { ...workspace, waitTimedOut: true, waitNodeId: node.id };
        } else {
          await condition(() => signals.hasExternalEvent(node.id));
        }
        const externalEvent = signals.takeExternalEvent(node.id);
        if (externalEvent) workspace = { ...workspace, externalEvent };
      }

      const result = await activities.executeNode({
        runId: input.runId,
        mode: input.mode,
        definition: input.definition,
        node,
        input: workspace,
        callbackBaseUrl: input.callbackBaseUrl,
        callbackToken: input.callbackToken,
        attempt: 1,
      });
      if (result.status === 'failed') throw new Error(result.message);
      // 输出既进入节点命名空间，也提升为后续节点可直接消费的变量池值。
      workspace = { ...workspace, ...result.output, [`node.${node.id}`]: result.output, lastNodeId: node.id };
      visited.add(node.id);
      state.visitedNodeIds = [...visited];

      const outgoing = workflowOutgoingEdges(input.definition, node.id);
      const selected = selectWorkflowEdges(outgoing, result, node.kind);
      for (const edge of selected) {
        if (!visited.has(edge.to) && !queued.has(edge.to)) {
          queue.push(edge.to);
          queued.add(edge.to);
        }
      }

      // 给 Temporal 事件历史一个明确的可调度边界。
      await sleep(1);
    }
    state.status = 'completed';
    state.currentNodeId = undefined;
    state.message = `执行完成，共运行 ${visited.size} 个节点`;
    await activities.updateRun({ runId: input.runId, status: state.status, message: state.message, output: workspace, callbackBaseUrl: input.callbackBaseUrl, callbackToken: input.callbackToken });
    return { runId: input.runId, status: 'completed', visitedNodeIds: [...visited], output: workspace };
  } catch (error) {
    state.status = 'failed';
    state.message = error instanceof Error ? error.message : String(error);
    await activities.updateRun({ runId: input.runId, status: state.status, message: state.message, output: workspace, callbackBaseUrl: input.callbackBaseUrl, callbackToken: input.callbackToken });
    throw error;
  }
}

/** 兼容已存在的历史 Temporal Workflow Type；新运行统一使用 workforceGraphWorkflow。 */
export const procurementGraphWorkflow = workforceGraphWorkflow;
