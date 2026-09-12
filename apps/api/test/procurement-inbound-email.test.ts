import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  Communication,
  PurchaseOrder,
  PurchaseOrderConfirmationLine,
  PurchaseOrderLine,
  Supplier,
} from '@readywork/core';
import { createProcurementRepository, openPersistence, ProcurementValidationError } from '@readywork/persistence';
import {
  buildPurchaseOrderConfirmationReplyBlock,
  ingestInboundPurchaseOrderEmail,
  resolvePurchaseOrderNumberFromEmailThread,
  parsePurchaseOrderConfirmation,
} from '../src/procurement-inbound-email.js';

const tenantId = 'tenant:inbound-email';
const orderedAt = '2026-08-20T00:00:00.000Z';

test('QQ 确认兼容实体空格与缺少开方括号，且只读取本次回复', () => {
  const line: PurchaseOrderLine = { id: 'line:qq', poId: 'po:qq', lineNumber: '10', itemId: 'PV-30', uom: '件', orderedQty: 200, unitPrice: 127, currency: 'CNY' };
  const block = '[READYWORK-CONFIRMATION]\nPO:P00993\nLINE:10 | QTY:200 | UNIT_PRICE:127 | CURRENCY:CNY | PROMISED_DATE:2026-09-20\n[/READYWORK-CONFIRMATION]';
  const quoted = '\n------------------ 原始邮件 ------------------\n' + block;
  const reply = block.slice(1).replace(/ \| /g, '&nbsp;|&nbsp;');
  assert.equal(parsePurchaseOrderConfirmation(reply, 'P00993', 'CNY', [line]).lines?.[0]?.quantity, 200);
  const parsed = parsePurchaseOrderConfirmation(reply + quoted, 'P00993', 'CNY', [line]);
  assert.deepEqual(parsed.lines, [{ poLineId: 'line:qq', quantity: 200, unitPrice: 127, promisedAt: '2026-09-20T00:00:00.000Z' }]);
  for (const body of ['稍后确认' + quoted, 'READYWORK-CONFIRMATION]\nPO:P00993\n[/READYWORK-CONFIRMATION]' + quoted, '> ' + block.replace(/\n/g, '\n> ')]) {
    assert.equal(parsePurchaseOrderConfirmation(body, 'P00993', 'CNY', [line]).lines, undefined, '原邮件模板不能成为供应商确认');
  }
  const changed = parsePurchaseOrderConfirmation(reply.replace('QTY:200', 'QTY:180') + quoted, 'P00993', 'CNY', [line]);
  assert.equal(changed.lines?.[0]?.quantity, 180, '只能采用本次回复，不能采用引用中的旧数量');
});

test('供应商回信：真实线程标识、PO 证据、结构化确认、状态推进和 SLA 重算', () => {
  const store = openPersistence(':memory:', { tenantId });
  store.db.prepare(`INSERT INTO procurement_communication_identities
    (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?, 'active',1,?,?,?,?)`).run(
    tenantId, '李娜', '高级采购专员', '东方制造有限公司',
    'human:manager', 'human:manager', orderedAt, orderedAt,
  );
  const repository = createProcurementRepository(store.db, tenantId);
  const supplier: Supplier = {
    id: 'supplier:inbound', tenantId, sourceSystem: 'odoo', externalId: 'SUP-INBOUND', status: 'active',
    createdAt: orderedAt, updatedAt: orderedAt, name: '上海卓越阀门', currency: 'CNY',
    contacts: [{ id: 'contact:inbound', name: '唐经理', email: 'supplier@example.com', primary: true }],
  };
  const po: PurchaseOrder = {
    id: 'po:inbound', tenantId, sourceSystem: 'odoo', externalId: 'P00991', status: 'draft',
    createdAt: orderedAt, updatedAt: orderedAt, supplierId: supplier.id, currency: 'CNY', orderedAt,
  };
  const lines: PurchaseOrderLine[] = [
    { id: 'po-line:inbound:10', poId: po.id, lineNumber: '10', itemId: 'item:valve', description: '控制阀', uom: 'EA', orderedQty: 8, unitPrice: 1250, currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z' },
    { id: 'po-line:inbound:20', poId: po.id, lineNumber: '20', itemId: 'item:seal', description: '密封件', uom: 'EA', orderedQty: 16, unitPrice: 32, currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z' },
  ];
  repository.saveDocument('supplier', supplier);
  repository.saveDocument('purchase_order', po);
  for (const line of lines) repository.saveLine('purchase_order_line', po.id, line);

  const queued = repository.executeProcurementMutation({
    action: 'send_po', idempotencyKey: 'send-real-po', payloadHash: 'send-real-po', actorId: 'human:buyer', permission: 'operate',
    aggregateId: po.id, expectedVersion: 1, occurredAt: '2026-08-21T00:00:00.000Z', connectorId: 'email', connectorReady: true,
  });
  const claimed = repository.claimOutboxMessages({ workerId: 'worker:email', claimedAt: '2026-08-21T00:00:01.000Z', leaseDurationMs: 60_000 })[0]!;
  repository.completeOutboxMessage({
    id: claimed.id, leaseToken: claimed.leaseToken!, completedAt: '2026-08-21T00:00:02.000Z',
    connectorResult: { message_id: '<readywork.po-991@example.com>', accepted_at: '2026-08-21T00:00:02.000Z', delivery_status: 'sent' },
  });
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.status, 'sent');
  assert.equal(queued.outbox?.status, 'pending');

  const rule = [{
    id: 'fulfilment-all', name: '履约检查', enabled: true, route: 'all', stage: 'fulfilment_production', risk: 'all',
    deadlineBasis: 'rihd', targetOffsetHours: -72, warningHours: 12, graceHours: 12,
    followupIntervalHours: 24, maxFollowups: 3, escalationRole: '采购经理', communicationChannel: 'email', messageCategory: 'delivery_status_escalation',
  }];
  store.db.prepare(`INSERT INTO procurement_sla_policies
    (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
    VALUES (?,?,?,?,'published',1,?,?,?,?,?,?,?)`).run(
      tenantId, 'sla:inbound', '回信测试 SLA', '验证确认后重算', JSON.stringify(rule),
      'human:manager', 'human:manager', 'human:manager', orderedAt, orderedAt, orderedAt,
    );

  const threadOnly = resolvePurchaseOrderNumberFromEmailThread(store.db, tenantId, {
    id: 'uid:thread', from: 'supplier@example.com', subject: 'Re: 确认', body: '', receivedAt: '2026-08-22T00:00:00.000Z',
    inReplyTo: '<readywork.po-991@example.com>',
  });
  assert.equal(threadOnly, 'P00991');

  const replyBlock = buildPurchaseOrderConfirmationReplyBlock(po.externalId, po.currency, lines);
  const email = {
    id: '991', from: '唐经理 <supplier@example.com>', subject: 'Re: 采购订单 P00991',
    body: `确认收到并接受。\n\n${replyBlock}\n\n暂无其他风险。`, receivedAt: '2026-08-22T01:00:00.000Z',
    messageId: '<supplier-confirm-991@example.com>', inReplyTo: '<readywork.po-991@example.com>', references: ['<readywork.po-991@example.com>'],
  };
  const first = ingestInboundPurchaseOrderEmail({ db: store.db, tenantId, provider: 'imap:example.com', mailbox: 'INBOX', email, poNumber: 'P00991' });
  assert.equal(first.status, 'confirmation_recorded');
  assert.equal(first.communicationReplayed, false);
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.status, 'confirmed');
  const communication = repository.getDocument<Communication>('communication', first.communicationId)?.document;
  assert.equal(communication?.businessObjectId, po.id);
  assert.equal(communication?.inReplyTo, '<readywork.po-991@example.com>');
  assert.deepEqual(
    repository.listLines<PurchaseOrderConfirmationLine>('confirmation_line', first.confirmation!.createdDocuments[0]!.id)
      .map((line) => line.poLineId),
    lines.map((line) => line.id),
  );
  const evaluation = store.db.prepare(`SELECT stage FROM procurement_sla_evaluations WHERE tenant_id=? AND po_id=?`).get(tenantId, po.id) as { stage: string };
  assert.equal(evaluation.stage, 'fulfilment_production');

  const replay = ingestInboundPurchaseOrderEmail({ db: store.db, tenantId, provider: 'imap:example.com', mailbox: 'INBOX', email, poNumber: 'P00991' });
  assert.equal(replay.status, 'confirmation_recorded');
  assert.equal(replay.communicationReplayed, true);
  assert.equal(replay.confirmation?.replayed, true);
  const counts = store.db.prepare(`SELECT
    (SELECT COUNT(*) FROM procurement_documents WHERE tenant_id=? AND kind='communication') AS communications,
    (SELECT COUNT(*) FROM procurement_documents WHERE tenant_id=? AND kind='confirmation') AS confirmations`).get(tenantId, tenantId) as { communications: number; confirmations: number };
  assert.deepEqual([Number(counts.communications), Number(counts.confirmations)], [1, 1]);
  store.close();
});

test('供应商回信：自由文本只保存证据，错误发件人不能冒充供应商', () => {
  const store = openPersistence(':memory:', { tenantId });
  const repository = createProcurementRepository(store.db, tenantId);
  const supplier: Supplier = {
    id: 'supplier:review', tenantId, sourceSystem: 'odoo', externalId: 'SUP-REVIEW', status: 'active',
    createdAt: orderedAt, updatedAt: orderedAt, name: '宁波华固', currency: 'CNY',
    contacts: [{ id: 'contact:review', name: '李经理', email: 'trusted@example.com', primary: true }],
  };
  const po: PurchaseOrder = {
    id: 'po:review', tenantId, sourceSystem: 'odoo', externalId: 'P00992', status: 'sent',
    createdAt: orderedAt, updatedAt: orderedAt, supplierId: supplier.id, currency: 'CNY', orderedAt,
  };
  const line: PurchaseOrderLine = { id: 'po-line:review', poId: po.id, lineNumber: '10', itemId: 'item:review', uom: 'EA', orderedQty: 5, unitPrice: 10, currency: 'CNY' };
  repository.saveDocument('supplier', supplier); repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);

  const evidence = ingestInboundPurchaseOrderEmail({
    db: store.db, tenantId, provider: 'imap:example.com', mailbox: 'INBOX', poNumber: po.externalId,
    email: { id: '992', from: '李经理 <trusted@example.com>', subject: 'Re: P00992', body: '收到，交期稍后确认。', receivedAt: '2026-08-22T02:00:00.000Z', messageId: '<evidence-992@example.com>' },
  });
  assert.equal(evidence.status, 'evidence_only');
  assert.match(evidence.reason ?? '', /等待人工复核/);
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.status, 'sent');
  const event = store.db.prepare(`SELECT event_type FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND source_id=?`).get(tenantId, po.id, evidence.communicationId) as { event_type: string };
  assert.equal(event.event_type, 'supplier_reply_received');

  assert.throws(() => ingestInboundPurchaseOrderEmail({
    db: store.db, tenantId, provider: 'imap:example.com', mailbox: 'INBOX', poNumber: po.externalId,
    email: { id: 'forged', from: 'attacker@example.net', subject: 'Re: P00992', body: '确认全部内容。', receivedAt: '2026-08-22T03:00:00.000Z', messageId: '<forged@example.net>' },
  }), (error: unknown) => error instanceof ProcurementValidationError && error.code === 'SUPPLIER_EMAIL_MISMATCH');
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_documents WHERE tenant_id=? AND kind='communication'`).get(tenantId)!.count, 1);
  store.close();
});
