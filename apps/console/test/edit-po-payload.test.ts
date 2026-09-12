import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEditPurchaseOrderPatch, type EditPurchaseOrderValues } from '../features/procurement/edit-po-payload.js';

const baseline: EditPurchaseOrderValues = {
  supplierId: 'supplier:1', contactId: 'contact:1', requiredInHouseAt: '2026-09-10', materialType: 'direct',
  lines: [{ id: 'line:1', itemCode: 'VALVE-1', description: '阀门', quantity: 2, unit: 'EA', unitPrice: 20, taxRate: 0.13 }],
};

test('Edit PO payload is a sparse semantic diff, never a full form snapshot', () => {
  assert.deepEqual(buildEditPurchaseOrderPatch(baseline, { ...baseline, requiredInHouseAt: '2026-09-30' }), {
    requiredInHouseAt: '2026-09-30',
  });
  assert.deepEqual(buildEditPurchaseOrderPatch(baseline, baseline), {});
});

test('Edit PO payload keeps approved local Draft changes and excludes unsupported external fields', () => {
  const changed: EditPurchaseOrderValues = {
    ...baseline, supplierId: 'supplier:2', contactId: 'contact:2', materialType: 'indirect' as const,
    lines: baseline.lines.map((line) => ({ ...line, quantity: 4 })), requiredInHouseAt: '2026-09-30',
  };
  assert.deepEqual(buildEditPurchaseOrderPatch(baseline, changed), {
    supplierId: 'supplier:2', contactId: 'contact:2', requiredInHouseAt: '2026-09-30', materialType: 'indirect', lines: changed.lines,
  });
  assert.deepEqual(buildEditPurchaseOrderPatch(baseline, changed, { external: true }), {
    requiredInHouseAt: '2026-09-30',
  });
});
