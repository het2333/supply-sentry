import type {
  AIEmployee,
  ApprovalRequest,
  Department,
  DomainEvent,
  EmployeeSpec,
  EmployeeStats,
  EntityId,
  PermissionRule,
  RuntimeHub,
  Task,
  TaskStatus,
} from '@readywork/core';
import type { WorkflowEngine } from '@readywork/workflow';

/**
 * Control Tower —— 管理员管理的是员工、任务、KPI，不是 Prompt。
 * V1 为查询层；V2 增加指令（暂停/接管/降级）与评测回放。
 */

export interface TowerOverview {
  employees: {
    total: number;
    byStatus: Record<string, number>;
    byDepartment: Record<string, number>;
  };
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    pendingApprovals: number;
  };
}

export interface EmployeeKpi {
  successRate: number;
  interventionRate: number;
  onTimeRate: number;
  totalCost: number;
}

export interface EmployeeDetail {
  employee: AIEmployee;
  spec: EmployeeSpec;
  kpi: EmployeeKpi;
  stats: EmployeeStats;
  permissions: PermissionRule[];
  pendingApprovals: ApprovalRequest[];
}

export class TowerService {
  constructor(
    private hub: RuntimeHub,
    private engine: WorkflowEngine,
  ) {}

  overview(): TowerOverview {
    const employees = this.hub.org.listAI();
    const byStatus: Record<string, number> = {};
    const byDepartment: Record<string, number> = {};
    for (const e of employees) {
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
      const dept = this.hub.org.getDepartment(e.deptId);
      const key = dept?.name ?? e.deptId;
      byDepartment[key] = (byDepartment[key] ?? 0) + 1;
    }
    const tasks = this.hub.machine.list();
    const tasksByStatus: Record<string, number> = {};
    for (const t of tasks) tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
    return {
      employees: { total: employees.length, byStatus, byDepartment },
      tasks: { total: tasks.length, byStatus: tasksByStatus, pendingApprovals: this.hub.approvals.listPending().length },
    };
  }

  employeeDetail(id: EntityId): EmployeeDetail {
    const employee = this.hub.org.getAI(id);
    if (!employee) throw new Error(`AI 员工不存在: ${id}`);
    const spec = this.hub.specs.get(employee.specId);
    if (!spec) throw new Error(`员工 Spec 不存在: ${employee.specId}`);
    const s = employee.stats;
    const kpi: EmployeeKpi = {
      successRate: s.tasksTotal > 0 ? s.tasksCompleted / s.tasksTotal : 0,
      interventionRate: s.tasksTotal > 0 ? s.humanTakeovers / s.tasksTotal : 0,
      onTimeRate: s.tasksCompleted > 0 ? s.onTimeCompleted / s.tasksCompleted : 0,
      totalCost: s.totalCost,
    };
    return {
      employee,
      spec,
      kpi,
      stats: s,
      permissions: spec.permissions,
      pendingApprovals: this.hub.approvals
        .listPending()
        .filter((a) => this.hub.machine.get(a.taskId)?.employeeId === id),
    };
  }

  employees(): AIEmployee[] {
    return this.hub.org.listAI();
  }

  tasks(status?: TaskStatus): Task[] {
    return this.hub.machine.list(status);
  }

  pendingApprovals(): ApprovalRequest[] {
    return this.hub.approvals.listPending();
  }

  recentEvents(n = 50): DomainEvent[] {
    return this.hub.eventLog.slice(-n);
  }

  departments(): { department: Department; aiCount: number; humanCount: number }[] {
    return this.hub.org.listDepartments().map((department) => ({
      department,
      aiCount: this.hub.org.listAI().filter((e) => e.deptId === department.id).length,
      humanCount: this.hub.org.listHumans().filter((e) => e.deptId === department.id).length,
    }));
  }
}
