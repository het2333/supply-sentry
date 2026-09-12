import type { EventBus } from './events.js';
import { InMemoryBudgetRepository, type BudgetRepository } from './repositories.js';
import type { EntityId, Month } from './types.js';
import { currentMonth, nowIso } from './types.js';

export interface BudgetState {
  employeeId: EntityId;
  monthlyCap: number;
  currency: string;
  month: Month;
  spent: number;
}

/** 预算记账：按月滚动，超限拒绝；每次变更落盘（默认内存） */
export class BudgetService {
  private repo: BudgetRepository;

  constructor(
    private bus?: EventBus,
    repo?: BudgetRepository,
  ) {
    this.repo = repo ?? new InMemoryBudgetRepository();
  }

  record(employeeId: EntityId, amount: number, currency: string, cap?: number): boolean {
    const month = currentMonth();
    let b = this.repo.get(employeeId);
    if (!b || b.month !== month) {
      b = { employeeId, monthlyCap: cap ?? Number.POSITIVE_INFINITY, currency, month, spent: 0 };
    }
    if (cap !== undefined) b.monthlyCap = cap;
    if (b.spent + amount > b.monthlyCap) return false;
    b.spent += amount;
    this.repo.save(b);
    this.bus?.emit({ type: 'budget.recorded', employeeId, amount, currency, at: nowIso() });
    return true;
  }

  state(employeeId: EntityId): BudgetState | undefined {
    return this.repo.get(employeeId);
  }

  spent(employeeId: EntityId): number {
    return this.repo.get(employeeId)?.spent ?? 0;
  }
}
