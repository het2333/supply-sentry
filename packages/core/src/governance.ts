/**
 * Governance —— 权限与治理引擎。
 *
 * 核心原则：聊天只是下达指令的入口，真正能执行什么取决于权限交集：
 *   最终可执行权限 = 当前用户权限 ∩ AI 员工权限 ∩ 连接器权限 ∩ 企业业务规则
 * 任何一层不允许，就不能直接做。
 */

export type ActionCategory = 'read' | 'analyze' | 'internal' | 'external_comm' | 'erp_write' | 'high_risk' | 'admin';

export type PermissionLevel = 'allow' | 'conditional' | 'require_approval' | 'readonly' | 'deny';

export interface ActionRule {
  category: ActionCategory;
  level: PermissionLevel;
  /** 条件允许的触发条件（人类可读） */
  condition?: string;
  note?: string;
}

export interface PermissionDecision {
  action: string;
  category: ActionCategory;
  level: PermissionLevel;
  /** 是否可自动执行（无人工审批） */
  autoExecute: boolean;
  /** 不允许时的原因 */
  reason: string;
}

export class GovernanceService {
  constructor(private rules: Record<string, ActionRule>) {}

  check(action: string, context?: Record<string, unknown>): PermissionDecision {
    const rule = this.rules[action];
    if (!rule) {
      return { action, category: 'admin', level: 'deny', autoExecute: false, reason: '该动作未在权限矩阵中定义，默认禁止' };
    }
    const autoExecute = rule.level === 'allow' || (rule.level === 'conditional' && this.meetsCondition(action, context));
    const reason = rule.level === 'conditional' && !autoExecute
      ? `条件允许未满足：${rule.condition ?? '需满足业务阈值'}`
      : rule.note ?? rule.level;
    return { action, category: rule.category, level: rule.level, autoExecute, reason };
  }

  private meetsCondition(action: string, context?: Record<string, unknown>): boolean {
    if (action === 'update_promise_date') {
      // 交期变化 ≤ 2 天才可自动
      return Number(context?.['days'] ?? 0) <= 2;
    }
    if (action === 'update_quantity') {
      // 数量变化 ≤ 0 才可自动（即不允许自动增数量）
      return Number(context?.['delta'] ?? 1) <= 0;
    }
    return false;
  }
}

/** 报价与订单员工（销售侧）权限矩阵 —— 报价=商业承诺，比采购更敏感 */
export function quoteOperatorGovernance(): Record<string, ActionRule> {
  return {
    // 读取
    read_customer_rfq: { category: 'read', level: 'allow', note: '读取客户询价' },
    read_history_quote: { category: 'read', level: 'allow', note: '读取历史报价' },
    read_erp_product: { category: 'read', level: 'allow', note: '读取 ERP 产品' },
    check_inventory: { category: 'read', level: 'allow', note: '查库存' },
    read_std_price: { category: 'read', level: 'allow', note: '查标准价格表' },
    read_history_price: { category: 'read', level: 'allow', note: '查询历史成交价' },
    read_std_leadtime: { category: 'read', level: 'allow', note: '查询标准交期' },
    // 分析与生成
    product_match: { category: 'analyze', level: 'conditional', condition: '匹配置信度 ≥ 98%', note: '低置信度需人工选型' },
    generate_quote_draft: { category: 'analyze', level: 'allow', note: '生成报价草稿' },
    // 外部沟通
    send_std_quote: { category: 'external_comm', level: 'conditional', condition: '标准产品 且 毛利 ≥ 25% 且 折扣 ≤ 5%', note: '标准报价条件自动' },
    send_quote: { category: 'external_comm', level: 'conditional', condition: '标准报价可自动，非标需审批' },
    // 业务系统写入
    create_sales_order: { category: 'erp_write', level: 'conditional', condition: '客户接受后', note: '客户接受后创建销售订单' },
    // 高风险商业
    nonstd_quote: { category: 'high_risk', level: 'require_approval', note: '非标产品报价需技术工程师审批' },
    low_margin_quote: { category: 'high_risk', level: 'require_approval', note: '毛利率 < 25% 需销售经理审批' },
    special_payment_terms: { category: 'high_risk', level: 'require_approval', note: '特殊付款条款需审批' },
    special_leadtime: { category: 'high_risk', level: 'require_approval', note: '交期提前 > 7 天需生产计划审批' },
    over_discount: { category: 'high_risk', level: 'require_approval', note: '折扣 > 5% 需审批' },
    modify_floor_price: { category: 'high_risk', level: 'deny', note: '修改底价永远禁止' },
    // 管理员
    change_rule: { category: 'admin', level: 'require_approval', note: '修改报价规则需管理员确认' },
    add_capability: { category: 'admin', level: 'require_approval', note: '加能力需管理员确认' },
    set_deploy_mode: { category: 'admin', level: 'require_approval', note: '切部署模式需管理员确认' },
  };
}

/** 采购订单执行员工的权限矩阵（7 级） */
export function poOperatorGovernance(): Record<string, ActionRule> {
  return {
    // 1 读取
    overview: { category: 'read', level: 'allow', note: '只读' },
    list_employees: { category: 'read', level: 'allow' },
    employee_detail: { category: 'read', level: 'allow' },
    list_tasks: { category: 'read', level: 'allow' },
    list_approvals: { category: 'read', level: 'allow' },
    get_context: { category: 'read', level: 'allow' },
    get_tools: { category: 'read', level: 'allow' },
    get_po: { category: 'read', level: 'allow', note: '可查询采购订单' },
    get_supplier: { category: 'read', level: 'allow', note: '可查询供应商' },
    // 2 分析与生成
    draft_email: { category: 'analyze', level: 'allow', note: '生成草稿，不发送' },
    analyze_delay: { category: 'analyze', level: 'allow' },
    compare_quotes: { category: 'analyze', level: 'allow' },
    // 3 内部操作
    approve: { category: 'internal', level: 'allow', note: '采购经理审批决策' },
    reject: { category: 'internal', level: 'allow' },
    inject_event: { category: 'internal', level: 'allow' },
    create_task: { category: 'internal', level: 'allow' },
    notify: { category: 'internal', level: 'allow' },
    // 4 外部沟通
    send_email: { category: 'external_comm', level: 'allow', note: '催交/确认类邮件可自动发送' },
    send_wecom: { category: 'external_comm', level: 'allow' },
    // 5 业务系统写入
    update_po_status: { category: 'erp_write', level: 'allow', note: '更新订单状态可自动' },
    update_promise_date: { category: 'erp_write', level: 'conditional', condition: '交期变化 ≤ 2 天', note: '承诺交期变化超过 2 天需审批' },
    // 6 高风险商业
    update_price: { category: 'high_risk', level: 'require_approval', note: '修改采购价格必须审批' },
    update_quantity: { category: 'high_risk', level: 'require_approval', note: '增加采购数量必须审批' },
    cancel_order: { category: 'high_risk', level: 'require_approval', note: '取消订单必须审批' },
    award: { category: 'high_risk', level: 'require_approval', note: '授标必须审批' },
    payment: { category: 'high_risk', level: 'deny', note: '付款永远禁止由 AI 员工执行' },
    // 7 管理员
    add_capability: { category: 'admin', level: 'require_approval', note: '给员工加能力需管理员确认' },
    set_deploy_mode: { category: 'admin', level: 'require_approval', note: '切换部署模式需管理员确认' },
    change_rule: { category: 'admin', level: 'require_approval', note: '修改自动化规则需管理员确认，且员工不能自授权' },
    publish_version: { category: 'admin', level: 'require_approval', note: '发布新版本需管理员确认' },
    create_employee: { category: 'admin', level: 'require_approval', note: '创建员工需管理员确认' },
  };
}
