import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { MessageGateway, MessagingRepository, type AdapterSendResult, type MessageDeliveryRequest } from '@readywork/messaging';
import { MessagingRuntimeRegistry } from '../src/messaging/runtime.js';
import { normalizeInboundEmailEnvelope } from '../src/messaging/procurement-bridge.js';
import { EmailMessagingAdapter } from '../src/messaging/email-adapter.js';

const tenantId = 'tenant:final-fix';
const at = '2026-09-08T00:00:00.000Z';
const control = { listCredentials: () => [{ id: 'isolated', connectorId: 'email', status: 'connected' }], getCredential: () => ({ username: 'isolated@example.test', password: 'isolated-test' }) };
const req: MessageDeliveryRequest = { tenantId, adapterId: 'email', channel: 'email', idempotencyKey: 'one', recipients: [{address:'recipient@example.test'}], text:'isolated', attachments:[], trace:{source:'procurement_outbox',sourceId:'isolated',correlationId:'isolated'} };
const envelope = () => normalizeInboundEmailEnvelope({ tenantId, adapterId:'email',provider:'imap',mailbox:'INBOX',email:{id:'1',from:'sender@example.test',subject:'isolated',body:'isolated',receivedAt:at,messageId:'<isolated@example.test>'} });

test('M2 lifecycle registration, health, breaker and completed domain dispatch have body-free audits',async()=>{
  const store=openPersistence(':memory:',{tenantId});
  try {
    const runtime=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=>at,sendMail:async()=>({ok:false,message:'isolated failure',retryable:true,dispatchStage:'before_dispatch'})}).forTenant(tenantId);
    await runtime.gateway.health();
    for(const key of ['one','two','three']) await runtime.deliver({...req,idempotencyKey:key});
    await runtime.processInbound(envelope(),async()=>({status:'processed',communicationId:'communication:one'}));
    const events=store.db.prepare('SELECT event_type,metadata_json FROM messaging_gateway_events WHERE tenant_id=?').all(tenantId) as Array<{event_type:string;metadata_json:string}>;
    for(const kind of ['adapter_registered','adapter_health_changed','adapter_breaker_opened','inbound_domain_processed']) assert.ok(events.some(event=>event.event_type===kind),kind);
    assert.doesNotMatch(JSON.stringify(events),/sender@example\.test|immutable attachment input/);
  } finally {store.close();}
});

test('I5 configured credentials do not constitute observed SMTP health or resume success',async()=>{
  const store=openPersistence(':memory:',{tenantId});
  try {
    const runtime=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=>at,sendMail:async()=>{throw new Error('send forbidden');}}).forTenant(tenantId);
    assert.equal(runtime.getAdapterState('email').status,'degraded');
    assert.equal(runtime.getAdapterState('email').lastHealthAt,undefined);
    await runtime.gateway.health();
    assert.equal(runtime.getAdapterState('email').status,'degraded');
    assert.equal(runtime.getAdapterState('email').lastHealthAt,at);
    const paused=runtime.pauseAdapter('email',runtime.getAdapterState('email').version,'admin','maintenance');
    assert.equal(runtime.resumeAdapter('email',paused.version,'admin','done').status,'degraded');
  } finally {store.close();}
});

test('I5 stale IMAP observation cannot remain running in a later control runtime',async()=>{
  const store=openPersistence(':memory:',{tenantId});
  try {
    const business=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=>at}).forTenant(tenantId);
    business.registerEmailReceiver(async()=>({handledCount:0}),true);
    await business.gateway.poll('email-imap',{trigger:'automatic'});
    assert.equal(business.getAdapterState('email-imap').status,'running');
    const later=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=> '2026-09-09T00:00:00.000Z'}).forTenant(tenantId);
    assert.equal(later.getAdapterState('email').startedAt,'2026-09-09T00:00:00.000Z');
    assert.equal(later.adapterStates().find(state=>state.adapterId==='email-imap')?.status,'degraded');
  } finally {store.close();}
});

test('I5 a recent past SMTP success cannot hide a newer failed call during health refresh',async()=>{
  const store=openPersistence(':memory:',{tenantId});let sends=0;
  try {
    const runtime=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=>at,sendMail:async()=>++sends===1
      ?{ok:true,message:'accepted',messageId:'<observed@example.test>'}:{ok:false,message:'ECONNREFUSED',dispatchStage:'before_dispatch',retryable:true}}).forTenant(tenantId);
    await runtime.deliver(req);await runtime.deliver({...req,idempotencyKey:'two'});
    await runtime.gateway.health();
    assert.equal(runtime.getAdapterState('email').status,'degraded');
  } finally {store.close();}
});

test('I6 gateway receive capability gates new polling while durable replay stays available',async()=>{
  const store=openPersistence(':memory:',{tenantId}); let polls=0;
  try {
    const runtime=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=>at}).forTenant(tenantId);
    const receiver=new EmailMessagingAdapter('email-imap','imap',async()=>{throw new Error('receive-only');},{poll:async()=>{polls++;throw new Error('isolated IMAP connection refused');}});
    runtime.gateway.register(receiver);
    assert.ok(runtime.getAdapterState('email-imap').capabilities.includes('receive'));
    for(let n=0;n<3;n++) await runtime.gateway.poll('email-imap',{});
    assert.equal(runtime.getAdapterState('email-imap').status,'paused_by_breaker');
    assert.equal((await runtime.gateway.poll('email-imap',{})).status,'blocked');
    assert.equal(polls,3);
    await runtime.ingest(envelope());
    assert.equal((await runtime.runPendingInbound(async()=>({status:'processed'}))).processed,1);
    assert.equal(runtime.getAdapterState('email-imap').lastHealthAt,at);
  } finally {store.close();}
});

test('N1 protocol ingestion durably stores attachment bytes without running a domain handler',async()=>{
  const store=openPersistence(':memory:',{tenantId});
  try {
    const runtime=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=>at}).forTenant(tenantId);
    const content=Buffer.from('durable inbound attachment');
    const descriptor={
      id:'attachment:n1',
      name:'confirmation.txt',
      contentType:'text/plain',
      sizeBytes:content.byteLength,
      sha256:createHash('sha256').update(content).digest('hex'),
    };
    await runtime.ingest({...envelope(),attachments:[descriptor]},[{...descriptor,content}]);

    const stored=runtime.repository.listInbound()[0];
    assert.deepEqual(stored?.attachments?.[0]?.content,content);
    assert.equal(stored?.status,'received');
  } finally {store.close();}
});

// A completion must not replace an independently committed administrative state.
for (const kind of ['accepted', 'retryable_before_dispatch', 'unknown_after_dispatch'] as const) {
  test(`I1 ${kind} completion preserves administrator pause`, async () => {
    const store = openPersistence(':memory:', {tenantId});
    try {
      const repo = new MessagingRepository(store.db, tenantId);
      const gateway = new MessageGateway(repo,{now:()=>at});
      let release!: (result: AdapterSendResult) => void;
      gateway.register({id:'email',channel:'email',provider:'smtp',capabilities:['send_text'],health:async()=>({ok:true}),send:()=>new Promise(resolve=>{release=resolve;})});
      const pending = gateway.deliver(req);
      gateway.pauseAdapter('email',gateway.getAdapterState('email').version,'admin','maintenance');
      release(kind==='accepted'?{kind,providerMessageId:'<accepted@example.test>',acceptedAt:at}:{kind,error:'isolated failure'});
      await pending;
      assert.equal(gateway.getAdapterState('email').status,'paused');
      assert.equal(gateway.getAdapterState('email').pauseReason,'maintenance');
    } finally {store.close();}
  });
}

test('I1 older success cannot clear concurrently tripped breaker', async () => {
  const store = openPersistence(':memory:',{tenantId});
  try {
    const gateway = new MessageGateway(new MessagingRepository(store.db,tenantId),{now:()=>at});
    let release!: (result: AdapterSendResult)=>void;
    gateway.register({id:'email',channel:'email',provider:'smtp',capabilities:['send_text'],health:async()=>({ok:true}),send:async(request)=>request.idempotencyKey==='one'?new Promise(resolve=>{release=resolve;}):{kind:'retryable_before_dispatch',error:'isolated failure'}});
    const pending=gateway.deliver(req);
    for(const key of ['two','three','four']) await gateway.deliver({...req,idempotencyKey:key});
    assert.equal(gateway.getAdapterState('email').status,'paused_by_breaker');
    release({kind:'accepted',providerMessageId:'<accepted@example.test>',acceptedAt:at});
    await pending;
    assert.equal(gateway.getAdapterState('email').status,'paused_by_breaker');
    assert.equal(gateway.getAdapterState('email').consecutiveFailures,3);
  } finally {store.close();}
});

for (const lateResult of ['processed','retryable_failure','throw'] as const) test(`I4 old runtime ${lateResult} returning after a new lease cannot terminate the new worker`, async () => {
  const store=openPersistence(':memory:',{tenantId}); let clock=at;
  try {
    const options={now:()=>clock};
    const a=new MessagingRuntimeRegistry(store.db,()=>control,options).forTenant(tenantId);
    const b=new MessagingRuntimeRegistry(store.db,()=>control,options).forTenant(tenantId);
    let releaseA!:()=>void; let releaseB!:()=>void;
    const old=a.processInbound(envelope(),async()=>{await new Promise<void>(resolve=>{releaseA=resolve;});
      if(lateResult==='throw') throw new Error('old failed');
      return lateResult==='retryable_failure'?{status:lateResult,error:'old failed'}:{status:lateResult,communicationId:'old'};
    });
    await Promise.resolve(); await Promise.resolve();
    clock='2026-09-08T00:10:00.000Z';
    const fresh=b.runPendingInbound(async()=>{await new Promise<void>(resolve=>{releaseB=resolve;});return {status:'processed',communicationId:'fresh'};});
    releaseA(); await old;
    assert.equal(b.repository.listInbound()[0]?.status,'dispatching');
    releaseB(); await fresh;
    assert.equal(b.repository.listInbound()[0]?.outcomeCode,'fresh');
  } finally {store.close();}
});

test('I4 historical terminal rows cannot starve pending inbound acquisition',async()=>{
  const store=openPersistence(':memory:',{tenantId});
  try {
    const runtime=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=>at}).forTenant(tenantId);
    for(let n=0;n<501;n++) runtime.repository.receive({...envelope(),id:`history:${String(n).padStart(4,'0')}`,providerMessageId:`<history-${n}@example.test>`});
    store.db.prepare("UPDATE messaging_inbound_messages SET status='processed' WHERE id<>'history:0500'").run();
    assert.equal((await runtime.runPendingInbound(async()=>({status:'processed'}))).processed,1);
  } finally {store.close();}
});

test('I7 expired sending recovers durably to audited unknown without resend', async()=>{
  const store=openPersistence(':memory:',{tenantId});
  try {
    const repo=new MessagingRepository(store.db,tenantId);
    const reserved=repo.reserveDelivery(req,at).delivery;
    repo.markDeliverySending(reserved.id,reserved.version,at);
    const runtime=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=> '2026-09-09T00:00:00.000Z',sendMail:async()=>{throw new Error('must never dispatch');}}).forTenant(tenantId);
    assert.equal((await runtime.deliver(req)).status,'unknown');
    assert.equal(repo.getDeliveryById(reserved.id)?.status,'unknown');
    assert.ok(store.db.prepare("SELECT 1 FROM messaging_gateway_events WHERE tenant_id=? AND event_type='delivery_recovered_unknown'").get(tenantId));
  } finally {store.close();}
});

test('I8 nested inbound failures are redacted before durable storage',async()=>{
  const store=openPersistence(':memory:',{tenantId});
  try {
    const runtime=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=>at}).forTenant(tenantId);
    const error=new Error('password=PW_SENTINEL authorizationCode=AUTH_SENTINEL sender@example.test',{cause:{token:'TOKEN_SENTINEL',nested:{secret:'SECRET_SENTINEL'}}});
    await runtime.processInbound(envelope(),async()=>{throw error;});
    const persisted=runtime.repository.listInbound()[0]?.error??'';
    assert.doesNotMatch(persisted,/PW_SENTINEL|AUTH_SENTINEL|TOKEN_SENTINEL|SECRET_SENTINEL|sender@example\.test/);
    assert.match(persisted,/REDACTED/);
  } finally {store.close();}
});
