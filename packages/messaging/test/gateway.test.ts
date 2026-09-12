import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import type {
  AdapterSendResult,
  InboundMessageEnvelope,
  MessageDeliveryRequest,
  MessagingAdapter,
} from '@readywork/messaging';

const at = '2026-09-08T00:00:00.000Z';

function request(overrides: Partial<MessageDeliveryRequest> = {}): MessageDeliveryRequest {
  return {
    tenantId: 'tenant:one',
    adapterId: 'email',
    channel: 'email',
    idempotencyKey: 'delivery:one',
    recipients: [{ address: 'supplier@example.test' }],
    subject: 'P00021 订单确认',
    text: '请确认订单。',
    attachments: [],
    trace: { source: 'procurement_outbox', sourceId: 'outbox:one', correlationId: 'po:one' },
    ...overrides,
  };
}

function inbound(): InboundMessageEnvelope {
  return {
    id: 'inbound:one',
    tenantId: 'tenant:one',
    adapterId: 'email',
    channel: 'email',
    provider: 'imap:example.test',
    providerMessageId: '<reply@example.test>',
    references: [],
    sender: { address: 'supplier@example.test' },
    recipients: [{ address: 'buyer@example.test' }],
    subject: 'Re: P00021',
    text: '当前回复',
    attachments: [],
    occurredAt: at,
    receivedAt: at,
    rawFingerprint: 'a'.repeat(64),
  };
}

function adapter(input: {
  id?: string;
  channel?: 'email' | 'teams';
  capabilities?: MessagingAdapter['capabilities'];
  send: (request: MessageDeliveryRequest) => Promise<AdapterSendResult>;
}): MessagingAdapter {
  return {
    id: input.id ?? 'email',
    channel: input.channel ?? 'email',
    provider: `test:${input.id ?? 'email'}`,
    capabilities: input.capabilities ?? ['send_text', 'send_attachments', 'threads'],
    health: async () => ({ ok: true }),
    send: input.send,
  };
}

test('accepted delivery is replayed without invoking the adapter twice', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    let calls = 0;
    const gateway = new module.MessageGateway(new module.MessagingRepository(store.db, 'tenant:one'), {
      now: () => at,
    });
    gateway.register(adapter({ send: async () => {
      calls += 1;
      return { kind: 'accepted', providerMessageId: '<accepted@example.test>', acceptedAt: at };
    } }));

    const first = await gateway.deliver(request());
    const replay = await gateway.deliver(request());

    assert.equal(first.status, 'accepted');
    assert.equal(first.providerMessageId, '<accepted@example.test>');
    assert.equal(first.replayed, false);
    assert.equal(replay.status, 'accepted');
    assert.equal(replay.replayed, true);
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('an unknown result after dispatch is terminal and replay never sends again', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    let calls = 0;
    const gateway = new module.MessageGateway(new module.MessagingRepository(store.db, 'tenant:one'), { now: () => at });
    gateway.register(adapter({ send: async () => {
      calls += 1;
      return { kind: 'unknown_after_dispatch', error: 'SMTP DATA 后连接中断' };
    } }));

    const first = await gateway.deliver(request());
    const replay = await gateway.deliver(request());

    assert.equal(first.status, 'unknown');
    assert.equal(replay.status, 'unknown');
    assert.equal(replay.replayed, true);
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('missing adapter capability is rejected before external I/O', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    let calls = 0;
    const gateway = new module.MessageGateway(new module.MessagingRepository(store.db, 'tenant:one'), { now: () => at });
    gateway.register(adapter({
      capabilities: ['send_text'],
      send: async () => {
        calls += 1;
        return { kind: 'accepted', providerMessageId: '<must-not-send@example.test>', acceptedAt: at };
      },
    }));

    const result = await gateway.deliver(request({
      attachments: [{
        id: 'attachment:one',
        name: 'P00021.pdf',
        contentType: 'application/pdf',
        sizeBytes: 3,
        sha256: 'b'.repeat(64),
        content: Buffer.from('pdf'),
      }],
    }));

    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /send_attachments/u);
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

test('three retryable failures trip only that adapter circuit breaker', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    let emailCalls = 0;
    let teamsCalls = 0;
    const gateway = new module.MessageGateway(new module.MessagingRepository(store.db, 'tenant:one'), { now: () => at });
    gateway.register(adapter({ send: async () => {
      emailCalls += 1;
      return { kind: 'retryable_before_dispatch', error: 'SMTP 暂时不可用' };
    } }));
    gateway.register(adapter({ id: 'teams', channel: 'teams', send: async () => {
      teamsCalls += 1;
      return { kind: 'accepted', providerMessageId: 'teams:one', acceptedAt: at };
    } }));

    for (const suffix of ['one', 'two', 'three']) {
      const result = await gateway.deliver(request({ idempotencyKey: `email:${suffix}` }));
      assert.equal(result.status, 'deferred');
    }
    assert.equal(gateway.getAdapterState('email').status, 'paused_by_breaker');
    assert.equal((await gateway.deliver(request({idempotencyKey:'email:four'}))).status,'blocked');

    const teamsResult = await gateway.deliver(request({
      adapterId: 'teams',
      channel: 'teams',
      idempotencyKey: 'teams:one',
    }));
    assert.equal(teamsResult.status, 'accepted');
    assert.equal(emailCalls, 3);
    assert.equal(teamsCalls, 1);
  } finally {
    store.close();
  }
});

test('success clears failures and administrator resume requires the current version', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    let shouldFail = true;
    const gateway = new module.MessageGateway(new module.MessagingRepository(store.db, 'tenant:one'), { now: () => at });
    gateway.register(adapter({ send: async () => shouldFail
      ? { kind: 'retryable_before_dispatch', error: 'SMTP 暂时不可用' }
      : { kind: 'accepted', providerMessageId: '<accepted@example.test>', acceptedAt: at } }));

    await gateway.deliver(request({ idempotencyKey: 'failure:one' }));
    assert.equal(gateway.getAdapterState('email').consecutiveFailures, 1);
    shouldFail = false;
    await gateway.deliver(request({ idempotencyKey: 'success:one' }));
    assert.equal(gateway.getAdapterState('email').consecutiveFailures, 0);

    const paused = gateway.pauseAdapter('email', gateway.getAdapterState('email').version, 'admin:one', '供应商维护');
    assert.equal(paused.status, 'paused');
    assert.throws(
      () => gateway.resumeAdapter('email', paused.version - 1, 'admin:one', '错误版本'),
      /消息适配器版本冲突/u,
    );
    const resumed = gateway.resumeAdapter('email', paused.version, 'admin:one', '维护完成');
    assert.equal(resumed.status, 'degraded');
    assert.equal(resumed.consecutiveFailures, 0);
    const events = store.db.prepare(`SELECT event_type FROM messaging_gateway_events
      WHERE tenant_id=? AND adapter_id=? ORDER BY seq`).all('tenant:one', 'email') as Array<{ event_type: string }>;
    assert.equal(events.some((event) => event.event_type === 'adapter_resumed'), true);
  } finally {
    store.close();
  }
});

test('an older successful health observation cannot overwrite a newer delivery failure', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    let releaseHealth!: (result: { ok: boolean; message?: string }) => void;
    const gateway = new module.MessageGateway(new module.MessagingRepository(store.db, 'tenant:one'), {
      now: () => at,
    });
    gateway.register({
      ...adapter({ send: async () => ({ kind: 'retryable_before_dispatch', error: 'new delivery failure' }) }),
      health: () => new Promise((resolve) => { releaseHealth = resolve; }),
    });

    const pendingHealth = gateway.health();
    const delivery = await gateway.deliver(request({ idempotencyKey: 'health-race:failure' }));
    assert.equal(delivery.status, 'deferred');
    releaseHealth({ ok: true });
    await pendingHealth;

    const state = gateway.getAdapterState('email');
    assert.equal(state.status, 'degraded');
    assert.equal(state.consecutiveFailures, 1);
    assert.equal(state.lastError, 'new delivery failure');
  } finally {
    store.close();
  }
});

test('an older failed health observation cannot overwrite a newer delivery success', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    let releaseHealth!: (result: { ok: boolean; message?: string }) => void;
    const gateway = new module.MessageGateway(new module.MessagingRepository(store.db, 'tenant:one'), {
      now: () => at,
    });
    gateway.register({
      ...adapter({ send: async () => ({ kind: 'accepted', providerMessageId: '<new-success@example.test>', acceptedAt: at }) }),
      health: () => new Promise((resolve) => { releaseHealth = resolve; }),
    });

    const pendingHealth = gateway.health();
    const delivery = await gateway.deliver(request({ idempotencyKey: 'health-race:success' }));
    assert.equal(delivery.status, 'accepted');
    releaseHealth({ ok: false, message: 'old health failure' });
    await pendingHealth;

    const state = gateway.getAdapterState('email');
    assert.equal(state.status, 'running');
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.lastError, undefined);
  } finally {
    store.close();
  }
});

test('ingest persists a channel-neutral envelope without invoking procurement code', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const repository = new module.MessagingRepository(store.db, 'tenant:one');
    const gateway = new module.MessageGateway(repository, { now: () => at });

    const first = await gateway.ingest(inbound());
    const replay = await gateway.ingest(inbound());

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(first.inboundId, 'inbound:one');
    assert.equal(repository.listInbound().length, 1);
  } finally {
    store.close();
  }
});
