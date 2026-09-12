import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProductionProgress, ProductionProgressLine, PurchaseOrder, PurchaseOrderLine, Receipt, Shipment, Supplier, TransportEvent } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementNotificationRequest, ProcurementNotificationWorker } from '../src/procurement-notifications.js';

const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
function token(tenantId: string, role = '采购专员', humanId = 'human:buyer'): string {
  const session: Session = { username: humanId, tenantId, humanId, name: humanId, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

test('采购通知: 真实规则、幂等刷新、已读版本、租户隔离与重启持久化', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-procurement-notifications-'));
  const dbPath = join(dir, 'notifications.db');
  let store = openPersistence(dbPath, { tenantId: 'tenant:notifications' });
  const repo = createProcurementRepository(store.db, 'tenant:notifications');
  const supplier: Supplier = {
    id: 'supplier:notifications', tenantId: 'tenant:notifications', sourceSystem: 'odoo', externalId: 'SUP-NOTIFY', status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', name: '华东精密制造', currency: 'CNY', contacts: [],
  };
  const waitingPo: PurchaseOrder = {
    id: 'po:waiting', tenantId: 'tenant:notifications', sourceSystem: 'odoo', externalId: 'PO-20260824-001', status: 'sent',
    createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', supplierId: supplier.id, currency: 'CNY', orderedAt: '2026-08-24T00:00:00.000Z',
  };
  const riskPo = {
    id: 'po:risk', tenantId: 'tenant:notifications', sourceSystem: 'odoo', externalId: 'PO-20260826-002', status: 'confirmed',
    createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z', supplierId: supplier.id, currency: 'CNY', orderedAt: '2026-08-26T00:00:00.000Z', promisedAt: '2026-08-28T00:00:00.000Z',
  } as PurchaseOrder & { promisedAt: string };
  repo.saveDocument('supplier', supplier); repo.saveDocument('purchase_order', waitingPo); repo.saveDocument('purchase_order', riskPo);
  const riskPoLine: PurchaseOrderLine = {
    id: 'po-line:risk', poId: riskPo.id, lineNumber: '10', itemId: 'item:risk', description: '风险测试物料',
    uom: 'EA', orderedQty: 10, unitPrice: 100, currency: 'CNY', requestedAt: '2026-08-28T00:00:00.000Z',
  };
  repo.saveLine('purchase_order_line', riskPo.id, riskPoLine);
  const productionProgress: ProductionProgress = {
    id: 'production-progress:notify', tenantId: 'tenant:notifications', sourceSystem: 'readywork-manual-verification',
    externalId: 'PROGRESS-NOTIFY', status: 'recorded', createdAt: '2026-08-26T08:00:00.000Z', updatedAt: '2026-08-26T08:00:00.000Z',
    poId: riskPo.id, supplierId: supplier.id, reportedAt: '2026-08-26T08:00:00.000Z', overallStatus: 'delayed',
    evidenceSource: 'manual_verified', evidenceReference: 'mail:progress-notify', verifiedBy: 'human:manager',
    verificationReason: '已核对供应商生产进度邮件',
  };
  const productionProgressLine: ProductionProgressLine = {
    id: 'production-progress-line:notify', progressId: productionProgress.id, poLineId: riskPoLine.id,
    lineNumber: '10', itemId: riskPoLine.itemId, description: riskPoLine.description, uom: riskPoLine.uom,
    progressStatus: 'delayed', completionPercent: 60, completedQty: 6,
    expectedReadyAt: '2026-08-26T10:00:00.000Z', note: '原料延迟到厂',
  };
  repo.saveDocument('production_progress', productionProgress);
  repo.saveLine('production_progress_line', productionProgress.id, productionProgressLine);
  const shipment: Shipment = {
    id: 'shipment:notify', tenantId: 'tenant:notifications', sourceSystem: 'odoo', externalId: 'ASN-NOTIFY', status: 'shipped',
    createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z', poId: riskPo.id, supplierId: supplier.id,
    shippedAt: '2026-08-25T00:00:00.000Z', carrier: 'DHL', trackingNumber: 'DHL-NOTIFY',
  };
  const transportEvent: TransportEvent = {
    id: 'transport-event:notify', tenantId: 'tenant:notifications', sourceSystem: 'readywork-manual-verification', externalId: 'CUSTOMS-HOLD-NOTIFY', status: 'recorded',
    createdAt: '2026-08-26T01:00:00.000Z', updatedAt: '2026-08-26T01:00:00.000Z', poId: riskPo.id, shipmentId: shipment.id,
    eventCode: 'customs_held', occurredAt: '2026-08-26T01:00:00.000Z', location: '上海海关', estimatedArrivalAt: '2026-08-26T12:00:00.000Z',
    evidenceSource: 'manual_verified', evidenceReference: 'customs:hold:notify', verifiedBy: 'human:manager', verificationReason: '已核对海关查验通知',
  };
  repo.saveDocument('shipment', shipment); repo.saveDocument('transport_event', transportEvent);
  store.db.prepare(`INSERT INTO procurement_message_drafts
    (tenant_id,id,purchase_order_id,supplier_id,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('tenant:notifications', 'draft:notify', waitingPo.id, supplier.id, 'supplier@vendor.cn', '请确认采购订单', '真实待审正文', 'acknowledgement_followup', 'trigger:notify', '{}', 'draft', 1, 'ai:procurement-sla', '2026-08-27T01:00:00.000Z', '2026-08-27T01:00:00.000Z');
  const outbox = { id: 'outbox:failed', status: 'failed', action: 'purchase_order.followup' };
  store.db.prepare(`INSERT INTO procurement_outbox
    (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,created_at,updated_at,failed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('tenant:notifications', outbox.id, 'email', 'email', outbox.action, waitingPo.id, 'notify-failure', outbox.status, '{}', JSON.stringify(outbox), '2026-08-27T02:00:00.000Z', '2026-08-27T02:00:00.000Z', '2026-08-27T02:00:00.000Z');

  const now = new Date('2026-08-27T12:00:00.000Z');
  let activeDb = store.db;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers['authorization']; const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    void handleProcurementNotificationRequest(req, res, url.pathname, req.method ?? 'GET', { db: activeDb, session: resolveSession(bearer), now: () => now })
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error: unknown) => res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, options: { method?: string; token?: string; body?: Record<string, unknown> } = {}) {
    const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}),
    }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  const buyer = token('tenant:notifications');
  const auditor = token('tenant:notifications', '审计员', 'human:auditor');
  try {
    assert.equal((await request('/api/procurement/notifications')).status, 401);
    assert.equal((await request('/api/procurement/notifications', { token: token('tenant:notifications', '访客') })).status, 403);
    const readOnlyList = await request('/api/procurement/notifications', { token: auditor });
    assert.equal(readOnlyList.status, 200, '只有 read 权限的审计员可以查看通知');
    assert.deepEqual(readOnlyList.body['items'], []);
    assert.deepEqual(readOnlyList.body['capabilities'], { markRead: false }, '审计员列表必须明确声明不可写');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_notifications WHERE tenant_id=?').get('tenant:notifications') as { count: number }).count, 0, 'GET 不得运行通知规则或写库');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_notification_events WHERE tenant_id=?').get('tenant:notifications') as { count: number }).count, 0, 'GET 不得产生审计写事件');
    const forbiddenRefresh = await request('/api/procurement/notifications/refresh', { method: 'POST', token: auditor });
    assert.equal(forbiddenRefresh.status, 403, '显式运行规则必须要求 operate 权限');
    assert.equal((await request('/api/procurement/notifications/refresh', { method: 'POST', token: token('tenant:other') })).body['created'], 0, '其他租户不得看见或派生当前租户事实');

    const refreshed = await request('/api/procurement/notifications/refresh', { method: 'POST', token: buyer });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body['created'], 12);
    assert.equal(refreshed.body['counts']['unread'], 12);
    assert.deepEqual(refreshed.body['capabilities'], { markRead: true }, '采购专员列表必须明确声明可标记已读');
    const types = new Set((refreshed.body['items'] as Array<Record<string, unknown>>).map((item) => item['type']));
    assert.deepEqual(types, new Set(['supplier_no_response', 'sla_breach', 'po_escalated', 'po_created', 'rihd_at_risk', 'drafts_ready', 'connector_failed', 'production_delayed', 'production_ready_overdue', 'customs_held', 'shipment_eta_overdue']));
    assert.equal(types.has('delivery_completed'), false, '没有真实收货时不得伪造 GRN 完成通知');

    const replay = await request('/api/procurement/notifications/refresh', { method: 'POST', token: buyer });
    assert.equal(replay.body['created'], 0, '业务指纹必须使刷新幂等');
    assert.equal(replay.body['generatedAt'], refreshed.body['generatedAt'], '无新事实时通知水位保持稳定');

    const first = (refreshed.body['items'] as Array<Record<string, any>>)[0]!;
    const auditorPopulated = await request('/api/procurement/notifications', { token: auditor });
    assert.equal(auditorPopulated.body['items'].length, 12);
    assert.deepEqual(auditorPopulated.body['capabilities'], { markRead: false });
    const auditorRowBefore = store.db.prepare(`SELECT status,version FROM procurement_notifications WHERE tenant_id=? AND id=?`).get('tenant:notifications', first['id']) as { status: string; version: number };
    const auditorEventsBefore = (store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_notification_events WHERE tenant_id=?`).get('tenant:notifications') as { count: number }).count;
    assert.equal((await request(`/api/procurement/notifications/${encodeURIComponent(first['id'])}/read`, { method: 'POST', token: auditor, body: { expectedVersion: first['version'] } })).status, 403);
    assert.equal((await request('/api/procurement/notifications/read-all', { method: 'POST', token: auditor })).status, 403);
    assert.deepEqual(store.db.prepare(`SELECT status,version FROM procurement_notifications WHERE tenant_id=? AND id=?`).get('tenant:notifications', first['id']), auditorRowBefore);
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_notification_events WHERE tenant_id=?`).get('tenant:notifications') as { count: number }).count, auditorEventsBefore, '拒绝的写入不得产生通知事件');
    const read = await request(`/api/procurement/notifications/${encodeURIComponent(first['id'])}/read`, { method: 'POST', token: buyer, body: { expectedVersion: first['version'] } });
    assert.equal(read.status, 200); assert.equal(read.body['item']['status'], 'read'); assert.equal(read.body['item']['version'], first['version'] + 1);
    const conflict = await request(`/api/procurement/notifications/${encodeURIComponent(first['id'])}/read`, { method: 'POST', token: buyer, body: { expectedVersion: first['version'] } });
    assert.equal(conflict.status, 409); assert.equal(conflict.body['code'], 'NOTIFICATION_VERSION_CONFLICT');
    const unread = await request('/api/procurement/notifications?filter=unread', { token: buyer });
    assert.equal(unread.body['items'].length, 11);

    const readAll = await request('/api/procurement/notifications/read-all', { method: 'POST', token: buyer });
    assert.equal(readAll.status, 200); assert.equal(readAll.body['updated'], 11); assert.equal(readAll.body['counts']['unread'], 0);
    const eventCount = store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_notification_events WHERE tenant_id=? AND action='marked_read'`).get('tenant:notifications') as { count: number };
    assert.equal(Number(eventCount.count), 12, '每条已读动作必须持久化审计事件');

    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    store = openPersistence(dbPath, { tenantId: 'tenant:notifications' }); activeDb = store.db;
    const persisted = store.db.prepare(`SELECT status,read_by,read_at FROM procurement_notifications WHERE tenant_id=?`).all('tenant:notifications') as Array<{ status: string; read_by: string | null; read_at: string | null }>;
    assert.equal(persisted.length, 12); assert.ok(persisted.every((row) => row.status === 'read' && row.read_by === 'human:buyer' && row.read_at));

    const receipt: Receipt = {
      id: 'receipt:notify', tenantId: 'tenant:notifications', sourceSystem: 'odoo', externalId: 'GRN-20260827-001', status: 'received',
      createdAt: '2026-08-27T10:00:00.000Z', updatedAt: '2026-08-27T10:00:00.000Z', poId: riskPo.id, warehouseId: 'warehouse:main', receivedAt: '2026-08-27T10:00:00.000Z',
    };
    createProcurementRepository(store.db, 'tenant:notifications').saveDocument('receipt', receipt);
    const workerResult = new ProcurementNotificationWorker(store.db, { actorId: 'system:test-notification-worker', now: () => now }).runPendingTenants();
    assert.equal(workerResult.find((item) => item.tenantId === 'tenant:notifications')?.created, 1);
    const delivery = store.db.prepare(`SELECT type,object_id FROM procurement_notifications WHERE tenant_id=? AND type='delivery_completed'`).get('tenant:notifications') as { type: string; object_id: string } | undefined;
    assert.equal(delivery?.type, 'delivery_completed'); assert.equal(delivery?.object_id, riskPo.id);
    const workerEvent = store.db.prepare(`SELECT actor_id,action FROM procurement_notification_events WHERE tenant_id=? AND notification_id=(
      SELECT id FROM procurement_notifications WHERE tenant_id=? AND type='delivery_completed'
    )`).get('tenant:notifications', 'tenant:notifications') as { actor_id: string; action: string } | undefined;
    assert.equal(workerEvent?.actor_id, 'system:test-notification-worker');
    assert.equal(workerEvent?.action, 'generated_by_rule');
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
