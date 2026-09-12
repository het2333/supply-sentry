import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { act as reactAct } from 'react';
import { poPageFixture, withPoPage } from './helpers/po-page-harness.js';
import {
  REAL_EVIDENCE_MANAGER_ID,
  REAL_EVIDENCE_TENANT_ID,
  realEvidenceIds,
  startRealEvidenceApiFixture,
  type PersistedEvidenceKind,
} from './helpers/po-evidence-real-api-fixture.js';

type Act = typeof reactAct;
type JsonObject = Record<string, unknown>;

type PersistenceCase = {
  kind: PersistedEvidenceKind;
  actionLabel: RegExp;
  documentGroup: 'confirmations' | 'productionProgress' | 'shipments' | 'transportEvents' | 'receipts';
  documentKind: 'confirmation' | 'production_progress' | 'shipment' | 'transport_event' | 'receipt';
  externalId?: string;
  evidenceReference?: string;
  expectedPoVersion: number;
  expectedPoStatus: string;
  remountTab: 'supplier' | 'documents';
  renderedEvidence: RegExp;
  fill: (act: Act, dialog: HTMLElement, lineLabel: string, seededShipmentId?: string) => Promise<void>;
  assertLines: (context: JsonObject, document: JsonObject) => void;
};

function byLabel(scope: ParentNode, text: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const label = [...scope.querySelectorAll('label')].find((entry) => (entry.textContent ?? '').includes(text));
  assert.ok(label, `missing label containing ${text}`);
  const control = label.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select');
  assert.ok(control, `missing control for label ${text}`);
  return control;
}

function byAria(scope: ParentNode, label: string): HTMLInputElement {
  const input = [...scope.querySelectorAll<HTMLInputElement>('input[aria-label]')]
    .find((entry) => entry.getAttribute('aria-label') === label);
  assert.ok(input, `missing input with aria-label ${label}`);
  return input;
}

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

function contextLines(context: JsonObject, documentId: unknown): JsonObject[] {
  assert.equal(typeof documentId, 'string');
  if (typeof documentId !== 'string') throw new TypeError('document id must be a string');
  const linesByDocument = context['linesByDocument'] as Record<string, JsonObject[]>;
  const lines = linesByDocument[documentId];
  assert.ok(Array.isArray(lines), `authoritative context omitted lines for ${documentId}`);
  return lines;
}

async function waitForDom(act: Act, predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  assert.ok(predicate(), message);
}

const fillConfirmation: PersistenceCase['fill'] = async (act, dialog, lineLabel) => {
  await setValues(act, [
    [byLabel(dialog, '原始入站回复'), 'communication:test:evidence-ui:confirmation'],
    [byAria(dialog, `${lineLabel} 供应商确认数量`), '200'],
    [byAria(dialog, `${lineLabel} 供应商确认单价`), '127'],
    [byAria(dialog, `${lineLabel} 供应商承诺交期`), '2026-09-20'],
  ]);
};

const fillProduction: PersistenceCase['fill'] = async (act, dialog, lineLabel) => {
  await setValues(act, [
    [byLabel(dialog, '进度证据编号'), 'PROGRESS-UI-PERSISTED'],
    [byLabel(dialog, '本次状态'), 'quality_check'],
    [byLabel(dialog, '预计可发运时间'), '2026-09-18T09:30'],
    [byLabel(dialog, '供应商说明'), '隔离测试质检中'],
    [byLabel(dialog, '原始核验依据'), 'mail:progress-ui-persisted'],
    [byLabel(dialog, '核验原因'), '采购经理已核对隔离测试周报'],
    [byAria(dialog, `${lineLabel} 完成数量`), '120'],
    [byAria(dialog, `${lineLabel} 完成度`), '60'],
  ]);
};

const fillShipment: PersistenceCase['fill'] = async (act, dialog, lineLabel) => {
  await setValues(act, [
    [byLabel(dialog, 'ASN / 发运单号'), 'ASN-UI-PERSISTED'],
    [byLabel(dialog, '承运商（可选）'), 'DHL-TEST'],
    [byLabel(dialog, '运单号（可选）'), 'TRACK-UI-PERSISTED'],
    [byLabel(dialog, '预计到货时间 ETA'), '2026-09-19T16:45'],
    [byLabel(dialog, '原始核验依据'), 'bol:shipment-ui-persisted'],
    [byLabel(dialog, '核验原因'), '采购经理已核对隔离测试提单'],
    [byAria(dialog, `${lineLabel} 本次数量`), '75'],
  ]);
};

const fillTransport: PersistenceCase['fill'] = async (act, dialog, _lineLabel, seededShipmentId) => {
  assert.ok(seededShipmentId);
  await setValues(act, [
    [byLabel(dialog, '关联 Shipment'), seededShipmentId],
    [byLabel(dialog, '节点类型'), 'arrived_port'],
    [byLabel(dialog, '实际发生时间'), '2026-09-01T11:15'],
    [byLabel(dialog, '节点证据编号'), 'TRACK-EVT-UI-PERSISTED'],
    [byLabel(dialog, '位置（可选）'), '隔离测试上海港'],
    [byLabel(dialog, '承运商参考号'), 'CARRIER-EVT-UI-PERSISTED'],
    [byLabel(dialog, '更新后的 ETA'), '2026-09-22T18:00'],
    [byLabel(dialog, '原始核验依据'), 'carrier:transport-ui-persisted'],
    [byLabel(dialog, '核验原因'), '采购经理已核对隔离测试轨迹'],
  ]);
};

const fillReceipt: PersistenceCase['fill'] = async (act, dialog, lineLabel, seededShipmentId) => {
  assert.ok(seededShipmentId);
  await setValues(act, [
    [byLabel(dialog, 'GRN / 收货单号'), 'GRN-UI-PERSISTED'],
    [byLabel(dialog, '仓库标识'), 'warehouse:test:shanghai'],
    [byLabel(dialog, '关联发运单'), seededShipmentId],
    [byLabel(dialog, '原始核验依据'), 'wms:receipt-ui-persisted'],
    [byLabel(dialog, '核验原因'), '采购经理已核对隔离测试签收'],
    [byAria(dialog, `${lineLabel} 本次数量`), '40'],
  ]);
};

const persistenceCases: PersistenceCase[] = [
  {
    kind: 'confirmation', actionLabel: /^从供应商回复登记确认$/, documentGroup: 'confirmations', documentKind: 'confirmation',
    expectedPoVersion: 2, expectedPoStatus: 'confirmed', remountTab: 'supplier',
    renderedEvidence: /communication:test:evidence-ui:confirmation/, fill: fillConfirmation,
    assertLines(context, document) {
      assert.deepEqual(contextLines(context, document['id']).map((line) => ({
        poLineId: line['poLineId'], confirmedQty: line['confirmedQty'], confirmedUnitPrice: line['confirmedUnitPrice'], promisedAt: line['promisedAt'],
      })), [{ poLineId: realEvidenceIds.confirmation.lineId, confirmedQty: 200, confirmedUnitPrice: 127, promisedAt: '2026-09-20T00:00:00.000Z' }]);
    },
  },
  {
    kind: 'production', actionLabel: /^核验生产 \/ 备货进度$/, documentGroup: 'productionProgress', documentKind: 'production_progress',
    externalId: 'PROGRESS-UI-PERSISTED', evidenceReference: 'mail:progress-ui-persisted',
    expectedPoVersion: 2, expectedPoStatus: 'in_production', remountTab: 'documents', renderedEvidence: /PROGRESS-UI-PERSISTED/, fill: fillProduction,
    assertLines(context, document) {
      assert.deepEqual(contextLines(context, document['id']).map((line) => ({
        poLineId: line['poLineId'], completedQty: line['completedQty'], completionPercent: line['completionPercent'], progressStatus: line['progressStatus'], expectedReadyAt: line['expectedReadyAt'], note: line['note'],
      })), [{ poLineId: realEvidenceIds.production.lineId, completedQty: 120, completionPercent: 60, progressStatus: 'quality_check', expectedReadyAt: '2026-09-18T01:30:00.000Z', note: '隔离测试质检中' }]);
    },
  },
  {
    kind: 'shipment', actionLabel: /^核验并记录发运 \/ ASN$/, documentGroup: 'shipments', documentKind: 'shipment',
    externalId: 'ASN-UI-PERSISTED', evidenceReference: 'bol:shipment-ui-persisted',
    expectedPoVersion: 2, expectedPoStatus: 'partially_shipped', remountTab: 'documents', renderedEvidence: /ASN-UI-PERSISTED/, fill: fillShipment,
    assertLines(context, document) {
      assert.deepEqual(contextLines(context, document['id']).map((line) => ({ poLineId: line['poLineId'], shippedQty: line['shippedQty'] })),
        [{ poLineId: realEvidenceIds.shipment.lineId, shippedQty: 75 }]);
    },
  },
  {
    kind: 'transport', actionLabel: /^核验并记录运输节点$/, documentGroup: 'transportEvents', documentKind: 'transport_event',
    externalId: 'TRACK-EVT-UI-PERSISTED', evidenceReference: 'carrier:transport-ui-persisted',
    expectedPoVersion: 3, expectedPoStatus: 'partially_shipped', remountTab: 'documents', renderedEvidence: /TRACK-EVT-UI-PERSISTED/, fill: fillTransport,
    assertLines(context, document) {
      assert.equal(contextLines(context, document['id']).length, 0, 'transport facts are document-only');
    },
  },
  {
    kind: 'receipt', actionLabel: /^核验并记录到货 \/ GRN$/, documentGroup: 'receipts', documentKind: 'receipt',
    externalId: 'GRN-UI-PERSISTED', evidenceReference: 'wms:receipt-ui-persisted',
    expectedPoVersion: 3, expectedPoStatus: 'partially_received', remountTab: 'documents', renderedEvidence: /GRN-UI-PERSISTED/, fill: fillReceipt,
    assertLines(context, document) {
      assert.deepEqual(contextLines(context, document['id']).map((line) => ({ poLineId: line['poLineId'], receivedQty: line['receivedQty'] })),
        [{ poLineId: realEvidenceIds.receipt.lineId, receivedQty: 40 }]);
    },
  },
];

// Mutation caught: a form that only receives a canned 201 can appear correct while its payload
// is rejected, not committed, projected under the wrong tenant, or absent after a fresh mount.
test('all five PO evidence forms persist through the real API and survive a browser remount', async (t) => {
  const api = await startRealEvidenceApiFixture();
  try {
    for (const flow of persistenceCases) {
      await t.test(`${flow.kind} creates an authoritative SQLite fact that a remount renders`, async () => {
        const ids = realEvidenceIds[flow.kind];
        const lineLabel = `${flow.kind} 隔离测试阀门`;
        const seededShipmentId = api.seededShipmentIds[flow.kind];
        const syntheticFixture = poPageFixture();
        syntheticFixture.po.id = ids.poId;

        await withPoPage({ fixture: syntheticFixture, initialId: ids.poId, fetch: api.forwardFetch }, async ({ act, button, requests }) => {
          await waitForDom(
            act,
            () => [...document.querySelectorAll('button')].some((entry) => flow.actionLabel.test(entry.textContent ?? '')),
            `${flow.kind} action did not render from real workbench context`,
          );
          await act(async () => button(flow.actionLabel).click());
          const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="confirm-action-title"]');
          assert.ok(dialog, `${flow.kind} form did not open from real workbench context`);
          await flow.fill(act, dialog, lineLabel, seededShipmentId);
          await act(async () => {
            button(/^确认事实并保存$/, dialog).click();
          });
          await waitForDom(act, () => document.querySelector('#confirm-action-title') === null, 'real 201 plus persisted refresh did not close the form');
          assert.equal(document.querySelector('#confirm-action-title'), null, 'real 201 plus persisted refresh closes the form');
          assert.equal(requests.filter((request) => request.path.includes('/api/procurement/execution/')).length, 1);
        });

        const context = await api.readContext(ids.poId);
        const purchaseOrder = (context['purchaseOrders'] as JsonObject[]).find((item) => item['id'] === ids.poId);
        assert.ok(purchaseOrder);
        assert.equal(purchaseOrder['version'], flow.expectedPoVersion);
        assert.equal(purchaseOrder['status'], flow.expectedPoStatus);
        const documents = context[flow.documentGroup] as JsonObject[];
        const persistedContextDocument = flow.kind === 'confirmation'
          ? documents.find((item) => item['supplierReference'] === 'communication:test:evidence-ui:confirmation')
          : documents.find((item) => item['externalId'] === flow.externalId);
        assert.ok(persistedContextDocument, `authoritative GET omitted persisted ${flow.kind} document`);
        if (flow.kind === 'confirmation') {
          assert.equal(persistedContextDocument['status'], 'confirmed');
          assert.equal(persistedContextDocument['sourceSystem'], 'supplier');
        } else {
          assert.equal(persistedContextDocument['evidenceSource'], 'manual_verified');
          assert.equal(persistedContextDocument['evidenceReference'], flow.evidenceReference);
          assert.equal(persistedContextDocument['verifiedBy'], REAL_EVIDENCE_MANAGER_ID);
          assert.match(String(persistedContextDocument['verificationReason']), /隔离测试/);
        }
        flow.assertLines(context, persistedContextDocument);
        const persistedDocumentId = persistedContextDocument['id'];
        assert.equal(typeof persistedDocumentId, 'string');
        if (typeof persistedDocumentId !== 'string') throw new TypeError('persisted document id must be a string');

        const poRow = api.store.db.prepare(`SELECT version,status,json FROM procurement_documents
          WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(REAL_EVIDENCE_TENANT_ID, ids.poId) as { version: number; status: string; json: string } | undefined;
        assert.ok(poRow);
        assert.equal(poRow.version, flow.expectedPoVersion);
        assert.equal(poRow.status, flow.expectedPoStatus);
        const persistedDocument = api.store.db.prepare(`SELECT json FROM procurement_documents
          WHERE tenant_id=? AND kind=? AND id=?`).get(REAL_EVIDENCE_TENANT_ID, flow.documentKind, persistedDocumentId) as { json: string } | undefined;
        assert.ok(persistedDocument, 'the authoritative GET must be backed by the isolated SQLite row');
        assert.deepEqual(JSON.parse(persistedDocument.json), Object.fromEntries(Object.entries(persistedContextDocument).filter(([key]) => key !== 'version' && key !== 'lines')));

        await withPoPage({ fixture: syntheticFixture, initialId: ids.poId, tab: flow.remountTab, fetch: api.forwardFetch }, async ({ act }) => {
          await waitForDom(act, () => flow.renderedEvidence.test(document.body.textContent ?? ''), `fresh mount omitted persisted ${flow.kind} evidence`);
          assert.match(document.body.textContent ?? '', flow.renderedEvidence, 'a fresh component mount must render the persisted fact read from the real API');
        });
      });
    }

    const outboxCount = api.store.db.prepare('SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?')
      .get(REAL_EVIDENCE_TENANT_ID) as { count: number };
    assert.equal(outboxCount.count, 0, 'manual evidence flows must not enqueue or call a connector');
  } finally {
    await api.close();
  }
});
