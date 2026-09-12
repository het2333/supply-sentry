import type { EntityId, ISODateTime } from './types.js';
import { nowIso, uid } from './types.js';

/**
 * 统一异常中心 —— 所有模块发现解决不了的问题，都生成同一个 Exception 实体。
 * 异常不是某个流程私有的，而是共享：严重度 / 所属对象 / 负责人 / AI 判断 / 推荐动作 / 上下文 / 是否需审批 / 状态。
 */

export type ExceptionSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ExceptionStatus = 'open' | 'assigned' | 'resolved' | 'dismissed';

export interface Exception {
  id: EntityId;
  type: string;
  severity: ExceptionSeverity;
  objectId: EntityId;
  objectType?: string;
  owner?: string;
  aiJudgment: string;
  recommendedAction: string;
  context: Record<string, unknown>;
  needsApproval: boolean;
  approvalId?: EntityId;
  status: ExceptionStatus;
  createdAt: ISODateTime;
  resolvedAt?: ISODateTime;
}

export interface ExceptionRepository {
  get(id: EntityId): Exception | undefined;
  list(): Exception[];
  save(exc: Exception): void;
}

export class InMemoryExceptionRepository implements ExceptionRepository {
  private map = new Map<EntityId, Exception>();
  get(id: EntityId): Exception | undefined { return this.map.get(id); }
  list(): Exception[] { return [...this.map.values()]; }
  save(exc: Exception): void { this.map.set(exc.id, exc); }
}

export class ExceptionStore {
  constructor(private repo: ExceptionRepository) {}

  create(input: {
    type: string;
    severity?: ExceptionSeverity;
    objectId: EntityId;
    objectType?: string;
    owner?: string;
    aiJudgment: string;
    recommendedAction: string;
    context?: Record<string, unknown>;
    needsApproval?: boolean;
    approvalId?: EntityId;
  }): Exception {
    const exc: Exception = {
      id: uid('exc'),
      type: input.type,
      severity: input.severity ?? 'medium',
      objectId: input.objectId,
      objectType: input.objectType,
      owner: input.owner,
      aiJudgment: input.aiJudgment,
      recommendedAction: input.recommendedAction,
      context: input.context ?? {},
      needsApproval: input.needsApproval ?? false,
      approvalId: input.approvalId,
      status: input.owner ? 'assigned' : 'open',
      createdAt: nowIso(),
    };
    this.repo.save(exc);
    return exc;
  }

  get(id: EntityId): Exception | undefined { return this.repo.get(id); }
  list(): Exception[] { return this.repo.list(); }
  listOpen(): Exception[] { return this.repo.list().filter((e) => e.status === 'open' || e.status === 'assigned'); }

  resolve(id: EntityId, meta: { by: string; summary: string }): Exception {
    const exc = this.repo.get(id);
    if (!exc) throw new Error(`异常不存在: ${id}`);
    exc.status = 'resolved';
    exc.resolvedAt = nowIso();
    exc.context = { ...exc.context, resolvedBy: meta.by, resolution: meta.summary };
    this.repo.save(exc);
    return exc;
  }

  assign(id: EntityId, owner: string): Exception {
    const exc = this.repo.get(id);
    if (!exc) throw new Error(`异常不存在: ${id}`);
    exc.owner = owner;
    exc.status = 'assigned';
    this.repo.save(exc);
    return exc;
  }
}
