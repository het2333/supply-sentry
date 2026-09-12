import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import type { Session } from '../src/auth.js';
import { HermesUpstreamError, type HermesPlatformCatalog } from '../src/messaging/hermes-control-client.js';
import { handleHermesMessagingRequest, type HermesControl } from '../src/messaging/hermes-routes.js';

const catalog: HermesPlatformCatalog = {
  platforms: [{
    id: 'future_channel',
    name: 'Future Channel',
    description: 'A future Hermes platform.',
    docsUrl: 'https://example.test/future',
    enabled: false,
    configured: false,
    gatewayRunning: true,
    state: 'not_configured',
    errorCode: null,
    errorMessage: null,
    updatedAt: null,
    onboarding: null,
    envVars: [
      {
        key: 'FUTURE_TOKEN',
        required: true,
        isSet: false,
        description: 'Access token',
        prompt: 'Token',
        help: '',
        url: null,
        isPassword: true,
        advanced: false,
      },
    ],
  }],
};

function session(role: string): Session {
  return {
    username: role,
    tenantId: 'tenant:a',
    humanId: `human:${role}`,
    name: role,
    role,
    expiresAt: Date.now() + 60_000,
  };
}

test('Hermes platform routes expose dynamic catalog, persist secret-free actions and serve stale read-only snapshots', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  let unavailable = false;
  let configureCalls = 0;
  let onboardingErrorStatus = 0;
  const onboardingCalls: Array<{ platform: string; method: string; action?: string }> = [];
  const control: HermesControl = {
    platforms: async () => {
      if (unavailable) throw new Error('upstream unavailable with token=never-return');
      return catalog;
    },
    configurePlatform: async (_profile, _platform, body) => {
      configureCalls += 1;
      assert.deepEqual(body, { enabled: true, env: { FUTURE_TOKEN: 'real-secret' }, clear_env: [] });
      return { ok: true, platform: 'future_channel' };
    },
    testPlatform: async () => ({ ok: false, state: 'not_configured', message: 'Missing setup' }),
    onboarding: async (input) => {
      if (onboardingErrorStatus) {
        throw new HermesUpstreamError('upstream onboarding error', onboardingErrorStatus, 'HERMES_HTTP_ERROR');
      }
      onboardingCalls.push({ platform: input.platform, method: input.method, ...(input.action ? { action: input.action } : {}) });
      return {
        pairing_id: 'weixin-pairing-001', status: 'ready', qr_payload: 'https://weixin.example/qr',
        token: 'never-return-weixin-token', bot_token: 'never-return-weixin-bot-token', account_id: 'never-return-account-id',
      };
    },
    health: async () => ({ status: 'ok' }),
    detailedHealth: async () => ({ status: 'ok' }),
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const role = String(req.headers['x-test-role'] ?? '');
    const activeSession = role === 'none' ? null : session(role === 'manager' ? '采购经理' : '管理员');
    void handleHermesMessagingRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db,
      session: activeSession,
      control,
      wecomCallbackPublicUrl: 'https://readywork.example.com',
      now: () => '2026-09-09T10:00:00.000Z',
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  const request = async (path: string, input: {
    method?: string;
    role?: string;
    idempotencyKey?: string;
    body?: unknown;
  } = {}) => {
    const body = input.body === undefined ? '' : JSON.stringify(input.body);
    return await new Promise<{ status: number; body: Record<string, any>; raw: string }>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path,
        method: input.method ?? 'GET',
        headers: {
          'x-test-role': input.role ?? 'admin',
          ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
          ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw || '{}'), raw });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  };

  try {
    assert.equal((await request('/api/messaging/platforms', { role: 'none' })).status, 401);
    const read = await request('/api/messaging/platforms');
    assert.equal(read.status, 200);
    assert.equal(read.body.stale, false);
    assert.equal(read.body.platforms[0].id, 'future_channel');
    assert.equal(read.body.platforms[0].name, 'Future Channel');

    assert.equal((await request('/api/messaging/wecom/setup-readiness', { role: 'none' })).status, 401);
    const wecomReadiness = await request('/api/messaging/wecom/setup-readiness');
    assert.equal(wecomReadiness.status, 200);
    assert.deepEqual(wecomReadiness.body, {
      callbackUrl: 'https://readywork.example.com/wecom/callback',
      ready: true,
      reason: null,
    });

    assert.equal((await request('/api/messaging/platforms/future_channel', {
      method: 'PUT',
      role: 'manager',
      idempotencyKey: 'configure:forbidden',
      body: { enabled: true, env: { FUTURE_TOKEN: 'real-secret' } },
    })).status, 403);

    const configured = await request('/api/messaging/platforms/future_channel', {
      method: 'PUT',
      idempotencyKey: 'configure:future:001',
      body: { enabled: true, env: { FUTURE_TOKEN: 'real-secret' } },
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.replayed, false);
    assert.equal(configured.raw.includes('real-secret'), false);
    const replay = await request('/api/messaging/platforms/future_channel', {
      method: 'PUT',
      idempotencyKey: 'configure:future:001',
      body: { enabled: true, env: { FUTURE_TOKEN: 'real-secret' } },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(configureCalls, 1);
    const persisted = JSON.stringify(store.db.prepare(
      'SELECT * FROM hermes_platform_actions WHERE tenant_id=?',
    ).get('tenant:a'));
    assert.equal(persisted.includes('real-secret'), false);

    assert.equal((await request('/api/messaging/onboarding/weixin/start', {
      method: 'POST', role: 'manager', body: {},
    })).status, 403);
    const weixinOnboarding = await request('/api/messaging/onboarding/weixin/start', { method: 'POST', body: {} });
    assert.equal(weixinOnboarding.status, 200);
    assert.equal(weixinOnboarding.body.status, 'ready');
    assert.equal(weixinOnboarding.body.pairing_id, 'weixin-pairing-001');
    assert.equal(weixinOnboarding.raw.includes('never-return'), false);
    assert.deepEqual(onboardingCalls, [{ platform: 'weixin', method: 'POST', action: 'start' }]);

    onboardingErrorStatus = 404;
    assert.equal((await request('/api/messaging/onboarding/weixin/weixin-pairing-001')).status, 404);
    onboardingErrorStatus = 410;
    assert.equal((await request('/api/messaging/onboarding/weixin/weixin-pairing-001')).status, 410);
    onboardingErrorStatus = 0;

    assert.equal((await request('/api/messaging/platforms/future_channel', {
      method: 'PUT',
      idempotencyKey: 'configure:unknown-field',
      body: { env: { ARBITRARY_ENV: 'bad' } },
    })).status, 400);

    unavailable = true;
    const stale = await request('/api/messaging/platforms');
    assert.equal(stale.status, 200);
    assert.equal(stale.body.stale, true);
    assert.equal(stale.body.platforms[0].id, 'future_channel');
    assert.equal(stale.raw.includes('never-return'), false);
    assert.equal((await request('/api/messaging/platforms/future_channel/test', {
      method: 'POST',
      idempotencyKey: 'test:stale',
    })).status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
