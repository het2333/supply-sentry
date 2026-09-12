const PROFILE_PATTERN = /^rw-[a-f0-9]{24}$/u;
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,95}$/u;

export interface HermesEnvironmentField {
  readonly key: string;
  readonly required: boolean;
  readonly isSet: boolean;
  readonly description: string;
  readonly prompt: string;
  readonly help: string;
  readonly url: string | null;
  readonly isPassword: boolean;
  readonly advanced: boolean;
}

export interface HermesPlatform {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly docsUrl: string;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly gatewayRunning: boolean;
  readonly state: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly updatedAt: string | null;
  readonly envVars: readonly HermesEnvironmentField[];
  readonly onboarding: 'telegram' | 'whatsapp' | 'weixin' | null;
}

export interface HermesPlatformCatalog {
  readonly platforms: readonly HermesPlatform[];
}

export interface HermesControlClientOptions {
  readonly baseUrl: string;
  readonly weixinOnboardingUrl?: string;
  readonly token: (refresh: boolean) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class HermesUpstreamError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'HERMES_UPSTREAM_ERROR',
  ) {
    super(message);
    this.name = 'HermesUpstreamError';
  }
}

export class HermesControlClient {
  private readonly baseUrl: URL;
  private readonly weixinOnboardingUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: HermesControlClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol)) throw new Error('Hermes 管理地址必须使用 HTTP 或 HTTPS');
    this.weixinOnboardingUrl = new URL(options.weixinOnboardingUrl ?? options.baseUrl);
    if (!['http:', 'https:'].includes(this.weixinOnboardingUrl.protocol)) throw new Error('Hermes 微信引导地址必须使用 HTTP 或 HTTPS');
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  }

  async platforms(profile: string): Promise<HermesPlatformCatalog> {
    this.assertProfile(profile);
    let payload: Record<string, unknown>;
    try {
      payload = await this.request('/api/messaging/platforms', { query: { profile } });
    } catch (error) {
      if (!(error instanceof HermesUpstreamError) || error.status !== 404) throw error;
      await this.ensureProfile(profile);
      payload = await this.request('/api/messaging/platforms', { query: { profile } });
    }
    const catalog = sanitizeCatalog(payload);
    if (!catalog.platforms.some((platform) => platform.configured && !platform.gatewayRunning)) return catalog;
    try {
      const status = await this.request('/api/status');
      return projectMultiplexCatalog(catalog, status, profile);
    } catch {
      return catalog;
    }
  }

  async configurePlatform(
    profile: string,
    platformId: string,
    body: { readonly enabled?: boolean; readonly env?: Readonly<Record<string, string>>; readonly clear_env?: readonly string[] },
  ): Promise<Record<string, unknown>> {
    this.assertProfile(profile);
    this.assertPlatform(platformId);
    return this.request(`/api/messaging/platforms/${encodeURIComponent(platformId)}`, {
      method: 'PUT',
      query: { profile },
      body,
    });
  }

  async testPlatform(profile: string, platformId: string): Promise<Record<string, unknown>> {
    this.assertProfile(profile);
    this.assertPlatform(platformId);
    const result = await this.request(`/api/messaging/platforms/${encodeURIComponent(platformId)}/test`, {
      method: 'POST',
      query: { profile },
    });
    if (result.ok === true) return result;
    try {
      const status = await this.request('/api/status');
      const runtime = multiplexPlatformState(status, profile, platformId);
      if (runtime?.state === 'connected') {
        return { ok: true, state: 'connected', message: '渠道已通过 Hermes 复用网关连接' };
      }
    } catch {
      // Preserve the authoritative platform-test failure if the owner status cannot be read.
    }
    return result;
  }

  async onboarding(input: {
    readonly profile: string;
    readonly platform: 'telegram' | 'whatsapp' | 'weixin';
    readonly method: 'GET' | 'POST' | 'DELETE';
    readonly pairingId?: string;
    readonly action?: 'start' | 'apply';
    readonly body?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    this.assertProfile(input.profile);
    const base = `/api/messaging/${input.platform}/onboarding`;
    let path: string;
    if (input.action === 'start' && !input.pairingId) path = `${base}/start`;
    else {
      if (!input.pairingId || !/^[A-Za-z0-9_-]{8,160}$/u.test(input.pairingId)) throw new Error('Hermes onboarding 会话标识无效');
      path = `${base}/${encodeURIComponent(input.pairingId)}${input.action === 'apply' ? '/apply' : ''}`;
    }
    return this.request(path, {
      method: input.method,
      query: { profile: input.profile },
      ...(input.platform === 'weixin' ? { baseUrl: this.weixinOnboardingUrl, timeoutMs: 45_000 } : {}),
      ...(input.body ? { body: input.body } : {}),
    });
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request('/api/health');
  }

  async detailedHealth(): Promise<Record<string, unknown>> {
    return this.request('/api/status');
  }

  private assertProfile(profile: string): void {
    if (!PROFILE_PATTERN.test(profile)) throw new Error('Hermes profile 标识无效');
  }

  private assertPlatform(platformId: string): void {
    if (!PLATFORM_PATTERN.test(platformId)) throw new Error('Hermes 平台标识无效');
  }

  private async ensureProfile(profile: string): Promise<void> {
    try {
      await this.request('/api/profiles', {
        method: 'POST',
        body: {
          name: profile,
          no_skills: true,
          description: 'Readywork 租户消息渠道隔离配置',
        },
      });
    } catch (error) {
      if (!(error instanceof HermesUpstreamError) || ![400, 409].includes(error.status)) throw error;
    }
  }

  private async request(
    path: string,
    input: {
      readonly method?: string;
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
      readonly baseUrl?: URL;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    let lastStatus = 502;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.options.token(attempt === 1);
      if (!token) throw new HermesUpstreamError('Hermes 服务凭据未配置', 503, 'HERMES_UNCONFIGURED');
      const url = new URL(path, input.baseUrl ?? this.baseUrl);
      for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Hermes 请求超时'));
      }, input.timeoutMs ?? this.timeoutMs);
      try {
        const response = await this.fetcher(url, {
          method: input.method ?? 'GET',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'X-Hermes-Session-Token': token,
          },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          signal: controller.signal,
        });
        lastStatus = response.status;
        if (response.status === 401 && attempt === 0) continue;
        const payload = await this.readJson(response);
        if (!response.ok) {
          const detail = typeof payload.detail === 'string' ? payload.detail : 'Hermes 管理服务请求失败';
          throw new HermesUpstreamError(redactOperationalError(detail), response.status, 'HERMES_HTTP_ERROR');
        }
        return payload;
      } catch (error) {
        if (error instanceof HermesUpstreamError) throw error;
        if (timedOut || controller.signal.aborted) {
          throw new HermesUpstreamError('Hermes 管理服务请求超时', 504, 'HERMES_TIMEOUT');
        }
        throw new HermesUpstreamError('无法连接 Hermes 管理服务', 503, 'HERMES_UNREACHABLE');
      } finally {
        clearTimeout(timer);
      }
    }
    throw new HermesUpstreamError('Hermes 服务凭据刷新后仍未授权', lastStatus, 'HERMES_UNAUTHORIZED');
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      throw new HermesUpstreamError('Hermes 响应体过大', 502, 'HERMES_RESPONSE_TOO_LARGE');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > this.maxResponseBytes) {
      throw new HermesUpstreamError('Hermes 响应体过大', 502, 'HERMES_RESPONSE_TOO_LARGE');
    }
    try {
      const parsed = JSON.parse(buffer.toString('utf8') || '{}') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      return parsed as Record<string, unknown>;
    } catch {
      throw new HermesUpstreamError('Hermes 返回了无效 JSON 响应', 502, 'HERMES_INVALID_RESPONSE');
    }
  }
}

function sanitizeCatalog(payload: Record<string, unknown>): HermesPlatformCatalog {
  if (!Array.isArray(payload.platforms)) {
    throw new HermesUpstreamError('Hermes 平台目录响应缺少 platforms', 502, 'HERMES_INVALID_CATALOG');
  }
  const platforms = payload.platforms
    .map(sanitizePlatform)
    .filter((platform): platform is HermesPlatform => platform !== null && platform.id !== 'readywork_bridge');
  return { platforms };
}

function projectMultiplexCatalog(
  catalog: HermesPlatformCatalog,
  status: Record<string, unknown>,
  profile: string,
): HermesPlatformCatalog {
  if (status.gateway_mode !== 'multiplex' || status.gateway_running !== true) return catalog;
  const runtime = status.gateway_platforms;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return catalog;
  const gatewayPlatforms = runtime as Record<string, unknown>;
  return {
    platforms: catalog.platforms.map((platform) => {
      const value = gatewayPlatforms[`${profile}:${platform.id}`];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ...platform, gatewayRunning: true };
      }
      const state = value as Record<string, unknown>;
      return {
        ...platform,
        gatewayRunning: true,
        state: stringOrEmpty(state.state).slice(0, 80) || platform.state,
        errorCode: nullableString(state.error_code, 120),
        errorMessage: nullableString(state.error_message, 1_000),
        updatedAt: nullableString(state.updated_at, 80),
      };
    }),
  };
}

function multiplexPlatformState(
  status: Record<string, unknown>,
  profile: string,
  platformId: string,
): Record<string, unknown> | null {
  if (status.gateway_mode !== 'multiplex' || status.gateway_running !== true) return null;
  const runtime = status.gateway_platforms;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return null;
  const value = (runtime as Record<string, unknown>)[`${profile}:${platformId}`];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sanitizePlatform(value: unknown): HermesPlatform | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HermesUpstreamError('Hermes 平台目录包含无效条目', 502, 'HERMES_INVALID_CATALOG');
  }
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !PLATFORM_PATTERN.test(item.id) || typeof item.name !== 'string') {
    throw new HermesUpstreamError('Hermes 平台目录包含无效标识', 502, 'HERMES_INVALID_CATALOG');
  }
  if (!Array.isArray(item.env_vars)) {
    throw new HermesUpstreamError('Hermes 平台目录包含无效配置字段', 502, 'HERMES_INVALID_CATALOG');
  }
  const envVars = item.env_vars.map((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field)) throw new HermesUpstreamError('Hermes 配置字段无效');
    const row = field as Record<string, unknown>;
    if (typeof row.key !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(row.key)) {
      throw new HermesUpstreamError('Hermes 配置字段标识无效');
    }
    return {
      key: row.key,
      required: row.required === true,
      isSet: row.is_set === true,
      description: stringOrEmpty(row.description),
      prompt: stringOrEmpty(row.prompt),
      help: stringOrEmpty(row.help),
      url: safeHttpUrl(row.url),
      isPassword: row.is_password === true,
      advanced: row.advanced === true,
    };
  });
  return {
    id: item.id,
    name: item.name.slice(0, 160),
    description: stringOrEmpty(item.description).slice(0, 2_000),
    docsUrl: safeHttpUrl(item.docs_url) ?? '',
    enabled: item.enabled === true,
    configured: item.configured === true,
    gatewayRunning: item.gateway_running === true,
    state: stringOrEmpty(item.state).slice(0, 80) || 'unknown',
    errorCode: nullableString(item.error_code, 120),
    errorMessage: nullableString(item.error_message, 1_000),
    updatedAt: nullableString(item.updated_at, 80),
    envVars,
    onboarding: item.id === 'telegram' || item.id === 'whatsapp' || item.id === 'weixin' ? item.id : null,
  };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value ? redactOperationalError(value).slice(0, maxLength) : null;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function redactOperationalError(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[已隐藏]')
    .replace(/\b(token|secret|password|authorization)\s*[:=]\s*\S+/giu, '$1=[已隐藏]')
    .replace(/(?:\/[^\s/]+){2,}/gu, '[内部路径]');
}
