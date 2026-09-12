import type { WorkflowNodeDefinition } from '@readywork/graph-runtime';
import type { ApprovalSignalPayload, ApprovalWaitBinding, ExternalEventSignalPayload } from './types.js';

export interface ExternalEventWait {
  nodeId: string;
  /** 未在节点定义中配置时，为兼容历史图不限制事件类型。 */
  eventType?: string;
  /** 仅当图输入或节点配置提供业务对象 ID 时才要求关联。 */
  objectId?: string;
}

const MAX_EARLY_EXTERNAL_EVENTS_PER_NODE = 32;

/** 角色升级必须是显式白名单；不会因为字符串相近或调用方声明而自动提权。 */
const DEFAULT_APPROVAL_ROLE_ESCALATIONS: Record<string, readonly string[]> = {
  buyer: ['manager'],
  manager: ['director'],
  finance: ['finance_manager', 'cfo'],
};

export interface ApprovalWaitContext {
  runId: string;
  workflowVersionId: string;
}

/**
 * 从审批节点和冻结的图输入生成不可变关联键。
 * 历史图缺少配置时，使用明确且严格的安全默认值：manager、run 级业务对象、
 * 由 run/node/version 派生的决策 ID 与版本绑定；新信号仍必须回传全部字段。
 */
export function approvalWaitFor(node: WorkflowNodeDefinition, input: Record<string, unknown>, context: ApprovalWaitContext): ApprovalWaitBinding {
  const assigneeRole = configuredString(node, 'assigneeRole') ?? (node.permission?.trim() || 'manager');
  const businessObjectId = configuredString(node, 'businessObjectId')
    ?? configuredString(node, 'objectId')
    ?? inputString(input, 'businessObjectId')
    ?? inputString(input, 'objectId')
    ?? `run:${context.runId}`;
  const lineId = configuredString(node, 'lineId') ?? inputString(input, 'lineId');
  const snapshotVersion = configuredString(node, 'snapshotVersion')
    ?? inputString(input, 'snapshotVersion')
    ?? context.workflowVersionId;
  const ruleVersion = configuredString(node, 'ruleVersion')
    ?? inputString(input, 'ruleVersion')
    ?? `workflow:${context.workflowVersionId}`;
  const decisionId = configuredString(node, 'decisionId')
    ?? inputString(input, 'decisionId')
    ?? `approval:${context.runId}:${node.id}:${snapshotVersion}`;
  const configuredEscalations = configuredStringArray(node, 'escalationRoles');
  const allowedApproverRoles = [...new Set([
    assigneeRole,
    ...(configuredEscalations ?? DEFAULT_APPROVAL_ROLE_ESCALATIONS[assigneeRole] ?? []),
  ])];
  return {
    nodeId: node.id,
    assigneeRole,
    allowedApproverRoles,
    businessObjectId,
    ...(lineId ? { lineId } : {}),
    decisionId,
    ruleVersion,
    snapshotVersion,
  };
}

/** 从等待节点与本次图输入中提取稳定的事件关联条件。 */
export function externalEventWaitFor(node: WorkflowNodeDefinition, input: Record<string, unknown>): ExternalEventWait {
  return {
    nodeId: node.id,
    eventType: configuredString(node, 'eventType'),
    objectId: configuredString(node, 'objectId') ?? inputString(input, 'objectId') ?? inputString(input, 'businessObjectId'),
  };
}

/**
 * Workflow 内信号闸门：只在对应节点真的等待时接收第一个关联信号。
 * 这既避免早到信号污染后续节点，也令重复投递保持幂等。
 */
export class WorkflowSignalGate {
  private approvalWait: ApprovalWaitBinding | undefined;
  private externalWait: ExternalEventWait | undefined;
  private approval: ApprovalSignalPayload | undefined;
  private externalEvent: ExternalEventSignalPayload | undefined;
  /** 外部事实可能先到；每个节点保留有限候选，等待时再做完整关联筛选。 */
  private earlyExternalEvents = new Map<string, ExternalEventSignalPayload[]>();

  beginApproval(wait: ApprovalWaitBinding): void {
    this.approvalWait = wait;
    this.approval = undefined;
  }

  offerApproval(payload: ApprovalSignalPayload): boolean {
    if (!this.approvalWait || this.approval || !matchesApproval(payload, this.approvalWait)) return false;
    this.approval = payload;
    return true;
  }

  hasApproval(nodeId: string): boolean {
    return this.approvalWait?.nodeId === nodeId && this.approval !== undefined;
  }

  takeApproval(nodeId: string): ApprovalSignalPayload | undefined {
    if (this.approvalWait?.nodeId !== nodeId) return undefined;
    const received = this.approval;
    this.approvalWait = undefined;
    this.approval = undefined;
    return received;
  }

  beginExternalEvent(wait: ExternalEventWait): void {
    this.externalWait = wait;
    this.externalEvent = undefined;
    const early = this.earlyExternalEvents.get(wait.nodeId) ?? [];
    this.earlyExternalEvents.delete(wait.nodeId);
    // 错误候选不能挡住随后正确的早到事件；消费后整个节点缓存被清理。
    this.externalEvent = early.find((candidate) => matchesExternalEvent(candidate, wait));
  }

  offerExternalEvent(payload: ExternalEventSignalPayload): boolean {
    const nodeId = payload.nodeId;
    if (!nodeId) return false;
    if (this.externalWait?.nodeId === nodeId) {
      if (this.externalEvent || !matchesExternalEvent(payload, this.externalWait)) return false;
      this.externalEvent = payload;
      return true;
    }
    // 即使正在等节点 A，也可暂存未来节点 B 的事件；它绝不会影响 A 的放行。
    return this.bufferEarlyExternalEvent(nodeId, payload);
  }

  hasExternalEvent(nodeId: string): boolean {
    return this.externalWait?.nodeId === nodeId && this.externalEvent !== undefined;
  }

  takeExternalEvent(nodeId: string): ExternalEventSignalPayload | undefined {
    if (this.externalWait?.nodeId !== nodeId) return undefined;
    const received = this.externalEvent;
    this.externalWait = undefined;
    this.externalEvent = undefined;
    return received;
  }

  /** 仅供运行时诊断与单测确认缓存有界；不暴露候选内容。 */
  pendingExternalEventCount(nodeId: string): number {
    return this.earlyExternalEvents.get(nodeId)?.length ?? 0;
  }

  private bufferEarlyExternalEvent(nodeId: string, payload: ExternalEventSignalPayload): boolean {
    const candidates = this.earlyExternalEvents.get(nodeId) ?? [];
    const key = externalEventKey(payload);
    if (candidates.some((candidate) => externalEventKey(candidate) === key)) return false;
    // 保留最新的有限窗口，避免错误/恶意首包永久阻塞后来的有效业务事实。
    if (candidates.length >= MAX_EARLY_EXTERNAL_EVENTS_PER_NODE) candidates.shift();
    candidates.push(payload);
    this.earlyExternalEvents.set(nodeId, candidates);
    return true;
  }
}

/** Payload 必须完整绑定当前等待，且审批角色需是受理角色或节点声明的升级角色。 */
export function matchesApproval(payload: ApprovalSignalPayload, expected: ApprovalWaitBinding): boolean {
  if (payload.nodeId !== expected.nodeId) return false;
  if (!nonEmptyString(payload.approverId) || !nonEmptyString(payload.approverRole)) return false;
  if (payload.businessObjectId !== expected.businessObjectId) return false;
  if ((payload.lineId ?? undefined) !== expected.lineId) return false;
  if (payload.decisionId !== expected.decisionId) return false;
  if (payload.ruleVersion !== expected.ruleVersion || payload.snapshotVersion !== expected.snapshotVersion) return false;
  return approvalRoleAllowed(payload.approverRole, expected);
}

/** API 与 Workflow 共用同一角色匹配语义，避免 API 预检和 Workflow 信号闸门出现分歧。 */
export function approvalRoleAllowed(role: string, expected: ApprovalWaitBinding): boolean {
  const actual = canonicalApprovalRole(role);
  return expected.allowedApproverRoles.some((allowed) => canonicalApprovalRole(allowed) === actual);
}

export function matchesExternalEvent(payload: ExternalEventSignalPayload, expected: ExternalEventWait): boolean {
  if (payload.nodeId !== expected.nodeId) return false;
  if (expected.eventType !== undefined && payload.eventType !== expected.eventType) return false;
  if (expected.objectId !== undefined && eventObjectId(payload) !== expected.objectId) return false;
  return true;
}

function configuredString(node: WorkflowNodeDefinition, key: string): string | undefined {
  const value = node.parameters?.[key] ?? node.config?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function configuredStringArray(node: WorkflowNodeDefinition, key: string): string[] | undefined {
  const value = node.parameters?.[key] ?? node.config?.[key];
  if (!Array.isArray(value)) return undefined;
  const roles = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  return roles.length > 0 ? roles : undefined;
}

function inputString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalApprovalRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  return ({
    '采购专员': 'buyer',
    '采购员': 'buyer',
    '采购经理': 'manager',
    '经理': 'manager',
    '财务': 'finance',
    '财务经理': 'finance_manager',
    '总监': 'director',
    '首席财务官': 'cfo',
  } as Record<string, string>)[normalized] ?? normalized;
}

function eventObjectId(payload: ExternalEventSignalPayload): string | undefined {
  if (typeof payload.objectId === 'string' && payload.objectId.trim()) return payload.objectId.trim();
  const nested = payload.payload?.['objectId'] ?? payload.payload?.['businessObjectId'];
  return typeof nested === 'string' && nested.trim() ? nested.trim() : undefined;
}

function externalEventKey(payload: ExternalEventSignalPayload): string {
  return `${payload.eventType}\u0000${eventObjectId(payload) ?? ''}\u0000${stableJson(payload.payload)}`;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  // Temporal Workflow 里避免 localeCompare：结果可受 Worker 运行时 locale 影响。
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}
