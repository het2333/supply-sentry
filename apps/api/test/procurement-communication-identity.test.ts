import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementCommunicationIdentityRequest } from '../src/procurement-communication-identity.js';
import { handleProcurementMessageDraftRequest } from '../src/procurement-message-drafts.js';

const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

function token(tenantId: string, role: string, humanId: string, name = humanId): string {
  const session: Session = { username: humanId, tenantId, humanId, name, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

test('采购沟通身份: 缺省、权限、创建、乐观锁、更新、审计与租户隔离', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:identity-a' });
  const legacySignature = '此致\nReadywork 采购执行助手（代采购方发送）';
  const seedLegacyDraft = (id: string, status: 'draft' | 'approved_queued') => {
    store.db.prepare(`INSERT INTO procurement_message_drafts
      (tenant_id,id,purchase_order_id,supplier_id,channel,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'tenant:identity-a', id, 'po:legacy', 'supplier:legacy', 'email', 'supplier@real-supplier.cn', '旧 SLA 草稿',
      `供应商您好：\n\n请确认采购订单。\n\n${legacySignature}`,
      'acknowledgement_followup', `sla:legacy:${id}`, JSON.stringify({ source: 'legacy-sla' }), status, 1,
      'ai:procurement-sla', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z',
    );
  };
  seedLegacyDraft('draft:eligible', 'draft');
  seedLegacyDraft('draft:edited', 'draft');
  seedLegacyDraft('draft:approved', 'approved_queued');
  store.db.prepare(`INSERT INTO procurement_message_draft_events
    (tenant_id,id,draft_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`).run(
    'tenant:identity-a', 'event:edited', 'draft:edited', 'human:buyer', 'edited', '{}', '2026-08-27T01:00:00.000Z',
  );
  const fixedTimes = [
    new Date('2026-08-28T01:00:00.000Z'),
    new Date('2026-08-28T02:00:00.000Z'),
  ];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers['authorization'];
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const session = resolveSession(bearer);
    void (async () => {
      if (await handleProcurementCommunicationIdentityRequest(req, res, url.pathname, req.method ?? 'GET', {
        db: store.db, session, now: () => fixedTimes[0]!,
      })) return;
      if (await handleProcurementMessageDraftRequest(req, res, url.pathname, req.method ?? 'GET', {
        db: store.db, session, connectorReady: () => true,
      })) return;
      res.writeHead(404).end();
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = token('tenant:identity-a', '采购专员', 'human:buyer', '李采购');
  const manager = token('tenant:identity-a', '采购经理', 'human:manager', '王经理');
  const otherManager = token('tenant:identity-b', '采购经理', 'human:other-manager', '赵经理');

  async function request(authToken: string, options: { method?: string; body?: Record<string, unknown> } = {}) {
    const response = await fetch(`${base}/api/procurement/communication-identity`, {
      method: options.method ?? 'GET',
      headers: { authorization: `Bearer ${authToken}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  try {
    const missing = await request(buyer);
    assert.equal(missing.status, 200);
    assert.equal(missing.body['item'], null);
    assert.equal(missing.body['readiness'], 'missing');
    assert.deepEqual(missing.body['suggested'], { displayName: '李采购', title: '采购专员' });
    assert.deepEqual(missing.body['permissions'], { read: true, configure: false });
    assert.deepEqual(missing.body['legacyDrafts'], { withoutIdentity: 2, eligibleForRebind: 1, requiresManualReview: 1, reboundInThisWrite: 0 });

    const denied = await request(buyer, { method: 'PUT', body: { expectedVersion: 0, displayName: '李采购', title: '采购专员', organizationName: '东方工业' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body['code'], 'FORBIDDEN');

    const headerInjection = await request(manager, { method: 'PUT', body: { expectedVersion: 0, displayName: '王经理\r\nBcc: attacker@example.com', title: '采购经理', organizationName: '东方工业有限公司' } });
    assert.equal(headerInjection.status, 422);
    assert.equal(headerInjection.body['code'], 'INVALID_COMMUNICATION_IDENTITY');
    assert.equal((await request(manager)).body['item'], null);

    const created = await request(manager, { method: 'PUT', body: { expectedVersion: 0, displayName: '王 经理', title: '高级采购经理', organizationName: '东方工业有限公司' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body['item'], {
      displayName: '王 经理', title: '高级采购经理', organizationName: '东方工业有限公司', status: 'active', version: 1,
      createdBy: 'human:manager', updatedBy: 'human:manager', createdAt: fixedTimes[0]!.toISOString(), updatedAt: fixedTimes[0]!.toISOString(),
    });
    assert.equal(created.body['readiness'], 'ready');
    assert.deepEqual(created.body['legacyDrafts'], { withoutIdentity: 1, eligibleForRebind: 0, requiresManualReview: 1, reboundInThisWrite: 1 });
    assert.equal(created.body['events'].length, 1);
    assert.equal(created.body['events'][0]['action'], 'created');
    assert.equal(created.body['events'][0]['detail']['reboundDrafts'], 1);

    const rebound = store.db.prepare(`SELECT body,version,sender_name,sender_title,sender_organization,trigger_evidence_json
      FROM procurement_message_drafts WHERE tenant_id=? AND id=?`).get('tenant:identity-a', 'draft:eligible') as Record<string, unknown>;
    assert.equal(rebound['version'], 2);
    assert.equal(rebound['sender_name'], '王 经理');
    assert.equal(rebound['sender_title'], '高级采购经理');
    assert.equal(rebound['sender_organization'], '东方工业有限公司');
    assert.match(String(rebound['body']), /此致\n王 经理\n高级采购经理｜东方工业有限公司$/);
    assert.doesNotMatch(String(rebound['body']), /Readywork 采购执行助手/);
    assert.deepEqual((JSON.parse(String(rebound['trigger_evidence_json'])) as Record<string, any>)['communicationIdentity'], {
      displayName: '王 经理', title: '高级采购经理', organizationName: '东方工业有限公司', version: 1,
    });
    assert.deepEqual((store.db.prepare(`SELECT action FROM procurement_message_draft_events WHERE tenant_id=? AND draft_id=? ORDER BY created_at,id`).all('tenant:identity-a', 'draft:eligible') as Array<{ action: string }>).map((event) => event.action), ['identity_rebound']);
    const untouchedEdited = store.db.prepare(`SELECT version,sender_name,body FROM procurement_message_drafts WHERE tenant_id=? AND id=?`).get('tenant:identity-a', 'draft:edited') as Record<string, unknown>;
    assert.deepEqual([untouchedEdited['version'], untouchedEdited['sender_name'], String(untouchedEdited['body']).endsWith(legacySignature)], [1, null, true]);
    const untouchedApproved = store.db.prepare(`SELECT version,sender_name,status FROM procurement_message_drafts WHERE tenant_id=? AND id=?`).get('tenant:identity-a', 'draft:approved') as Record<string, unknown>;
    assert.deepEqual([untouchedApproved['version'], untouchedApproved['sender_name'], untouchedApproved['status']], [1, null, 'approved_queued']);

    const approveRebound = await fetch(`${base}/api/procurement/message-drafts/${encodeURIComponent('draft:eligible')}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${manager}`, 'content-type': 'application/json', 'idempotency-key': 'approve-rebound-draft' },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    const approveReboundBody = await approveRebound.json() as Record<string, any>;
    assert.equal(approveRebound.status, 201, JSON.stringify(approveReboundBody));
    assert.equal(approveReboundBody['item']['status'], 'approved_queued');
    assert.deepEqual(approveReboundBody['item']['senderIdentity'], { displayName: '王 经理', title: '高级采购经理', organizationName: '东方工业有限公司' });
    assert.equal(approveReboundBody['outbox']['status'], 'pending');

    const loaded = await request(buyer);
    assert.equal(loaded.body['item']['version'], 1);
    assert.equal(loaded.body['item']['displayName'], '王 经理');

    const conflict = await request(manager, { method: 'PUT', body: { expectedVersion: 0, displayName: '张经理', title: '采购经理', organizationName: '东方工业有限公司' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body['code'], 'COMMUNICATION_IDENTITY_VERSION_CONFLICT');
    assert.equal(conflict.body['currentVersion'], 1);

    fixedTimes.shift();
    const updated = await request(manager, { method: 'PUT', body: { expectedVersion: 1, displayName: '张经理', title: '采购总监', organizationName: '东方工业有限公司' } });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body['item']['version'], 2);
    assert.equal(updated.body['item']['displayName'], '张经理');
    assert.equal(updated.body['item']['updatedAt'], '2026-08-28T02:00:00.000Z');
    assert.equal(updated.body['legacyDrafts']['reboundInThisWrite'], 0);
    assert.deepEqual(updated.body['events'].map((event: Record<string, unknown>) => event['action']), ['updated', 'created']);
    const frozenAfterIdentityUpdate = store.db.prepare(`SELECT version,sender_name,sender_title FROM procurement_message_drafts WHERE tenant_id=? AND id=?`).get('tenant:identity-a', 'draft:eligible') as Record<string, unknown>;
    assert.deepEqual([frozenAfterIdentityUpdate['version'], frozenAfterIdentityUpdate['sender_name'], frozenAfterIdentityUpdate['sender_title']], [3, '王 经理', '高级采购经理']);

    const isolated = await request(otherManager);
    assert.equal(isolated.status, 200);
    assert.equal(isolated.body['item'], null);
    assert.deepEqual(isolated.body['events'], []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
