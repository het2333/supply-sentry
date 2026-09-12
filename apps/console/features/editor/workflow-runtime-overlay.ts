export type WorkflowRunLifecycleStatus =
  | "queued"
  | "running"
  | "completed"
  | "waiting_approval"
  | "waiting_external"
  | "ready"
  | "rejected"
  | "failed"
  | "cancelled";

export type WorkflowNodeExecutionStatus = "running" | "completed" | "blocked" | "failed";
export type WorkflowNodeOverlayStatus = WorkflowNodeExecutionStatus | "waiting";

export interface WorkflowNodeRunRecord {
  id: string;
  nodeId: string;
  status: WorkflowNodeExecutionStatus;
  attempt: number;
  sideEffectStatus: "none" | "blocked" | "approval_gate" | "executed";
  message?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface WorkflowRunOverlaySource {
  id: string;
  workflowId: string;
  status: WorkflowRunLifecycleStatus;
  temporalState?: {
    currentNodeId?: string;
    visitedNodeIds: string[];
    message: string;
  };
  nodeRuns: WorkflowNodeRunRecord[];
}

export interface WorkflowNodeRuntimeState {
  status: WorkflowNodeOverlayStatus;
  attempt?: number;
  sideEffectStatus?: WorkflowNodeRunRecord["sideEffectStatus"];
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface WorkflowRuntimeOverlay {
  runId: string;
  workflowId: string;
  runStatus: WorkflowRunLifecycleStatus;
  currentNodeId?: string;
  visitedNodeIds: string[];
  nodes: Record<string, WorkflowNodeRuntimeState>;
}

function time(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLater(candidate: WorkflowNodeRunRecord, current: WorkflowNodeRunRecord): boolean {
  if (candidate.attempt !== current.attempt) return candidate.attempt > current.attempt;
  const candidateTime = Math.max(time(candidate.finishedAt), time(candidate.startedAt));
  const currentTime = Math.max(time(current.finishedAt), time(current.startedAt));
  return candidateTime > currentTime || (candidateTime === currentTime && candidate.id.localeCompare(current.id) > 0);
}

export function buildWorkflowRuntimeOverlay(source: WorkflowRunOverlaySource | null | undefined): WorkflowRuntimeOverlay | null {
  if (!source) return null;
  const latestRuns = new Map<string, WorkflowNodeRunRecord>();
  for (const nodeRun of source.nodeRuns) {
    const current = latestRuns.get(nodeRun.nodeId);
    if (!current || isLater(nodeRun, current)) latestRuns.set(nodeRun.nodeId, nodeRun);
  }

  const currentNodeId = source.temporalState?.currentNodeId?.trim() || undefined;
  const visited = new Set(source.temporalState?.visitedNodeIds ?? []);
  for (const nodeRun of source.nodeRuns) visited.add(nodeRun.nodeId);
  if (currentNodeId) visited.add(currentNodeId);

  const nodes: Record<string, WorkflowNodeRuntimeState> = {};
  for (const [nodeId, nodeRun] of latestRuns) {
    const waiting = nodeId === currentNodeId && (source.status === "waiting_approval" || source.status === "waiting_external");
    nodes[nodeId] = {
      status: waiting ? "waiting" : nodeRun.status,
      attempt: nodeRun.attempt,
      sideEffectStatus: nodeRun.sideEffectStatus,
      message: nodeRun.error ?? nodeRun.message,
      startedAt: nodeRun.startedAt,
      finishedAt: nodeRun.finishedAt,
    };
  }
  if (currentNodeId && !nodes[currentNodeId]) {
    nodes[currentNodeId] = {
      status: source.status === "waiting_approval" || source.status === "waiting_external" ? "waiting" : "running",
      message: source.temporalState?.message,
    };
  }

  return {
    runId: source.id,
    workflowId: source.workflowId,
    runStatus: source.status,
    ...(currentNodeId ? { currentNodeId } : {}),
    visitedNodeIds: [...visited],
    nodes,
  };
}
