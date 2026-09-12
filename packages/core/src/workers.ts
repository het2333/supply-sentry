/** Systems of Workers —— Worker 定义与路由 */
export interface WorkerDef {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  taskTypes: string[];
}

export class WorkerRegistry {
  private defs = new Map<string, WorkerDef>();

  register(def: WorkerDef): void {
    this.defs.set(def.id, def);
  }

  get(id: string): WorkerDef | undefined {
    return this.defs.get(id);
  }

  list(): WorkerDef[] {
    return [...this.defs.values()];
  }

  findByTaskType(taskType: string): WorkerDef[] {
    return this.list().filter((w) => w.taskTypes.includes(taskType));
  }
}

/** Worker Router：按任务类型与偏好选出执行单元（V1 简单实现） */
export function routeWorker(registry: WorkerRegistry, taskType: string, preferredIds?: string[]): WorkerDef | undefined {
  if (preferredIds) {
    for (const id of preferredIds) {
      const w = registry.get(id);
      if (w && w.taskTypes.includes(taskType)) return w;
    }
  }
  return registry.findByTaskType(taskType)[0];
}
