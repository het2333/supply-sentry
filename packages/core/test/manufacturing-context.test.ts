import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTwinConfidence, compareTwinSourceVersions, twinSourcePriority } from '../src/manufacturing-context.js';

test('Twin source priority cannot let a model override an external receipt', () => {
  assert.equal(twinSourcePriority('verified_external'), 400);
  assert.equal(twinSourcePriority('approved_human'), 300);
  assert.equal(twinSourcePriority('deterministic'), 200);
  assert.equal(twinSourcePriority('model_derived'), 100);
  assert.equal(twinSourcePriority('observed_backfill'), 200);
});

test('Twin confidence is finite and between zero and one', () => {
  assert.equal(assertTwinConfidence(0.94), 0.94);
  assert.throws(() => assertTwinConfidence(1.1), /0 到 1/);
  assert.throws(() => assertTwinConfidence(Number.NaN), /0 到 1/);
});

test('Twin source versions use numeric bigint ordering and stable source-aware binary fallback', () => {
  assert.ok(compareTwinSourceVersions(
    { sourceKind: 'odoo', sourceVersion: '9' },
    { sourceKind: 'odoo', sourceVersion: '10' },
  ) < 0);
  assert.ok(compareTwinSourceVersions(
    { sourceKind: 'odoo', sourceVersion: '90071992547409931234567890' },
    { sourceKind: 'odoo', sourceVersion: '90071992547409931234567891' },
  ) < 0);
  assert.ok(compareTwinSourceVersions(
    { sourceKind: 'odoo', sourceVersion: 'v:9' },
    { sourceKind: 'odoo', sourceVersion: 'v:10' },
  ) > 0);
  const opaque = compareTwinSourceVersions(
    { sourceKind: 'wms', sourceVersion: 'β' },
    { sourceKind: 'odoo', sourceVersion: 'β' },
  );
  assert.equal(opaque, -compareTwinSourceVersions(
    { sourceKind: 'odoo', sourceVersion: 'β' },
    { sourceKind: 'wms', sourceVersion: 'β' },
  ));
});
