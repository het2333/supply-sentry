import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PurchaseOrder, PurchaseOrderLine } from '@readywork/core';
import { openPersistence } from '@readywork/persistence';
import { procurementV1Readiness } from '../src/procurement-v1-readiness.js';

const readyOperations = {
  queue: { workerReady: true, pollerCount: 1, deadLetter: 0, staleRuns: 0 },
  sideEffects: { failed: 0, manualReconciliation: 0, expiredLeases: 0 },
  outbox: { failed: 0, blocked: 0, expiredLeases: 0 },
  documents: {
    failed: 0, expiredLeases: 0, pendingMalwareScan: 0, quarantined: 0, scanFailed: 0,
    malwareScanner: { status: 'ready' },
  },
  manufacturingContext: {
    workerReady: true,
    lastHeartbeatAt: '2026-08-28T07:59:59.000Z',
    pollIntervalMs: 3_000,
  },
};

test('V1 发布就绪：所有门槛由真实租户事实统一计算', () => {
  const tenantId = 'tenant:v1-ready';
  const store = openPersistence(':memory:', { tenantId });
  const at = '2026-08-28T08:00:00.000Z';
  const completePo = purchaseOrder(tenantId, 'po:closed', 'P-CLOSED', 'received', at);
  store.procurement.saveDocument('purchase_order', completePo);
  store.procurement.saveLine('purchase_order_line', completePo.id, purchaseOrderLine(completePo.id, 'line:closed'));

  store.db.prepare(`INSERT INTO procurement_communication_identities
    (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,'active',1,?,?,?,?)`).run(
    tenantId, '王敏', '采购经理', '真实制造有限公司', 'human:manager', 'human:manager', at, at,
  );
  store.db.prepare(`INSERT INTO procurement_sla_policies
    (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
    VALUES (?,?,?,?,'published',2,?,?,?,?,?,?,?)`).run(
    tenantId, 'sla:v1', '采购执行 SLA V1', '五阶段正式策略', '[]', 'human:manager', 'human:manager', 'human:manager', at, at, at,
  );
  const credential = store.db.prepare(`INSERT INTO control_credentials
    (tenant_id,id,connector_id,credential_type,name,encrypted_json,status,last_tested_at,last_error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'connected',?,NULL,?,?)`);
  credential.run(tenantId, 'credential:email', 'email', 'emailCredential', '企业采购邮箱', '{}', at, at, at);
  credential.run(tenantId, 'credential:erp', 'erp', 'erpCredential', '本地 Odoo', '{}', at, at, at);
  store.db.prepare(`INSERT INTO procurement_inbound_mail_status
    (tenant_id,configured,connected,provider,mailbox,last_started_at,last_completed_at,last_status,last_handled_count,last_error,next_poll_at,consecutive_failures,updated_at)
    VALUES (?,1,1,'imap:imap.example.com','buyer@example.com',?,?,'completed',1,NULL,NULL,0,?)`)
    .run(tenantId, at, at, at);

  const route = store.db.prepare(`INSERT INTO procurement_route_assignments
    (tenant_id,po_id,route,source,evidence_json,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,'local','manual',?,1,'human:manager','human:manager',?,?)`);
  route.run(tenantId, completePo.id, JSON.stringify({ reason: '供应商与交付地均在国内' }), at, at);

  const stage = store.db.prepare(`INSERT INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,?,?,'completed',?,?,?,?,?,?)`);
  const facts = [
    ['po_sent', 'connector_delivery_confirmed', 'outbox', 'outbox:1', 'connector:email'],
    ['supplier_commitment', 'confirmation_accepted', 'confirmation', 'confirmation:1', 'supplier:real'],
    ['fulfilment_production', 'production_ready_to_ship', 'manual_verified_production_progress', 'progress:1', 'human:buyer'],
    ['dispatch_transit', 'final_arrival_recorded', 'odoo_grn', 'receipt:1', 'connector:odoo'],
    ['delivery_grn', 'grn_completed', 'odoo_grn', 'receipt:1', 'connector:odoo'],
  ] as const;
  facts.forEach(([stageName, eventType, sourceKind, sourceId, actorId], index) => stage.run(
    tenantId, `stage:${index}`, completePo.id, stageName, eventType, at, sourceKind, sourceId, actorId,
    JSON.stringify({ exactTransitionTime: true }), at,
  ));

  const result = procurementV1Readiness(store.db, tenantId, readyOperations, new Date(at));
  assert.equal(result.status, 'ready');
  assert.equal(result.readyGates, result.totalGates);
  assert.equal(result.totalGates, 11);
  assert.equal(result.deploymentMode, 'odoo_connected');
  assert.deepEqual(result.portfolio, {
    totalPurchaseOrders: 1,
    activePurchaseOrders: 0,
    local: 0,
    import: 0,
    unclassified: 0,
    byStage: { po_sent: 0, supplier_commitment: 0, fulfilment_production: 0, dispatch_transit: 0, delivery_grn: 0 },
    fiveStageClosedLoop: 1,
  });
  store.close();
});

test('V1 发布就绪：纯邮箱模式不要求 Odoo，但要求已核验邮箱 PO，并接受人工核验仓库 GRN', () => {
  const tenantId = 'tenant:v1-email-only';
  const store = openPersistence(':memory:', { tenantId });
  const at = '2026-08-28T08:00:00.000Z';
  const po = { ...purchaseOrder(tenantId, 'po:email:closed', 'EMAIL-PO-1', 'received', at), sourceSystem: 'email-intake' };
  store.procurement.saveDocument('purchase_order', po);
  store.procurement.saveLine('purchase_order_line', po.id, purchaseOrderLine(po.id, 'line:email-closed'));
  store.db.prepare(`INSERT INTO procurement_deployment_profiles
    (tenant_id,mode,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,'email_only',1,'human:manager','human:manager',?,?)`).run(tenantId, at, at);
  store.db.prepare(`INSERT INTO procurement_po_intake_candidates
    (tenant_id,id,provider,mailbox,provider_uid,message_id,sender,subject,received_at,attachment_id,status,warnings_json,accepted_po_id,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'accepted','[]',?,1,'connector:email','human:manager',?,?)`).run(
    tenantId, 'intake:1', 'imap:test', 'INBOX', 'uid:1', '<message-1@test>', 'supplier@test.cn', 'PO EMAIL-PO-1', at, 'attachment:1', po.id, at, at,
  );
  store.db.prepare(`INSERT INTO procurement_route_assignments
    (tenant_id,po_id,route,source,evidence_json,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,'local','manual',?,1,'human:manager','human:manager',?,?)`)
    .run(tenantId, po.id, JSON.stringify({ reason: '已核验本地交付路线' }), at, at);
  const stage = store.db.prepare(`INSERT INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,?,?,'completed',?,?,?,?,?,?)`);
  const facts = [
    ['po_sent', 'connector_delivery_confirmed', 'outbox', 'outbox:email', 'connector:email'],
    ['supplier_commitment', 'confirmation_accepted', 'confirmation', 'confirmation:email', 'supplier:real'],
    ['fulfilment_production', 'production_ready_to_ship', 'manual_verified_production_progress', 'progress:email', 'human:buyer'],
    ['dispatch_transit', 'final_arrival_recorded', 'manual_verified_grn', 'receipt:email', 'human:manager'],
    ['delivery_grn', 'grn_completed', 'manual_verified_grn', 'receipt:email', 'human:manager'],
  ] as const;
  facts.forEach(([stageName, eventType, sourceKind, sourceId, actorId], index) => stage.run(
    tenantId, `stage:email:${index}`, po.id, stageName, eventType, at, sourceKind, sourceId, actorId,
    JSON.stringify({ exactTransitionTime: true, evidenceReference: 'warehouse:GRN-EMAIL-1', verificationReason: '已核验仓库收货单原件' }), at,
  ));

  const result = procurementV1Readiness(store.db, tenantId, readyOperations, new Date(at));
  assert.equal(result.deploymentMode, 'email_only');
  assert.equal(result.gates.find((gate) => gate.id === 'odoo')?.status, 'ready');
  assert.match(result.gates.find((gate) => gate.id === 'odoo')?.label ?? '', /纯邮箱/);
  assert.equal(result.gates.find((gate) => gate.id === 'five_stage_closed_loop')?.status, 'ready');
  assert.equal(result.portfolio.fiveStageClosedLoop, 1);
  store.close();
});

test('V1 发布就绪：IMAP 限流、未处置安全事件和迁移阶段事实不得误报 ready', () => {
  const tenantId = 'tenant:v1-blocked';
  const store = openPersistence(':memory:', { tenantId });
  const at = '2026-08-28T08:00:00.000Z';
  const po = purchaseOrder(tenantId, 'po:migration-only', 'P-MIGRATION', 'received', at);
  store.procurement.saveDocument('purchase_order', po);
  store.procurement.saveLine('purchase_order_line', po.id, purchaseOrderLine(po.id, 'line:migration-only'));
  store.db.prepare(`INSERT INTO procurement_inbound_mail_status
    (tenant_id,configured,connected,provider,mailbox,last_started_at,last_completed_at,last_status,last_handled_count,last_error,next_poll_at,consecutive_failures,updated_at)
    VALUES (?,1,1,'imap:imap.163.com','buyer@example.com',?,?,'failed',0,'IMAP FETCH volume limit exceeded','2026-08-28T09:00:00.000Z',12,?)`)
    .run(tenantId, at, at, at);
  store.db.prepare(`INSERT INTO control_security_events
    (tenant_id,event_type,severity,request_id,method,path,actor_id,message,created_at)
    VALUES (?,'authorization_denied','warning','request:1','POST','/api/procurement','human:buyer','权限拒绝',?)`)
    .run(tenantId, at);

  const result = procurementV1Readiness(store.db, tenantId, readyOperations, new Date(at));
  assert.equal(result.status, 'blocked');
  assert.equal(result.portfolio.fiveStageClosedLoop, 0);
  assert.equal(result.gates.find((gate) => gate.id === 'inbound_email')?.status, 'blocked');
  assert.match(result.gates.find((gate) => gate.id === 'inbound_email')?.summary ?? '', /限流|退避/);
  assert.equal(result.gates.find((gate) => gate.id === 'security_events')?.status, 'blocked');
  assert.equal(result.gates.find((gate) => gate.id === 'five_stage_closed_loop')?.status, 'blocked');
  store.close();
});

test('V1 发布就绪：IMAP 正常轮询期间沿用最近一次成功结果', () => {
  const tenantId = 'tenant:v1-imap-running';
  const store = openPersistence(':memory:', { tenantId });
  const checkedAt = '2026-08-28T08:00:00.000Z';
  const lastCompletedAt = '2026-08-28T07:59:45.500Z';
  const currentStartedAt = '2026-08-28T07:59:59.500Z';
  store.db.prepare(`INSERT INTO procurement_inbound_mail_status
    (tenant_id,configured,connected,provider,mailbox,last_started_at,last_completed_at,last_status,last_handled_count,last_error,next_poll_at,consecutive_failures,updated_at)
    VALUES (?,1,1,'imap:imap.163.com','INBOX',?,?,'running',0,NULL,NULL,0,?)`)
    .run(tenantId, currentStartedAt, lastCompletedAt, currentStartedAt);

  const result = procurementV1Readiness(store.db, tenantId, readyOperations, new Date(checkedAt));

  assert.equal(result.gates.find((gate) => gate.id === 'inbound_email')?.status, 'ready');
  assert.match(result.gates.find((gate) => gate.id === 'inbound_email')?.summary ?? '', /正常轮询/);
  store.close();
});

test('V1 readiness blocks when Context projection is dead-lettered or stale', () => {
  const tenantId = 'tenant:context-readiness';
  const at = '2026-08-28T08:00:00.000Z';
  const store = openPersistence(':memory:', { tenantId });
  try {
    store.db.prepare(`INSERT INTO twin_projection_jobs
      (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,available_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'dead_letter',8,8,?,?,?)`)
      .run(tenantId, 'job:dead', 'procurement_documents', 'purchase_order:po:1', '1', 'purchase_order.changed', 'hash', at, at, at);
    const operations = {
      ...readyOperations,
      manufacturingContext: { workerReady: true, lastHeartbeatAt: '2026-08-28T07:59:59.000Z', pollIntervalMs: 3_000 },
    };
    const view = procurementV1Readiness(store.db, tenantId, operations, new Date(at));
    assert.equal(view.gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'blocked');
  } finally {
    store.close();
  }
});

test('V1 readiness blocks when Context worker heartbeat is stale', () => {
  const tenantId = 'tenant:context-stale-heartbeat';
  const at = '2026-08-28T08:00:00.000Z';
  const store = openPersistence(':memory:', { tenantId });
  try {
    const operations = {
      ...readyOperations,
      manufacturingContext: {
        workerReady: true,
        lastHeartbeatAt: '2026-08-28T07:59:53.999Z',
        pollIntervalMs: 3_000,
      },
    };
    const view = procurementV1Readiness(store.db, tenantId, operations, new Date(at));
    assert.equal(view.gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'blocked');
  } finally {
    store.close();
  }
});

test('V1 readiness blocks when Context worker heartbeat is in the future', () => {
  const tenantId = 'tenant:context-future-heartbeat';
  const at = '2026-08-28T08:00:00.000Z';
  const store = openPersistence(':memory:', { tenantId });
  try {
    const operations = {
      ...readyOperations,
      manufacturingContext: {
        workerReady: true,
        lastHeartbeatAt: '2026-08-28T08:00:00.001Z',
        pollIntervalMs: 3_000,
      },
    };
    const view = procurementV1Readiness(store.db, tenantId, operations, new Date(at));
    assert.equal(view.gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'blocked');
  } finally {
    store.close();
  }
});

test('V1 readiness blocks for tenant pending Context work older than ten minutes', () => {
  const tenantId = 'tenant:context-old-pending';
  const otherTenantId = 'tenant:context-other';
  const at = '2026-08-28T08:00:00.000Z';
  const store = openPersistence(':memory:', { tenantId });
  try {
    const insert = store.db.prepare(`INSERT INTO twin_projection_jobs
      (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,available_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?, ?,0,8,?,?,?)`);
    insert.run(tenantId, 'job:old', 'procurement_documents', 'purchase_order:po:old', '1', 'purchase_order.changed', 'hash:old', 'queued', '2026-08-28T07:49:59.999Z', at, at);
    insert.run(otherTenantId, 'job:other-dead', 'procurement_documents', 'purchase_order:po:other', '1', 'purchase_order.changed', 'hash:other', 'dead_letter', at, at, at);

    const blocked = procurementV1Readiness(store.db, tenantId, readyOperations, new Date(at));
    assert.equal(blocked.gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'blocked');

    store.db.prepare(`DELETE FROM twin_projection_jobs WHERE tenant_id=? AND id=?`).run(tenantId, 'job:old');
    const tenantScoped = procurementV1Readiness(store.db, tenantId, readyOperations, new Date(at));
    assert.equal(tenantScoped.gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'ready');
  } finally {
    store.close();
  }
});

function purchaseOrder(tenantId: string, id: string, externalId: string, status: PurchaseOrder['status'], at: string): PurchaseOrder {
  return {
    id, tenantId, sourceSystem: 'odoo', externalId, status, createdAt: at, updatedAt: at,
    supplierId: 'supplier:real', currency: 'CNY', orderedAt: at,
  };
}

function purchaseOrderLine(poId: string, id: string): PurchaseOrderLine {
  return {
    id, poId, lineNumber: '10', itemId: 'item:real', description: '真实采购物料', uom: 'EA',
    orderedQty: 10, unitPrice: 100, currency: 'CNY', requestedAt: '2026-09-30T00:00:00.000Z',
  };
}
