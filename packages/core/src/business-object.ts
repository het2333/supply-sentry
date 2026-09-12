import { InMemoryBusinessObjectRepository, type BusinessObjectRepository } from './repositories.js';
import { canTransition, lifecycleStateMachine } from './procurement-domain.js';
import type { EntityId, ISODateTime } from './types.js';
import { nowIso } from './types.js';

/** 业务对象（PO / RFQ / Requisition / Invoice …）：业务事实的唯一载体 */
export interface BusinessObject {
  id: EntityId;
  type: string;
  status: string;
  attributes: Record<string, unknown>;
  state: Record<string, unknown>;
  history: BusinessObjectEvent[];
  updatedAt: ISODateTime;
}

export interface BusinessObjectEvent {
  at: ISODateTime;
  kind: string;
  summary: string;
  by: string;
}

export class BusinessObjectStore {
  private repo: BusinessObjectRepository;

  constructor(repo?: BusinessObjectRepository) {
    this.repo = repo ?? new InMemoryBusinessObjectRepository();
  }

  create(input: {
    id: EntityId;
    type: string;
    status?: string;
    attributes?: Record<string, unknown>;
  }): BusinessObject {
    const bo: BusinessObject = {
      id: input.id,
      type: input.type,
      status: input.status ?? 'created',
      attributes: { ...(input.attributes ?? {}) },
      state: {},
      history: [],
      updatedAt: nowIso(),
    };
    this.repo.save(bo);
    return bo;
  }

  get(id: EntityId): BusinessObject | undefined {
    return this.repo.get(id);
  }

  update(
    id: EntityId,
    patch: { attributes?: Record<string, unknown>; state?: Record<string, unknown>; status?: string },
    meta: { kind: string; summary: string; by: string },
  ): BusinessObject {
    const bo = this.repo.get(id);
    if (!bo) throw new Error(`业务对象不存在: ${id}`);
    if (patch.attributes) bo.attributes = { ...bo.attributes, ...patch.attributes };
    if (patch.state) bo.state = { ...bo.state, ...patch.state };
    if (patch.status !== undefined) bo.status = patch.status;
    bo.updatedAt = nowIso();
    bo.history.push({ at: nowIso(), kind: meta.kind, summary: meta.summary, by: meta.by });
    this.repo.save(bo);
    return bo;
  }

  list(type?: string): BusinessObject[] {
    return this.repo.list(type);
  }

  /** 生命周期状态转移（按对象类型的状态机校验；非法转移返回 illegalTransition） */
  transition(
    id: EntityId,
    nextStatus: string,
    meta: { kind: string; summary: string; by: string },
  ): { ok: true; bo: BusinessObject } | { ok: false; error: string; illegalTransition: boolean } {
    const bo = this.repo.get(id);
    if (!bo) return { ok: false, error: `业务对象不存在: ${id}`, illegalTransition: false };
    const sm = lifecycleStateMachine(bo.type);
    if (sm && !canTransition(sm, bo.status, nextStatus)) {
      return { ok: false, error: `非法状态转移: ${bo.type}「${bo.status}」→「${nextStatus}」（状态机 ${sm.name} 不允许）`, illegalTransition: true };
    }
    bo.status = nextStatus;
    bo.updatedAt = nowIso();
    bo.history.push({ at: nowIso(), kind: meta.kind, summary: meta.summary, by: meta.by });
    this.repo.save(bo);
    return { ok: true, bo };
  }
}
