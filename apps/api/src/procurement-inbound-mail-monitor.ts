import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';
import { redactSensitive } from './http-errors.js';

export type InboundMailPollTrigger = 'automatic' | 'manual';

export interface ProcurementInboundMailPollResult {
  readonly runId: string;
  readonly trigger: InboundMailPollTrigger;
  readonly status: 'completed';
  readonly handledCount: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ProcurementInboundMailRuntimeState {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly provider?: string | null;
  readonly mailbox?: string | null;
  readonly error?: string | null;
}

export interface InboundMailRejectionIdentity {
  readonly provider: string;
  readonly mailbox: string;
  readonly providerUid: string;
  readonly messageId?: string | null;
  /** Normalized address observed in the rejected message's From header. */
  readonly observedSender?: string | null;
  readonly poNumber: string;
  readonly reasonCode: string;
}

export interface ProcurementInboundMailContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly poll?: (actorId: string) => Promise<ProcurementInboundMailPollResult>;
}

interface StatusRow {
  configured: number;
  connected: number;
  provider: string | null;
  mailbox: string | null;
  last_started_at: string | null;
  last_completed_at: string | null;
  last_status: string | null;
  last_handled_count: number | null;
  last_error: string | null;
  next_poll_at: string | null;
  consecutive_failures: number;
  updated_at: string;
}

interface RunRow {
  id: string;
  trigger: InboundMailPollTrigger;
  actor_id: string;
  provider: string;
  mailbox: string;
  status: 'running' | 'completed' | 'failed';
  handled_count: number | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export function recordInboundMailRuntimeState(
  db: DatabaseSync,
  tenantId: string,
  state: ProcurementInboundMailRuntimeState,
  at = new Date(),
): void {
  repairLegacyInboundMailRejectionBackoff(db, tenantId);
  const now = at.toISOString();
  const error = state.error ? redactSensitive(state.error, 500) : null;
  const recovered = db.prepare(`UPDATE procurement_inbound_mail_runs
    SET status='failed',completed_at=?,error='API 进程重启，前一次 IMAP 检查未完成'
    WHERE tenant_id=? AND status='running'`).run(now, tenantId).changes;
  db.prepare(`INSERT INTO procurement_inbound_mail_status
      (tenant_id,configured,connected,provider,mailbox,last_completed_at,last_status,last_error,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        configured=excluded.configured,
        connected=excluded.connected,
        provider=excluded.provider,
        mailbox=excluded.mailbox,
        last_completed_at=CASE WHEN ? > 0 THEN excluded.last_completed_at ELSE procurement_inbound_mail_status.last_completed_at END,
        last_status=CASE WHEN ? > 0 THEN 'failed' ELSE procurement_inbound_mail_status.last_status END,
        last_error=CASE
          WHEN ? > 0 THEN 'API 进程重启，前一次 IMAP 检查未完成'
          WHEN excluded.last_error IS NOT NULL THEN excluded.last_error
          ELSE procurement_inbound_mail_status.last_error
        END,
        updated_at=excluded.updated_at`)
    .run(tenantId, state.configured ? 1 : 0, state.connected ? 1 : 0,
      state.provider ?? null, state.mailbox ?? null,
      recovered > 0 ? now : null,
      recovered > 0 ? 'failed' : null,
      recovered > 0 ? 'API 进程重启，前一次 IMAP 检查未完成' : error,
      now, recovered, recovered, recovered);
}

export async function runInboundMailPoll(input: {
  db: DatabaseSync;
  tenantId: string;
  trigger: InboundMailPollTrigger;
  actorId: string;
  provider: string;
  mailbox: string;
  poll: () => Promise<number>;
  timeoutMs?: number;
  onTimeout?: () => void;
  now?: () => Date;
}): Promise<ProcurementInboundMailPollResult> {
  const startedAt = (input.now?.() ?? new Date()).toISOString();
  const runId = `inbound-mail-run:${randomUUID()}`;
  input.db.exec('BEGIN IMMEDIATE');
  try {
    input.db.prepare(`INSERT INTO procurement_inbound_mail_runs
        (tenant_id,id,trigger,actor_id,provider,mailbox,status,started_at)
        VALUES (?,?,?,?,?,?,'running',?)`)
      .run(input.tenantId, runId, input.trigger, input.actorId, input.provider, input.mailbox, startedAt);
    input.db.prepare(`INSERT INTO procurement_inbound_mail_status
        (tenant_id,configured,connected,provider,mailbox,last_started_at,last_status,last_error,updated_at)
        VALUES (?,1,1,?,?,?,'running',NULL,?)
        ON CONFLICT(tenant_id) DO UPDATE SET
          configured=1,connected=1,provider=excluded.provider,mailbox=excluded.mailbox,
          last_started_at=excluded.last_started_at,last_status='running',last_error=NULL,updated_at=excluded.updated_at`)
      .run(input.tenantId, input.provider, input.mailbox, startedAt, startedAt);
    input.db.exec('COMMIT');
  } catch (error) {
    rollback(input.db);
    throw error;
  }

  try {
    const handledCount = await pollWithTimeout(input.poll, input.timeoutMs ?? 60_000, input.onTimeout);
    const completedAt = (input.now?.() ?? new Date()).toISOString();
    input.db.exec('BEGIN IMMEDIATE');
    try {
      input.db.prepare(`UPDATE procurement_inbound_mail_runs
        SET status='completed',handled_count=?,completed_at=?,error=NULL
        WHERE tenant_id=? AND id=? AND status='running'`)
        .run(handledCount, completedAt, input.tenantId, runId);
      input.db.prepare(`UPDATE procurement_inbound_mail_status
        SET configured=1,connected=1,last_completed_at=?,last_status='completed',last_handled_count=?,last_error=NULL,
          next_poll_at=NULL,consecutive_failures=0,updated_at=?
        WHERE tenant_id=?`)
        .run(completedAt, handledCount, completedAt, input.tenantId);
      input.db.exec('COMMIT');
    } catch (error) {
      rollback(input.db);
      throw error;
    }
    return { runId, trigger: input.trigger, status: 'completed', handledCount, startedAt, completedAt };
  } catch (error) {
    const completedAt = (input.now?.() ?? new Date()).toISOString();
    const message = redactSensitive(error, 500) || 'IMAP 轮询失败';
    const current = input.db.prepare(`SELECT consecutive_failures FROM procurement_inbound_mail_status WHERE tenant_id=?`)
      .get(input.tenantId) as { consecutive_failures: number } | undefined;
    const failures = Math.max(1, Number(current?.consecutive_failures ?? 0) + 1);
    const throttled = isInboundMailThrottleError(error);
    const nextPollAt = new Date(new Date(completedAt).getTime() + inboundMailFailureBackoffMs(failures, throttled)).toISOString();
    input.db.exec('BEGIN IMMEDIATE');
    try {
      input.db.prepare(`UPDATE procurement_inbound_mail_runs
        SET status='failed',completed_at=?,error=?
        WHERE tenant_id=? AND id=? AND status='running'`)
        .run(completedAt, message, input.tenantId, runId);
      input.db.prepare(`UPDATE procurement_inbound_mail_status
        SET connected=?,last_completed_at=?,last_status='failed',last_error=?,next_poll_at=?,consecutive_failures=?,updated_at=?
        WHERE tenant_id=?`)
        .run(throttled ? 1 : 0, completedAt, message, nextPollAt, failures, completedAt, input.tenantId);
      input.db.exec('COMMIT');
    } catch {
      rollback(input.db);
    }
    throw new InboundMailPollError(message);
  }
}

async function pollWithTimeout(poll: () => Promise<number>, timeoutMs: number, onTimeout?: () => void): Promise<number> {
  const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(1_000, Math.min(5 * 60_000, Math.floor(timeoutMs))) : 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      poll(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch { /* timeout still fails the run */ }
          reject(new Error(`IMAP 轮询超过 ${boundedTimeoutMs}ms，连接已关闭`));
        }, boundedTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Returns true only for the first rejection of this provider/mailbox/UID identity. */
export function recordInboundMailRejection(
  db: DatabaseSync,
  tenantId: string,
  identity: InboundMailRejectionIdentity,
  at = new Date(),
): boolean {
  const existing = db.prepare(`SELECT attempts FROM procurement_inbound_mail_rejections
    WHERE tenant_id=? AND provider=? AND mailbox=? AND provider_uid=?`)
    .get(tenantId, identity.provider, identity.mailbox, identity.providerUid) as { attempts: number } | undefined;
  const now = at.toISOString();
  const attempts = Math.max(1, Number(existing?.attempts ?? 0) + 1);
  const delayMs = inboundMailRejectionBackoffMs(attempts);
  const nextAttemptAt = new Date(at.getTime() + delayMs).toISOString();
  const observedSender = normalizeObservedSender(identity.observedSender);
  db.prepare(`INSERT INTO procurement_inbound_mail_rejections
      (tenant_id,provider,mailbox,provider_uid,message_id,observed_sender,po_number,reason_code,attempts,first_seen_at,last_seen_at,next_attempt_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,provider,mailbox,provider_uid) DO UPDATE SET
        message_id=excluded.message_id,observed_sender=COALESCE(excluded.observed_sender,procurement_inbound_mail_rejections.observed_sender),
        po_number=excluded.po_number,reason_code=excluded.reason_code,
        attempts=excluded.attempts,last_seen_at=excluded.last_seen_at,next_attempt_at=excluded.next_attempt_at`)
    .run(tenantId, identity.provider, identity.mailbox, identity.providerUid,
      identity.messageId ?? null, observedSender, identity.poNumber, identity.reasonCode, attempts, now, now, nextAttemptAt);
  return !existing;
}

function normalizeObservedSender(value: string | null | undefined): string | null {
  if (!value) return null;
  const bracketed = /<\s*([^<>]+?)\s*>/.exec(value);
  const candidate = (bracketed?.[1] ?? value).trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate)) return null;
  return candidate.toLowerCase().slice(0, 320);
}

/**
 * Per-UID retry timestamps were added after some persisted rejection rows had
 * already accumulated attempts. Reconstruct those timestamps from immutable
 * last_seen_at evidence so a restart cannot immediately refetch the same
 * rejected messages and trigger the provider FETCH quota again.
 */
export function repairLegacyInboundMailRejectionBackoff(db: DatabaseSync, tenantId: string): number {
  const rows = db.prepare(`SELECT provider,mailbox,provider_uid,attempts,last_seen_at
    FROM procurement_inbound_mail_rejections WHERE tenant_id=? AND next_attempt_at IS NULL`)
    .all(tenantId) as unknown as Array<{
      provider: string; mailbox: string; provider_uid: string; attempts: number; last_seen_at: string;
    }>;
  const update = db.prepare(`UPDATE procurement_inbound_mail_rejections SET next_attempt_at=?
    WHERE tenant_id=? AND provider=? AND mailbox=? AND provider_uid=? AND next_attempt_at IS NULL`);
  let repaired = 0;
  for (const row of rows) {
    const lastSeen = Date.parse(row.last_seen_at);
    if (!Number.isFinite(lastSeen)) continue;
    const nextAttemptAt = new Date(lastSeen + inboundMailRejectionBackoffMs(Number(row.attempts))).toISOString();
    repaired += Number(update.run(nextAttemptAt, tenantId, row.provider, row.mailbox, row.provider_uid).changes);
  }
  return repaired;
}

function inboundMailRejectionBackoffMs(attempts: number): number {
  const boundedAttempts = Math.max(1, Math.min(64, Math.trunc(attempts)));
  return Math.min(24 * 60 * 60_000, 15 * 60_000 * (2 ** (boundedAttempts - 1)));
}

export function deferredInboundMailUids(
  db: DatabaseSync,
  tenantId: string,
  provider: string,
  mailbox: string,
  at = new Date(),
): Set<string> {
  const rows = db.prepare(`SELECT provider_uid FROM procurement_inbound_mail_rejections
    WHERE tenant_id=? AND provider=? AND mailbox=? AND next_attempt_at>?`)
    .all(tenantId, provider, mailbox, at.toISOString()) as unknown as Array<{ provider_uid: string }>;
  return new Set(rows.map((row) => row.provider_uid));
}

/**
 * Operator-triggered checks retry durable rejections before unrelated new
 * mail. This only selects UIDs; all identity and business validation runs
 * again before a message can be marked seen.
 */
export function rejectedInboundMailUids(
  db: DatabaseSync,
  tenantId: string,
  provider: string,
  mailbox: string,
  limit = 100,
): Set<string> {
  const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
  const rows = db.prepare(`SELECT provider_uid FROM procurement_inbound_mail_rejections
    WHERE tenant_id=? AND provider=? AND mailbox=?
    ORDER BY last_seen_at DESC,provider_uid DESC LIMIT ?`)
    .all(tenantId, provider, mailbox, bounded) as unknown as Array<{ provider_uid: string }>;
  return new Set(rows.map((row) => row.provider_uid));
}

export function isAutomaticInboundMailPollDue(db: DatabaseSync, tenantId: string, at = new Date()): boolean {
  const row = db.prepare(`SELECT next_poll_at FROM procurement_inbound_mail_status WHERE tenant_id=?`)
    .get(tenantId) as { next_poll_at: string | null } | undefined;
  return !row?.next_poll_at || row.next_poll_at <= at.toISOString();
}

export function inboundMailAutomaticPollIntervalMs(value: string | undefined): number {
  const parsed = Number(value ?? 60_000);
  if (!Number.isFinite(parsed)) return 60_000;
  return Math.min(300_000, Math.max(15_000, Math.floor(parsed)));
}

export async function runAutomaticInboundMailPollIfDue<T>(input: {
  db: DatabaseSync;
  tenantId: string;
  poll: () => Promise<T>;
  now?: Date;
}): Promise<T | undefined> {
  if (!isAutomaticInboundMailPollDue(input.db, input.tenantId, input.now)) return undefined;
  return input.poll();
}

export function resolveInboundMailRejection(
  db: DatabaseSync,
  tenantId: string,
  provider: string,
  mailbox: string,
  providerUid: string,
): void {
  db.prepare(`DELETE FROM procurement_inbound_mail_rejections
    WHERE tenant_id=? AND provider=? AND mailbox=? AND provider_uid=?`)
    .run(tenantId, provider, mailbox, providerUid);
}

export function inboundMailMonitorView(db: DatabaseSync, tenantId: string) {
  const status = db.prepare(`SELECT configured,connected,provider,mailbox,last_started_at,last_completed_at,
      last_status,last_handled_count,last_error,next_poll_at,consecutive_failures,updated_at
    FROM procurement_inbound_mail_status WHERE tenant_id=?`).get(tenantId) as StatusRow | undefined;
  const runs = db.prepare(`SELECT id,trigger,actor_id,provider,mailbox,status,handled_count,started_at,completed_at,error
    FROM procurement_inbound_mail_runs WHERE tenant_id=? ORDER BY started_at DESC,id DESC LIMIT 20`)
    .all(tenantId) as unknown as RunRow[];
  const rejected = db.prepare(`SELECT COUNT(*) AS count FROM procurement_inbound_mail_rejections WHERE tenant_id=?`)
    .get(tenantId) as { count: number };
  // Older process-startup code could clear last_error while retaining a
  // failed status. Recover the provider classification from the matching
  // durable run so the UI never reports an unexplained generic failure.
  const latestFailure = runs.find((run) => run.status === 'failed'
    && (!status?.last_completed_at || run.completed_at === status.last_completed_at))
    ?? runs.find((run) => run.status === 'failed');
  const lastError = status?.last_error
    ?? (status?.last_status === 'failed' ? latestFailure?.error : null)
    ?? null;
  return {
    configured: status?.configured === 1,
    connected: status?.connected === 1,
    provider: status?.provider ?? null,
    mailbox: status?.mailbox ?? null,
    lastStartedAt: status?.last_started_at ?? null,
    lastCompletedAt: status?.last_completed_at ?? null,
    lastStatus: status?.last_status === 'failed' && status.next_poll_at && isInboundMailThrottleError(lastError)
      ? 'throttled' : status?.last_status ?? null,
    lastHandledCount: status?.last_handled_count ?? null,
    lastError: lastError ? redactSensitive(lastError, 500) : null,
    nextAutomaticPollAt: status?.next_poll_at ?? null,
    consecutiveFailures: Number(status?.consecutive_failures ?? 0),
    unresolvedRejectedCount: Number(rejected.count),
    updatedAt: status?.updated_at ?? null,
    runs: runs.map((run) => ({
      id: run.id,
      trigger: run.trigger,
      actorId: run.actor_id,
      provider: run.provider,
      mailbox: run.mailbox,
      status: run.status,
      handledCount: run.handled_count,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      error: run.error ? redactSensitive(run.error, 500) : null,
    })),
  };
}

export async function handleProcurementInboundMailRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementInboundMailContext,
): Promise<boolean> {
  const root = path === '/api/procurement/inbound-mail';
  const poll = path === '/api/procurement/inbound-mail/poll';
  if (!root && !poll) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  if (root && method === 'GET') {
    if (!can(context.session, 'read')) { sendJson(res, 403, { error: '无读取供应商回信状态权限', code: 'FORBIDDEN' }); return true; }
    sendJson(res, 200, inboundMailMonitorView(context.db, context.session.tenantId));
    return true;
  }
  if (poll && method === 'POST') {
    if (!can(context.session, 'operate')) { sendJson(res, 403, { error: '无检查供应商回复权限', code: 'FORBIDDEN' }); return true; }
    if (!context.poll) { sendJson(res, 409, { error: '邮箱收件连接器尚未配置或连接失败', code: 'INBOUND_MAIL_NOT_READY' }); return true; }
    try {
      const result = await context.poll(context.session.humanId);
      sendJson(res, 200, { result, monitor: inboundMailMonitorView(context.db, context.session.tenantId) });
    } catch (error) {
      sendJson(res, 503, { error: redactSensitive(error, 500) || '检查供应商回复失败', code: 'INBOUND_MAIL_POLL_FAILED', monitor: inboundMailMonitorView(context.db, context.session.tenantId) });
    }
    return true;
  }
  sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
  return true;
}

export class InboundMailPollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundMailPollError';
  }
}

function isInboundMailThrottleError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return /fetch volume limit|rate[ -]?limit|too many requests|throttl/i.test(text);
}

function inboundMailFailureBackoffMs(failures: number, throttled: boolean): number {
  const base = throttled ? 15 * 60_000 : 60_000;
  const maximum = throttled ? 60 * 60_000 : 15 * 60_000;
  return Math.min(maximum, base * (2 ** Math.max(0, failures - 1)));
}

function rollback(db: DatabaseSync): void { try { db.exec('ROLLBACK'); } catch { /* no active transaction */ } }
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
