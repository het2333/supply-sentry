import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateRiskModelV2,
  validateRiskModelV2Result,
  type RiskComponentInput,
} from '../src/procurement-risk-model-v2.js';

const observedAt = '2026-09-03T08:00:00.000Z';

function component(
  score: number | null,
  evidenceState: RiskComponentInput['evidenceState'] = score === null ? 'missing' : 'observed',
  id = 'evidence:1',
): RiskComponentInput {
  return {
    score,
    evidenceState,
    evidenceReferences: score === null ? [] : [{ type: 'fixture', id, version: 1 }],
    observedAt: score === null ? null : observedAt,
  };
}

test('RiskModelV2 applies the published 30/25/20/15/10 formula and fixed bands', () => {
  const result = calculateRiskModelV2({
    S: component(80, 'observed', 'supplier'),
    D: component(60, 'derived', 'delivery'),
    V: component(50, 'derived', 'value'),
    C: component(40, 'observed', 'criticality'),
    A: component(20, 'derived', 'approval'),
  });

  assert.equal(result.modelVersion, 'risk-model-v2');
  assert.equal(result.totalScore, 57);
  assert.equal(result.provisionalScore, null);
  assert.equal(result.provisionalBand, null);
  assert.equal(result.band, 'medium');
  assert.equal(result.evidenceCoverage, 1);
  assert.deepEqual(Object.fromEntries(Object.entries(result.components).map(([name, value]) => [name, value.weight])), {
    supplierPerformance: 0.30,
    deliveryDelay: 0.25,
    poValue: 0.20,
    productCriticality: 0.15,
    complianceApproval: 0.10,
  });

  assert.equal(calculateRiskModelV2({ S: component(70), D: component(70), V: component(70), C: component(70), A: component(70) }).band, 'high');
  assert.equal(calculateRiskModelV2({ S: component(40), D: component(40), V: component(40), C: component(40), A: component(40) }).band, 'medium');
  assert.equal(calculateRiskModelV2({ S: component(39), D: component(39), V: component(39), C: component(39), A: component(39) }).band, 'low');
});

test('RiskModelV2 excludes missing and stale evidence and labels normalized partial scores provisional', () => {
  const result = calculateRiskModelV2({
    S: component(80, 'observed', 'supplier'),
    D: component(60, 'derived', 'delivery'),
    V: component(50, 'observed', 'value'),
    C: component(null, 'missing'),
    A: component(100, 'stale', 'approval'),
  });

  assert.equal(result.evidenceCoverage, 0.75);
  assert.equal(result.totalScore, null);
  assert.equal(result.provisionalScore, 65);
  assert.equal(result.provisionalBand, 'medium');
  assert.equal(result.band, 'unpublished');
});

test('RiskModelV2 does not publish a provisional score below 70% coverage or without Delivery Delay evidence', () => {
  const belowThreshold = calculateRiskModelV2({
    S: component(80), D: component(60), V: component(null), C: component(null), A: component(20),
  });
  assert.equal(belowThreshold.evidenceCoverage, 0.65);
  assert.equal(belowThreshold.provisionalScore, null);

  const deliveryMissing = calculateRiskModelV2({
    S: component(80), D: component(null), V: component(50), C: component(40), A: component(20),
  });
  assert.equal(deliveryMissing.evidenceCoverage, 0.75);
  assert.equal(deliveryMissing.provisionalScore, null);
  assert.equal(deliveryMissing.band, 'unpublished');
});

test('RiskModelV2 rejects caller weights, invalid evidence contracts and mutated stored weights', () => {
  const valid = { S: component(80), D: component(60), V: component(50), C: component(40), A: component(20) };
  assert.throws(() => calculateRiskModelV2({ ...valid, S: { ...valid.S, weight: 0.99 } } as never), /weight/i);
  assert.throws(() => calculateRiskModelV2({ ...valid, V: component(101) }), /score/i);
  assert.throws(() => calculateRiskModelV2({ ...valid, D: { ...valid.D, observedAt: 'not-a-date' } }), /observedAt/i);

  const result = calculateRiskModelV2(valid);
  const tampered = structuredClone(result);
  tampered.components.deliveryDelay.weight = 0.30 as never;
  assert.throws(() => validateRiskModelV2Result(tampered), /weight/i);
});

test('RiskModelV2 freezes copied evidence so later caller mutation cannot rewrite a result', () => {
  const supplier = component(80, 'observed', 'supplier');
  const result = calculateRiskModelV2({
    S: supplier, D: component(60), V: component(50), C: component(40), A: component(20),
  });
  supplier.evidenceReferences[0]!.id = 'rewritten';

  assert.equal(result.components.supplierPerformance.evidenceReferences[0]?.id, 'supplier');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.components), true);
  assert.equal(Object.isFrozen(result.components.supplierPerformance.evidenceReferences), true);
});
