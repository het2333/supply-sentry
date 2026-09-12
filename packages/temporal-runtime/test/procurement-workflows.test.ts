import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectPurchaseOrderCancellationStatus } from '../src/workflows.js';

test('purchase-order cancellation workflow waits for external receipt and never projects success from dispatch alone', () => {
  assert.equal(projectPurchaseOrderCancellationStatus({ source: 'local', purchaseOrderStatus: 'cancelled' }), 'cancelled');
  assert.equal(projectPurchaseOrderCancellationStatus({ source: 'odoo', purchaseOrderStatus: 'confirmed', amendmentState: 'queued' }), 'pending_external');
  assert.equal(projectPurchaseOrderCancellationStatus({ source: 'odoo', purchaseOrderStatus: 'confirmed', amendmentState: 'dispatched' }), 'pending_external');
  assert.equal(projectPurchaseOrderCancellationStatus({ source: 'odoo', purchaseOrderStatus: 'confirmed', amendmentState: 'applied' }), 'unknown');
  assert.equal(projectPurchaseOrderCancellationStatus({ source: 'odoo', purchaseOrderStatus: 'cancelled', amendmentState: 'applied' }), 'cancelled');
});

test('purchase-order cancellation workflow distinguishes definite rejection from uncertain network outcome', () => {
  assert.equal(projectPurchaseOrderCancellationStatus({ source: 'odoo', purchaseOrderStatus: 'confirmed', amendmentState: 'failed' }), 'failed');
  assert.equal(projectPurchaseOrderCancellationStatus({ source: 'odoo', purchaseOrderStatus: 'confirmed', amendmentState: 'rejected' }), 'failed');
  assert.equal(projectPurchaseOrderCancellationStatus({ source: 'odoo', purchaseOrderStatus: 'confirmed', amendmentState: 'unknown' }), 'unknown');
});
