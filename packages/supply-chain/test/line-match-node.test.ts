import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  LineMatchPolicy,
  PurchaseOrderLine,
  ReceiptLine,
  SupplierInvoiceLine,
} from '@readywork/core';
import type { NodeExecutionResult } from '@readywork/graph-runtime';
import { createProcurementNodeFactory, procurementNodeAsset, procurementNodeExecutorResolver } from '@readywork/supply-chain';

const policy: LineMatchPolicy = {
  tolerance: { quantityPercent: 1, unitPricePercent: 1, amountPercent: 1, amountAbsolute: 5 },
  approval: { quantityPercent: 5, unitPricePercent: 5, amountPercent: 5, amountAbsolute: 50 },
};

function poLine(overrides: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return { id: 'po-line:1', poId: 'po:1', lineNumber: '10', itemId: 'item:1', uom: 'EA', orderedQty: 100, unitPrice: 10, currency: 'CNY', ...overrides };
}

function receiptLine(overrides: Partial<ReceiptLine> = {}): ReceiptLine {
  return { id: 'receipt-line:1', receiptId: 'receipt:1', poLineId: 'po-line:1', lineNumber: '10', itemId: 'item:1', uom: 'EA', receivedQty: 100, ...overrides };
}

function invoiceLine(overrides: Partial<SupplierInvoiceLine> = {}): SupplierInvoiceLine {
  return {
    id: 'invoice-line:1', invoiceId: 'invoice:1', poLineId: 'po-line:1', receiptAllocations: [{ receiptLineId: 'receipt-line:1', allocatedQty: 100 }],
    lineNumber: '10', itemId: 'item:1', uom: 'EA', invoicedQty: 100, unitPrice: 10, netAmount: 1000, currency: 'CNY', ...overrides,
  };
}

async function execute(input: Record<string, unknown>): Promise<NodeExecutionResult> {
  const asset = procurementNodeAsset('b:line-threeway')!;
  const factory = createProcurementNodeFactory(procurementNodeExecutorResolver());
  return factory.create({ id: 'match:line', type: asset.descriptor.type, typeVersion: asset.descriptor.version, name: asset.descriptor.name }).execute(
    { id: 'match:line', type: asset.descriptor.type, typeVersion: asset.descriptor.version, name: asset.descriptor.name },
    input,
    { tenantId: 't:1', employeeId: 'ai:procurement', workflowId: 'wf:invoice', workflowVersionId: 'v1', runId: 'run:1', nodeRunId: 'node:1', mode: 'autonomous', variables: input, credentials: {} },
  );
}

test('行级三单匹配节点: 精确、容差内、需审批、严重异常映射到稳定分支', async () => {
  const cases: Array<{ name: string; invoice: SupplierInvoiceLine; label: string }> = [
    { name: 'exact', invoice: invoiceLine(), label: '完全匹配' },
    { name: 'tolerance', invoice: invoiceLine({ unitPrice: 10.05, netAmount: 1004 }), label: '容差内' },
    { name: 'approval', invoice: invoiceLine({ invoicedQty: 97, unitPrice: 10.3, netAmount: 970 }), label: '需要审批' },
    { name: 'severe', invoice: invoiceLine({ invoicedQty: 80, unitPrice: 12, netAmount: 960 }), label: '严重异常' },
  ];
  for (const item of cases) {
    const result = await execute({ poLine: poLine(), receiptLines: [receiptLine()], invoiceLine: item.invoice, policy });
    assert.equal(result.status, 'completed', item.name);
    assert.deepEqual(result.selectedEdgeLabels, [item.label], item.name);
    assert.equal((result.outputs['result'] as { disposition: string }).disposition, {
      '完全匹配': 'exact_match', '容差内': 'within_tolerance', '需要审批': 'approval_required', '严重异常': 'severe_exception',
    }[item.label]);
  }
});

test('行级三单匹配节点: 支持部分发票与历史收货分配累计', async () => {
  const result = await execute({
    poLine: poLine({ orderedQty: 1000 }),
    receiptLines: [receiptLine({ receivedQty: 1000 })],
    invoiceLine: invoiceLine({ invoicedQty: 400, netAmount: 4000, receiptAllocations: [{ receiptLineId: 'receipt-line:1', allocatedQty: 400 }] }),
    policy,
    previouslyAllocatedQtyByReceiptLineId: { 'receipt-line:1': 600 },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.selectedEdgeLabels, ['完全匹配']);
  assert.deepEqual(result.outputs['allocations'], [{ receiptLineId: 'receipt-line:1', allocatedQty: 400 }]);
});

test('行级三单匹配节点: 未关联 PO 行返回失败，不产生分支或副作用', async () => {
  const result = await execute({ poLine: poLine(), receiptLines: [receiptLine()], invoiceLine: invoiceLine({ poLineId: undefined }), policy });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.outputs, {});
  assert.equal(result.selectedEdgeLabels, undefined);
  assert.match(result.message ?? '', /尚未关联 PO 行/);
});
