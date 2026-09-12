import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from '../auth.js';
import { HermesUpstreamError, type HermesPlatformCatalog } from './hermes-control-client.js';
import { HermesRepository } from './hermes-repository.js';
import { resolveWecomSetupReadiness } from './wecom-setup-readiness.js';

export interface HermesControl {
  platforms(profile: string): Promise<HermesPlatformCatalog>;
  configurePlatform(
    profile: string,
    platformId: string,
    body: { readonly enabled?: boolean; readonly env?: Readonly<Record<string, string>>; readonly clear_env?: readonly string[] },
  ): Promise<Record<string, unknown>>;
  testPlatform(profile: string, platformId: string): Promise<Record<string, unknown>>;
  onboarding(input: {
    readonly profile: string;
    readonly platform: 'telegram' | 'whatsapp' | 'weixin';
    readonly method: 'GET' | 'POST' | 'DELETE';
    readonly pairingId?: string;
    readonly action?: 'start' | 'apply';
    readonly body?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  health(): Promise<Record<string, unknown>>;
  detailedHealth(): Promise<Record<string, unknown>>;
}

export interface HermesMessagingRequestContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly control?: HermesControl;
  readonly synchronizePlatforms?: (tenantId: string, platforms: HermesPlatformCatalog['platforms']) => void;
  readonly wecomCallbackPublicUrl?: string;
  readonly now?: () => string;
}

export async function handleHermesMessagingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: HermesMessagingRequestContext,
): Promise<boolean> {
  const isPlatforms = path === '/api/messaging/platforms'
    || /^\/api\/messaging\/platforms\/[^/]+(?:\/test)?$/u.test(path);
  const isHealth = path === '/api/messaging/hermes/health';
  const isOnboarding = path.startsWith('/api/messaging/onboarding/');
  const isWecomSetupReadiness = path === '/api/messaging/wecom/setup-readiness';
  if (!isPlatforms && !isHealth && !isOnboarding && !isWecomSetupReadiness) return false;
  if (!context.session) return json(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  if (!can(context.session, 'read')) return json(res, 403, { error: '无读取消息渠道权限', code: 'FORBIDDEN' });
  const repository = new HermesRepository(context.db, context.session.tenantId);
  const now = context.now ?? (() => new Date().toISOString());
  const profile = repository.profileForTenant(now());

  if (isWecomSetupReadiness) {
    if (method !== 'GET') return json(res, 405, { error: '企业微信接入状态只支持读取', code: 'METHOD_NOT_ALLOWED' });
    return json(res, 200, resolveWecomSetupReadiness(context.wecomCallbackPublicUrl));
  }

  if (path === '/api/messaging/platforms') {
    if (method !== 'GET') return json(res, 405, { error: '消息渠道目录只支持读取', code: 'METHOD_NOT_ALLOWED' });
    if (!context.control) return staleOrUnavailable(res, repository, 'Hermes 管理服务尚未配置', context.session);
    try {
      const catalog = await context.control.platforms(profile);
      context.synchronizePlatforms?.(context.session.tenantId, catalog.platforms);
      repository.savePlatformSnapshot({ capturedAt: now(), catalog: catalog as unknown as Record<string, unknown> });
      return json(res, 200, {
        ...catalog,
        stale: false,
        capturedAt: now(),
        permissions: { manage: can(context.session, 'admin') },
      });
    } catch {
      return staleOrUnavailable(res, repository, 'Hermes 管理服务当前不可达', context.session);
    }
  }

  if (path === '/api/messaging/hermes/health') {
    if (method !== 'GET') return json(res, 405, { error: 'Hermes 健康状态只支持读取', code: 'METHOD_NOT_ALLOWED' });
    const queue = context.db.prepare(`SELECT
      (SELECT COUNT(*) FROM messaging_inbound_messages WHERE tenant_id=? AND status IN ('received','dispatching','failed')) AS inbox_pending,
      (SELECT COUNT(*) FROM messaging_deliveries WHERE tenant_id=? AND status IN ('pending','sending','retry_wait')) AS outbox_pending,
      (SELECT COUNT(*) FROM messaging_deliveries WHERE tenant_id=? AND status='unknown') AS unknown_deliveries`
    ).get(context.session.tenantId, context.session.tenantId, context.session.tenantId) as {
      inbox_pending: number; outbox_pending: number; unknown_deliveries: number;
    };
    if (!context.control) return json(res, 200, {
      status: 'unreachable',
      checkedAt: now(),
      sidecar: { ok: false },
      bridge: { ok: false, reason: 'Hermes Bridge 尚未配置' },
      inboxOutbox: { inboxPending: queue.inbox_pending, outboxPending: queue.outbox_pending, unknownDeliveries: queue.unknown_deliveries },
    });
    try {
      const [health, detailed] = await Promise.all([
        context.control.health(),
        context.control.detailedHealth(),
      ]);
      return json(res, 200, {
        status: queue.unknown_deliveries > 0 ? 'blocked' : 'running',
        checkedAt: now(),
        sidecar: { ok: true, health, detailed },
        bridge: { ok: true },
        inboxOutbox: { inboxPending: queue.inbox_pending, outboxPending: queue.outbox_pending, unknownDeliveries: queue.unknown_deliveries },
      });
    } catch {
      return json(res, 200, {
        status: 'unreachable',
        checkedAt: now(),
        sidecar: { ok: false },
        bridge: { ok: false, reason: 'Hermes Sidecar 当前不可达' },
        inboxOutbox: { inboxPending: queue.inbox_pending, outboxPending: queue.outbox_pending, unknownDeliveries: queue.unknown_deliveries },
      });
    }
  }

  const platformMatch = path.match(/^\/api\/messaging\/platforms\/([^/]+)(\/test)?$/u);
  if (platformMatch) {
    const platformId = decodeURIComponent(platformMatch[1]!);
    const action = platformMatch[2] ? 'test' : 'configure';
    if (method !== (action === 'test' ? 'POST' : 'PUT')) {
      return json(res, 405, { error: action === 'test' ? '渠道测试只支持 POST' : '渠道配置只支持 PUT', code: 'METHOD_NOT_ALLOWED' });
    }
    if (!can(context.session, 'admin')) return json(res, 403, { error: '无管理消息渠道权限', code: 'FORBIDDEN' });
    const idempotencyKey = singleHeader(req.headers['idempotency-key']);
    if (!idempotencyKey) return json(res, 400, { error: '缺少 Idempotency-Key', code: 'IDEMPOTENCY_KEY_REQUIRED' });
    let body: Record<string, unknown> = {};
    if (action === 'configure') {
      try { body = await readJsonObject(req); }
      catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : '请求体无效', code: 'INVALID_BODY' }); }
    }
    const fingerprint = createHash('sha256').update(stableJson({ action, platformId, body })).digest('hex');
    const previous = repository.platformAction(idempotencyKey);
    if (previous) {
      if (previous.requestFingerprint !== fingerprint) return json(res, 409, { error: 'Idempotency-Key 已用于不同请求', code: 'IDEMPOTENCY_CONFLICT' });
      return json(res, 200, { ...previous.response, replayed: true });
    }
    if (!context.control) return json(res, 503, { error: 'Hermes 管理服务尚未配置', code: 'HERMES_UNAVAILABLE' });
    let catalog: HermesPlatformCatalog;
    try { catalog = await context.control.platforms(profile); }
    catch { return json(res, 503, { error: 'Hermes 管理服务当前不可达，禁止修改过期快照', code: 'HERMES_UNAVAILABLE' }); }
    const platform = catalog.platforms.find((candidate) => candidate.id === platformId);
    if (!platform) return json(res, 404, { error: 'Hermes 当前目录中不存在该消息渠道', code: 'PLATFORM_NOT_FOUND' });

    try {
      let response: Record<string, unknown>;
      let configuredFields: readonly string[] = [];
      let secretFingerprints: Readonly<Record<string, string>> = {};
      if (action === 'configure') {
        const normalized = normalizePlatformUpdate(body, platform.envVars.map((field) => field.key));
        configuredFields = Object.keys(normalized.env);
        secretFingerprints = Object.fromEntries(Object.entries(normalized.env)
          .map(([key, value]) => [key, createHash('sha256').update(value).digest('hex')]));
        const upstream = await context.control.configurePlatform(profile, platformId, normalized.upstream);
        response = { ok: upstream.ok === true, platform: platformId };
      } else {
        const upstream = await context.control.testPlatform(profile, platformId);
        response = {
          ok: upstream.ok === true,
          platform: platformId,
          state: typeof upstream.state === 'string' ? upstream.state.slice(0, 80) : 'unknown',
          message: upstream.ok === true ? '渠道连接测试成功' : '渠道连接测试未通过',
        };
      }
      const recorded = repository.recordPlatformAction({
        idempotencyKey,
        platformId,
        action,
        requestFingerprint: fingerprint,
        response,
        configuredFields,
        secretFingerprints,
        actorId: context.session.humanId,
        createdAt: now(),
      });
      return json(res, 200, { ...recorded.response, replayed: recorded.replayed });
    } catch (error) {
      if (error instanceof InvalidPlatformUpdateError) return json(res, 400, { error: error.message, code: 'INVALID_PLATFORM_UPDATE' });
      return json(res, 502, { error: 'Hermes 消息渠道操作失败', code: 'HERMES_OPERATION_FAILED' });
    }
  }

  const onboardingMatch = path.match(/^\/api\/messaging\/onboarding\/(telegram|whatsapp|weixin)(?:\/([^/]+))?(?:\/(apply))?$/u);
  if (!onboardingMatch) return false;
  if (!can(context.session, 'admin')) return json(res, 403, { error: '无管理消息渠道 onboarding 权限', code: 'FORBIDDEN' });
  if (!context.control) return json(res, 503, { error: 'Hermes 管理服务尚未配置', code: 'HERMES_UNAVAILABLE' });
  const platform = onboardingMatch[1]! as 'telegram' | 'whatsapp' | 'weixin';
  const segment = onboardingMatch[2] ? decodeURIComponent(onboardingMatch[2]) : undefined;
  const action = segment === 'start' ? 'start' : onboardingMatch[3] === 'apply' ? 'apply' : undefined;
  const pairingId = segment && segment !== 'start' ? segment : undefined;
  if ((action === 'start' && method !== 'POST') || (action === 'apply' && method !== 'POST')
    || (!action && !['GET', 'DELETE'].includes(method))) {
    return json(res, 405, { error: 'Onboarding 请求方法无效', code: 'METHOD_NOT_ALLOWED' });
  }
  let body: Record<string, unknown> | undefined;
  if (method === 'POST') {
    try { body = await readJsonObject(req); }
    catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : '请求体无效', code: 'INVALID_BODY' }); }
  }
  try {
    const response = await context.control.onboarding({
      profile,
      platform,
      method: method as 'GET' | 'POST' | 'DELETE',
      ...(pairingId ? { pairingId } : {}),
      ...(action ? { action } : {}),
      ...(body ? { body } : {}),
    });
    return json(res, 200, sanitizeOnboardingResponse(response));
  } catch (error) {
    if (error instanceof HermesUpstreamError && error.status === 404) {
      return json(res, 404, { error: '微信接入会话不存在', code: 'ONBOARDING_NOT_FOUND' });
    }
    if (error instanceof HermesUpstreamError && error.status === 410) {
      return json(res, 410, { error: '微信二维码已过期，请重新生成', code: 'ONBOARDING_EXPIRED' });
    }
    return json(res, 502, { error: 'Hermes 渠道引导操作失败', code: 'HERMES_ONBOARDING_FAILED' });
  }
}

class InvalidPlatformUpdateError extends Error {}

function normalizePlatformUpdate(body: Record<string, unknown>, allowedKeys: readonly string[]): {
  env: Record<string, string>;
  upstream: { enabled?: boolean; env: Record<string, string>; clear_env: string[] };
} {
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new InvalidPlatformUpdateError('enabled 必须是布尔值');
  if (body.env !== undefined && (!body.env || typeof body.env !== 'object' || Array.isArray(body.env))) {
    throw new InvalidPlatformUpdateError('env 必须是对象');
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries((body.env ?? {}) as Record<string, unknown>)) {
    if (!allowedKeys.includes(key)) throw new InvalidPlatformUpdateError(`${key} 不是该渠道允许的配置字段`);
    if (typeof value !== 'string' || !value.trim() || value.length > 8_192) throw new InvalidPlatformUpdateError(`${key} 配置值无效`);
    env[key] = value.trim();
  }
  const clearEnv = Array.isArray(body.clearEnv) ? body.clearEnv : [];
  if (!clearEnv.every((key): key is string => typeof key === 'string' && allowedKeys.includes(key))) {
    throw new InvalidPlatformUpdateError('clearEnv 包含该渠道不允许的字段');
  }
  return {
    env,
    upstream: {
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      env,
      clear_env: [...clearEnv],
    },
  };
}

function staleOrUnavailable(
  res: ServerResponse,
  repository: HermesRepository,
  message: string,
  session: Session,
): true {
  const snapshot = repository.latestPlatformSnapshot();
  if (!snapshot) return json(res, 503, { error: message, code: 'HERMES_UNAVAILABLE' });
  return json(res, 200, {
    ...snapshot.catalog,
    stale: true,
    capturedAt: snapshot.capturedAt,
    warning: 'Hermes 当前不可达，正在显示上次成功快照；所有修改操作已禁用。',
    permissions: { manage: can(session, 'admin') },
  });
}

function sanitizeOnboardingResponse(value: Record<string, unknown>): Record<string, unknown> {
  const allowed = ['ok', 'status', 'pairing_id', 'qr_payload', 'expires_at', 'bot_username', 'owner_user_id', 'account_name', 'account_phone', 'needs_restart'];
  return Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    allowed.includes(key) && (typeof item === 'string' || typeof item === 'boolean' || item === null)));
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > 32 * 1024) throw new Error('请求体过大');
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
