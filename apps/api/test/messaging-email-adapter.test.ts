import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageDeliveryRequest } from '@readywork/messaging';
import { EmailMessagingAdapter, type EmailSendPortInput } from '../src/messaging/email-adapter.js';

const at = '2026-09-08T00:00:00.000Z';

function request(): MessageDeliveryRequest {
  return {
    tenantId: 'tenant:one',
    adapterId: 'email',
    channel: 'email',
    idempotencyKey: 'outbox:one',
    sender: { displayName: '李采购' },
    recipients: [{ address: 'supplier@example.test' }],
    subject: '采购订单 P00021',
    text: '请确认订单。',
    attachments: [{
      id: 'attachment:one',
      name: '采购订单.pdf',
      contentType: 'application/pdf',
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
      content: Buffer.from('pdf'),
    }],
    thread: {
      inReplyTo: '<supplier@example.test>',
      references: ['<root@example.test>', '<supplier@example.test>'],
    },
    trace: { source: 'procurement_outbox', sourceId: 'outbox:one', correlationId: 'po:one' },
  };
}

test('Email adapter maps the channel-neutral request and preserves a real SMTP receipt', async () => {
  let captured: EmailSendPortInput | undefined;
  const adapter = new EmailMessagingAdapter('email', 'smtp:example.test', async (input) => {
    captured = input;
    return {
      ok: true,
      message: 'accepted',
      messageId: input.messageId,
      acceptedAt: at,
    };
  });

  const result = await adapter.send(request());

  assert.equal(captured?.to, 'supplier@example.test');
  assert.equal(captured?.fromName, '李采购');
  assert.equal(captured?.subject, '采购订单 P00021');
  assert.equal(captured?.body, '请确认订单。');
  assert.match(captured?.messageId ?? '', /^<readywork\.[a-f0-9]{64}@readywork\.local>$/u);
  assert.equal(captured?.inReplyTo, '<supplier@example.test>');
  assert.deepEqual(captured?.references, ['<root@example.test>', '<supplier@example.test>']);
  assert.equal(captured?.attachments?.[0]?.filename, '采购订单.pdf');
  assert.deepEqual(Buffer.from(captured?.attachments?.[0]?.content ?? []), Buffer.from('pdf'));
  assert.deepEqual(result, {
    kind: 'accepted',
    providerMessageId: captured?.messageId,
    acceptedAt: at,
  });
});

test('Email adapter distinguishes safe pre-dispatch failures from unknown post-dispatch results', async (t) => {
  await t.test('retryable before dispatch', async () => {
    const adapter = new EmailMessagingAdapter('email', 'smtp:example.test', async () => ({
      ok: false,
      message: 'SMTP 连接超时',
      dispatchStage: 'before_dispatch',
      retryable: true,
    }));
    assert.deepEqual(await adapter.send(request()), {
      kind: 'retryable_before_dispatch',
      error: 'SMTP 连接超时',
    });
  });

  await t.test('permanent before dispatch', async () => {
    const adapter = new EmailMessagingAdapter('email', 'smtp:example.test', async () => ({
      ok: false,
      message: '收件人地址无效',
      dispatchStage: 'before_dispatch',
      retryable: false,
    }));
    assert.deepEqual(await adapter.send(request()), {
      kind: 'failed_before_dispatch',
      error: '收件人地址无效',
    });
  });

  await t.test('unknown after dispatch', async () => {
    const adapter = new EmailMessagingAdapter('email', 'smtp:example.test', async () => ({
      ok: false,
      message: 'SMTP DATA 后连接中断',
      dispatchStage: 'after_dispatch',
      retryable: true,
    }));
    assert.deepEqual(await adapter.send(request()), {
      kind: 'unknown_after_dispatch',
      error: 'SMTP DATA 后连接中断',
    });
  });
});

test('Email adapter treats an accepted response without Message-ID as unknown and never invents acceptance', async () => {
  const adapter = new EmailMessagingAdapter('email', 'smtp:example.test', async () => ({
    ok: true,
    message: 'accepted without receipt',
    acceptedAt: at,
  }));
  assert.deepEqual(await adapter.send(request()), {
    kind: 'unknown_after_dispatch',
    error: 'SMTP 已返回成功但缺少 Message-ID，投递结果需要人工核对',
  });
});
