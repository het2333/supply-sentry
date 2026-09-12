import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { MessagingAdapterState, StoredMessageDeliveryRequest } from '@readywork/messaging';
import { MessagingAdapterVersionConflictError } from '@readywork/messaging';
import { can, type Session } from './auth.js';
import { redactSensitive } from './http-errors.js';

export interface MessagingRuntimeControl {
  adapterStates(): MessagingAdapterState[];
  pauseAdapter(adapterId: string, expectedVersion: number, actorId: string, reason: string): MessagingAdapterState;
  resumeAdapter(adapterId: string, expectedVersion: number, actorId: string, reason: string): MessagingAdapterState;
}

export interface MessagingRequestContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly runtimeForTenant: (tenantId: string) => MessagingRuntimeControl;
  readonly now?: () => string;
}

type GatewayAction = 'pause' | 'resume';

export async function handleMessagingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: MessagingRequestContext,
): Promise<boolean> {
  if (!path.startsWith('/api/messaging/')) return false;
  if (!context.session) return json(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  if (!can(context.session, 'read')) return json(res, 403, { error: '无读取消息网关权限', code: 'FORBIDDEN' });
  const runtime = context.runtimeForTenant(context.session.tenantId);
  const now = context.now ?? (() => new Date().toISOString());

  if (path === '/api/messaging/gateway') {
    if (method !== 'GET') return json(res, 405, { error: '消息网关摘要只支持读取', code: 'METHOD_NOT_ALLOWED' });
    const adapters = runtime.adapterStates().map((state) => adapterSummary(context.db, state));
    return json(res, 200, {
      status: overallStatus(adapters.map((adapter) => adapter.status)),
      checkedAt: now(),
      adapters,
      permissions: { manage: can(context.session, 'admin') },
    });
  }

  if (path === '/api/messaging/deliveries') {
    if (method !== 'GET') return json(res, 405, { error: '消息投递列表只支持读取', code: 'METHOD_NOT_ALLOWED' });
    if (!can(context.session, 'admin')) return json(res, 403, { error: '无读取异常投递权限', code: 'FORBIDDEN' });
    const requestUrl = new URL(req.url ?? path, 'http://127.0.0.1');
    const status = requestUrl.searchParams.get('status') ?? '';
    if (!['unknown', 'failed', 'abandoned'].includes(status)) {
      return json(res, 400, { error: 'status 仅支持 unknown、failed 或 abandoned', code: 'INVALID_STATUS' });
    }
    const rows = context.db.prepare(`SELECT id,adapter_id,channel,status,request_json,attempts,error,created_at,updated_at
      FROM messaging_deliveries WHERE tenant_id=? AND status=? ORDER BY updated_at DESC,id LIMIT 100`)
      .all(context.session.tenantId, status) as unknown as Array<{
        id: string;
        adapter_id: string;
        channel: string;
        status: string;
        request_json: string;
        attempts: number;
        error: string | null;
        created_at: string;
        updated_at: string;
      }>;
    return json(res, 200, {
      deliveries: rows.map((row) => {
        const request = JSON.parse(row.request_json) as StoredMessageDeliveryRequest;
        return {
          id: row.id,
          adapterId: row.adapter_id,
          channel: row.channel,
          status: row.status,
          attempts: row.attempts,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          recipient: maskAddress(request.recipients[0]?.address ?? ''),
          source: request.trace.source,
          sourceId: request.trace.sourceId,
          correlationId: request.trace.correlationId,
          ...(row.error ? { error: redactSensitive(row.error, 500) } : {}),
        };
      }),
    });
  }

  const actionMatch = path.match(/^\/api\/messaging\/adapters\/([^/]+)\/(pause|resume)$/u);
  if (!actionMatch) return false;
  if (method !== 'POST') return json(res, 405, { error: '适配器操作只支持 POST', code: 'METHOD_NOT_ALLOWED' });
  if (!can(context.session, 'admin')) return json(res, 403, { error: '无管理消息适配器权限', code: 'FORBIDDEN' });
  const idempotencyKey = singleHeader(req.headers['idempotency-key']);
  if (!idempotencyKey) return json(res, 400, { error: '缺少 Idempotency-Key', code: 'IDEMPOTENCY_KEY_REQUIRED' });
  const adapterId = decodeURIComponent(actionMatch[1]!);
  const action = actionMatch[2]! as GatewayAction;
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req);
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : '请求体无效', code: 'INVALID_BODY' });
  }
  const expectedVersion = Number(body['expectedVersion']);
  const reason = typeof body['reason'] === 'string' ? redactSensitive(body['reason'].trim(), 500) : '';
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0 || !reason) {
    return json(res, 400, { error: 'expectedVersion 必须为正整数且 reason 不能为空', code: 'INVALID_ACTION' });
  }
  const fingerprint = createHash('sha256')
    .update(stableJson({ action, adapterId, expectedVersion, reason }))
    .digest('hex');
  const existing = context.db.prepare(`SELECT request_fingerprint,response_json FROM messaging_gateway_actions
    WHERE tenant_id=? AND idempotency_key=?`).get(context.session.tenantId, idempotencyKey) as {
      request_fingerprint: string;
      response_json: string;
    } | undefined;
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) {
      return json(res, 409, { error: 'Idempotency-Key 已用于不同请求', code: 'IDEMPOTENCY_CONFLICT' });
    }
    return json(res, 200, { ...(JSON.parse(existing.response_json) as Record<string, unknown>), replayed: true });
  }

  context.db.exec('BEGIN IMMEDIATE');
  try {
    const adapter = action === 'pause'
      ? runtime.pauseAdapter(adapterId, expectedVersion, context.session.humanId, reason)
      : runtime.resumeAdapter(adapterId, expectedVersion, context.session.humanId, reason);
    const response = { adapter: publicAdapterState(adapter), replayed: false };
    context.db.prepare(`INSERT INTO messaging_gateway_actions
      (tenant_id,idempotency_key,action,adapter_id,request_fingerprint,response_json,actor_id,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      context.session.tenantId,
      idempotencyKey,
      action,
      adapterId,
      fingerprint,
      JSON.stringify(response),
      context.session.humanId,
      reason,
      now(),
    );
    context.db.exec('COMMIT');
    return json(res, 200, response);
  } catch (error) {
    context.db.exec('ROLLBACK');
    if (error instanceof MessagingAdapterVersionConflictError) {
      return json(res, 409, { error: error.message, code: 'VERSION_CONFLICT' });
    }
    if (error instanceof Error && /不存在/u.test(error.message)) {
      return json(res, 404, { error: error.message, code: 'ADAPTER_NOT_FOUND' });
    }
    throw error;
  }
}

function adapterSummary(db: DatabaseSync, state: MessagingAdapterState) {
  const pendingInbound = count(db, `SELECT COUNT(*) AS count FROM messaging_inbound_messages
    WHERE tenant_id=? AND adapter_id=? AND status IN ('received','dispatching','failed')`, state.tenantId, state.adapterId);
  const pendingDeliveries = count(db, `SELECT COUNT(*) AS count FROM messaging_deliveries
    WHERE tenant_id=? AND adapter_id=? AND status IN ('pending','sending','retry_wait')`, state.tenantId, state.adapterId);
  const exceptionalDeliveries = count(db, `SELECT COUNT(*) AS count FROM messaging_deliveries
    WHERE tenant_id=? AND adapter_id=? AND status IN ('unknown','failed','abandoned')`, state.tenantId, state.adapterId);
  return {
    ...publicAdapterState(state),
    pendingInbound,
    pendingDeliveries,
    exceptionalDeliveries,
  };
}

function publicAdapterState(state: MessagingAdapterState) {
  return {
    id: state.adapterId,
    channel: state.channel,
    provider: state.provider,
    status: state.status,
    capabilities: [...state.capabilities],
    configured:state.configured ?? false,
    startedAt:state.startedAt ?? null,
    version: state.version,
    consecutiveFailures: state.consecutiveFailures,
    lastHealthAt: state.lastHealthAt ?? null,
    lastError: state.lastError ? redactSensitive(state.lastError, 500) : null,
    pauseReason: state.pauseReason ? redactSensitive(state.pauseReason, 500) : null,
  };
}

function count(db: DatabaseSync, sql: string, ...params: string[]): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}

function overallStatus(statuses: MessagingAdapterState['status'][]): 'running' | 'degraded' | 'blocked' {
  if (statuses.length > 0 && statuses.every((status) => status === 'running')) return 'running';
  if (statuses.some((status) => status === 'degraded')) return 'degraded';
  return 'blocked';
}

function maskAddress(address: string): string {
  const normalized = address.trim();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return normalized ? `${normalized.slice(0, 1)}***` : '';
  return `${normalized.slice(0, 1)}***${normalized.slice(at)}`;
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 32 * 1024) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function singleHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
