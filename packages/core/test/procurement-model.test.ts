import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyPurchaseOrderLineQuantityEvent,
  createPurchaseOrderLineQuantityProjection,
  matchPurchaseOrderLine,
} from '@readywork/core';
import type {
  Communication,
  Item,
  LineMatchPolicy,
  ProcurementRequisition,
  PurchaseOrderLine,
  PurchaseOrderLineQuantityEvent,
  RequisitionLine,
  ReceiptLine,
  Supplier,
  SupplierInvoiceLine,
} from '@readywork/core';

const at = '2026-08-21T00:00:00.000Z';

test('采购入口与主数据: Item/Supplier/Requisition/Communication 保留租户和业务证据关联', () => {
  const base = { tenantId: 'tenant:1', sourceSystem: 'manual', status: 'active', createdAt: at, updatedAt: at };
  const item: Item = { ...base, id: 'item:1', externalId: 'SKU-1', sku: 'SKU-1', name: '轴承', uom: 'EA' };
  const supplier: Supplier = {
    ...base,
    id: 'supplier:1',
    externalId: 'SUP-1',
    name: '供应商 A',
    currency: 'CNY',
    contacts: [{ id: 'contact:1', name: '张三', email: 'buyer@example.com', primary: true }],
  };
  const requisition: ProcurementRequisition = {
    ...base,
    id: 'req:1',
    externalId: 'REQ-1',
    source: 'excel',
    requesterId: 'human:1',
    requestedAt: at,
  };
  const line: RequisitionLine = {
    id: 'req-line:1', requisitionId: requisition.id, lineNumber: '10', itemId: item.id, uom: 'EA',
    requestedQty: 50, requiredAt: at, technicalRequirements: '耐高温', attachmentIds: ['attachment:1'],
  };
  const communication: Communication = {
    ...base,
    id: 'comm:1',
    externalId: 'mail:1',
    businessObjectId: requisition.id,
    businessObjectType: 'requisition',
    supplierId: supplier.id,
    channel: 'email',
    direction: 'outbound',
    messageId: '<mail-1@example.com>',
    subject: '询价',
    body: '请报价',
    attachmentIds: line.attachmentIds,
    occurredAt: at,
  };
  assert.equal(supplier.contacts[0]?.primary, true);
  assert.equal(requisition.source, 'excel');
  assert.equal(line.requisitionId, requisition.id);
  assert.equal(communication.businessObjectId, requisition.id);
});

function poLine(overrides: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return {
    id: 'po-line:1',
    poId: 'po:1',
    awardLineId: 'award-line:1',
    quoteLineId: 'quote-line:1',
    rfqLineId: 'rfq-line:1',
    lineNumber: '10',
    itemId: 'item:1',
    uom: 'EA',
    orderedQty: 100,
    unitPrice: 10,
    currency: 'CNY',
    ...overrides,
  };
}

function event(overrides: Partial<PurchaseOrderLineQuantityEvent> = {}): PurchaseOrderLineQuantityEvent {
  return {
    tenantId: 'tenant:1',
    sourceSystem: 'odoo',
    sourceEventId: 'event:1',
    poLineId: 'po-line:1',
    dimension: 'confirmed',
    delta: 100,
    occurredAt: at,
    ...overrides,
  };
}

test('PO 行数量投影: 连续累计、原投影不可变、同一来源事件幂等', () => {
  const initial = createPurchaseOrderLineQuantityProjection(poLine(), 'tenant:1');
  const confirmed = applyPurchaseOrderLineQuantityEvent(initial, event());
  assert.equal(confirmed.applied, true);
  assert.equal(initial.confirmedQty, 0);
  assert.equal(confirmed.projection.confirmedQty, 100);
  assert.equal(confirmed.projection.events.length, 1);

  const duplicate = applyPurchaseOrderLineQuantityEvent(confirmed.projection, event());
  assert.equal(duplicate.applied, false, 'tenant+sourceSystem+sourceEventId 相同即视为重复，不能重复累计');
  assert.strictEqual(duplicate.projection, confirmed.projection);
  assert.throws(
    () => applyPurchaseOrderLineQuantityEvent(confirmed.projection, event({ delta: 50 })),
    /幂等键已被不同载荷使用/,
  );
  assert.throws(
    () => applyPurchaseOrderLineQuantityEvent(confirmed.projection, event({ occurredAt: '2026-08-21T00:00:01.000Z' })),
    /幂等键已被不同载荷使用/,
  );

  const shipped = applyPurchaseOrderLineQuantityEvent(confirmed.projection, event({ sourceEventId: 'event:2', dimension: 'shipped', delta: 80 }));
  const received = applyPurchaseOrderLineQuantityEvent(shipped.projection, event({ sourceEventId: 'event:3', dimension: 'received', delta: 70 }));
  const invoiced = applyPurchaseOrderLineQuantityEvent(received.projection, event({ sourceEventId: 'event:4', dimension: 'invoiced', delta: 65 }));
  assert.deepEqual(
    [invoiced.projection.confirmedQty, invoiced.projection.shippedQty, invoiced.projection.receivedQty, invoiced.projection.invoicedQty],
    [100, 80, 70, 65],
  );
});

test('PO 行数量投影: 允许安全冲销，拒绝负累计、跨租户、跨行和超累计', () => {
  let projection = createPurchaseOrderLineQuantityProjection(poLine(), 'tenant:1');
  projection = applyPurchaseOrderLineQuantityEvent(projection, event()).projection;
  projection = applyPurchaseOrderLineQuantityEvent(projection, event({ sourceEventId: 'event:2', dimension: 'shipped', delta: 80 })).projection;
  projection = applyPurchaseOrderLineQuantityEvent(projection, event({ sourceEventId: 'event:3', dimension: 'shipped', delta: -20 })).projection;
  assert.equal(projection.shippedQty, 60);

  assert.throws(() => applyPurchaseOrderLineQuantityEvent(projection, event({ sourceEventId: 'negative', dimension: 'shipped', delta: -61 })), /非负/);
  assert.throws(() => applyPurchaseOrderLineQuantityEvent(projection, event({ sourceEventId: 'cancel-over', dimension: 'cancelled', delta: 101 })), /不能超过订购/);
  assert.throws(() => applyPurchaseOrderLineQuantityEvent(projection, event({ sourceEventId: 'tenant', tenantId: 'tenant:2' })), /租户不一致/);
  assert.throws(() => applyPurchaseOrderLineQuantityEvent(projection, event({ sourceEventId: 'line', poLineId: 'po-line:2' })), /PO 行不一致/);
  assert.throws(() => applyPurchaseOrderLineQuantityEvent(projection, event({ sourceEventId: 'zero', delta: 0 })), /非零有限数/);
});

test('PO 行数量投影: 发票先到、无发货先收货均记录事实并派生 issue', () => {
  let projection = createPurchaseOrderLineQuantityProjection(poLine(), 'tenant:1');
  const invoicedFirst = applyPurchaseOrderLineQuantityEvent(projection, event({ sourceEventId: 'invoice-first', dimension: 'invoiced', delta: 20 }));
  projection = invoicedFirst.projection;
  assert.equal(projection.invoicedQty, 20);
  assert.ok(invoicedFirst.issues.some((issue) => issue.code === 'invoiced_exceeds_received'));

  const receiptWithoutShipment = applyPurchaseOrderLineQuantityEvent(projection, event({ sourceEventId: 'receipt-no-asn', dimension: 'received', delta: 25 }));
  projection = receiptWithoutShipment.projection;
  assert.equal(projection.receivedQty, 25);
  assert.ok(receiptWithoutShipment.issues.some((issue) => issue.code === 'received_exceeds_shipped'));
  assert.ok(!receiptWithoutShipment.issues.some((issue) => issue.code === 'invoiced_exceeds_received'));

  const shippedWithoutConfirmation = applyPurchaseOrderLineQuantityEvent(projection, event({ sourceEventId: 'ship-no-confirm', dimension: 'shipped', delta: 30 }));
  assert.equal(shippedWithoutConfirmation.projection.shippedQty, 30);
  assert.ok(shippedWithoutConfirmation.issues.some((issue) => issue.code === 'shipped_exceeds_confirmed'));
});

const policy: LineMatchPolicy = {
  tolerance: { quantityPercent: 1, unitPricePercent: 1, amountPercent: 1, amountAbsolute: 5 },
  approval: { quantityPercent: 5, unitPricePercent: 5, amountPercent: 5, amountAbsolute: 50 },
};

function receipt(overrides: Partial<ReceiptLine> = {}): ReceiptLine {
  return {
    id: 'receipt-line:1',
    receiptId: 'receipt:1',
    poLineId: 'po-line:1',
    shipmentLineId: 'shipment-line:1',
    lineNumber: '10',
    itemId: 'item:1',
    uom: 'EA',
    receivedQty: 100,
    ...overrides,
  };
}

function invoiceLine(overrides: Partial<SupplierInvoiceLine> = {}): SupplierInvoiceLine {
  return {
    id: 'invoice-line:1',
    invoiceId: 'invoice:1',
    poLineId: 'po-line:1',
    receiptAllocations: [{ receiptLineId: 'receipt-line:1', allocatedQty: 100 }],
    lineNumber: '10',
    itemId: 'item:1',
    uom: 'EA',
    invoicedQty: 100,
    unitPrice: 10,
    netAmount: 1000,
    currency: 'CNY',
    ...overrides,
  };
}

test('行级三单匹配: 完全匹配并分别输出数量/单价/金额/币种差异', () => {
  const result = matchPurchaseOrderLine({ poLine: poLine(), receiptLines: [receipt()], invoiceLine: invoiceLine(), policy });
  assert.equal(result.disposition, 'exact_match');
  assert.equal(result.variances.quantity.difference, 0);
  assert.equal(result.variances.unitPrice.difference, 0);
  assert.equal(result.variances.amount.difference, 0);
  assert.equal(result.variances.currency.matches, true);
});

test('行级三单匹配: 容差内、需审批、严重异常四档分支', () => {
  const within = matchPurchaseOrderLine({
    poLine: poLine(), receiptLines: [receipt()], invoiceLine: invoiceLine({ unitPrice: 10.05, netAmount: 1004 }), policy,
  });
  assert.equal(within.disposition, 'within_tolerance');

  const approval = matchPurchaseOrderLine({
    poLine: poLine(), receiptLines: [receipt()], invoiceLine: invoiceLine({ invoicedQty: 97, unitPrice: 10.3, netAmount: 970 }), policy,
  });
  assert.equal(approval.disposition, 'approval_required');

  const severe = matchPurchaseOrderLine({
    poLine: poLine(), receiptLines: [receipt()], invoiceLine: invoiceLine({ invoicedQty: 80, unitPrice: 12, netAmount: 960 }), policy,
  });
  assert.equal(severe.disposition, 'severe_exception');

  const currency = matchPurchaseOrderLine({
    poLine: poLine(), receiptLines: [receipt()], invoiceLine: invoiceLine({ currency: 'USD' }), policy,
  });
  assert.equal(currency.disposition, 'severe_exception');
  assert.equal(currency.variances.currency.matches, false);
});

test('行级三单匹配: 拒绝断裂关联和倒置阈值', () => {
  assert.throws(
    () => matchPurchaseOrderLine({ poLine: poLine(), receiptLines: [receipt()], invoiceLine: invoiceLine({ poLineId: undefined }), policy }),
    /尚未关联 PO 行/,
  );
  assert.throws(
    () => matchPurchaseOrderLine({ poLine: poLine(), receiptLines: [receipt()], invoiceLine: invoiceLine({ receiptAllocations: undefined }), policy }),
    /尚未分配收货数量/,
  );
  assert.throws(
    () => matchPurchaseOrderLine({ poLine: poLine(), receiptLines: [receipt({ poLineId: 'po-line:other' })], invoiceLine: invoiceLine(), policy }),
    /收货行未关联目标 PO 行/,
  );
  assert.throws(
    () => matchPurchaseOrderLine({
      poLine: poLine(),
      receiptLines: [receipt()],
      invoiceLine: invoiceLine(),
      policy: { ...policy, approval: { ...policy.approval, quantityPercent: 0.5 } },
    }),
    /approval\.quantityPercent/,
  );
});

test('行级三单匹配: 一条 1000 收货可分别匹配 600/400 两张部分发票，单次超分配拒绝', () => {
  const orderLine = poLine({ orderedQty: 1000 });
  const receiptOf1000 = receipt({ receivedQty: 1000 });
  const invoice600 = invoiceLine({
    id: 'invoice-line:600',
    invoiceId: 'invoice:600',
    invoicedQty: 600,
    netAmount: 6000,
    receiptAllocations: [{ receiptLineId: receiptOf1000.id, allocatedQty: 600 }],
  });
  const invoice400 = invoiceLine({
    id: 'invoice-line:400',
    invoiceId: 'invoice:400',
    invoicedQty: 400,
    netAmount: 4000,
    receiptAllocations: [{ receiptLineId: receiptOf1000.id, allocatedQty: 400 }],
  });

  const first = matchPurchaseOrderLine({ poLine: orderLine, receiptLines: [receiptOf1000], invoiceLine: invoice600, policy });
  const second = matchPurchaseOrderLine({ poLine: orderLine, receiptLines: [receiptOf1000], invoiceLine: invoice400, policy });
  assert.equal(first.disposition, 'exact_match');
  assert.equal(first.variances.quantity.expected, 600);
  assert.equal(second.disposition, 'exact_match');
  assert.equal(second.variances.quantity.expected, 400);

  assert.throws(
    () => matchPurchaseOrderLine({
      poLine: orderLine,
      receiptLines: [receiptOf1000],
      invoiceLine: invoiceLine({ invoicedQty: 1001, netAmount: 10010, receiptAllocations: [{ receiptLineId: receiptOf1000.id, allocatedQty: 1001 }] }),
      policy,
    }),
    /历史已分配与本次分配数量之和不能超过/,
  );
  assert.throws(
    () => matchPurchaseOrderLine({
      poLine: orderLine,
      receiptLines: [receiptOf1000],
      invoiceLine: invoiceLine({ receiptAllocations: [{ receiptLineId: receiptOf1000.id, allocatedQty: 0 }] }),
      policy,
    }),
    /必须是正有限数/,
  );
  assert.throws(
    () => matchPurchaseOrderLine({
      poLine: orderLine,
      receiptLines: [receiptOf1000],
      invoiceLine: invoiceLine({ receiptAllocations: [{ receiptLineId: 'receipt-line:missing', allocatedQty: 1 }] }),
      policy,
    }),
    /未对应三单匹配输入中的收货行/,
  );
});

test('行级三单匹配: 历史累计占用与本次分配共同受收货数量上限约束', () => {
  const orderLine = poLine({ orderedQty: 1000 });
  const receiptOf1000 = receipt({ receivedQty: 1000 });
  const current400 = invoiceLine({
    id: 'invoice-line:current-400',
    invoicedQty: 400,
    netAmount: 4000,
    receiptAllocations: [{ receiptLineId: receiptOf1000.id, allocatedQty: 400 }],
  });
  const accepted = matchPurchaseOrderLine({
    poLine: orderLine,
    receiptLines: [receiptOf1000],
    invoiceLine: current400,
    policy,
    previouslyAllocatedQtyByReceiptLineId: { [receiptOf1000.id]: 600 },
  });
  assert.equal(accepted.disposition, 'exact_match');

  assert.throws(
    () => matchPurchaseOrderLine({
      poLine: orderLine,
      receiptLines: [receiptOf1000],
      invoiceLine: invoiceLine({
        id: 'invoice-line:current-500',
        invoicedQty: 500,
        netAmount: 5000,
        receiptAllocations: [{ receiptLineId: receiptOf1000.id, allocatedQty: 500 }],
      }),
      policy,
      previouslyAllocatedQtyByReceiptLineId: { [receiptOf1000.id]: 600 },
    }),
    /历史已分配与本次分配数量之和不能超过/,
  );
  assert.throws(
    () => matchPurchaseOrderLine({
      poLine: orderLine,
      receiptLines: [receiptOf1000],
      invoiceLine: current400,
      policy,
      previouslyAllocatedQtyByReceiptLineId: { [receiptOf1000.id]: -1 },
    }),
    /历史已分配数量必须是非负有限数/,
  );
});
