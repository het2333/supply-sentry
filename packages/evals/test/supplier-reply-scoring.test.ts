import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreField, scoreSupplierReplyCases, type SupplierReplyCaseResult } from '../src/supplier-replies/scoring.js';
import { stableJson, summarizeSupplierReplyReport, type SupplierReplyEvaluationReport } from '../src/supplier-replies/report.js';
import { generateSupplierReplyDataset } from '../../../scripts/evals/generate-supplier-reply-dataset.js';

test('field precision, recall, and F1 follow hand-calculated TP/FP/FN counts', () => {
  assert.deepEqual(scoreField([{ expected: ['10'], predicted: ['10', '12'] }]), {
    truePositive: 1,
    falsePositive: 1,
    falseNegative: 0,
    precision: 0.5,
    recall: 1,
    f1: 2 / 3,
  });
});

test('scores association, missing facts, approval, fabrication, and accepted results exactly', () => {
  const source = generateSupplierReplyDataset();
  const exact: SupplierReplyCaseResult = {
    caseId: source[0]!.caseId,
    scenarioTags: source[0]!.scenarioTags,
    expected: source[0]!.expected,
    prediction: structuredClone(source[0]!.expected),
    metadata: { runner: 'deterministic', model: 'test', promptVersion: 'v1', schemaVersion: 'supplier-reply-proposal-v1', latencyMs: 2, inputTokens: null, outputTokens: null, cost: null },
  };
  const fabricatedPrediction = structuredClone(source[1]!.expected);
  fabricatedPrediction.extracted.unitPrice = '99.00';
  fabricatedPrediction.unknownFields = fabricatedPrediction.unknownFields.filter((field) => field !== 'unitPrice');
  fabricatedPrediction.evidence.push({ field: 'unitPrice', start: 0, end: 1, text: source[1]!.body.slice(0, 1) });
  fabricatedPrediction.approvalRequired = true;
  fabricatedPrediction.validation = 'review_required';
  const fabricated: SupplierReplyCaseResult = {
    caseId: source[1]!.caseId,
    scenarioTags: source[1]!.scenarioTags,
    expected: source[1]!.expected,
    prediction: fabricatedPrediction,
    metadata: { ...exact.metadata, latencyMs: 4 },
  };
  const metrics = scoreSupplierReplyCases([exact, fabricated]);
  assert.equal(metrics.caseCount, 2);
  assert.equal(metrics.associationAccuracy, 1);
  assert.equal(metrics.fabricatedFacts, 1);
  assert.equal(metrics.fabricationRate, 1 / 5);
  assert.equal(metrics.acceptedResultRate, 0.5);
  assert.equal(metrics.missingFactRecall, 11 / 12);
  assert.equal(metrics.latencyMs.p50, 2);
  assert.equal(metrics.latencyMs.p95, 4);
  assert.equal(metrics.tokenUsage, null);
  assert.equal(metrics.cost, null);
});

test('stable summary excludes run timestamp, revision, latency, and case-level output', () => {
  const report = {
    reportVersion: 'supplier-reply-evaluation-v1', datasetVersion: 'supplier-replies-v1', datasetHash: 'abc', generatedAt: '2026-09-14T00:00:00.000Z',
    sourceRevision: 'deadbeef', runner: 'deterministic', model: 'test', promptVersion: 'v1', schemaVersion: 'supplier-reply-proposal-v1',
    caseResults: [], metrics: { caseCount: 0, completedCases: 0, associationAccuracy: 0, fields: {}, missingFactRecall: 0, approvalRecall: 0, shortDeliveryApprovalRecall: null, materialVarianceApprovalRecall: null, fabricatedFacts: 0, predictedFacts: 0, fabricationRate: 0, acceptedResultRate: 0, latencyMs: { p50: 1, p95: 2 }, tokenUsage: null, cost: null, perTag: {} },
  } as unknown as SupplierReplyEvaluationReport;
  const summary = summarizeSupplierReplyReport(report);
  const serialized = stableJson(summary);
  assert.doesNotMatch(serialized, /generatedAt|sourceRevision|latencyMs|caseResults/u);
  assert.equal(serialized, stableJson({ ...summary }));
});
