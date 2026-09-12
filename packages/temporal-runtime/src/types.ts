import type {
  WorkflowEdgeDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeKind,
  WorkflowRunMode,
  WorkflowVersionDefinition,
} from '@readywork/graph-runtime';

/** Temporal 只承载可靠执行，不再维护另一套图契约。 */
export type TemporalRunMode = WorkflowRunMode;
export type TemporalNodeKind = WorkflowNodeKind;
export type TemporalNodeDefinition = WorkflowNodeDefinition;
export type TemporalEdgeDefinition = WorkflowEdgeDefinition;
export type TemporalWorkflowVersion = WorkflowVersionDefinition;

export interface TemporalGraphRunInput {
  runId: string;
  mode: TemporalRunMode;
  definition: TemporalWorkflowVersion;
  input: Record<string, unknown>;
  callbackBaseUrl: string;
  callbackToken?: string;
}

export interface TemporalNodeActivityInput {
  runId: string;
  mode: TemporalRunMode;
  definition: TemporalWorkflowVersion;
  node: TemporalNodeDefinition;
  input: Record<string, unknown>;
  callbackBaseUrl: string;
  callbackToken?: string;
  attempt: number;
}

export interface TemporalNodeActivityResult {
  status: 'completed' | 'blocked' | 'failed';
  output: Record<string, unknown>;
  selectedTargets?: string[];
  selectedEdgeLabels?: string[];
  sideEffectStatus: 'none' | 'blocked' | 'approval_gate' | 'executed';
  message: string;
}

export interface TemporalGraphRunResult {
  runId: string;
  status: 'completed' | 'rejected' | 'failed';
  visitedNodeIds: string[];
  output: Record<string, unknown>;
}

/** 等待中的审批绑定。仅包含可审计的关联键，不能承载业务正文、凭据或完整上下文。 */
export interface ApprovalWaitBinding {
  nodeId: string;
  assigneeRole: string;
  allowedApproverRoles: string[];
  businessObjectId: string;
  lineId?: string;
  decisionId: string;
  ruleVersion: string;
  snapshotVersion: string;
}

/** 审批结论的最小审计记录；特意不保存 note、原始输入或任何敏感上下文。 */
export interface ApprovalAuditEntry extends ApprovalWaitBinding {
  approverId: string;
  approverRole: string;
  decision: 'approved' | 'rejected';
  decidedAt: string;
}

export interface ApprovalSignalPayload {
  nodeId?: string;
  decision: 'approved' | 'rejected';
  /** 旧客户端字段，仅用于平滑升级；信号闸门不会以它代替 approverId。 */
  by?: string;
  approverId?: string;
  approverRole?: string;
  businessObjectId?: string;
  lineId?: string;
  decisionId?: string;
  ruleVersion?: string;
  snapshotVersion?: string;
  note?: string;
}

export interface ExternalEventSignalPayload {
  nodeId?: string;
  eventType: string;
  /** 顶层关联字段；旧客户端仍可在 payload.objectId / businessObjectId 中传递。 */
  objectId?: string;
  payload?: Record<string, unknown>;
}

export interface TemporalRunState {
  runId: string;
  status: 'running' | 'waiting_approval' | 'waiting_external' | 'completed' | 'rejected' | 'failed';
  currentNodeId?: string;
  visitedNodeIds: string[];
  message: string;
  /** 当前审批绑定及已接受的最小审计信息，供控制面安全展示。 */
  pendingApproval?: ApprovalWaitBinding;
  approvalAudit?: ApprovalAuditEntry[];
}
