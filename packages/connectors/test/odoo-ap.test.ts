import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OdooErpClient } from '../src/odoo.js';

type RpcRequest = { model: string; method: string; body: Record<string, unknown> };

function installFakeOdoo(handler: (request: RpcRequest) => unknown | Promise<unknown>): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const [, model, method] = url.match(/\/json\/2\/([^/]+)\/([^/?]+)$/) ?? [];
    const request = { model: decodeURIComponent(model ?? ''), method: decodeURIComponent(method ?? ''), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    const result = await handler(request);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

const client = () => new OdooErpClient({ baseUrl: 'https://odoo.example.test', database: 'demo', apiKey: 'secret-api-key', timeoutMs: 100 });

test('采购订单只读同步解析 Incoterm、目的地址与收货操作类型', async () => {
  let requestedFields: string[] = [];
  const restore = installFakeOdoo(({ model, method, body }) => {
    if (model === 'purchase.order' && method === 'search_read') {
      requestedFields = body.fields as string[];
      return [{
        id: 20, name: 'P00011', partner_id: [7, '供应商 A'], date_order: '2026-08-01 09:00:00',
        date_approve: '2026-08-01 09:05:00',
        amount_total: 113, amount_untaxed: 100, state: 'purchase', currency_id: [1, 'CNY'], order_line: [201],
        incoterm_id: [5, 'FOB'], incoterm_location: 'Shanghai Port', dest_address_id: [18, '上海工厂'],
        picking_type_id: [2, 'My Company: 收据'],
      }];
    }
    if (model === 'purchase.order.line' && method === 'search_read') return [{ id: 201, product_id: [55, 'M6 螺钉'], product_qty: 10, product_uom_id: [1, '件'], price_unit: 10, date_planned: '2026-08-05 00:00:00' }];
    if (model === 'res.partner' && method === 'search_read') return [{ id: 7, email: 'supplier@example.test' }];
    return [];
  });
  try {
    const po = await client().readPO('P00011');
    assert.ok(requestedFields.includes('incoterm_id'));
    assert.ok(requestedFields.includes('date_approve'));
    assert.ok(requestedFields.includes('incoterm_location'));
    assert.ok(requestedFields.includes('dest_address_id'));
    assert.ok(requestedFields.includes('picking_type_id'));
    assert.equal(po?.incotermId, 5);
    assert.equal(po?.incotermName, 'FOB');
    assert.equal(po?.incotermLocation, 'Shanghai Port');
    assert.equal(po?.dropshipAddressId, 18);
    assert.equal(po?.dropshipAddressName, '上海工厂');
    assert.equal(po?.deliveryOperationTypeId, 2);
    assert.equal(po?.deliveryOperationTypeName, 'My Company: 收据');
    assert.equal(po?.confirmedAt, '2026-08-01 09:05:00');
  } finally { restore(); }
});

test('读取供应商发票头/行与收货头/行，并关联 PO 行', async () => {
  const restore = installFakeOdoo(async ({ model, method }) => {
    if (model === 'account.move' && method === 'search_read') return [{ id: 10, name: 'BILL/10', partner_id: [7, '供应商 A'], invoice_origin: 'P00011', currency_id: [1, 'CNY'], amount_total: 113, amount_untaxed: 100, state: 'posted', payment_state: 'not_paid', invoice_date: '2026-08-01', invoice_line_ids: [101] }];
    if (model === 'account.move.line') return [{ id: 101, product_id: [55, 'M6 螺钉'], quantity: 10, price_unit: 10, price_subtotal: 100, tax_ids: [3], currency_id: [1, 'CNY'], purchase_line_id: [201, 'PO line'], purchase_order_id: [20, 'P00011'] }];
    if (model === 'stock.picking') return [{ id: 30, name: 'WH/IN/30', origin: 'P00011', state: 'done', scheduled_date: '2026-08-02', date_done: '2026-08-03', move_line_ids: [301] }];
    if (model === 'stock.move.line') return [{ id: 301, product_id: [55, 'M6 螺钉'], quantity: 8, product_uom_id: [1, '件'], move_id: [300, 'move'] }];
    if (model === 'stock.move') return [{ id: 300, purchase_line_id: [201, 'PO line'] }];
    return [];
  });
  try {
    const invoices = await client().listVendorInvoices();
    assert.equal(invoices[0]?.poName, 'P00011');
    assert.equal(invoices[0]?.currency, 'CNY');
    assert.equal(invoices[0]?.lines[0]?.poLineId, 201);
    assert.equal(invoices[0]?.lines[0]?.unitPrice, 10);
    const receipts = await client().listGoodsReceipts();
    assert.equal(receipts[0]?.poName, 'P00011');
    assert.equal(receipts[0]?.lines[0]?.poLineId, 201);
    assert.equal(receipts[0]?.lines[0]?.quantity, 8);
  } finally { restore(); }
});

test('分页遇到重复页会去重并停止，避免重复结果或无限读取', async () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, name: `BILL/${index + 1}`, partner_id: [7, '供应商'], invoice_origin: 'P00011', invoice_line_ids: [], currency_id: [1, 'CNY'] }));
  const restore = installFakeOdoo(({ model, method, body }) => {
    if (model === 'account.move' && method === 'search_read') return Number(body.offset) === 0 ? rows : rows;
    return [];
  });
  try { assert.equal((await client().listVendorInvoices()).length, 200); } finally { restore(); }
});

test('发票和收货缺少可选字段时返回安全默认值', async () => {
  const restore = installFakeOdoo(({ model }) => {
    if (model === 'account.move') return [{ id: 11, invoice_line_ids: [111] }];
    if (model === 'account.move.line') return [{ id: 111 }];
    if (model === 'stock.picking') return [{ id: 31, move_line_ids: [311] }];
    if (model === 'stock.move.line') return [{ id: 311 }];
    return [];
  });
  try {
    const invoice = (await client().listVendorInvoices())[0]!;
    assert.equal(invoice.supplierId, 0);
    assert.equal(invoice.supplierName, '');
    assert.equal(invoice.currency, '');
    assert.equal(invoice.amountTotal, 0);
    assert.equal(invoice.lines[0]?.quantity, 0);
    assert.equal(invoice.lines[0]?.product, '');
    const receipt = (await client().listGoodsReceipts())[0]!;
    assert.equal(receipt.poName, '');
    assert.equal(receipt.lines[0]?.quantity, 0);
    assert.equal(receipt.lines[0]?.unit, '');
  } finally { restore(); }
});

test('只读供应商主数据，按 supplier_rank 分页去重并报告坏行', async () => {
  const firstPage = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, name: `供应商 ${index + 1}`, email: `s${index + 1}@example.test`, phone: null, currency_id: [1, 'CNY'], country_id: [44, '中国'], city: '上海', street: '浦东新区采购路 8 号', street2: '', zip: '200120', active: true }));
  const restore = installFakeOdoo(({ model, method, body }) => {
    if (model === 'res.partner' && method === 'search_read') {
      if (Number(body.offset) === 0) return [...firstPage, { id: 0, name: '无效 ID' }, { id: 202, name: '' }];
      return [...firstPage, { id: 0, name: '重复页' }];
    }
    if (model === 'res.country' && method === 'search_read') return [{ id: 44, code: 'CN', name: '中国' }];
    return [];
  });
  try {
    const result = await client().listSupplierMasters();
    assert.equal(result.items.length, 200);
    assert.equal(result.items[0]?.externalId, 'odoo-partner-1');
    assert.equal(result.items[0]?.contacts[0]?.email, 's1@example.test');
    assert.equal(result.items[0]?.sourceSystem, 'odoo');
    assert.equal(result.items[0]?.countryCode, 'CN');
    assert.equal(result.items[0]?.countryName, '中国');
    assert.equal(result.items[0]?.city, '上海');
    assert.equal(result.items[0]?.street, '浦东新区采购路 8 号');
    assert.equal(result.items[0]?.postalCode, '200120');
    assert.deepEqual(result.issues, [{ row: 200, reason: 'missing_id' }, { row: 201, reason: 'missing_name' }]);
  } finally { restore(); }
});

test('供应商主数据 Odoo fault 与超时错误脱敏', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response('fault api_key=secret-api-key password=hunter2', { status: 500 })) as typeof fetch;
  try { await assert.rejects(() => client().listSupplierMasters(), (error: Error) => !error.message.includes('secret-api-key') && !error.message.includes('hunter2')); } finally { globalThis.fetch = previous; }
  globalThis.fetch = (async () => { throw new Error('timed out token=secret-api-key'); }) as typeof fetch;
  try { await assert.rejects(() => client().listSupplierMasters(), (error: Error) => error.message.includes('[REDACTED]') && !error.message.includes('secret-api-key')); } finally { globalThis.fetch = previous; }
});

test('invoice.update 只写三单白名单，并在写后重新读取核验', async () => {
  let stored: Record<string, unknown> = {};
  const restore = installFakeOdoo(({ model, method, body }) => {
    if (model === 'account.move' && method === 'write') { stored = { ...stored, ...(body.vals as Record<string, unknown>) }; return true; }
    if (model === 'account.move' && method === 'search_read') return [{ id: 10, name: 'BILL/10', partner_id: [7, '供应商'], invoice_origin: 'P00011', currency_id: [1, 'CNY'], invoice_line_ids: [], ...stored }];
    return [];
  });
  try {
    const updated = await client().updateInvoiceMatch(10, { matchResult: 'approval_required', approvalStatus: 'pending', payableStatus: 'hold', holdReason: '金额差异超过容差' });
    assert.equal(stored.readywork_match_result, 'approval_required');
    assert.equal(stored.readywork_payable_status, 'hold');
    assert.equal(updated.id, 10);
    await assert.rejects(() => client().updateInvoice(10, { bankAccount: '123' } as never), /非白名单字段/);
    await assert.rejects(() => client().updateInvoice(10, { matchResult: 'exact_match', bankAccount: '123' } as never), /非白名单字段/);
  } finally { restore(); }
});

test('invoice.update 在运行时拒绝非法状态、发票 ID 与 hold 空原因', async () => {
  const c = client();
  await assert.rejects(() => c.updateInvoiceMatch(0, { matchResult: 'exact_match' }), /正整数/);
  await assert.rejects(() => c.updateInvoiceMatch(10, { matchResult: '任意值' } as never), /matchResult 无效/);
  await assert.rejects(() => c.updateInvoiceMatch(10, { approvalStatus: '绕过审批' } as never), /approvalStatus 无效/);
  await assert.rejects(() => c.updateInvoiceMatch(10, { payableStatus: 'paid' } as never), /payableStatus 无效/);
  await assert.rejects(() => c.updateInvoiceMatch(10, { payableStatus: 'hold' }), /必须提供 holdReason/);
  await assert.rejects(() => c.updateInvoiceMatch(10, { holdReason: ' '.repeat(2) }), /1 到 500/);
  await assert.rejects(() => c.updateInvoiceMatch(10, { holdReason: 'x'.repeat(501) }), /1 到 500/);
});

test('写后核验不一致时失败', async () => {
  const restore = installFakeOdoo(({ model, method }) => {
    if (model === 'account.move' && method === 'search_read') return [{ id: 10, name: 'BILL/10', partner_id: [7, '供应商'], invoice_line_ids: [], readywork_match_result: 'matched' }];
    if (model === 'account.move' && method === 'write') return true;
    return [];
  });
  try { await assert.rejects(() => client().updateInvoiceMatch(10, { matchResult: 'severe_exception' }), /写入核验不一致/); } finally { restore(); }
});

test('Odoo fault、超时错误脱敏且有边界', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response('Odoo fault api_key=secret-api-key password=hunter2', { status: 500 })) as typeof fetch;
  try {
    await assert.rejects(() => client().listVendorInvoices(), (error: Error) => !error.message.includes('secret-api-key') && !error.message.includes('hunter2') && error.message.length <= 500);
  } finally { globalThis.fetch = previous; }

  globalThis.fetch = (async () => { throw new Error('request timed out token=secret-api-key'); }) as typeof fetch;
  try { await assert.rejects(() => client().listVendorInvoices(), (error: Error) => error.message.includes('[REDACTED]') && !error.message.includes('secret-api-key')); } finally { globalThis.fetch = previous; }
});
