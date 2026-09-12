import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HermesControlClient,
  HermesUpstreamError,
} from '../src/messaging/hermes-control-client.js';

const catalogPayload = {
  env_path: '/private/hermes/.env',
  gateway_start_command: 'hermes gateway start --profile rw-secret',
  platforms: [
    {
      id: 'telegram',
      name: 'Telegram',
      description: 'Run Hermes from Telegram.',
      docs_url: 'https://core.telegram.org/bots/',
      enabled: false,
      configured: false,
      gateway_running: true,
      state: 'not_configured',
      error_code: null,
      error_message: null,
      updated_at: null,
      home_channel: null,
      env_vars: [{
        key: 'TELEGRAM_BOT_TOKEN',
        required: true,
        is_set: true,
        redacted_value: '123***secret',
        description: 'Bot token',
        prompt: 'Token',
        help: '',
        url: null,
        is_password: true,
        advanced: false,
      }],
    },
    {
      id: 'readywork_bridge',
      name: 'Readywork Bridge',
      description: 'internal',
      docs_url: '',
      enabled: true,
      configured: true,
      gateway_running: true,
      state: 'connected',
      error_code: null,
      error_message: null,
      updated_at: null,
      home_channel: null,
      env_vars: [],
    },
  ],
};

test('Hermes control client refreshes a 401 once, scopes profile and strips internal data', async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const tokenCalls: boolean[] = [];
  let attempt = 0;
  const client = new HermesControlClient({
    baseUrl: 'http://127.0.0.1:8642/',
    token: async (refresh) => {
      tokenCalls.push(refresh);
      return refresh ? 'fresh-service-token' : 'expired-service-token';
    },
    fetch: async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      attempt += 1;
      return attempt === 1
        ? new Response(JSON.stringify({ detail: 'expired' }), { status: 401, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify(catalogPayload), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const catalog = await client.platforms('rw-0123456789abcdef01234567');
  assert.deepEqual(tokenCalls, [false, true]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]!.url).searchParams.get('profile'), 'rw-0123456789abcdef01234567');
  assert.equal(calls[0]!.headers.get('X-Hermes-Session-Token'), 'expired-service-token');
  assert.equal(calls[1]!.headers.get('X-Hermes-Session-Token'), 'fresh-service-token');
  assert.equal(catalog.platforms.length, 1);
  assert.equal(catalog.platforms[0]!.id, 'telegram');
  assert.equal(catalog.platforms[0]!.envVars[0]!.isSet, true);
  const serialized = JSON.stringify(catalog);
  assert.equal(serialized.includes('redacted_value'), false);
  assert.equal(serialized.includes('123***secret'), false);
  assert.equal(serialized.includes('/private/hermes'), false);
  assert.equal(serialized.includes('gateway start'), false);
});

test('Hermes control client allows only normalized profile and platform identifiers', async () => {
  const client = new HermesControlClient({
    baseUrl: 'http://127.0.0.1:8642',
    token: async () => 'service-token',
    fetch: async () => new Response(JSON.stringify(catalogPayload), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(() => client.platforms('../default'), /profile/u);
  await assert.rejects(() => client.testPlatform('rw-0123456789abcdef01234567', '../telegram'), /平台标识/u);
});

test('Hermes control client rejects malformed and oversized upstream responses without leaking the token', async () => {
  const secret = 'never-leak-service-token';
  const malformed = new HermesControlClient({
    baseUrl: 'http://127.0.0.1:8642',
    token: async () => secret,
    fetch: async () => new Response('not-json', { headers: { 'content-type': 'text/plain' } }),
  });
  await assert.rejects(() => malformed.platforms('rw-0123456789abcdef01234567'), (error: unknown) => {
    assert.ok(error instanceof HermesUpstreamError);
    assert.equal(error.message.includes(secret), false);
    return true;
  });

  const oversized = new HermesControlClient({
    baseUrl: 'http://127.0.0.1:8642',
    token: async () => secret,
    maxResponseBytes: 1024,
    fetch: async () => new Response('x'.repeat(1025), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(() => oversized.platforms('rw-0123456789abcdef01234567'), /响应体过大/u);
});

test('Hermes control client times out bounded requests', async () => {
  const client = new HermesControlClient({
    baseUrl: 'http://127.0.0.1:8642',
    token: async () => 'service-token',
    timeoutMs: 5,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  });
  await assert.rejects(() => client.health(), /超时/u);
});

test('Hermes control client uses the official v2026 dashboard health endpoints', async () => {
  const paths: string[] = [];
  const client = new HermesControlClient({
    baseUrl: 'http://127.0.0.1:8642',
    token: async () => 'service-token',
    fetch: async (input, init) => {
      paths.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await client.health();
  await client.detailedHealth();

  assert.deepEqual(paths, ['/api/health', '/api/status']);
});

test('Hermes control client creates an isolated Readywork profile on first use', async () => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  let platformReads = 0;
  const client = new HermesControlClient({
    baseUrl: 'http://127.0.0.1:8642',
    token: async () => 'service-token',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? 'GET';
      calls.push({
        path,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (path === '/api/messaging/platforms' && platformReads++ === 0) {
        return new Response(JSON.stringify({ detail: "Profile does not exist" }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/api/profiles') {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(catalogPayload), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const profile = 'rw-0123456789abcdef01234567';
  const result = await client.platforms(profile);

  assert.equal(result.platforms[0]?.id, 'telegram');
  assert.deepEqual(calls.map(({ path, method }) => ({ path, method })), [
    { path: '/api/messaging/platforms', method: 'GET' },
    { path: '/api/profiles', method: 'POST' },
    { path: '/api/messaging/platforms', method: 'GET' },
  ]);
  assert.deepEqual(calls[1]?.body, {
    name: profile,
    no_skills: true,
    description: 'Readywork 租户消息渠道隔离配置',
  });
});

test('Hermes control client projects multiplexed tenant platform state from the owning gateway', async () => {
  const profile = 'rw-0123456789abcdef01234567';
  const paths: string[] = [];
  const client = new HermesControlClient({
    baseUrl: 'http://127.0.0.1:8642',
    token: async () => 'service-token',
    fetch: async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/api/status') {
        return new Response(JSON.stringify({
          gateway_mode: 'multiplex',
          gateway_running: true,
          gateway_platforms: {
            [`${profile}:weixin`]: {
              state: 'connected', error_code: null, error_message: null, updated_at: '2026-09-09T09:00:00Z',
            },
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ platforms: [{
        id: 'weixin', name: 'Weixin', description: 'Personal WeChat', docs_url: '', enabled: true,
        configured: true, gateway_running: false, state: 'disconnected', error_code: null,
        error_message: null, updated_at: null, env_vars: [],
      }] }), { headers: { 'content-type': 'application/json' } });
    },
  });

  const catalog = await client.platforms(profile);

  assert.deepEqual(paths, ['/api/messaging/platforms', '/api/status']);
  assert.equal(catalog.platforms[0]?.gatewayRunning, true);
  assert.equal(catalog.platforms[0]?.state, 'connected');
  assert.equal(catalog.platforms[0]?.updatedAt, '2026-09-09T09:00:00Z');
});

test('Hermes control client verifies a tenant platform through the multiplex gateway owner', async () => {
  const profile = 'rw-0123456789abcdef01234567';
  const paths: string[] = [];
  const client = new HermesControlClient({
    baseUrl: 'http://127.0.0.1:8642',
    token: async () => 'service-token',
    fetch: async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/api/status') {
        return new Response(JSON.stringify({
          gateway_mode: 'multiplex',
          gateway_running: true,
          gateway_platforms: { [`${profile}:weixin`]: { state: 'connected' } },
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        ok: false,
        state: 'disconnected',
        message: 'Gateway is not running. Restart the gateway to connect this platform.',
      }), { headers: { 'content-type': 'application/json' } });
    },
  });

  const result = await client.testPlatform(profile, 'weixin');

  assert.deepEqual(paths, ['/api/messaging/platforms/weixin/test', '/api/status']);
  assert.equal(result.ok, true);
  assert.equal(result.state, 'connected');
});

test('Hermes control client marks Weixin as scannable and routes its onboarding through the native sidecar', async () => {
  const calls: string[] = [];
  const client = new HermesControlClient({
    baseUrl: 'http://127.0.0.1:8642',
    weixinOnboardingUrl: 'http://127.0.0.1:9121',
    timeoutMs: 5,
    token: async () => 'service-token',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.pathname === '/api/messaging/platforms') {
        return new Response(JSON.stringify({ platforms: [{
          id: 'weixin', name: 'Weixin', description: 'Personal WeChat', docs_url: '', enabled: false,
          configured: false, gateway_running: true, state: 'not_configured', error_code: null,
          error_message: null, updated_at: null, env_vars: [
            { key: 'WEIXIN_ACCOUNT_ID', required: true, is_set: false, description: '', prompt: '', help: '', url: null, is_password: false, advanced: false },
            { key: 'WEIXIN_TOKEN', required: true, is_set: false, description: '', prompt: '', help: '', url: null, is_password: true, advanced: false },
          ],
        }] }), { headers: { 'content-type': 'application/json' } });
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        }, { once: true });
      });
      return new Response(JSON.stringify({
        pairing_id: 'weixin-pairing-001', status: 'waiting', qr_payload: 'https://weixin.example/qr',
      }), { headers: { 'content-type': 'application/json' } });
    },
  });

  const platforms = await client.platforms('rw-0123456789abcdef01234567');
  assert.equal(platforms.platforms[0]?.onboarding, 'weixin');
  const response = await client.onboarding({
    profile: 'rw-0123456789abcdef01234567', platform: 'weixin', method: 'POST', action: 'start', body: {},
  });

  assert.equal(response.status, 'waiting');
  const onboardingUrl = new URL(calls.at(-1)!);
  assert.equal(onboardingUrl.origin, 'http://127.0.0.1:9121');
  assert.equal(onboardingUrl.pathname, '/api/messaging/weixin/onboarding/start');
  assert.equal(onboardingUrl.searchParams.get('profile'), 'rw-0123456789abcdef01234567');
});
