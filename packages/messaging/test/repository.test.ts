import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import type {
  InboundMessageEnvelope,
  MessageDeliveryRequest,
  MessagingAdapterState,
} from '@readywork/messaging';

const at = '2026-09-08T00:00:00.000Z';

function inbound(overrides: Partial<InboundMessageEnvelope> = {}): InboundMessageEnvelope {
  return {
    id: 'inbound:one',
    tenantId: 'tenant:one',
    adapterId: 'email',
    channel: 'email',
    provider: 'imap:imap.example.test',
    providerMessageId: '<one@example.test>',
    references: [],
    sender: { address: 'supplier@example.test', displayName: '供应商' },
    recipients: [{ address: 'buyer@example.test' }],
    subject: 'Re: P00021',
    text: '当前回复',
    attachments: [],
    occurredAt: at,
    receivedAt: at,
    rawFingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

function delivery(overrides: Partial<MessageDeliveryRequest> = {}): MessageDeliveryRequest {
  return {
    tenantId: 'tenant:one',
    adapterId: 'email',
    channel: 'email',
    idempotencyKey: 'send:one',
    sender: { address: 'buyer@example.test', displayName: '采购员' },
    recipients: [{ address: 'supplier@example.test' }],
    subject: 'P00021 订单确认',
    text: '请确认订单。',
    attachments: [],
    trace: { source: 'procurement_outbox', sourceId: 'outbox:one', correlationId: 'po:one' },
    ...overrides,
  };
}

test('receive persists one tenant-scoped inbound message and reports replay', async () => {
  const module = await import('@readywork/messaging');
  assert.equal(typeof module.MessagingRepository, 'function', 'MessagingRepository must be exported');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const repository = new module.MessagingRepository(store.db, 'tenant:one');
    const first = repository.receive(inbound());
    const replay = repository.receive(inbound());

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(first.message.status, 'received');
    assert.equal(repository.listInbound({ status: 'received' }).length, 1);
    assert.equal(
      (store.db.prepare('SELECT COUNT(*) AS count FROM messaging_inbound_messages WHERE tenant_id=?').get('tenant:one') as { count: number }).count,
      1,
    );
  } finally {
    store.close();
  }
});

test('receive rejects a reused provider identity with a different immutable payload', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const repository = new module.MessagingRepository(store.db, 'tenant:one');
    repository.receive(inbound());

    assert.throws(
      () => repository.receive(inbound({ text: '被替换的正文', rawFingerprint: 'b'.repeat(64) })),
      /相同提供商消息标识对应不同载荷/u,
    );
    assert.throws(
      () => repository.receive(inbound({ tenantId: 'tenant:other', id: 'inbound:other' })),
      /消息租户与仓储租户不一致/u,
    );
    assert.equal(repository.listInbound().length, 1);
  } finally {
    store.close();
  }
});

test('reserveDelivery owns a new request and replays only the identical request', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const repository = new module.MessagingRepository(store.db, 'tenant:one');
    const first = repository.reserveDelivery(delivery(), at);
    const replay = repository.reserveDelivery(delivery(), at);

    assert.equal(first.owner, true);
    assert.equal(first.replayed, false);
    assert.equal(first.delivery.status, 'pending');
    assert.equal(replay.owner, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.delivery.id, first.delivery.id);
    assert.throws(
      () => repository.reserveDelivery(delivery({ text: '不同正文' }), at),
      /投递幂等键对应不同请求/u,
    );
    assert.equal(
      (store.db.prepare('SELECT COUNT(*) AS count FROM messaging_deliveries WHERE tenant_id=?').get('tenant:one') as { count: number }).count,
      1,
    );
  } finally {
    store.close();
  }
});

test('delivery transitions require the current version and persist an accepted provider receipt', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const repository = new module.MessagingRepository(store.db, 'tenant:one');
    const reserved = repository.reserveDelivery(delivery(), at).delivery;
    const sending = repository.markDeliverySending(reserved.id, reserved.version, '2026-09-08T00:00:01.000Z');
    const accepted = repository.completeDelivery(sending.id, sending.version, {
      kind: 'accepted',
      providerMessageId: '<accepted@example.test>',
      acceptedAt: '2026-09-08T00:00:02.000Z',
    }, '2026-09-08T00:00:02.000Z');

    assert.equal(sending.status, 'sending');
    assert.equal(sending.attempts, 1);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.providerMessageId, '<accepted@example.test>');
    assert.equal(accepted.acceptedAt, '2026-09-08T00:00:02.000Z');
    assert.equal(accepted.externalDispatchStarted, true);
    assert.throws(
      () => repository.markDeliverySending(reserved.id, reserved.version, '2026-09-08T00:00:03.000Z'),
      /消息投递版本冲突/u,
    );
  } finally {
    store.close();
  }
});

test('unknown-after-dispatch is terminal until manual reconciliation and never schedules a retry', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const repository = new module.MessagingRepository(store.db, 'tenant:one');
    const reserved = repository.reserveDelivery(delivery(), at).delivery;
    const sending = repository.markDeliverySending(reserved.id, reserved.version, '2026-09-08T00:00:01.000Z');
    const unknown = repository.failDelivery(sending.id, sending.version, {
      kind: 'unknown_after_dispatch',
      error: 'SMTP DATA 后连接中断',
    }, '2026-09-08T00:00:02.000Z');

    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.externalDispatchStarted, true);
    assert.equal(unknown.nextAttemptAt, undefined);
    assert.equal(unknown.error, 'SMTP DATA 后连接中断');
  } finally {
    store.close();
  }
});

test('only a retryable failure before dispatch schedules another attempt', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const repository = new module.MessagingRepository(store.db, 'tenant:one');
    const retryReserved = repository.reserveDelivery(delivery({ idempotencyKey: 'send:retry' }), at).delivery;
    const retrySending = repository.markDeliverySending(retryReserved.id, retryReserved.version, '2026-09-08T00:00:01.000Z');
    const retry = repository.failDelivery(retrySending.id, retrySending.version, {
      kind: 'retryable_before_dispatch',
      error: 'SMTP 连接超时',
    }, '2026-09-08T00:00:02.000Z');

    const failedReserved = repository.reserveDelivery(delivery({ idempotencyKey: 'send:failed' }), at).delivery;
    const failedSending = repository.markDeliverySending(failedReserved.id, failedReserved.version, '2026-09-08T00:00:01.000Z');
    const failed = repository.failDelivery(failedSending.id, failedSending.version, {
      kind: 'failed_before_dispatch',
      error: '收件人地址无效',
    }, '2026-09-08T00:00:02.000Z');

    assert.equal(retry.status, 'retry_wait');
    assert.equal(retry.externalDispatchStarted, false);
    assert.equal(retry.nextAttemptAt, '2026-09-08T00:00:32.000Z');
    assert.equal(retry.completedAt, undefined);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.externalDispatchStarted, false);
    assert.equal(failed.nextAttemptAt, undefined);
    assert.equal(failed.completedAt, '2026-09-08T00:00:02.000Z');
  } finally {
    store.close();
  }
});

test('inbound claim uses a lease and failed work can be claimed again without duplicating the message', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const repository = new module.MessagingRepository(store.db, 'tenant:one');
    repository.receive(inbound());

    const firstClaim = repository.claimInbound(10, 'worker:one', 60_000, at);
    assert.equal(firstClaim.length, 1);
    assert.equal(firstClaim[0]?.status, 'dispatching');
    assert.equal(firstClaim[0]?.attempts, 1);
    assert.equal(firstClaim[0]?.leaseOwner, 'worker:one');
    assert.equal(firstClaim[0]?.leaseExpiresAt, '2026-09-08T00:01:00.000Z');
    assert.equal(repository.claimInbound(10, 'worker:two', 60_000, '2026-09-08T00:00:30.000Z').length, 0);

    const failed = repository.failInbound('inbound:one', '2026-09-08T00:00:31.000Z', '采购桥接暂时不可用',firstClaim[0]!);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.leaseOwner, undefined);

    const replayClaim = repository.claimInbound(10, 'worker:two', 60_000, '2026-09-08T00:00:32.000Z');
    assert.equal(replayClaim.length, 1);
    assert.equal(replayClaim[0]?.attempts, 2);
    const completed = repository.completeInbound('inbound:one', 'processed', '2026-09-08T00:00:33.000Z', 'communication_created',replayClaim[0]!);
    assert.equal(completed.status, 'processed');
    assert.equal(completed.outcomeCode, 'communication_created');
    assert.equal(completed.processedAt, '2026-09-08T00:00:33.000Z');
    assert.equal(repository.claimInbound(10, 'worker:three', 60_000, '2026-09-08T00:02:00.000Z').length, 0);
    assert.equal(repository.listInbound().length, 1);
  } finally {
    store.close();
  }
});

test('adapter state uses optimistic versions and gateway events never persist message content', async () => {
  const module = await import('@readywork/messaging');
  const store = openPersistence(':memory:', { tenantId: 'tenant:one' });
  try {
    const repository = new module.MessagingRepository(store.db, 'tenant:one');
    const initial: MessagingAdapterState = {
      tenantId: 'tenant:one',
      adapterId: 'email',
      channel: 'email',
      provider: 'smtp:example.test',
      status: 'running',
      capabilities: ['send_text', 'send_attachments', 'threads'],
      consecutiveFailures: 0,
      version: 1,
      createdAt: at,
      updatedAt: at,
    };
    const saved = repository.saveAdapterState(initial);
    const degraded = repository.saveAdapterState({
      ...saved,
      status: 'degraded',
      consecutiveFailures: 1,
      lastError: 'SMTP 暂时不可用',
      updatedAt: '2026-09-08T00:00:01.000Z',
    }, saved.version);

    assert.equal(repository.getAdapterState('email')?.status, 'degraded');
    assert.equal(degraded.version, 2);
    assert.throws(() => repository.saveAdapterState({ ...degraded, status: 'running' }, 1), /消息适配器版本冲突/u);

    repository.appendEvent({
      id: 'event:one',
      tenantId: 'tenant:one',
      adapterId: 'email',
      eventType: 'delivery_failed',
      status: 'degraded',
      metadata: {
        deliveryId: 'delivery:one',
        messageBody: '不得写入的正文',
        attachmentContent: '不得写入的附件',
      },
      createdAt: '2026-09-08T00:00:02.000Z',
    });
    const row = store.db.prepare('SELECT metadata_json FROM messaging_gateway_events WHERE tenant_id=? AND id=?')
      .get('tenant:one', 'event:one') as { metadata_json: string };
    assert.deepEqual(JSON.parse(row.metadata_json), { deliveryId: 'delivery:one' });
  } finally {
    store.close();
  }
});
