import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestInboundPurchaseOrderEmail } from '../src/procurement-inbound-email.js';
import type { InboundEmail } from '@readywork/connectors';
import { MessagingRuntimeRegistry } from '../src/messaging/runtime.js';
import {
  ProcurementMessagingBridge,
  normalizeInboundEmailEnvelope,
} from '../src/messaging/procurement-bridge.js';

const tenantId = 'tenant:bridge';
const at = '2026-09-08T00:00:00.000Z';

function email(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    id: 'imap-uid-21',
    from: '供应商 <supplier@example.test>',
    subject: 'Re: 采购订单 P00021',
    body: '本订单为境内采购。',
    receivedAt: at,
    messageId: '<reply-21@example.test>',
    inReplyTo: '<readywork-21@example.test>',
    references: ['<readywork-21@example.test>'],
    ...overrides,
  };
}

// Catches descriptor-only persistence: a restarted bridge must receive the same bytes.
test('I3 and M1 durable attachment and Communication source survive bridge failure and SQLite reopen', async()=>{
  const directory=mkdtempSync(join(tmpdir(),'gateway-attachment-replay-')); const path=join(directory,'replay.sqlite');
  let store=openPersistence(path,{tenantId});
  const incoming=email({attachments:[{filename:'evidence.txt',contentType:'text/plain',content:Buffer.from('immutable attachment input')}]});
  const env=normalizeInboundEmailEnvelope({tenantId,adapterId:'email',provider:'imap:example.test',mailbox:'INBOX',email:incoming});
  const repository=createProcurementRepository(store.db,tenantId);
  repository.saveDocument('supplier',{id:'supplier:one',tenantId,sourceSystem:'isolated',externalId:'supplier:one',status:'active',createdAt:at,updatedAt:at,name:'isolated',currency:'CNY',contacts:[{id:'contact:one',name:'supplier',email:'supplier@example.test',primary:true}]});
  repository.saveDocument('purchase_order',{id:'po:one',tenantId,sourceSystem:'isolated',externalId:'P00021',status:'sent',createdAt:at,updatedAt:at,supplierId:'supplier:one',currency:'CNY',orderedAt:at});
  let attempts=0; const observed:string[]=[]; let bridgeProvider='imap:example.test';
  const makeBridge=()=>new ProcurementMessagingBridge({db:store.db,tenantId,provider:bridgeProvider,mailbox:'INBOX',processPurchaseOrderEmail:async(input)=>{
    observed.push(Buffer.from(input.email.attachments?.[0]?.content??[]).toString());
    const result=ingestInboundPurchaseOrderEmail({...input,deferConfirmation:true});
    return {...result,retryable:++attempts===1,analysis:{status:attempts===1?'failed':'review_required'}};
  }});
  try {
    const runtime=new MessagingRuntimeRegistry(store.db,()=>({listCredentials:()=>[],getCredential:()=>undefined}),{now:()=>at}).forTenant(tenantId);
    const bridge=makeBridge();
    // The provider identity may already have a pre-gateway Communication.
    ingestInboundPurchaseOrderEmail({db:store.db,tenantId,provider:'imap:example.test',mailbox:'INBOX',email:incoming,poNumber:'P00021',deferConfirmation:true});
    const first=await runtime.processInbound(env,message=>bridge.handle(message,incoming),env.attachments.map((descriptor,index)=>({...descriptor,content:Buffer.from(incoming.attachments![index]!.content)})));
    assert.equal(first.status,'failed');
    store.close(); store=openPersistence(path,{tenantId});
    bridgeProvider='imap'; // Recovery must not depend on a currently configured IMAP host.
    const resumed=new MessagingRuntimeRegistry(store.db,()=>({listCredentials:()=>[],getCredential:()=>undefined}),{now:()=>at}).forTenant(tenantId);
    const replayBridge=makeBridge();
    await resumed.runPendingInbound(message=>replayBridge.handle(message));
    assert.deepEqual(observed,['immutable attachment input','immutable attachment input']);
    const attachment=store.db.prepare('SELECT content FROM procurement_attachments WHERE tenant_id=?').all(tenantId) as Array<{content:Uint8Array}>;
    assert.equal(attachment.length,1);
    assert.equal(Buffer.from(attachment[0]!.content).toString(),'immutable attachment input');
    const communications=store.db.prepare("SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='communication'").all(tenantId) as Array<{json:string}>;
    assert.equal(communications.length,1);
    assert.equal(JSON.parse(communications[0]!.json).gatewayInboundId,env.id);
    assert.equal(resumed.repository.listInbound()[0]?.status,'processed');
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('I3 descriptor-only input cannot acknowledge receipt or leave a partial inbox row',async()=>{
  const store=openPersistence(':memory:',{tenantId});
  try {
    const incoming=email({attachments:[{filename:'evidence.txt',contentType:'text/plain',content:Buffer.from('required bytes')}]});
    const envelope=normalizeInboundEmailEnvelope({tenantId,adapterId:'email',provider:'imap',mailbox:'INBOX',email:incoming});
    const runtime=new MessagingRuntimeRegistry(store.db,()=>({listCredentials:()=>[],getCredential:()=>undefined}),{now:()=>at}).forTenant(tenantId);
    await assert.rejects(()=>runtime.processInbound(envelope,async()=>({status:'processed'})),/附件字节未可靠持久化/);
    assert.equal(runtime.repository.listInbound().length,0);
  } finally {store.close();}
});

test('Email normalization creates a stable tenant-scoped identity and immutable fingerprint', () => {
  const first = normalizeInboundEmailEnvelope({
    tenantId,
    adapterId: 'email',
    provider: 'imap:example.test',
    mailbox: 'INBOX',
    email: email(),
  });
  const replay = normalizeInboundEmailEnvelope({
    tenantId,
    adapterId: 'email',
    provider: 'imap:example.test',
    mailbox: 'INBOX',
    email: email(),
  });
  const changed = normalizeInboundEmailEnvelope({
    tenantId,
    adapterId: 'email',
    provider: 'imap:example.test',
    mailbox: 'INBOX',
    email: email({ body: '本订单改为进口采购。' }),
  });

  assert.equal(first.id, replay.id);
  assert.equal(first.rawFingerprint, replay.rawFingerprint);
  assert.equal(first.providerMessageId, '<reply-21@example.test>');
  assert.equal(first.sender.address, 'supplier@example.test');
  assert.equal(first.sender.displayName, '供应商');
  assert.notEqual(first.rawFingerprint, changed.rawFingerprint);
  assert.equal(first.attachments.length, 0);
  assert.equal('poId' in first, false);
});

test('IMAP ingress is persisted before procurement processing and retry reuses one inbox row', async () => {
  const store = openPersistence(':memory:', { tenantId });
  try {
    let attempts = 0;
    const runtime = new MessagingRuntimeRegistry(store.db, () => ({
      listCredentials: () => [],
      getCredential: () => undefined,
    }), { now: () => at }).forTenant(tenantId);
    const bridge = new ProcurementMessagingBridge({
      db: store.db,
      tenantId,
      provider: 'imap:example.test',
      mailbox: 'INBOX',
      processPurchaseOrderEmail: async (input) => {
        attempts += 1;
        const persisted = store.db.prepare(`SELECT status FROM messaging_inbound_messages
          WHERE tenant_id=? AND id=?`).get(tenantId, input.gatewayInboundId) as { status: string };
        assert.equal(persisted.status, 'dispatching');
        if (attempts === 1) throw new Error('采购桥接暂时不可用');
        return {
          retryable: false,
          purchaseOrderId: 'purchase-order:odoo:21',
          purchaseOrderNumber: 'P00021',
          communicationId: 'communication:reply-21',
          analysis: { status: 'applied' },
        };
      },
    });
    const envelope = normalizeInboundEmailEnvelope({
      tenantId,
      adapterId: 'email',
      provider: 'imap:example.test',
      mailbox: 'INBOX',
      email: email(),
    });
    runtime.repository.receive({
      ...envelope,
      id: 'messaging-inbound:older',
      providerMessageId: '<older@example.test>',
      rawFingerprint: 'f'.repeat(64),
    });

    const failed = await runtime.processInbound(envelope, (message) => bridge.handle(message));
    assert.equal(failed.status, 'failed');
    assert.equal(runtime.repository.listInbound().find((item) => item.envelope.id === envelope.id)?.status, 'failed');
    assert.equal(runtime.repository.listInbound().find((item) => item.envelope.id === 'messaging-inbound:older')?.status, 'received');

    const recovered = await runtime.processInbound(envelope, (message) => bridge.handle(message));
    assert.equal(recovered.status, 'processed');
    assert.equal(recovered.replayed, true);
    assert.equal(runtime.repository.listInbound().find((item) => item.envelope.id === envelope.id)?.status, 'processed');
    assert.equal(runtime.repository.listInbound().length, 2);
    assert.equal(attempts, 2);
  } finally {
    store.close();
  }
});
