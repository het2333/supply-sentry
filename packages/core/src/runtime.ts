import { ApprovalStore } from './approval.js';
import { BudgetService } from './budget.js';
import type { DomainEvent, EventBus } from './events.js';
import { InMemoryEventBus } from './events.js';
import { EmployeeSpecRegistry } from './employee-spec.js';
import { BusinessObjectStore } from './business-object.js';
import { ExceptionStore, InMemoryExceptionRepository, type ExceptionRepository } from './exception.js';
import { ActivityStore, InMemoryActivityRepository, type ActivityRepository } from './activity.js';
import { OrgRegistry } from './org.js';
import { PolicyEngine } from './policy.js';
import {
  InMemoryApprovalRepository,
  InMemoryBudgetRepository,
  InMemoryBusinessObjectRepository,
  InMemoryEventRepository,
  InMemoryTaskRepository,
  type ApprovalRepository,
  type BudgetRepository,
  type BusinessObjectRepository,
  type EventRepository,
  type TaskRepository,
} from './repositories.js';
import { Scheduler } from './scheduler.js';
import { TaskStateMachine } from './task.js';
import { WorkerRegistry } from './workers.js';

/**
 * RuntimeHub —— Business Runtime 微内核的组装根。
 * 所有横切系统（事件/调度/组织/规格/业务对象/审批/任务/权限/预算/Worker）在此统一装配。
 * 仓储默认内存；传入持久化仓储即获得跨重启状态（见 packages/persistence）。
 */
export interface RuntimeHub {
  bus: EventBus;
  eventLog: DomainEvent[];
  scheduler: Scheduler;
  org: OrgRegistry;
  specs: EmployeeSpecRegistry;
  objects: BusinessObjectStore;
  approvals: ApprovalStore;
  exceptions: ExceptionStore;
  activities: ActivityStore;
  machine: TaskStateMachine;
  policy: PolicyEngine;
  budget: BudgetService;
  workers: WorkerRegistry;
  taskRepo: TaskRepository;
  objectRepo: BusinessObjectRepository;
  approvalRepo: ApprovalRepository;
  eventRepo: EventRepository;
  budgetRepo: BudgetRepository;
  exceptionRepo: ExceptionRepository;
  activityRepo: ActivityRepository;
}

export interface RuntimeHubOptions {
  taskRepo?: TaskRepository;
  objectRepo?: BusinessObjectRepository;
  approvalRepo?: ApprovalRepository;
  eventRepo?: EventRepository;
  budgetRepo?: BudgetRepository;
  exceptionRepo?: ExceptionRepository;
  activityRepo?: ActivityRepository;
}

export function createRuntimeHub(opts: RuntimeHubOptions = {}): RuntimeHub {
  const eventRepo = opts.eventRepo ?? new InMemoryEventRepository();
  const taskRepo = opts.taskRepo ?? new InMemoryTaskRepository();
  const objectRepo = opts.objectRepo ?? new InMemoryBusinessObjectRepository();
  const approvalRepo = opts.approvalRepo ?? new InMemoryApprovalRepository();
  const budgetRepo = opts.budgetRepo ?? new InMemoryBudgetRepository();
  const exceptionRepo = opts.exceptionRepo ?? new InMemoryExceptionRepository();
  const activityRepo = opts.activityRepo ?? new InMemoryActivityRepository();

  const eventLog: DomainEvent[] = [];
  const bus = new InMemoryEventBus();
  const activities = new ActivityStore(activityRepo);
  const exceptions = new ExceptionStore(exceptionRepo);
  bus.subscribe((e) => {
    eventLog.push(e);
    eventRepo.append(e);
    // 统一活动/审计中心：每个领域事件也写一条 Activity（审计/绩效/运行轨迹都从它出）
    const objectId = ('taskId' in e && e.taskId) || ('objectId' in e && e.objectId) || undefined;
    const actor = ('by' in e && e.by) || ('employeeId' in e && e.employeeId) || 'system';
    activities.record({ objectId: objectId as string | undefined, actor: actor as string, action: e.type, summary: e.type });
  });
  const approvals = new ApprovalStore(approvalRepo);
  return {
    bus,
    eventLog,
    scheduler: new Scheduler(),
    org: new OrgRegistry(),
    specs: new EmployeeSpecRegistry(),
    objects: new BusinessObjectStore(objectRepo),
    approvals,
    exceptions,
    activities,
    machine: new TaskStateMachine(bus, approvals, taskRepo),
    policy: new PolicyEngine(),
    budget: new BudgetService(bus, budgetRepo),
    workers: new WorkerRegistry(),
    taskRepo,
    objectRepo,
    approvalRepo,
    eventRepo,
    budgetRepo,
    exceptionRepo,
    activityRepo,
  };
}
