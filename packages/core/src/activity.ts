import type { EntityId, ISODateTime } from './types.js';
import { nowIso, uid } from './types.js';

/**
 * 统一活动/审计中心 —— 所有动作（AI 执行 / 人工审批 / ERP 回写 / 事件）都写一条 Activity。
 * 审计、绩效、AI 运行轨迹、出错排查都从 Activity 产生。
 */

export interface Activity {
  id: EntityId;
  at: ISODateTime;
  objectId?: EntityId;
  actor: string; // 'ai:procurement' | 'h:manager' | 'system'
  action: string; // 'po.sent' | 'approval.completed' | 'erp.write' | ...
  summary: string;
  context?: Record<string, unknown>;
}

export interface ActivityRepository {
  append(a: Activity): void;
  list(objectId?: EntityId, limit?: number): Activity[];
}

export class InMemoryActivityRepository implements ActivityRepository {
  private log: Activity[] = [];
  append(a: Activity): void { this.log.push(a); }
  list(objectId?: EntityId, limit?: number): Activity[] {
    const filtered = objectId ? this.log.filter((a) => a.objectId === objectId) : [...this.log];
    return limit === undefined ? filtered : filtered.slice(-limit);
  }
}

export class ActivityStore {
  constructor(private repo: ActivityRepository) {}

  record(input: { objectId?: EntityId; actor: string; action: string; summary: string; context?: Record<string, unknown> }): Activity {
    const a: Activity = {
      id: uid('act'),
      at: nowIso(),
      objectId: input.objectId,
      actor: input.actor,
      action: input.action,
      summary: input.summary,
      context: input.context,
    };
    this.repo.append(a);
    return a;
  }

  list(objectId?: EntityId, limit?: number): Activity[] { return this.repo.list(objectId, limit); }
}
