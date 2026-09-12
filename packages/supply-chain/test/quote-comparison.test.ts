import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSupplierQuotes, type QuoteComparisonInput } from '../src/quote-comparison.js';

const base = (overrides: Record<string, unknown> = {}) => ({ supplierId: 's1', supplierName: '供应商1', unitPrice: 18, priceBasisQuantity: 1, quantity: 100, uom: '件', currency: 'CNY', taxIncluded: false, taxRate: 0.13, moq: 1, leadTimeDays: 10, oneTimeCharges: [], freight: 0, paymentTerms: 'Net 30', performance: { score: 90 }, validUntil: '2026-12-31', ...overrides });
const input = (quotes: Record<string, unknown>[], overrides: Partial<QuoteComparisonInput> = {}): QuoteComparisonInput => ({ quotes: quotes as never[], purchaseQuantity: 100, uom: '件', comparisonCurrency: 'CNY', asOf: '2026-08-21', rateSnapshot: { version: 'fx-1', rates: { 'USD/CNY': 7.2 } }, weights: { price: 0.5, leadTime: 0.2, paymentTerms: 0.1, performance: 0.2 }, ruleVersion: 'quote-v1', ...overrides });

test('按价格基准数量归一化：18元/件等于1800元/100件', () => {
  const result = compareSupplierQuotes(input([base(), base({ supplierId: 's2', unitPrice: 1800, priceBasisQuantity: 100 })]));
  assert.equal(result.quotes[0]!.unitPriceUntaxed, result.quotes[1]!.unitPriceUntaxed);
  assert.equal(result.quotes[0]!.totalCost, result.quotes[1]!.totalCost);
});

test('汇率、税和一次性模具费均纳入可解释总成本', () => {
  const result = compareSupplierQuotes(input([base({ supplierId: 'usd', unitPrice: 10, currency: 'USD', taxIncluded: true, taxRate: 0.1, oneTimeCharges: [{ kind: 'tooling', amount: 1000 }], freight: 20 })]));
  const quote = result.quotes[0]!;
  assert.equal(quote.unitPriceUntaxed, 10 / 1.1 * 7.2);
  assert.equal(quote.oneTimeCharges[0]!.amount, 7200);
  assert.equal(quote.totalCost, (10 / 1.1 * 100 + 1000 + 20) * 7.2);
  assert.equal(result.rateSnapshotVersion, 'fx-1');
});

test('MOQ 不满足和报价过期不可推荐，且排序稳定', () => {
  const result = compareSupplierQuotes(input([base({ supplierId: 'z', moq: 200 }), base({ supplierId: 'a', validUntil: '2026-08-20' }), base({ supplierId: 'b' })]));
  assert.equal(result.recommendedSupplierId, 'b');
  assert.deepEqual(result.quotes.map((quote) => [quote.supplierId, quote.eligibility]), [['b', 'eligible'], ['a', 'expired'], ['z', 'moq_not_met']]);
  assert.match(result.quotes[1]!.reason, /过期/);
});

test('未说明含税状态的报价明确进入税务复核，不能参与排序或推荐', () => {
  const result = compareSupplierQuotes(input([
    base({ supplierId: 'known', taxIncluded: false }),
    base({ supplierId: 'unknown', taxIncluded: undefined }),
  ]));
  const unknown = result.quotes.find((quote) => quote.supplierId === 'unknown')!;
  assert.equal(unknown.taxStatus, 'unknown');
  assert.equal(unknown.taxReviewRequired, true);
  assert.equal(unknown.eligibility, 'tax_review_required');
  assert.equal(unknown.unitPriceUntaxed, null);
  assert.equal(unknown.unitPriceTaxIncluded, null);
  assert.equal(unknown.totalCost, null);
  assert.equal(unknown.rank, null);
  assert.equal(result.recommendedSupplierId, 'known');
  assert.match(unknown.reason, /未说明.*含税.*未税|税务复核/);
});

test('缺少汇率、单位规则或必填数值时明确失败', () => {
  assert.throws(() => compareSupplierQuotes(input([base({ currency: 'EUR' })])), /缺少汇率/);
  assert.throws(() => compareSupplierQuotes(input([base({ uom: '箱' })])), /无转换规则/);
  assert.throws(() => compareSupplierQuotes(input([base({ unitPrice: undefined })])), /unitPrice/);
  assert.throws(() => compareSupplierQuotes(input([base({ priceBasisQuantity: 0 })])), /priceBasisQuantity/);
  assert.throws(() => compareSupplierQuotes(input([base({ taxRate: 13 })])), /taxRate/);
  assert.throws(() => compareSupplierQuotes(input([base({ quantity: 0 })])), /quantity/);
});

test('报价数量不足会淘汰，账期越长分数越高，付款语义可解释', () => {
  const result = compareSupplierQuotes(input([
    base({ supplierId: 'short', quantity: 50, paymentTerms: '月结30天' }),
    base({ supplierId: 'long', paymentTerms: '月结60天', leadTimeDays: 12 }),
    base({ supplierId: 'partial', paymentTerms: '预付30%' }),
  ], { weights: { price: 0, leadTime: 0, paymentTerms: 1, performance: 0 } }));
  const short = result.quotes.find((quote) => quote.supplierId === 'short')!;
  const long = result.quotes.find((quote) => quote.supplierId === 'long')!;
  const partial = result.quotes.find((quote) => quote.supplierId === 'partial')!;
  assert.equal(short.eligibility, 'quoted_quantity_insufficient');
  assert.equal(long.scores.paymentTerms, 100);
  assert.equal(partial.paymentTermsNote, '部分预付 30%，其余账期按报价原文处理');
  assert.match(result.recommendationReason, /总拥有成本.*交期.*账期.*最低成本/);
});

test('权重与版本被原样记录，同分按供应商 ID 可复现', () => {
  const result = compareSupplierQuotes(input([base({ supplierId: 'b' }), base({ supplierId: 'a' })], { weights: { price: 1, leadTime: 0, paymentTerms: 0, performance: 0 } }));
  assert.deepEqual(result.quotes.map((quote) => quote.supplierId), ['a', 'b']);
  assert.equal(result.ruleVersion, 'quote-v1');
});

test('比价结果保留不可变 Quote 和 Quote Line 引用', () => {
  const result = compareSupplierQuotes(input([base({ supplierId: 'traceable', quoteId: 'quote:1', quoteLineId: 'quote-line:1' })]));
  assert.equal(result.quotes[0]?.quoteId, 'quote:1');
  assert.equal(result.quotes[0]?.quoteLineId, 'quote-line:1');
});
