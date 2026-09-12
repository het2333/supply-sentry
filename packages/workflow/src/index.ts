import type {
  AgentAction,
  AgentRequest,
  AgentResult,
  AgentRuntimePort,
  AIEmployee,
  BusinessObject,
  ContextStore,
  EmployeeSpec,
  EntityId,
  EventSelector,
  RuntimeHub,
  Task,
} from '@readywork/core';
import { nowIso, ruleIdToExceptionType } from '@readywork/core';
import type { SkillRegistry, SkillContext } from '@readywork/skills';
import type { ToolRegistry } from '@readywork/tools';

/**
 * Workflow 引擎 —— 流程层。
 *
 * 职责边界：
 * - Workflow 决定流程（步骤序列：agent/tool/skill/wait/approval/condition/notify/end）
 * - Agent 决定行动（actions: tool/skill 调用 + stateUpdates）
 * - 引擎执行行动（权限校验 → 工具执行 → 成本记账 → 事件审计 → 状态推进）
 */

export interface RunContext {
  task: Task;
  employee: AIEmployee;
  spec: EmployeeSpec;
  businessObject: BusinessObject;
  workspace: Record<string, unknown>;
  stepIndex: number;
}

export type WorkflowStep =
  | { type: 'agent'; worker: string; instruction: string }
  | {
      type: 'tool';
      tool: string;
      action: string;
      args: Record<string, unknown>;
      optional?: boolean;
    }
  | { type: 'skill'; skill: string; input: Record<string, unknown>; store: string }
  | { type: 'wait'; reason: string; untilMs?: number; forEvent?: EventSelector }
  | {
      type: 'approval';
      ruleId: string;
      title?: string;
      message?: string;
      payload?: (ctx: RunContext) => Record<string, unknown>;
    }
  | { type: 'condition'; if: (ctx: RunContext) => boolean; then: number; else?: number }
  | { type: 'notify'; to: string; message: (ctx: RunContext) => string }
  | { type: 'end' };

export interface WorkflowDef {
  id: string;
  name: string;
  description?: string;
  /** 面向业务用户的触发条件描述（如「采购订单发出」），非技术字段 */
  trigger?: string;
  steps: WorkflowStep[];
}

export interface EngineDeps {
  hub: RuntimeHub;
  agent: AgentRuntimePort;
  skills: SkillRegistry;
  tools: ToolRegistry;
  context: ContextStore;
}

export interface RunTaskInput {
  tenantId: EntityId;
  employeeId: EntityId;
  workflowId: string;
  businessObjectId: EntityId;
  instruction?: string;
  maxRetries?: number;
}

/** @deprecated 仅用于旧采购任务兼容和历史数据恢复；所有新图运行统一进入 Temporal workforceGraphWorkflow。 */
export class WorkflowEngine {
  private defs = new Map<string, WorkflowDef>();
  private pendingWaits = new Map<EntityId, EventSelector>();
  private waitTimers = new Map<EntityId, { cancel(): void }>();

  constructor(private deps: EngineDeps) {
    // 事件恢复：wait(forEvent) 命中即恢复任务
    this.deps.hub.bus.subscribe((e) => {
      if (e.type !== 'context.event') return;
      for (const [taskId, sel] of [...this.pendingWaits]) {
        if (matchesSelector(sel, e.eventType, e.objectId, e.payload)) {
          this.pendingWaits.delete(taskId);
          void this.resume(taskId).catch(() => {
            /* 已由其他路径恢复，幂等忽略 */
          });
        }
      }
    });
  }

  /** 运行时替换 Agent 实现（如接入 DeepSeek Harness Adapter） */
  setAgent(agent: AgentRuntimePort): void {
    this.deps.agent = agent;
  }

  register(def: WorkflowDef): void {
    this.defs.set(def.id, def);
  }

  /**
   * 重启恢复：为所有 waiting_external 任务重新注册事件恢复选择器
   * （引擎重启后 pendingWaits 为空，否则业务事件无法恢复任务）。
   * 返回重新武装的任务数。
   */
  rearmWaits(): number {
    let n = 0;
    for (const task of this.deps.hub.machine.list('waiting_external')) {
      try {
        const def = this.defs.get(task.workflowId);
        if (!def) continue;
        const step = def.steps[task.checkpoint.stepIndex - 1];
        if (!step || step.type !== 'wait' || !step.forEvent) continue;
        const ctx = this.makeContext(task);
        const selector = this.resolveSelector(step.forEvent, ctx);
        this.pendingWaits.set(task.id, selector);
        n += 1;
      } catch {
        // 组织/规格缺失等异常跳过
      }
    }
    return n;
  }

  get(id: string): WorkflowDef | undefined {
    return this.defs.get(id);
  }

  list(): WorkflowDef[] {
    return [...this.defs.values()];
  }

  async runTask(input: RunTaskInput): Promise<Task> {
    const task = this.deps.hub.machine.create({
      tenantId: input.tenantId,
      employeeId: input.employeeId,
      workflowId: input.workflowId,
      businessObjectId: input.businessObjectId,
      instruction: input.instruction,
      maxRetries: input.maxRetries,
    });
    this.setEmployeeStatus(task.employeeId, 'working');
    this.deps.hub.machine.start(task.id);
    await this.advance(task.id);
    const t = this.deps.hub.machine.get(task.id);
    if (!t) throw new Error(`任务丢失: ${task.id}`);
    return t;
  }

  /** 恢复挂起的任务（幂等：非挂起状态直接返回） */
  async resume(taskId: EntityId): Promise<Task> {
    const t = this.deps.hub.machine.get(taskId);
    if (!t) throw new Error(`任务不存在: ${taskId}`);
    if (t.status !== 'waiting_external' && t.status !== 'waiting_approval' && t.status !== 'waiting_human') {
      return t;
    }
    this.pendingWaits.delete(taskId);
    this.clearWaitTimer(taskId);
    this.deps.hub.machine.resume(taskId);
    this.setEmployeeStatus(t.employeeId, 'working');
    await this.advance(taskId);
    const r = this.deps.hub.machine.get(taskId);
    if (!r) throw new Error(`任务丢失: ${taskId}`);
    return r;
  }

  async approve(taskId: EntityId, approvalId: EntityId, by: string): Promise<Task> {
    const t = this.deps.hub.machine.get(taskId);
    if (!t) throw new Error(`任务不存在: ${taskId}`);
    if (t.status !== 'waiting_approval') throw new Error(`任务不在审批等待状态: ${taskId}（${t.status}）`);
    const emp = this.deps.hub.org.getAI(t.employeeId);
    if (emp) emp.stats.humanTakeovers += 1;
    this.deps.hub.machine.approve(taskId, approvalId, by);
    await this.advance(taskId);
    const r = this.deps.hub.machine.get(taskId);
    if (!r) throw new Error(`任务丢失: ${taskId}`);
    // 批准只解锁后续执行；若后续工具失败，异常必须保留给人工处理，不能把
    // “审批已通过”误显示成“业务处置已完成”。保守地等整条旧工作流完成再关闭。
    if (r.status === 'completed') this.resolveLinkedException(approvalId, by);
    return r;
  }

  async reject(taskId: EntityId, approvalId: EntityId, by: string, reason?: string): Promise<Task> {
    const t = this.deps.hub.machine.get(taskId);
    if (!t) throw new Error(`任务不存在: ${taskId}`);
    const emp = this.deps.hub.org.getAI(t.employeeId);
    if (emp) emp.stats.humanTakeovers += 1;
    this.deps.hub.machine.reject(taskId, approvalId, by, reason);
    this.setEmployeeStatus(t.employeeId, 'failed');
    this.resolveLinkedException(approvalId, by);
    return t;
  }

  /** 审批/驳回后，把挂在同一审批上的异常一并关闭（异常工作台与审批状态保持一致） */
  private resolveLinkedException(approvalId: EntityId, by: string): void {
    try {
      const open = this.deps.hub.exceptions.listOpen().find((e) => e.approvalId === approvalId);
      if (open) this.deps.hub.exceptions.resolve(open.id, { by, summary: '审批已处理' });
    } catch {
      /* 异常仓库不可用时静默 */
    }
  }

  async cancel(taskId: EntityId): Promise<Task> {
    const t = this.deps.hub.machine.get(taskId);
    if (!t) throw new Error(`任务不存在: ${taskId}`);
    this.pendingWaits.delete(taskId);
    this.clearWaitTimer(taskId);
    this.deps.hub.machine.cancel(taskId);
    this.setEmployeeStatus(t.employeeId, 'idle');
    return t;
  }

  // ---------------------------------------------------------------- internal

  private async advance(taskId: EntityId): Promise<void> {
    for (;;) {
      const task = this.deps.hub.machine.get(taskId);
      if (!task) return;
      if (task.status !== 'running') {
        this.syncTerminal(task);
        return;
      }
      const def = this.defs.get(task.workflowId);
      if (!def) {
        this.deps.hub.machine.fail(taskId, `工作流未注册: ${task.workflowId}`);
        continue;
      }
      const step = def.steps[task.checkpoint.stepIndex];
      if (!step) {
        // 步骤耗尽 = 正常结束
        this.finishTask(task);
        continue;
      }
      try {
        const r = await this.executeStep(def, step, task);
        // 步骤间 checkpoint/workspace 变更落盘（崩溃恢复）
        this.deps.hub.machine.save(task.id);
        if (r === 'pause') {
          this.syncTerminal(task);
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.hub.machine.fail(taskId, msg);
      }
    }
  }

  private async executeStep(def: WorkflowDef, step: WorkflowStep, task: Task): Promise<'continue' | 'pause'> {
    const ctx = this.makeContext(task);
    switch (step.type) {
      case 'agent': {
        const req: AgentRequest = {
          employeeId: task.employeeId,
          taskId: task.id,
          workerId: step.worker,
          instruction: step.instruction,
          contextSnapshot: this.deps.context.snapshotFor(task.employeeId, ctx.spec.contextScope),
          toolDescriptors: this.deps.tools.list(),
          skillDescriptors: this.deps.skills.list(),
          workspace: task.checkpoint.workspace,
        };
        const res: AgentResult = await this.deps.agent.execute(req);
        Object.assign(task.checkpoint.workspace, res.stateUpdates ?? {});
        for (const action of res.actions ?? []) {
          await this.applyAction(action, task, ctx);
        }
        task.checkpoint.workspace['agent.last'] = { reasoning: res.reasoning, output: res.output };
        task.checkpoint.stepIndex += 1;
        return 'continue';
      }
      case 'tool': {
        if (!this.deps.hub.policy.can(ctx.spec.permissions, step.action, step.tool)) {
          throw new Error(`权限拒绝: ${task.employeeId} 无权限调用 ${step.tool}.${step.action}`);
        }
        const res = await this.execTool(step.tool, step.action, step.args, task, ctx);
        if (!res.ok && !step.optional) {
          throw new Error(`工具调用失败 ${step.tool}.${step.action}: ${res.error ?? 'unknown'}`);
        }
        // 工具结果写入工作区，供后续步骤通过 {{tool.<id>.<action>}} 引用
        task.checkpoint.workspace[`tool.${step.tool}.${step.action}`] = res.data;
        task.checkpoint.stepIndex += 1;
        return 'continue';
      }
      case 'skill': {
        const input = this.interpolate(step.input, ctx) as Record<string, unknown>;
        const r = await this.deps.skills.invoke(step.skill, input, this.skillCtx(task));
        task.checkpoint.workspace[step.store] = r;
        task.checkpoint.stepIndex += 1;
        return 'continue';
      }
      case 'wait': {
        const selector = step.forEvent ? this.resolveSelector(step.forEvent, ctx) : undefined;
        this.deps.hub.machine.wait(task.id, { reason: step.reason, untilMs: step.untilMs, forEvent: selector });
        task.checkpoint.stepIndex += 1;
        if (step.untilMs !== undefined) {
          const handle = this.deps.hub.scheduler.schedule(step.untilMs, () => {
            void this.resume(task.id).catch(() => {});
          });
          this.waitTimers.set(task.id, handle);
        }
        if (selector) this.pendingWaits.set(task.id, selector);
        return 'pause';
      }
      case 'approval': {
        const payload = step.payload ? step.payload(ctx) : {};
        const updated = this.deps.hub.machine.requestApproval(task.id, {
          ruleId: step.ruleId,
          title: step.title ?? `审批：${def.name}`,
          message: step.message ?? '',
          payload,
        });
        // 统一异常中心：审批即异常（带完整上下文 + 关联审批 id），异常工作台据此展示
        this.deps.hub.exceptions.create({
          type: ruleIdToExceptionType(step.ruleId),
          severity: 'high',
          objectId: task.businessObjectId,
          aiJudgment: step.message ?? step.title ?? '',
          recommendedAction: `审批「${step.title ?? ''}」`,
          context: payload,
          needsApproval: true,
          approvalId: updated.checkpoint.pendingApprovalId,
        });
        task.checkpoint.stepIndex += 1;
        return 'pause';
      }
      case 'condition': {
        const go = step.if(ctx) ? step.then : (step.else ?? task.checkpoint.stepIndex + 1);
        task.checkpoint.stepIndex = go;
        return 'continue';
      }
      case 'notify': {
        const msg = step.message(ctx);
        this.deps.hub.bus.emit({
          type: 'context.event',
          eventType: 'notify.sent',
          objectId: task.businessObjectId,
          payload: { to: step.to, message: msg },
          at: nowIso(),
        });
        this.deps.context.recordEvidence({
          entityId: task.businessObjectId,
          source: `workflow:${def.id}`,
          summary: msg,
        });
        task.checkpoint.stepIndex += 1;
        return 'continue';
      }
      case 'end': {
        this.finishTask(task);
        return 'continue';
      }
    }
  }

  /** 执行 Agent 产出的行动（工具/技能），并做权限与记账 */
  private async applyAction(action: AgentAction, task: Task, ctx: RunContext): Promise<void> {
    if (action.type === 'skill') {
      const input = this.interpolate(action.input, ctx) as Record<string, unknown>;
      const r = await this.deps.skills.invoke(action.skill, input, this.skillCtx(task));
      task.checkpoint.workspace[`skill.${action.skill}`] = r;
      return;
    }
    if (!this.deps.hub.policy.can(ctx.spec.permissions, action.action, action.tool)) {
      throw new Error(`权限拒绝: ${task.employeeId} 无权限调用 ${action.tool}.${action.action}`);
    }
    const res = await this.execTool(action.tool, action.action, action.args, task, ctx);
    task.checkpoint.workspace[`tool.${action.tool}.${action.action}`] = res.data;
  }

  private async execTool(
    tool: string,
    action: string,
    args: Record<string, unknown>,
    task: Task,
    ctx: RunContext,
  ) {
    const res = await this.deps.tools.execute(
      tool,
      action,
      this.interpolate(args, ctx) as Record<string, unknown>,
      { employeeId: task.employeeId, taskId: task.id, businessObjectId: task.businessObjectId },
    );
    const cost = res.cost ?? 0;
    if (cost > 0) {
      const cap = ctx.spec.budget?.monthlyCap;
      const currency = ctx.spec.budget?.currency ?? 'CNY';
      const ok = this.deps.hub.budget.record(task.employeeId, cost, currency, cap);
      if (!ok) throw new Error(`预算超限: ${task.employeeId} 本月预算 ${currency} ${cap}`);
      const emp = this.deps.hub.org.getAI(task.employeeId);
      if (emp) emp.stats.totalCost += cost;
    }
    this.deps.hub.bus.emit({
      type: 'tool.called',
      employeeId: task.employeeId,
      tool,
      action,
      ok: res.ok,
      cost,
      at: nowIso(),
    });
    return res;
  }

  private finishTask(task: Task): void {
    const delay = task.checkpoint.workspace['delay'] as { delayed?: boolean } | undefined;
    this.deps.hub.machine.complete(task.id, {
      onTime: !(delay?.delayed === true),
      result: { workspace: task.checkpoint.workspace },
    });
  }

  private clearWaitTimer(taskId: EntityId): void {
    const h = this.waitTimers.get(taskId);
    if (h) {
      h.cancel();
      this.waitTimers.delete(taskId);
    }
  }

  private syncTerminal(task: Task): void {
    switch (task.status) {
      case 'completed': {
        this.clearWaitTimer(task.id);
        // 先改统计，再改状态（状态变更事件会触发持久化 saveAi）
        const emp = this.deps.hub.org.getAI(task.employeeId);
        if (emp) {
          emp.stats.tasksTotal += 1;
          emp.stats.tasksCompleted += 1;
          if (task.metadata.onTime === true) emp.stats.onTimeCompleted += 1;
        }
        this.setEmployeeStatus(task.employeeId, 'idle');
        return;
      }
      case 'failed': {
        this.clearWaitTimer(task.id);
        const emp = this.deps.hub.org.getAI(task.employeeId);
        if (emp) {
          emp.stats.tasksTotal += 1;
          emp.stats.tasksFailed += 1;
        }
        this.setEmployeeStatus(task.employeeId, 'failed');
        return;
      }
      case 'waiting_external':
        this.setEmployeeStatus(task.employeeId, 'waiting_external');
        return;
      case 'waiting_approval':
        this.setEmployeeStatus(task.employeeId, 'waiting_approval');
        return;
      case 'waiting_human':
        this.setEmployeeStatus(task.employeeId, 'waiting_human');
        return;
      default:
        return;
    }
  }

  private setEmployeeStatus(employeeId: EntityId, to: AIEmployee['status']): void {
    const emp = this.deps.hub.org.getAI(employeeId);
    if (!emp || emp.status === to) return;
    const from = emp.status;
    emp.status = to;
    this.deps.hub.bus.emit({ type: 'employee.status_changed', employeeId, from, to, at: nowIso() });
  }

  private makeContext(task: Task): RunContext {
    const employee = this.deps.hub.org.getAI(task.employeeId);
    if (!employee) throw new Error(`AI 员工不存在: ${task.employeeId}`);
    const spec = this.deps.hub.specs.get(employee.specId);
    if (!spec) throw new Error(`员工 Spec 不存在: ${employee.specId}`);
    const businessObject = this.deps.hub.objects.get(task.businessObjectId);
    if (!businessObject) throw new Error(`业务对象不存在: ${task.businessObjectId}`);
    return {
      task,
      employee,
      spec,
      businessObject,
      workspace: task.checkpoint.workspace,
      stepIndex: task.checkpoint.stepIndex,
    };
  }

  private skillCtx(task: Task): SkillContext {
    return {
      employeeId: task.employeeId,
      taskId: task.id,
      businessObject: this.deps.hub.objects.get(task.businessObjectId),
    };
  }

  private resolveSelector(sel: EventSelector, ctx: RunContext): EventSelector {
    return {
      eventType: String(this.interpolate(sel.eventType, ctx) ?? sel.eventType),
      objectId:
        sel.objectId !== undefined
          ? String(this.interpolate(sel.objectId, ctx) ?? sel.objectId)
          : undefined,
      match: sel.match,
    };
  }

  /** 模板插值：{{workspace.a.b}} / {{bo.attributes.x}} / {{task.status}} */
  private interpolate(value: unknown, ctx: RunContext): unknown {
    if (typeof value === 'string') {
      return value.replace(/\{\{([^}]+)\}\}/g, (_m, raw: string) => {
        const v = this.lookup(raw.trim(), ctx);
        return v === undefined ? '' : String(v);
      });
    }
    if (Array.isArray(value)) return value.map((v) => this.interpolate(v, ctx));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.interpolate(v, ctx);
      return out;
    }
    return value;
  }

  private lookup(path: string, ctx: RunContext): unknown {
    const ws = ctx.workspace;
    const segments = path.split('.');
    // ① workspace 扁平键最长前缀匹配：'tool.erp.po.get.po.promiseDate' → ws['tool.erp.po.get'].po.promiseDate
    for (let i = segments.length; i >= 1; i--) {
      const key = segments.slice(0, i).join('.');
      if (key in ws) {
        let cur: unknown = ws[key];
        for (let j = i; j < segments.length; j++) {
          if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
          cur = (cur as Record<string, unknown>)[segments[j]!];
        }
        return cur;
      }
    }
    // ② 标准根路径：workspace.x / bo.attributes.x / task.status
    const root: Record<string, unknown> = {
      workspace: ws,
      bo: {
        id: ctx.businessObject.id,
        type: ctx.businessObject.type,
        status: ctx.businessObject.status,
        attributes: ctx.businessObject.attributes,
        state: ctx.businessObject.state,
      },
      task: { id: ctx.task.id, status: ctx.task.status },
    };
    let cur: unknown = root;
    for (const p of segments) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
  }
}

function matchesSelector(
  sel: EventSelector,
  eventType: string,
  objectId: string | undefined,
  payload: Record<string, unknown> | undefined,
): boolean {
  if (sel.eventType !== eventType) return false;
  if (sel.objectId !== undefined && sel.objectId !== objectId) return false;
  if (sel.match) {
    for (const [k, v] of Object.entries(sel.match)) {
      if (payload?.[k] !== v) return false;
    }
  }
  return true;
}
