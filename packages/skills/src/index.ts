import type { BusinessObject, EntityId, SkillDescriptor } from '@readywork/core';

/**
 * 能力层（Skills）插件系统。
 * Skill = AI 会什么（确定性能力），行业技能由 Workforce Pack 注册实现。
 */

export interface SkillContext {
  employeeId: EntityId;
  taskId: EntityId;
  businessObject?: BusinessObject;
}

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  invoke(input: Record<string, unknown>, ctx: SkillContext): Promise<Record<string, unknown>>;
}

export class SkillRegistry {
  private defs = new Map<string, SkillDef>();

  register(def: SkillDef): void {
    this.defs.set(def.id, def);
  }

  get(id: string): SkillDef | undefined {
    return this.defs.get(id);
  }

  list(): SkillDescriptor[] {
    return [...this.defs.values()].map((d) => ({ id: d.id, name: d.name }));
  }

  async invoke(id: string, input: Record<string, unknown>, ctx: SkillContext): Promise<Record<string, unknown>> {
    const def = this.defs.get(id);
    if (!def) throw new Error(`技能未注册: ${id}`);
    return def.invoke(input, ctx);
  }
}
