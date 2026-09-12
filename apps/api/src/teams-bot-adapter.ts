import { createHash, createPublicKey, createVerify } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CollaborationAction, CollaborationActionResult, CollaborationActor, CollaborationControlPlane } from './collaboration-channels.js';
import { redactSensitive, redactSensitiveValue } from './http-errors.js';
import { recordSecurityEvent } from './production-operations.js';

const DEFAULT_SERVICE_URL_HOSTS = ['smba.trafficmanager.net', 'smba.infra.teams.microsoft.com'];

export interface TeamsBotConfiguration {
  appId: string;
  /** Required only for proactive delivery; inbound JWT validation still works without it. */
  appSecret?: string;
  issuer: string;
  jwksUrl: string;
  oauthTokenUrl?: string;
  oauthScope?: string;
  allowedServiceUrlHosts?: readonly string[];
  requestTimeoutMs?: number;
  clockSkewSeconds?: number;
}

export interface TeamsIdentityBinding {
  teamsTenantId: string;
  aadObjectId: string;
  readyworkTenantId: string;
  readyworkHumanId: string;
  updatedAt: string;
}

export interface TeamsConversationReference extends TeamsIdentityBinding {
  conversationId: string;
  serviceUrl: string;
  botId?: string;
  channelId?: string;
  updatedAt: string;
}

export interface BotFrameworkActivity {
  id?: string;
  type?: string;
  channelId?: string;
  serviceUrl?: string;
  from?: { id?: string; aadObjectId?: string };
  recipient?: { id?: string };
  conversation?: { id?: string; tenantId?: string };
  text?: string;
  value?: Record<string, unknown>;
}

export interface VerifiedBotFrameworkClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  tid?: string;
  oid?: string;
  [key: string]: unknown;
}

export interface TeamsBotAdapterOptions {
  db: DatabaseSync;
  config?: TeamsBotConfiguration;
  collaboration: CollaborationControlPlane;
  /** Resolve the current Readywork actor/role from the authoritative identity store. */
  resolveActor: (readyworkTenantId: string, readyworkHumanId: string) => CollaborationActor | undefined | Promise<CollaborationActor | undefined>;
  /** Execute an explicitly phrased approval command against the authoritative workflow store. */
  handleNaturalLanguageApproval?: (actor: CollaborationActor, input: TeamsNaturalLanguageApprovalInput) => Promise<TeamsApprovalResult>;
  fetch?: typeof fetch;
  now?: () => number;
}

export type TeamsInboundResult =
  | { status: 'processed'; result: CollaborationActionResult | TeamsApprovalResult; replayed: boolean }
  | { status: 'unavailable' | 'rejected' | 'failed'; code: string; error: string };

export type TeamsDeliveryResult =
  | { status: 'sent'; activityId?: string }
  | { status: 'unavailable' | 'failed'; code: string; error: string };

export interface TeamsNaturalLanguageApprovalInput {
  approvalId: string;
  decision: 'approved' | 'rejected';
  reason?: string;
  idempotencyKey: string;
}

export type TeamsApprovalResult =
  | { ok: true; approvalId: string; taskId: string; decision: 'approved' | 'rejected'; taskStatus: string; replayed: boolean }
  | { ok: false; code: string; error: string };

interface JwtHeader { alg?: string; kid?: string; typ?: string; }
interface Jwk { kty?: string; kid?: string; n?: string; e?: string; use?: string; alg?: string; [key: string]: unknown; }
interface Jwks { keys?: Jwk[]; }
interface CachedJwks { keys: Jwk[]; expiresAt: number; }
interface CachedBotToken { token: string; expiresAt: number; }
interface ActivityClaim { kind: 'owner' | 'replayed' | 'processing' | 'conflict'; response?: TeamsInboundResult; }

export class TeamsAdapterError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** The schema lives with the adapter so it can be applied independently of the core persistence package. */
export function initializeTeamsBotSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams_identity_bindings (
      teams_tenant_id TEXT NOT NULL,
      aad_object_id TEXT NOT NULL,
      readywork_tenant_id TEXT NOT NULL,
      readywork_human_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (teams_tenant_id, aad_object_id)
    );
    CREATE INDEX IF NOT EXISTS idx_teams_identity_readywork ON teams_identity_bindings (readywork_tenant_id, readywork_human_id);
    CREATE TABLE IF NOT EXISTS teams_conversation_references (
      teams_tenant_id TEXT NOT NULL,
      aad_object_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      service_url TEXT NOT NULL,
      bot_id TEXT,
      channel_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (teams_tenant_id, aad_object_id, conversation_id),
      FOREIGN KEY (teams_tenant_id, aad_object_id) REFERENCES teams_identity_bindings(teams_tenant_id, aad_object_id)
    );
    CREATE INDEX IF NOT EXISTS idx_teams_conversation_readywork ON teams_conversation_references (teams_tenant_id, aad_object_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS teams_inbound_activities (
      teams_tenant_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      response_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (teams_tenant_id, activity_id)
    );
  `);
}

export function upsertTeamsIdentityBinding(db: DatabaseSync, input: Omit<TeamsIdentityBinding, 'updatedAt'> & { updatedAt?: string }): TeamsIdentityBinding {
  initializeTeamsBotSchema(db);
  const binding = {
    teamsTenantId: requiredText(input.teamsTenantId, 'teamsTenantId'),
    aadObjectId: requiredText(input.aadObjectId, 'aadObjectId'),
    readyworkTenantId: requiredText(input.readyworkTenantId, 'readyworkTenantId'),
    readyworkHumanId: requiredText(input.readyworkHumanId, 'readyworkHumanId'),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
  db.prepare(`INSERT INTO teams_identity_bindings (teams_tenant_id,aad_object_id,readywork_tenant_id,readywork_human_id,updated_at)
    VALUES (?,?,?,?,?) ON CONFLICT(teams_tenant_id,aad_object_id) DO UPDATE SET readywork_tenant_id=excluded.readywork_tenant_id,readywork_human_id=excluded.readywork_human_id,updated_at=excluded.updated_at`)
    .run(binding.teamsTenantId, binding.aadObjectId, binding.readyworkTenantId, binding.readyworkHumanId, binding.updatedAt);
  return binding;
}

export function findTeamsIdentityBinding(db: DatabaseSync, teamsTenantId: string, aadObjectId: string): TeamsIdentityBinding | undefined {
  initializeTeamsBotSchema(db);
  const row = db.prepare('SELECT teams_tenant_id,aad_object_id,readywork_tenant_id,readywork_human_id,updated_at FROM teams_identity_bindings WHERE teams_tenant_id=? AND aad_object_id=?')
    .get(teamsTenantId, aadObjectId) as { teams_tenant_id: string; aad_object_id: string; readywork_tenant_id: string; readywork_human_id: string; updated_at: string } | undefined;
  return row ? { teamsTenantId: row.teams_tenant_id, aadObjectId: row.aad_object_id, readyworkTenantId: row.readywork_tenant_id, readyworkHumanId: row.readywork_human_id, updatedAt: row.updated_at } : undefined;
}

export function listTeamsConversationReferences(db: DatabaseSync, readyworkTenantId: string, readyworkHumanId: string): TeamsConversationReference[] {
  initializeTeamsBotSchema(db);
  const rows = db.prepare(`SELECT b.teams_tenant_id,b.aad_object_id,b.readywork_tenant_id,b.readywork_human_id,r.conversation_id,r.service_url,r.bot_id,r.channel_id,r.updated_at
    FROM teams_identity_bindings b JOIN teams_conversation_references r ON r.teams_tenant_id=b.teams_tenant_id AND r.aad_object_id=b.aad_object_id
    WHERE b.readywork_tenant_id=? AND b.readywork_human_id=? ORDER BY r.updated_at DESC`).all(readyworkTenantId, readyworkHumanId) as Array<Record<string, string | null>>;
  return rows.map((row) => ({
    teamsTenantId: String(row['teams_tenant_id']), aadObjectId: String(row['aad_object_id']), readyworkTenantId: String(row['readywork_tenant_id']), readyworkHumanId: String(row['readywork_human_id']),
    conversationId: String(row['conversation_id']), serviceUrl: String(row['service_url']), ...(row['bot_id'] ? { botId: String(row['bot_id']) } : {}), ...(row['channel_id'] ? { channelId: String(row['channel_id']) } : {}), updatedAt: String(row['updated_at']),
  }));
}

/**
 * Production Bot Framework adapter.  It is intentionally an adapter class,
 * not an HTTP route: the host must authenticate the HTTP request and map it to
 * this API without granting card data any authority.
 */
export class TeamsBotFrameworkAdapter {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private jwks?: CachedJwks;
  private botToken?: CachedBotToken;

  constructor(private readonly options: TeamsBotAdapterOptions) {
    initializeTeamsBotSchema(options.db);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async handleInboundActivity(authorization: string | undefined, activity: BotFrameworkActivity): Promise<TeamsInboundResult> {
    const config = this.options.config;
    if (!config) return { status: 'unavailable', code: 'TEAMS_UNAVAILABLE', error: 'Teams Bot 未配置' };
    let claimedActivity: { teamsTenantId: string; activityId: string } | undefined;
    try {
      const claims = await this.verifyBotFrameworkJwt(authorization);
      // Bot Framework Connector token authenticates Microsoft/Bot Service itself;
      // production tokens do not necessarily carry the end user's oid/tid. Once the
      // connector JWT is verified, the Activity envelope is the authenticated channel
      // assertion. If claims do include tid/oid, require them to agree as defense-in-depth.
      const claimTenantId = claimText(claims, ['tid', 'http://schemas.microsoft.com/identity/claims/tenantid']);
      const claimObjectId = claimText(claims, ['oid', 'http://schemas.microsoft.com/identity/claims/objectidentifier']);
      const teamsTenantId = requiredText(activity.conversation?.tenantId ?? claimTenantId, 'conversation.tenantId');
      const aadObjectId = requiredText(activity.from?.aadObjectId ?? claimObjectId, 'from.aadObjectId');
      if (claimTenantId && claimTenantId !== teamsTenantId) throw new TeamsAdapterError('TEAMS_IDENTITY_MISMATCH', 'Activity 租户与验证后的身份不一致');
      if (claimObjectId && claimObjectId !== aadObjectId) throw new TeamsAdapterError('TEAMS_IDENTITY_MISMATCH', 'Activity 用户与验证后的身份不一致');
      const binding = findTeamsIdentityBinding(this.options.db, teamsTenantId, aadObjectId);
      if (!binding) return { status: 'unavailable', code: 'TEAMS_IDENTITY_UNBOUND', error: 'Teams 身份尚未绑定 Readywork 用户' };
      const actor = await this.options.resolveActor(binding.readyworkTenantId, binding.readyworkHumanId);
      if (!actor || actor.tenantId !== binding.readyworkTenantId || actor.humanId !== binding.readyworkHumanId) {
        return { status: 'unavailable', code: 'READYWORK_IDENTITY_UNAVAILABLE', error: 'Readywork 用户身份不可用' };
      }
      this.saveConversationReference(teamsTenantId, aadObjectId, activity);
      const activityId = requiredText(activity.id, 'activity.id');
      const claim = this.claimActivity(teamsTenantId, activityId, activity);
      if (claim.kind === 'replayed') return claim.response!.status === 'processed' ? { ...claim.response!, replayed: true } : claim.response!;
      if (claim.kind === 'processing') return { status: 'failed', code: 'TEAMS_ACTIVITY_IN_PROGRESS', error: '该 Teams 动作正在处理中' };
      if (claim.kind === 'conflict') return { status: 'rejected', code: 'TEAMS_ACTIVITY_REUSED', error: '相同 Activity ID 的载荷不一致' };
      claimedActivity = { teamsTenantId, activityId };
      const result = activity.value && typeof activity.value['action'] === 'string'
        ? await this.options.collaboration.handleTeamsAction(actor, parseAction(activity.value, activityId))
        : await this.handleNaturalLanguageApproval(actor, activity, activityId);
      if (!result.ok && (result.code.endsWith('_FORBIDDEN') || result.code === 'TEAMS_ACTION_INVALID')) {
        recordSecurityEvent(this.options.db, {
          tenantId: actor.tenantId, eventType: 'authorization_denied', severity: 'warning', requestId: activityId,
          method: 'POST', path: '/api/collaboration/teams/activities', actorId: actor.humanId,
          message: `Teams 动作被拒绝: ${result.code}`,
        });
      }
      const response: TeamsInboundResult = { status: 'processed', result: redactSensitiveValue(result) as CollaborationActionResult | TeamsApprovalResult, replayed: false };
      this.finishActivity(teamsTenantId, activityId, response);
      return response;
    } catch (error) {
      if (claimedActivity) this.failActivity(claimedActivity.teamsTenantId, claimedActivity.activityId);
      const code = error instanceof TeamsAdapterError ? error.code : 'TEAMS_ACTIVITY_FAILED';
      return { status: 'rejected', code, error: publicTeamsError(error) };
    }
  }

  private async handleNaturalLanguageApproval(actor: CollaborationActor, activity: BotFrameworkActivity, activityId: string): Promise<TeamsApprovalResult> {
    const command = parseNaturalLanguageApproval(activity.text);
    if (!command) return { ok: false, code: 'TEAMS_APPROVAL_COMMAND_INVALID', error: '请使用“批准 <审批ID>”或“拒绝 <审批ID> <原因>”' };
    if (!this.options.handleNaturalLanguageApproval) {
      return { ok: false, code: 'TEAMS_APPROVAL_UNAVAILABLE', error: 'Teams 自然语言审批未配置' };
    }
    return this.options.handleNaturalLanguageApproval(actor, { ...command, idempotencyKey: `teams:${activityId}` });
  }

  async sendProactiveTaskNotification(recipient: CollaborationActor, taskId: string): Promise<TeamsDeliveryResult> {
    const config = this.options.config;
    if (!config?.appSecret) return { status: 'unavailable', code: 'TEAMS_UNAVAILABLE', error: 'Teams Bot 主动通知未配置' };
    const notification = this.options.collaboration.prepareTeamsNotification(recipient, taskId);
    if (notification.status !== 'queued' || !notification.payload) return { status: 'unavailable', code: notification.code, error: notification.error ?? 'Teams 通知不可用' };
    const reference = listTeamsConversationReferences(this.options.db, recipient.tenantId, recipient.humanId)[0];
    if (!reference) return { status: 'unavailable', code: 'TEAMS_CONVERSATION_UNAVAILABLE', error: '该 Readywork 用户没有已验证的 Teams 会话引用' };
    if (!this.trustedServiceUrl(reference.serviceUrl)) return { status: 'unavailable', code: 'TEAMS_SERVICE_URL_UNTRUSTED', error: 'Teams 会话服务地址不受信任' };
    try {
      const accessToken = await this.getBotAccessToken();
      const endpoint = new URL(`/v3/conversations/${encodeURIComponent(reference.conversationId)}/activities`, reference.serviceUrl).toString();
      const response = await this.request(endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: notification.payload.adaptiveCard }] }),
      });
      if (!response.ok) return { status: 'failed', code: 'TEAMS_DELIVERY_FAILED', error: `Teams 主动通知失败（HTTP ${response.status}）` };
      let activityId: string | undefined;
      try { const body = await response.json() as { id?: unknown }; if (typeof body.id === 'string') activityId = body.id; } catch { /* a successful response need not contain JSON */ }
      return { status: 'sent', ...(activityId ? { activityId } : {}) };
    } catch (error) {
      return { status: 'failed', code: error instanceof TeamsAdapterError ? error.code : 'TEAMS_DELIVERY_FAILED', error: publicTeamsError(error) };
    }
  }

  async verifyBotFrameworkJwt(authorization: string | undefined): Promise<VerifiedBotFrameworkClaims> {
    const config = this.requireConfig();
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new TeamsAdapterError('TEAMS_AUTH_INVALID', '缺少 Bot Framework Bearer token');
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new TeamsAdapterError('TEAMS_AUTH_INVALID', 'Bot Framework token 格式无效');
    const header = parseBase64Json<JwtHeader>(parts[0], 'JWT header');
    const claims = parseBase64Json<VerifiedBotFrameworkClaims>(parts[1], 'JWT claims');
    if (header.alg !== 'RS256' || !header.kid) throw new TeamsAdapterError('TEAMS_AUTH_INVALID', 'Bot Framework token 算法或 kid 无效');
    if (claims.iss !== config.issuer || !audienceIncludes(claims.aud, config.appId)) throw new TeamsAdapterError('TEAMS_AUTH_INVALID', 'Bot Framework token issuer 或 audience 无效');
    const nowSeconds = Math.floor(this.now() / 1000);
    const skew = Math.min(Math.max(config.clockSkewSeconds ?? 60, 0), 300);
    if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds - skew) throw new TeamsAdapterError('TEAMS_AUTH_EXPIRED', 'Bot Framework token 已过期');
    if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + skew)) throw new TeamsAdapterError('TEAMS_AUTH_NOT_ACTIVE', 'Bot Framework token 尚未生效');
    let jwk = (await this.jwksFor(config)).find((item) => item.kid === header.kid && item.kty === 'RSA' && item.n && item.e);
    // Key rotation can happen before Cache-Control expires; refresh once for a new kid.
    if (!jwk && this.jwks) {
      this.jwks = undefined;
      jwk = (await this.jwksFor(config)).find((item) => item.kid === header.kid && item.kty === 'RSA' && item.n && item.e);
    }
    if (!jwk) throw new TeamsAdapterError('TEAMS_AUTH_KEY_UNKNOWN', 'Bot Framework token kid 未在 JWKS 中发布');
    try {
      // node:crypto accepts a JWK here; the local Jwk shape is validated above.
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${parts[0]}.${parts[1]}`);
      verifier.end();
      if (!verifier.verify(key, Buffer.from(parts[2], 'base64url'))) throw new TeamsAdapterError('TEAMS_AUTH_INVALID', 'Bot Framework token 签名无效');
    } catch (error) {
      if (error instanceof TeamsAdapterError) throw error;
      throw new TeamsAdapterError('TEAMS_AUTH_INVALID', 'Bot Framework token 签名无效');
    }
    return claims;
  }

  private requireConfig(): TeamsBotConfiguration {
    if (!this.options.config) throw new TeamsAdapterError('TEAMS_UNAVAILABLE', 'Teams Bot 未配置');
    const config = this.options.config;
    if (!config.appId || !config.issuer || !config.jwksUrl) throw new TeamsAdapterError('TEAMS_UNAVAILABLE', 'Teams Bot JWT 配置不完整');
    return config;
  }

  private async jwksFor(config: TeamsBotConfiguration): Promise<Jwk[]> {
    if (this.jwks && this.jwks.expiresAt > this.now()) return this.jwks.keys;
    let response: Response;
    try { response = await this.request(config.jwksUrl, { headers: { accept: 'application/json' } }); }
    catch (error) { throw new TeamsAdapterError('TEAMS_JWKS_UNAVAILABLE', redactSensitive(error)); }
    if (!response.ok) throw new TeamsAdapterError('TEAMS_JWKS_UNAVAILABLE', `JWKS 请求失败（HTTP ${response.status}）`);
    let body: Jwks;
    try { body = await response.json() as Jwks; } catch { throw new TeamsAdapterError('TEAMS_JWKS_INVALID', 'JWKS 响应不是有效 JSON'); }
    if (!Array.isArray(body.keys) || body.keys.length === 0) throw new TeamsAdapterError('TEAMS_JWKS_INVALID', 'JWKS 未包含公钥');
    const ttlSeconds = cacheMaxAge(response.headers.get('cache-control')) ?? 3_600;
    this.jwks = { keys: body.keys, expiresAt: this.now() + Math.min(Math.max(ttlSeconds, 60), 86_400) * 1_000 };
    return body.keys;
  }

  private async getBotAccessToken(): Promise<string> {
    const config = this.requireConfig();
    if (!config.appSecret) throw new TeamsAdapterError('TEAMS_UNAVAILABLE', 'Teams Bot 主动通知未配置');
    if (this.botToken && this.botToken.expiresAt > this.now() + 60_000) return this.botToken.token;
    const tokenUrl = config.oauthTokenUrl ?? 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
    const body = new URLSearchParams({ client_id: config.appId, client_secret: config.appSecret, grant_type: 'client_credentials', scope: config.oauthScope ?? 'https://api.botframework.com/.default' });
    let response: Response;
    try { response = await this.request(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }); }
    catch (error) { throw new TeamsAdapterError('TEAMS_OAUTH_UNAVAILABLE', redactSensitive(error)); }
    if (!response.ok) throw new TeamsAdapterError('TEAMS_OAUTH_FAILED', `Teams OAuth 请求失败（HTTP ${response.status}）`);
    let value: { access_token?: unknown; expires_in?: unknown };
    try { value = await response.json() as { access_token?: unknown; expires_in?: unknown }; } catch { throw new TeamsAdapterError('TEAMS_OAUTH_FAILED', 'Teams OAuth 响应无效'); }
    if (typeof value.access_token !== 'string' || !value.access_token) throw new TeamsAdapterError('TEAMS_OAUTH_FAILED', 'Teams OAuth 未返回 access token');
    const expiresIn = typeof value.expires_in === 'number' && Number.isFinite(value.expires_in) ? value.expires_in : 3_600;
    this.botToken = { token: value.access_token, expiresAt: this.now() + Math.max(60, Math.min(expiresIn, 86_400)) * 1_000 };
    return value.access_token;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const timeoutMs = Math.min(Math.max(this.options.config?.requestTimeoutMs ?? 8_000, 1_000), 30_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await this.fetcher(url, { ...init, signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new TeamsAdapterError('TEAMS_TIMEOUT', 'Teams 请求超时');
      throw error;
    } finally { clearTimeout(timer); }
  }

  private saveConversationReference(teamsTenantId: string, aadObjectId: string, activity: BotFrameworkActivity): void {
    const conversationId = requiredText(activity.conversation?.id, 'conversation.id');
    const serviceUrl = requiredText(activity.serviceUrl, 'serviceUrl');
    if (!this.trustedServiceUrl(serviceUrl)) throw new TeamsAdapterError('TEAMS_SERVICE_URL_UNTRUSTED', 'Teams Activity serviceUrl 不受信任');
    const now = new Date(this.now()).toISOString();
    this.options.db.prepare(`INSERT INTO teams_conversation_references (teams_tenant_id,aad_object_id,conversation_id,service_url,bot_id,channel_id,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(teams_tenant_id,aad_object_id,conversation_id) DO UPDATE SET service_url=excluded.service_url,bot_id=excluded.bot_id,channel_id=excluded.channel_id,updated_at=excluded.updated_at`)
      .run(teamsTenantId, aadObjectId, conversationId, serviceUrl, activity.recipient?.id ?? null, activity.channelId ?? null, now);
  }

  private trustedServiceUrl(serviceUrl: string): boolean {
    try {
      const url = new URL(serviceUrl);
      const allowed = this.options.config?.allowedServiceUrlHosts ?? DEFAULT_SERVICE_URL_HOSTS;
      return url.protocol === 'https:' && allowed.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    } catch { return false; }
  }

  private claimActivity(teamsTenantId: string, activityId: string, activity: BotFrameworkActivity): ActivityClaim {
    const hash = createHash('sha256').update(stableJson({ type: activity.type, conversationId: activity.conversation?.id, text: activity.text, value: activity.value })).digest('hex');
    const now = new Date(this.now()).toISOString();
    this.options.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.options.db.prepare('SELECT payload_hash,status,response_json FROM teams_inbound_activities WHERE teams_tenant_id=? AND activity_id=?').get(teamsTenantId, activityId) as { payload_hash: string; status: string; response_json: string | null } | undefined;
      if (existing) {
        if (existing.payload_hash !== hash) { this.options.db.exec('COMMIT'); return { kind: 'conflict' }; }
        if (existing.status === 'succeeded' && existing.response_json) { this.options.db.exec('COMMIT'); return { kind: 'replayed', response: JSON.parse(existing.response_json) as TeamsInboundResult }; }
        if (existing.status === 'processing') { this.options.db.exec('COMMIT'); return { kind: 'processing' }; }
        this.options.db.prepare("UPDATE teams_inbound_activities SET status='processing',response_json=NULL,updated_at=? WHERE teams_tenant_id=? AND activity_id=? AND status='failed'").run(now, teamsTenantId, activityId);
        this.options.db.exec('COMMIT');
        return { kind: 'owner' };
      }
      this.options.db.prepare("INSERT INTO teams_inbound_activities (teams_tenant_id,activity_id,payload_hash,status,response_json,updated_at) VALUES (?,?,?,'processing',NULL,?)").run(teamsTenantId, activityId, hash, now);
      this.options.db.exec('COMMIT');
      return { kind: 'owner' };
    } catch (error) {
      try { this.options.db.exec('ROLLBACK'); } catch { /* no transaction to roll back */ }
      throw error;
    }
  }

  private finishActivity(teamsTenantId: string, activityId: string, response: TeamsInboundResult): void {
    this.options.db.prepare("UPDATE teams_inbound_activities SET status='succeeded',response_json=?,updated_at=? WHERE teams_tenant_id=? AND activity_id=? AND status='processing'")
      .run(JSON.stringify(response), new Date(this.now()).toISOString(), teamsTenantId, activityId);
  }

  private failActivity(teamsTenantId: string, activityId: string): void {
    this.options.db.prepare("UPDATE teams_inbound_activities SET status='failed',updated_at=? WHERE teams_tenant_id=? AND activity_id=? AND status='processing'")
      .run(new Date(this.now()).toISOString(), teamsTenantId, activityId);
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 1_000) throw new TeamsAdapterError('TEAMS_ACTIVITY_INVALID', `${field} 无效`);
  return value.trim();
}

function parseAction(value: Record<string, unknown> | undefined, activityId: string): { taskId: string; action: CollaborationAction; idempotencyKey: string; teamsActionToken: string; assigneeHumanId?: string; assigneeRole?: string; confirmationToken?: string } {
  if (!value || typeof value !== 'object') throw new TeamsAdapterError('TEAMS_ACTIVITY_INVALID', 'Teams Activity 缺少动作数据');
  const action = value['action'];
  if (action !== 'accept' && action !== 'dismiss' && action !== 'reassign') throw new TeamsAdapterError('TEAMS_ACTIVITY_INVALID', 'Teams 动作无效');
  return {
    taskId: requiredText(value['taskId'], 'taskId'), action, idempotencyKey: typeof value['idempotencyKey'] === 'string' && value['idempotencyKey'].trim() ? value['idempotencyKey'].trim() : `teams:${activityId}`,
    teamsActionToken: requiredText(value['teamsActionToken'], 'teamsActionToken'),
    ...(typeof value['assigneeHumanId'] === 'string' ? { assigneeHumanId: value['assigneeHumanId'] } : {}), ...(typeof value['assigneeRole'] === 'string' ? { assigneeRole: value['assigneeRole'] } : {}), ...(typeof value['confirmationToken'] === 'string' ? { confirmationToken: value['confirmationToken'] } : {}),
  };
}

export function parseNaturalLanguageApproval(text: string | undefined): Omit<TeamsNaturalLanguageApprovalInput, 'idempotencyKey'> | undefined {
  if (typeof text !== 'string' || text.length > 1_000) return undefined;
  const match = text.trim().match(/^(批准|同意|通过|拒绝|驳回)\s*(?:审批)?\s*([A-Za-z0-9:_-]+)(?:\s+(.+))?$/);
  if (!match) return undefined;
  const decision = ['拒绝', '驳回'].includes(match[1]!) ? 'rejected' as const : 'approved' as const;
  const reason = match[3]?.trim();
  return {
    approvalId: match[2]!, decision,
    ...(decision === 'rejected' && reason ? { reason: reason.replace(/^原因[:：]?\s*/, '') } : {}),
  };
}

function parseBase64Json<T>(value: string, label: string): T {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as T;
  } catch { throw new TeamsAdapterError('TEAMS_AUTH_INVALID', `${label} 无效`); }
}

function audienceIncludes(aud: string | string[], expected: string): boolean { return typeof aud === 'string' ? aud === expected : Array.isArray(aud) && aud.includes(expected); }
function claimText(claims: VerifiedBotFrameworkClaims, names: string[]): string | undefined { for (const name of names) if (typeof claims[name] === 'string' && claims[name].trim()) return claims[name].trim(); return undefined; }
function cacheMaxAge(header: string | null): number | undefined { const match = header?.match(/max-age=(\d+)/i); return match ? Number(match[1]) : undefined; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
function publicTeamsError(error: unknown): string {
  const safe = redactSensitive(error).toLowerCase();
  if (error instanceof TeamsAdapterError && error.code === 'TEAMS_TIMEOUT' || /timeout|timed out|abort/.test(safe)) return 'Teams 服务请求超时';
  return 'Teams 请求被拒绝或处理失败';
}
