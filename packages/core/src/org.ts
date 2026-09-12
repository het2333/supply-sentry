import type { EntityId, ISODateTime } from './types.js';

/** AI 员工运行状态（与控制塔一致） */
export type AIEmployeeStatus = 'idle' | 'working' | 'waiting_external' | 'waiting_approval' | 'waiting_human' | 'failed';

export interface Tenant {
  id: EntityId;
  name: string;
}

export interface Department {
  id: EntityId;
  tenantId: EntityId;
  name: string;
}

export interface HumanEmployee {
  id: EntityId;
  tenantId: EntityId;
  deptId: EntityId;
  name: string;
  email: string;
  role: string;
  managerId?: EntityId;
}

export interface EmployeeStats {
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  humanTakeovers: number;
  onTimeCompleted: number;
  totalCost: number;
}

export function emptyStats(): EmployeeStats {
  return { tasksTotal: 0, tasksCompleted: 0, tasksFailed: 0, humanTakeovers: 0, onTimeCompleted: 0, totalCost: 0 };
}

export interface AIEmployee {
  id: EntityId;
  tenantId: EntityId;
  deptId: EntityId;
  specId: string;
  name: string;
  role: string;
  status: AIEmployeeStatus;
  managerId?: EntityId;
  stats: EmployeeStats;
  createdAt: ISODateTime;
}

export class OrgRegistry {
  private tenants = new Map<EntityId, Tenant>();
  private departments = new Map<EntityId, Department>();
  private humans = new Map<EntityId, HumanEmployee>();
  private ais = new Map<EntityId, AIEmployee>();

  registerTenant(t: Tenant): Tenant {
    this.tenants.set(t.id, t);
    return t;
  }

  registerDepartment(d: Department): Department {
    this.departments.set(d.id, d);
    return d;
  }

  registerHuman(h: HumanEmployee): HumanEmployee {
    this.humans.set(h.id, h);
    return h;
  }

  registerAI(e: AIEmployee): AIEmployee {
    this.ais.set(e.id, e);
    return e;
  }

  getTenant(id: EntityId): Tenant | undefined {
    return this.tenants.get(id);
  }

  getDepartment(id: EntityId): Department | undefined {
    return this.departments.get(id);
  }

  getHuman(id: EntityId): HumanEmployee | undefined {
    return this.humans.get(id);
  }

  getAI(id: EntityId): AIEmployee | undefined {
    return this.ais.get(id);
  }

  listTenants(): Tenant[] {
    return [...this.tenants.values()];
  }

  listDepartments(): Department[] {
    return [...this.departments.values()];
  }

  listHumans(): HumanEmployee[] {
    return [...this.humans.values()];
  }

  listAI(): AIEmployee[] {
    return [...this.ais.values()];
  }

  setStatus(id: EntityId, status: AIEmployeeStatus): AIEmployee | undefined {
    const e = this.ais.get(id);
    if (e) e.status = status;
    return e;
  }
}
