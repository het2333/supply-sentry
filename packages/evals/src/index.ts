import type { ApprovalRequest, DomainEvent, RuntimeHub, Task } from '@readywork/core';

export * from './supplier-replies/types.js';
export * from './supplier-replies/dataset.js';
export * from './supplier-replies/runner.js';
export * from './supplier-replies/deterministic-runner.js';
export * from './supplier-replies/scoring.js';
export * from './supplier-replies/report.js';

/**
 * Evaluations —— 基于事件日志与任务终态回放评测。
 * 不依赖 Agent 实现：只读 hub 的状态与事件，产出结构化评分，支持两次运行回归对比。
 */

export interface ToolCallTrace {
  tool: string;
  action: string;
  ok: boolean;
  cost: number;
  at: string;
}

export interface ApprovalTrace {
  ruleId: string;
  title: string;
  payload: Record<string, unknown>;
  status: ApprovalRequest['status'];
  decidedBy?: string;
  /** 该审批是否被员工 Spec 的 ApprovalRule 判定为"应当触发" */
  justified: boolean;
}

export interface TaskTrajectory {
  taskId: string;
  workflowId: string;
  employeeId: string;
  businessObjectId: string;
  status: Task['status'];
  attempts: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
  durationMs?: number;
  onTime?: boolean;
  toolCalls: ToolCallTrace[];
  approvals: ApprovalTrace[];
  eventCount: number;
}

export interface EmployeeEval {
  employeeId: string;
  name: string;
  taskCount: number;
  successRate: number;
  interventionRate: number;
  onTimeRate: number;
  cost: number;
  toolFailures: number;
  retries: number;
  approvals: { total: number; justified: number; unnecessary: number };
}

export interface EvalReport {
  runId: string;
  at: string;
  employees: EmployeeEval[];
  tasks: TaskTrajectory[];
}

export interface RegressionDiff {
  employeeId: string;
  successRateDelta: number;
  interventionRateDelta: number;
  onTimeRateDelta: number;
  costDelta: number;
}

// ---------------------------------------------------------------- 录制

export function recordTrajectories(hub: RuntimeHub): TaskTrajectory[] {
  const trajectories: TaskTrajectory[] = [];
  for (const task of hub.machine.list()) {
    const events = hub.eventLog.filter((e) => 'taskId' in e && (e as { taskId?: string }).taskId === task.id);
    const toolCalls: ToolCallTrace[] = hub.eventLog
      .filter((e) => e.type === 'tool.called' && e.employeeId === task.employeeId && e.at >= task.createdAt && (task.completedAt ?? task.failedAt ?? e.at) >= e.at)
      .map((e) => (e.type === 'tool.called' ? { tool: e.tool, action: e.action, ok: e.ok, cost: e.cost, at: e.at } : null))
      .filter((t): t is ToolCallTrace => t !== null);

    const emp = hub.org.getAI(task.employeeId);
    const spec = emp ? hub.specs.get(emp.specId) : undefined;
    const approvals: ApprovalTrace[] = hub.approvalRepo.listByTask(task.id).map((a) => ({
      ruleId: a.ruleId,
      title: a.title,
      payload: a.payload,
      status: a.status,
      decidedBy: a.decidedBy,
      justified:
        spec?.approvalRules.some((r) => {
          try {
            return r.id === a.ruleId && r.when({ employeeId: task.employeeId, taskId: task.id, payload: a.payload, now: new Date(a.requestedAt) });
          } catch {
            return false;
          }
        }) ?? false,
    }));

    const start = Date.parse(task.startedAt ?? task.createdAt);
    const end = task.completedAt ?? task.failedAt;
    trajectories.push({
      taskId: task.id,
      workflowId: task.workflowId,
      employeeId: task.employeeId,
      businessObjectId: task.businessObjectId,
      status: task.status,
      attempts: task.attempts,
      error: task.error,
      createdAt: task.createdAt,
      completedAt: end,
      durationMs: end ? Date.parse(end) - start : undefined,
      onTime: task.metadata.onTime === true ? true : task.metadata.onTime === false ? false : undefined,
      toolCalls,
      approvals,
      eventCount: events.length,
    });
  }
  return trajectories;
}

export function scoreTrajectories(hub: RuntimeHub, trajectories: TaskTrajectory[], runId: string, at: string): EvalReport {
  const employees: EmployeeEval[] = hub.org.listAI().map((emp) => {
    const ts = trajectories.filter((t) => t.employeeId === emp.id);
    const done = ts.filter((t) => t.status === 'completed');
    const toolCalls = ts.flatMap((t) => t.toolCalls);
    const approvals = ts.flatMap((t) => t.approvals);
    return {
      employeeId: emp.id,
      name: emp.name,
      taskCount: ts.length,
      successRate: ts.length ? done.length / ts.length : 0,
      interventionRate: ts.length ? emp.stats.humanTakeovers / ts.length : 0,
      onTimeRate: done.length ? done.filter((t) => t.onTime === true).length / done.length : 0,
      cost: toolCalls.reduce((s, c) => s + c.cost, 0),
      toolFailures: toolCalls.filter((c) => !c.ok).length,
      retries: ts.reduce((s, t) => s + t.attempts, 0),
      approvals: {
        total: approvals.length,
        justified: approvals.filter((a) => a.justified).length,
        unnecessary: approvals.filter((a) => !a.justified).length,
      },
    };
  });
  return { runId, at, employees, tasks: trajectories };
}

export function recordReport(hub: RuntimeHub, runId: string): EvalReport {
  return scoreTrajectories(hub, recordTrajectories(hub), runId, new Date().toISOString());
}

export function compareRuns(baseline: EvalReport, current: EvalReport): RegressionDiff[] {
  const diffs: RegressionDiff[] = [];
  for (const b of baseline.employees) {
    const c = current.employees.find((e) => e.employeeId === b.employeeId);
    if (!c) continue;
    diffs.push({
      employeeId: b.employeeId,
      successRateDelta: c.successRate - b.successRate,
      interventionRateDelta: c.interventionRate - b.interventionRate,
      onTimeRateDelta: c.onTimeRate - b.onTimeRate,
      costDelta: c.cost - b.cost,
    });
  }
  return diffs;
}
