import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Communication, PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import {
  handleProcurementMessageDraftRequest,
  hashDraftRecipient,
  maskDraftRecipient,
  normalizeDraftRecipient,
  queueApprovedMessageDraft,
} from '../src/procurement-message-drafts.js';
import { ProcurementOutboxWorker } from '../src/procurement-outbox-worker.js';
import { recordAdvancedSlaAutoSendDecision } from '../src/procurement-advanced-sla.js';

const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
function token(role: string, humanId: string, tenantId = 'tenant:drafts'): string {
  const session: Session = { username: humanId, tenantId, humanId, name: humanId, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

test('邮件草稿收件人: 邮箱与 WhatsApp 规范化、掩码和哈希保持确定性', () => {
  assert.equal(normalizeDraftRecipient('email', '  NEW.Recipient@REAL-SUPPLIER.CN  '), 'new.recipient@real-supplier.cn');
  assert.equal(maskDraftRecipient('email', 'new.recipient@real-supplier.cn'), 'n***@real-supplier.cn');
  assert.equal(hashDraftRecipient('new.recipient@real-supplier.cn'), '8ffef4e5d2f2e8a42aaea2b6dbf44a8d34ad6d8d48f90128eac63aecf957bd2e');
  assert.equal(normalizeDraftRecipient('whatsapp', '+86 (138) 0013-8000'), '+8613800138000');
  assert.equal(maskDraftRecipient('whatsapp', '+8613800138000'), '+86*******8000');
  for (const recipient of ['buyer@example.com', 'buyer@example.org', 'buyer@host.invalid', 'buyer@localhost', 'buyer@intranet.local']) {
    assert.throws(() => normalizeDraftRecipient('email', recipient), /收件人/);
  }
  for (const recipient of ['13800138000', '+1', '+1234567890123456', 'not-a-number']) {
    assert.throws(() => normalizeDraftRecipient('whatsapp', recipient), /收件人/);
  }
});

function seedIdentity(db: ReturnType<typeof openPersistence>['db'], tenantId = 'tenant:drafts', at = '2026-08-21T00:00:00.000Z'): void {
  db.prepare(`INSERT INTO procurement_communication_identities
    (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,'active',1,?,?,?,?)`).run(
    tenantId, '王经理', '采购经理', '东方工业有限公司', 'human:manager', 'human:manager', at, at,
  );
}

test('Message draft queue service replays an identical Advanced SLA correlation without duplicating its pinned Outbox row (catches correlation replay regressions)', () => {
  const tenantId = 'tenant:drafts:queue-replay'; const store = openPersistence(':memory:', { tenantId }); const createdAt = '2026-08-21T00:00:00.000Z';
  seedIdentity(store.db, tenantId, createdAt);
  store.db.prepare(`INSERT INTO procurement_message_drafts
    (tenant_id,id,purchase_order_id,supplier_id,channel,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at,sender_name,sender_title,sender_organization)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tenantId, 'message-draft:queue-replay', 'po:queue-replay', 'supplier:queue-replay', 'email', 'supplier@example.com', 'subject', 'body',
    'acknowledgement_followup', 'queue-replay', '{}', 'draft', 1, 'ai:procurement-sla', createdAt, createdAt, '王经理', '采购经理', '东方工业有限公司',
  );
  try {
    const input = { tenantId, draftId: 'message-draft:queue-replay', expectedVersion: 1, actorId: 'ai:advanced-sla:advanced-sla:queue:v3', correlationId: 'advanced-sla:queue:v3:message-draft:queue-replay', connectorReady: () => true, now: new Date(createdAt), credentialId: 'credential:queue:healthy' };
    const queued = queueApprovedMessageDraft(store.db, input);
    const replay = queueApprovedMessageDraft(store.db, input);
    assert.equal(queued.replayed, false); assert.equal(replay.replayed, true); assert.equal(replay.outbox.id, queued.outbox.id);
    assert.equal(queued.outbox.payload['credentialId'], 'credential:queue:healthy');
    assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?').get(tenantId) as { count: number }).count), 1);
  } finally { store.close(); }
});

test('Advanced SLA decision audit and Draft-to-Outbox transition roll back together and retry after restart (catches the ready-event crash gap)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-advanced-sla-atomic-'));
  const path = join(directory, 'readywork.sqlite');
  const tenantId = 'tenant:drafts:atomic-audit'; const createdAt = '2026-08-21T00:00:00.000Z';
  try {
    const first = openPersistence(path, { tenantId });
    seedIdentity(first.db, tenantId, createdAt);
    first.db.prepare(`INSERT INTO procurement_message_drafts
      (tenant_id,id,purchase_order_id,supplier_id,channel,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at,sender_name,sender_title,sender_organization)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId, 'message-draft:atomic', 'po:atomic', 'supplier:atomic', 'email', 'supplier@real.cn', 'subject', 'body',
      'acknowledgement_followup', 'atomic', '{}', 'draft', 1, 'ai:procurement-sla', createdAt, createdAt, '王经理', '采购经理', '东方工业有限公司',
    );
    const baseInput = { tenantId, draftId: 'message-draft:atomic', expectedVersion: 1, actorId: 'ai:advanced-sla:profile-atomic:v3', correlationId: 'advanced-sla:profile-atomic:v3:message-draft:atomic', connectorReady: () => true, now: new Date(createdAt), credentialId: 'credential:atomic' };
    assert.throws(() => queueApprovedMessageDraft(first.db, {
      ...baseInput,
      onQueuedInTransaction: () => { throw new Error('forced runtime audit insert failure'); },
    }), /forced runtime audit insert failure/);
    assert.deepEqual({ ...(first.db.prepare('SELECT status,version,outbox_id FROM procurement_message_drafts WHERE tenant_id=? AND id=?').get(tenantId, baseInput.draftId) as Record<string, unknown>) }, { status: 'draft', version: 1, outbox_id: null });
    assert.equal(Number((first.db.prepare('SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?').get(tenantId) as { count: number }).count), 0);
    first.close();

    const restored = openPersistence(path, { tenantId });
    const queued = queueApprovedMessageDraft(restored.db, {
      ...baseInput,
      onQueuedInTransaction: ({ outbox }: { outbox: { id: string } }) => recordAdvancedSlaAutoSendDecision(restored.db, tenantId, {
        profileId: 'profile-atomic', profileVersion: 3, draftId: baseInput.draftId, purchaseOrderId: 'po:atomic', decisionCode: 'ready', outboxId: outbox.id,
        actorId: baseInput.actorId, timestamp: createdAt,
      }),
    });
    assert.equal(queued.replayed, false);
    assert.equal(Number((restored.db.prepare('SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?').get(tenantId) as { count: number }).count), 1);
    assert.equal(Number((restored.db.prepare("SELECT COUNT(*) AS count FROM procurement_advanced_sla_runtime_events WHERE tenant_id=? AND action='auto_send_decision'").get(tenantId) as { count: number }).count), 1);
    restored.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('邮件草稿: 真实 PO 的 SLA 生成、人工编辑、审批、Outbox 派发与审计闭环', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:drafts' });
  const repository = createProcurementRepository(store.db, 'tenant:drafts');
  const at = '2026-08-21T00:00:00.000Z';
  seedIdentity(store.db, 'tenant:drafts', at);
  const supplier: Supplier = {
    id: 'supplier:drafts', tenantId: 'tenant:drafts', sourceSystem: 'odoo', externalId: 'SUP-DRAFTS', status: 'active',
    createdAt: at, updatedAt: at, name: '真实测试供应商', currency: 'CNY',
    contacts: [{ id: 'contact:drafts', name: '陈经理', email: 'supplier@acme-supplier.cn', primary: true }],
  };
  const po: PurchaseOrder = {
    id: 'po:drafts', tenantId: 'tenant:drafts', sourceSystem: 'readywork', externalId: 'PO-DRAFTS', status: 'sent',
    createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at,
  };
  const line: PurchaseOrderLine = { id: 'po-line:drafts', poId: po.id, lineNumber: '10', itemId: 'item:drafts', description: '液压阀', uom: 'EA', orderedQty: 12, unitPrice: 50, currency: 'CNY' };
  repository.saveDocument('supplier', supplier); repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
  store.db.prepare(`INSERT INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,'supplier_commitment','stage_entered','active',?,'outbox','outbox:drafts','connector:email',?,?)`)
    .run('tenant:drafts', 'po-stage-event:drafts:commitment', po.id, at, JSON.stringify({ exactTransitionTime: true }), at);
  const slaRules = [{
    id: 'supplier-commitment-all', name: '供应商确认期限', enabled: true, route: 'all', stage: 'supplier_commitment', risk: 'all',
    deadlineBasis: 'stage_entry', targetOffsetHours: 24, warningHours: 4, graceHours: 0,
    followupIntervalHours: 24, maxFollowups: 3, escalationRole: '采购经理', messageCategory: 'acknowledgement_followup',
  }];
  store.db.prepare(`INSERT INTO procurement_sla_policies
    (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
    VALUES (?,?,?,?, 'published',2,?,?,?,?,?,?,?)`).run('tenant:drafts', 'sla:published', '测试 SLA', '测试发布策略', JSON.stringify(slaRules),
      'human:manager', 'human:manager', 'human:manager', at, at, at);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers['authorization']; const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    void handleProcurementMessageDraftRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(bearer), connectorReady: () => true,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = token('采购专员', 'human:buyer'); const manager = token('采购经理', 'human:manager'); const auditor = token('审计员', 'human:auditor');
  async function request(path: string, options: { method?: string; token?: string; key?: string; body?: Record<string, unknown> } = {}) {
    const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.key ? { 'idempotency-key': options.key } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  try {
    const refresh = await request('/api/procurement/message-drafts/refresh', { method: 'POST', token: buyer });
    assert.equal(refresh.status, 200); assert.equal(refresh.body['created'], 1); assert.equal(refresh.body['examined'], 1);
    const replayRefresh = await request('/api/procurement/message-drafts/refresh', { method: 'POST', token: buyer });
    assert.equal(replayRefresh.body['created'], 0, 'SLA trigger code must make generation idempotent');
    const listed = await request('/api/procurement/message-drafts?status=all', { token: buyer });
    assert.equal(listed.status, 200); assert.equal(listed.body['items'].length, 1);
    assert.deepEqual(listed.body['capabilities'], { edit: true, discard: true, approve: false });
    assert.deepEqual(listed.body['generationReadiness'], { status: 'ready', publishedPolicyId: 'sla:published', publishedPolicyVersion: 2, communicationIdentityVersion: 1 });
    const draft = listed.body['items'][0] as Record<string, any>;
    const managerList = await request('/api/procurement/message-drafts?status=all', { token: manager });
    assert.deepEqual(managerList.body['capabilities'], { edit: true, discard: true, approve: true });
    const auditorList = await request('/api/procurement/message-drafts?status=all', { token: auditor });
    assert.equal(auditorList.status, 200);
    assert.deepEqual(auditorList.body['capabilities'], { edit: false, discard: false, approve: false });
    assert.equal(draft['purchaseOrderNumber'], 'PO-DRAFTS'); assert.equal(draft['recipient'], 'supplier@acme-supplier.cn');
    assert.deepEqual(draft['senderIdentity'], { displayName: '王经理', title: '采购经理', organizationName: '东方工业有限公司' });
    assert.match(draft['body'], /王经理\n采购经理｜东方工业有限公司$/);
    assert.equal(draft['body'].includes('Readywork 采购执行助手'), false);
    assert.equal(/\bAI\b/i.test(draft['body']), false);
    assert.deepEqual(draft['triggerEvidence']['communicationIdentity'], { displayName: '王经理', title: '采购经理', organizationName: '东方工业有限公司', version: 1 });
    assert.equal(draft['decisionContext']['source'], 'sla_policy');
    assert.equal(draft['decisionContext']['label'], '确认催办');
    assert.equal(draft['decisionContext']['sourceCommunication'], null);
    assert.equal(draft['decisionContext']['summary'], 'SLA 截止时间 2026-08-22T00:00:00.000Z，当前需要确认催办');

    const draftPath = `/api/procurement/message-drafts/${encodeURIComponent(draft['id'])}`;
    const auditorDetail = await request(draftPath, { token: auditor });
    assert.equal(auditorDetail.status, 200);
    assert.deepEqual(auditorDetail.body['capabilities'], { edit: false, discard: false, approve: false });
    const rowBeforeDeniedActions = store.db.prepare(`SELECT status,version,outbox_id FROM procurement_message_drafts WHERE tenant_id=? AND id=?`).get('tenant:drafts', draft['id']);
    const eventsBeforeDeniedActions = Number((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_message_draft_events WHERE tenant_id=? AND draft_id=?`).get('tenant:drafts', draft['id']) as { count: number }).count);
    const outboxBeforeDeniedActions = Number((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?`).get('tenant:drafts') as { count: number }).count);
    assert.equal((await request(draftPath, { method: 'PATCH', token: auditor, body: { expectedVersion: 1, recipient: 'supplier@acme-supplier.cn', subject: '不得编辑', body: '不得编辑正文', reason: '权限验证' } })).status, 403);
    assert.equal((await request(`${draftPath}/approve`, { method: 'POST', token: auditor, key: 'auditor-denied', body: { expectedVersion: 1 } })).status, 403);
    assert.equal((await request(`${draftPath}/discard`, { method: 'POST', token: auditor, body: { expectedVersion: 1, reason: '不得丢弃' } })).status, 403);
    assert.deepEqual(store.db.prepare(`SELECT status,version,outbox_id FROM procurement_message_drafts WHERE tenant_id=? AND id=?`).get('tenant:drafts', draft['id']), rowBeforeDeniedActions);
    assert.equal(Number((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_message_draft_events WHERE tenant_id=? AND draft_id=?`).get('tenant:drafts', draft['id']) as { count: number }).count), eventsBeforeDeniedActions);
    assert.equal(Number((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?`).get('tenant:drafts') as { count: number }).count), outboxBeforeDeniedActions);

    const reply: Communication = {
      id: 'communication:drafts:reply', tenantId: 'tenant:drafts', sourceSystem: 'imap:supplier', externalId: '<reply@real.cn>', status: 'received',
      createdAt: at, updatedAt: at, businessObjectId: po.id, businessObjectType: 'purchase_order', supplierId: supplier.id,
      channel: 'email', direction: 'inbound', messageId: '<reply@real.cn>', from: '陈经理 <supplier@acme-supplier.cn>', subject: 'Re: PO-DRAFTS 确认',
      body: '数量和交期已确认，请再核对单价。', attachmentIds: [], occurredAt: at, receivedAt: at,
    };
    repository.saveDocument('communication', reply);
    store.db.prepare(`INSERT INTO procurement_message_drafts
      (tenant_id,id,purchase_order_id,supplier_id,channel,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at,sender_name,sender_title,sender_organization)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'tenant:drafts', 'message-draft:reply-clarification', po.id, supplier.id, 'email', 'supplier@acme-supplier.cn', '请补充确认单价', '请确认订单单价。',
      'acknowledgement_followup', 'po-workbench:reply-clarification', JSON.stringify({ sourceCommunicationId: reply.id, confirmationMissingFields: ['unit_price'] }),
      'draft', 1, 'human:manager', at, at, '王经理', '采购经理', '东方工业有限公司',
    );
    const replyDetail = await request(`/api/procurement/message-drafts/${encodeURIComponent('message-draft:reply-clarification')}`, { token: manager });
    assert.equal(replyDetail.status, 200);
    assert.deepEqual(replyDetail.body['capabilities'], { edit: true, discard: true, approve: true });
    assert.equal(replyDetail.body['item']['decisionContext']['source'], 'supplier_reply');
    assert.equal(replyDetail.body['item']['decisionContext']['label'], '回信待补充');
    assert.equal(replyDetail.body['item']['decisionContext']['summary'], '已收到供应商回复，仍需补充确认单价');
    assert.equal(replyDetail.body['item']['decisionContext']['sourceCommunication']['id'], reply.id);
    assert.equal(replyDetail.body['item']['decisionContext']['sourceCommunication']['body'], reply.body);
    assert.equal((await request(`/api/procurement/message-drafts/${encodeURIComponent(draft['id'])}/approve`, { method: 'POST', token: buyer, key: 'buyer-denied', body: { expectedVersion: 1 } })).status, 403);

    const invalidRecipient = await request(draftPath, { method: 'PATCH', token: buyer, body: { expectedVersion: 1, recipient: 'buyer@example.com', subject: '修改后主题', body: '修改后正文', reason: '核对真实供应商联系人' } });
    assert.equal(invalidRecipient.status, 422);
    const unknownField = await request(draftPath, { method: 'PATCH', token: buyer, body: { expectedVersion: 1, recipient: 'new.recipient@real-supplier.cn', subject: '修改后主题', body: '修改后正文', reason: '核对真实供应商联系人', channel: 'whatsapp' } });
    assert.equal(unknownField.status, 422);
    const crossTenant = await request(draftPath, { method: 'PATCH', token: token('采购专员', 'human:other', 'tenant:other'), body: { expectedVersion: 1, recipient: 'new.recipient@real-supplier.cn', subject: '修改后主题', body: '修改后正文', reason: '核对真实供应商联系人' } });
    assert.equal(crossTenant.status, 404);

    const edited = await request(draftPath, { method: 'PATCH', token: buyer, body: { expectedVersion: 1, recipient: '  NEW.Recipient@REAL-SUPPLIER.CN  ', subject: '修改后主题', body: '修改后正文', reason: '核对真实供应商联系人' } });
    assert.equal(edited.status, 200); assert.equal(edited.body['item']['version'], 2); assert.equal(edited.body['item']['recipient'], 'new.recipient@real-supplier.cn');
    const editEvent = edited.body['events'].find((item: Record<string, unknown>) => item['action'] === 'edited') as Record<string, any>;
    assert.deepEqual(editEvent['detail'], {
      previousVersion: 1,
      channel: 'email',
      purchaseOrderId: po.id,
      reason: '核对真实供应商联系人',
      previousRecipientMasked: 's***@acme-supplier.cn',
      previousRecipientSha256: hashDraftRecipient('supplier@acme-supplier.cn'),
      recipientMasked: 'n***@real-supplier.cn',
      recipientSha256: '8ffef4e5d2f2e8a42aaea2b6dbf44a8d34ad6d8d48f90128eac63aecf957bd2e',
      previousSubjectSha256: hashDraftRecipient(String(draft['subject'])),
      subjectSha256: hashDraftRecipient('修改后主题'),
      previousBodySha256: hashDraftRecipient(String(draft['body'])),
      bodySha256: hashDraftRecipient('修改后正文'),
    });
    assert.equal(JSON.stringify(editEvent).includes('new.recipient@real-supplier.cn'), false);
    assert.equal(JSON.stringify(editEvent).includes('supplier@acme-supplier.cn'), false);
    assert.equal(JSON.stringify(editEvent).includes('修改后正文'), false);
    const stale = await request(draftPath, { method: 'PATCH', token: buyer, body: { expectedVersion: 1, recipient: 'new.recipient@real-supplier.cn', subject: '并发覆盖', body: '不应写入', reason: '陈旧版本' } });
    assert.equal(stale.status, 409); assert.equal(stale.body['currentVersion'], 2);
    const approved = await request(`/api/procurement/message-drafts/${encodeURIComponent(draft['id'])}/approve`, { method: 'POST', token: manager, key: 'approve-once', body: { expectedVersion: 2 } });
    assert.equal(approved.status, 201, JSON.stringify(approved.body)); assert.equal(approved.body['item']['status'], 'approved_queued'); assert.equal(approved.body['outbox']['status'], 'pending');
    const replayApprove = await request(`/api/procurement/message-drafts/${encodeURIComponent(draft['id'])}/approve`, { method: 'POST', token: manager, key: 'approve-once', body: { expectedVersion: 2 } });
    assert.equal(replayApprove.status, 200); assert.equal(replayApprove.body['replayed'], true);

    let sentInput: Record<string, unknown> | undefined;
    // Keep the injected worker clock after the request clock. Using a fixed
    // historical timestamp makes the sent event sort before generation when
    // the test runs on a newer wall clock, which is a clock-fixture bug rather
    // than a valid event timeline.
    const dispatchBase = Date.now() + 60_000;
    const worker = new ProcurementOutboxWorker(store.db, () => ({
      listCredentials: () => [{ id: 'credential:email', connectorId: 'email', status: 'connected' }],
      getCredential: () => ({ host: 'smtp.example.com' }),
      execute: async (_connectorId, action, input) => { assert.equal(action, 'send'); sentInput = input; return { ok: true, data: { accepted: true } }; },
    }), { workerId: 'worker:drafts', now: (() => { let offset = 0; return () => new Date(dispatchBase + offset++); })() });
    const dispatched = await worker.runTenant('tenant:drafts');
    assert.equal(dispatched.dispatched, 1); assert.equal(sentInput?.['to'], 'new.recipient@real-supplier.cn'); assert.equal(sentInput?.['subject'], '修改后主题'); assert.equal(sentInput?.['body'], '修改后正文');
    const detail = await request(`/api/procurement/message-drafts/${encodeURIComponent(draft['id'])}`, { token: manager });
    assert.equal(detail.body['item']['status'], 'sent'); assert.equal(detail.body['item']['delivery']['status'], 'dispatched');
    assert.deepEqual(detail.body['events'].map((item: Record<string, unknown>) => item['action']), ['generated_by_sla', 'edited', 'approved_and_queued', 'sent']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); store.close();
  }
});

test('邮件草稿: 未发布 SLA 时列表返回真实未就绪状态且不会生成草稿', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:drafts' });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers['authorization']; const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    void handleProcurementMessageDraftRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(bearer), connectorReady: () => false,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = token('采购专员', 'human:buyer');
  try {
    const listedResponse = await fetch(`${base}/api/procurement/message-drafts?status=all`, { headers: { authorization: `Bearer ${buyer}` } });
    const listed = await listedResponse.json() as Record<string, any>;
    assert.equal(listedResponse.status, 200);
    assert.deepEqual(listed['items'], []);
    assert.deepEqual(listed['generationReadiness'], { status: 'sla_policy_missing', publishedPolicyId: null, publishedPolicyVersion: null, communicationIdentityVersion: null });

    const refreshResponse = await fetch(`${base}/api/procurement/message-drafts/refresh`, { method: 'POST', headers: { authorization: `Bearer ${buyer}` } });
    const refresh = await refreshResponse.json() as Record<string, any>;
    assert.equal(refreshResponse.status, 409);
    assert.equal(refresh['code'], 'SLA_POLICY_NOT_PUBLISHED');
    const persisted = store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_message_drafts WHERE tenant_id=?`).get('tenant:drafts') as { count: number };
    assert.equal(Number(persisted.count), 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});

test('邮件草稿: 已发布 SLA 但缺少专业沟通身份时禁止生成', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:drafts' });
  const at = '2026-08-21T00:00:00.000Z';
  store.db.prepare(`INSERT INTO procurement_sla_policies
    (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
    VALUES (?,?,?,?, 'published',1,?,?,?,?,?,?,?)`).run('tenant:drafts', 'sla:identity-required', '身份阻断 SLA', '验证身份阻断', '[]',
      'human:manager', 'human:manager', 'human:manager', at, at, at);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers['authorization']; const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    void handleProcurementMessageDraftRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(bearer), connectorReady: () => true,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = token('采购专员', 'human:buyer');
  try {
    const listedResponse = await fetch(`${base}/api/procurement/message-drafts`, { headers: { authorization: `Bearer ${buyer}` } });
    const listed = await listedResponse.json() as Record<string, any>;
    assert.equal(listedResponse.status, 200);
    assert.deepEqual(listed['generationReadiness'], { status: 'communication_identity_missing', publishedPolicyId: 'sla:identity-required', publishedPolicyVersion: 1, communicationIdentityVersion: null });

    const refreshResponse = await fetch(`${base}/api/procurement/message-drafts/refresh`, { method: 'POST', headers: { authorization: `Bearer ${buyer}` } });
    const refresh = await refreshResponse.json() as Record<string, any>;
    assert.equal(refreshResponse.status, 409);
    assert.equal(refresh['code'], 'COMMUNICATION_IDENTITY_MISSING');
    assert.equal(Number((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_message_drafts WHERE tenant_id=?`).get('tenant:drafts') as { count: number }).count), 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});

test('邮件草稿: 旧草稿缺少发件人快照时审批安全阻断', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:drafts' });
  const at = '2026-08-21T00:00:00.000Z';
  seedIdentity(store.db, 'tenant:drafts', at);
  store.db.prepare(`INSERT INTO procurement_message_drafts
    (tenant_id,id,purchase_order_id,supplier_id,channel,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'tenant:drafts', 'message-draft:legacy', 'po:legacy', 'supplier:legacy', 'email', 'supplier@legacy-supplier.cn', '旧草稿', '旧草稿正文',
    'acknowledgement_followup', 'legacy:without-sender', '{}', 'draft', 1, 'ai:legacy', at, at,
  );
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers['authorization']; const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    void handleProcurementMessageDraftRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(bearer), connectorReady: () => true,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manager = token('采购经理', 'human:manager');
  try {
    const detailResponse = await fetch(`${base}/api/procurement/message-drafts/${encodeURIComponent('message-draft:legacy')}`, { headers: { authorization: `Bearer ${manager}` } });
    const detail = await detailResponse.json() as Record<string, any>;
    assert.equal(detail['item']['senderIdentity'], null);

    const approveResponse = await fetch(`${base}/api/procurement/message-drafts/${encodeURIComponent('message-draft:legacy')}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${manager}`, 'content-type': 'application/json', 'idempotency-key': 'legacy-sender-block' },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    const approve = await approveResponse.json() as Record<string, any>;
    assert.equal(approveResponse.status, 409, JSON.stringify(approve));
    assert.equal(approve['code'], 'COMMUNICATION_IDENTITY_MISSING');
    const row = store.db.prepare(`SELECT status,outbox_id FROM procurement_message_drafts WHERE tenant_id=? AND id=?`).get('tenant:drafts', 'message-draft:legacy') as { status: string; outbox_id: string | null };
    assert.equal(row.status, 'draft');
    assert.equal(row.outbox_id, null);
    assert.equal(Number((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?`).get('tenant:drafts') as { count: number }).count), 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
