import type {
  ContextEntity,
  ContextSnapshot,
  ContextStore,
  EntityId,
  Evidence,
  Relationship,
} from '@readywork/core';
import { nowIso, uid } from '@readywork/core';

export * from './context-identity.js';
export * from './context-access-policy.js';
export * from './snapshot-builder.js';
export * from './agent-events.js';
export * from './projection-queue.js';
export * from './procurement-po-missing-facts.js';
export * from './procurement-po-projector.js';
export * from './sqlite-manufacturing-context-store.js';

/**
 * Enterprise Context Graph —— 企业数字大脑（V1 内存实现）。
 * 实体 + 关系 + 证据 + 员工私有记忆；快照按权限范围过滤。
 */
export class InMemoryContextStore implements ContextStore {
  private entities = new Map<EntityId, ContextEntity>();
  private relationships: Relationship[] = [];
  private evidences: Evidence[] = [];
  private memories = new Map<EntityId, Map<string, unknown>>();

  upsertEntity(e: {
    id: EntityId;
    type: string;
    attributes?: Record<string, unknown>;
    state?: Record<string, unknown>;
  }): ContextEntity {
    const existing = this.entities.get(e.id);
    const entity: ContextEntity = {
      id: e.id,
      type: e.type,
      attributes: { ...(existing?.attributes ?? {}), ...(e.attributes ?? {}) },
      state: { ...(existing?.state ?? {}), ...(e.state ?? {}) },
      updatedAt: nowIso(),
    };
    this.entities.set(entity.id, entity);
    return entity;
  }

  getEntity(id: EntityId): ContextEntity | undefined {
    return this.entities.get(id);
  }

  queryEntities(type?: string): ContextEntity[] {
    const all = [...this.entities.values()];
    return type ? all.filter((e) => e.type === type) : all;
  }

  relate(from: EntityId, to: EntityId, type: string): Relationship {
    const rel: Relationship = { from, to, type, since: nowIso() };
    this.relationships.push(rel);
    return rel;
  }

  getRelations(id: EntityId): Relationship[] {
    return this.relationships.filter((r) => r.from === id || r.to === id);
  }

  recordEvidence(e: { entityId?: EntityId; source: string; summary: string }): Evidence {
    const ev: Evidence = { id: uid('ev'), at: nowIso(), ...e };
    this.evidences.push(ev);
    return ev;
  }

  remember(employeeId: EntityId, key: string, value: unknown): void {
    let m = this.memories.get(employeeId);
    if (!m) {
      m = new Map();
      this.memories.set(employeeId, m);
    }
    m.set(key, value);
  }

  recall(employeeId: EntityId, key: string): unknown {
    return this.memories.get(employeeId)?.get(key);
  }

  snapshotFor(employeeId: EntityId, scope: string[]): ContextSnapshot {
    const entities = scope.length
      ? [...this.entities.values()].filter((e) => scope.includes(e.type))
      : [...this.entities.values()];
    const ids = new Set(entities.map((e) => e.id));
    const relationships = this.relationships.filter((r) => ids.has(r.from) && ids.has(r.to));
    const memory: Record<string, unknown> = {};
    for (const [k, v] of this.memories.get(employeeId) ?? []) memory[k] = v;
    return { employeeId, at: nowIso(), entities, relationships, memory };
  }
}
