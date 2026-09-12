import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { act as reactAct } from 'react';
import { deferredResponse, jsonResponse, poPageFixture, type Row, withPoPage } from './helpers/po-page-harness.js';

type EvidenceKind = 'confirmation' | 'production' | 'shipment' | 'transport' | 'receipt';
type Act = typeof reactAct;
type Fixture = ReturnType<typeof poPageFixture>;

type EvidenceCase = {
  kind: EvidenceKind;
  actionLabel: RegExp;
  endpoint: string;
  idempotencyKey: string;
  fixture: Fixture;
  expectedBody: Row;
  fill: (act: Act, dialog: HTMLElement) => Promise<void>;
  invalidate: (act: Act, dialog: HTMLElement) => Promise<RegExp>;
  snapshot: (dialog: HTMLElement) => Record<string, string>;
  revokePermission: (fixture: Fixture) => void;
};

function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')?.set;
  assert.ok(setter, `missing native value setter for ${control.tagName}`);
  setter.call(control, value);
  const EventConstructor = control.ownerDocument.defaultView!.Event;
  control.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  control.dispatchEvent(new EventConstructor('change', { bubbles: true }));
}

async function setValues(act: Act, entries: Array<[HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, string]>): Promise<void> {
  await act(async () => {
    for (const [control, value] of entries) setNativeValue(control, value);
  });
}

function byLabel(scope: ParentNode, text: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const label = [...scope.querySelectorAll('label')].find((entry) => (entry.textContent ?? '').includes(text));
  assert.ok(label, `missing label containing ${text}`);
  const control = label.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
  assert.ok(control, `missing control for label ${text}`);
  return control;
}

function byAria(scope: ParentNode, label: string): HTMLInputElement {
  const control = [...scope.querySelectorAll<HTMLInputElement>('input[aria-label]')]
    .find((entry) => entry.getAttribute('aria-label') === label);
  assert.ok(control, `missing input with aria-label ${label}`);
  return control;
}

function currentValues(dialog: HTMLElement, labels: string[], ariaLabels: string[] = []): Record<string, string> {
  return Object.fromEntries([
    ...labels.map((label) => [label, byLabel(dialog, label).value]),
    ...ariaLabels.map((label) => [label, byAria(dialog, label).value]),
  ]);
}

function fixtureFor(kind: EvidenceKind): Fixture {
  const stage = kind === 'confirmation' ? 'supplier_commitment'
    : ['production', 'shipment'].includes(kind) ? 'fulfilment_production' : 'dispatch_transit';
  const fixture = poPageFixture(kind === 'confirmation' ? 'sent' : kind === 'production' || kind === 'shipment' ? 'confirmed' : 'shipped', stage);
  fixture.po.route = 'import';

  if (kind === 'confirmation') {
    fixture.context.communications.push(
      {
        id: 'message:latest', businessObjectType: 'purchase_order', businessObjectId: fixture.po.id,
        channel: 'email', direction: 'inbound', status: 'received', from: 'supplier@example.test',
        subject: '最新回复', body: '200 件，127 元，2026-09-20 交货', messageId: '<latest@example.test>',
        receivedAt: '2026-09-06T00:00:00.000Z',
      },
      {
        id: 'message:chosen', businessObjectType: 'purchase_order', businessObjectId: fixture.po.id,
        channel: 'email', direction: 'inbound', status: 'received', from: 'planner@example.test',
        subject: '人工核对回复', body: '180 件，129.5 元，2026-09-21 交货', messageId: '<chosen@example.test>',
        receivedAt: '2026-09-05T00:00:00.000Z',
      },
    );
  }

  if (kind === 'transport' || kind === 'receipt') {
    fixture.context.shipments.push(
      { id: 'shipment:page', externalId: 'ASN-PAGE', poId: fixture.po.id },
      { id: 'shipment:backup', externalId: 'ASN-BACKUP', poId: fixture.po.id },
    );
    fixture.context.quantityProjections.push({
      poLineId: fixture.line.id, orderedQty: 200, confirmedQty: 200, shippedQty: 100, receivedQty: 20,
    });
  }
  if (kind === 'receipt') fixture.context.receipts.push({ id: 'receipt:old', warehouseId: 'warehouse:old' });
  return fixture;
}

async function fillConfirmation(act: Act, dialog: HTMLElement): Promise<void> {
  await setValues(act, [
    [byLabel(dialog, '原始入站回复'), 'message:chosen'],
    [byAria(dialog, '测试阀门 供应商确认数量'), '180'],
    [byAria(dialog, '测试阀门 供应商确认单价'), '129.5'],
    [byAria(dialog, '测试阀门 供应商承诺交期'), '2026-09-21'],
  ]);
}

async function fillProduction(act: Act, dialog: HTMLElement): Promise<void> {
  await setValues(act, [
    [byLabel(dialog, '进度证据编号'), 'PROGRESS-42'],
    [byLabel(dialog, '本次状态'), 'quality_check'],
    [byLabel(dialog, '预计可发运时间'), '2026-09-18T09:30'],
    [byLabel(dialog, '供应商说明'), '装配正在进行'],
    [byLabel(dialog, '原始核验依据'), 'EMAIL-MSG-42'],
    [byLabel(dialog, '核验原因'), '已核验供应商周报'],
    [byAria(dialog, '测试阀门 完成数量'), '120'],
    [byAria(dialog, '测试阀门 完成度'), '60'],
  ]);
}

async function fillShipment(act: Act, dialog: HTMLElement): Promise<void> {
  await setValues(act, [
    [byLabel(dialog, 'ASN / 发运单号'), 'ASN-42'],
    [byLabel(dialog, '承运商（可选）'), 'DHL'],
    [byLabel(dialog, '运单号（可选）'), 'TRACK-42'],
    [byLabel(dialog, '预计到货时间 ETA'), '2026-09-19T16:45'],
    [byLabel(dialog, '原始核验依据'), 'BOL-42'],
    [byLabel(dialog, '核验原因'), '核对承运商提单'],
    [byAria(dialog, '测试阀门 本次数量'), '75'],
  ]);
}

async function fillTransport(act: Act, dialog: HTMLElement): Promise<void> {
  await setValues(act, [
    [byLabel(dialog, '关联 Shipment'), 'shipment:page'],
    [byLabel(dialog, '节点类型'), 'arrived_port'],
    [byLabel(dialog, '实际发生时间'), '2026-09-20T11:15'],
    [byLabel(dialog, '节点证据编号'), 'TRACK-EVT-42'],
    [byLabel(dialog, '位置（可选）'), '上海港'],
    [byLabel(dialog, '承运商参考号'), 'CARRIER-EVT-42'],
    [byLabel(dialog, '更新后的 ETA'), '2026-09-22T18:00'],
    [byLabel(dialog, '原始核验依据'), 'CARRIER-PAGE-42'],
    [byLabel(dialog, '核验原因'), '核对承运商轨迹'],
  ]);
}

async function fillReceipt(act: Act, dialog: HTMLElement): Promise<void> {
  await setValues(act, [
    [byLabel(dialog, 'GRN / 收货单号'), 'GRN-42'],
    [byLabel(dialog, '仓库标识'), 'warehouse:shanghai'],
    [byLabel(dialog, '关联发运单'), 'shipment:page'],
    [byLabel(dialog, '原始核验依据'), 'WMS-RECEIPT-42'],
    [byLabel(dialog, '核验原因'), '核对仓库签收'],
    [byAria(dialog, '测试阀门 本次数量'), '80'],
  ]);
}

function evidenceCase(kind: EvidenceKind): EvidenceCase {
  const fixture = fixtureFor(kind);
  if (kind === 'confirmation') return {
    kind, fixture, actionLabel: /^从供应商回复登记确认$/, endpoint: '/api/procurement/execution/record_confirmation',
    idempotencyKey: 'web-po:record-confirmation:po:page:v4', fill: fillConfirmation,
    expectedBody: { aggregateId: 'po:page', expectedVersion: 4, supplierReference: 'message:chosen', lines: [{ poLineId: 'line:page', quantity: 180, unitPrice: 129.5, promisedAt: '2026-09-21' }] },
    invalidate: async (act, dialog) => { await setValues(act, [[byAria(dialog, '测试阀门 供应商确认数量'), '']]); return /大于 0.*确认数量/; },
    snapshot: (dialog) => currentValues(dialog, ['原始入站回复'], ['测试阀门 供应商确认数量', '测试阀门 供应商确认单价', '测试阀门 供应商承诺交期']),
    revokePermission: (target) => { target.workbench.permissions.operate = false; },
  };
  if (kind === 'production') return {
    kind, fixture, actionLabel: /^核验生产 \/ 备货进度$/, endpoint: '/api/procurement/execution/record_production_progress',
    idempotencyKey: 'web-po:record-production-progress:po:page:v4', fill: fillProduction,
    expectedBody: { aggregateId: 'po:page', expectedVersion: 4, supplierReference: 'PROGRESS-42', evidenceReference: 'EMAIL-MSG-42', reason: '已核验供应商周报', lines: [{ poLineId: 'line:page', quantity: 120, completionPercent: 60, progressStatus: 'quality_check', expectedReadyAt: '2026-09-18T01:30:00.000Z', note: '装配正在进行' }] },
    invalidate: async (act, dialog) => { await setValues(act, [[byAria(dialog, '测试阀门 完成度'), '101']]); return /0–100%/; },
    snapshot: (dialog) => currentValues(dialog, ['进度证据编号', '本次状态', '预计可发运时间', '供应商说明', '原始核验依据', '核验原因'], ['测试阀门 完成数量', '测试阀门 完成度']),
    revokePermission: (target) => { target.workbench.permissions.approve = false; },
  };
  if (kind === 'shipment') return {
    kind, fixture, actionLabel: /^核验并记录发运 \/ ASN$/, endpoint: '/api/procurement/execution/record_shipment',
    idempotencyKey: 'web-po:record-shipment:po:page:v4', fill: fillShipment,
    expectedBody: { aggregateId: 'po:page', expectedVersion: 4, supplierReference: 'ASN-42', evidenceReference: 'BOL-42', reason: '核对承运商提单', lines: [{ poLineId: 'line:page', quantity: 75 }], carrier: 'DHL', trackingNumber: 'TRACK-42', estimatedArrivalAt: '2026-09-19T08:45:00.000Z' },
    invalidate: async (act, dialog) => { await setValues(act, [[byAria(dialog, '测试阀门 本次数量'), '201']]); return /不能超过/; },
    snapshot: (dialog) => currentValues(dialog, ['ASN / 发运单号', '承运商（可选）', '运单号（可选）', '预计到货时间 ETA', '原始核验依据', '核验原因'], ['测试阀门 本次数量']),
    revokePermission: (target) => { target.workbench.permissions.approve = false; },
  };
  if (kind === 'transport') return {
    kind, fixture, actionLabel: /^核验并记录运输节点$/, endpoint: '/api/procurement/execution/record_transport_event',
    idempotencyKey: 'web-po:record-transport-event:po:page:v4', fill: fillTransport,
    expectedBody: { aggregateId: 'po:page', expectedVersion: 4, shipmentId: 'shipment:page', eventCode: 'arrived_port', eventReference: 'TRACK-EVT-42', eventOccurredAt: '2026-09-20T03:15:00.000Z', evidenceReference: 'CARRIER-PAGE-42', reason: '核对承运商轨迹', location: '上海港', carrierReference: 'CARRIER-EVT-42', estimatedArrivalAt: '2026-09-22T10:00:00.000Z' },
    invalidate: async (act, dialog) => { await setValues(act, [[byLabel(dialog, '节点证据编号'), '']]); return /运输节点证据编号/; },
    snapshot: (dialog) => currentValues(dialog, ['关联 Shipment', '节点类型', '实际发生时间', '节点证据编号', '位置（可选）', '承运商参考号', '更新后的 ETA', '原始核验依据', '核验原因']),
    revokePermission: (target) => { target.workbench.permissions.approve = false; },
  };
  return {
    kind, fixture, actionLabel: /^核验并记录到货 \/ GRN$/, endpoint: '/api/procurement/execution/record_receipt',
    idempotencyKey: 'web-po:record-receipt:po:page:v4', fill: fillReceipt,
    expectedBody: { aggregateId: 'po:page', expectedVersion: 4, supplierReference: 'GRN-42', evidenceReference: 'WMS-RECEIPT-42', reason: '核对仓库签收', lines: [{ poLineId: 'line:page', quantity: 80 }], warehouseId: 'warehouse:shanghai', shipmentId: 'shipment:page' },
    invalidate: async (act, dialog) => { await setValues(act, [[byLabel(dialog, '仓库标识'), '']]); return /仓库.*标识/; },
    snapshot: (dialog) => currentValues(dialog, ['GRN / 收货单号', '仓库标识', '关联发运单', '原始核验依据', '核验原因'], ['测试阀门 本次数量']),
    revokePermission: (target) => { target.workbench.permissions.approve = false; },
  };
}

async function openFilledForm(entry: EvidenceCase, act: Act, button: (pattern: RegExp, scope?: ParentNode) => HTMLButtonElement): Promise<HTMLElement> {
  await act(async () => button(entry.actionLabel).click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="confirm-action-title"]');
  assert.ok(dialog, `${entry.kind} evidence dialog did not open`);
  await entry.fill(act, dialog);
  return dialog;
}

const evidenceKinds: EvidenceKind[] = ['confirmation', 'production', 'shipment', 'transport', 'receipt'];

// Mutation caught: any form routes to the wrong endpoint, drops a field, uses stale PO version,
// or omits its stable idempotency identity.
for (const kind of evidenceKinds) {
  test(`${kind} evidence form submits its complete reviewed payload`, async () => {
    const entry = evidenceCase(kind);
    await withPoPage({ fixture: entry.fixture, fetch(path, init) {
      if (path === entry.endpoint && init?.method === 'POST') return jsonResponse({ aggregate: { id: 'po:page', version: 5 } });
    } }, async ({ act, button, requests }) => {
      const dialog = await openFilledForm(entry, act, button);
      await act(async () => button(/^确认事实并保存$/, dialog).click());
      assert.deepEqual(requests, [{ path: entry.endpoint, body: entry.expectedBody, key: entry.idempotencyKey }]);
      assert.equal(document.querySelector('#confirm-action-title'), null, 'successful persisted readback closes the reviewed form');
    });
  });
}

// Mutation caught: removing a client-side guard sends incomplete or impossible evidence,
// or a failed guard resets fields that the operator already reviewed.
for (const kind of evidenceKinds) {
  test(`${kind} evidence validation blocks POST and preserves every reviewed input`, async () => {
    const entry = evidenceCase(kind);
    await withPoPage({ fixture: entry.fixture }, async ({ act, button, requests }) => {
      const dialog = await openFilledForm(entry, act, button);
      const expectedError = await entry.invalidate(act, dialog);
      const beforeSubmit = entry.snapshot(dialog);
      await act(async () => button(/^确认事实并保存$/, dialog).click());
      assert.equal(requests.length, 0, 'invalid evidence must never cross the HTTP boundary');
      assert.match(dialog.textContent ?? '', expectedError);
      assert.deepEqual(entry.snapshot(dialog), beforeSubmit, 'validation feedback must not erase reviewed or invalid input');
    });
  });
}

// Mutation caught: closing/reinitializing a form on an authoritative rejection loses operator work.
for (const status of [409, 422] as const) {
  for (const kind of evidenceKinds) {
    test(`${kind} evidence preserves reviewed input after HTTP ${status}`, async () => {
      const entry = evidenceCase(kind);
      const serverError = `后端拒绝 ${kind} evidence`;
      await withPoPage({ fixture: entry.fixture, fetch(path, init) {
        if (path === entry.endpoint && init?.method === 'POST') return jsonResponse({ error: serverError }, status);
      } }, async ({ act, button, requests }) => {
        const dialog = await openFilledForm(entry, act, button);
        const beforeSubmit = entry.snapshot(dialog);
        await act(async () => button(/^确认事实并保存$/, dialog).click());
        assert.deepEqual(requests, [{ path: entry.endpoint, body: entry.expectedBody, key: entry.idempotencyKey }]);
        assert.ok(document.querySelector('#confirm-action-title'), 'rejected evidence must stay open for correction or safe retry');
        assert.deepEqual(entry.snapshot(dialog), beforeSubmit, `HTTP ${status} must preserve all reviewed input`);
        assert.match(dialog.textContent ?? '', status === 409 ? /版本或状态已变化/ : new RegExp(serverError));
      });
    });
  }
}

// Mutation caught: removing the submission latch permits duplicate evidence facts with one identity.
for (const kind of evidenceKinds) {
  test(`${kind} evidence disables re-entry while its POST is in flight`, async () => {
    const entry = evidenceCase(kind);
    let pending: ReturnType<typeof deferredResponse> | undefined;
    await withPoPage({ fixture: entry.fixture, fetch(path, init) {
      if (path === entry.endpoint && init?.method === 'POST') {
        pending = deferredResponse(init.signal);
        return pending.promise;
      }
    } }, async ({ act, button, requests }) => {
      const dialog = await openFilledForm(entry, act, button);
      const submit = button(/^确认事实并保存$/, dialog);
      await act(async () => submit.click());
      assert.equal(requests.length, 1);
      const waiting = button(/^等待后端确认…$/, dialog);
      assert.equal(waiting.disabled, true, 'pending evidence disables the submit control');
      await act(async () => waiting.click());
      assert.equal(requests.length, 1, 'a second activation must not create another POST');
      await act(async () => pending!.resolve(jsonResponse({ aggregate: { id: 'po:page', version: 5 } })));
      assert.equal(document.querySelector('#confirm-action-title'), null);
    });
  });
}

// Mutation caught: treating an opened dialog as an authority grant lets stale users submit after revocation.
for (const kind of evidenceKinds) {
  test(`${kind} evidence rechecks live permission before POST`, async () => {
    const entry = evidenceCase(kind);
    await withPoPage({ fixture: entry.fixture, fetch(_path, init) {
      if (init?.method === 'POST') return jsonResponse({ error: '服务器权限门禁' }, 403);
    } }, async ({ act, button, realtime, requests }) => {
      const dialog = await openFilledForm(entry, act, button);
      const beforeRevocation = entry.snapshot(dialog);
      entry.revokePermission(entry.fixture);
      await realtime();
      await act(async () => button(/^确认事实并保存$/, dialog).click());
      assert.equal(requests.length, 0, 'revoked authority must fail closed before the HTTP boundary');
      assert.match(dialog.textContent ?? '', /权限或订单状态已变化/);
      assert.deepEqual(entry.snapshot(dialog), beforeRevocation, 'permission denial must retain reviewed evidence');
    });
  });
}
