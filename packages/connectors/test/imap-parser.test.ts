import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImapClient, MimeMessageLimitError, parseRawMessage } from '../src/imap.js';

test('IMAP 有界抓取只读取最新 N 个 UID，并优先处理最新邮件', async () => {
  const fetched: string[] = [];
  const imap = Object.create(ImapClient.prototype) as ImapClient & {
    fetchUnseenUids: () => Promise<string[]>;
    fetchEmail: (uid: string) => Promise<ReturnType<typeof stubEmail>>;
  };
  imap.fetchUnseenUids = async () => ['101', '102', '103', '104', '105'];
  imap.fetchEmail = async (uid) => {
    fetched.push(uid);
    return stubEmail(uid);
  };

  const emails = await imap.fetchUnseen({ limit: 3 });

  assert.deepEqual(fetched, ['105', '104', '103']);
  assert.deepEqual(emails.map((email) => email.id), ['105', '104', '103']);
});

test('IMAP 有界抓取在选择最新 N 个前排除处于退避期的 UID', async () => {
  const fetched: string[] = [];
  const imap = Object.create(ImapClient.prototype) as ImapClient & {
    fetchUnseenUids: () => Promise<string[]>;
    fetchEmail: (uid: string) => Promise<ReturnType<typeof stubEmail>>;
  };
  imap.fetchUnseenUids = async () => ['201', '202', '203', '204', '205'];
  imap.fetchEmail = async (uid) => {
    fetched.push(uid);
    return stubEmail(uid);
  };

  const emails = await imap.fetchUnseen({ limit: 2, excludeUids: new Set(['205', '203']) });

  assert.deepEqual(fetched, ['204', '202']);
  assert.deepEqual(emails.map((email) => email.id), ['204', '202']);
});

test('IMAP 人工复核在有界窗口内优先抓取历史拒绝 UID', async () => {
  const fetched: string[] = [];
  const imap = Object.create(ImapClient.prototype) as ImapClient & {
    fetchUnseenUids: () => Promise<string[]>;
    fetchEmail: (uid: string) => Promise<ReturnType<typeof stubEmail>>;
  };
  imap.fetchUnseenUids = async () => ['301', '302', '303', '304', '305'];
  imap.fetchEmail = async (uid) => {
    fetched.push(uid);
    return stubEmail(uid);
  };

  const emails = await imap.fetchUnseen({ limit: 3, priorityUids: new Set(['302', '304']) });

  assert.deepEqual(fetched, ['304', '302', '305']);
  assert.deepEqual(emails.map((email) => email.id), ['304', '302', '305']);
});

test('IMAP 解析 QQ Mail 的折行主题与 multipart Base64 纯文本回复', () => {
  const text = '数量 200 件，单价 51.50 元/件，MOQ 100 件，交期 2027-04-22。';
  const raw = [
    'From: "Tanghe" <supplier@supplysentry.invalid>',
    'Subject: =?UTF-8?B?UmU6IOivouS7tyBSRlEtRTJFLTIwMjYwODIxLVFR?=',
    ' =?UTF-8?B?LTAwMQ==?=',
    'Date: Fri, 21 Aug 2026 18:01:04 +0800',
    'Message-ID: <reply-20260821@qq.com>',
    'In-Reply-To: <readywork.po-1@163.com>',
    'References: <thread-root@163.com> <readywork.po-1@163.com>',
    'Content-Type: multipart/alternative;',
    ' boundary="----readywork-boundary"',
    '',
    '------readywork-boundary',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text).toString('base64'),
    '------readywork-boundary',
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(`<div>${text}</div>`).toString('base64'),
    '------readywork-boundary--',
    '',
  ].join('\r\n');
  const parsed = parseRawMessage(raw);
  assert.equal(parsed.from, '"Tanghe" <supplier@supplysentry.invalid>');
  assert.equal(parsed.subject, 'Re: 询价 RFQ-E2E-20260821-QQ-001');
  assert.equal(parsed.body, text);
  assert.equal(parsed.messageId, '<reply-20260821@qq.com>');
  assert.equal(parsed.inReplyTo, '<readywork.po-1@163.com>');
  assert.deepEqual(parsed.references, ['<thread-root@163.com>', '<readywork.po-1@163.com>']);
});

test('IMAP quoted-printable 按字节还原 UTF-8', () => {
  const parsed = parseRawMessage([
    'From: supplier@example.com',
    'Subject: Quote',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '=E6=8A=A5=E4=BB=B7=EF=BC=9A51.50',
  ].join('\r\n'));
  assert.equal(parsed.body, '报价：51.50');
});

test('IMAP 安全解析 multipart 邮件附件并清理路径文件名', () => {
  const pdf = Buffer.from('%PDF-1.7\nPO-2026-0828\n%%EOF');
  const parsed = parseRawMessage([
    'From: buyer@example.com',
    'Subject: Approved PO',
    'Message-ID: <po-intake@example.com>',
    'Content-Type: multipart/mixed; boundary="rw-mixed"',
    '',
    '--rw-mixed',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Please review the attached PO.',
    '--rw-mixed',
    'Content-Type: application/pdf; name="../../approved-po.pdf"',
    'Content-Disposition: attachment; filename="../../approved-po.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    pdf.toString('base64'),
    '--rw-mixed--',
    '',
  ].join('\r\n'));
  assert.equal(parsed.body, 'Please review the attached PO.');
  assert.equal(parsed.attachments?.length, 1);
  assert.equal(parsed.attachments?.[0]?.filename, 'approved-po.pdf');
  assert.equal(parsed.attachments?.[0]?.contentType, 'application/pdf');
  assert.deepEqual(Buffer.from(parsed.attachments?.[0]?.content ?? []), pdf);
});

test('IMAP 拒绝超过数量限制的附件', () => {
  const parts: string[] = [];
  for (let index = 0; index < 13; index += 1) parts.push('--many', 'Content-Type: text/plain', `Content-Disposition: attachment; filename="${index}.txt"`, '', `item-${index}`);
  assert.throws(() => parseRawMessage(['From: x@example.com', 'Subject: too many', 'Content-Type: multipart/mixed; boundary="many"', '', ...parts, '--many--', ''].join('\r\n')), MimeMessageLimitError);
});

function stubEmail(id: string) {
  return {
    id,
    from: 'supplier@example.com',
    subject: `PO ${id}`,
    body: '',
    receivedAt: '2026-08-28T00:00:00.000Z',
  };
}
