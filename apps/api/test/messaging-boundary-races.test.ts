import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImapClient, type InboundEmail } from '@readywork/connectors';
import { openPersistence } from '@readywork/persistence';
import { createImapReceivePort } from '../src/messaging/email-adapter.js';
import { createDurableInboundMailHandler } from '../src/messaging/inbound-mail-handler.js';
import { MessagingRuntimeRegistry } from '../src/messaging/runtime.js';

const tenantId='tenant:boundary-races';
const at='2026-09-08T00:00:00.000Z';
const control={listCredentials:()=>[],getCredential:()=>undefined};

test('N1 slow successful domain processing does not consume the IMAP protocol timeout or failure budget',async(t)=>{
  const store=openPersistence(':memory:',{tenantId});
  try {
    const emails:InboundEmail[]=['1','2','3'].map(suffix=>({
      id:`uid-${suffix}`,
      from:'supplier@example.test',
      subject:'Re: P00021',
      body:`供应商自然语言回复 ${suffix}`,
      receivedAt:at,
      messageId:`<n1-${suffix}@example.test>`,
      attachments:[{filename:`confirmation-${suffix}.txt`,contentType:'text/plain',content:Buffer.from(`confirmation-${suffix}`)}],
    }));
    const seen:string[]=[];
    const client={
      fetchUnseen:async()=>emails,
      markSeen:async(uid:string)=>{seen.push(uid);},
      close:()=>undefined,
    };
    t.mock.method(ImapClient,'connect',async()=>client as unknown as ImapClient);

    const runtime=new MessagingRuntimeRegistry(store.db,()=>control,{now:()=>at}).forTenant(tenantId);
    let persistedCount=0;
    let allPersisted!:()=>void;
    const allPersistedSignal=new Promise<void>(resolve=>{allPersisted=resolve;});
    const handler=createDurableInboundMailHandler({
      runtime,
      tenantId,
      adapterId:'email-imap',
      provider:'imap:example.test',
      mailbox:'INBOX',
      onPersisted:()=>{if (++persistedCount===emails.length) allPersisted();},
    });
    runtime.registerEmailReceiver(createImapReceivePort(()=>({host:'example.test',port:993,user:'buyer@example.test',pass:'test'}),handler),true);

    const protocolPoll=runtime.gateway.poll('email-imap',{trigger:'automatic'});
    await allPersistedSignal;

    let domainStarted!:()=>void;
    const domainStartedSignal=new Promise<void>(resolve=>{domainStarted=resolve;});
    let releaseDomain!:()=>void;
    const domainHold=new Promise<void>(resolve=>{releaseDomain=resolve;});
    let domainCalls=0;
    const domainRun=runtime.runPendingInbound(async()=>{
      if (++domainCalls===1) domainStarted();
      await domainHold;
      return {status:'processed',communicationId:'communication:n1'};
    });
    await domainStartedSignal;

    const protocolResult=await protocolPoll;
    assert.deepEqual(protocolResult,{status:'received',handledCount:3});
    assert.deepEqual(seen,['uid-1','uid-2','uid-3']);
    assert.equal(runtime.getAdapterState('email-imap').status,'running');
    assert.equal(runtime.getAdapterState('email-imap').consecutiveFailures,0);
    assert.deepEqual(runtime.repository.listInbound().map(item=>item.status).sort(),['dispatching','received','received']);
    assert.deepEqual(runtime.repository.listInbound().map(item=>item.attachments?.[0]?.content.toString()).sort(),['confirmation-1','confirmation-2','confirmation-3']);

    releaseDomain();
    assert.deepEqual(await domainRun,{claimed:3,processed:3,rejected:0,failed:0});
  } finally {store.close();}
});
