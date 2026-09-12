import type { ApprovalStore } from './approval.js';
import type { EventBus } from './events.js';
import { InMemoryTaskRepository, type TaskRepository } from './repositories.js';
import type { EntityId, EventSelector, ISODateTime } from './types.js';
import { nowIso, uid } from './types.js';

/**
 * Business Task 状态机 —— Business Runtime 的心脏。
 * Wait / Resume / Retry / Approval / Handoff 全部在这里。
 * 每次状态变更都会写入 TaskRepository（默认内存；持久化实现见 packages/persistence）。
 */

export type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_external'
  | 'waiting_approval'
  | 'waiting_human'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskCheckpoint {
  stepIndex: number;
  pendingApprovalId?: EntityId;
  waitingReason?: string;
  /** 步骤间共享的工作区（Agent 输出、Skill 结果、工具结果引用） */
  workspace: Record<string, unknown>;
}

export interface Task {
  id: EntityId;
  tenantId: EntityId;
  employeeId: EntityId;
  workflowId: string;
  businessObjectId: EntityId;
  status: TaskStatus;
  attempts: number;
  maxRetries: number;
  instruction?: string;
  checkpoint: TaskCheckpoint;
  createdAt: ISODateTime;
  startedAt?: ISODateTime;
  completedAt?: ISODateTime;
  failedAt?: ISODateTime;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface CreateTaskInput {
  id?: EntityId;
  tenantId: EntityId;
  employeeId: EntityId;
  workflowId: string;
  businessObjectId: EntityId;
  instruction?: string;
  maxRetries?: number;
}

export interface WaitOptions {
  reason: string;
  /** 定时恢复（毫秒） */
  untilMs?: number;
  /** 事件恢复选择器 */
  forEvent?: EventSelector;
}

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created: ['queued', 'running', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['waiting_external', 'waiting_approval', 'waiting_human', 'completed', 'failed', 'cancelled'],
  waiting_external: ['running', 'cancelled'],
  waiting_approval: ['running', 'failed', 'cancelled'],
  waiting_human: ['running', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export class TaskStateMachine {
  private repo: TaskRepository;

  constructor(
    private bus: EventBus,
    private approvals: ApprovalStore,
    repo?: TaskRepository,
  ) {
    this.repo = repo ?? new InMemoryTaskRepository();
  }

  create(input: CreateTaskInput): Task {
    const task: Task = {
      id: input.id ?? uid('task'),
      tenantId: input.tenantId,
      employeeId: input.employeeId,
      workflowId: input.workflowId,
      businessObjectId: input.businessObjectId,
      status: 'created',
      attempts: 0,
      maxRetries: input.maxRetries ?? 3,
      instruction: input.instruction,
      checkpoint: { stepIndex: 0, workspace: {} },
      createdAt: nowIso(),
      metadata: {},
    };
    this.repo.save(task);
    this.bus.emit({ type: 'task.created', taskId: task.id, employeeId: task.employeeId, workflowId: task.workflowId, at: nowIso() });
    return task;
  }

  start(id: EntityId): Task {
    const t = this.transition(id, 'running');
    t.startedAt = nowIso();
    this.repo.save(t);
    this.bus.emit({ type: 'task.started', taskId: t.id, employeeId: t.employeeId, at: nowIso() });
    return t;
  }

  wait(id: EntityId, opts: WaitOptions): Task {
    const t = this.transition(id, 'waiting_external');
    t.checkpoint.waitingReason = opts.reason;
    this.repo.save(t);
    this.bus.emit({
      type: 'task.waiting',
      taskId: t.id,
      employeeId: t.employeeId,
      reason: opts.reason,
      untilAt: opts.untilMs !== undefined ? new Date(Date.now() + opts.untilMs).toISOString() : undefined,
      forEvent: opts.forEvent,
      at: nowIso(),
    });
    return t;
  }

  resume(id: EntityId, reason?: string): Task {
    const t = this.transition(id, 'running');
    this.repo.save(t);
    this.bus.emit({ type: 'task.resumed', taskId: t.id, employeeId: t.employeeId, reason, at: nowIso() });
    return t;
  }

  requestApproval(id: EntityId, req: { ruleId: string; title: string; message: string; payload: Record<string, unknown> }): Task {
    const t = this.transition(id, 'waiting_approval');
    const approval = this.approvals.create({ taskId: id, ...req });
    t.checkpoint.pendingApprovalId = approval.id;
    this.repo.save(t);
    this.bus.emit({
      type: 'approval.requested',
      taskId: t.id,
      approvalId: approval.id,
      ruleId: req.ruleId,
      title: req.title,
      at: nowIso(),
    });
    this.bus.emit({
      type: 'task.waiting_approval',
      taskId: t.id,
      employeeId: t.employeeId,
      approvalId: approval.id,
      ruleId: req.ruleId,
      title: req.title,
      at: nowIso(),
    });
    return t;
  }

  approve(id: EntityId, approvalId: EntityId, by: string): Task {
    this.approvals.decide(approvalId, 'approved', by);
    const t = this.transition(id, 'running');
    t.checkpoint.pendingApprovalId = undefined;
    this.repo.save(t);
    this.bus.emit({ type: 'task.approved', taskId: t.id, approvalId, by, at: nowIso() });
    return t;
  }

  reject(id: EntityId, approvalId: EntityId, by: string, reason?: string): Task {
    const a = this.approvals.decide(approvalId, 'rejected', by, reason);
    const t = this.transition(id, 'failed');
    t.error = `审批拒绝: ${a.title}${reason ? `（${reason}）` : ''}`;
    t.failedAt = nowIso();
    this.repo.save(t);
    this.bus.emit({ type: 'task.rejected', taskId: t.id, approvalId, by, at: nowIso() });
    this.bus.emit({ type: 'task.failed', taskId: t.id, employeeId: t.employeeId, error: t.error, attempts: t.attempts, at: nowIso() });
    return t;
  }

  handoff(id: EntityId, reason: string): Task {
    const t = this.transition(id, 'waiting_human');
    t.checkpoint.waitingReason = reason;
    this.repo.save(t);
    this.bus.emit({ type: 'task.handed_off', taskId: t.id, employeeId: t.employeeId, reason, at: nowIso() });
    return t;
  }

  finishHandoff(id: EntityId): Task {
    const t = this.transition(id, 'running');
    this.repo.save(t);
    this.bus.emit({ type: 'task.handoff_finished', taskId: t.id, at: nowIso() });
    return t;
  }

  /** 失败：attempts ≤ maxRetries 时重试（回到 running，checkpoint 不后退），否则终态 failed */
  fail(id: EntityId, error: string): Task {
    const t = this.get(id);
    if (!t) throw new Error(`任务不存在: ${id}`);
    t.attempts += 1;
    if (t.attempts <= t.maxRetries) {
      t.status = 'running';
      this.repo.save(t);
      this.bus.emit({ type: 'task.retrying', taskId: t.id, employeeId: t.employeeId, attempt: t.attempts, error, at: nowIso() });
      return t;
    }
    t.status = 'failed';
    t.error = error;
    t.failedAt = nowIso();
    this.repo.save(t);
    this.bus.emit({ type: 'task.failed', taskId: t.id, employeeId: t.employeeId, error, attempts: t.attempts, at: nowIso() });
    return t;
  }

  complete(id: EntityId, meta?: { result?: Record<string, unknown>; onTime?: boolean }): Task {
    const t = this.transition(id, 'completed');
    t.completedAt = nowIso();
    if (meta?.onTime !== undefined) t.metadata.onTime = meta.onTime;
    if (meta?.result !== undefined) t.metadata.result = meta.result;
    this.repo.save(t);
    this.bus.emit({ type: 'task.completed', taskId: t.id, employeeId: t.employeeId, result: meta?.result, at: nowIso() });
    return t;
  }

  cancel(id: EntityId): Task {
    const t = this.transition(id, 'cancelled');
    this.repo.save(t);
    this.bus.emit({ type: 'task.cancelled', taskId: t.id, at: nowIso() });
    return t;
  }

  get(id: EntityId): Task | undefined {
    return this.repo.get(id);
  }

  list(status?: TaskStatus): Task[] {
    return this.repo.list(status);
  }

  /** 显式落盘（引擎在步骤间修改 checkpoint/workspace 后调用，保证崩溃可恢复） */
  save(id: EntityId): Task {
    const t = this.get(id);
    if (!t) throw new Error(`任务不存在: ${id}`);
    this.repo.save(t);
    return t;
  }

  private transition(id: EntityId, to: TaskStatus): Task {
    const t = this.get(id);
    if (!t) throw new Error(`任务不存在: ${id}`);
    const allowed = TRANSITIONS[t.status] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(`非法状态迁移: ${t.status} → ${to}（task ${id}）`);
    }
    t.status = to;
    return t;
  }
}
