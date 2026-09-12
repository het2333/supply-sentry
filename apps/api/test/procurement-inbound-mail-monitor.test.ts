import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import {
  deferredInboundMailUids,
  inboundMailAutomaticPollIntervalMs,
  inboundMailMonitorView,
  isAutomaticInboundMailPollDue,
  recordInboundMailRejection,
  recordInboundMailRuntimeState,
  rejectedInboundMailUids,
  repairLegacyInboundMailRejectionBackoff,
  resolveInboundMailRejection,
  runAutomaticInboundMailPollIfDue,
  runInboundMailPoll,
} from '../src/procurement-inbound-mail-monitor.js';

test('IMAP 监控：真实轮询结果和运行历史会持久化', async () => {
  const store = openPersistence(':memory:');
  recordInboundMailRuntimeState(store.db, 'tenant:mail', {
    configured: true,
    connected: true,
    provider: 'imap:imap.example.net',
    mailbox: 'INBOX',
  }, new Date('2026-08-28T01:00:00.000Z'));

  const result = await runInboundMailPoll({
    db: store.db,
    tenantId: 'tenant:mail',
    trigger: 'manual',
    actorId: 'human:buyer',
    provider: 'imap:imap.example.net',
    mailbox: 'INBOX',
    poll: async () => 2,
    now: sequence('2026-08-28T01:01:00.000Z', '2026-08-28T01:01:03.000Z'),
  });

  assert.equal(result.handledCount, 2);
  const view = inboundMailMonitorView(store.db, 'tenant:mail');
  assert.equal(view.configured, true);
  assert.equal(view.connected, true);
  assert.equal(view.lastStatus, 'completed');
  assert.equal(view.lastHandledCount, 2);
  assert.equal(view.runs.length, 1);
  assert.equal(view.runs[0]?.trigger, 'manual');
  assert.equal(view.runs[0]?.actorId, 'human:buyer');
  store.close();
});

test('IMAP 监控：失败会持久化并脱敏，不产生假成功', async () => {
  const store = openPersistence(':memory:');
  await assert.rejects(() => runInboundMailPoll({
    db: store.db,
    tenantId: 'tenant:mail-failure',
    trigger: 'automatic',
    actorId: 'system:imap-poller',
    provider: 'imap:imap.example.net',
    mailbox: 'INBOX',
    poll: async () => { throw new Error('password=do-not-leak connection reset'); },
    now: sequence('2026-08-28T02:00:00.000Z', '2026-08-28T02:00:02.000Z'),
  }));

  const view = inboundMailMonitorView(store.db, 'tenant:mail-failure');
  assert.equal(view.connected, false);
  assert.equal(view.lastStatus, 'failed');
  assert.equal(view.lastHandledCount, null);
  assert.equal(view.runs[0]?.status, 'failed');
  assert.equal(view.consecutiveFailures, 1);
  assert.equal(view.nextAutomaticPollAt, '2026-08-28T02:01:02.000Z');
  assert.equal(isAutomaticInboundMailPollDue(store.db, 'tenant:mail-failure', new Date('2026-08-28T02:01:01.999Z')), false);
  assert.equal(isAutomaticInboundMailPollDue(store.db, 'tenant:mail-failure', new Date('2026-08-28T02:01:02.000Z')), true);
  assert.ok(view.lastError);
  assert.equal(view.lastError?.includes('do-not-leak'), false);
  assert.equal(view.runs[0]?.error?.includes('do-not-leak'), false);
  store.close();
});

test('IMAP 监控：卡住的网络轮询会超时、关闭连接并进入持久退避', async () => {
  const store = openPersistence(':memory:');
  let closed = 0;
  await assert.rejects(() => runInboundMailPoll({
    db: store.db,
    tenantId: 'tenant:mail-timeout',
    trigger: 'automatic',
    actorId: 'system:imap-poller',
    provider: 'imap:imap.example.net',
    mailbox: 'INBOX',
    poll: () => new Promise<number>(() => undefined),
    timeoutMs: 1_000,
    onTimeout: () => { closed += 1; },
  }), /IMAP 轮询超过 1000ms/);

  const view = inboundMailMonitorView(store.db, 'tenant:mail-timeout');
  assert.equal(closed, 1);
  assert.equal(view.lastStatus, 'failed');
  assert.equal(view.connected, false);
  assert.equal(view.runs[0]?.status, 'failed');
  assert.equal(view.consecutiveFailures, 1);
  assert.ok(view.nextAutomaticPollAt);
  store.close();
});

test('IMAP 监控：网易 FETCH 限流进入持久退避，连接状态不被误判为断开', async () => {
  const store = openPersistence(':memory:');
  await assert.rejects(() => runInboundMailPoll({
    db: store.db,
    tenantId: 'tenant:mail-throttled',
    trigger: 'automatic',
    actorId: 'system:imap-poller',
    provider: 'imap:imap.163.com',
    mailbox: 'INBOX',
    poll: async () => { throw new Error('IMAP FETCH 失败: NO FETCH Fetch volume limit exceed'); },
    now: sequence('2026-08-28T02:30:00.000Z', '2026-08-28T02:30:02.000Z'),
  }));

  const firstView = inboundMailMonitorView(store.db, 'tenant:mail-throttled');
  assert.equal(firstView.connected, true);
  assert.equal(firstView.lastStatus, 'throttled');
  assert.equal(firstView.consecutiveFailures, 1);
  assert.equal(firstView.nextAutomaticPollAt, '2026-08-28T02:45:02.000Z');
  assert.equal(isAutomaticInboundMailPollDue(store.db, 'tenant:mail-throttled', new Date('2026-08-28T02:45:01.999Z')), false);

  await assert.rejects(() => runInboundMailPoll({
    db: store.db,
    tenantId: 'tenant:mail-throttled',
    trigger: 'manual',
    actorId: 'human:buyer',
    provider: 'imap:imap.163.com',
    mailbox: 'INBOX',
    poll: async () => { throw new Error('rate limited by provider'); },
    now: sequence('2026-08-28T02:31:00.000Z', '2026-08-28T02:31:02.000Z'),
  }));

  const secondView = inboundMailMonitorView(store.db, 'tenant:mail-throttled');
  assert.equal(secondView.consecutiveFailures, 2);
  assert.equal(secondView.nextAutomaticPollAt, '2026-08-28T03:01:02.000Z');
  store.close();
});

test('IMAP 监控：人工成功重试可绕过自动退避并清零失败状态', async () => {
  const store = openPersistence(':memory:');
  await assert.rejects(() => runInboundMailPoll({
    db: store.db,
    tenantId: 'tenant:mail-recovered',
    trigger: 'automatic',
    actorId: 'system:imap-poller',
    provider: 'imap:imap.163.com',
    mailbox: 'INBOX',
    poll: async () => { throw new Error('Fetch volume limit exceed'); },
    now: sequence('2026-08-28T04:00:00.000Z', '2026-08-28T04:00:02.000Z'),
  }));
  assert.equal(isAutomaticInboundMailPollDue(store.db, 'tenant:mail-recovered', new Date('2026-08-28T04:01:00.000Z')), false);

  const recovered = await runInboundMailPoll({
    db: store.db,
    tenantId: 'tenant:mail-recovered',
    trigger: 'manual',
    actorId: 'human:buyer',
    provider: 'imap:imap.163.com',
    mailbox: 'INBOX',
    poll: async () => 1,
    now: sequence('2026-08-28T04:01:00.000Z', '2026-08-28T04:01:01.000Z'),
  });

  assert.equal(recovered.handledCount, 1);
  const view = inboundMailMonitorView(store.db, 'tenant:mail-recovered');
  assert.equal(view.connected, true);
  assert.equal(view.lastStatus, 'completed');
  assert.equal(view.lastHandledCount, 1);
  assert.equal(view.lastError, null);
  assert.equal(view.consecutiveFailures, 0);
  assert.equal(view.nextAutomaticPollAt, null);
  assert.equal(isAutomaticInboundMailPollDue(store.db, 'tenant:mail-recovered', new Date('2026-08-28T04:01:01.000Z')), true);
  store.close();
});

test('IMAP 监控：进程重启后仍从 SQLite 恢复自动退避期限', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-imap-backoff-'));
  const databasePath = join(directory, 'readywork.sqlite');
  try {
    const firstProcess = openPersistence(databasePath);
    await assert.rejects(() => runInboundMailPoll({
      db: firstProcess.db,
      tenantId: 'tenant:mail-restart',
      trigger: 'automatic',
      actorId: 'system:imap-poller',
      provider: 'imap:imap.163.com',
      mailbox: 'INBOX',
      poll: async () => { throw new Error('NO FETCH Fetch volume limit exceed'); },
      now: sequence('2026-08-28T05:00:00.000Z', '2026-08-28T05:00:02.000Z'),
    }));
    firstProcess.close();

    const restartedProcess = openPersistence(databasePath);
    recordInboundMailRuntimeState(restartedProcess.db, 'tenant:mail-restart', {
      configured: true,
      connected: true,
      provider: 'imap:imap.163.com',
      mailbox: 'INBOX',
    }, new Date('2026-08-28T05:00:30.000Z'));
    const restored = inboundMailMonitorView(restartedProcess.db, 'tenant:mail-restart');
    assert.equal(restored.lastStatus, 'throttled');
    assert.equal(restored.consecutiveFailures, 1);
    assert.equal(restored.nextAutomaticPollAt, '2026-08-28T05:15:02.000Z');
    assert.equal(isAutomaticInboundMailPollDue(restartedProcess.db, 'tenant:mail-restart', new Date('2026-08-28T05:15:01.999Z')), false);
    assert.equal(isAutomaticInboundMailPollDue(restartedProcess.db, 'tenant:mail-restart', new Date('2026-08-28T05:15:02.000Z')), true);
    restartedProcess.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('IMAP 监控：自动调度在持久退避到期前不再连接收件服务器', async () => {
  const store = openPersistence(':memory:');
  const tenantId = 'tenant:mail-scheduler-backoff';
  await assert.rejects(() => runInboundMailPoll({
    db: store.db,
    tenantId,
    trigger: 'automatic',
    actorId: 'system:imap-poller',
    provider: 'imap:imap.example.net',
    mailbox: 'INBOX',
    poll: async () => { throw new Error('temporary IMAP timeout'); },
    now: sequence('2026-08-28T06:00:00.000Z', '2026-08-28T06:00:02.000Z'),
  }));

  const poll = () => runInboundMailPoll({
    db: store.db,
    tenantId,
    trigger: 'automatic',
    actorId: 'system:imap-poller',
    provider: 'imap:imap.example.net',
    mailbox: 'INBOX',
    poll: async () => 0,
    now: sequence('2026-08-28T06:01:02.000Z', '2026-08-28T06:01:03.000Z'),
  });

  const deferred = await runAutomaticInboundMailPollIfDue({
    db: store.db,
    tenantId,
    poll,
    now: new Date('2026-08-28T06:01:01.999Z'),
  });
  assert.equal(deferred, undefined);
  assert.equal(inboundMailMonitorView(store.db, tenantId).runs.length, 1);

  const completed = await runAutomaticInboundMailPollIfDue({
    db: store.db,
    tenantId,
    poll,
    now: new Date('2026-08-28T06:01:02.000Z'),
  });
  assert.equal(completed?.handledCount, 0);
  assert.equal(inboundMailMonitorView(store.db, tenantId).runs.length, 2);
  store.close();
});

test('IMAP 监控：自动收件默认一分钟且拒绝过度高频的重连节拍', () => {
  assert.equal(inboundMailAutomaticPollIntervalMs(undefined), 60_000);
  assert.equal(inboundMailAutomaticPollIntervalMs('not-a-number'), 60_000);
  assert.equal(inboundMailAutomaticPollIntervalMs('5000'), 15_000);
  assert.equal(inboundMailAutomaticPollIntervalMs('90000'), 90_000);
  assert.equal(inboundMailAutomaticPollIntervalMs('900000'), 300_000);
});

test('IMAP 监控：兼容旧记录，从持久化运行恢复被清空的限流原因', async () => {
  const store = openPersistence(':memory:');
  await assert.rejects(() => runInboundMailPoll({
    db: store.db,
    tenantId: 'tenant:mail-legacy-status',
    trigger: 'automatic',
    actorId: 'system:imap-poller',
    provider: 'imap:imap.163.com',
    mailbox: 'INBOX',
    poll: async () => { throw new Error('NO FETCH Fetch volume limit exceed'); },
    now: sequence('2026-08-28T05:30:00.000Z', '2026-08-28T05:30:02.000Z'),
  }));
  store.db.prepare(`UPDATE procurement_inbound_mail_status SET last_error=NULL WHERE tenant_id=?`)
    .run('tenant:mail-legacy-status');

  const restored = inboundMailMonitorView(store.db, 'tenant:mail-legacy-status');
  assert.equal(restored.lastStatus, 'throttled');
  assert.match(restored.lastError ?? '', /Fetch volume limit/i);
  store.close();
});

test('IMAP 监控：相同拒绝邮件只首次告警，主数据修复后可解除', () => {
  const store = openPersistence(':memory:');
  const identity = {
    provider: 'imap:imap.example.net', mailbox: 'INBOX', providerUid: 'uid-9',
    messageId: '<reply-9@example.net>', observedSender: '供应商业务 <Reply-9@Example.NET>',
    poNumber: 'P00009', reasonCode: 'SUPPLIER_EMAIL_MISMATCH',
  };
  assert.equal(recordInboundMailRejection(store.db, 'tenant:mail-rejection', identity, new Date('2026-08-28T03:00:00.000Z')), true);
  assert.equal(recordInboundMailRejection(store.db, 'tenant:mail-rejection', identity, new Date('2026-08-28T03:01:00.000Z')), false);
  assert.equal(inboundMailMonitorView(store.db, 'tenant:mail-rejection').unresolvedRejectedCount, 1);
  const attempts = store.db.prepare(`SELECT attempts,next_attempt_at,observed_sender FROM procurement_inbound_mail_rejections WHERE tenant_id=?`).get('tenant:mail-rejection') as { attempts: number; next_attempt_at: string; observed_sender: string };
  assert.equal(attempts.attempts, 2);
  assert.equal(attempts.next_attempt_at, '2026-08-28T03:31:00.000Z');
  assert.equal(attempts.observed_sender, 'reply-9@example.net');
  assert.deepEqual(
    [...deferredInboundMailUids(store.db, 'tenant:mail-rejection', identity.provider, identity.mailbox, new Date('2026-08-28T03:30:59.999Z'))],
    ['uid-9'],
  );
  assert.deepEqual(
    [...rejectedInboundMailUids(store.db, 'tenant:mail-rejection', identity.provider, identity.mailbox)],
    ['uid-9'],
  );
  assert.deepEqual(
    [...deferredInboundMailUids(store.db, 'tenant:mail-rejection', identity.provider, identity.mailbox, new Date('2026-08-28T03:31:00.000Z'))],
    [],
  );
  resolveInboundMailRejection(store.db, 'tenant:mail-rejection', identity.provider, identity.mailbox, identity.providerUid);
  assert.equal(inboundMailMonitorView(store.db, 'tenant:mail-rejection').unresolvedRejectedCount, 0);
  store.close();
});

test('IMAP 监控：旧拒绝记录缺少重试时间时按历史尝试恢复 UID 退避', () => {
  const store = openPersistence(':memory:');
  const tenantId = 'tenant:mail-legacy-rejection';
  store.db.prepare(`INSERT INTO procurement_inbound_mail_rejections
    (tenant_id,provider,mailbox,provider_uid,message_id,po_number,reason_code,attempts,first_seen_at,last_seen_at,next_attempt_at)
    VALUES (?,'imap:imap.163.com','INBOX','uid-legacy','<legacy@example.net>','P00011','SUPPLIER_EMAIL_MISMATCH',188,?,?,NULL)`)
    .run(tenantId, '2026-08-27T20:00:00.000Z', '2026-08-27T21:05:39.000Z');

  assert.equal(repairLegacyInboundMailRejectionBackoff(store.db, tenantId), 1);
  const row = store.db.prepare(`SELECT next_attempt_at FROM procurement_inbound_mail_rejections WHERE tenant_id=?`)
    .get(tenantId) as { next_attempt_at: string };
  assert.equal(row.next_attempt_at, '2026-08-28T21:05:39.000Z');
  assert.deepEqual([...deferredInboundMailUids(store.db, tenantId, 'imap:imap.163.com', 'INBOX', new Date('2026-08-28T12:00:00.000Z'))], ['uid-legacy']);
  assert.equal(repairLegacyInboundMailRejectionBackoff(store.db, tenantId), 0);
  store.close();
});

function sequence(...values: string[]): () => Date {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]!);
}
