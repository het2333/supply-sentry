import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import type { MessageDeliveryRequest } from '@readywork/messaging';
import { MessagingRuntimeRegistry } from '../src/messaging/runtime.js';
import { normalizeInboundEmailEnvelope } from '../src/messaging/procurement-bridge.js';
import { procurementV1ReadinessForOperations } from '../src/manufacturing-context-readiness.js';

const tenantId = 'tenant:runtime-cutover';
const at = '2026-09-08T00:00:00.000Z';
const control = {
  listCredentials: () => [{ id: 'email:test', connectorId: 'email', status: 'connected' }],
  getCredential: () => ({ smtpHost: 'smtp.example.test', username: 'buyer@example.test', password: 'test-only' }),
};
const request: MessageDeliveryRequest = {
  tenantId, adapterId: 'email', channel: 'email', idempotencyKey: 'outbox:cutover',
  recipients: [{ address: 'supplier@example.test' }], subject: 'P00021', text: 'Confirm order', attachments: [],
  trace: { source: 'procurement_outbox', sourceId: 'outbox:cutover', correlationId: 'po:21' },
};

// Catches loss of persisted acceptance when a new registry opens the same file.
test('file SQLite runtime restart replays accepted delivery without another SMTP dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-messaging-cutover-'));
  const path = join(directory, 'runtime.sqlite');
  let store = openPersistence(path, { tenantId });
  let sends = 0;
  const options = { now: () => at, sendMail: async () => {
    sends += 1;
    return { ok: true, message: 'accepted', messageId: '<cutover@example.test>', acceptedAt: at };
  } };
  try {
    const first = await new MessagingRuntimeRegistry(store.db, () => control, options).forTenant(tenantId).deliver(request);
    assert.equal(first.status, 'accepted');
    store.close();
    store = openPersistence(path, { tenantId });
    const second = await new MessagingRuntimeRegistry(store.db, () => control, options).forTenant(tenantId).deliver(request);
    assert.equal(second.status, 'accepted');
    assert.equal(second.deliveryId, first.deliveryId);
    assert.equal(second.providerMessageId, '<cutover@example.test>');
    assert.equal(second.attempt, 1);
    assert.equal(second.replayed, true);
    assert.equal(sends, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

// Catches treating a crashed worker's lease as permanent or processing it early.
test('file SQLite restart recovers inbound only after its prior lease expires', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-messaging-lease-'));
  const path = join(directory, 'runtime.sqlite');
  let store = openPersistence(path, { tenantId });
  let now = at;
  const envelope = normalizeInboundEmailEnvelope({ tenantId, adapterId: 'email', provider: 'imap:test', mailbox: 'INBOX',
    email: { id: 'uid:21', from: 'supplier@example.test', subject: 'P00021', body: 'Confirmed', receivedAt: at, messageId: '<inbound@example.test>' },
  });
  try {
    const old = new MessagingRuntimeRegistry(store.db, () => control, { now: () => now }).forTenant(tenantId);
    await old.ingest(envelope);
    assert.ok(old.repository.claimInboundById(envelope.id, 'old-process', 60_000, at));
    store.close();
    store = openPersistence(path, { tenantId });
    const restarted = new MessagingRuntimeRegistry(store.db, () => control, { now: () => now }).forTenant(tenantId);
    const handler = async () => ({ status: 'processed' as const, communicationId: 'communication:21' });
    assert.deepEqual(await restarted.runPendingInbound(handler), { claimed: 0, processed: 0, rejected: 0, failed: 0 });
    now = '2026-09-08T00:01:01.000Z';
    assert.deepEqual(await restarted.runPendingInbound(handler), { claimed: 1, processed: 1, rejected: 0, failed: 0 });
    assert.equal(restarted.repository.listInbound()[0]?.status, 'processed');
    assert.deepEqual(await restarted.runPendingInbound(handler), { claimed: 0, processed: 0, rejected: 0, failed: 0 });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

// Catches adapter failures incorrectly changing the eleven business release gates.
test('persisted email breaker survives restart and leaves business readiness and inbound processing independent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-messaging-breaker-'));
  const path = join(directory, 'runtime.sqlite');
  let store = openPersistence(path, { tenantId });
  const operations = { queue: { workerReady: true, pollerCount: 1 } };
  try {
    const baseline = procurementV1ReadinessForOperations(store.db, tenantId, operations, new Date(at));
    const runtime = new MessagingRuntimeRegistry(store.db, () => control, { now: () => at,
      sendMail: async () => ({ ok: false, message: 'transient connection refused', retryable: true, dispatchStage: 'before_dispatch' as const }),
    }).forTenant(tenantId);
    for (let i = 0; i < 3; i += 1) await runtime.deliver({ ...request, idempotencyKey: `outbox:failed:${i}` });
    assert.equal(runtime.getAdapterState('email').status, 'paused_by_breaker');
    store.close();
    store = openPersistence(path, { tenantId });
    const restarted = new MessagingRuntimeRegistry(store.db, () => control, { now: () => at }).forTenant(tenantId);
    assert.equal(restarted.getAdapterState('email').status, 'paused_by_breaker');
    assert.equal((await restarted.deliver({ ...request, idempotencyKey: 'outbox:blocked' })).status,'blocked');
    const readiness = procurementV1ReadinessForOperations(store.db, tenantId, operations, new Date(at));
    assert.equal(readiness.totalGates, 11);
    assert.deepEqual(readiness, baseline);
    assert.equal(readiness.gates.find(gate => gate.id === 'durable_runtime')?.status, 'ready');
    assert.equal(readiness.gates.find(gate => gate.id === 'five_stage_closed_loop')?.status, 'blocked');
    const envelope = normalizeInboundEmailEnvelope({ tenantId, adapterId: 'email', provider: 'imap:test', mailbox: 'INBOX',
      email: { id: 'uid:breaker', from: 'supplier@example.test', subject: 'P00021', body: 'Confirmed', receivedAt: at, messageId: '<breaker@example.test>' },
    });
    assert.equal((await restarted.processInbound(envelope, async () => ({ status: 'processed', communicationId: 'communication:breaker' }))).status, 'processed');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
