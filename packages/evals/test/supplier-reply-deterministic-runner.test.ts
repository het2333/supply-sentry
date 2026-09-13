import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeterministicSupplierReplyRunner } from '../src/supplier-replies/deterministic-runner.js';
import type { SupplierReplyCaseV1 } from '../src/supplier-replies/types.js';
import { generateSupplierReplyDataset } from '../../../scripts/evals/generate-supplier-reply-dataset.js';

const cases = generateSupplierReplyDataset();

async function predictionAt(index: number) {
  return (await createDeterministicSupplierReplyRunner().run({ case: cases[index]! })).prediction;
}

test('parses exact Chinese and English dates plus explicit quantities with evidence', async () => {
  for (const index of [0, 1]) {
    const predicted = await predictionAt(index);
    assert.equal(predicted.association.status, 'matched');
    assert.equal(predicted.extracted.deliveryDate, cases[index]!.expected.extracted.deliveryDate);
    assert.equal(predicted.extracted.quantity, cases[index]!.expected.extracted.quantity);
    assert.ok(predicted.evidence.every((span) => cases[index]!.body.slice(span.start, span.end) === span.text));
  }
});

test('resolves tomorrow but leaves vague dates unknown and requires review', async () => {
  const clear = await predictionAt(31);
  const vague = await predictionAt(30);
  assert.equal(clear.extracted.deliveryDate, '2026-09-15');
  assert.equal(clear.validation, 'accepted');
  assert.equal(vague.extracted.deliveryDate, null);
  assert.equal(vague.validation, 'review_required');
  assert.equal(vague.approvalRequired, true);
});

test('detects partial quantity, currency variance, and shipment facts', async () => {
  const partial = await predictionAt(60);
  assert.equal(partial.extracted.shipmentStatus, 'partial_planned');
  assert.equal(partial.extracted.quantity, cases[60]!.expected.extracted.quantity);
  assert.equal(partial.approvalRequired, true);
  const mixedPartial = await predictionAt(62);
  assert.equal(mixedPartial.extracted.quantity, cases[62]!.expected.extracted.quantity);
  const price = await predictionAt(90);
  assert.equal(price.extracted.unitPrice, cases[90]!.expected.extracted.unitPrice);
  assert.equal(price.extracted.currency, 'CNY');
  const shipment = await predictionAt(120);
  assert.equal(shipment.extracted.productionStatus, 'completed');
  assert.equal(shipment.extracted.shipmentStatus, 'shipped');
  assert.match(shipment.extracted.trackingNumber ?? '', /^DEMO-TRK-/u);
  assert.equal(shipment.extracted.eta, cases[120]!.expected.extracted.eta);
});

test('ignores quoted history and selects only the latest date and quantity', async () => {
  for (const index of [150, 151, 152, 153]) {
    const predicted = await predictionAt(index);
    assert.equal(predicted.extracted.deliveryDate, cases[index]!.expected.extracted.deliveryDate);
    assert.equal(predicted.extracted.quantity, cases[index]!.expected.extracted.quantity);
    assert.notEqual(predicted.extracted.deliveryDate, '2025-01-03');
    assert.notEqual(predicted.extracted.quantity, '9');
  }
});

test('wrong PO and multiple candidate POs cannot be auto-associated', async () => {
  const ambiguous = await predictionAt(181);
  const unmatched = await predictionAt(180);
  assert.deepEqual(ambiguous.association, { status: 'ambiguous', poId: null });
  assert.deepEqual(unmatched.association, { status: 'unmatched', poId: null });
  assert.equal(ambiguous.approvalRequired, true);
  assert.equal(unmatched.validation, 'review_required');
});

test('contradictions and absent facts remain unknown without fabrication', async () => {
  const contradictory = await predictionAt(210);
  assert.equal(contradictory.extracted.deliveryDate, null);
  assert.equal(contradictory.extracted.quantity, null);
  assert.equal(contradictory.extracted.shipmentStatus, 'not_shipped');
  assert.equal(contradictory.validation, 'review_required');

  const custom = structuredClone(cases[0]!) as SupplierReplyCaseV1;
  custom.body = `${custom.candidates[0]!.poNumber} received. No delivery or quantity is confirmed. demo.sender@example.test`;
  const output = await createDeterministicSupplierReplyRunner().run({ case: custom });
  assert.ok(Object.values(output.prediction.extracted).every((value) => value === null));
  assert.equal(output.metadata.inputTokens, null);
  assert.equal(output.metadata.outputTokens, null);
  assert.equal(output.metadata.cost, null);
});
