import type { EntityId } from './types.js';
import type { BusinessObject } from './business-object.js';

/**
 * Employee Definition —— Build Plane 的输出（Employee Spec）。
 * 一份 Spec 定义"一个 AI 岗位"：做什么、会什么、能用什么、能碰什么、何时需要人。
 */

export interface KpiDef {
  id: string;
  name: string;
  unit: string;
  target?: number;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  kpis: KpiDef[];
}

export type RuleEffect = 'allow' | 'deny';

/** 权限规则：默认拒绝；deny 优先于 allow；action/resource 支持 '*' 与 '前缀.*' */
export interface PermissionRule {
  effect: RuleEffect;
  action: string;
  resource: string;
  note?: string;
}

export interface RuleContext {
  employeeId: EntityId;
  taskId?: EntityId;
  businessObject?: BusinessObject;
  action?: string;
  resource?: string;
  payload?: Record<string, unknown>;
  now: Date;
}

export type ConditionFn = (ctx: RuleContext) => boolean;

/** 审批规则（工作流中显式挂载审批步骤；此处元数据供控制塔展示与 V2 自动审批引擎） */
export interface ApprovalRule {
  id: string;
  name: string;
  message: string;
  when: ConditionFn;
  approver: string; // 'manager' | 'contact:<id>' | 具体角色名
}

/** 运行时策略：命中时阻断或要求审批 */
export interface PolicyRule {
  id: string;
  name: string;
  when: ConditionFn;
  then: 'block' | 'require_approval';
  message: string;
}

export interface EvalCriterion {
  id: string;
  name: string;
  formula: 'success_rate' | 'intervention_rate' | 'on_time_rate' | 'cost';
}

/**
 * 能力模块：把一个岗位拆成"面向业务的能力模块"，而非平级小员工。
 * 一个「采购运营员工」由 需求处理 / 询价采购 / 采购订单 / 供应商跟进 / 异常处理 / 系统同步 等模块组成。
 */
export interface CapabilityModule {
  id: string;
  name: string;
  description: string;
  /** 归属的流程（Workflow）id，用于把模块落到具体执行路径 */
  workflows?: string[];
  /** 归属的技能（Skill）id，用于把模块落到具体专业能力 */
  skills?: string[];
}

export interface EmployeeSpec {
  id: string;
  name: string;
  departmentId: EntityId;
  version: string;
  /** 员工版本绑定的可安装产品包；未声明时仅使用通用 Workforce Core。 */
  capabilityPackIds?: string[];
  role: string;
  description?: string;
  goals: Goal[];
  /** 能力模块（员工 → 技能/流程 的三级结构的第一层呈现） */
  capabilities?: CapabilityModule[];
  workers: string[]; // 装配的 Worker 执行单元
  workflows: string[];
  skills: string[];
  tools: string[];
  permissions: PermissionRule[];
  policies: PolicyRule[];
  approvalRules: ApprovalRule[];
  budget?: { monthlyCap: number; currency: string };
  contextScope: string[]; // 可见的 Context 实体类型
  evalCriteria: EvalCriterion[];
  humanEscalation: { contactIds: EntityId[] };
}

export class EmployeeSpecRegistry {
  private specs = new Map<string, EmployeeSpec>();

  register(spec: EmployeeSpec): void {
    this.specs.set(spec.id, spec);
  }

  get(id: string): EmployeeSpec | undefined {
    return this.specs.get(id);
  }

  list(): EmployeeSpec[] {
    return [...this.specs.values()];
  }
}
