import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMailPayload, classifySmtpFailure } from '../src/smtp.js';

test('SMTP MIME: attachment uses multipart/mixed and RFC-compatible Chinese filename', () => {
  const content = new Uint8Array(Buffer.alloc(120, 0xab));
  const payload = buildMailPayload('sender@example.com', {
    to: 'recipient@example.com',
    subject: '附件测试',
    body: '请查收附件。',
    attachments: [{
      filename: '报价单.pdf',
      contentType: 'application/pdf',
      content,
    }],
  });

  const boundary = payload.match(/^Content-Type: multipart\/mixed; boundary="([^"]+)"$/m)?.[1];
  assert.ok(boundary);
  assert.match(payload, new RegExp(`--${boundary}\\r\\nContent-Type: text/plain`));
  assert.match(payload, new RegExp(`--${boundary}--$`));
  assert.match(payload, /Content-Type: application\/pdf; name="___\.pdf"/);
  assert.match(payload, /filename\*=UTF-8''%E6%8A%A5%E4%BB%B7%E5%8D%95\.pdf/);

  const attachmentBody = payload.match(/Content-Disposition: attachment[^\r]+\r\n\r\n([\s\S]+?)\r\n--/);
  assert.ok(attachmentBody);
  const encodedLines = attachmentBody[1]!.split('\r\n');
  assert.ok(encodedLines.every((line) => line.length <= 76));
  assert.deepEqual(Buffer.from(encodedLines.join(''), 'base64'), Buffer.from(content));
});

test('SMTP MIME: mail without attachments remains text/plain', () => {
  const payload = buildMailPayload('sender@example.com', {
    to: 'recipient@example.com',
    subject: '纯文本',
    body: '无需附件',
  });

  assert.match(payload, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.doesNotMatch(payload, /multipart\/mixed/);
  assert.doesNotMatch(payload, /Content-Disposition: attachment/);
  assert.ok(payload.endsWith(Buffer.from('无需附件').toString('base64')));
});

test('SMTP MIME: uses RFC 2047 encoded supplier-visible sender name without changing mailbox', () => {
  const payload = buildMailPayload('purchasing@example.com', {
    to: 'supplier@example.com',
    fromName: '李采购',
    subject: '采购订单',
    body: '请确认。',
  });
  assert.match(payload, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?= <purchasing@example\.com>$/m);
  assert.match(payload, new RegExp(Buffer.from('李采购').toString('base64')));
});

test('SMTP MIME: rejects CR/LF injection in supplier-visible sender name', () => {
  assert.throws(() => buildMailPayload('sender@example.com', {
    to: 'recipient@example.com',
    fromName: '李采购\r\nBcc: attacker@example.com',
    subject: '采购订单',
    body: '请确认。',
  }), /From name 邮件头无效/);
});

test('SMTP MIME: writes a verifiable Message-ID and RFC thread headers', () => {
  const payload = buildMailPayload('sender@example.com', {
    to: 'supplier@example.com',
    subject: '采购订单 P00001',
    body: '请确认。',
    date: 'Fri, 28 Aug 2026 10:00:00 +0800',
    messageId: 'readywork.po-1@example.com',
    inReplyTo: '<supplier-reply@example.net>',
    references: ['thread-root@example.com', '<supplier-reply@example.net>'],
  });

  assert.match(payload, /^Date: Fri, 28 Aug 2026 10:00:00 \+0800$/m);
  assert.match(payload, /^Message-ID: <readywork\.po-1@example\.com>$/m);
  assert.match(payload, /^In-Reply-To: <supplier-reply@example\.net>$/m);
  assert.match(payload, /^References: <thread-root@example\.com> <supplier-reply@example\.net>$/m);
});

test('SMTP failure classification never retries once DATA dispatch has started', () => {
  assert.deepEqual(classifySmtpFailure('connect ECONNREFUSED 127.0.0.1:465', false), {
    dispatchStage: 'before_dispatch',
    retryable: true,
  });
  assert.deepEqual(classifySmtpFailure('SMTP 期望 250，收到：550 mailbox unavailable', false), {
    dispatchStage: 'before_dispatch',
    retryable: false,
  });
  assert.deepEqual(classifySmtpFailure('SMTP 读超时', true), {
    dispatchStage: 'after_dispatch',
    retryable: false,
  });
});
