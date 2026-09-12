import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { PurchaseOrder, PurchaseOrderLine, RequestForQuotation, RequestForQuotationLine, Supplier } from '@readywork/core';
import type { MessageDeliveryRequest } from '@readywork/messaging';
import { OdooPurchaseOrderCancellationRejectedError } from '@readywork/connectors';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { ProcurementOutboxWorker, type OutboxConnectorPort } from '../src/procurement-outbox-worker.js';
import { MemoryAttachmentObjectStorage } from '../src/attachment-object-storage.js';
import { MessagingRuntimeRegistry } from '../src/messaging/runtime.js';

const at = '2026-08-21T01:00:00.000Z';

function seedIdentity(db: DatabaseSync, tenantId: string): void {
  db.prepare(`INSERT INTO procurement_communication_identities
    (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,'active',1,?,?,?,?)`).run(
    tenantId, '李采购', '采购专员', '示例制造有限公司', 'human:buyer', 'human:buyer', at, at,
  );
}

function fixture(connectorReady = true) {
  const store = openPersistence(':memory:', { tenantId: 'tenant:outbox' });
  seedIdentity(store.db, 'tenant:outbox');
  const repository = createProcurementRepository(store.db, 'tenant:outbox');
  const supplier: Supplier = { id: 'supplier:1', tenantId: 'tenant:outbox', sourceSystem: 'manual', externalId: 'supplier:1', status: 'active', createdAt: at, updatedAt: at, name: '测试供应商', currency: 'CNY', contacts: [{ id: 'contact:1', name: '陈经理', email: 'supplier@example.com', primary: true }] };
  const po: PurchaseOrder = { id: 'po:1', tenantId: 'tenant:outbox', sourceSystem: 'readywork', externalId: 'PO-1', status: 'draft', createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at };
  const line: PurchaseOrderLine = { id: 'po-line:1', poId: po.id, lineNumber: '10', itemId: 'item:1', uom: '件', orderedQty: 10, unitPrice: 20, currency: 'CNY' };
  repository.saveDocument('supplier', supplier);
  repository.saveDocument('purchase_order', po);
  repository.saveLine('purchase_order_line', po.id, line);
  const queued = repository.executeProcurementMutation({
    action: 'send_po', idempotencyKey: 'send-1', payloadHash: 'send-hash', actorId: 'h:buyer', permission: 'operate',
    aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'email', connectorReady,
  });
  return { store, repository, queued };
}

// Catches treating gateway wait/paused as a new failed domain dispatch on every 5s tick.
for (const paused of [false, true]) test(`I2 real Worker and Runtime preserve the same outbox through ${paused?'pause/resume':'30 second retry wait'}`, async()=>{
  const {store,repository,queued}=fixture(); let milliseconds=Date.parse(at); let sends=0;
  try {
    const runtime=new MessagingRuntimeRegistry(store.db,()=>({listCredentials:()=>[{id:'isolated',connectorId:'email',status:'connected'}],getCredential:()=>({username:'isolated@example.test',password:'test-only'})}),{
      now:()=>new Date(milliseconds).toISOString(),sendMail:async()=>{sends++;return !paused&&sends===1?{ok:false,message:'ECONNREFUSED',dispatchStage:'before_dispatch',retryable:true}:{ok:true,message:'accepted',messageId:'<isolated@example.test>'};}
    }).forTenant('tenant:outbox');
    if(paused) runtime.pauseAdapter('email',runtime.getAdapterState('email').version,'admin','maintenance');
    const worker=new ProcurementOutboxWorker(store.db,()=>connector(async()=>{throw new Error('legacy send forbidden');}),{now:()=>new Date(milliseconds),messageGatewayForTenant:()=>runtime});
    await worker.runTenant('tenant:outbox');
    for(let seconds=5;seconds<30;seconds+=5){milliseconds=Date.parse(at)+seconds*1000;await worker.runTenant('tenant:outbox');}
    const waiting=repository.getOutboxMessage(queued.outbox!.id)!;
    assert.equal(waiting.status,'pending');
    assert.equal(waiting.attempts,paused?0:1);
    assert.equal(sends,paused?0:1);
    if(paused) runtime.resumeAdapter('email',runtime.getAdapterState('email').version,'admin','maintenance complete');
    milliseconds=Date.parse(at)+30_000;
    await worker.runTenant('tenant:outbox');
    const done=repository.getOutboxMessage(queued.outbox!.id)!;
    assert.equal(done.status,'dispatched');
    assert.equal(done.connectorResult?.['message_id'],'<isolated@example.test>');
    assert.equal(done.attempts,paused?1:2);
  } finally {store.close();}
});

test('I2 safe attempt budget terminates exactly on the third external attempt',async()=>{
  const {store,repository,queued}=fixture();let milliseconds=Date.parse(at);let sends=0;
  try {
    const runtime=new MessagingRuntimeRegistry(store.db,()=>({listCredentials:()=>[{id:'isolated',connectorId:'email',status:'connected'}],getCredential:()=>({username:'isolated@example.test',password:'isolated'})}),{now:()=>new Date(milliseconds).toISOString(),sendMail:async()=>{sends++;return {ok:false,message:'ECONNREFUSED',dispatchStage:'before_dispatch',retryable:true};}}).forTenant('tenant:outbox');
    const worker=new ProcurementOutboxWorker(store.db,()=>connector(async()=>{throw new Error('legacy');}),{now:()=>new Date(milliseconds),messageGatewayForTenant:()=>runtime});
    for(let seconds=0;seconds<=60;seconds+=5){milliseconds=Date.parse(at)+seconds*1000;await worker.runTenant('tenant:outbox');}
    assert.equal(repository.getOutboxMessage(queued.outbox!.id)?.status,'failed');
    assert.equal(repository.getOutboxMessage(queued.outbox!.id)?.attempts,3);
    assert.equal(sends,3);
  } finally {store.close();}
});

test('Outbox Worker: 凭据就绪后按原 ID 重排 blocked 消息，仍只在真实成功后推进 PO', async () => {
  const { store, repository, queued } = fixture(false);
  assert.equal(queued.outbox?.status, 'blocked');
  assert.equal(queued.aggregate.document.status, 'draft');
  let calls = 0;
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => {
    calls += 1;
    return { ok: true, output: { message_id: 'm:unblocked' } };
  }), { now: () => new Date(at) });
  const result = await worker.runTenant('tenant:outbox');
  assert.deepEqual(result, { claimed: 1, dispatched: 1, retryScheduled: 0, failed: 0 });
  assert.equal(calls, 1);
  const message = repository.getOutboxMessage(queued.outbox!.id)!;
  assert.equal(message.id, queued.outbox!.id, '重排不创建新消息，保留幂等身份');
  assert.equal(message.requeuedAt, at);
  assert.equal(message.attempts, 1);
  assert.equal(message.status, 'dispatched');
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', 'po:1')?.document.status, 'sent');
  store.close();
});

test('Outbox Worker: 邮箱 Intake PO 冻结版本并附带已扫描的原始文件', async () => {
  const tenantId = 'tenant:outbox:email-intake-po';
  const store = openPersistence(':memory:', { tenantId });
  seedIdentity(store.db, tenantId);
  const repository = createProcurementRepository(store.db, tenantId);
  const supplier: Supplier = { id: 'supplier:intake', tenantId, sourceSystem: 'odoo', externalId: 'SUP-INTAKE', status: 'active', createdAt: at, updatedAt: at, name: '真实供应商', currency: 'CNY', contacts: [{ id: 'contact:intake', name: '联系人', email: 'supplier@supplysentry.invalid', primary: true }] };
  const content = Buffer.from('ORIGINAL PURCHASE ORDER PO-INTAKE-001', 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const attachmentId = 'attachment:intake:po';
  const po = { id: 'po:intake', tenantId, sourceSystem: 'email-intake', externalId: 'PO-INTAKE-001', status: 'draft', createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at, sourceAttachmentId: attachmentId } as PurchaseOrder;
  const line: PurchaseOrderLine = { id: 'po-line:intake', poId: po.id, lineNumber: '10', itemId: 'VALVE-1', uom: 'EA', orderedQty: 5, unitPrice: 20, currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z' };
  repository.saveDocument('supplier', supplier); repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
  store.db.prepare(`INSERT INTO procurement_attachments
    (tenant_id,id,requisition_id,requisition_line_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,
      extraction_status,extracted_text_preview,content,status,security_status,processing_status,storage_backend,owner_type,owner_id,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active','clean','parsed','sqlite','purchase_order',?,?,?)`).run(
      tenantId, attachmentId, po.id, null, 'PO-INTAKE-001.txt', 'text/plain', content.length, sha256, 1, null,
      'text_extracted', 'ORIGINAL PURCHASE ORDER', content, po.id, 'human:manager', at,
    );
  const queued = repository.executeProcurementMutation({ action: 'send_po', idempotencyKey: 'send-intake-po', payloadHash: 'send-intake-po-hash', actorId: 'human:manager', permission: 'operate', aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'email', connectorReady: true });
  assert.equal(queued.outbox?.payload['poVersion'], 1);
  assert.deepEqual(queued.outbox?.payload['attachments'], [{ id: attachmentId, sha256, version: 1, name: 'PO-INTAKE-001.txt', contentType: 'text/plain', sizeBytes: content.length }]);
  let sentAttachments: Array<{ filename: string; content: Uint8Array }> = [];
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async (_id, action, input) => {
    assert.equal(action, 'send'); sentAttachments = input['attachments'] as typeof sentAttachments;
    return { ok: true, output: { message_id: '<po-intake-001@example.test>' } };
  }), { now: () => new Date(at) });
  const result = await worker.runTenant(tenantId); assert.equal(result.dispatched, 1);
  assert.equal(sentAttachments[0]?.filename, 'PO-INTAKE-001.txt'); assert.deepEqual(Buffer.from(sentAttachments[0]!.content), content);
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.status, 'sent');
  assert.deepEqual(repository.getOutboxMessage(queued.outbox!.id)?.sentAttachments, queued.outbox?.payload['attachments']);
  const audit = store.db.prepare(`SELECT action FROM procurement_attachment_audit WHERE tenant_id=? AND attachment_id=? AND action='sent_with_po'`).get(tenantId, attachmentId) as { action: string } | undefined;
  assert.equal(audit?.action, 'sent_with_po');
  store.close();
});

function connector(execute: OutboxConnectorPort['execute']): OutboxConnectorPort {
  return {
    execute,
    listCredentials: () => [{ id: 'credential:email', connectorId: 'email', status: 'connected' }],
    getCredential: () => ({ username: 'sender@example.com', authorizationCode: 'not-returned' }),
  };
}

function amendmentFixture(suffix: string) {
  const tenantId = `tenant:outbox:amendment:${suffix}`;
  const store = openPersistence(':memory:', { tenantId });
  const repository = createProcurementRepository(store.db, tenantId);
  const supplier: Supplier = {
    id: `supplier:amendment:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: 'odoo-81', status: 'active', createdAt: at, updatedAt: at,
    name: 'amendment supplier', currency: 'CNY', contacts: [],
  };
  const po = {
    id: `po:amendment:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: 'purchase.order:81', status: 'confirmed', createdAt: at, updatedAt: at,
    supplierId: supplier.id, currency: 'CNY', orderedAt: at, number: 'P00081', requiredInHouseAt: '2026-09-10T00:00:00.000Z',
  } as PurchaseOrder & { number: string };
  const line: PurchaseOrderLine = {
    id: `po-line:amendment:${suffix}`, poId: po.id, lineNumber: '901', itemId: 'VALVE-81', uom: '件', orderedQty: 2, unitPrice: 20,
    currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z',
  };
  repository.saveDocument('supplier', supplier); repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
  const queued = repository.executeProcurementMutation({
    action: 'edit_po', idempotencyKey: `po-amendment-${suffix}`, payloadHash: `po-amendment-${suffix}-hash`, actorId: 'human:manager', permission: 'operate',
    aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'erp', connectorReady: true,
    patch: { requiredInHouseAt: '2026-09-30T00:00:00.000Z' }, reason: '项目需求日已批准调整',
  });
  return { tenantId, store, repository, po, queued };
}

function rfqAttachmentFixture(suffix: string) {
  const tenantId = `tenant:outbox:${suffix}`;
  const store = openPersistence(':memory:', { tenantId });
  seedIdentity(store.db, tenantId);
  const repository = createProcurementRepository(store.db, tenantId);
  const supplier: Supplier = {
    id: `supplier:${suffix}`, tenantId, sourceSystem: 'manual', externalId: `supplier:${suffix}`, status: 'active',
    createdAt: at, updatedAt: at, name: '附件校验供应商', currency: 'CNY',
    contacts: [{ id: `contact:${suffix}`, name: '联系人', email: 'supplier@example.com', primary: true }],
  };
  const content = Buffer.from(`attachment-${suffix}`, 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  const attachment = { id: `attachment:${suffix}`, fileName: `${suffix}.txt`, contentType: 'text/plain', sizeBytes: content.length, sha256, version: 1 };
  const rfq: RequestForQuotation = {
    id: `rfq:${suffix}`, tenantId, sourceSystem: 'readywork', externalId: `RFQ-${suffix}`, status: 'draft', createdAt: at, updatedAt: at,
    requisitionId: `requisition:${suffix}`, buyerId: 'h:buyer', supplierIds: [supplier.id], currency: 'CNY', quoteDueAt: '2026-08-30T00:00:00.000Z',
    attachmentIds: [attachment.id], attachments: [attachment],
  };
  const line: RequestForQuotationLine = { id: `rfq-line:${suffix}`, rfqId: rfq.id, lineNumber: '10', itemId: 'item:1', uom: '件', requestedQty: 1 };
  repository.saveDocument('supplier', supplier);
  repository.saveDocument('rfq', rfq);
  repository.saveLine('rfq_line', rfq.id, line);
  const insertAttachment = (rowTenantId: string, rowContent = content): void => {
    store.db.prepare(`INSERT INTO procurement_attachments
      (tenant_id,id,requisition_id,requisition_line_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,
        extraction_status,extracted_text_preview,content,status,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        rowTenantId, attachment.id, rfq.requisitionId!, null, attachment.fileName, attachment.contentType,
        rowContent.length, attachment.sha256, attachment.version, null, 'text_extracted', null, rowContent, 'active', 'h:buyer', at,
      );
    store.db.prepare(`UPDATE procurement_attachments SET security_status='clean' WHERE tenant_id=? AND id=?`).run(rowTenantId, attachment.id);
  };
  insertAttachment(tenantId);
  const queued = repository.executeProcurementMutation({
    action: 'send_rfq', idempotencyKey: `send-${suffix}`, payloadHash: `hash-${suffix}`, actorId: 'h:buyer', permission: 'operate',
    aggregateId: rfq.id, expectedVersion: 1, occurredAt: at, connectorId: 'email', connectorReady: true, supplierId: supplier.id,
  });
  return { store, repository, tenantId, rfq, attachment, queued, insertAttachment };
}

test('Outbox Worker: RFQ 邮件只在 SMTP 真实成功后推进为 sent', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:outbox' });
  seedIdentity(store.db, 'tenant:outbox');
  const repository = createProcurementRepository(store.db, 'tenant:outbox');
  const supplier: Supplier = { id: 'supplier:rfq', tenantId: 'tenant:outbox', sourceSystem: 'odoo', externalId: 'odoo-partner-6', status: 'active', createdAt: at, updatedAt: at, name: '上海卓越阀门', currency: 'CNY', contacts: [{ id: 'contact:rfq', name: '上海卓越阀门', email: 'supplier@supplysentry.invalid', primary: true }] };
  const attachmentContent = Buffer.from('阀门图纸-v1', 'utf8');
  const attachmentSha256 = createHash('sha256').update(attachmentContent).digest('hex');
  const attachment = {
    id: 'attachment:rfq:1', fileName: '阀门图纸.txt', contentType: 'text/plain', sizeBytes: attachmentContent.length,
    sha256: attachmentSha256, version: 1,
  };
  const rfq: RequestForQuotation = {
    id: 'rfq:1', tenantId: 'tenant:outbox', sourceSystem: 'readywork', externalId: 'RFQ-E2E-1', status: 'draft', createdAt: at, updatedAt: at,
    requisitionId: 'requisition:rfq:1', buyerId: 'h:buyer', supplierIds: [supplier.id], currency: 'CNY',
    quoteDueAt: '2026-08-30T00:00:00.000Z', title: '真实询价验收', attachmentIds: [attachment.id], attachments: [attachment],
  };
  const line: RequestForQuotationLine = { id: 'rfq-line:1', rfqId: rfq.id, lineNumber: '10', itemId: 'item:1', itemName: '阀门组件', uom: '件', requestedQty: 10, requiredAt: '2026-09-15T00:00:00.000Z' };
  repository.saveDocument('supplier', supplier);
  repository.saveDocument('rfq', rfq);
  repository.saveLine('rfq_line', rfq.id, line);
  store.db.prepare(`INSERT INTO procurement_attachments
    (tenant_id,id,requisition_id,requisition_line_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,
      extraction_status,extracted_text_preview,content,status,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'tenant:outbox', attachment.id, rfq.requisitionId!, null, attachment.fileName, attachment.contentType,
      attachment.sizeBytes, attachment.sha256, attachment.version, null, 'text_extracted', null,
      attachmentContent, 'active', 'h:buyer', at,
    );
  store.db.prepare(`UPDATE procurement_attachments SET security_status='clean' WHERE tenant_id=? AND id=?`).run('tenant:outbox', attachment.id);
  const queued = repository.executeProcurementMutation({
    action: 'send_rfq', idempotencyKey: 'send-rfq-1', payloadHash: 'send-rfq-hash', actorId: 'h:buyer', permission: 'operate',
    aggregateId: rfq.id, expectedVersion: 1, occurredAt: at, connectorId: 'email', connectorReady: true, supplierId: supplier.id,
  });
  assert.equal(queued.outbox?.status, 'pending');
  assert.deepEqual(queued.outbox?.payload['attachments'], [{
    id: attachment.id, sha256: attachment.sha256, version: 1, name: attachment.fileName, contentType: attachment.contentType, sizeBytes: attachment.sizeBytes,
  }]);
  assert.equal(repository.getDocument<RequestForQuotation>('rfq', rfq.id)?.document.status, 'draft');
  let input: Record<string, unknown> = {};
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async (_id, action, nextInput) => {
    assert.equal(action, 'send'); input = nextInput; return { ok: true, output: { message_id: 'm:rfq' } };
  }), { now: () => new Date(at) });
  const result = await worker.runTenant('tenant:outbox');
  assert.equal(result.dispatched, 1);
  assert.equal(input['to'], 'supplier@supplysentry.invalid');
  assert.equal(input['fromName'], '李采购');
  assert.match(String(input['subject']), /RFQ-E2E-1/);
  assert.match(String(input['body']), /单价/);
  assert.match(String(input['body']), /李采购\n采购专员｜示例制造有限公司/);
  assert.doesNotMatch(String(input['body']), /Readywork|AI/);
  const sentInputAttachments = input['attachments'] as Array<{ filename: string; contentType: string; content: Uint8Array }>;
  assert.equal(sentInputAttachments.length, 1);
  assert.equal(sentInputAttachments[0]?.filename, attachment.fileName);
  assert.equal(sentInputAttachments[0]?.contentType, attachment.contentType);
  assert.deepEqual(Buffer.from(sentInputAttachments[0]!.content), attachmentContent);
  assert.equal(repository.getDocument<RequestForQuotation>('rfq', rfq.id)?.document.status, 'sent');
  assert.deepEqual(repository.getOutboxMessage(queued.outbox!.id)?.sentAttachments, queued.outbox?.payload['attachments']);
  const audit = store.db.prepare(`SELECT action,detail_json FROM procurement_attachment_audit
    WHERE tenant_id=? AND attachment_id=? AND action='sent_with_rfq'`).get('tenant:outbox', attachment.id) as { action: string; detail_json: string } | undefined;
  assert.equal(audit?.action, 'sent_with_rfq');
  assert.deepEqual(JSON.parse(audit!.detail_json), {
    rfqId: rfq.id, outboxId: queued.outbox!.id, supplierId: supplier.id,
    id: attachment.id, sha256: attachment.sha256, version: 1, name: attachment.fileName, contentType: attachment.contentType, sizeBytes: attachment.sizeBytes,
  });
  store.close();
});

test('Outbox Worker: S3/MinIO 附件经对象存储完整性门禁后才进入邮件', async () => {
  const fixture = rfqAttachmentFixture('object-storage');
  const objectStorage = new MemoryAttachmentObjectStorage();
  const content = Buffer.from('attachment-object-storage', 'utf8');
  const metadata = await objectStorage.put({
    tenantId: fixture.tenantId,
    attachmentId: fixture.attachment.id,
    version: fixture.attachment.version,
    sha256: fixture.attachment.sha256,
    sizeBytes: fixture.attachment.sizeBytes,
    contentType: fixture.attachment.contentType,
    body: content,
  });
  fixture.store.db.prepare(`UPDATE procurement_attachments SET storage_backend='s3',object_key=?,content=? WHERE tenant_id=? AND id=?`)
    .run(metadata.key, Buffer.alloc(0), fixture.tenantId, fixture.attachment.id);
  let sentContent: Uint8Array | undefined;
  const worker = new ProcurementOutboxWorker(fixture.store.db, () => connector(async (_id, _action, input) => {
    sentContent = (input['attachments'] as Array<{ content: Uint8Array }>)[0]?.content;
    return { ok: true, output: { message_id: 'object-storage-message' } };
  }), { now: () => new Date(at), objectStorage });
  const result = await worker.runTenant(fixture.tenantId);
  assert.equal(result.dispatched, 1);
  assert.deepEqual(Buffer.from(sentContent!), content);
  fixture.store.close();
});

test('Outbox Worker: RFQ 附件不存在、失效或版本/摘要不一致时终止发信', async (t) => {
  const cases: Array<{
    name: string;
    mutate: (fixture: ReturnType<typeof rfqAttachmentFixture>) => void;
    error: RegExp;
  }> = [
    {
      name: '只有其他租户同 ID 附件',
      mutate: (fixture) => {
        fixture.store.db.prepare('DELETE FROM procurement_attachments WHERE tenant_id=? AND id=?').run(fixture.tenantId, fixture.attachment.id);
        fixture.insertAttachment('tenant:other');
      },
      error: /不存在/,
    },
    {
      name: '附件已失效',
      mutate: (fixture) => { fixture.store.db.prepare('UPDATE procurement_attachments SET status=? WHERE tenant_id=? AND id=?').run('superseded', fixture.tenantId, fixture.attachment.id); },
      error: /已失效/,
    },
    {
      name: '附件版本变化',
      mutate: (fixture) => { fixture.store.db.prepare('UPDATE procurement_attachments SET version=? WHERE tenant_id=? AND id=?').run(2, fixture.tenantId, fixture.attachment.id); },
      error: /版本/,
    },
    {
      name: '附件存储摘要变化',
      mutate: (fixture) => { fixture.store.db.prepare('UPDATE procurement_attachments SET sha256=? WHERE tenant_id=? AND id=?').run('0'.repeat(64), fixture.tenantId, fixture.attachment.id); },
      error: /sha256/,
    },
    {
      name: '附件 BLOB 被篡改',
      mutate: (fixture) => { fixture.store.db.prepare('UPDATE procurement_attachments SET content=? WHERE tenant_id=? AND id=?').run(Buffer.alloc(fixture.attachment.sizeBytes, 0x61), fixture.tenantId, fixture.attachment.id); },
      error: /sha256/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fixture = rfqAttachmentFixture(item.name);
      item.mutate(fixture);
      let calls = 0;
      const worker = new ProcurementOutboxWorker(fixture.store.db, () => connector(async () => {
        calls += 1;
        return { ok: true, output: { message_id: 'must-not-send' } };
      }), { now: () => new Date(at) });
      const result = await worker.runTenant(fixture.tenantId);
      assert.deepEqual(result, { claimed: 1, dispatched: 0, retryScheduled: 0, failed: 1 });
      assert.equal(calls, 0, '附件校验失败后不得改为无附件邮件发送');
      const outbox = fixture.repository.getOutboxMessage(fixture.queued.outbox!.id)!;
      assert.equal(outbox.status, 'failed');
      assert.match(outbox.error ?? '', item.error);
      assert.equal(fixture.repository.getDocument<RequestForQuotation>('rfq', fixture.rfq.id)?.document.status, 'draft');
      fixture.store.close();
    });
  }
});

test('Outbox Worker: 只在连接器真实成功后把 PO 从 draft 推进到 sent', async () => {
  const { store, repository, queued } = fixture();
  assert.equal(queued.aggregate.document.status, 'draft');
  let input: Record<string, unknown> = {};
  let clock = new Date(at);
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async (_id, action, nextInput) => {
    assert.equal(action, 'send'); input = nextInput; clock = new Date('2026-08-21T01:00:05.000Z'); return { ok: true, output: { message_id: 'm1', from_name: '李采购' } };
  }), { now: () => clock });
  const result = await worker.runTenant('tenant:outbox');
  assert.deepEqual(result, { claimed: 1, dispatched: 1, retryScheduled: 0, failed: 0 });
  assert.equal(input['to'], 'supplier@example.com');
  assert.equal(input['fromName'], '李采购');
  assert.match(String(input['body']), /李采购\n采购专员｜示例制造有限公司/);
  assert.doesNotMatch(String(input['body']), /Readywork 采购执行助手|AI/);
  const completedOutbox = repository.getOutboxMessage(queued.outbox!.id)!;
  assert.equal(completedOutbox.status, 'dispatched');
  assert.equal(completedOutbox.dispatchedAt, '2026-08-21T01:00:05.000Z', '完成事实必须使用真实外部调用返回后的时间');
  assert.equal(completedOutbox.connectorResult?.['from_name'], '李采购');
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', 'po:1')?.document.status, 'sent');
  store.close();
});

test('Outbox Worker: Email 只经过消息网关且 accepted 回执推进采购 Outbox', async () => {
  const { store, repository, queued } = fixture();
  let connectorCalls = 0;
  let delivered: MessageDeliveryRequest | undefined;
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => {
    connectorCalls += 1;
    return { ok: false, error: '旧 Email Connector 不得被调用' };
  }), {
    now: () => new Date(at),
    messageGatewayForTenant: () => ({
      deliver: async (request) => {
        delivered = request;
        return {
          deliveryId: 'messaging-delivery:one',
          status: 'accepted',
          providerMessageId: '<gateway@example.test>',
          acceptedAt: at,
          attempt: 1,
          replayed: false,
        };
      },
    }),
  });

  const result = await worker.runTenant('tenant:outbox');

  assert.deepEqual(result, { claimed: 1, dispatched: 1, retryScheduled: 0, failed: 0 });
  assert.equal(connectorCalls, 0);
  assert.equal(delivered?.adapterId, 'email');
  assert.equal(delivered?.channel, 'email');
  assert.equal(delivered?.idempotencyKey, queued.outbox?.idempotencyKey);
  assert.equal(delivered?.recipients[0]?.address, 'supplier@example.com');
  assert.equal(delivered?.sender?.displayName, '李采购');
  assert.equal(delivered?.trace.source, 'procurement_outbox');
  assert.equal(delivered?.trace.sourceId, queued.outbox?.id);
  assert.equal(delivered?.trace.correlationId, 'po:1');
  const completed = repository.getOutboxMessage(queued.outbox!.id)!;
  assert.equal(completed.status, 'dispatched');
  assert.equal(completed.connectorResult?.['message_id'], '<gateway@example.test>');
  assert.equal(completed.connectorResult?.['delivery_status'], 'accepted');
  store.close();
});

test('Outbox Worker: 消息网关 unknown 进入人工核对且不重试采购 Outbox', async () => {
  const { store, repository, queued } = fixture();
  let connectorCalls = 0;
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => {
    connectorCalls += 1;
    return { ok: false, error: '旧 Email Connector 不得被调用' };
  }), {
    now: () => new Date(at),
    messageGatewayForTenant: () => ({
      deliver: async () => ({
        deliveryId: 'messaging-delivery:unknown',
        status: 'unknown',
        attempt: 1,
        replayed: false,
        error: 'SMTP DATA 后连接中断',
      }),
    }),
  });

  const result = await worker.runTenant('tenant:outbox');

  assert.deepEqual(result, { claimed: 1, dispatched: 0, retryScheduled: 0, failed: 1 });
  assert.equal(connectorCalls, 0);
  assert.equal(repository.getOutboxMessage(queued.outbox!.id)?.status, 'failed');
  const exception = store.db.prepare(`SELECT json FROM runtime_exceptions WHERE tenant_id=? AND object_id=?`)
    .get('tenant:outbox', 'po:1') as { json: string };
  assert.equal(JSON.parse(exception.json)['type'], 'external_delivery_uncertain');
  store.close();
});

test('Outbox Worker: 从冻结 payload 创建 Odoo draft，拒绝不完整回执', async () => {
  const tenantId = 'tenant:outbox:odoo-draft';
  const store = openPersistence(':memory:', { tenantId });
  const repository = createProcurementRepository(store.db, tenantId);
  const supplier: Supplier = { id: 'supplier:odoo', tenantId, sourceSystem: 'odoo', externalId: 'odoo-8', status: 'active', createdAt: at, updatedAt: at, name: 'Odoo 供应商', currency: 'CNY', contacts: [] };
  const po: PurchaseOrder = { id: 'po:odoo-draft', tenantId, sourceSystem: 'readywork', externalId: 'PO-ODOO-DRAFT', status: 'draft', createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at };
  const line: PurchaseOrderLine = { id: 'po-line:odoo-draft', poId: po.id, lineNumber: '10', itemId: 'VALVE-1', description: '阀门', uom: '件', orderedQty: 2, unitPrice: 50, currency: 'CNY', requestedAt: '2026-09-01T00:00:00.000Z' };
  repository.saveDocument('supplier', supplier); repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
  const queued = repository.executeProcurementMutation({ action: 'create_odoo_po_draft', idempotencyKey: 'odoo-draft-1', payloadHash: 'odoo-draft-hash', actorId: 'human:manager', permission: 'approve', aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'erp', connectorReady: true });
  let received: Record<string, unknown> | undefined;
  const erpConnector: OutboxConnectorPort = {
    async execute(connectorId, action, input) {
      assert.equal(connectorId, 'erp'); assert.equal(action, 'po.create_draft'); received = input;
      return { ok: true, output: { id: 701, name: 'PO-701', state: 'draft', correlationKey: input['correlationKey'], replayed: false } };
    },
    listCredentials: () => [{ id: 'credential:erp', connectorId: 'erp', status: 'connected' }],
    getCredential: () => ({ baseUrl: 'http://fake-odoo.invalid', database: 'fake', apiKey: 'fake' }),
  };
  const worker = new ProcurementOutboxWorker(store.db, () => erpConnector, { now: () => new Date(at) });
  const result = await worker.runTenant(tenantId);
  assert.deepEqual(result, { claimed: 1, dispatched: 1, retryScheduled: 0, failed: 0 });
  assert.deepEqual(received, { poId: po.id, poVersion: 1, correlationKey: `readywork:${tenantId}:${po.id}`, partnerId: 8, currencyCode: 'CNY', lines: [{ itemCode: 'VALVE-1', quantity: 2, priceUnit: 50, description: '阀门', datePlanned: '2026-09-01T00:00:00.000Z' }] });
  assert.deepEqual(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.odooReference, { id: 701, name: 'PO-701', correlationKey: `readywork:${tenantId}:${po.id}`, createdAt: at });
  store.close();
});

test('Outbox Worker: ERP 租约领取后必须重新解析当前租户凭据，删除/失效时不外呼', async () => {
  const tenantId = 'tenant:outbox:odoo-resolver';
  const store = openPersistence(':memory:', { tenantId });
  const repository = createProcurementRepository(store.db, tenantId);
  const supplier: Supplier = { id: 'supplier:resolver', tenantId, sourceSystem: 'odoo', externalId: 'odoo-9', status: 'active', createdAt: at, updatedAt: at, name: '供应商', currency: 'CNY', contacts: [] };
  const po: PurchaseOrder = { id: 'po:resolver', tenantId, sourceSystem: 'readywork', externalId: 'PO-RESOLVER', status: 'draft', createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at };
  const line: PurchaseOrderLine = { id: 'po-line:resolver', poId: po.id, lineNumber: '10', itemId: 'VALVE-2', description: '阀门', uom: '件', orderedQty: 1, unitPrice: 10, currency: 'CNY', requestedAt: '2026-09-01T00:00:00.000Z' };
  repository.saveDocument('supplier', supplier); repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
  const queued = repository.executeProcurementMutation({ action: 'create_odoo_po_draft', idempotencyKey: 'odoo-resolver-1', payloadHash: 'odoo-resolver-hash', actorId: 'human:manager', permission: 'approve', aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'erp', connectorReady: true });
  let calls = 0; let resolvedTenant = '';
  const worker = new ProcurementOutboxWorker(store.db, () => ({
    async execute() { calls += 1; return { ok: true, output: {} }; },
    listCredentials: () => [{ id: 'credential:old', connectorId: 'erp', status: 'connected' }],
    getCredential: () => ({ apiKey: 'must-not-be-used' }),
  }), {
    now: () => new Date(at),
    odooRuntimeResolver: { resolve: (tenant) => { resolvedTenant = tenant; return undefined; } },
  });
  const result = await worker.runTenant(tenantId);
  assert.equal(result.claimed, 1, 'the message was leased before the resolver re-check');
  assert.equal(result.failed, 1);
  assert.equal(resolvedTenant, tenantId);
  assert.equal(calls, 0, 'a deleted/unverified tenant ERP credential must prevent the external call');
  assert.match(repository.getOutboxMessage(queued.outbox!.id)?.error ?? '', /未配置、未验证、已删除或无法解密/);
  store.close();
});

test('Outbox Worker: ERP 成功回执冻结凭据 ID、版本与最近外部测试时间', async () => {
  const tenantId = 'tenant:outbox:odoo-audit';
  const store = openPersistence(':memory:', { tenantId });
  const repository = createProcurementRepository(store.db, tenantId);
  const supplier: Supplier = { id: 'supplier:audit', tenantId, sourceSystem: 'odoo', externalId: 'odoo-10', status: 'active', createdAt: at, updatedAt: at, name: '供应商', currency: 'CNY', contacts: [] };
  const po: PurchaseOrder = { id: 'po:audit', tenantId, sourceSystem: 'readywork', externalId: 'PO-AUDIT', status: 'draft', createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at };
  const line: PurchaseOrderLine = { id: 'po-line:audit', poId: po.id, lineNumber: '10', itemId: 'VALVE-3', description: '阀门', uom: '件', orderedQty: 1, unitPrice: 10, currency: 'CNY', requestedAt: '2026-09-01T00:00:00.000Z' };
  repository.saveDocument('supplier', supplier); repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
  const queued = repository.executeProcurementMutation({ action: 'create_odoo_po_draft', idempotencyKey: 'odoo-audit-1', payloadHash: 'odoo-audit-hash', actorId: 'human:manager', permission: 'approve', aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'erp', connectorReady: true });
  const worker = new ProcurementOutboxWorker(store.db, () => ({
    async execute() { throw new Error('tenant resolver must execute ERP directly'); },
    listCredentials: () => [{ id: 'credential:erp:audit', connectorId: 'erp', status: 'connected' }],
    getCredential: () => ({ apiKey: 'not-used' }),
  }), {
    now: () => new Date(at),
    odooRuntimeResolver: { resolve: (tenant) => tenant === tenantId ? {
      client: { createPurchaseOrderDraft: async () => ({ id: 801, name: 'PO-801', state: 'draft', replayed: false }) } as never,
      credential: { credentialId: 'credential:erp:audit', credentialVersion: '2026-09-02T00:00:00.000Z', lastTestedAt: '2026-09-02T00:00:00.000Z' },
    } : undefined },
  });
  assert.equal((await worker.runTenant(tenantId)).dispatched, 1);
  const result = repository.getOutboxMessage(queued.outbox!.id)?.connectorResult;
  assert.deepEqual(result?.['credential'], { credentialId: 'credential:erp:audit', credentialVersion: '2026-09-02T00:00:00.000Z', lastTestedAt: '2026-09-02T00:00:00.000Z' });
  assert.equal(JSON.stringify(result).includes('not-used'), false);
  store.close();
});

test('Outbox Worker: Cancel PO 只在 Odoo 取消读回后投影成功，明确拒绝与网络未知分流', async (t) => {
  const fixture = (suffix: string) => {
    const tenantId = `tenant:outbox:cancel:${suffix}`;
    const store = openPersistence(':memory:', { tenantId });
    const repository = createProcurementRepository(store.db, tenantId);
    const supplier: Supplier = { id: `supplier:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `odoo-${suffix}`, status: 'active', createdAt: at, updatedAt: at, name: '取消测试供应商', currency: 'CNY', contacts: [] };
    const po = { id: `po:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `purchase.order:${suffix}`, status: 'confirmed', createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at, number: `P00${suffix}` } as PurchaseOrder & { number: string };
    const line: PurchaseOrderLine = { id: `line:${suffix}`, poId: po.id, lineNumber: '10', itemId: 'VALVE', uom: 'EA', orderedQty: 2, unitPrice: 20, currency: 'CNY' };
    repository.saveDocument('supplier', supplier); repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
    const queued = repository.executeProcurementMutation({
      action: 'cancel_po', idempotencyKey: `cancel:${suffix}`, payloadHash: `cancel:${suffix}:hash`, actorId: 'human:manager',
      permission: 'operate_and_approve', aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'erp', connectorReady: true,
      reason: '项目终止，已完成内部审批',
    });
    return { tenantId, store, repository, po, queued };
  };

  await t.test('matching readback', async () => {
    const { tenantId, store, repository, po, queued } = fixture('901');
    let cancelCalls = 0;
    const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => { throw new Error('tenant resolver must execute ERP directly'); }), {
      now: () => new Date(at),
      odooRuntimeResolver: { resolve: () => ({
        client: { cancelPurchaseOrder: async () => { cancelCalls += 1; return { id: 901, name: 'P00901', state: 'cancel', replayed: false }; } } as never,
        credential: { credentialId: 'credential:erp:cancel', credentialVersion: 'v1', lastTestedAt: at },
      }) },
    });
    assert.deepEqual(await worker.runTenant(tenantId), { claimed: 1, dispatched: 1, retryScheduled: 0, failed: 0 });
    assert.equal(cancelCalls, 1);
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.status, 'cancelled');
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.version, 2);
    assert.equal(store.db.prepare('SELECT state FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?').get(tenantId, queued.amendment!.id)?.['state'], 'applied');
    assert.equal(repository.getOutboxMessage(queued.outbox!.id)?.connectorResult?.['receiptReference'], 'purchase.order:901');
    store.close();
  });

  await t.test('definite rejection', async () => {
    const { tenantId, store, repository, po, queued } = fixture('902');
    const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => { throw new Error('not used'); }), {
      now: () => new Date(at), maximumAttempts: 3,
      odooRuntimeResolver: { resolve: () => ({
        client: { cancelPurchaseOrder: async () => { throw new OdooPurchaseOrderCancellationRejectedError('Odoo rejected cancellation'); } } as never,
        credential: { credentialId: 'credential:erp:cancel', credentialVersion: 'v1', lastTestedAt: at },
      }) },
    });
    assert.deepEqual(await worker.runTenant(tenantId), { claimed: 1, dispatched: 0, retryScheduled: 0, failed: 1 });
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.status, 'confirmed');
    assert.equal(store.db.prepare('SELECT state FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?').get(tenantId, queued.amendment!.id)?.['state'], 'failed');
    store.close();
  });

  await t.test('network uncertainty', async () => {
    const { tenantId, store, repository, po, queued } = fixture('903');
    const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => { throw new Error('not used'); }), {
      now: () => new Date(at), maximumAttempts: 3,
      odooRuntimeResolver: { resolve: () => ({
        client: { cancelPurchaseOrder: async () => { throw new Error('Odoo cancellation response timed out'); } } as never,
        credential: { credentialId: 'credential:erp:cancel', credentialVersion: 'v1', lastTestedAt: at },
      }) },
    });
    assert.deepEqual(await worker.runTenant(tenantId), { claimed: 1, dispatched: 0, retryScheduled: 0, failed: 1 });
    assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.status, 'confirmed');
    assert.equal(store.db.prepare('SELECT state FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?').get(tenantId, queued.amendment!.id)?.['state'], 'unknown');
    const exception = store.db.prepare('SELECT json FROM runtime_exceptions WHERE tenant_id=? AND object_id=?').get(tenantId, po.id) as { json: string };
    assert.equal(JSON.parse(exception.json)['type'], 'external_delivery_uncertain');
    store.close();
  });
});

test('Outbox Worker: Edit RIHD 真实写 Odoo 后回读全部行，成功才更新 SQLite', async () => {
  const tenantId = 'tenant:outbox:rihd';
  const store = openPersistence(':memory:', { tenantId });
  const repository = createProcurementRepository(store.db, tenantId);
  const po = {
    id: 'po:rihd', tenantId, sourceSystem: 'odoo', externalId: 'purchase.order:22', status: 'confirmed', createdAt: at, updatedAt: at,
    supplierId: 'supplier:rihd', currency: 'CNY', orderedAt: at, number: 'P00022',
    requiredInHouseAt: '2026-09-10T00:00:00.000Z', promisedAt: '2026-09-10T00:00:00.000Z',
  } as PurchaseOrder & { number: string };
  const line: PurchaseOrderLine = { id: 'po-line:rihd', poId: po.id, lineNumber: '91', itemId: 'VALVE-22', uom: '件', orderedQty: 8, unitPrice: 20, currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z' };
  repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
  const queued = repository.executeProcurementMutation({
    action: 'update_rihd', idempotencyKey: 'rihd-1', payloadHash: 'rihd-hash', actorId: 'human:manager', permission: 'approve',
    aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'erp', connectorReady: true,
    requiredInHouseAt: '2026-09-30T00:00:00.000Z', reason: '项目需求日已批准调整',
  });
  let updateInput: { poNumber: string; eta: string } | undefined;
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => { throw new Error('tenant resolver must execute ERP directly'); }), {
    now: () => new Date(at),
    odooRuntimeResolver: { resolve: () => ({
      client: {
        updateETA: async (poNumber: string, eta: string) => { updateInput = { poNumber, eta }; return { updated: 1, lines: 1 }; },
        readPO: async () => ({ name: 'P00022', lines: [{ id: 91, datePlanned: '2026-09-30 00:00:00' }] }),
      } as never,
      credential: { credentialId: 'credential:erp:rihd', credentialVersion: 'v3', lastTestedAt: at },
    }) },
  });
  assert.equal((await worker.runTenant(tenantId)).dispatched, 1);
  assert.deepEqual(updateInput, { poNumber: 'P00022', eta: '2026-09-30T00:00:00.000Z' });
  const completed = repository.getOutboxMessage(queued.outbox!.id)!;
  assert.deepEqual(completed.connectorResult, {
    po_name: 'P00022', required_in_house_at: '2026-09-30T00:00:00.000Z', updated_lines: 1, verified_lines: 1,
    credential: { credentialId: 'credential:erp:rihd', credentialVersion: 'v3', lastTestedAt: at },
  });
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.requiredInHouseAt, '2026-09-30T00:00:00.000Z');
  assert.equal(repository.getLine<PurchaseOrderLine>('purchase_order_line', line.id)?.requestedAt, '2026-09-30T00:00:00.000Z');
  store.close();
});

test('Outbox Worker: Edit RIHD 写后回读不一致时标记结果不确定，不伪造本地成功', async () => {
  const tenantId = 'tenant:outbox:rihd-mismatch';
  const store = openPersistence(':memory:', { tenantId });
  const repository = createProcurementRepository(store.db, tenantId);
  const po = {
    id: 'po:rihd-mismatch', tenantId, sourceSystem: 'odoo', externalId: 'purchase.order:23', status: 'confirmed', createdAt: at, updatedAt: at,
    supplierId: 'supplier:rihd', currency: 'CNY', orderedAt: at, number: 'P00023', requiredInHouseAt: '2026-09-10T00:00:00.000Z',
  } as PurchaseOrder & { number: string };
  const line: PurchaseOrderLine = { id: 'po-line:rihd-mismatch', poId: po.id, lineNumber: '92', itemId: 'VALVE-23', uom: '件', orderedQty: 1, unitPrice: 20, currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z' };
  repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
  const queued = repository.executeProcurementMutation({ action: 'update_rihd', idempotencyKey: 'rihd-mismatch', payloadHash: 'rihd-mismatch-hash', actorId: 'human:manager', permission: 'approve', aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'erp', connectorReady: true, requiredInHouseAt: '2026-09-30T00:00:00.000Z', reason: '给定真实修改原因' });
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => { throw new Error('not used'); }), {
    now: () => new Date(at), maximumAttempts: 1,
    odooRuntimeResolver: { resolve: () => ({
      client: { updateETA: async () => ({ updated: 1, lines: 1 }), readPO: async () => ({ name: 'P00023', lines: [{ id: 92, datePlanned: '2026-10-01 00:00:00' }] }) } as never,
      credential: { credentialId: 'credential:erp:rihd', credentialVersion: 'v3', lastTestedAt: at },
    }) },
  });
  const result = await worker.runTenant(tenantId);
  assert.equal(result.failed, 1);
  assert.equal(repository.getOutboxMessage(queued.outbox!.id)?.status, 'failed');
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.requiredInHouseAt, '2026-09-10T00:00:00.000Z');
  assert.equal(repository.getLine<PurchaseOrderLine>('purchase_order_line', line.id)?.requestedAt, '2026-09-10T00:00:00.000Z');
  const exception = store.db.prepare(`SELECT json FROM runtime_exceptions WHERE tenant_id=? AND object_id=?`).get(tenantId, po.id) as { json: string };
  assert.equal(JSON.parse(exception.json)['type'], 'external_delivery_uncertain');
  store.close();
});

test('Outbox Worker: Edit PO amendment 写入 Odoo 并以匹配读回推进 amendment', async () => {
  const tenantId = 'tenant:outbox:po-amendment';
  const store = openPersistence(':memory:', { tenantId });
  const repository = createProcurementRepository(store.db, tenantId);
  const po = {
    id: 'po:amendment', tenantId, sourceSystem: 'odoo', externalId: 'purchase.order:81', status: 'confirmed', createdAt: at, updatedAt: at,
    supplierId: 'supplier:amendment', currency: 'CNY', orderedAt: at, number: 'P00081', requiredInHouseAt: '2026-09-10T00:00:00.000Z',
  } as PurchaseOrder & { number: string };
  const line: PurchaseOrderLine = {
    id: 'po-line:amendment', poId: po.id, lineNumber: '901', itemId: 'VALVE-81', uom: '件', orderedQty: 2, unitPrice: 20,
    currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z',
  };
  repository.saveDocument('supplier', {
    id: po.supplierId, tenantId, sourceSystem: 'odoo', externalId: 'odoo-81', status: 'active', createdAt: at, updatedAt: at,
    name: 'amendment supplier', currency: 'CNY', contacts: [],
  } as Supplier);
  repository.saveDocument('purchase_order', po); repository.saveLine('purchase_order_line', po.id, line);
  const queued = repository.executeProcurementMutation({
    action: 'edit_po', idempotencyKey: 'po-amendment-1', payloadHash: 'po-amendment-hash', actorId: 'human:manager', permission: 'operate',
    aggregateId: po.id, expectedVersion: 1, occurredAt: at, connectorId: 'erp', connectorReady: true,
    patch: { requiredInHouseAt: '2026-09-30T00:00:00.000Z' }, reason: '项目需求日已批准调整',
  });
  let updateInput: { poNumber: string; eta: string } | undefined;
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => { throw new Error('tenant resolver must execute ERP directly'); }), {
    now: () => new Date(at),
    odooRuntimeResolver: { resolve: () => ({
      client: {
        updateETA: async (poNumber: string, eta: string) => { updateInput = { poNumber, eta }; return { updated: 1, lines: 1 }; },
        readPO: async () => ({ id: 81, name: 'P00081', lines: [{ id: 901, datePlanned: '2026-09-30 00:00:00' }] }),
      } as never,
      credential: { credentialId: 'credential:erp:amendment', credentialVersion: 'v4', lastTestedAt: at },
    }) },
  });
  assert.deepEqual(await worker.runTenant(tenantId), { claimed: 1, dispatched: 1, retryScheduled: 0, failed: 0 });
  assert.deepEqual(updateInput, { poNumber: 'P00081', eta: '2026-09-30T00:00:00.000Z' });
  assert.deepEqual(repository.getOutboxMessage(queued.outbox!.id)?.connectorResult, {
    po_name: 'P00081', readbackMatches: true, receiptReference: 'purchase.order:81',
    credential: { credentialId: 'credential:erp:amendment', credentialVersion: 'v4', lastTestedAt: at },
  });
  const amendment = store.db.prepare('SELECT state FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?')
    .get(tenantId, queued.amendment!.id) as { state: string } | undefined;
  assert.equal(amendment?.state, 'applied');
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.version, 2, 'matching authoritative readback advances the local PO');
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', po.id)?.document.requiredInHouseAt, '2026-09-30T00:00:00.000Z');
  store.close();
});

test('Outbox Worker: amendment mismatch creates purchase-order attention without replay', async () => {
  const { tenantId, store, repository, po, queued } = amendmentFixture('mismatch');
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => { throw new Error('tenant resolver must execute ERP directly'); }), {
    now: () => new Date(at),
    odooRuntimeResolver: { resolve: () => ({
      client: {
        updateETA: async () => ({ updated: 1, lines: 1 }),
        readPO: async () => ({ id: 81, name: 'P00081', lines: [{ id: 901, datePlanned: '2026-10-01 00:00:00' }] }),
      } as never,
      credential: { credentialId: 'credential:erp:mismatch', credentialVersion: 'v1', lastTestedAt: at },
    }) },
  });
  assert.equal((await worker.runTenant(tenantId)).dispatched, 1);
  assert.equal(repository.getOutboxMessage(queued.outbox!.id)?.status, 'dispatched');
  const amendment = store.db.prepare('SELECT state FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?')
    .get(tenantId, queued.amendment!.id) as { state: string } | undefined;
  assert.equal(amendment?.state, 'unknown');
  const exception = store.db.prepare('SELECT json FROM runtime_exceptions WHERE tenant_id=? AND object_id=?')
    .get(tenantId, po.id) as { json: string } | undefined;
  assert.equal(JSON.parse(exception!.json)['objectType'], 'purchase_order');
  store.close();
});

test('Outbox Worker: amendment write/readback uncertainty is terminal, unknown and needs attention', async (t) => {
  const cases: Array<{ name: string; client: Record<string, unknown> }> = [
    { name: 'write-timeout', client: { updateETA: async () => { throw new Error('Odoo write request timed out'); }, readPO: async () => null } },
    { name: 'readback-timeout', client: { updateETA: async () => ({ updated: 1, lines: 1 }), readPO: async () => { throw new Error('Odoo readback timed out'); } } },
    { name: 'wrong-identity', client: { updateETA: async () => ({ updated: 1, lines: 1 }), readPO: async () => ({ id: 82, name: 'P00082', lines: [{ id: 901, datePlanned: '2026-09-30 00:00:00' }] }) } },
  ];
  for (const fixture of cases) await t.test(fixture.name, async () => {
    const { tenantId, store, repository, po, queued } = amendmentFixture(fixture.name);
    const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => { throw new Error('tenant resolver must execute ERP directly'); }), {
      now: () => new Date(at), maximumAttempts: 3,
      odooRuntimeResolver: { resolve: () => ({
        client: fixture.client as never,
        credential: { credentialId: `credential:erp:${fixture.name}`, credentialVersion: 'v1', lastTestedAt: at },
      }) },
    });
    assert.deepEqual(await worker.runTenant(tenantId), { claimed: 1, dispatched: 0, retryScheduled: 0, failed: 1 });
    assert.equal(repository.getOutboxMessage(queued.outbox!.id)?.status, 'failed');
    const amendment = store.db.prepare('SELECT state FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?')
      .get(tenantId, queued.amendment!.id) as { state: string } | undefined;
    assert.equal(amendment?.state, 'unknown');
    const exception = store.db.prepare('SELECT json FROM runtime_exceptions WHERE tenant_id=? AND object_id=?')
      .get(tenantId, po.id) as { json: string } | undefined;
    const parsed = JSON.parse(exception!.json) as Record<string, unknown>;
    assert.equal(parsed['type'], 'external_delivery_uncertain');
    assert.equal(parsed['objectType'], 'purchase_order');
    store.close();
  });
});

test('Outbox Worker: amendment frozen-payload validation failure is deterministic failed without Needs attention', async () => {
  const { tenantId, store, repository, po, queued } = amendmentFixture('invalid-frozen-payload');
  const row = store.db.prepare('SELECT payload_json,json FROM procurement_outbox WHERE tenant_id=? AND id=?')
    .get(tenantId, queued.outbox!.id) as { payload_json: string; json: string };
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  payload['sourcePoVersion'] = 0;
  const message = JSON.parse(row.json) as { payload: Record<string, unknown> };
  message.payload = payload;
  store.db.prepare('UPDATE procurement_outbox SET payload_json=?,json=? WHERE tenant_id=? AND id=?')
    .run(JSON.stringify(payload), JSON.stringify(message), tenantId, queued.outbox!.id);
  let resolverCalled = false;
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => ({ ok: false, error: 'connector must not be called' })), {
    now: () => new Date(at),
    odooRuntimeResolver: { resolve: () => { resolverCalled = true; return undefined; } },
  });
  assert.deepEqual(await worker.runTenant(tenantId), { claimed: 1, dispatched: 0, retryScheduled: 0, failed: 1 });
  assert.equal(resolverCalled, false, 'frozen payload is rejected before external dispatch begins');
  assert.equal(repository.getOutboxMessage(queued.outbox!.id)?.status, 'failed');
  const amendment = store.db.prepare('SELECT state FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?')
    .get(tenantId, queued.amendment!.id) as { state: string } | undefined;
  assert.equal(amendment?.state, 'failed');
  const attention = store.db.prepare('SELECT COUNT(*) AS count FROM runtime_exceptions WHERE tenant_id=? AND object_id=?')
    .get(tenantId, po.id) as { count: number };
  assert.equal(attention.count, 0, 'pre-dispatch validation failure is not an uncertain external delivery');
  store.close();
});

test('Outbox Worker: 明确未连接可安全重试，超时结果不确定则终止重放', async () => {
  const retryFixture = fixture();
  const retryWorker = new ProcurementOutboxWorker(retryFixture.store.db, () => connector(async () => ({ ok: false, error: 'connect ECONNREFUSED 127.0.0.1:465 token=secret-value' })), { now: () => new Date(at) });
  const retry = await retryWorker.runTenant('tenant:outbox');
  assert.equal(retry.retryScheduled, 1);
  const retryMessage = retryFixture.repository.getOutboxMessage(retryFixture.queued.outbox!.id)!;
  assert.equal(retryMessage.status, 'pending');
  assert.equal(retryMessage.error?.includes('secret-value'), false);
  retryFixture.store.close();

  const timeoutFixture = fixture();
  const timeoutWorker = new ProcurementOutboxWorker(timeoutFixture.store.db, () => connector(async () => ({ ok: false, error: 'SMTP 整体超时 token=secret-value' })), { now: () => new Date(at) });
  const timeout = await timeoutWorker.runTenant('tenant:outbox');
  assert.equal(timeout.failed, 1);
  const timeoutMessage = timeoutFixture.repository.getOutboxMessage(timeoutFixture.queued.outbox!.id)!;
  assert.equal(timeoutMessage.status, 'failed');
  assert.equal(timeoutMessage.error?.includes('secret-value'), false);
  assert.equal(timeoutFixture.repository.getDocument<PurchaseOrder>('purchase_order', 'po:1')?.document.status, 'draft');
  const exceptionRows = timeoutFixture.store.db.prepare(`SELECT json FROM runtime_exceptions
    WHERE tenant_id=? AND object_id=?`).all('tenant:outbox', 'po:1') as Array<{ json: string }>;
  assert.equal(exceptionRows.length, 1);
  const exception = JSON.parse(exceptionRows[0]!.json) as Record<string, unknown>;
  assert.equal(exception['type'], 'external_delivery_uncertain');
  assert.equal(exception['status'], 'open');
  assert.equal(JSON.stringify(exception).includes('secret-value'), false);
  timeoutFixture.store.close();
});

test('Outbox Worker: 已批准 PO 缺少冻结的专业联系人身份时阻止连接器调用', async () => {
  const { store, repository, queued } = fixture();
  const row = store.db.prepare('SELECT payload_json,json FROM procurement_outbox WHERE tenant_id=? AND id=?')
    .get('tenant:outbox', queued.outbox!.id) as { payload_json: string; json: string };
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  delete payload['communicationIdentity'];
  const outboxJson = JSON.parse(row.json) as { payload: Record<string, unknown> };
  delete outboxJson.payload['communicationIdentity'];
  store.db.prepare('UPDATE procurement_outbox SET payload_json=?,json=? WHERE tenant_id=? AND id=?')
    .run(JSON.stringify(payload), JSON.stringify(outboxJson), 'tenant:outbox', queued.outbox!.id);
  let calls = 0;
  const worker = new ProcurementOutboxWorker(store.db, () => connector(async () => {
    calls += 1;
    return { ok: true, output: { message_id: 'must-not-send' } };
  }), { now: () => new Date(at) });
  const result = await worker.runTenant('tenant:outbox');
  assert.deepEqual(result, { claimed: 1, dispatched: 0, retryScheduled: 0, failed: 1 });
  assert.equal(calls, 0);
  const outbox = repository.getOutboxMessage(queued.outbox!.id)!;
  assert.equal(outbox.status, 'failed');
  assert.match(outbox.error ?? '', /冻结.*采购专业联系人身份/);
  assert.equal(repository.getDocument<PurchaseOrder>('purchase_order', 'po:1')?.document.status, 'draft');
  store.close();
});
