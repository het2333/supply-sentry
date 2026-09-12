import type {
  GraphNode,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeExecutor,
  NodeTypeDescriptor,
} from '@readywork/graph-runtime';
import {
  analyzeSupplierReply,
  matchPurchaseOrderLine,
  type LineMatchPolicy,
  type PurchaseOrderLine,
  type ReceiptLine,
  type SupplierReplyCommunicationInput,
  type SupplierReplyPoLineInput,
  type SupplierInvoiceLine,
} from '@readywork/core';
import { ProcurementOrchestrator } from './orchestrator.js';

export interface ProcurementNodeExecutorPorts {
  executeConnector?: (descriptor: NodeTypeDescriptor, node: GraphNode, input: Record<string, unknown>, context: NodeExecutionContext) => Promise<NodeExecutionResult>;
  /**
   * AI 节点只在此端口完成推理与结构化输出。任何模型建议的 action
   * 都必须由调用方在 Action Gateway 中单独校验和执行，不能在这里直调工具。
   */
  executeAi?: (descriptor: NodeTypeDescriptor, node: GraphNode, input: Record<string, unknown>, context: NodeExecutionContext) => Promise<NodeExecutionResult>;
}

/** 确定性行级三单匹配节点的输入契约。所有事实均由上游读取/关联节点提供。 */
export interface ProcurementLineMatchInput {
  poLine: PurchaseOrderLine;
  receiptLines: ReceiptLine[];
  invoiceLine: SupplierInvoiceLine;
  policy: LineMatchPolicy;
  previouslyAllocatedQtyByReceiptLineId?: Record<string, number>;
}

const LINE_MATCH_EDGE_LABELS = {
  exact_match: '完全匹配',
  within_tolerance: '容差内',
  approval_required: '需要审批',
  severe_exception: '严重异常',
} as const;

const completed = (descriptor: NodeTypeDescriptor, outputs: Record<string, unknown>, selectedEdgeLabels?: string[]): NodeExecutionResult => ({
  status: 'completed',
  outputs,
  ...(selectedEdgeLabels ? { selectedEdgeLabels } : {}),
  message: `${descriptor.name}执行完成`,
});

function procurementRoute(input: Record<string, unknown>): { decision: Record<string, unknown>; labels: string[] } {
  const decision = new ProcurementOrchestrator().decide({
    kind: String(input['kind'] ?? 'event') as 'requisition' | 'po' | 'invoice' | 'event',
    intent: input['intent'] ? String(input['intent']) as 'supplier_reject' | 'delay' | 'invoice' | 'rfq_quote' | 'other' : undefined,
    poName: input['poName'] ? String(input['poName']) : undefined,
    hasPo: Boolean(input['hasPo']),
    hasReceipt: Boolean(input['hasReceipt']),
    hasInvoice: Boolean(input['hasInvoice']),
    hasContractPrice: Boolean(input['hasContractPrice']),
    contractPriceValid: Boolean(input['contractPriceValid']),
    hasQualifiedSupplier: input['hasQualifiedSupplier'] === undefined ? undefined : Boolean(input['hasQualifiedSupplier']),
    urgent: Boolean(input['urgent']),
  }) as unknown as Record<string, unknown>;
  const labels = ({
    rfq: ['无有效价格', '重新定标'],
    'po-execution': ['已有 PO'],
    'invoice-match': ['发票已到', '收货后重匹配'],
    'wait-receipt': ['发票到、货未到'],
    sourcing: ['供应商拒单'],
    exception: ['异常'],
  } as Record<string, string[]>)[String(decision['entry'])] ?? [];
  return { decision, labels };
}

function builtInAi(descriptor: NodeTypeDescriptor, input: Record<string, unknown>): NodeExecutionResult {
  if (descriptor.type === 'ai.delivery_date_extract') {
    const text = String(input['text'] ?? input['body'] ?? '');
    const promiseDate = text.match(/\b(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})\b/)?.[1]?.replace(/[/.]/g, '-');
    return completed(descriptor, { promise_date: promiseDate ?? null, confidence: promiseDate ? 0.9 : 0 });
  }
  if (descriptor.type === 'ai.three_way_match') {
    // Legacy compatibility only. 新图必须使用 business.procurement_line_match，
    // 以获得 PO/收货/发票的行级关联与历史累计约束。
    const poAmount = Number(input['poAmount'] ?? 0);
    const invoiceAmount = Number(input['invoiceAmount'] ?? 0);
    const variancePct = poAmount ? ((invoiceAmount - poAmount) / poAmount) * 100 : 0;
    return completed(descriptor, { matched: Math.abs(variancePct) <= 1, variancePct });
  }
  if (descriptor.type === 'ai.quote_recommend') {
    const quotes = Array.isArray(input['quotes']) ? input['quotes'] as Array<Record<string, unknown>> : [];
    const ranked = [...quotes].sort((a, b) => Number(a['price'] ?? Number.MAX_SAFE_INTEGER) - Number(b['price'] ?? Number.MAX_SAFE_INTEGER));
    return completed(descriptor, { recommendation: ranked[0] ?? null, ranked });
  }
  if (descriptor.type === 'ai.supplier_reply_parse') {
    const message = objectOrUndefined(input['message']);
    const text = String(input['text'] ?? input['body'] ?? message?.['body'] ?? (typeof input['message'] === 'string' ? input['message'] : ''));
    const analysis = analyzeSupplierReply({
      communication: {
        body: text,
        id: optionalText(message?.['id'] ?? input['communicationId']),
        receivedAt: optionalText(message?.['receivedAt'] ?? input['receivedAt']),
      },
      earlierCommunications: supplierReplyCommunications(input['earlierCommunications']),
      poLines: supplierReplyPoLines(input['poLines'] ?? input['lines']),
      referenceYear: optionalFiniteNumber(input['referenceYear']),
    });
    const intent = analysis.intent === 'supplier_reject'
      ? 'supplier_reject'
      : analysis.intent === 'delay'
        ? 'delay'
        : analysis.intent === 'confirmation' || analysis.intent === 'partial_confirmation'
          ? 'confirmed'
          : 'other';
    return completed(descriptor, { intent, facts: analysis });
  }
  return completed(descriptor, { capability: descriptor.type, input });
}

function lineMatch(descriptor: NodeTypeDescriptor, input: Record<string, unknown>): NodeExecutionResult {
  try {
    const poLine = recordInput(input, 'poLine') as unknown as PurchaseOrderLine;
    const invoiceLine = recordInput(input, 'invoiceLine') as unknown as SupplierInvoiceLine;
    const policy = recordInput(input, 'policy') as unknown as LineMatchPolicy;
    if (!Array.isArray(input['receiptLines'])) throw new Error('行级三单匹配缺少 receiptLines 数组');
    const receiptLines = input['receiptLines'] as ReceiptLine[];
    const historical = input['previouslyAllocatedQtyByReceiptLineId'];
    if (historical !== undefined && (!historical || typeof historical !== 'object' || Array.isArray(historical))) {
      throw new Error('行级三单匹配的历史已分配数量必须是对象');
    }
    const result = matchPurchaseOrderLine({
      poLine,
      receiptLines,
      invoiceLine,
      policy,
      ...(historical === undefined ? {} : { previouslyAllocatedQtyByReceiptLineId: historical as Record<string, number> }),
    });
    return completed(descriptor, {
      result,
      variances: result.variances,
      allocations: result.receiptAllocations,
      disposition: result.disposition,
    }, [LINE_MATCH_EDGE_LABELS[result.disposition]]);
  } catch (error) {
    return {
      status: 'failed',
      outputs: {},
      message: `行级三单匹配失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function recordInput(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`行级三单匹配缺少 ${key} 对象`);
  return value as Record<string, unknown>;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function supplierReplyCommunications(value: unknown): SupplierReplyCommunicationInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectOrUndefined(item);
    const body = optionalText(record?.['body']);
    if (!body) return [];
    return [{ body, id: optionalText(record?.['id']), receivedAt: optionalText(record?.['receivedAt']) }];
  });
}

function supplierReplyPoLines(value: unknown): SupplierReplyPoLineInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectOrUndefined(item);
    const poLineId = optionalText(record?.['poLineId'] ?? record?.['id']);
    const orderedQty = optionalFiniteNumber(record?.['orderedQty']);
    if (!poLineId || orderedQty === undefined || orderedQty <= 0) return [];
    return [{
      poLineId,
      orderedQty,
      poUnitPrice: optionalFiniteNumber(record?.['poUnitPrice'] ?? record?.['unitPrice']) ?? null,
      requestedAt: optionalText(record?.['requestedAt']) ?? null,
      description: optionalText(record?.['description']),
      itemId: optionalText(record?.['itemId']),
      uom: optionalText(record?.['uom']),
    }];
  });
}

/**
 * 领域能力包向通用 NodeFactory 提供执行器。执行引擎无需知道采购节点类型。
 */
export function procurementNodeExecutorResolver(ports: ProcurementNodeExecutorPorts = {}): (descriptor: NodeTypeDescriptor) => NodeExecutor {
  return (descriptor) => ({
    async execute(node, input, context) {
      if (descriptor.runtime === 'connector') {
        if (!ports.executeConnector) return { status: 'failed', outputs: {}, message: `连接器执行端口未配置: ${descriptor.executor}` };
        return ports.executeConnector(descriptor, node, input, context);
      }
      if (descriptor.category === 'ai') return ports.executeAi ? ports.executeAi(descriptor, node, input, context) : builtInAi(descriptor, input);
      if (descriptor.type === 'business.procurement_path_router') {
        const { decision, labels } = procurementRoute(input);
        return completed(descriptor, { decision }, labels);
      }
      if (descriptor.type === 'business.procurement_line_match') return lineMatch(descriptor, input);
      if (descriptor.type === 'logic.condition') {
        if (input['delayDays'] !== undefined || input['days'] !== undefined) {
          const days = Number(input['delayDays'] ?? input['days'] ?? 0);
          return completed(descriptor, { result: days <= 2, delayDays: days }, [days <= 2 ? '自动接受' : '需审批']);
        }
        if (input['quantityMatched'] !== undefined) {
          const matched = Boolean(input['quantityMatched']);
          return completed(descriptor, { result: matched }, [matched ? '数量一致' : '数量异常']);
        }
        const value = input['value'] ?? input['condition'] ?? input['result'];
        return completed(descriptor, { result: Boolean(value) }, [Boolean(value) ? 'true' : 'false']);
      }
      if (descriptor.type === 'business.action') return completed(descriptor, { result: input['result'] ?? input['value'] ?? true, nodeType: descriptor.type, executedAt: new Date().toISOString() });
      return completed(descriptor, { nodeType: descriptor.type, executedAt: new Date().toISOString() });
    },
  });
}
