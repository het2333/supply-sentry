import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ApprovalRequest, Task } from '@readywork/core';
import { redactSensitive, redactSensitiveValue } from './http-errors.js';

/**
 * The collaboration surface deliberately keeps its own small state instead of
 * changing a Task object in place.  A caller that owns persistence can observe
 * `onCommitted` and write the resulting assignment to its authoritative store.
 * This keeps a chat/card request from silently bypassing the task state machine.
 */
export type CollaborationAction = 'accept' | 'dismiss' | 'reassign';
export type CollaborationState = 'open' | 'accepted' | 'dismissed' | 'reassigned';

export interface CollaborationActor {
  tenantId: string;
  humanId: string;
  role: string;
}

export interface CollaborationTaskSource {
  list(): Task[];
  get?(taskId: string): Task | undefined;
}

export interface CollaborationApprovalSource {
  listByTask(taskId: string): ApprovalRequest[];
}

export interface WorkItem {
  id: string;
  employeeId: string;
  workflowId: string;
  businessObjectId: string;
  status: Task['status'];
  collaborationStatus: CollaborationState;
  assignedHumanId?: string;
  assignedRole?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkDetail extends WorkItem {
  task: unknown;
  approvals: unknown[];
  assignment: { humanId?: string; role?: string; state: CollaborationState; updatedAt: string };
}

export interface MyWorkOptions {
  /** Explicit status filtering is treated as a request for task history too. */
  statuses?: readonly Task['status'][];
  /** Show terminal tasks only when a caller explicitly asks for them. */
  includeTerminal?: boolean;
}

export interface CollaborationActionInput {
  taskId: string;
  action: CollaborationAction;
  idempotencyKey: string;
  /** Required only for reassign.  One of the two targets must be supplied. */
  assigneeHumanId?: string;
  assigneeRole?: string;
  /** A signed, user-bound confirmation returned by the first call. */
  confirmationToken?: string;
}

export type CollaborationActionResult =
  | { ok: true; replayed: boolean; taskId: string; action: CollaborationAction; state: CollaborationState; assignment: { humanId?: string; role?: string }; committedAt: string }
  | { ok: false; code: 'CONFIRMATION_REQUIRED'; confirmationToken: string; expiresAt: string; taskId: string; action: CollaborationAction; idempotencyKey: string }
  | { ok: false; code: string; error: string };

export function isConfirmationRequired(result: CollaborationActionResult): result is Extract<CollaborationActionResult, { code: 'CONFIRMATION_REQUIRED' }> {
  return !result.ok && result.code === 'CONFIRMATION_REQUIRED' && 'confirmationToken' in result;
}

export interface CollaborationCommit {
  actor: CollaborationActor;
  task: Task;
  action: CollaborationAction;
  state: CollaborationState;
  assignment: { humanId?: string; role?: string };
  idempotencyKey: string;
  fingerprint: string;
  committedAt: string;
}

export interface TeamsConfiguration {
  tenantId: string;
  enabled: boolean;
  /** Optional allow-list sourced from the Teams/SSO directory mapping. */
  allowedHumanIds?: readonly string[];
}

export interface TeamsNotification {
  status: 'queued' | 'unavailable';
  code: 'TEAMS_QUEUED' | 'TEAMS_UNAVAILABLE';
  payload?: {
    channel: 'teams';
    tenantId: string;
    recipient: { humanId: string };
    adaptiveCard: Record<string, unknown>;
  };
  error?: string;
}

interface Assignment {
  humanId?: string;
  role?: string;
  state: CollaborationState;
  updatedAt: string;
}

interface PendingConfirmation {
  actor: CollaborationActor;
  taskId: string;
  action: CollaborationAction;
  fingerprint: string;
  idempotencyKey: string;
  expiresAt: number;
  token: string;
}

interface CompletedAction {
  fingerprint: string;
  result: Extract<CollaborationActionResult, { ok: true }>;
}

interface SignedPayload {
  purpose: 'confirmation' | 'teams_action';
  tenantId: string;
  humanId: string;
  taskId: string;
  action: CollaborationAction;
  fingerprint?: string;
  nonce: string;
  expiresAt: number;
}

export interface CollaborationControlPlaneOptions {
  tasks: CollaborationTaskSource;
  approvals?: CollaborationApprovalSource;
  /** Required in deployed environments; inject a stable per-environment secret. */
  signingSecret: string;
  confirmationTtlMs?: number;
  teams?: (tenantId: string) => TeamsConfiguration | undefined;
  onCommitted?: (commit: CollaborationCommit) => void | Promise<void>;
  now?: () => number;
}

function text(value: unknown, field: string, max = 200): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`${field} 无效`);
  return value.trim();
}

function metadataAssignment(task: Task): Assignment {
  const metadata = task.metadata;
  const nested = metadata['collaboration'];
  const c = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : {};
  const humanId = typeof c['assigneeHumanId'] === 'string' ? c['assigneeHumanId']
    : typeof metadata['assigneeHumanId'] === 'string' ? metadata['assigneeHumanId']
      : typeof metadata['assigneeId'] === 'string' ? metadata['assigneeId']
        : typeof metadata['ownerId'] === 'string' ? metadata['ownerId'] : undefined;
  const role = typeof c['assigneeRole'] === 'string' ? c['assigneeRole']
    : typeof metadata['assigneeRole'] === 'string' ? metadata['assigneeRole']
      : typeof metadata['assignedRole'] === 'string' ? metadata['assignedRole'] : undefined;
  const state = typeof c['state'] === 'string' && ['open', 'accepted', 'dismissed', 'reassigned'].includes(c['state'])
    ? c['state'] as CollaborationState : 'open';
  const updatedAt = typeof c['updatedAt'] === 'string' ? c['updatedAt'] : task.createdAt;
  return { humanId, role, state, updatedAt };
}

function persistedCompletedAction(task: Task, actor: CollaborationActor, idempotencyKey: string): CompletedAction | undefined {
  const nested = task.metadata['collaboration'];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return undefined;
  const actions = (nested as Record<string, unknown>)['actions'];
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) return undefined;
  const raw = (actions as Record<string, unknown>)[idempotencyKey];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record['actorTenantId'] !== actor.tenantId || record['actorHumanId'] !== actor.humanId || typeof record['fingerprint'] !== 'string') return undefined;
  const result = record['result'];
  if (!result || typeof result !== 'object' || Array.isArray(result) || (result as Record<string, unknown>)['ok'] !== true) return undefined;
  return { fingerprint: record['fingerprint'], result: result as Extract<CollaborationActionResult, { ok: true }> };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(input: Omit<CollaborationActionInput, 'confirmationToken'>): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

function isManager(actor: CollaborationActor): boolean {
  return actor.role === '管理员' || actor.role === '采购经理';
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Secure, transport-independent collaboration controller.  HTTP and Teams
 * adapters should authenticate the actor first, then call this object; card
 * data itself is never treated as an identity assertion.
 */
export class CollaborationControlPlane {
  private readonly assignments = new Map<string, Assignment>();
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly pendingByIdempotency = new Map<string, string>();
  private readonly completed = new Map<string, CompletedAction>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CollaborationControlPlaneOptions) {
    if (options.signingSecret.trim().length < 16) throw new Error('协同签名密钥未配置或长度不足');
    this.ttlMs = Math.min(Math.max(options.confirmationTtlMs ?? 5 * 60_000, 30_000), 30 * 60_000);
    this.now = options.now ?? Date.now;
  }

  myWork(actor: CollaborationActor, options: MyWorkOptions = {}): WorkItem[] {
    const requestedStatuses = options.statuses ? new Set(options.statuses) : undefined;
    const includeTerminal = options.includeTerminal === true || requestedStatuses !== undefined;
    return this.tenantTasks(actor.tenantId)
      .filter((task) => this.isVisible(task, actor))
      .filter((task) => includeTerminal || !isTerminalTask(task))
      .filter((task) => !requestedStatuses || requestedStatuses.has(task.status))
      .map((task) => this.workItem(task))
      .filter((item) => item.collaborationStatus !== 'dismissed')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  taskDetail(actor: CollaborationActor, taskId: string): WorkDetail | undefined {
    const task = this.taskFor(actor.tenantId, taskId);
    if (!task || !this.isVisible(task, actor)) return undefined;
    const item = this.workItem(task);
    const assignment = this.assignmentFor(task);
    return {
      ...item,
      task: redactSensitiveValue(task),
      approvals: (this.options.approvals?.listByTask(task.id) ?? []).map(redactSensitiveValue),
      assignment: { humanId: assignment.humanId, role: assignment.role, state: assignment.state, updatedAt: assignment.updatedAt },
    };
  }

  async requestAction(actor: CollaborationActor, raw: CollaborationActionInput): Promise<CollaborationActionResult> {
    let input: Omit<CollaborationActionInput, 'confirmationToken'>;
    try {
      input = this.normalizeInput(raw);
    } catch (error) {
      return this.invalid(error);
    }
    const task = this.taskFor(actor.tenantId, input.taskId);
    if (!task) return { ok: false, code: 'TASK_NOT_FOUND', error: '任务不存在或不属于当前租户' };
    if (!this.canAct(task, actor, input)) return { ok: false, code: 'ACTION_FORBIDDEN', error: '当前会话无权处理该任务动作' };

    const digest = fingerprint(input);
    const actionKey = this.actionKey(actor, input.idempotencyKey);
    const completed = this.completed.get(actionKey);
    if (completed) {
      if (completed.fingerprint !== digest) return { ok: false, code: 'IDEMPOTENCY_KEY_REUSED', error: '幂等键已用于不同动作载荷' };
      return { ...completed.result, replayed: true };
    }
    const persisted = persistedCompletedAction(task, actor, input.idempotencyKey);
    if (persisted) {
      if (persisted.fingerprint !== digest) return { ok: false, code: 'IDEMPOTENCY_KEY_REUSED', error: '幂等键已用于不同动作载荷' };
      this.completed.set(actionKey, persisted);
      return { ...persisted.result, replayed: true };
    }

    if (!raw.confirmationToken) {
      const pendingKey = this.pendingByIdempotency.get(actionKey);
      if (pendingKey) {
        const pending = this.pending.get(pendingKey);
        if (pending && pending.fingerprint === digest && pending.expiresAt > this.now()) {
          return { ok: false, code: 'CONFIRMATION_REQUIRED', confirmationToken: pending.token, expiresAt: new Date(pending.expiresAt).toISOString(), taskId: input.taskId, action: input.action, idempotencyKey: input.idempotencyKey };
        }
      }
      const expiresAt = this.now() + this.ttlMs;
      const nonce = randomUUID();
      const token = this.sign({ purpose: 'confirmation', tenantId: actor.tenantId, humanId: actor.humanId, taskId: input.taskId, action: input.action, fingerprint: digest, nonce, expiresAt });
      this.pending.set(nonce, { actor: { ...actor }, taskId: input.taskId, action: input.action, fingerprint: digest, idempotencyKey: input.idempotencyKey, expiresAt, token });
      this.pendingByIdempotency.set(actionKey, nonce);
      return { ok: false, code: 'CONFIRMATION_REQUIRED', confirmationToken: token, expiresAt: new Date(expiresAt).toISOString(), taskId: input.taskId, action: input.action, idempotencyKey: input.idempotencyKey };
    }

    const verified = this.verify(raw.confirmationToken, 'confirmation', actor);
    if (!verified || verified.taskId !== input.taskId || verified.action !== input.action || verified.fingerprint !== digest) {
      return { ok: false, code: 'CONFIRMATION_INVALID', error: '确认凭据无效、过期，或不属于当前会话/动作' };
    }
    const pending = this.pending.get(verified.nonce);
    if (!pending || pending.expiresAt <= this.now() || pending.fingerprint !== digest || pending.idempotencyKey !== input.idempotencyKey || pending.actor.tenantId !== actor.tenantId || pending.actor.humanId !== actor.humanId) {
      return { ok: false, code: 'CONFIRMATION_INVALID', error: '确认凭据已失效或与当前请求不匹配' };
    }
    this.pending.delete(verified.nonce);
    this.pendingByIdempotency.delete(actionKey);
    return this.commit(actor, task, input, digest, actionKey);
  }

  /** Build a Teams Adaptive Card, but never sends it to the Teams network. */
  prepareTeamsNotification(recipient: CollaborationActor, taskId: string): TeamsNotification {
    const task = this.taskFor(recipient.tenantId, taskId);
    if (!task || !this.isVisible(task, recipient)) return { status: 'unavailable', code: 'TEAMS_UNAVAILABLE', error: '任务不存在或收件人无权查看' };
    const config = this.options.teams?.(recipient.tenantId);
    if (!config?.enabled || config.tenantId !== recipient.tenantId || (config.allowedHumanIds && !config.allowedHumanIds.includes(recipient.humanId))) {
      return { status: 'unavailable', code: 'TEAMS_UNAVAILABLE', error: 'Teams 未配置或当前用户未绑定 Teams 身份' };
    }
    const item = this.workItem(task);
    const tokenFor = (action: CollaborationAction) => ({
      token: this.sign({ purpose: 'teams_action', tenantId: recipient.tenantId, humanId: recipient.humanId, taskId: task.id, action, nonce: randomUUID(), expiresAt: this.now() + this.ttlMs }),
      idempotencyKey: `teams:${randomUUID()}`,
    });
    return {
      status: 'queued', code: 'TEAMS_QUEUED',
      payload: {
        channel: 'teams', tenantId: recipient.tenantId, recipient: { humanId: recipient.humanId },
        adaptiveCard: createTeamsAdaptiveCard(item, {
          accept: tokenFor('accept'), dismiss: tokenFor('dismiss'), reassign: tokenFor('reassign'),
        }),
      },
    };
  }

  /**
   * Identity must come from the verified Teams SSO/webhook mapping, never from
   * Adaptive Card submit data.  The token additionally binds that identity.
   */
  async handleTeamsAction(actor: CollaborationActor, input: CollaborationActionInput & { teamsActionToken: string }): Promise<CollaborationActionResult> {
    const signed = this.verify(input.teamsActionToken, 'teams_action', actor);
    if (!signed || signed.taskId !== input.taskId || signed.action !== input.action) {
      return { ok: false, code: 'TEAMS_ACTION_INVALID', error: 'Teams 动作签名无效、过期或身份不匹配' };
    }
    const { teamsActionToken: _teamsActionToken, ...action } = input;
    return this.requestAction(actor, action);
  }

  private async commit(actor: CollaborationActor, task: Task, input: Omit<CollaborationActionInput, 'confirmationToken'>, digest: string, actionKey: string): Promise<CollaborationActionResult> {
    const current = this.assignmentFor(task);
    const assignment = input.action === 'reassign'
      ? { humanId: input.assigneeHumanId, role: input.assigneeRole }
      : input.action === 'accept'
        ? { humanId: actor.humanId, role: actor.role }
        : { humanId: current.humanId, role: current.role };
    const state: CollaborationState = input.action === 'accept' ? 'accepted' : input.action === 'dismiss' ? 'dismissed' : 'reassigned';
    const committedAt = new Date(this.now()).toISOString();
    this.assignments.set(this.taskKey(task), { ...assignment, state, updatedAt: committedAt });
    const result: Extract<CollaborationActionResult, { ok: true }> = { ok: true, replayed: false, taskId: task.id, action: input.action, state, assignment, committedAt };
    try {
      await this.options.onCommitted?.({ actor, task, action: input.action, state, assignment, idempotencyKey: input.idempotencyKey, fingerprint: digest, committedAt });
    } catch (error) {
      this.assignments.set(this.taskKey(task), current);
      return { ok: false, code: 'COLLABORATION_COMMIT_FAILED', error: `协同状态未保存：${redactSensitive(error)}` };
    }
    this.completed.set(actionKey, { fingerprint: digest, result });
    return result;
  }

  private normalizeInput(raw: CollaborationActionInput): Omit<CollaborationActionInput, 'confirmationToken'> {
    const taskId = text(raw.taskId, 'taskId');
    const idempotencyKey = text(raw.idempotencyKey, 'idempotencyKey');
    if (!taskId || !idempotencyKey || !['accept', 'dismiss', 'reassign'].includes(raw.action)) throw new Error('动作请求无效');
    const assigneeHumanId = text(raw.assigneeHumanId, 'assigneeHumanId');
    const assigneeRole = text(raw.assigneeRole, 'assigneeRole');
    if (raw.action === 'reassign' && !assigneeHumanId && !assigneeRole) throw new Error('重新分配必须指定人员或角色');
    if (raw.action !== 'reassign' && (assigneeHumanId || assigneeRole)) throw new Error('该动作不接受重新分配字段');
    return { taskId, action: raw.action, idempotencyKey, ...(assigneeHumanId ? { assigneeHumanId } : {}), ...(assigneeRole ? { assigneeRole } : {}) };
  }

  private invalid(error: unknown): CollaborationActionResult {
    return { ok: false, code: 'INVALID_ACTION_INPUT', error: redactSensitive(error) };
  }

  private taskFor(tenantId: string, taskId: string): Task | undefined {
    const direct = this.options.tasks.get?.(taskId);
    if (direct && direct.tenantId === tenantId) return direct;
    return this.tenantTasks(tenantId).find((task) => task.id === taskId);
  }

  private tenantTasks(tenantId: string): Task[] {
    return this.options.tasks.list().filter((task) => task.tenantId === tenantId);
  }

  private taskKey(task: Task): string { return `${task.tenantId}\u0000${task.id}`; }
  private actionKey(actor: CollaborationActor, idempotencyKey: string): string { return `${actor.tenantId}\u0000${actor.humanId}\u0000${idempotencyKey}`; }

  private assignmentFor(task: Task): Assignment {
    return this.assignments.get(this.taskKey(task)) ?? metadataAssignment(task);
  }

  private isVisible(task: Task, actor: CollaborationActor): boolean {
    if (task.tenantId !== actor.tenantId) return false;
    if (actor.role === '管理员') return true;
    const assignment = this.assignmentFor(task);
    return assignment.humanId === actor.humanId || assignment.role === actor.role;
  }

  private canAct(task: Task, actor: CollaborationActor, input: Omit<CollaborationActionInput, 'confirmationToken'>): boolean {
    if (task.tenantId !== actor.tenantId) return false;
    if (input.action === 'reassign') return isManager(actor);
    return this.isVisible(task, actor);
  }

  private sign(payload: SignedPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', this.options.signingSecret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private verify(token: string, purpose: SignedPayload['purpose'], actor: CollaborationActor): SignedPayload | undefined {
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra) return undefined;
    const expected = createHmac('sha256', this.options.signingSecret).update(encoded).digest('base64url');
    if (!safeEqual(signature, expected)) return undefined;
    try {
      const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedPayload;
      if (value.purpose !== purpose || value.tenantId !== actor.tenantId || value.humanId !== actor.humanId || value.expiresAt <= this.now() || !value.nonce) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  private workItem(task: Task): WorkItem {
    const assignment = this.assignmentFor(task);
    return {
      id: task.id, employeeId: task.employeeId, workflowId: task.workflowId, businessObjectId: task.businessObjectId,
      status: task.status, collaborationStatus: assignment.state, assignedHumanId: assignment.humanId,
      assignedRole: assignment.role, createdAt: task.createdAt, updatedAt: assignment.updatedAt,
    };
  }
}

function isTerminalTask(task: Task): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

/** A transport-neutral Adaptive Card payload suitable for a Teams sender. */
export function createTeamsAdaptiveCard(item: WorkItem, actionTokens: Record<CollaborationAction, { token: string; idempotencyKey: string }>): Record<string, unknown> {
  return {
    type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.5',
    body: [
      { type: 'TextBlock', text: 'Readywork 待办任务', weight: 'Bolder', size: 'Medium' },
      { type: 'TextBlock', text: `任务：${item.workflowId}`, wrap: true },
      { type: 'FactSet', facts: [
        { title: '任务 ID', value: item.id }, { title: '状态', value: item.status }, { title: '业务对象', value: item.businessObjectId },
      ] },
      { type: 'TextBlock', text: '提交动作后仍需在已认证会话中二次确认。', wrap: true, isSubtle: true },
    ],
    actions: [
      { type: 'Action.Submit', title: '接受', data: { action: 'accept', taskId: item.id, idempotencyKey: actionTokens.accept.idempotencyKey, teamsActionToken: actionTokens.accept.token } },
      { type: 'Action.Submit', title: '忽略', data: { action: 'dismiss', taskId: item.id, idempotencyKey: actionTokens.dismiss.idempotencyKey, teamsActionToken: actionTokens.dismiss.token } },
      { type: 'Action.Submit', title: '重新分配', data: { action: 'reassign', taskId: item.id, idempotencyKey: actionTokens.reassign.idempotencyKey, teamsActionToken: actionTokens.reassign.token } },
    ],
  };
}
