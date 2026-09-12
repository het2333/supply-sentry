import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Task } from '@readywork/core';
import { CollaborationControlPlane } from '../src/collaboration-channels.js';
import { TeamsBotFrameworkAdapter, initializeTeamsBotSchema, listTeamsConversationReferences, upsertTeamsIdentityBinding, type TeamsBotAdapterOptions } from '../src/teams-bot-adapter.js';

const clock = new Date('2026-08-21T01:00:00.000Z').getTime();
const issuer = 'https://api.botframework.com';
const appId = 'bot-app-id';
const teamsTenantId = 'teams-tenant';
const aadObjectId = 'aad-user';
const actor = { tenantId: 't:acme', humanId: 'h:buyer-1', role: '采购专员' };

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...(keyPair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'key-1', use: 'sig', alg: 'RS256' };

function makeTask(): Task {
  return {
    id: 'task:teams', tenantId: actor.tenantId, employeeId: 'ai:procurement', workflowId: 'wf:teams', businessObjectId: 'po:1', status: 'waiting_human', attempts: 0, maxRetries: 3,
    checkpoint: { stepIndex: 1, workspace: {} }, createdAt: new Date(clock).toISOString(), metadata: { assigneeHumanId: actor.humanId },
  };
}

function signJwt(overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-1' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: appId, exp: Math.floor(clock / 1000) + 3_600, nbf: Math.floor(clock / 1000) - 60, tid: teamsTenantId, oid: aadObjectId, ...overrides })).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${signer.sign(keyPair.privateKey).toString('base64url')}`;
}

function setup(options: { withSecret?: boolean; fetch?: typeof fetch; handleNaturalLanguageApproval?: TeamsBotAdapterOptions['handleNaturalLanguageApproval'] } = {}) {
  const db = new DatabaseSync(':memory:');
  initializeTeamsBotSchema(db);
  upsertTeamsIdentityBinding(db, { teamsTenantId, aadObjectId, readyworkTenantId: actor.tenantId, readyworkHumanId: actor.humanId, updatedAt: new Date(clock).toISOString() });
  const collaboration = new CollaborationControlPlane({
    tasks: { list: () => [makeTask()] }, signingSecret: 'teams-channel-signing-secret-long-enough', now: () => clock,
    teams: (tenantId) => tenantId === actor.tenantId ? { tenantId, enabled: true, allowedHumanIds: [actor.humanId] } : undefined,
  });
  const adapter = new TeamsBotFrameworkAdapter({
    db, collaboration, resolveActor: (tenant, human) => tenant === actor.tenantId && human === actor.humanId ? actor : undefined,
    config: { appId, ...(options.withSecret === false ? {} : { appSecret: 'bot-client-secret' }), issuer, jwksUrl: 'https://keys.example.test/jwks', oauthTokenUrl: 'https://login.example.test/token', allowedServiceUrlHosts: ['smba.trafficmanager.net'], requestTimeoutMs: 1_000 },
    fetch: options.fetch,
    ...(options.handleNaturalLanguageApproval ? { handleNaturalLanguageApproval: options.handleNaturalLanguageApproval } : {}),
    now: () => clock,
  });
  return { db, collaboration, adapter };
}

function activity(value: Record<string, unknown>, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'activity:1', type: 'invoke', channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/amer/',
    from: { id: '29:aad-user', aadObjectId }, recipient: { id: 'bot-id' }, conversation: { id: 'conversation:1', tenantId: teamsTenantId }, value, ...overrides,
  };
}

test('生产 Teams 入站：验证 JWT/JWKS、只使用 claims 身份、持久化会话且防重复 activity', async () => {
  let jwksFetches = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url) === 'https://keys.example.test/jwks') { jwksFetches += 1; return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'cache-control': 'max-age=3600' } }); }
    throw new Error('unexpected network call');
  };
  const { db, collaboration, adapter } = setup({ fetch: fetcher, withSecret: false });
  const notification = collaboration.prepareTeamsNotification(actor, 'task:teams');
  assert.equal(notification.status, 'queued');
  if (!notification.payload) return;
  const action = (notification.payload.adaptiveCard['actions'] as Array<{ data: Record<string, unknown> }>)[0]!.data;
  const first = await adapter.handleInboundActivity(`Bearer ${signJwt()}`, activity(action));
  assert.equal(first.status, 'processed');
  if (first.status !== 'processed') return;
  assert.equal(first.replayed, false);
  assert.equal(!first.result.ok && first.result.code === 'CONFIRMATION_REQUIRED', true, 'Teams 动作仍必须经历二次确认');
  const replay = await adapter.handleInboundActivity(`Bearer ${signJwt()}`, activity(action));
  assert.equal(replay.status, 'processed');
  if (replay.status === 'processed') assert.equal(replay.replayed, true, '重复 activity 返回持久化结果且明确标为重放');
  assert.equal(jwksFetches, 1, 'JWKS 依据 cache-control 缓存，不为每个 Activity 重取');
  assert.equal(listTeamsConversationReferences(db, actor.tenantId, actor.humanId).length, 1);
  db.close();
});

test('Teams 拒绝自报身份、过期 JWT、无绑定身份以及同 ID 异载荷', async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
  const { db, collaboration, adapter } = setup({ fetch: fetcher, withSecret: false });
  const notification = collaboration.prepareTeamsNotification(actor, 'task:teams');
  if (!notification.payload) return;
  const cardAction = (notification.payload.adaptiveCard['actions'] as Array<{ data: Record<string, unknown> }>)[0]!.data;
  const mismatch = await adapter.handleInboundActivity(`Bearer ${signJwt()}`, activity(cardAction, { from: { aadObjectId: 'forged-user' } }));
  assert.deepEqual(mismatch, { status: 'rejected', code: 'TEAMS_IDENTITY_MISMATCH', error: 'Teams 请求被拒绝或处理失败' });
  const expired = await adapter.handleInboundActivity(`Bearer ${signJwt({ exp: Math.floor(clock / 1000) - 61 })}`, activity(cardAction));
  assert.deepEqual(expired, { status: 'rejected', code: 'TEAMS_AUTH_EXPIRED', error: 'Teams 请求被拒绝或处理失败' });
  const first = await adapter.handleInboundActivity(`Bearer ${signJwt()}`, activity(cardAction));
  assert.equal(first.status, 'processed');
  const changed = await adapter.handleInboundActivity(`Bearer ${signJwt()}`, activity({ ...cardAction, action: 'dismiss' }));
  assert.deepEqual(changed, { status: 'rejected', code: 'TEAMS_ACTIVITY_REUSED', error: '相同 Activity ID 的载荷不一致' });
  db.prepare('DELETE FROM teams_conversation_references WHERE teams_tenant_id=? AND aad_object_id=?').run(teamsTenantId, aadObjectId);
  db.prepare('DELETE FROM teams_identity_bindings WHERE teams_tenant_id=? AND aad_object_id=?').run(teamsTenantId, aadObjectId);
  const unbound = await adapter.handleInboundActivity(`Bearer ${signJwt()}`, activity({ ...cardAction, idempotencyKey: 'another-action' }, { id: 'activity:unbound' }));
  assert.deepEqual(unbound, { status: 'unavailable', code: 'TEAMS_IDENTITY_UNBOUND', error: 'Teams 身份尚未绑定 Readywork 用户' });
  db.close();
});

test('Teams 自然语言审批：显式批准/拒绝指令只使用绑定身份，且 activity 幂等与拒绝可监控', async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
  const calls: Array<{ actor: unknown; input: unknown }> = [];
  const { db, adapter } = setup({
    fetch: fetcher, withSecret: false,
    handleNaturalLanguageApproval: async (boundActor, input) => {
      calls.push({ actor: boundActor, input });
      return { ok: true, approvalId: input.approvalId, taskId: 'task:teams', decision: input.decision, taskStatus: 'running', replayed: false };
    },
  });
  const approvedActivity = activity({}, { id: 'activity:natural-approve', type: 'message', text: '批准 approval:42', value: undefined });
  const approved = await adapter.handleInboundActivity(`Bearer ${signJwt()}`, approvedActivity);
  assert.equal(approved.status, 'processed');
  if (approved.status !== 'processed') return;
  assert.deepEqual(approved.result, { ok: true, approvalId: 'approval:42', taskId: 'task:teams', decision: 'approved', taskStatus: 'running', replayed: false });
  assert.deepEqual(calls[0]?.actor, actor, '审批人只能来自 JWT + Teams/AAD 绑定后的 Readywork 身份');
  assert.deepEqual(calls[0]?.input, { approvalId: 'approval:42', decision: 'approved', idempotencyKey: 'teams:activity:natural-approve' });
  const replay = await adapter.handleInboundActivity(`Bearer ${signJwt()}`, approvedActivity);
  assert.equal(replay.status, 'processed');
  if (replay.status === 'processed') assert.equal(replay.replayed, true);
  assert.equal(calls.length, 1);
  const changed = await adapter.handleInboundActivity(`Bearer ${signJwt()}`, activity({}, {
    id: 'activity:natural-approve', type: 'message', text: '拒绝 approval:42 原因：价格超限', value: undefined,
  }));
  assert.equal(changed.status, 'rejected', '自然语言文本必须进入 activity 载荷指纹');
  db.close();

  const deniedSetup = setup({
    fetch: fetcher, withSecret: false,
    handleNaturalLanguageApproval: async () => ({ ok: false, code: 'TEAMS_APPROVAL_FORBIDDEN', error: '无权审批' }),
  });
  const denied = await deniedSetup.adapter.handleInboundActivity(`Bearer ${signJwt()}`, activity({}, {
    id: 'activity:natural-denied', type: 'message', text: '批准 approval:99', value: undefined,
  }));
  assert.equal(denied.status, 'processed');
  const security = deniedSetup.db.prepare(`SELECT tenant_id,event_type,actor_id,message FROM control_security_events
    WHERE request_id=?`).get('activity:natural-denied') as Record<string, unknown> | undefined;
  assert.deepEqual({ ...security }, {
    tenant_id: actor.tenantId, event_type: 'authorization_denied', actor_id: actor.humanId,
    message: 'Teams 动作被拒绝: TEAMS_APPROVAL_FORBIDDEN',
  });
  deniedSetup.db.close();
});

test('主动 Teams 通知：OAuth + 2xx 才返回 sent；未配、无会话、失败绝不假成功', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://keys.example.test/jwks') return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    if (String(url) === 'https://login.example.test/token') return new Response(JSON.stringify({ access_token: 'bot-token', expires_in: 3600 }), { status: 200 });
    if (String(url).includes('/v3/conversations/')) return new Response(JSON.stringify({ id: 'outbound:1' }), { status: 201 });
    throw new Error('unexpected endpoint');
  };
  const noSecret = setup({ fetch: fetcher, withSecret: false });
  assert.deepEqual(await noSecret.adapter.sendProactiveTaskNotification(actor, 'task:teams'), { status: 'unavailable', code: 'TEAMS_UNAVAILABLE', error: 'Teams Bot 主动通知未配置' });
  noSecret.db.close();

  const { db, adapter } = setup({ fetch: fetcher });
  const noConversation = await adapter.sendProactiveTaskNotification(actor, 'task:teams');
  assert.deepEqual(noConversation, { status: 'unavailable', code: 'TEAMS_CONVERSATION_UNAVAILABLE', error: '该 Readywork 用户没有已验证的 Teams 会话引用' });
  db.prepare('INSERT INTO teams_conversation_references (teams_tenant_id,aad_object_id,conversation_id,service_url,bot_id,channel_id,updated_at) VALUES (?,?,?,?,?,?,?)').run(teamsTenantId, aadObjectId, 'conversation:1', 'https://smba.trafficmanager.net/amer/', 'bot-id', 'msteams', new Date(clock).toISOString());
  assert.deepEqual(await adapter.sendProactiveTaskNotification(actor, 'task:teams'), { status: 'sent', activityId: 'outbound:1' });
  assert.equal(calls.some((item) => item.url.includes('/v3/conversations/conversation%3A1/activities') && item.init?.method === 'POST'), true);
  db.close();
});

test('JWKS 超时和错误不泄露上游敏感文本', async () => {
  const fetcher: typeof fetch = async () => { throw new Error('authorization=Bearer must-not-leak timeout'); };
  const { db, adapter } = setup({ fetch: fetcher, withSecret: false });
  const result = await adapter.handleInboundActivity(`Bearer ${signJwt()}`, activity({}));
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.includes('must-not-leak'), false);
  db.close();
});
