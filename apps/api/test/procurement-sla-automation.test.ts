import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { openPersistence } from '@readywork/persistence';
import type { Session } from '../src/auth.js';
import { handleProcurementSlaAutomationRequest, ProcurementSlaAutomationWorker } from '../src/procurement-sla-automation.js';
import { ProcurementOutboxWorker } from '../src/procurement-outbox-worker.js';

const at = '2026-08-20T00:00:00.000Z';
const rule = {
  id: 'commitment-default', name: '供应商确认期限', enabled: true, route: 'all', stage: 'supplier_commitment', risk: 'all',
  deadlineBasis: 'stage_entry', targetOffsetHours: 24, warningHours: 4, graceHours: 0,
  followupIntervalHours: 1, maxFollowups: 3, escalationRole: '采购经理', messageCategory: 'acknowledgement_followup',
};
const advancedSections = [
  'production_service_milestones', 'communication_escalation', 'payment_terms', 'logistics_planning', 'logistics_handover',
  'transit_monitoring', 'regulatory_import_approval', 'customs_clearance', 'quality_inspection_grn',
].map((domain) => ({
  domain, enabled: true, rules: [],
}));

function seedTenant(
  store: ReturnType<typeof openPersistence>,
  tenantId: string,
  recipient = 'buyer@supplier-real.cn',
  completePublishedRisk = true,
): void {
  store.db.prepare(`INSERT INTO procurement_communication_identities
    (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?, 'active',1,?,?,?,?)`).run(
    tenantId, '李娜', '高级采购专员', '东方制造有限公司',
    'human:manager', 'human:manager', at, at,
  );
  const supplier: Supplier = {
    id: `supplier:${tenantId}`, tenantId, sourceSystem: 'odoo', externalId: `SUP-${tenantId}`, status: 'active',
    createdAt: at, updatedAt: at, name: `供应商 ${tenantId}`, currency: 'CNY',
    ...(completePublishedRisk ? { performanceScore: 0 } : {}),
    contacts: recipient ? [{ id: `contact:${tenantId}`, name: '陈经理', email: recipient, primary: true }] : [],
  };
  const po: PurchaseOrder = {
    id: `po:${tenantId}`, tenantId, sourceSystem: 'odoo', externalId: `PO-${tenantId}`, status: 'sent',
    createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at,
    ...(completePublishedRisk ? { requiredInHouseAt: '2026-08-21T00:00:00.000Z' } : {}),
  };
  const line: PurchaseOrderLine = { id: `line:${tenantId}`, poId: po.id, lineNumber: '10', itemId: `item:${tenantId}`, description: '真实控制阀', uom: 'EA', orderedQty: 2, unitPrice: 100, currency: 'CNY' };
  store.procurement.saveDocument('supplier', supplier);
  store.procurement.saveDocument('purchase_order', po);
  store.procurement.saveLine('purchase_order_line', po.id, line);
  if (completePublishedRisk) {
    store.db.prepare(`INSERT INTO procurement_supplier_operating_profiles
      (tenant_id,supplier_id,version,country_code,route,supplier_type,industry,address_json,primary_material_code,primary_material_name,
       default_lead_time_days,product_criticality,payment_terms,contract_starts_on,contract_ends_on,status,created_at,updated_at)
      VALUES (?,?,1,'CN','local','manufacturer','工业自动化','null','','',7,'high','','2026-01-01','2026-12-31','active',?,?)`)
      .run(tenantId, supplier.id, at, at);
  }
  store.db.prepare(`INSERT INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,'supplier_commitment','stage_entered','active',?,'outbox',?,'connector:email',?,?)`)
    .run(tenantId, `po-stage-event:${tenantId}:commitment`, po.id, at, `outbox:${tenantId}`, JSON.stringify({ exactTransitionTime: true }), at);
}

function publishPolicy(store: ReturnType<typeof openPersistence>, tenantId: string): void {
  store.db.prepare(`INSERT INTO procurement_sla_policies
    (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
    VALUES (?,?,?,?, 'published',1,?,?,?,?,?,?,?)`).run(
      tenantId, `sla:${tenantId}`, '采购执行 SLA V1', '已审批策略', JSON.stringify([rule]),
      'human:manager', 'human:manager', 'human:manager', at, at, at,
    );
}

function publishReadyAdvancedAutoSend(store: ReturnType<typeof openPersistence>, tenantId: string, risks = ['high']): void {
  store.db.prepare(`INSERT INTO procurement_advanced_sla_profiles
    (tenant_id,id,name,status,version,sections_json,auto_send_json,created_by,updated_by,published_by,created_at,updated_at,published_at,schema_version)
    VALUES (?,?,?,'published',3,?,?,?,?,?,?,?,?,2)`).run(
    tenantId, `advanced-sla:${tenantId}`, 'Advanced auto-send', JSON.stringify(advancedSections), JSON.stringify({ enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks }),
    'human:manager', 'human:manager', 'human:manager', at, at, at,
  );
  store.db.prepare(`INSERT INTO procurement_advanced_sla_runtime_controls
    (tenant_id,profile_id,profile_version,paused,version,updated_by,updated_at) VALUES (?,?,3,0,1,?,?)`)
    .run(tenantId, `advanced-sla:${tenantId}`, 'human:manager', at);
  store.db.prepare(`INSERT INTO control_credentials
    (tenant_id,id,connector_id,credential_type,name,encrypted_json,status,last_tested_at,last_error,created_at,updated_at)
    VALUES (?,?,?,'smtp','Email','{}','connected',?,NULL,?,?)`)
    .run(tenantId, `credential:${tenantId}:healthy`, 'email', at, at, at);
  store.db.prepare(`INSERT INTO control_credentials
    (tenant_id,id,connector_id,credential_type,name,encrypted_json,status,last_tested_at,last_error,created_at,updated_at)
    VALUES (?,?,?,'smtp','Other Email','{}','connected',?,'revoked',?,?)`)
    .run(tenantId, `credential:${tenantId}:other`, 'email', at, at, at);
}

test('Advanced SLA never auto-sends from an unpublished RiskModelV2 fallback band', async () => {
  const tenantId = 'tenant:sla-unpublished-risk';
  const store = openPersistence(':memory:', { tenantId });
  seedTenant(store, tenantId, 'buyer@supplier-real.cn', false);
  publishPolicy(store, tenantId);
  publishReadyAdvancedAutoSend(store, tenantId, ['all']);
  const worker = new ProcurementSlaAutomationWorker(store.db, { workerId: 'worker:unpublished-risk', now: () => new Date('2026-08-28T08:00:00.000Z') });
  try {
    const result = await worker.runTenant(tenantId, { force: true });
    assert.equal(result.status, 'completed');
    assert.equal(result.result?.created, 1);
    assert.equal(result.result?.autoQueued, 0, 'a fallback band without a published V2 score must never authorize an external send');
    assert.deepEqual(result.result?.autoBlocked, []);
    assert.deepEqual(result.result?.manualReview, [{
      draftId: (store.db.prepare('SELECT id FROM procurement_message_drafts WHERE tenant_id=?').get(tenantId) as { id: string }).id,
      poId: `po:${tenantId}`,
      reason: 'candidate_risk_not_published',
    }]);
    assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?').get(tenantId) as { count: number }).count), 0);
  } finally { store.close(); }
});

test('SLA automation global preference blocks lease claims and draft creation, including forced runs', async () => {
  const tenantId = 'tenant:sla-disabled-by-general-settings';
  const store = openPersistence(':memory:', { tenantId });
  seedTenant(store, tenantId);
  publishPolicy(store, tenantId);
  store.db.prepare(`INSERT INTO procurement_tenant_preferences
    (tenant_id,country_code,working_days_json,time_zone,date_format,sla_escalations_enabled,exclude_weekends,exclude_public_holidays,auto_calculate_lead_time,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,?,0,1,1,1,1,?,?,?,?)`).run(
      tenantId, 'CN', JSON.stringify([1, 2, 3, 4, 5]), 'Asia/Shanghai', 'YYYY-MM-DD',
      'human:manager', 'human:manager', at, at,
    );
  const worker = new ProcurementSlaAutomationWorker(store.db, { workerId: 'worker:disabled', now: () => new Date('2026-08-28T08:00:00.000Z') });
  try {
    assert.deepEqual(await worker.runTenant(tenantId, { force: true }), { tenantId, status: 'skipped', reason: 'disabled' });
    assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_sla_automation_leases WHERE tenant_id=?').get(tenantId) as { count: number }).count), 0);
    assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_message_drafts WHERE tenant_id=?').get(tenantId) as { count: number }).count), 0);
    assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_sla_automation_runs WHERE tenant_id=?').get(tenantId) as { count: number }).count), 0);
  } finally { store.close(); }
});

test('Advanced SLA automation queues a ready draft once and records only an Outbox-backed decision (catches direct-send or duplicate-queue regressions)', async () => {
  const tenantId = 'tenant:sla-advanced-autosend';
  const store = openPersistence(':memory:', { tenantId });
  seedTenant(store, tenantId); publishPolicy(store, tenantId); publishReadyAdvancedAutoSend(store, tenantId);
  const worker = new ProcurementSlaAutomationWorker(store.db, { workerId: 'worker:advanced', now: () => new Date('2026-08-28T08:00:00.000Z') });
  try {
    const first = await worker.runTenant(tenantId, { force: true });
    assert.equal(first.status, 'completed');
    assert.equal(first.result?.['created'], 1);
    assert.equal(first.result?.['autoQueued'], 1, 'a ready candidate must be represented by exactly one queued Outbox row');
    assert.deepEqual(first.result?.['autoBlocked'], []);
    assert.deepEqual(first.result?.['manualReview'], []);
    const queued = store.db.prepare(`SELECT d.id,d.status,d.reviewed_by,d.outbox_id,o.status AS outbox_status,o.idempotency_key
      FROM procurement_message_drafts d JOIN procurement_outbox o ON o.tenant_id=d.tenant_id AND o.id=d.outbox_id
      WHERE d.tenant_id=?`).all(tenantId) as Array<{ id: string; status: string; reviewed_by: string; outbox_id: string; outbox_status: string; idempotency_key: string }>;
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.status, 'approved_queued');
    assert.equal(queued[0]!.reviewed_by, `ai:advanced-sla:advanced-sla:${tenantId}:v3`);
    assert.equal(queued[0]!.outbox_status, 'pending');
    assert.equal(queued[0]!.idempotency_key, `message_draft.approve:advanced-sla:advanced-sla:${tenantId}:v3:${queued[0]!.id}`);
    const queuedPayload = JSON.parse((store.db.prepare('SELECT payload_json FROM procurement_outbox WHERE tenant_id=? AND id=?').get(tenantId, queued[0]!.outbox_id) as { payload_json: string }).payload_json) as Record<string, unknown>;
    assert.equal(queuedPayload['credentialId'], `credential:${tenantId}:healthy`, 'the live decision must freeze the exact healthy credential');
    const replay = await worker.runTenant(tenantId, { force: true });
    assert.equal(replay.result?.['autoQueued'], 0, 'a replay must not create a second Outbox row');
    assert.equal(Number((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?').get(tenantId) as { count: number }).count), 1);
    const event = store.db.prepare(`SELECT actor_id,detail_json FROM procurement_advanced_sla_runtime_events
      WHERE tenant_id=? AND action='auto_send_decision'`).get(tenantId) as { actor_id: string; detail_json: string } | undefined;
    assert.equal(event?.actor_id, `ai:advanced-sla:advanced-sla:${tenantId}:v3`);
    assert.deepEqual(Object.keys(JSON.parse(event?.detail_json ?? '{}')).sort(), ['actorId', 'decisionCode', 'draftId', 'outboxId', 'poId', 'profileId', 'profileVersion', 'timestamp']);
  } finally { store.close(); }
});

test('Advanced SLA automation events existing drafts after base-SLA or identity revocation (catches early-return and refresh-throw gaps)', async () => {
  for (const scenario of [
    { name: 'base SLA unpublished', revoke: (store: ReturnType<typeof openPersistence>, tenantId: string) => store.db.prepare("UPDATE procurement_sla_policies SET status='retired' WHERE tenant_id=?").run(tenantId), code: 'advanced_sla_not_published' },
    { name: 'identity revoked', revoke: (store: ReturnType<typeof openPersistence>, tenantId: string) => { store.db.prepare("UPDATE procurement_communication_identities SET status='disabled' WHERE tenant_id=?").run(tenantId); store.db.prepare('UPDATE procurement_advanced_sla_runtime_controls SET paused=0 WHERE tenant_id=?').run(tenantId); }, code: 'communication_identity_missing' },
  ] as const) {
    const tenantId = `tenant:sla-revocation:${scenario.name.replaceAll(' ', '-')}`;
    const store = openPersistence(':memory:', { tenantId });
    seedTenant(store, tenantId); publishPolicy(store, tenantId); publishReadyAdvancedAutoSend(store, tenantId);
    store.db.prepare('UPDATE procurement_advanced_sla_runtime_controls SET paused=1 WHERE tenant_id=?').run(tenantId);
    const worker = new ProcurementSlaAutomationWorker(store.db, { workerId: `worker:${scenario.name}`, now: () => new Date('2026-08-28T08:00:00.000Z') });
    try {
      assert.equal((await worker.runTenant(tenantId, { force: true })).result?.created, 1);
      store.db.prepare('UPDATE procurement_advanced_sla_runtime_controls SET paused=0 WHERE tenant_id=?').run(tenantId);
      scenario.revoke(store, tenantId);
      const result = await worker.runTenant(tenantId, { force: true });
      assert.equal(result.status, 'completed', `${scenario.name} must not skip or fail existing candidates`);
      assert.deepEqual(result.result?.autoBlocked, [{
        draftId: (store.db.prepare('SELECT id FROM procurement_message_drafts WHERE tenant_id=?').get(tenantId) as { id: string }).id,
        poId: `po:${tenantId}`,
        decisionCode: scenario.code,
      }]);
      assert.equal((store.db.prepare('SELECT status FROM procurement_message_drafts WHERE tenant_id=?').get(tenantId) as { status: string }).status, 'draft');
      const event = store.db.prepare(`SELECT detail_json FROM procurement_advanced_sla_runtime_events
        WHERE tenant_id=? AND action='auto_send_decision' AND json_extract(detail_json,'$.decisionCode')=?
        ORDER BY created_at DESC,id DESC LIMIT 1`).get(tenantId, scenario.code) as { detail_json: string };
      const detail = JSON.parse(event.detail_json) as Record<string, unknown>;
      assert.equal(detail['decisionCode'], scenario.code);
      assert.equal('body' in detail || 'credentialId' in detail, false, 'runtime events must stay secret-free');
    } finally { store.close(); }
  }
});

test('Advanced SLA pinned credential dispatches only the frozen healthy ID and never falls back after revocation (catches credential substitution)', async () => {
  const tenantId = 'tenant:sla-pinned-credential';
  const store = openPersistence(':memory:', { tenantId });
  seedTenant(store, tenantId); publishPolicy(store, tenantId); publishReadyAdvancedAutoSend(store, tenantId);
  const worker = new ProcurementSlaAutomationWorker(store.db, { workerId: 'worker:pinned', now: () => new Date('2026-08-28T08:00:00.000Z') });
  try {
    await worker.runTenant(tenantId, { force: true });
    const outbox = store.db.prepare('SELECT id,payload_json FROM procurement_outbox WHERE tenant_id=?').get(tenantId) as { id: string; payload_json: string };
    assert.equal((JSON.parse(outbox.payload_json) as Record<string, unknown>)['credentialId'], `credential:${tenantId}:healthy`);
    let executed = 0;
    const pinnedWorker = new ProcurementOutboxWorker(store.db, () => ({
      listCredentials: () => [
        { id: `credential:${tenantId}:other`, connectorId: 'email', status: 'connected' },
        { id: `credential:${tenantId}:healthy`, connectorId: 'email', status: 'connected' },
      ],
      getCredential: (id) => id === `credential:${tenantId}:healthy` ? { account: 'healthy' } : { account: 'other' },
      execute: async (_connectorId, action, _input, context) => { executed += 1; assert.equal(action, 'send'); assert.deepEqual(context.credentials, { account: 'healthy' }); return { ok: true, output: { message_id: 'pinned-ok' } }; },
    }), { now: () => new Date('2026-08-28T08:01:00.000Z') });
    assert.equal((await pinnedWorker.runTenant(tenantId)).dispatched, 1);
    assert.equal(executed, 1);

    const secondTenant = `${tenantId}:revoked`;
    const secondStore = openPersistence(':memory:', { tenantId: secondTenant });
    seedTenant(secondStore, secondTenant); publishPolicy(secondStore, secondTenant); publishReadyAdvancedAutoSend(secondStore, secondTenant);
    try {
      await new ProcurementSlaAutomationWorker(secondStore.db, { workerId: 'worker:pinned-revoked', now: () => new Date('2026-08-28T08:00:00.000Z') }).runTenant(secondTenant, { force: true });
      let substituteCalls = 0;
      const revokedWorker = new ProcurementOutboxWorker(secondStore.db, () => ({
        listCredentials: () => [
          { id: `credential:${secondTenant}:other`, connectorId: 'email', status: 'connected' },
          { id: `credential:${secondTenant}:healthy`, connectorId: 'email', status: 'failed' },
        ],
        getCredential: (id) => id === `credential:${secondTenant}:other` ? { account: 'other' } : undefined,
        execute: async () => { substituteCalls += 1; return { ok: true }; },
      }), { now: () => new Date('2026-08-28T08:01:00.000Z') });
      const result = await revokedWorker.runTenant(secondTenant);
      assert.equal(result.dispatched, 0); assert.equal(result.failed, 1); assert.equal(substituteCalls, 0, 'a pinned unhealthy credential must not fall back to another credential');
      assert.equal((secondStore.db.prepare('SELECT status FROM procurement_outbox WHERE tenant_id=?').get(secondTenant) as { status: string }).status, 'failed');
    } finally { secondStore.close(); }
  } finally { store.close(); }
});

test('SLA 自动检查：持久化租约、幂等草稿、过期接管、跟进计数和租户隔离', async () => {
  const tenantId = 'tenant:sla-automation';
  const store = openPersistence(':memory:', { tenantId });
  seedTenant(store, tenantId);
  const now = new Date('2026-08-28T08:00:00.000Z');
  const worker = new ProcurementSlaAutomationWorker(store.db, { workerId: 'worker:a', intervalSeconds: 300, now: () => now });
  try {
    const withoutPolicy = await worker.runTenant(tenantId);
    assert.deepEqual(withoutPolicy, { tenantId, status: 'skipped', reason: 'no_published_policy' });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM procurement_sla_automation_leases').get()?.['count'], 0);

    publishPolicy(store, tenantId);
    const first = await worker.runTenant(tenantId);
    assert.equal(first.status, 'completed');
    assert.equal(first.result?.examined, 1);
    assert.equal(first.result?.created, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM procurement_message_drafts WHERE tenant_id=?').get(tenantId)?.['count'], 1);

    const beforeDue = await worker.runTenant(tenantId);
    assert.equal(beforeDue.reason, 'not_due');
    const replay = await worker.runTenant(tenantId, { force: true, actorId: 'human:buyer' });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.result?.created, 0, '相同 SLA 指纹不得重复生成草稿');

    store.db.prepare(`UPDATE procurement_sla_automation_leases SET lease_owner='worker:held',lease_token='held',lease_expires_at=? WHERE tenant_id=?`)
      .run('2026-08-28T08:10:00.000Z', tenantId);
    assert.equal((await worker.runTenant(tenantId, { force: true })).reason, 'lease_held');

    store.db.prepare(`INSERT INTO procurement_sla_automation_runs
      (tenant_id,id,worker_id,status,started_at,created_at) VALUES (?,?,?,'running',?,?)`)
      .run(tenantId, 'run:expired', 'worker:dead', '2026-08-28T07:00:00.000Z', '2026-08-28T07:00:00.000Z');
    store.db.prepare(`UPDATE procurement_sla_automation_leases SET lease_expires_at='2026-08-28T07:30:00.000Z' WHERE tenant_id=?`).run(tenantId);
    assert.equal((await worker.runTenant(tenantId, { force: true })).status, 'completed');
    assert.equal(store.db.prepare('SELECT status FROM procurement_sla_automation_runs WHERE tenant_id=? AND id=?').get(tenantId, 'run:expired')?.['status'], 'abandoned');

    const draft = store.db.prepare('SELECT id FROM procurement_message_drafts WHERE tenant_id=?').get(tenantId) as { id: string };
    store.db.prepare("UPDATE procurement_message_drafts SET status='discarded' WHERE tenant_id=? AND id=?").run(tenantId, draft.id);
    await worker.runTenant(tenantId, { force: true });
    assert.equal(store.db.prepare('SELECT followup_count FROM procurement_sla_evaluations WHERE tenant_id=?').get(tenantId)?.['followup_count'], 0, '未发送/已丢弃草稿不是对供应商的真实跟进');
    store.db.prepare("UPDATE procurement_message_drafts SET status='sent',sent_at=? WHERE tenant_id=? AND id=?").run(now.toISOString(), tenantId, draft.id);
    await worker.runTenant(tenantId, { force: true });
    assert.equal(store.db.prepare('SELECT followup_count FROM procurement_sla_evaluations WHERE tenant_id=?').get(tenantId)?.['followup_count'], 1, '只有连接器确认的 sent 事实才计数');

    assert.equal((await worker.runTenant('tenant:other')).reason, 'no_published_policy');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM procurement_sla_automation_leases WHERE tenant_id=?').get('tenant:other')?.['count'], 0);
  } finally { store.close(); }
});

test('SLA 自动检查：失败会释放租约并持久化退避', async () => {
  const tenantId = 'tenant:sla-failure';
  const store = openPersistence(':memory:', { tenantId });
  seedTenant(store, tenantId); publishPolicy(store, tenantId);
  store.db.exec('DROP TABLE procurement_sla_evaluations');
  const worker = new ProcurementSlaAutomationWorker(store.db, { workerId: 'worker:failure', intervalSeconds: 300, now: () => new Date('2026-08-28T08:00:00.000Z') });
  try {
    const result = await worker.runTenant(tenantId, { force: true });
    assert.equal(result.status, 'failed');
    const lease = store.db.prepare('SELECT lease_token,last_status,consecutive_failures,next_run_at FROM procurement_sla_automation_leases WHERE tenant_id=?').get(tenantId) as Record<string, unknown>;
    assert.equal(lease['lease_token'], null); assert.equal(lease['last_status'], 'failed'); assert.equal(lease['consecutive_failures'], 1);
    assert.equal(lease['next_run_at'], '2026-08-28T08:05:00.000Z');
  } finally { store.close(); }
});

test('SLA 自动检查：API 权限与运行状态读取', async () => {
  const tenantId = 'tenant:sla-api';
  const store = openPersistence(':memory:', { tenantId });
  seedTenant(store, tenantId); publishPolicy(store, tenantId);
  const buyer: Session = { username: 'buyer', tenantId, humanId: 'human:buyer', name: '采购员', role: '采购专员', expiresAt: Date.now() + 60_000 };
  const denied: Session = { ...buyer, role: '访客' };
  const server = createServer((req, res) => {
    const token = String(req.headers.authorization ?? '').replace('Bearer ', '');
    const session = token === 'buyer' ? buyer : token === 'denied' ? denied : null;
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleProcurementSlaAutomationRequest(req, res, path, req.method ?? 'GET', { db: store.db, session, now: () => new Date('2026-08-28T08:00:00.000Z') });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, method: string, token?: string) {
    const response = await fetch(`${base}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  try {
    assert.equal((await request('/api/procurement/sla/automation', 'GET')).status, 401);
    assert.equal((await request('/api/procurement/sla/automation', 'GET', 'denied')).status, 403);
    const initial = await request('/api/procurement/sla/automation', 'GET', 'buyer');
    assert.equal(initial.status, 200); assert.equal(initial.body['status'], 'not_started');
    const run = await request('/api/procurement/sla/automation/run', 'POST', 'buyer');
    assert.equal(run.status, 200, JSON.stringify(run.body)); assert.equal(run.body['automation']['status'], 'scheduled');
    store.db.prepare(`INSERT INTO procurement_tenant_preferences
      (tenant_id,country_code,working_days_json,time_zone,date_format,sla_escalations_enabled,exclude_weekends,exclude_public_holidays,auto_calculate_lead_time,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,?,0,1,1,1,1,?,?,?,?)`).run(
        tenantId, 'CN', JSON.stringify([1, 2, 3, 4, 5]), 'Asia/Shanghai', 'YYYY-MM-DD', 'human:manager', 'human:manager', at, at,
      );
    const disabled = await request('/api/procurement/sla/automation', 'GET', 'buyer');
    assert.equal(disabled.body['status'], 'disabled');
    assert.equal(disabled.body['enabled'], false);
    assert.equal(disabled.body['preferenceVersion'], 1);
    const blockedRun = await request('/api/procurement/sla/automation/run', 'POST', 'buyer');
    assert.equal(blockedRun.status, 409);
    assert.equal(blockedRun.body['result']['reason'], 'disabled');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); store.close();
  }
});

test('SLA 自动检查：重启后恢复运行和草稿事实', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-sla-automation-'));
  const path = join(directory, 'readywork.sqlite');
  const tenantId = 'tenant:sla-restart';
  try {
    const firstStore = openPersistence(path, { tenantId });
    seedTenant(firstStore, tenantId); publishPolicy(firstStore, tenantId);
    const worker = new ProcurementSlaAutomationWorker(firstStore.db, { workerId: 'worker:before-restart', now: () => new Date('2026-08-28T08:00:00.000Z') });
    assert.equal((await worker.runTenant(tenantId)).result?.created, 1);
    firstStore.close();

    const restored = openPersistence(path, { tenantId });
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS count FROM procurement_sla_automation_runs WHERE tenant_id=? AND status=?').get(tenantId, 'completed')?.['count'], 1);
    assert.equal(restored.db.prepare('SELECT COUNT(*) AS count FROM procurement_message_drafts WHERE tenant_id=?').get(tenantId)?.['count'], 1);
    const replay = new ProcurementSlaAutomationWorker(restored.db, { workerId: 'worker:after-restart', now: () => new Date('2026-08-28T08:10:00.000Z') });
    assert.equal((await replay.runTenant(tenantId, { force: true })).result?.created, 0);
    restored.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
