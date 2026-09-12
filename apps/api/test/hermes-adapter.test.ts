import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { MessageDeliveryRequest } from '@readywork/messaging';
import { HermesMessagingAdapter } from '../src/messaging/hermes-adapter.js';

const secret = 'bridge-secret-with-at-least-thirty-two-bytes';
const request: MessageDeliveryRequest = {
  tenantId: 'tenant:a',
  adapterId: 'hermes:telegram',
  channel: 'telegram',
  idempotencyKey: 'purchase-order:P00088:approved:v1',
  recipients: [{ address: 'chat-001' }],
  text: '已审批，请确认交期。',
  attachments: [{
    id: 'attachment-1',
    name: 'P00088.pdf',
    contentType: 'application/pdf',
    sizeBytes: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    content: Buffer.from('abc'),
  }],
  thread: { inReplyTo: 'provider-001', references: ['provider-000'] },
  trace: { source: 'purchase_order', sourceId: 'po:P00088', correlationId: 'corr-001' },
};

test('Hermes adapter signs the exact body and returns the provider receipt', async () => {
  let observed: { url: string; body: string; headers: Headers } | undefined;
  const options = {
    baseUrl: 'http://127.0.0.1:8788',
    secret,
    profile: 'rw-0123456789abcdef01234567',
    now: () => '2026-09-09T10:00:00.000Z',
    nonce: () => 'nonce-outbound-001',
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      const headers = new Headers(init?.headers);
      observed = { url: String(input), body, headers };
      return new Response(JSON.stringify({
        kind: 'accepted',
        providerMessageId: 'provider-777',
        acceptedAt: '2026-09-09T10:00:01.000Z',
        continuationMessageIds: ['provider-775', 'provider-776'],
      }), { headers: { 'content-type': 'application/json' } });
    },
  };
  const adapter = new HermesMessagingAdapter('telegram', options);

  const result = await adapter.send(request);
  assert.deepEqual(result, {
    kind: 'accepted',
    providerMessageId: 'provider-777',
    acceptedAt: '2026-09-09T10:00:01.000Z',
  });
  assert.equal(observed?.url, 'http://127.0.0.1:8788/readywork/v1/deliveries');
  const payload = JSON.parse(observed!.body);
  assert.equal(payload.profile, 'rw-0123456789abcdef01234567');
  assert.equal(payload.platform, 'telegram');
  assert.equal(payload.target, 'chat-001');
  assert.equal(payload.attachments[0].contentBase64, 'YWJj');
  const timestamp = String(Date.parse('2026-09-09T10:00:00.000Z'));
  const expected = createHmac('sha256', secret).update([
    'POST',
    '/readywork/v1/deliveries',
    timestamp,
    'nonce-outbound-001',
    observed!.body,
  ].join('\n')).digest('hex');
  assert.equal(observed!.headers.get('X-Readywork-Signature'), expected);
});

test('Hermes adapter distinguishes connection refusal, ambiguous interruption and bridge failures', async () => {
  const refused = new HermesMessagingAdapter('telegram', {
    baseUrl: 'http://127.0.0.1:8788',
    secret,
    profile: 'rw-0123456789abcdef01234567',
    fetch: async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
  });
  assert.deepEqual(await refused.send({ ...request, attachments: [] }), {
    kind: 'retryable_before_dispatch',
    error: 'Hermes Bridge 当前不可达',
  });

  const interrupted = new HermesMessagingAdapter('telegram', {
    baseUrl: 'http://127.0.0.1:8788',
    secret,
    profile: 'rw-0123456789abcdef01234567',
    fetch: async () => { throw new TypeError('connection terminated'); },
  });
  assert.deepEqual(await interrupted.send({ ...request, attachments: [] }), {
    kind: 'unknown_after_dispatch',
    error: 'Hermes Bridge 响应中断，外部投递结果未知',
  });

  const failed = new HermesMessagingAdapter('telegram', {
    baseUrl: 'http://127.0.0.1:8788',
    secret,
    profile: 'rw-0123456789abcdef01234567',
    fetch: async () => new Response(JSON.stringify({
      kind: 'failed_before_dispatch',
      error: 'Hermes 目标渠道未连接',
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.deepEqual(await failed.send({ ...request, attachments: [] }), {
    kind: 'failed_before_dispatch',
    error: 'Hermes 目标渠道未连接',
  });
});

test('Hermes adapter refuses mismatched channels and multiple targets before I/O', async () => {
  let calls = 0;
  const adapter = new HermesMessagingAdapter('telegram', {
    baseUrl: 'http://127.0.0.1:8788',
    secret,
    profile: 'rw-0123456789abcdef01234567',
    fetch: async () => {
      calls += 1;
      return new Response('{}');
    },
  });
  assert.equal((await adapter.send({ ...request, channel: 'slack' })).kind, 'failed_before_dispatch');
  assert.equal((await adapter.send({ ...request, recipients: [{ address: 'a' }, { address: 'b' }] })).kind, 'failed_before_dispatch');
  assert.equal(calls, 0);
});
