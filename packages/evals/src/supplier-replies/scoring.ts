import { SUPPLIER_REPLY_FIELDS } from './dataset.js';
import type { SupplierReplyPrediction, SupplierReplyRunMetadata } from './runner.js';
import type { SupplierReplyExpected } from './types.js';

export interface SupplierReplyCaseResult {
  caseId: string;
  scenarioTags: string[];
  expected: SupplierReplyExpected;
  prediction: SupplierReplyPrediction;
  metadata: SupplierReplyRunMetadata;
}

export interface FieldScore {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface SupplierReplyMetrics {
  caseCount: number;
  completedCases: number;
  associationAccuracy: number;
  fields: Record<string, FieldScore>;
  missingFactRecall: number;
  approvalRecall: number;
  shortDeliveryApprovalRecall: number | null;
  materialVarianceApprovalRecall: number | null;
  fabricatedFacts: number;
  predictedFacts: number;
  fabricationRate: number;
  acceptedResultRate: number;
  latencyMs: { p50: number; p95: number };
  tokenUsage: { input: number; output: number } | null;
  cost: number | null;
  perTag: Record<string, Omit<SupplierReplyMetrics, 'perTag'>>;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function scoreField(items: readonly { expected: readonly string[]; predicted: readonly string[] }[]): FieldScore {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const item of items) {
    const expected = new Set(item.expected.map((value) => value.trim().toLowerCase()));
    const predicted = new Set(item.predicted.map((value) => value.trim().toLowerCase()));
    for (const value of predicted) expected.has(value) ? truePositive += 1 : falsePositive += 1;
    for (const value of expected) if (!predicted.has(value)) falseNegative += 1;
  }
  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);
  return { truePositive, falsePositive, falseNegative, precision, recall, f1: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall) };
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
}

function approvalRecall(results: readonly SupplierReplyCaseResult[], tag?: string): number | null {
  const expected = results.filter((result) => result.expected.approvalRequired && (!tag || result.scenarioTags.includes(tag)));
  if (expected.length === 0) return null;
  return expected.filter((result) => result.prediction.approvalRequired).length / expected.length;
}

function exactPrediction(result: SupplierReplyCaseResult): boolean {
  return JSON.stringify(result.prediction) === JSON.stringify(result.expected);
}

function scoreCore(results: readonly SupplierReplyCaseResult[]): Omit<SupplierReplyMetrics, 'perTag'> {
  const fields: Record<string, FieldScore> = {};
  let expectedUnknown = 0;
  let identifiedUnknown = 0;
  let fabricatedFacts = 0;
  let predictedFacts = 0;
  for (const field of SUPPLIER_REPLY_FIELDS) {
    fields[field] = scoreField(results.map((result) => ({
      expected: result.expected.extracted[field] === null ? [] : [result.expected.extracted[field]!],
      predicted: result.prediction.extracted[field] === null ? [] : [result.prediction.extracted[field]!],
    })));
  }
  for (const result of results) {
    for (const field of SUPPLIER_REPLY_FIELDS) {
      const expected = result.expected.extracted[field];
      const predicted = result.prediction.extracted[field];
      if (predicted !== null) predictedFacts += 1;
      if (expected === null && predicted !== null) fabricatedFacts += 1;
      if (expected === null) {
        expectedUnknown += 1;
        if (result.prediction.unknownFields.includes(field)) identifiedUnknown += 1;
      }
    }
  }
  const tokensAvailable = results.length > 0 && results.every((result) => result.metadata.inputTokens !== null && result.metadata.outputTokens !== null);
  const costAvailable = results.length > 0 && results.every((result) => result.metadata.cost !== null);
  const associationCorrect = results.filter((result) => result.expected.association.status === result.prediction.association.status
    && (result.expected.association.status !== 'matched' || result.expected.association.poId === result.prediction.association.poId)).length;
  return {
    caseCount: results.length,
    completedCases: results.length,
    associationAccuracy: ratio(associationCorrect, results.length),
    fields,
    missingFactRecall: ratio(identifiedUnknown, expectedUnknown),
    approvalRecall: approvalRecall(results) ?? 0,
    shortDeliveryApprovalRecall: approvalRecall(results, 'quantity_or_partial_shipment'),
    materialVarianceApprovalRecall: approvalRecall(results, 'price_or_currency_variance'),
    fabricatedFacts,
    predictedFacts,
    fabricationRate: ratio(fabricatedFacts, predictedFacts),
    acceptedResultRate: ratio(results.filter(exactPrediction).length, results.length),
    latencyMs: { p50: percentile(results.map((result) => result.metadata.latencyMs), 0.5), p95: percentile(results.map((result) => result.metadata.latencyMs), 0.95) },
    tokenUsage: tokensAvailable ? {
      input: results.reduce((sum, result) => sum + result.metadata.inputTokens!, 0),
      output: results.reduce((sum, result) => sum + result.metadata.outputTokens!, 0),
    } : null,
    cost: costAvailable ? results.reduce((sum, result) => sum + result.metadata.cost!, 0) : null,
  };
}

export function scoreSupplierReplyCases(results: readonly SupplierReplyCaseResult[]): SupplierReplyMetrics {
  const core = scoreCore(results);
  const tags = [...new Set(results.flatMap((result) => result.scenarioTags))].sort();
  return { ...core, perTag: Object.fromEntries(tags.map((tag) => [tag, scoreCore(results.filter((result) => result.scenarioTags.includes(tag)))])) };
}
