import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapClient, InboundEmail } from '../src/imap.js';
import { extractPoNumber, pollInboundMail } from '../src/mail-router.js';

test('extractPoNumber: Odoo P00011 格式', () => {
  assert.equal(extractPoNumber('P00011 交期确认', '新交期 2026-09-20'), 'P00011');
});

test('extractPoNumber: readywork PO-1001 格式', () => {
  assert.equal(extractPoNumber('PO-1001 延期跟进', ''), 'PO-1001');
});

test('extractPoNumber: po:1001 格式', () => {
  assert.equal(extractPoNumber('关于 po:1001 的回复', ''), 'po:1001');
});

test('extractPoNumber: 从正文提取', () => {
  assert.equal(extractPoNumber('回复：交期', '订单 P00029 预计 10 月 15 号交货'), 'P00029');
});

test('extractPoNumber: 无单号返回 null', () => {
  assert.equal(extractPoNumber('你好', '没有单号'), null);
});

test('pollInboundMail: 未通过业务校验的邮件保持未读且不阻塞后续邮件', async () => {
  const emails: InboundEmail[] = [
    { id: '1', from: 'unknown@example.net', subject: 'P00011 回复', body: '', receivedAt: '2026-08-28T01:00:00.000Z' },
    { id: '2', from: 'supplier@example.net', subject: 'P00012 回复', body: '', receivedAt: '2026-08-28T01:01:00.000Z' },
  ];
  const seen: string[] = [];
  const imap = {
    fetchUnseen: async () => emails,
    markSeen: async (id: string) => { seen.push(id); },
  } as unknown as ImapClient;

  const handled = await pollInboundMail(imap, async (email) => email.id === '2');

  assert.equal(handled, 1);
  assert.deepEqual(seen, ['2']);
});

test('pollInboundMail: 把有界抓取与 UID 退避选项原样传给 IMAP 客户端', async () => {
  const excludeUids = new Set(['deferred-uid']);
  let receivedOptions: unknown;
  const imap = {
    fetchUnseen: async (options: unknown) => {
      receivedOptions = options;
      return [];
    },
    markSeen: async () => undefined,
  } as unknown as ImapClient;

  const handled = await pollInboundMail(imap, async () => true, { limit: 20, excludeUids });

  assert.equal(handled, 0);
  assert.deepEqual(receivedOptions, { limit: 20, excludeUids });
});
