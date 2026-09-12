import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { PurchaseOrder, Supplier } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { ToolRegistry } from '@readywork/tools';
import { ConnectorControlPlane } from '../src/connector-control-plane.js';
import { processWhatsAppWebhook, verifyWhatsAppWebhookSubscription } from '../src/procurement-whatsapp-webhook.js';
import { normalizeWhatsAppRecipient, WhatsAppCloudApiClient } from '../src/whatsapp-cloud.js';

const credentials = {
  phoneNumberId: '123456789', businessAccountId: '987654321', accessToken: 'test-access-token',
  appSecret: 'test-app-secret', verifyToken: 'test-verify-token', apiVersion: 'v23.0',
  templateName: 'purchase_order_followup', languageCode: 'zh_CN',
  templateParameterKeys: ['po_number', 'supplier_name', 'message'],
};

test('WhatsApp Cloud 客户端只发送已配置模板，并保存 Meta message id 契约', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).includes('/message_templates?')) return new Response(JSON.stringify({ data: [{
      name: 'purchase_order_followup', language: 'zh_CN', status: 'APPROVED',
      components: [{ type: 'BODY', text: 'PO {{1}} / {{2}} / {{3}}' }],
    }] }), { status: 200 });
    if (String(url).endsWith('/messages')) return new Response(JSON.stringify({ messages: [{ id: 'wamid.test-1' }] }), { status: 200 });
    return new Response(JSON.stringify({ id: '123456789', display_phone_number: '+86 138 0000 0000' }), { status: 200 });
  }) as typeof fetch;
  const client = new WhatsAppCloudApiClient(credentials, fakeFetch);
  const health = await client.healthCheck();
  assert.equal(health.parameterCount, 3);
  const sent = await client.sendTemplate({ to: '+86 138-0000-0000', poNumber: 'PO-1001', supplierName: '供应商甲', message: '请确认交期', idempotencyKey: 'draft:test' });
  assert.equal(sent.messageId, 'wamid.test-1');
  const payload = JSON.parse(String(calls[2]?.init?.body)) as Record<string, any>;
  assert.equal(payload['to'], '8613800000000');
  assert.equal(payload['type'], 'template');
  assert.deepEqual(payload['template']['components'][0]['parameters'].map((item: Record<string, unknown>) => item['text']), ['PO-1001', '供应商甲', '请确认交期']);
  assert.equal(normalizeWhatsAppRecipient('+86 (138) 0000-0000'), '8613800000000');
  assert.throws(() => normalizeWhatsAppRecipient('138'), /8-15/);
});

test('WhatsApp Webhook 强制签名、幂等保存状态，并只按可信 context 关联 PO 回复', () => {
  const previousKey = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'readywork-whatsapp-test-key-long-enough';
  const store = openPersistence(':memory:', { tenantId: 'tenant:whatsapp' });
  try {
    const tenantId = 'tenant:whatsapp';
    const control = new ConnectorControlPlane(store.db, new ToolRegistry(), tenantId);
    control.putCredential({ id: 'credential:whatsapp', connectorId: 'whatsapp', credentialType: 'whatsappBusinessCredential', name: 'Meta 测试凭据', value: credentials });
    assert.deepEqual(verifyWhatsAppWebhookSubscription({
      controlPlane: control, credentialId: 'credential:whatsapp', mode: 'subscribe', verifyToken: credentials.verifyToken, challenge: 'challenge-123',
    }), { status: 200, challenge: 'challenge-123' });
    assert.equal(verifyWhatsAppWebhookSubscription({
      controlPlane: control, credentialId: 'credential:whatsapp', mode: 'subscribe', verifyToken: 'wrong', challenge: 'challenge-123',
    }).status, 403);

    const repository = createProcurementRepository(store.db, tenantId);
    const at = '2026-08-28T00:00:00.000Z';
    const supplier: Supplier = {
      id: 'supplier:wa', tenantId, sourceSystem: 'odoo', externalId: 'SUP-WA', status: 'active', createdAt: at, updatedAt: at,
      name: '真实 WhatsApp 供应商', currency: 'CNY', contacts: [{ id: 'contact:wa', name: '王经理', phone: '+86 138 0000 0000', primary: true }],
    };
    const po: PurchaseOrder = {
      id: 'po:wa', tenantId, sourceSystem: 'odoo', externalId: 'PO-WA', status: 'sent', createdAt: at, updatedAt: at,
      supplierId: supplier.id, currency: 'CNY', orderedAt: at,
    };
    repository.saveDocument('supplier', supplier);
    repository.saveDocument('purchase_order', po);
    store.db.prepare(`INSERT INTO procurement_message_drafts
      (tenant_id,id,purchase_order_id,supplier_id,channel,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at,sent_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId, 'draft:wa', po.id, supplier.id, 'whatsapp', '8613800000000', '内部摘要', '请确认 PO', 'acknowledgement_followup',
      'trigger:wa', '{}', 'sent', 2, 'ai:procurement', at, at, at,
    );
    store.db.prepare(`INSERT INTO procurement_whatsapp_delivery_events
      (tenant_id,event_fingerprint,provider_message_id,draft_id,outbox_id,status,occurred_at,raw_hash,created_at)
      VALUES (?,?,?,?,?,'accepted',?,?,?)`).run(tenantId, 'accepted:fingerprint', 'wamid.outbound-1', 'draft:wa', null, at, 'hash', at);

    const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
      statuses: [{ id: 'wamid.outbound-1', status: 'delivered', timestamp: '1787875200' }],
      messages: [{ from: '8613800000000', id: 'wamid.inbound-1', timestamp: '1787875260', type: 'text', context: { id: 'wamid.outbound-1' }, text: { body: '已确认，按期发货。' } }],
    } }] }] };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${createHmac('sha256', credentials.appSecret).update(rawBody).digest('hex')}`;
    const denied = processWhatsAppWebhook({ db: store.db, tenantId, credentialId: 'credential:whatsapp', controlPlane: control, rawBody, signature: 'sha256=' + '0'.repeat(64) });
    assert.equal(denied.status, 401);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_whatsapp_inbound_messages').get() as { count: number }).count, 0);

    const accepted = processWhatsAppWebhook({ db: store.db, tenantId, credentialId: 'credential:whatsapp', controlPlane: control, rawBody, signature });
    assert.deepEqual(accepted.body, { ok: true, deliveryEvents: 1, inboundMessages: 1, linkedMessages: 1 });
    const replay = processWhatsAppWebhook({ db: store.db, tenantId, credentialId: 'credential:whatsapp', controlPlane: control, rawBody, signature });
    assert.deepEqual(replay.body, { ok: true, deliveryEvents: 0, inboundMessages: 0, linkedMessages: 0 });
    const inbound = store.db.prepare('SELECT po_id,supplier_id,body FROM procurement_whatsapp_inbound_messages WHERE tenant_id=? AND provider_message_id=?')
      .get(tenantId, 'wamid.inbound-1') as { po_id: string; supplier_id: string; body: string };
    assert.equal(inbound.po_id, po.id);
    assert.equal(inbound.supplier_id, supplier.id);
    assert.equal(inbound.body, '已确认，按期发货。');
    const communication = store.db.prepare("SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='communication' AND external_id=?")
      .get(tenantId, 'wamid.inbound-1') as { json: string };
    const parsed = JSON.parse(communication.json) as Record<string, unknown>;
    assert.equal(parsed['businessObjectId'], po.id);
    assert.equal(parsed['channel'], 'whatsapp');

    const unmatchedPayload = { entry: [{ changes: [{ value: { messages: [{ from: '8613900000000', id: 'wamid.inbound-unmatched', timestamp: '1787875300', type: 'text', text: { body: '没有上下文' } }] } }] }] };
    const unmatchedBody = Buffer.from(JSON.stringify(unmatchedPayload));
    const unmatchedSignature = `sha256=${createHmac('sha256', credentials.appSecret).update(unmatchedBody).digest('hex')}`;
    const unmatched = processWhatsAppWebhook({ db: store.db, tenantId, credentialId: 'credential:whatsapp', controlPlane: control, rawBody: unmatchedBody, signature: unmatchedSignature });
    assert.deepEqual(unmatched.body, { ok: true, deliveryEvents: 0, inboundMessages: 1, linkedMessages: 0 });
    const row = store.db.prepare('SELECT po_id,supplier_id FROM procurement_whatsapp_inbound_messages WHERE tenant_id=? AND provider_message_id=?')
      .get(tenantId, 'wamid.inbound-unmatched') as { po_id: null; supplier_id: null };
    assert.equal(row.po_id, null);
    assert.equal(row.supplier_id, null);
  } finally {
    store.close();
    if (previousKey === undefined) delete process.env['READYWORK_CREDENTIAL_KEY']; else process.env['READYWORK_CREDENTIAL_KEY'] = previousKey;
  }
});
