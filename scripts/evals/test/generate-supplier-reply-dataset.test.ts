import assert from 'node:assert/strict';
import test from 'node:test';
import { verifySupplierReplyDataset } from '../../../packages/evals/src/supplier-replies/dataset.js';
import {
  generateSupplierReplyDataset,
  serializeSupplierReplyDataset,
  supplierReplyDatasetDistribution,
} from '../generate-supplier-reply-dataset.js';

test('fixed-seed supplier reply generation is byte-identical', () => {
  const first = serializeSupplierReplyDataset(generateSupplierReplyDataset());
  const second = serializeSupplierReplyDataset(generateSupplierReplyDataset());
  assert.deepEqual(first, second);
  assert.equal(generateSupplierReplyDataset().length, 240);
});

test('generation has 60 cases per locale, 30 per primary scenario, and at least 60 adversarial cases', () => {
  const cases = generateSupplierReplyDataset();
  const distribution = supplierReplyDatasetDistribution(cases);
  assert.deepEqual(distribution.locale, { 'en-US': 60, 'mixed': 60, 'qq-mail': 60, 'zh-CN': 60 });
  assert.deepEqual(distribution.primaryScenario, {
    exact_date: 30,
    missing_or_contradictory_facts: 30,
    price_or_currency_variance: 30,
    production_shipment_transport: 30,
    quantity_or_partial_shipment: 30,
    quoted_history_contamination: 30,
    relative_or_vague_date: 30,
    wrong_or_ambiguous_association: 30,
  });
  assert.ok((distribution.difficulty.adversarial ?? 0) >= 60);
  assert.ok((distribution.association.ambiguous ?? 0) > 0);
  assert.ok((distribution.association.unmatched ?? 0) > 0);
  assert.ok((distribution.validation.review_required ?? 0) > 0);
});

test('generated rows satisfy the strict dataset verifier and exact evidence offsets', () => {
  const cases = generateSupplierReplyDataset();
  const bytes = serializeSupplierReplyDataset(cases);
  const result = verifySupplierReplyDataset(cases, bytes);
  assert.equal(result.caseCount, 240);
  for (const value of cases) {
    for (const evidence of value.expected.evidence) {
      assert.equal(value.body.slice(evidence.start, evidence.end), evidence.text);
      assert.equal(value.body.indexOf(evidence.text), evidence.start, `${value.caseId} evidence must be unique and derived from the final body`);
      assert.equal(value.body.lastIndexOf(evidence.text), evidence.start, `${value.caseId} evidence must occur once`);
    }
  }
});
