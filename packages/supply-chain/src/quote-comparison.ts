export type QuoteChargeKind = 'tooling' | 'packaging' | 'other';

export interface QuoteCharge {
  kind: QuoteChargeKind;
  amount: number;
  description?: string;
}

export interface SupplierPerformance {
  score: number;
}

export interface QuoteInput {
  /** Immutable procurement references carried into the persisted comparison snapshot. */
  quoteId?: string;
  quoteLineId?: string;
  supplierId: string;
  supplierName?: string;
  unitPrice: number;
  priceBasisQuantity: number;
  quantity: number;
  uom: string;
  currency: string;
  /** Omitted means the supplier reply did not state tax treatment. */
  taxIncluded?: boolean;
  taxRate?: number;
  moq?: number;
  leadTimeDays: number;
  oneTimeCharges?: QuoteCharge[];
  freight?: number;
  paymentTerms: string;
  performance?: SupplierPerformance;
  validUntil: string;
}

export interface ExchangeRateSnapshot {
  version: string;
  /** Direct rates, e.g. { 'USD/CNY': 7.2 }. Inverse rates are accepted. */
  rates: Record<string, number>;
}

export interface QuoteComparisonWeights {
  price: number;
  leadTime: number;
  paymentTerms: number;
  performance: number;
}

export interface QuoteComparisonInput {
  quotes: QuoteInput[];
  purchaseQuantity: number;
  uom: string;
  comparisonCurrency: string;
  asOf: string;
  rateSnapshot: ExchangeRateSnapshot;
  weights: QuoteComparisonWeights;
  ruleVersion: string;
}

export type QuoteEligibility = 'eligible' | 'moq_not_met' | 'quoted_quantity_insufficient' | 'expired' | 'tax_review_required';
export type QuoteTaxStatus = 'included' | 'excluded' | 'unknown';

export interface NormalizedQuote {
  quoteId?: string;
  quoteLineId?: string;
  supplierId: string;
  supplierName: string;
  currency: string;
  eligibility: QuoteEligibility;
  reason: string;
  unitPriceUntaxed: number | null;
  unitPriceTaxIncluded: number | null;
  taxStatus: QuoteTaxStatus;
  taxReviewRequired: boolean;
  oneTimeCharges: QuoteCharge[];
  freight: number;
  leadTimeDays: number;
  paymentTerms: string;
  paymentTermsDays: number;
  paymentTermsNote?: string;
  performanceScore?: number;
  totalCost: number | null;
  scores: { price?: number; leadTime?: number; paymentTerms?: number; performance?: number; total?: number };
  rank: number | null;
}

export interface QuoteComparisonResult {
  comparisonCurrency: string;
  purchaseQuantity: number;
  quotes: NormalizedQuote[];
  recommendedSupplierId: string | null;
  recommendationReason: string;
  ruleVersion: string;
  rateSnapshotVersion: string;
}

const DEFAULT_PAYMENT_DAYS = /^(?:net\s*)?(\d+)$/i;

export function compareSupplierQuotes(input: QuoteComparisonInput): QuoteComparisonResult {
  const quantity = positive(input.purchaseQuantity, 'purchaseQuantity');
  const uom = requiredText(input.uom, 'uom');
  const targetCurrency = requiredText(input.comparisonCurrency, 'comparisonCurrency').toUpperCase();
  const asOf = validDate(input.asOf, 'asOf');
  const weights = validateWeights(input.weights);
  if (!requiredText(input.ruleVersion, 'ruleVersion')) throw new Error('ruleVersion 不能为空');
  if (!requiredText(input.rateSnapshot.version, 'rateSnapshot.version')) throw new Error('rateSnapshot.version 不能为空');

  const prepared = input.quotes.map((quote, index) => normalizeQuote(quote, index, quantity, uom, targetCurrency, asOf, input.rateSnapshot, weights));
  const eligible = prepared.filter((quote) => quote.eligibility === 'eligible');
  scoreQuotes(eligible, weights);
  eligible.sort((a, b) => (b.scores.total! - a.scores.total!) || a.supplierId.localeCompare(b.supplierId));
  eligible.forEach((quote, index) => { quote.rank = index + 1; });
  prepared.filter((quote) => quote.eligibility !== 'eligible').forEach((quote) => { quote.rank = null; });
  const ordered = [...eligible, ...prepared.filter((quote) => quote.eligibility !== 'eligible').sort((a, b) => a.supplierId.localeCompare(b.supplierId))];
  const winner = eligible[0];
  const minimumCost = eligible.length ? Math.min(...eligible.map((quote) => quote.totalCost!)) : 0;
  const costDelta = winner && minimumCost > 0 ? ((winner.totalCost! - minimumCost) / minimumCost) * 100 : 0;
  return {
    comparisonCurrency: targetCurrency,
    purchaseQuantity: quantity,
    quotes: ordered,
    recommendedSupplierId: winner?.supplierId ?? null,
    recommendationReason: winner ? `${winner.supplierName} 总分最高（${winner.scores.total!.toFixed(2)}）；总拥有成本 ${winner.totalCost!.toFixed(2)} ${targetCurrency}，交期 ${winner.leadTimeDays} 天，账期 ${winner.paymentTerms}；相对最低成本差异 ${costDelta.toFixed(2)}%。` : `没有满足数量、MOQ 且在有效期内、税务状态明确的报价${prepared.some((quote) => quote.taxReviewRequired) ? '；存在税务状态未知报价，需复核' : ''}`,
    ruleVersion: input.ruleVersion,
    rateSnapshotVersion: input.rateSnapshot.version,
  };
}

function normalizeQuote(quote: QuoteInput, index: number, quantity: number, uom: string, targetCurrency: string, asOf: Date, snapshot: ExchangeRateSnapshot, weights: QuoteComparisonWeights): NormalizedQuote {
  const supplierId = requiredText(quote.supplierId, `quotes[${index}].supplierId`);
  const supplierName = quote.supplierName?.trim() || supplierId;
  if (requiredText(quote.uom, `quotes[${index}].uom`) !== uom) throw new Error(`quotes[${index}].uom 无转换规则`);
  const currency = requiredText(quote.currency, `quotes[${index}].currency`).toUpperCase();
  const basis = positive(quote.priceBasisQuantity, `quotes[${index}].priceBasisQuantity`);
  const quotedQuantity = positive(quote.quantity, `quotes[${index}].quantity`);
  const unitPrice = nonNegative(quote.unitPrice, `quotes[${index}].unitPrice`) / basis;
  const taxRate = quote.taxRate === undefined ? 0 : nonNegative(quote.taxRate, `quotes[${index}].taxRate`);
  if (taxRate > 1) throw new Error(`quotes[${index}].taxRate 必须在 0 到 1 之间`);
  const taxStatus: QuoteTaxStatus = quote.taxIncluded === true ? 'included' : quote.taxIncluded === false ? 'excluded' : 'unknown';
  const untaxed = taxStatus === 'included' ? unitPrice / (1 + taxRate) : taxStatus === 'excluded' ? unitPrice : null;
  const taxIncluded = taxStatus === 'included' ? unitPrice : taxStatus === 'excluded' ? unitPrice * (1 + taxRate) : null;
  const charges = (quote.oneTimeCharges ?? []).map((charge, chargeIndex) => ({ ...charge, amount: nonNegative(charge.amount, `quotes[${index}].oneTimeCharges[${chargeIndex}].amount`) }));
  const freight = nonNegative(quote.freight ?? 0, `quotes[${index}].freight`);
  const moq = quote.moq === undefined ? 0 : positive(quote.moq, `quotes[${index}].moq`);
  const leadTime = nonNegative(quote.leadTimeDays, `quotes[${index}].leadTimeDays`);
  const expiry = validDate(quote.validUntil, `quotes[${index}].validUntil`);
  const baseEligibility: Exclude<QuoteEligibility, 'tax_review_required'> = expiry < asOf ? 'expired' : quotedQuantity < quantity ? 'quoted_quantity_insufficient' : quantity < moq ? 'moq_not_met' : 'eligible';
  const eligibility: QuoteEligibility = taxStatus === 'unknown' ? 'tax_review_required' : baseEligibility;
  const conversion = exchangeRate(currency, targetCurrency, snapshot);
  const totalCost = untaxed === null ? null : conversion * (untaxed * quantity + charges.reduce((sum, charge) => sum + charge.amount, 0) + freight);
  const payment = parsePaymentTerms(quote.paymentTerms, index);
  const performance = quote.performance?.score;
  if (performance !== undefined && (performance < 0 || performance > 100 || !Number.isFinite(performance))) throw new Error(`quotes[${index}].performance.score 必须在 0 到 100`);
  return {
    ...(quote.quoteId ? { quoteId: quote.quoteId } : {}),
    ...(quote.quoteLineId ? { quoteLineId: quote.quoteLineId } : {}),
    supplierId, supplierName, currency, eligibility, reason: eligibilityReason(eligibility, moq, quantity, quotedQuantity, expiry, asOf),
    unitPriceUntaxed: untaxed === null ? null : conversion * untaxed, unitPriceTaxIncluded: taxIncluded === null ? null : conversion * taxIncluded,
    taxStatus, taxReviewRequired: taxStatus === 'unknown', oneTimeCharges: charges.map((charge) => ({ ...charge, amount: conversion * charge.amount })), freight: conversion * freight,
    leadTimeDays: leadTime, paymentTerms: requiredText(quote.paymentTerms, `quotes[${index}].paymentTerms`), paymentTermsDays: payment.days, paymentTermsNote: payment.note, performanceScore: performance,
    totalCost: eligibility === 'eligible' ? totalCost : null,
    scores: {}, rank: null,
  };
}

function scoreQuotes(quotes: NormalizedQuote[], weights: QuoteComparisonWeights): void {
  const dimensions = ['price', 'leadTime', 'paymentTerms', 'performance'] as const;
  const raw = quotes.map((quote) => ({ price: quote.totalCost!, leadTime: quote.leadTimeDays, paymentTerms: quote.paymentTermsDays, performance: quote.performanceScore }));
  const paymentValues = raw.map((value) => value.paymentTerms);
  const leadTimeValues = raw.map((value) => value.leadTime);
  const performanceValues = raw.map((value) => value.performance).filter((value): value is number => value !== undefined);
  const priceValues = raw.map((value) => value.price);
  const maxPrice = Math.max(...priceValues), minPrice = Math.min(...priceValues);
  const paymentMax = Math.max(...paymentValues), paymentMin = Math.min(...paymentValues);
  const leadMax = Math.max(...leadTimeValues), leadMin = Math.min(...leadTimeValues);
  const performanceMax = performanceValues.length ? Math.max(...performanceValues) : 100;
  const performanceMin = performanceValues.length ? Math.min(...performanceValues) : 0;
  quotes.forEach((quote, index) => {
    const scores = quote.scores;
    scores.price = inverseScore(raw[index]!.price, minPrice, maxPrice);
    scores.leadTime = inverseScore(raw[index]!.leadTime, leadMin, leadMax);
    scores.paymentTerms = directScore(raw[index]!.paymentTerms ?? paymentMin, paymentMin, paymentMax);
    scores.performance = raw[index]!.performance === undefined ? undefined : raw[index]!.performance === performanceMax && performanceMax === performanceMin ? 100 : ((raw[index]!.performance! - performanceMin) / (performanceMax - performanceMin)) * 100;
    scores.total = weighted(scores, weights, dimensions);
  });
}

function weighted(scores: NormalizedQuote['scores'], weights: QuoteComparisonWeights, dimensions: readonly (keyof QuoteComparisonWeights)[]): number {
  let total = 0, weight = 0;
  for (const dimension of dimensions) { const value = scores[dimension]; const w = weights[dimension]; if (value !== undefined && w > 0) { total += value * w; weight += w; } }
  return weight ? total / weight : 0;
}

function inverseScore(value: number, min: number, max: number): number { return max === min ? 100 : ((max - value) / (max - min)) * 100; }
function directScore(value: number, min: number, max: number): number { return max === min ? 100 : ((value - min) / (max - min)) * 100; }
function validateWeights(weights: QuoteComparisonWeights): QuoteComparisonWeights {
  const values = [weights.price, weights.leadTime, weights.paymentTerms, weights.performance];
  if (values.some((value) => !Number.isFinite(value) || value < 0) || values.every((value) => value === 0)) throw new Error('weights 必须为非负数且至少一个维度大于 0');
  return weights;
}
function eligibilityReason(status: QuoteEligibility, moq: number, quantity: number, quotedQuantity: number, expiry: Date, asOf: Date): string { if (status === 'tax_review_required') return '供应商未说明报价含税或未税，需税务复核后才能比较或定标'; if (status === 'expired') return `报价已过期（有效期 ${expiry.toISOString().slice(0, 10)}，基准日 ${asOf.toISOString().slice(0, 10)}）`; if (status === 'quoted_quantity_insufficient') return `报价数量 ${quotedQuantity} 低于采购数量 ${quantity}`; if (status === 'moq_not_met') return `MOQ ${moq} 高于采购数量 ${quantity}`; return '满足数量、MOQ 且报价有效'; }
function parsePaymentTerms(value: string, index: number): { days: number; note?: string } { const text = requiredText(value, `quotes[${index}].paymentTerms`).trim(); const partial = text.match(/预付\s*(\d+(?:\.\d+)?)\s*%/); if (partial) return { days: 0, note: `部分预付 ${partial[1]}%，其余账期按报价原文处理` }; if (/预付/.test(text)) return { days: 0, note: '全额预付，账期 0 天' }; if (/现金/.test(text)) return { days: 0, note: '现金付款，账期 0 天' }; const month = text.match(/月结\s*(\d+)\s*天?/); if (month) return { days: Number(month[1]) }; const match = text.match(DEFAULT_PAYMENT_DAYS); if (!match) throw new Error(`quotes[${index}].paymentTerms 无法标准化`); return { days: Number(match[1]) }; }
function exchangeRate(from: string, to: string, snapshot: ExchangeRateSnapshot): number { if (from === to) return 1; const direct = snapshot.rates[`${from}/${to}`]; if (direct !== undefined && direct > 0) return direct; const inverse = snapshot.rates[`${to}/${from}`]; if (inverse !== undefined && inverse > 0) return 1 / inverse; throw new Error(`缺少汇率 ${from}/${to}（快照 ${snapshot.version}）`); }
function requiredText(value: string | undefined, field: string): string { if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空`); return value.trim(); }
function positive(value: number, field: string): number { if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} 必须大于 0`); return value; }
function nonNegative(value: number | undefined, field: string): number { if (value === undefined || !Number.isFinite(value) || value < 0) throw new Error(`${field} 不能为空且不能为负数`); return value; }
function validDate(value: string, field: string): Date { const date = new Date(requiredText(value, field)); if (Number.isNaN(date.getTime())) throw new Error(`${field} 日期无效`); return date; }
