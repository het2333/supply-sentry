#!/usr/bin/env node

import assert from 'node:assert/strict';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const positionalUrl = process.argv.slice(2).find((argument, index, arguments_) => (
  !argument.startsWith('--') && arguments_[index - 1] !== '--base-url'
));
const baseUrl = new URL(option('--base-url') ?? positionalUrl ?? process.env.READYWORK_DEMO_URL ?? 'http://127.0.0.1:3002/');
const internalToken = process.env.READYWORK_INTERNAL_CALLBACK_TOKEN?.trim() || null;
const verificationMode = internalToken ? 'internal_reset' : 'external_public';

const targetPoId = 'purchase-order:public-demo:awaiting-confirmation';
let cookie = '';
let generation = 0;

async function call(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (cookie) headers.set('cookie', cookie);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.mutation) headers.set('x-readywork-demo-generation', String(options.generation ?? generation));
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    redirect: 'manual',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';', 1)[0] ?? '';
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = text; }
  return { response, body };
}

function expectStatus(result, expected, label) {
  assert.equal(
    result.response.status,
    expected,
    `${label}: expected HTTP ${expected}, received ${result.response.status}\n${JSON.stringify(result.body)}`,
  );
}

function workbenchItems(workbench, section) {
  const items = workbench?.documents?.[section]?.items;
  assert.ok(Array.isArray(items), `workbench documents.${section}.items is missing`);
  return items;
}

async function reset() {
  assert.ok(internalToken, 'internal reset token is unavailable in external public verification');
  const result = await call('/internal/demo/reset', {
    method: 'POST',
    headers: { 'x-readywork-internal-token': internalToken },
  });
  expectStatus(result, 200, 'public demo reset');
  assert.ok(Number.isSafeInteger(result.body?.generation) && result.body.generation > 0, 'reset generation is invalid');
  return result.body;
}

console.log(`Verifying SupplySentry public demo at ${baseUrl.origin} (${verificationMode})`);

const home = await call('/');
expectStatus(home, 200, 'console');

const entry = await call('/api/auth/public-demo', { method: 'POST' });
expectStatus(entry, 200, 'public demo entry');
assert.equal(entry.body?.demoMode, true);
assert.match(cookie, /^readywork_session=rw1\./u);

if (internalToken) await reset();
const status = await call('/api/public-demo/status');
expectStatus(status, 200, 'public demo status');
assert.equal(status.body?.tenantId, 't:public-demo');
assert.equal(status.body?.seedVersion, 'public-demo-v1');
assert.equal(status.body?.status, 'healthy');
generation = status.body.generation;

const beforeWorkbenchResult = await call('/api/procurement/workbench');
expectStatus(beforeWorkbenchResult, 200, 'initial workbench');
const beforeWorkbench = beforeWorkbenchResult.body;
const purchaseOrders = workbenchItems(beforeWorkbench, 'purchaseOrders');
const purchaseOrder = purchaseOrders.find((item) => item.id === targetPoId);
assert.ok(purchaseOrder, `seeded purchase order ${targetPoId} is missing`);
assert.ok(Number.isSafeInteger(purchaseOrder.version) && purchaseOrder.version > 0, 'purchase order version is invalid');

const beforeNotifications = await call('/api/procurement/notifications?filter=all');
expectStatus(beforeNotifications, 200, 'initial notifications');
if (internalToken) assert.ok(beforeNotifications.body?.counts?.unread > 0, 'freshly reset demo must include unread notifications');

const staleMutation = await call('/api/procurement/notifications/read-all', {
  method: 'POST',
  mutation: true,
  generation: generation - 1,
  body: {},
});
expectStatus(staleMutation, 409, 'stale generation guard');
assert.equal(staleMutation.body?.code, 'DEMO_GENERATION_CONFLICT');

const readNotifications = await call('/api/procurement/notifications/read-all', {
  method: 'POST',
  mutation: true,
  body: {},
});
expectStatus(readNotifications, 200, 'notification mutation');
assert.equal(readNotifications.body?.counts?.unread, 0);

const markedAtRisk = await call('/api/procurement/execution/mark_at_risk', {
  method: 'POST',
  mutation: true,
  headers: { 'idempotency-key': `public-demo-verifier-risk-${generation}` },
  body: {
    aggregateId: targetPoId,
    expectedVersion: purchaseOrder.version,
    riskSeverity: 'high',
    riskCategory: 'supplier_response',
    reason: 'Public demo end-to-end verification risk',
    recommendedAction: 'Confirm the supplier recovery plan in the demo workflow.',
  },
});
assert.ok([200, 201].includes(markedAtRisk.response.status), `mark_at_risk failed: ${JSON.stringify(markedAtRisk.body)}`);
assert.equal(markedAtRisk.body?.exception?.objectId, targetPoId);
assert.equal(markedAtRisk.body?.exception?.type, 'manual_purchase_order_risk');

const afterWorkbenchResult = await call('/api/procurement/workbench');
expectStatus(afterWorkbenchResult, 200, 'mutated workbench');
const afterWorkbench = afterWorkbenchResult.body;
assert.ok(
  afterWorkbench.exceptions.items.some((item) => item.objectId === targetPoId && item.type === 'manual_purchase_order_risk'),
  'manual risk exception was not projected into the workbench',
);
assert.ok(
  afterWorkbench.recentActivities.items.some((item) => item.objectId === targetPoId && item.action === 'purchase_order.marked_at_risk'),
  'risk activity was not persisted',
);

const shortDeliveryApprovalId = 'approval:public-demo:short-delivery';
const approvalResult = await call(`/api/procurement/execution/approvals/${encodeURIComponent(shortDeliveryApprovalId)}`);
expectStatus(approvalResult, 200, 'short-delivery approval');
assert.equal(approvalResult.body?.approval?.poId, targetPoId, 'short-delivery approval is not linked to the expected purchase order');
let approvalState = approvalResult.body.approval.status;
if (approvalState === 'pending') {
  const approvalDecision = await call('/api/procurement/execution/decide_confirmation', {
    method: 'POST',
    mutation: true,
    headers: { 'idempotency-key': `public-demo-verifier-approval-${generation}` },
    body: {
      aggregateId: shortDeliveryApprovalId,
      expectedVersion: purchaseOrder.version,
      decision: 'approved',
      shortfallDisposition: 'cancel_remainder',
      reason: 'Public demo verification accepts the synthetic short delivery.',
    },
  });
  assert.ok([200, 201].includes(approvalDecision.response.status), `short-delivery approval failed: ${JSON.stringify(approvalDecision.body)}`);
  assert.equal(approvalDecision.body?.approval?.status, 'approved');
  assert.equal(approvalDecision.body?.approval?.shortfallDisposition, 'cancel_remainder');
  assert.equal(approvalDecision.body?.aggregate?.document?.id, targetPoId);
  assert.equal(approvalDecision.body?.aggregate?.document?.status, 'confirmed');
  approvalState = 'approved';
} else {
  assert.equal(approvalState, 'approved', `unexpected short-delivery approval state: ${String(approvalState)}`);
}

const approvedWorkbenchResult = await call('/api/procurement/workbench');
expectStatus(approvedWorkbenchResult, 200, 'approved workbench projection');
const approvedPurchaseOrder = workbenchItems(approvedWorkbenchResult.body, 'purchaseOrders').find((item) => item.id === targetPoId);
assert.equal(approvedPurchaseOrder?.status, 'confirmed', 'approved purchase order projection was not updated');

const simulatedAction = await call('/api/public-demo/simulated-actions', {
  method: 'POST',
  mutation: true,
  body: { scenarioId: targetPoId },
});
expectStatus(simulatedAction, 200, 'simulated external action');
assert.equal(simulatedAction.body?.output?.receiptKind, 'simulated_demo');
assert.equal(simulatedAction.body?.output?.externalDelivery, false);
assert.equal(simulatedAction.body?.output?.generation, generation);

for (const deniedRequest of [
  { label: 'configuration', method: 'GET', path: '/api/editor/workflows' },
  { label: 'upload', method: 'POST', path: `/api/procurement/import-documents/pos/${encodeURIComponent(targetPoId)}/documents` },
  { label: 'webhook', method: 'POST', path: '/api/connectors/webhook/t%3Apublic-demo/demo-token' },
]) {
  const denied = await call(deniedRequest.path, { method: deniedRequest.method });
  expectStatus(denied, 403, `${deniedRequest.label} denial`);
  assert.equal(denied.body?.code, 'PUBLIC_DEMO_CAPABILITY_DISABLED');
}

let resetRestored = false;
let resetVerification = 'server_internal_only';
if (internalToken) {
  const finalReset = await reset();
  assert.equal(finalReset.generation, generation + 1, 'final reset did not advance generation exactly once');
  generation = finalReset.generation;

  const restoredWorkbenchResult = await call('/api/procurement/workbench');
  expectStatus(restoredWorkbenchResult, 200, 'restored workbench');
  const restoredWorkbench = restoredWorkbenchResult.body;
  assert.equal(workbenchItems(restoredWorkbench, 'purchaseOrders').length, purchaseOrders.length, 'seeded purchase order count was not restored');
  assert.equal(
    restoredWorkbench.exceptions.items.some((item) => item.objectId === targetPoId && item.type === 'manual_purchase_order_risk'),
    false,
    'final reset did not remove the verification risk',
  );

  const restoredNotifications = await call('/api/procurement/notifications?filter=all');
  expectStatus(restoredNotifications, 200, 'restored notifications');
  assert.equal(restoredNotifications.body?.counts?.unread, beforeNotifications.body.counts.unread, 'final reset did not restore notification state');
  resetRestored = true;
  resetVerification = 'verified_internal';
}

console.log(JSON.stringify({
  ok: true,
  verificationMode,
  tenantId: 't:public-demo',
  generation,
  purchaseOrders: purchaseOrders.length,
  approval: approvalState,
  simulatedReceipt: {
    receiptKind: simulatedAction.body.output.receiptKind,
    externalDelivery: simulatedAction.body.output.externalDelivery,
  },
  resetRestored,
  resetVerification,
}, null, 2));
