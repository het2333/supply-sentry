/**
 * 采购域核心数据模型 —— 业务对象比任务更重要。
 *
 * 系统核心不是 task_001 / task_002，而是真实采购对象：
 *   Supplier / Item / RFQ / Quote / PO / Shipment / Receipt / Invoice / Exception / Approval / Activity
 *
 * 每个业务对象有自己的状态机；系统由「事件」驱动；正常自动处理，异常才创建人工任务。
 */

// ---------------------------------------------------------------- ① 业务对象类型

export type ProcurementObjectKind =
  | 'supplier' | 'item'
  | 'rfq' | 'quote'
  | 'purchase_order' | 'production_progress' | 'shipment' | 'transport_event' | 'receipt'
  | 'invoice' | 'match_result'
  | 'exception' | 'approval' | 'activity' | 'communication';

// ---------------------------------------------------------------- ② 状态机

export interface StateMachine {
  name: string;
  states: string[];
  /** 合法转移：当前状态 -> 允许的下一状态（含回退边，如拒单 → 关闭 / 拒单 → 重新询价） */
  transitions: Record<string, string[]>;
  /** 异常态（暂停 / 取消），不属于正常主链 */
  abnormal: string[];
}

export const PO_STATE_MACHINE: StateMachine = {
  name: '采购订单',
  states: ['draft', 'created', 'sent', 'awaiting_confirmation', 'confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped', 'shipped', 'partially_received', 'received', 'closed'],
  transitions: {
    draft: ['created', 'sent'],
    created: ['sent'],
    sent: ['awaiting_confirmation'],
    awaiting_confirmation: ['confirmed', 'rejected', 'cancelled'],
    confirmed: ['in_production'],
    in_production: ['awaiting_shipment'],
    awaiting_shipment: ['partially_shipped', 'shipped'],
    partially_shipped: ['shipped', 'partially_received'],
    shipped: ['partially_received', 'received'],
    partially_received: ['received'],
    received: ['closed'],
    // 回退/异常边
    rejected: ['closed'],
    cancelled: ['closed'],
  },
  abnormal: ['rejected', 'cancelled'],
};

export const RFQ_STATE_MACHINE: StateMachine = {
  name: '询价单',
  states: ['draft', 'sent', 'awaiting_quotes', 'partial_quotes', 'quotes_complete', 'compared', 'pending_award', 'awarded', 'closed'],
  transitions: {
    // Manual/offline quotes may be entered against a draft RFQ. Persisting the
    // complete immutable comparison is the governed transition to award review.
    draft: ['sent', 'pending_award'],
    sent: ['awaiting_quotes'],
    awaiting_quotes: ['partial_quotes', 'quotes_complete', 'pending_award'],
    partial_quotes: ['awaiting_quotes', 'quotes_complete', 'pending_award'],
    quotes_complete: ['compared', 'pending_award'],
    compared: ['pending_award'],
    pending_award: ['awarded'],
    awarded: ['closed'],
  },
  abnormal: [],
};

export const INVOICE_STATE_MACHINE: StateMachine = {
  name: '发票',
  states: ['received', 'parsing', 'awaiting_link', 'three_way_match', 'matched', 'pending_approval', 'exception', 'payable_approved', 'erp_written'],
  transitions: {
    received: ['parsing'],
    parsing: ['awaiting_link', 'exception'],
    awaiting_link: ['three_way_match', 'exception'],
    three_way_match: ['matched', 'pending_approval', 'exception'],
    matched: ['payable_approved'],
    pending_approval: ['payable_approved', 'exception'],
    exception: ['awaiting_link', 'three_way_match', 'matched'],
    payable_approved: ['erp_written'],
  },
  abnormal: ['exception'],
};

// ---------------------------------------------------------------- ③ 事件分类

export const PROCUREMENT_EVENTS = {
  PO_CREATED: 'po.created',
  PO_SENT: 'po.sent',
  SUPPLIER_EMAIL_RECEIVED: 'supplier.email.received',
  PO_CONFIRMATION_RECEIVED: 'po.confirmation.received',
  DELIVERY_DATE_CHANGED: 'delivery.date.changed',
  PRICE_CHANGED: 'price.changed',
  SHIPMENT_CREATED: 'shipment.created',
  RECEIPT_CREATED: 'receipt.created',
  INVOICE_RECEIVED: 'invoice.received',
  APPROVAL_COMPLETED: 'approval.completed',
  ERP_WRITE_FAILED: 'erp.write.failed',
} as const;

// ---------------------------------------------------------------- ④ 异常类型（统一异常中心）

export const EXCEPTION_TYPES = {
  RFQ_NO_RESPONSE: 'rfq_no_response',
  QUOTE_PARSE_FAILED: 'quote_parse_failed',
  PO_NO_CONFIRMATION: 'po_no_confirmation',
  DELIVERY_DELAY: 'delivery_delay',
  PRICE_VARIANCE: 'price_variance',
  QUANTITY_VARIANCE: 'quantity_variance',
  PARTIAL_SHIPMENT: 'partial_shipment',
  SHORT_RECEIPT: 'short_receipt',
  INVOICE_WITHOUT_PO: 'invoice_without_po',
  DUPLICATE_INVOICE: 'duplicate_invoice',
  THREE_WAY_MISMATCH: 'three_way_mismatch',
  ERP_WRITE_FAILED: 'erp_write_failed',
} as const;

// ---------------------------------------------------------------- ⑤ 审批阈值（规则优先，数据驱动）

export interface ApprovalThreshold {
  /** 自动接受的上限（含） */
  auto: number;
  /** 采购员审批的上限（含）；超过则采购经理审批 */
  buyer: number;
}

export const APPROVAL_THRESHOLDS: Record<string, ApprovalThreshold> = {
  deliveryDelayDays: { auto: 2, buyer: 5 }, // 交期：≤2天自动，3-5天采购员，>5天采购经理
  poPriceVariancePct: { auto: 2, buyer: 5 }, // PO 价格变化：≤2%自动，2-5%采购员，>5%采购经理
  threeWayVariancePct: { auto: 1, buyer: 3 }, // 三单匹配差异：≤1%自动，1-3%财务，>3%采购+财务
};

/** 根据阈值判断审批级别 */
export function approvalLevel(kind: keyof typeof APPROVAL_THRESHOLDS, value: number): 'auto' | 'buyer' | 'manager' | 'finance' {
  const t = APPROVAL_THRESHOLDS[kind]!;
  if (value <= t.auto) return 'auto';
  if (value <= t.buyer) return kind === 'threeWayVariancePct' ? 'finance' : 'buyer';
  return 'manager';
}

/** 检查状态转移是否合法 */
export function canTransition(sm: StateMachine, from: string, to: string): boolean {
  return (sm.transitions[from] ?? []).includes(to);
}

/** 把审批规则 id 映射到统一异常类型（未映射的归为 other） */
export function ruleIdToExceptionType(ruleId: string): string {
  switch (ruleId) {
    case 'delay-over-7d': return EXCEPTION_TYPES.DELIVERY_DELAY;
    case 'price-change': return EXCEPTION_TYPES.PRICE_VARIANCE;
    case 'variance-over': return EXCEPTION_TYPES.THREE_WAY_MISMATCH;
    case 'approve-payable': return 'payable_approval';
    default: return 'other';
  }
}

/** 把业务对象类型映射到生命周期状态机（未知类型返回 undefined = 无状态机约束） */
export function lifecycleStateMachine(type: string): StateMachine | undefined {
  switch (type) {
    case 'po':
    case 'purchase_order':
      return PO_STATE_MACHINE;
    case 'rfq':
      return RFQ_STATE_MACHINE;
    case 'invoice':
      return INVOICE_STATE_MACHINE;
    default:
      return undefined;
  }
}
