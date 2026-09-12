import { createHash, createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const apiBaseUrl = (process.env.READYWORK_API_BASE_URL ?? 'http://127.0.0.1:4173').replace(/\/$/u, '');
const dashboardBaseUrl = (process.env.READYWORK_HERMES_DASHBOARD_URL ?? 'http://127.0.0.1:9119').replace(/\/$/u, '');
const bridgeBaseUrl = (process.env.READYWORK_HERMES_BRIDGE_URL ?? 'http://127.0.0.1:8788').replace(/\/$/u, '');
const dashboardToken = process.env.READYWORK_HERMES_DASHBOARD_TOKEN ?? process.env.HERMES_DASHBOARD_SESSION_TOKEN ?? '';
const bridgeSecret = process.env.READYWORK_HERMES_BRIDGE_SECRET ?? process.env.READYWORK_BRIDGE_SECRET ?? '';
const databasePath = process.env.DB_PATH ?? resolve(process.cwd(), 'data/readywork.sqlite');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`${url} 返回了无效 JSON`); }
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}：${String(body.error ?? body.detail ?? '请求失败')}`);
  return body;
}

async function readyworkCookie() {
  if (process.env.READYWORK_SESSION_COOKIE) return process.env.READYWORK_SESSION_COOKIE;
  const body = await fetch(`${apiBaseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.READYWORK_VERIFY_USERNAME ?? 'admin',
      password: process.env.READYWORK_VERIFY_PASSWORD ?? 'admin123',
    }),
  });
  if (!body.ok) throw new Error(`Readywork 验证登录失败（HTTP ${body.status}）；请开启本地演示登录或传入 READYWORK_SESSION_COOKIE`);
  const cookie = body.headers.get('set-cookie')?.split(';')[0] ?? '';
  requireCondition(cookie.startsWith('readywork_session='), 'Readywork 验证登录未返回会话 Cookie');
  return cookie;
}

function bridgeHeaders(path, body) {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = createHmac('sha256', bridgeSecret)
    .update(['POST', path, timestamp, nonce, body].join('\n'))
    .digest('hex');
  return {
    'content-type': 'application/json',
    'X-Readywork-Bridge-Version': 'readywork.hermes.bridge.v1',
    'X-Readywork-Timestamp': timestamp,
    'X-Readywork-Nonce': nonce,
    'X-Readywork-Signature': signature,
  };
}

requireCondition(dashboardToken.length >= 24, '缺少 READYWORK_HERMES_DASHBOARD_TOKEN，无法验证 Hermes Dashboard');
requireCondition(bridgeSecret.length >= 32, '缺少 READYWORK_HERMES_BRIDGE_SECRET，无法验证 HMAC Bridge');

const dashboardHeaders = { 'X-Hermes-Session-Token': dashboardToken, accept: 'application/json' };
const [dashboardHealth, detailedHealth, bridgeHealth] = await Promise.all([
  readJson(`${dashboardBaseUrl}/api/health`, { headers: dashboardHeaders }),
  readJson(`${dashboardBaseUrl}/api/status`, { headers: dashboardHeaders }),
  readJson(`${bridgeBaseUrl}/health`),
]);
requireCondition(bridgeHealth.ok === true, 'Readywork Bridge 健康检查未通过');
requireCondition(dashboardHealth.ok === true && detailedHealth.gateway_running === true, 'Hermes Dashboard 或 Gateway 健康检查未通过');

const cookie = await readyworkCookie();
const readyworkHeaders = { cookie, accept: 'application/json' };
const catalog = await readJson(`${apiBaseUrl}/api/messaging/platforms`, { headers: readyworkHeaders });
requireCondition(Array.isArray(catalog.platforms), 'Readywork 未返回动态消息渠道目录');
requireCondition(!catalog.platforms.some((platform) => platform.id === 'readywork_bridge'), '内部 readywork_bridge 渠道被错误泄露');

const runtime = await readJson(`${apiBaseUrl}/api/messaging/gateway`, { headers: readyworkHeaders });
for (const platform of catalog.platforms.filter((candidate) => candidate.configured === false)) {
  const state = runtime.adapters?.find((adapter) => (
    adapter.id === `hermes:${platform.id}`
    || (platform.id === 'email' && adapter.id === 'email' && adapter.provider === 'hermes-gateway')
  ));
  requireCondition(
    !state || (state.configured === false && state.status !== 'running'),
    `未配置渠道 ${platform.id} 被标记为 ${state?.status ?? '未知状态'}`,
  );
}

const profile = `rw-${createHash('sha256').update('t:acme').digest('hex').slice(0, 24)}`;
const inboundPath = '/api/integrations/hermes/v1/inbound';
const providerMessageId = `readywork-integration-verification-${Date.now()}`;
const inboundPayload = JSON.stringify({
  requestId: `integration-${randomUUID()}`,
  profile,
  event: {
    platform: 'webhook',
    messageId: providerMessageId,
    conversationId: 'integration-verification',
    inReplyTo: null,
    references: [],
    sender: { address: 'readywork-integration-verifier', displayName: '集成验证器' },
    recipients: [{ address: 'readywork' }],
    subject: '集成验证',
    text: 'Readywork Hermes 集成验证事件（非供应商业务消息）',
    occurredAt: new Date().toISOString(),
    threadId: null,
    raw: { verification: true },
  },
  attachments: [],
});
const inboundReceipt = await readJson(`${apiBaseUrl}${inboundPath}`, {
  method: 'POST',
  headers: bridgeHeaders(inboundPath, inboundPayload),
  body: inboundPayload,
});
requireCondition(inboundReceipt.persisted === true && typeof inboundReceipt.inboundId === 'string', 'HMAC 入站未获得持久化回执');

const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const persisted = database.prepare('SELECT provider_message_id,channel FROM messaging_inbound_messages WHERE id=?').get(inboundReceipt.inboundId);
  requireCondition(persisted?.provider_message_id === providerMessageId && persisted?.channel === 'webhook', 'HMAC 入站回执未在 Readywork SQLite 中找到');
} finally {
  database.close();
}

const outboundPath = '/readywork/v1/deliveries';
const outboundPayload = JSON.stringify({
  deliveryId: `readywork:integration-unconfigured:${randomUUID()}`,
  platform: 'readywork_integration_unconfigured',
  target: 'verification-only',
  text: '未配置渠道验证',
  replyTo: null,
  metadata: { source: 'integration_verification' },
  attachments: [],
});
const outboundResult = await readJson(`${bridgeBaseUrl}${outboundPath}`, {
  method: 'POST',
  headers: bridgeHeaders(outboundPath, outboundPayload),
  body: outboundPayload,
});
requireCondition(outboundResult.kind === 'failed_before_dispatch', '未连接渠道没有在外部调用前明确失败');

console.log(JSON.stringify({
  ok: true,
  hermes: '健康',
  bridge: '健康',
  platformCount: catalog.platforms.length,
  catalogStale: catalog.stale === true,
  inboundPersisted: true,
  unconfiguredOutboundBlockedBeforeDispatch: true,
}, null, 2));
