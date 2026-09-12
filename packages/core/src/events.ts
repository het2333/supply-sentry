import type { EntityId, EventSelector, ISODateTime } from './types.js';
import type { AIEmployeeStatus } from './org.js';

/** 领域事件目录（全部进入 eventLog，供审计与控制塔） */
export type DomainEvent =
  | { type: 'task.created'; taskId: EntityId; employeeId: EntityId; workflowId: string; at: ISODateTime }
  | { type: 'task.started'; taskId: EntityId; employeeId: EntityId; at: ISODateTime }
  | {
      type: 'task.waiting';
      taskId: EntityId;
      employeeId: EntityId;
      reason: string;
      untilAt?: ISODateTime;
      forEvent?: EventSelector;
      at: ISODateTime;
    }
  | { type: 'task.resumed'; taskId: EntityId; employeeId: EntityId; reason?: string; at: ISODateTime }
  | {
      type: 'task.waiting_approval';
      taskId: EntityId;
      employeeId: EntityId;
      approvalId: EntityId;
      ruleId: string;
      title: string;
      at: ISODateTime;
    }
  | { type: 'task.approved'; taskId: EntityId; approvalId: EntityId; by: string; at: ISODateTime }
  | { type: 'task.rejected'; taskId: EntityId; approvalId: EntityId; by: string; at: ISODateTime }
  | { type: 'task.completed'; taskId: EntityId; employeeId: EntityId; result?: Record<string, unknown>; at: ISODateTime }
  | { type: 'task.failed'; taskId: EntityId; employeeId: EntityId; error: string; attempts: number; at: ISODateTime }
  | { type: 'task.retrying'; taskId: EntityId; employeeId: EntityId; attempt: number; error: string; at: ISODateTime }
  | { type: 'task.handed_off'; taskId: EntityId; employeeId: EntityId; reason: string; at: ISODateTime }
  | { type: 'task.handoff_finished'; taskId: EntityId; at: ISODateTime }
  | { type: 'task.cancelled'; taskId: EntityId; at: ISODateTime }
  | {
      type: 'approval.requested';
      taskId: EntityId;
      approvalId: EntityId;
      ruleId: string;
      title: string;
      at: ISODateTime;
    }
  | {
      type: 'employee.status_changed';
      employeeId: EntityId;
      from: AIEmployeeStatus;
      to: AIEmployeeStatus;
      at: ISODateTime;
    }
  | { type: 'tool.called'; employeeId: EntityId; tool: string; action: string; ok: boolean; cost: number; at: ISODateTime }
  | { type: 'budget.recorded'; employeeId: EntityId; amount: number; currency: string; at: ISODateTime }
  | {
      type: 'context.event';
      eventType: string;
      objectId?: EntityId;
      payload?: Record<string, unknown>;
      at: ISODateTime;
    };

export interface EventBus {
  emit(e: DomainEvent): void;
  subscribe(listener: (e: DomainEvent) => void): () => void;
}

export class InMemoryEventBus implements EventBus {
  private listeners = new Set<(e: DomainEvent) => void>();

  emit(e: DomainEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // 监听器异常不应中断事件分发
      }
    }
  }

  subscribe(listener: (e: DomainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
