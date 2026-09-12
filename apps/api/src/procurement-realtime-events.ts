import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';

export type ProcurementRealtimeFamily = 'pos' | 'outbox' | 'messages' | 'notifications';

interface RealtimeEventRow {
  seq: number;
  family: ProcurementRealtimeFamily;
  event_type: string;
  object_id: string | null;
  object_version: string | null;
  occurred_at: string;
}

export interface ProcurementRealtimeEvent {
  id: string;
  family: ProcurementRealtimeFamily;
  eventType: string;
  objectId: string | null;
  objectVersion: string | null;
  occurredAt: string;
}

export interface ProcurementRealtimeContext {
  db: DatabaseSync;
  session: Session | null;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxReplayEvents?: number;
}

const FAMILIES: readonly ProcurementRealtimeFamily[] = ['pos', 'outbox', 'messages', 'notifications'];

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function realtimeCursor(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (!/^\d+$/.test(value)) throw new Error('实时事件游标必须是非负整数');
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('实时事件游标超出有效范围');
  return cursor;
}

export function latestProcurementRealtimeEventSeq(db: DatabaseSync, tenantId: string): number {
  const row = db.prepare('SELECT MAX(seq) AS seq FROM procurement_realtime_events WHERE tenant_id=?')
    .get(tenantId) as { seq: number | null } | undefined;
  return Number(row?.seq ?? 0);
}

export function listProcurementRealtimeEvents(
  db: DatabaseSync,
  tenantId: string,
  afterSeq: number,
  limit: number,
): ProcurementRealtimeEvent[] {
  const rows = db.prepare(`SELECT seq,family,event_type,object_id,object_version,occurred_at
    FROM procurement_realtime_events WHERE tenant_id=? AND seq>? ORDER BY seq LIMIT ?`)
    .all(tenantId, afterSeq, limit) as unknown as RealtimeEventRow[];
  return rows.map((row) => ({
    id: String(row.seq),
    family: row.family,
    eventType: row.event_type,
    objectId: row.object_id,
    objectVersion: row.object_version,
    occurredAt: row.occurred_at,
  }));
}

export function procurementSseFrame(event: string, data: unknown, id?: string): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamRequested(req: IncomingMessage, url: URL): boolean {
  const accept = header(req, 'accept') ?? '';
  return url.searchParams.get('stream') === '1' || accept.toLowerCase().includes('text/event-stream');
}

/**
 * Authenticated, tenant-scoped SSE invalidation feed. The stream contains only
 * persisted metadata; clients must re-read the authoritative API for business
 * facts after receiving an event.
 */
export async function handleProcurementRealtimeEventsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementRealtimeContext,
): Promise<boolean> {
  if (path !== '/api/events') return false;
  const url = new URL(req.url ?? path, 'http://127.0.0.1');
  if (!streamRequested(req, url)) return false;
  if (method !== 'GET') {
    sendJson(res, 405, { error: `不支持的方法：${method}`, code: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  if (!context.session) {
    sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
    return true;
  }
  if (!can(context.session, 'read')) {
    sendJson(res, 403, { error: '当前身份没有读取实时采购事件的权限', code: 'FORBIDDEN' });
    return true;
  }

  let requestedCursor: number | null;
  try {
    requestedCursor = realtimeCursor(header(req, 'last-event-id') ?? url.searchParams.get('cursor'));
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : '实时事件游标无效', code: 'INVALID_EVENT_CURSOR' });
    return true;
  }

  const tenantId = context.session.tenantId;
  const pollIntervalMs = Math.min(10_000, Math.max(100, context.pollIntervalMs ?? 1_000));
  const heartbeatIntervalMs = Math.min(60_000, Math.max(1_000, context.heartbeatIntervalMs ?? 15_000));
  const maxReplayEvents = Math.min(1_000, Math.max(1, context.maxReplayEvents ?? 250));
  let cursor = requestedCursor ?? latestProcurementRealtimeEventSeq(context.db, tenantId);
  let closed = false;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store, must-revalidate',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  req.socket.setKeepAlive(true);
  res.write(`retry: 3000\n${procurementSseFrame('ready', { cursor: String(cursor), families: FAMILIES }, String(cursor))}`);

  const write = (value: string): boolean => {
    if (closed || res.destroyed || res.writableEnded) return false;
    try { res.write(value); return true; } catch { return false; }
  };

  const resetToLatest = (latest: number, reason: 'cursor_ahead' | 'backlog_exceeded'): void => {
    cursor = latest;
    write(procurementSseFrame('reset', { cursor: String(latest), reason, families: FAMILIES }, String(latest)));
  };

  const flush = (): void => {
    if (closed) return;
    const latest = latestProcurementRealtimeEventSeq(context.db, tenantId);
    if (cursor > latest) {
      resetToLatest(latest, 'cursor_ahead');
      return;
    }
    const events = listProcurementRealtimeEvents(context.db, tenantId, cursor, maxReplayEvents + 1);
    if (events.length > maxReplayEvents) {
      resetToLatest(latest, 'backlog_exceeded');
      return;
    }
    for (const event of events) {
      if (!write(procurementSseFrame(event.family, event, event.id))) break;
      cursor = Number(event.id);
    }
  };

  if (requestedCursor !== null) flush();
  const pollTimer = setInterval(flush, pollIntervalMs);
  const heartbeatTimer = setInterval(() => { write(`: keep-alive ${Date.now()}\n\n`); }, heartbeatIntervalMs);
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
  };
  req.once('aborted', cleanup);
  req.once('close', cleanup);
  res.once('close', cleanup);
  res.once('finish', cleanup);
  return true;
}
