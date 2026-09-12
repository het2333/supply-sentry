import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OdooErpClient, purchaseOrderDraftOrigin } from '../src/odoo.js';

type RpcRequest = { model: string; method: string; body: Record<string, unknown> };

function installFakeOdoo(handler: (request: RpcRequest) => unknown | Promise<unknown>): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const [, model, method] = String(input).match(/\/json\/2\/([^/]+)\/([^/?]+)$/) ?? [];
    const result = await handler({ model: decodeURIComponent(model ?? ''), method: decodeURIComponent(method ?? ''), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

const client = () => new OdooErpClient({ baseUrl: 'https://odoo.example.test', database: 'demo', apiKey: 'secret-api-key', timeoutMs: 100 });
const input = { correlationKey: 'award-42', partnerId: 'odoo-7', currencyCode: 'cny', lines: [{ itemCode: 'M6', quantity: 10, priceUnit: 2.5, description: 'M6 螺栓', datePlanned: '2026-09-01T08:30:00.000Z' }] };

test('创建 PO 草稿会解析产品/UoM/币种并在写后读取核验', async () => {
  let createdVals: Record<string, unknown> | undefined;
  let order: Record<string, unknown> | undefined;
  const restore = installFakeOdoo(({ model, method, body }) => {
    if (model === 'purchase.order' && method === 'search_read') return order ? [order] : [];
    if (model === 'res.partner' && method === 'search_read') return [{ id: 7, name: '供应商 A', active: true, supplier_rank: 1 }];
    if (model === 'product.product' && method === 'search_read') return [{ id: 51, display_name: 'M6 螺栓', uom_po_id: [3, '件'] }];
    if (model === 'res.currency' && method === 'search_read') return [{ id: 1, name: 'CNY' }];
    if (model === 'purchase.order' && method === 'create') {
      createdVals = body.vals as Record<string, unknown>;
      order = { id: 88, name: 'P00088', origin: createdVals.origin, partner_id: [7, '供应商 A'], currency_id: [1, 'CNY'], state: 'draft', order_line: [901] };
      return 88;
    }
    return [];
  });
  try {
    const result = await client().createPurchaseOrderDraft(input);
    assert.deepEqual(result, { id: 88, name: 'P00088', origin: purchaseOrderDraftOrigin('award-42'), partnerId: 7, currencyId: 1, state: 'draft', lineCount: 1, replayed: false });
    assert.equal(createdVals?.origin, 'readywork:award-42');
    assert.equal(createdVals?.partner_id, 7);
    assert.equal(createdVals?.state, 'draft');
    assert.deepEqual(createdVals?.order_line, [[0, 0, { product_id: 51, product_uom: 3, product_qty: 10, price_unit: 2.5, name: 'M6 螺栓', date_planned: '2026-09-01 08:30:00' }]]);
  } finally { restore(); }
});

test('同一 correlationKey 返回已有草稿且不重新创建', async () => {
  let creates = 0;
  const restore = installFakeOdoo(({ model, method, body }) => {
    if (model === 'purchase.order' && method === 'search_read') {
      assert.deepEqual(body.domain, [['origin', '=', 'readywork:award-42']]);
      return [{ id: 88, name: 'P00088', origin: 'readywork:award-42', partner_id: [7, '供应商 A'], currency_id: [1, 'CNY'], state: 'draft', order_line: [901] }];
    }
    if (model === 'purchase.order' && method === 'create') creates += 1;
    return [];
  });
  try {
    const result = await client().createPurchaseOrderDraft(input);
    assert.equal(result.replayed, true);
    assert.equal(creates, 0);
  } finally { restore(); }
});

test('产品编码无法映射时不创建 PO 草稿', async () => {
  let creates = 0;
  const restore = installFakeOdoo(({ model, method }) => {
    if (model === 'purchase.order' && method === 'search_read') return [];
    if (model === 'res.partner' && method === 'search_read') return [{ id: 7, name: '供应商 A', active: true, supplier_rank: 1 }];
    if (model === 'product.product' && method === 'search_read') return [];
    if (model === 'purchase.order' && method === 'create') creates += 1;
    return [];
  });
  try {
    await assert.rejects(() => client().createPurchaseOrderDraft(input), /未找到可采购产品编码: M6/);
    assert.equal(creates, 0);
  } finally { restore(); }
});

test('创建请求超时后只按 correlation 对账，找到草稿即重放返回', async () => {
  let createCalls = 0;
  let visibleAfterTimeout = false;
  const restore = installFakeOdoo(({ model, method }) => {
    if (model === 'purchase.order' && method === 'search_read') {
      return visibleAfterTimeout ? [{ id: 88, name: 'P00088', origin: 'readywork:award-42', partner_id: [7, '供应商 A'], currency_id: [1, 'CNY'], state: 'draft', order_line: [901] }] : [];
    }
    if (model === 'res.partner') return [{ id: 7, name: '供应商 A', active: true, supplier_rank: 1 }];
    if (model === 'product.product') return [{ id: 51, display_name: 'M6 螺栓', uom_po_id: [3, '件'] }];
    if (model === 'res.currency') return [{ id: 1, name: 'CNY' }];
    if (model === 'purchase.order' && method === 'create') { createCalls += 1; visibleAfterTimeout = true; throw new Error('request timed out'); }
    return [];
  });
  try {
    const result = await client().createPurchaseOrderDraft(input);
    assert.equal(result.replayed, true);
    assert.equal(createCalls, 1);
  } finally { restore(); }
});

test('创建后读取结果不满足 origin/partner/state/行数时失败', async () => {
  let created = false;
  const restore = installFakeOdoo(({ model, method }) => {
    if (model === 'purchase.order' && method === 'search_read') return created ? [{ id: 88, name: 'P00088', origin: 'readywork:award-42', partner_id: [8, '错误供应商'], currency_id: [1, 'CNY'], state: 'draft', order_line: [901] }] : [];
    if (model === 'res.partner') return [{ id: 7, name: '供应商 A', active: true, supplier_rank: 1 }];
    if (model === 'product.product') return [{ id: 51, uom_po_id: [3, '件'] }];
    if (model === 'res.currency') return [{ id: 1, name: 'CNY' }];
    if (model === 'purchase.order' && method === 'create') { created = true; return 88; }
    return [];
  });
  try { await assert.rejects(() => client().createPurchaseOrderDraft(input), /写入核验不一致/); } finally { restore(); }
});
