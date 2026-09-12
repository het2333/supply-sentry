import type { EntityId, ISODateTime } from './types.js';

/**
 * Context Plane 端口定义（核心层只定义契约，实现见 @readywork/context）。
 * 所有 AI Employee 按 spec.contextScope（权限）共享同一个 Context Store。
 */

export interface ContextEntity {
  id: EntityId;
  type: string;
  attributes: Record<string, unknown>;
  state: Record<string, unknown>;
  updatedAt: ISODateTime;
}

export interface Relationship {
  from: EntityId;
  to: EntityId;
  type: string;
  since: ISODateTime;
}

export interface Evidence {
  id: EntityId;
  at: ISODateTime;
  entityId?: EntityId;
  source: string;
  summary: string;
}

/** 注入 Agent 的上下文快照（纯 JSON，可序列化进 LLM 上下文） */
export interface ContextSnapshot {
  employeeId: EntityId;
  at: ISODateTime;
  entities: ContextEntity[];
  relationships: Relationship[];
  memory: Record<string, unknown>;
}

export interface ContextStore {
  upsertEntity(e: { id: EntityId; type: string; attributes?: Record<string, unknown>; state?: Record<string, unknown> }): ContextEntity;
  getEntity(id: EntityId): ContextEntity | undefined;
  queryEntities(type?: string): ContextEntity[];
  relate(from: EntityId, to: EntityId, type: string): Relationship;
  getRelations(id: EntityId): Relationship[];
  recordEvidence(e: { entityId?: EntityId; source: string; summary: string }): Evidence;
  remember(employeeId: EntityId, key: string, value: unknown): void;
  recall(employeeId: EntityId, key: string): unknown;
  /** 按权限范围返回员工可见的快照 */
  snapshotFor(employeeId: EntityId, scope: string[]): ContextSnapshot;
}
