/**
 * 采购路径编排器 —— 一个「采购执行员工」内部按业务情况动态路由，
 * 只调用需要的工作流，跳过不需要的步骤（不做固定流水线）。
 *
 * 输入来源：① 采购事件意图识别（DeepSeek intake 输出结构化 intent）
 *          ② 企业事实快照（ERP/邮箱/上下文聚合的 hasPo/hasReceipt/…）
 *
 * 规则（第一版，规则驱动，后续抽成 JSON 规则表）：
 *   供应商拒单          → 返回 RFQ（往前跳）
 *   发票 + PO + 收货    → 三单匹配
 *   发票 + PO + 无收货  → 等待收货
 *   无 PO 的发票        → 异常
 *   已有 PO             → 直接 PO 执行（跳过询价）
 *   合同价有效          → 跳过询价 → 直接 PO
 *   无合格供应商        → 寻源
 *   无有效合同价        → 询价
 */

export type PurchasePathKind = 'requisition' | 'po' | 'invoice' | 'event';

/** 采购事件意图（由 DeepSeek 采购事件识别 worker 输出） */
export type PurchaseIntent = 'supplier_reject' | 'delay' | 'invoice' | 'rfq_quote' | 'other';

export interface PurchasePathInput {
  kind: PurchasePathKind;
  intent?: PurchaseIntent;
  poName?: string;
  poState?: string;
  hasPo?: boolean;
  hasReceipt?: boolean;
  hasInvoice?: boolean;
  hasContractPrice?: boolean;
  contractPriceValid?: boolean;
  hasQualifiedSupplier?: boolean;
  urgent?: boolean;
}

export interface PathDecision {
  /** 入口：从哪条工作流开始 */
  entry: 'rfq' | 'po-execution' | 'invoice-match' | 'sourcing' | 'exception' | 'wait-receipt';
  /** 需要执行的工作流 id 序列 */
  workflows: string[];
  /** 被跳过的步骤 */
  skipped: string[];
  reason: string;
}

export class ProcurementOrchestrator {
  decide(input: PurchasePathInput): PathDecision {
    const skipped: string[] = [];

    // 供应商拒单 → 返回 RFQ（往前跳，不继续 PO）
    if (input.intent === 'supplier_reject' || input.poState === 'rejected') {
      if (input.hasQualifiedSupplier === false) {
        return { entry: 'sourcing', workflows: [], skipped: [], reason: '供应商拒单且无备选合格供应商 → 进入寻源' };
      }
      return { entry: 'rfq', workflows: ['rfq-process'], skipped: ['po-operations'], reason: `供应商拒单${input.poName ? '（' + input.poName + '）' : ''} → 返回询价重新定标` };
    }

    // 发票场景（intent=invoice 或已存在发票）
    if (input.intent === 'invoice' || input.kind === 'invoice' || input.hasInvoice) {
      if (input.hasPo && input.hasReceipt) {
        return { entry: 'invoice-match', workflows: ['invoice-match'], skipped: ['rfq-process', 'po-operations'], reason: '发票 + PO + 收货齐全 → 三单匹配' };
      }
      if (input.hasPo && !input.hasReceipt) {
        return { entry: 'wait-receipt', workflows: [], skipped: ['rfq-process', 'po-operations', 'invoice-match'], reason: '发票已到、货未到 → 等待收货后自动重新匹配' };
      }
      return { entry: 'exception', workflows: [], skipped: [], reason: '无 PO 发票异常 → 提交财务/采购人工审核' };
    }

    // 已有 PO：从 PO 执行开始，跳过询价
    if (input.kind === 'po' || input.hasPo) {
      skipped.push('rfq-process');
      if (input.urgent) {
        return { entry: 'po-execution', workflows: ['po-operations'], skipped, reason: `已有 PO${input.poName ? ' ' + input.poName : ''} → 直接 PO 执行（紧急：高频催交）` };
      }
      return { entry: 'po-execution', workflows: ['po-operations'], skipped, reason: `已有 PO${input.poName ? ' ' + input.poName : ''} → 直接 PO 执行，跳过询价` };
    }

    // 无合格供应商 → 寻源
    if (input.hasQualifiedSupplier === false) {
      return { entry: 'sourcing', workflows: [], skipped: [], reason: '没有合格供应商 → 进入寻源/供应商准入' };
    }

    // 无 PO：判断是否需要询价
    if (input.hasContractPrice && input.contractPriceValid) {
      skipped.push('rfq-process');
      return { entry: 'po-execution', workflows: ['po-operations'], skipped, reason: '框架合同价有效 → 跳过询价，直接创建 PO 执行' };
    }

    // 默认：需要询价
    return { entry: 'rfq', workflows: ['rfq-process'], skipped: [], reason: '无有效合同价 → 进入询价比价' };
  }
}

/** 把「采购事件意图」（DeepSeek 输出）映射成路径编排器的输入事实 */
export function intentToPathInput(intent: PurchaseIntent, extra: Partial<PurchasePathInput> = {}): PurchasePathInput {
  switch (intent) {
    case 'supplier_reject':
      return { kind: 'po', intent, hasPo: true, hasQualifiedSupplier: extra.hasQualifiedSupplier ?? true, ...extra };
    case 'invoice': {
      // 有单号即视为存在 PO；收货状态由 ERP 事实快照提供（缺省按已收货 → 三单匹配）
      const hasPo = extra.hasPo ?? Boolean(extra.poName);
      return { kind: 'invoice', intent, hasInvoice: true, hasPo, hasReceipt: extra.hasReceipt ?? true, ...extra };
    }
    case 'delay':
      return { kind: 'po', intent, hasPo: true, ...extra };
    case 'rfq_quote':
      return { kind: 'requisition', intent, hasPo: false, ...extra };
    default:
      return { kind: 'event', intent, ...extra };
  }
}
