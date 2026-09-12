import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PurchaseOrder, Supplier } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { buildPoHistoryEvents } from '../src/procurement-po-history.js';

const at = '2026-09-06T08:00:00.000Z';

test('projects activity and blocked outbox codes emitted by the real repository without claiming delivery succeeded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-po-history-'));
  const store = openPersistence(join(directory, 'history.sqlite'), { tenantId: 'tenant:test:po-history' });
  try {
    const tenantId = 'tenant:test:po-history';
    const actorId = 'human:test:po-history-manager';
    const repository = createProcurementRepository(store.db, tenantId);
    const supplier: Supplier = {
      id: 'supplier:test:po-history', tenantId, sourceSystem: 'readywork', externalId: 'SUPPLIER-HISTORY',
      status: 'active', createdAt: at, updatedAt: at, name: '历史投影测试供应商', currency: 'CNY',
      contacts: [{ id: 'contact:test:po-history', name: '测试联系人', email: 'history@example.test', primary: true }],
    };
    repository.saveDocument('supplier', supplier);
    const po = (id: string, status: PurchaseOrder['status']): PurchaseOrder => ({
      id, tenantId, sourceSystem: 'readywork', externalId: id.toUpperCase(), status,
      createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at,
    });
    const riskPo = po('po:test:history-risk', 'sent');
    const sendPo = po('po:test:history-send', 'draft');
    repository.saveDocument('purchase_order', riskPo);
    repository.saveDocument('purchase_order', sendPo);
    store.db.prepare(`INSERT INTO procurement_communication_identities
      (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?, 'active',1,?,?,?,?)`).run(
      tenantId, '历史投影测试采购经理', '采购经理', '历史投影测试租户', actorId, actorId, at, at,
    );

    repository.executeProcurementMutation({
      action: 'mark_at_risk', idempotencyKey: 'history-risk', payloadHash: 'history-risk-v1',
      actorId, permission: 'operate', aggregateId: riskPo.id, expectedVersion: 1, occurredAt: at,
      riskSeverity: 'high', riskCategory: 'schedule', reason: '供应商原文：Line 4 tooling is delayed.',
    });
    const send = repository.executeProcurementMutation({
      action: 'send_po', idempotencyKey: 'history-send', payloadHash: 'history-send-v1',
      actorId, permission: 'operate', aggregateId: sendPo.id, expectedVersion: 1, occurredAt: '2026-09-06T08:01:00.000Z',
      connectorId: 'email', connectorReady: false,
    });
    const activityRows = store.db.prepare('SELECT json FROM runtime_activities WHERE tenant_id=? AND object_id=?')
      .all(tenantId, riskPo.id).map((row) => JSON.parse(String(row['json'])) as Record<string, unknown>);

    const events = buildPoHistoryEvents(activityRows, [send.outbox!], []);

    assert.deepEqual(events.map(({ id, type, typeLabel, label, state, summary }) => ({ id, type, typeLabel, label, state, summary })), [
      {
        id: send.outbox!.id,
        type: 'purchase_order.send',
        typeLabel: '采购订单发送',
        label: '采购订单发送（已阻断）',
        state: 'blocked',
        summary: null,
      },
      {
        id: activityRows[0]!['id'],
        type: 'purchase_order.marked_at_risk',
        typeLabel: '采购订单风险标记',
        label: '采购订单风险标记',
        state: null,
        summary: '采购订单已人工标记为高风险',
      },
    ]);
    assert.deepEqual(
      events.map(({ source, at: eventAt, actor }) => ({ source, at: eventAt, actor })),
      [
        { source: 'outbox', at: '2026-09-06T08:01:00.000Z', actor: null },
        { source: 'activity', at, actor: actorId },
      ],
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps the legacy followup type normalization and labels pending as unfinished', () => {
  const events = buildPoHistoryEvents([], [{
    id: 'outbox:followup', action: 'purchase_order.followup', status: 'pending',
    createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:01:00.000Z',
  }], []);

  assert.deepEqual(events[0], {
    id: 'outbox:followup',
    type: 'purchase_order_followup',
    typeLabel: '采购订单跟进',
    label: '采购订单跟进（待处理）',
    at: '2026-09-06T10:01:00.000Z',
    actor: null,
    source: 'outbox',
    state: 'pending',
    summary: null,
  });
});

test('preserves stable ids, actors, times and states exactly instead of treating them as display names', () => {
  const id = `activity:${'stable-id-segment-'.repeat(10)}`;
  const actor = `  connector:${'identity-segment-'.repeat(10)}  `;
  const eventAt = `2026-09-06T10:01:00.000Z${'#source-clock'.repeat(10)}`;
  const state = `pending:${'source-state-'.repeat(10)}`;

  const events = buildPoHistoryEvents([{
    id, action: 'approval.requested', at: eventAt, actor, state, summary: '保留原始身份与时间',
  }], [], []);

  assert.equal(events[0]?.id, id);
  assert.equal(events[0]?.actor, actor);
  assert.equal(events[0]?.at, eventAt);
  assert.equal(events[0]?.state, state);
});

test('uses each amendment row state and preserves its original business reason', () => {
  const events = buildPoHistoryEvents([], [], [
    {
      id: 'amendment:requested', action: 'edit', state: 'requested', actor_id: 'human:buyer',
      reason: 'Supplier wording: keep the requested delivery date.',
      created_at: '2026-09-06T08:00:00.000Z', updated_at: '2026-09-06T08:00:00.000Z', applied_at: null,
    },
    {
      id: 'amendment:applied', action: 'edit', state: 'applied', actor_id: 'connector:odoo',
      reason: '业务原文：Odoo readback matched.',
      created_at: '2026-09-06T08:01:00.000Z', updated_at: '2026-09-06T08:02:00.000Z', applied_at: '2026-09-06T08:03:00.000Z',
    },
    {
      id: 'cancel:pending', action: 'cancel', state: 'queued', actor_id: 'human:manager', reason: '项目暂停，等待 ERP 确认',
      created_at: '2026-09-06T08:04:00.000Z', updated_at: '2026-09-06T08:04:00.000Z', applied_at: null,
    },
  ]);

  assert.deepEqual(events.map(({ id, type, typeLabel, label, state, summary }) => ({ id, type, typeLabel, label, state, summary })), [
    {
      id: 'cancel:pending', type: 'purchase_order_cancellation_queued', typeLabel: '采购订单取消',
      label: '采购订单取消（已排队）', state: 'queued', summary: '项目暂停，等待 ERP 确认',
    },
    {
      id: 'amendment:applied', type: 'purchase_order_amendment_applied', typeLabel: '采购订单修改',
      label: '采购订单修改（已应用）', state: 'applied', summary: '业务原文：Odoo readback matched.',
    },
    {
      id: 'amendment:requested', type: 'purchase_order_amendment_requested', typeLabel: '采购订单修改',
      label: '采购订单修改（已申请）', state: 'requested', summary: 'Supplier wording: keep the requested delivery date.',
    },
  ]);
});

test('maps common approval, stage, SLA and route codes while retaining unknown actions and deterministic ordering', () => {
  const events = buildPoHistoryEvents([
    { id: 'event:approval', action: 'approval.requested', at: '2026-09-06T09:00:00.000Z', actor: 'system', summary: '原始审批摘要' },
    { id: 'event:stage', action: 'stage_entered', at: '2026-09-06T09:00:00.000Z', actor: 'system', summary: 'Stage source summary' },
    { id: 'event:sla', action: 'sla_breach', at: '2026-09-06T09:00:00.000Z', actor: 'system', summary: 'SLA source summary' },
    { id: 'event:route', action: 'route_assigned', at: '2026-09-06T09:00:00.000Z', actor: 'human:buyer', summary: 'Route source summary' },
    { id: 'event:unknown', action: 'supplier.portal.custom_ack', at: '2026-09-06T09:00:00.000Z', actor: 'supplier:portal', summary: 'Do not translate this supplier note.' },
    { id: 'event:reviewed', action: 'po.reviewed', at: '2026-09-06T09:01:00.000Z', actor: 'ai:procurement', summary: '原始复核结论' },
  ], [], []);

  assert.deepEqual(events.map(({ id, type, typeLabel, label, summary }) => ({ id, type, typeLabel, label, summary })), [
    { id: 'event:reviewed', type: 'purchase_order_reviewed', typeLabel: '采购订单复核', label: '采购订单复核', summary: '原始复核结论' },
    { id: 'event:approval', type: 'approval.requested', typeLabel: '审批请求', label: '审批请求', summary: '原始审批摘要' },
    { id: 'event:route', type: 'route_assigned', typeLabel: '采购路径分配', label: '采购路径分配', summary: 'Route source summary' },
    { id: 'event:sla', type: 'sla_breach', typeLabel: 'SLA 超时', label: 'SLA 超时', summary: 'SLA source summary' },
    { id: 'event:stage', type: 'stage_entered', typeLabel: '采购阶段进入', label: '采购阶段进入', summary: 'Stage source summary' },
    { id: 'event:unknown', type: 'supplier.portal.custom_ack', typeLabel: 'supplier.portal.custom_ack', label: 'supplier.portal.custom_ack', summary: 'Do not translate this supplier note.' },
  ]);
});

test('omits inferred document-status observations from History while retaining real stage events', () => {
  const events = buildPoHistoryEvents([], [], [], {
    stageEvents: [
      {
        id: 'stage:inferred-document-status', event_type: 'observed_document_status', state: 'active',
        occurred_at: '2026-09-06T13:00:00.000Z', source_kind: 'document_snapshot', source_id: 'odoo:PO-42:v7',
        actor_id: 'source:odoo', evidence_json: JSON.stringify({ exactTransitionTime: false, observedStatus: 'sent' }),
      },
      {
        id: 'stage:exact-document-status', event_type: 'observed_document_status', state: 'active',
        occurred_at: '2026-09-06T12:00:00.000Z', source_kind: 'document_snapshot', source_id: 'odoo:PO-42:event-9',
        actor_id: 'connector:odoo', evidence_json: JSON.stringify({ exactTransitionTime: true, observedStatus: 'sent' }),
      },
      {
        id: 'stage:supplier-confirmed', event_type: 'confirmation_accepted', state: 'completed',
        occurred_at: '2026-09-06T11:00:00.000Z', source_kind: 'communication', source_id: 'communication:42',
        actor_id: 'human:buyer', evidence_json: JSON.stringify({ exactTransitionTime: false, reason: 'Buyer verified the reply.' }),
      },
    ],
  });

  assert.deepEqual(events.map((event) => event.id), [
    'stage:exact-document-status',
    'stage:supplier-confirmed',
  ]);
});

test('projects every persisted PO event source with immutable evidence references and original business text', () => {
  const events = buildPoHistoryEvents([], [], [], {
    stageEvents: [{
      id: 'stage:event:1', event_type: 'supplier_difference_received', state: 'blocked',
      occurred_at: '2026-09-06T14:05:00.000Z', source_kind: 'communication', source_id: 'communication:1',
      actor_id: 'connector:email', evidence_json: JSON.stringify({ exactTransitionTime: true, reason: 'Supplier note: line 4 date differs.' }),
    }],
    routeEvents: [{
      id: 'route:event:1', actor_id: 'human:buyer', action: 'route_assigned',
      detail_json: JSON.stringify({ previousRoute: 'local', route: 'import', reason: '合同原文：FOB Ningbo' }),
      created_at: '2026-09-06T14:04:00.000Z',
    }],
    routeEvidenceEvents: [{
      id: 'route-evidence:event:1', document_id: 'route-document:1', actor_id: 'human:buyer', action: 'route_evidence_bound',
      detail_json: JSON.stringify({ reference: 'Contract section 9.2', note: 'Keep source wording.' }),
      created_at: '2026-09-06T14:03:00.000Z',
    }],
    slaEvents: [{
      id: 'sla:event:1', policy_id: 'sla-policy:1', rule_id: 'sla-rule:1', action: 'evaluation_changed',
      detail_json: JSON.stringify({ actorId: 'system:sla', status: 'breached', reason: '等待供应商确认超时' }),
      created_at: '2026-09-06T14:02:00.000Z',
    }],
    importDocumentEvents: [{
      id: 'import-document:event:1', import_document_id: 'import-document:1', actor_id: 'human:import-buyer', action: 'document_bound',
      detail_json: JSON.stringify({ status: 'active', summary: 'Packing list PL-204 attached.' }),
      created_at: '2026-09-06T14:01:00.000Z',
    }],
    quantityEvents: [{
      source_system: 'odoo', source_event_id: 'receipt:42', po_line_id: 'po-line:1', dimension: 'received', delta: 8,
      occurred_at: '2026-09-06T14:00:00.000Z', json: JSON.stringify({ sourceEntityId: 'grn:42', sourceRevision: '7', note: '仓库原文：8 cartons received.' }),
    }],
  });

  assert.deepEqual(events.map(({ id, source, type, typeLabel, label, at: eventAt, actor, state, summary, evidence }) => ({
    id, source, type, typeLabel, label, at: eventAt, actor, state, summary, evidence,
  })), [
    {
      id: 'stage:event:1', source: 'stage', type: 'supplier_difference_received', typeLabel: '收到供应商差异',
      label: '收到供应商差异（已阻断）', at: '2026-09-06T14:05:00.000Z', actor: 'connector:email', state: 'blocked',
      summary: 'Supplier note: line 4 date differs.',
      evidence: { sourceKind: 'communication', sourceId: 'communication:1', details: { exactTransitionTime: true, reason: 'Supplier note: line 4 date differs.' } },
    },
    {
      id: 'route:event:1', source: 'route', type: 'route_assigned', typeLabel: '采购路径分配', label: '采购路径分配',
      at: '2026-09-06T14:04:00.000Z', actor: 'human:buyer', state: null, summary: '合同原文：FOB Ningbo',
      evidence: { details: { previousRoute: 'local', route: 'import', reason: '合同原文：FOB Ningbo' } },
    },
    {
      id: 'route-evidence:event:1', source: 'route_evidence', type: 'route_evidence_bound', typeLabel: '采购路径证据绑定', label: '采购路径证据绑定',
      at: '2026-09-06T14:03:00.000Z', actor: 'human:buyer', state: null, summary: 'Keep source wording.',
      evidence: { documentId: 'route-document:1', details: { reference: 'Contract section 9.2', note: 'Keep source wording.' } },
    },
    {
      id: 'sla:event:1', source: 'sla', type: 'evaluation_changed', typeLabel: 'SLA 评估更新', label: 'SLA 评估更新（已超时）',
      at: '2026-09-06T14:02:00.000Z', actor: 'system:sla', state: 'breached', summary: '等待供应商确认超时',
      evidence: { policyId: 'sla-policy:1', ruleId: 'sla-rule:1', details: { actorId: 'system:sla', status: 'breached', reason: '等待供应商确认超时' } },
    },
    {
      id: 'import-document:event:1', source: 'import_document', type: 'document_bound', typeLabel: '进口单证绑定', label: '进口单证绑定（生效）',
      at: '2026-09-06T14:01:00.000Z', actor: 'human:import-buyer', state: 'active', summary: 'Packing list PL-204 attached.',
      evidence: { importDocumentId: 'import-document:1', details: { status: 'active', summary: 'Packing list PL-204 attached.' } },
    },
    {
      id: 'quantity:odoo:receipt:42', source: 'quantity', type: 'procurement_po_line_quantity.received', typeLabel: '收货数量更新', label: '收货数量更新',
      at: '2026-09-06T14:00:00.000Z', actor: null, state: null, summary: '仓库原文：8 cartons received.',
      evidence: { poLineId: 'po-line:1', sourceSystem: 'odoo', sourceEventId: 'receipt:42', dimension: 'received', delta: 8, details: { sourceEntityId: 'grn:42', sourceRevision: '7', note: '仓库原文：8 cartons received.' } },
    },
  ]);
});
