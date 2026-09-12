import type { ApprovalRequest } from './approval.js';
import type { BudgetState } from './budget.js';
import type { BusinessObject } from './business-object.js';
import type { DomainEvent } from './events.js';
import type { Task, TaskStatus } from './task.js';
import type { EntityId } from './types.js';

/**
 * 仓储接口 —— 持久化边界。
 * 默认内存实现；packages/persistence 提供 node:sqlite 实现。
 * 所有 Store 的每次变更都会 save()，天然支持崩溃恢复（V2）。
 */

export interface TaskRepository {
  get(id: EntityId): Task | undefined;
  list(status?: TaskStatus): Task[];
  save(task: Task): void;
}

export class InMemoryTaskRepository implements TaskRepository {
  private tasks = new Map<EntityId, Task>();

  get(id: EntityId): Task | undefined {
    return this.tasks.get(id);
  }

  list(status?: TaskStatus): Task[] {
    const all = [...this.tasks.values()];
    return status ? all.filter((t) => t.status === status) : all;
  }

  save(task: Task): void {
    this.tasks.set(task.id, task);
  }
}

export interface BusinessObjectRepository {
  get(id: EntityId): BusinessObject | undefined;
  list(type?: string): BusinessObject[];
  save(bo: BusinessObject): void;
}

export class InMemoryBusinessObjectRepository implements BusinessObjectRepository {
  private objs = new Map<EntityId, BusinessObject>();

  get(id: EntityId): BusinessObject | undefined {
    return this.objs.get(id);
  }

  list(type?: string): BusinessObject[] {
    const all = [...this.objs.values()];
    return type ? all.filter((b) => b.type === type) : all;
  }

  save(bo: BusinessObject): void {
    this.objs.set(bo.id, bo);
  }
}

export interface ApprovalRepository {
  get(id: EntityId): ApprovalRequest | undefined;
  listByTask(taskId: EntityId): ApprovalRequest[];
  listPending(): ApprovalRequest[];
  save(req: ApprovalRequest): void;
}

export class InMemoryApprovalRepository implements ApprovalRepository {
  private requests = new Map<EntityId, ApprovalRequest>();

  get(id: EntityId): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  listByTask(taskId: EntityId): ApprovalRequest[] {
    return [...this.requests.values()].filter((r) => r.taskId === taskId);
  }

  listPending(): ApprovalRequest[] {
    return [...this.requests.values()].filter((r) => r.status === 'pending');
  }

  save(req: ApprovalRequest): void {
    this.requests.set(req.id, req);
  }
}

export interface EventRepository {
  append(e: DomainEvent): void;
  list(limit?: number): DomainEvent[];
}

export class InMemoryEventRepository implements EventRepository {
  private log: DomainEvent[] = [];

  append(e: DomainEvent): void {
    this.log.push(e);
  }

  list(limit?: number): DomainEvent[] {
    return limit === undefined ? [...this.log] : this.log.slice(-limit);
  }
}

export interface BudgetRepository {
  get(employeeId: EntityId): BudgetState | undefined;
  save(state: BudgetState): void;
}

export class InMemoryBudgetRepository implements BudgetRepository {
  private states = new Map<EntityId, BudgetState>();

  get(employeeId: EntityId): BudgetState | undefined {
    return this.states.get(employeeId);
  }

  save(state: BudgetState): void {
    this.states.set(state.employeeId, state);
  }
}
