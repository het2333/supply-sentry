import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PurchaseOrder, PurchaseOrderLine } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { ToolRegistry } from '@readywork/tools';
import { ConnectorControlPlane } from '../src/connector-control-plane.js';
import { processSignedProcurementWebhook, type SignedWebhookInput } from '../src/procurement-webhook.js';

const at = '2026-08-21T00:00:00.000Z';

function po(tenantId: string): PurchaseOrder {
  return {
    id: 'po:webhook', tenantId, sourceSystem: 'erp', externalId: 'PO-WEBHOOK', status: 'created',
    createdAt: at, updatedAt: at, supplierId: 'supplier:1', currency: 'CNY', orderedAt: at,
  };
}

function poLine(id: string, lineNumber: string): PurchaseOrderLine {
  return {
    id, poId: 'po:webhook', lineNumber, itemId: `item:${lineNumber}`, uom: 'EA',
    orderedQty: 100, unitPrice: 10, currency: 'CNY',
  };
}

function signedWebhook(payload: Record<string, unknown>, secret: string, signature?: string): SignedWebhookInput {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    payload,
    headers: {},
    signature: signature ?? createHmac('sha256', secret).update(rawBody).digest('hex'),
  };
}

test('已签名 Connector webhook: 五类 PO 行事实、幂等、隔离与错误边界', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-procurement-webhook-'));
  const previousKey = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'readywork-procurement-webhook-test-key';
  const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:bootstrap' });
  const tenantA = 'tenant:webhook-a';
  const tenantB = 'tenant:webhook-b';
  const secretA = 'webhook-secret-a';
  const secretB = 'webhook-secret-b';
  const credentialA = 'credential:webhook:a';
  const credentialB = 'credential:webhook:b';
  const controlA = new ConnectorControlPlane(store.db, new ToolRegistry(), tenantA);
  const controlB = new ConnectorControlPlane(store.db, new ToolRegistry(), tenantB);

  try {
    await controlA.install('webhook');
    await controlB.install('webhook');
    controlA.putCredential({ id: credentialA, connectorId: 'webhook', credentialType: 'webhookSecret', name: 'A Webhook', value: { secret: secretA } });
    controlB.putCredential({ id: credentialB, connectorId: 'webhook', credentialType: 'webhookSecret', name: 'B Webhook', value: { secret: secretB } });

    const repositoryA = createProcurementRepository(store.db, tenantA);
    repositoryA.saveDocument('purchase_order', po(tenantA));
    for (const [index, id] of ['po-line:mapped', 'po-line:out-of-order', 'po-line:idempotent'].entries()) {
      repositoryA.saveLine('purchase_order_line', 'po:webhook', poLine(id, String((index + 1) * 10)));
    }

    const process = (
      control: ConnectorControlPlane,
      tenantId: string,
      credentialId: string,
      webhook: SignedWebhookInput,
    ) => processSignedProcurementWebhook({ db: store.db, tenantId, credentialId, verifier: control, webhook });

    await t.test('签名失败或租户凭据路径不匹配时绝不落账', async () => {
      const payload = { type: 'po_line.confirmed', poLineId: 'po-line:mapped', sourceEventId: 'bad-signature', delta: 10, occurredAt: at };
      const rejected = await process(controlA, tenantA, credentialA, signedWebhook(payload, secretA, '0'.repeat(64)));
      assert.equal(rejected.status, 401);
      assert.equal(repositoryA.getPurchaseOrderLineQuantityProjection('po-line:mapped'), undefined);

      const wrongTenantCredential = await process(controlB, tenantB, credentialA, signedWebhook(payload, secretA));
      assert.equal(wrongTenantCredential.status, 401);
      assert.equal(repositoryA.getPurchaseOrderLineQuantityProjection('po-line:mapped'), undefined);
    });

    await t.test('未知事件仍作为通用 webhook 接收，且敏感载荷被脱敏、不改账本', async () => {
      const unknown = await process(controlA, tenantA, credentialA, signedWebhook({
        type: 'po.updated', poLineId: 'po-line:mapped', apiKey: 'do-not-leak',
      }, secretA));
      assert.equal(unknown.status, 202);
      assert.equal(repositoryA.getPurchaseOrderLineQuantityProjection('po-line:mapped'), undefined);
      assert.equal(JSON.stringify(unknown.body).includes('do-not-leak'), false);
    });

    await t.test('明确事件缺字段、零数量或无效日期返回 422', async () => {
      const invalidPayloads = [
        { type: 'po_line.confirmed', sourceEventId: 'missing-line', delta: 1, occurredAt: at },
        { type: 'po_line.confirmed', poLineId: 'po-line:mapped', sourceEventId: '', delta: 1, occurredAt: at },
        { type: 'po_line.confirmed', poLineId: 'po-line:mapped', sourceEventId: 'zero', delta: 0, occurredAt: at },
        { type: 'po_line.confirmed', poLineId: 'po-line:mapped', sourceEventId: 'nan', delta: 'NaN', occurredAt: at },
        { type: 'po_line.confirmed', poLineId: 'po-line:mapped', sourceEventId: 'date', delta: 1, occurredAt: 'not-a-date' },
      ];
      for (const payload of invalidPayloads) {
        const result = await process(controlA, tenantA, credentialA, signedWebhook(payload, secretA));
        assert.equal(result.status, 422, JSON.stringify(result.body));
        assert.equal(result.body['code'], 'INVALID_QUANTITY_EVENT');
      }
      assert.equal(repositoryA.getPurchaseOrderLineQuantityProjection('po-line:mapped'), undefined);
    });

    await t.test('五类事件按规范维度累计并返回 projection 与 issues', async () => {
      const cases = [
        ['po_line.confirmed', 'confirmedQty', 10],
        ['shipment.line_recorded', 'shippedQty', 8],
        ['receipt.line_recorded', 'receivedQty', 7],
        ['invoice.line_recorded', 'invoicedQty', 6],
        ['po_line.cancelled', 'cancelledQty', 2],
      ] as const;
      for (const [type, field, delta] of cases) {
        const result = await process(controlA, tenantA, credentialA, signedWebhook({
          type, poLineId: 'po-line:mapped', sourceSystem: 'Odoo ERP', sourceEventId: `mapped:${type}`,
          delta, occurredAt: at,
        }, secretA));
        assert.equal(result.status, 202, JSON.stringify(result.body));
        assert.equal(result.body['applied'], true);
        assert.equal((result.body['projection'] as Record<string, unknown>)[field], delta);
        assert.ok(Array.isArray(result.body['issues']));
      }
      const projection = repositoryA.getPurchaseOrderLineQuantityProjection('po-line:mapped');
      assert.deepEqual(
        [projection?.confirmedQty, projection?.shippedQty, projection?.receivedQty, projection?.invoicedQty, projection?.cancelledQty],
        [10, 8, 7, 6, 2],
      );
      assert.equal(projection?.events[0]?.sourceSystem, 'odoo-erp');
    });

    await t.test('未确认先发运、无 ASN 收货和发票先到均保留事实并返回 issue', async () => {
      const events = [
        { type: 'invoice.line_recorded', sourceEventId: 'early:invoice', delta: 20 },
        { type: 'receipt.line_recorded', sourceEventId: 'early:receipt', delta: 25 },
        { type: 'shipment.line_recorded', sourceEventId: 'early:shipment', delta: 30 },
      ];
      const issueCodes = new Set<string>();
      for (const event of events) {
        const result = await process(controlA, tenantA, credentialA, signedWebhook({
          ...event, poLineId: 'po-line:out-of-order', occurredAt: at,
        }, secretA));
        assert.equal(result.status, 202);
        for (const issue of result.body['issues'] as Array<{ code: string }>) issueCodes.add(issue.code);
      }
      const projection = repositoryA.getPurchaseOrderLineQuantityProjection('po-line:out-of-order');
      assert.deepEqual([projection?.shippedQty, projection?.receivedQty, projection?.invoicedQty], [30, 25, 20]);
      assert.ok(issueCodes.has('invoiced_exceeds_received'));
      assert.ok(issueCodes.has('received_exceeds_shipped'));
      assert.ok(issueCodes.has('shipped_exceeds_confirmed'));
    });

    await t.test('并发重复只落账一次，同键异载荷返回 409', async () => {
      const event = { type: 'po_line.confirmed', poLineId: 'po-line:idempotent', sourceEventId: 'event:same', delta: 40, occurredAt: at };
      const webhook = signedWebhook(event, secretA);
      const results = await Promise.all([
        process(controlA, tenantA, credentialA, webhook),
        process(controlA, tenantA, credentialA, webhook),
      ]);
      assert.deepEqual(results.map((result) => result.status), [202, 202]);
      assert.deepEqual(results.map((result) => result.body['applied']).sort(), [false, true]);
      assert.equal(repositoryA.getPurchaseOrderLineQuantityProjection('po-line:idempotent')?.events.length, 1);

      const conflict = await process(controlA, tenantA, credentialA, signedWebhook({ ...event, delta: 41 }, secretA));
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body['code'], 'QUANTITY_EVENT_CONFLICT');
      assert.equal(repositoryA.getPurchaseOrderLineQuantityProjection('po-line:idempotent')?.confirmedQty, 40);
    });

    await t.test('跨租户或未知 PO 行统一返回 404，且响应不泄露敏感 ID', async () => {
      const sensitiveLineId = 'po-line:idempotent?token=do-not-return';
      const crossTenant = await process(controlB, tenantB, credentialB, signedWebhook({
        type: 'po_line.confirmed', poLineId: sensitiveLineId, sourceEventId: 'tenant-b:event', delta: 5, occurredAt: at,
      }, secretB));
      assert.equal(crossTenant.status, 404);
      assert.equal(crossTenant.body['code'], 'PO_LINE_NOT_FOUND');
      assert.equal(JSON.stringify(crossTenant.body).includes('do-not-return'), false);
      assert.equal(repositoryA.getPurchaseOrderLineQuantityProjection('po-line:idempotent')?.confirmedQty, 40);
      assert.equal(createProcurementRepository(store.db, tenantB).getPurchaseOrderLineQuantityProjection(sensitiveLineId), undefined);
    });
  } finally {
    store.close();
    if (previousKey === undefined) delete process.env['READYWORK_CREDENTIAL_KEY'];
    else process.env['READYWORK_CREDENTIAL_KEY'] = previousKey;
    rmSync(dir, { recursive: true, force: true });
  }
});
