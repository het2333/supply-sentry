import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { PurchaseOrder, Receipt, Supplier } from '@readywork/core';
import { can, type Session } from './auth.js';

export interface ProcurementNotificationContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly now?: () => Date;
}

export interface ProcurementNotificationWorkerOptions {
  readonly actorId?: string;
  readonly now?: () => Date;
}

export interface ProcurementNotificationWorkerResult {
  readonly tenantId: string;
  readonly created: number;
  readonly examined: number;
}

type NotificationStatus = 'unread' | 'read';
type NotificationFilter = 'all' | 'unread';
type NotificationSeverity = 'critical' | 'high' | 'warning' | 'info' | 'success';

interface NotificationRow {
  tenant_id: string;
  id: string;
  fingerprint: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  tag: string;
  object_type: string | null;
  object_id: string | null;
  evidence_json: string;
  status: NotificationStatus;
  version: number;
  read_by: string | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentRow { id: string; status: string; created_at: string; updated_at: string; json: string }

interface NotificationCandidate {
  fingerprint: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  tag: string;
  objectType?: string;
  objectId?: string;
  evidence: Record<string, unknown>;
  occurredAt: string;
}

export async function handleProcurementNotificationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementNotificationContext,
): Promise<boolean> {
  const root = path === '/api/procurement/notifications';
  const refresh = path === '/api/procurement/notifications/refresh';
  const readAll = path === '/api/procurement/notifications/read-all';
  const readOne = path.match(/^\/api\/procurement\/notifications\/([^/]+)\/read$/);
  if (!root && !refresh && !readAll && !readOne) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  const { db, session } = context;
  const capabilities = { markRead: can(session, 'operate') };

  try {
    if (root && method === 'GET') {
      if (!can(session, 'read')) return forbidden(res, '无读取通知权限');
      const filter = queryFilter(req);
      sendJson(res, 200, { ...listNotifications(db, session.tenantId, filter), capabilities });
      return true;
    }

    if (refresh && method === 'POST') {
      if (!can(session, 'operate')) return forbidden(res, '无运行通知规则权限');
      const result = refreshNotifications(db, session.tenantId, session.humanId, context.now?.() ?? new Date());
      sendJson(res, 200, { ...result, ...listNotifications(db, session.tenantId, 'all'), capabilities });
      return true;
    }

    if (readAll && method === 'POST') {
      if (!can(session, 'operate')) return forbidden(res, '无更新通知权限');
      const now = (context.now?.() ?? new Date()).toISOString();
      const rows = db.prepare(`SELECT id,version FROM procurement_notifications WHERE tenant_id=? AND status='unread' ORDER BY created_at,id`)
        .all(session.tenantId) as Array<{ id: string; version: number }>;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          db.prepare(`UPDATE procurement_notifications SET status='read',version=version+1,read_by=?,read_at=?,updated_at=?
            WHERE tenant_id=? AND id=? AND version=? AND status='unread'`)
            .run(session.humanId, now, now, session.tenantId, row.id, row.version);
          insertEvent(db, session.tenantId, row.id, session.humanId, 'marked_read', { previousVersion: row.version, source: 'read_all' }, now);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      sendJson(res, 200, { updated: rows.length, ...listNotifications(db, session.tenantId, 'all'), capabilities });
      return true;
    }

    if (readOne && method === 'POST') {
      if (!can(session, 'operate')) return forbidden(res, '无更新通知权限');
      const body = await readJsonBody(req);
      assertOnlyKeys(body, ['expectedVersion']);
      const expectedVersion = positiveInteger(body['expectedVersion'], 'expectedVersion');
      const id = decodePath(readOne[1]!);
      const now = (context.now?.() ?? new Date()).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = getNotification(db, session.tenantId, id);
        if (!row) throw new NotificationNotFoundError();
        if (row.version !== expectedVersion) throw new NotificationVersionError(row.version);
        if (row.status === 'unread') {
          const changed = db.prepare(`UPDATE procurement_notifications SET status='read',version=version+1,read_by=?,read_at=?,updated_at=?
            WHERE tenant_id=? AND id=? AND version=? AND status='unread'`)
            .run(session.humanId, now, now, session.tenantId, id, expectedVersion);
          if (changed.changes !== 1) throw new NotificationVersionError(getNotification(db, session.tenantId, id)?.version ?? expectedVersion);
          insertEvent(db, session.tenantId, id, session.humanId, 'marked_read', { previousVersion: expectedVersion, source: 'single' }, now);
        } else {
          insertEvent(db, session.tenantId, id, session.humanId, 'read_replayed', { version: expectedVersion, source: 'single' }, now);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      sendJson(res, 200, { item: presentNotification(getNotification(db, session.tenantId, id)!) });
      return true;
    }

    sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    sendNotificationError(res, error);
  }
  return true;
}

export function refreshNotifications(
  db: DatabaseSync,
  tenantId: string,
  actorId: string,
  now: Date,
): { created: number; examined: number } {
  const candidates = deriveNotifications(db, tenantId, now);
  let created = 0;
  const insertedAt = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const candidate of candidates) {
      const id = `procurement-notification:${randomUUID()}`;
      const result = db.prepare(`INSERT OR IGNORE INTO procurement_notifications
        (tenant_id,id,fingerprint,type,severity,title,message,tag,object_type,object_id,evidence_json,status,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
        .run(tenantId, id, candidate.fingerprint, candidate.type, candidate.severity, candidate.title, candidate.message,
          candidate.tag, candidate.objectType ?? null, candidate.objectId ?? null, JSON.stringify(candidate.evidence), 'unread',
          candidate.occurredAt, candidate.occurredAt);
      if (result.changes !== 1) continue;
      insertEvent(db, tenantId, id, actorId, 'generated_by_rule', { fingerprint: candidate.fingerprint, type: candidate.type, evaluatedAt: insertedAt }, insertedAt);
      created += 1;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { created, examined: candidates.length };
}

/**
 * 通知规则属于后台投影，不属于“查看通知”这个只读动作。Worker 从已有采购事实中
 * 发现租户，并依靠通知 fingerprint 的唯一约束保证多实例或重复轮询时仍然幂等。
 */
export class ProcurementNotificationWorker {
  private readonly actorId: string;
  private readonly now: () => Date;

  constructor(private readonly db: DatabaseSync, options: ProcurementNotificationWorkerOptions = {}) {
    this.actorId = options.actorId ?? 'system:procurement-notification-worker';
    this.now = options.now ?? (() => new Date());
  }

  runPendingTenants(): ProcurementNotificationWorkerResult[] {
    const tenants = this.db.prepare(`SELECT DISTINCT tenant_id FROM procurement_documents
      UNION SELECT DISTINCT tenant_id FROM procurement_message_drafts
      UNION SELECT DISTINCT tenant_id FROM procurement_outbox
      UNION SELECT DISTINCT tenant_id FROM procurement_import_document_evaluations
      ORDER BY tenant_id`).all() as Array<{ tenant_id: string }>;
    return tenants.map(({ tenant_id }) => ({
      tenantId: tenant_id,
      ...refreshNotifications(this.db, tenant_id, this.actorId, this.now()),
    }));
  }
}

function deriveNotifications(db: DatabaseSync, tenantId: string, now: Date): NotificationCandidate[] {
  const candidates: NotificationCandidate[] = [];
  const nowMs = now.getTime();
  const poRows = db.prepare(`SELECT id,status,created_at,updated_at,json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' ORDER BY created_at,id`).all(tenantId) as unknown as DocumentRow[];
  const supplierRows = db.prepare(`SELECT id,json FROM procurement_documents WHERE tenant_id=? AND kind='supplier'`).all(tenantId) as Array<{ id: string; json: string }>;
  const suppliers = new Map(supplierRows.map((row) => {
    const supplier = safeJson(row.json) as Partial<Supplier>;
    return [row.id, supplier.name ?? row.id];
  }));
  const inboundPoIds = new Set<string>();
  const communicationRows = db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='communication'`).all(tenantId) as Array<{ json: string }>;
  for (const row of communicationRows) {
    const communication = safeJson(row.json) as Record<string, unknown>;
    if (communication['direction'] === 'inbound' && communication['businessObjectType'] === 'purchase_order' && typeof communication['businessObjectId'] === 'string') inboundPoIds.add(communication['businessObjectId']);
  }

  for (const row of poRows) {
    const po = safeJson(row.json) as unknown as PurchaseOrder & { number?: string; promisedAt?: string | null; requiredInHouseAt?: string | null };
    const number = po.number ?? po.externalId ?? row.id;
    const supplierName = suppliers.get(po.supplierId) ?? po.supplierId;
    const orderedAt = validDate(po.orderedAt) ?? validDate(row.created_at);
    const hoursSinceOrder = orderedAt ? Math.floor((nowMs - orderedAt.getTime()) / 3_600_000) : -1;
    if (row.status === 'sent' && !inboundPoIds.has(row.id) && hoursSinceOrder >= 24) {
      candidates.push({
        fingerprint: `supplier-no-response:${row.id}:${dateIdentity(po.orderedAt ?? row.created_at)}`,
        type: 'supplier_no_response', severity: hoursSinceOrder >= 48 ? 'high' : 'warning', tag: '供应商回复',
        title: `供应商尚未确认 ${number}`,
        message: `${supplierName} 在采购订单发出 ${hoursSinceOrder} 小时后仍未回复，需要跟进确认数量、价格与交期。`,
        objectType: 'purchase_order', objectId: row.id,
        evidence: { rule: 'supplier_no_response_24h', purchaseOrderId: row.id, hoursSinceOrder }, occurredAt: addHours(orderedAt!, 24),
      });
      candidates.push({
        fingerprint: `sla-breach:commitment:${row.id}:${dateIdentity(po.orderedAt ?? row.created_at)}`,
        type: 'sla_breach', severity: 'high', tag: 'SLA 告警',
        title: `${number} 已超过供应商确认 SLA`,
        message: `采购订单超过 24 小时未取得供应商承诺，当前已超出确认服务时限。`,
        objectType: 'purchase_order', objectId: row.id,
        evidence: { rule: 'supplier_commitment_24h', purchaseOrderId: row.id, hoursSinceOrder }, occurredAt: addHours(orderedAt!, 24),
      });
      if (hoursSinceOrder >= 48) candidates.push({
        fingerprint: `po-escalated:${row.id}:${dateIdentity(po.orderedAt ?? row.created_at)}`,
        type: 'po_escalated', severity: 'critical', tag: 'PO 升级',
        title: `${number} 已升级处理`,
        message: `${supplierName} 超过 48 小时未确认订单，系统已将该 PO 提升为人工关注事项。`,
        objectType: 'purchase_order', objectId: row.id,
        evidence: { rule: 'supplier_commitment_escalation_48h', purchaseOrderId: row.id, hoursSinceOrder }, occurredAt: addHours(orderedAt!, 48),
      });
    }

    const requiredAtRaw = po.requiredInHouseAt ?? po.promisedAt;
    const requiredAt = validDate(requiredAtRaw);
    const active = !['draft', 'received', 'closed', 'cancelled'].includes(row.status);
    if (active && requiredAt) {
      const daysToRequired = Math.ceil((requiredAt.getTime() - nowMs) / 86_400_000);
      if (daysToRequired <= 3) candidates.push({
        fingerprint: `rihd-at-risk:${row.id}:${dateIdentity(requiredAtRaw!)}`,
        type: 'rihd_at_risk', severity: daysToRequired < 0 ? 'critical' : 'high', tag: '到货风险',
        title: `${number} 的要求到货日存在风险`,
        message: daysToRequired < 0
          ? `要求到货日已逾期 ${Math.abs(daysToRequired)} 天，仍未发现完成收货记录。`
          : `距离要求到货日仅剩 ${daysToRequired} 天，当前订单尚未完成收货。`,
        objectType: 'purchase_order', objectId: row.id,
        evidence: { rule: 'rihd_due_within_3_days', purchaseOrderId: row.id, requiredAt: requiredAt.toISOString(), daysToRequired }, occurredAt: addDays(requiredAt, -3),
      });
    }

    const createdAt = validDate(po.createdAt) ?? validDate(row.created_at);
    if (createdAt && nowMs >= createdAt.getTime() && nowMs - createdAt.getTime() <= 7 * 86_400_000) candidates.push({
      fingerprint: `po-created:${row.id}`,
      type: 'po_created', severity: 'info', tag: 'PO 事件', title: `${number} 已创建`,
      message: `${supplierName} 的采购订单已进入采购执行跟踪。`, objectType: 'purchase_order', objectId: row.id,
      evidence: { rule: 'po_created_within_7_days', purchaseOrderId: row.id }, occurredAt: createdAt.toISOString(),
    });
  }

  const receiptRows = db.prepare(`SELECT id,created_at,json FROM procurement_documents WHERE tenant_id=? AND kind='receipt' AND status='received' ORDER BY created_at,id`)
    .all(tenantId) as unknown as Array<{ id: string; created_at: string; json: string }>;
  for (const row of receiptRows) {
    const receipt = safeJson(row.json) as unknown as Receipt & { reference?: string };
    const receivedAt = validDate(receipt.receivedAt) ?? validDate(row.created_at);
    if (!receivedAt) continue;
    candidates.push({
      fingerprint: `delivery-completed:${row.id}`, type: 'delivery_completed', severity: 'success', tag: '收货完成',
      title: `${receipt.reference ?? receipt.externalId ?? row.id} 已完成收货`, message: `真实 GRN 已记录，相关采购订单的到货状态可继续核对。`,
      objectType: 'purchase_order', objectId: receipt.poId,
      evidence: { rule: 'goods_receipt_recorded', receiptId: row.id, purchaseOrderId: receipt.poId }, occurredAt: receivedAt.toISOString(),
    });
  }

  const productionRows = db.prepare(`SELECT id,json FROM procurement_documents
    WHERE tenant_id=? AND kind='production_progress' ORDER BY json_extract(json,'$.reportedAt') DESC,id DESC`)
    .all(tenantId) as Array<{ id: string; json: string }>;
  const latestProductionByPo = new Map<string, { id: string; value: Record<string, unknown> }>();
  for (const row of productionRows) {
    const value = safeJson(row.json);
    const poId = typeof value['poId'] === 'string' ? value['poId'] : undefined;
    if (poId && !latestProductionByPo.has(poId)) latestProductionByPo.set(poId, { id: row.id, value });
  }
  for (const [poId, progress] of latestProductionByPo) {
    const status = String(progress.value['overallStatus'] ?? '');
    const reportedAt = validDate(progress.value['reportedAt'])?.toISOString();
    if (!reportedAt) continue;
    if (status === 'delayed' || status === 'blocked') candidates.push({
      fingerprint: `production-risk:${progress.id}`,
      type: status === 'blocked' ? 'production_blocked' : 'production_delayed',
      severity: status === 'blocked' ? 'critical' : 'high', tag: '生产履约',
      title: status === 'blocked' ? '供应商生产 / 备货受阻' : '供应商生产 / 备货延期',
      message: `最新核验进度为“${status === 'blocked' ? '受阻' : '延期'}”；证据编号 ${String(progress.value['externalId'] ?? progress.id)}。`,
      objectType: 'purchase_order', objectId: poId,
      evidence: { rule: status, purchaseOrderId: poId, productionProgressId: progress.id, evidenceReference: progress.value['evidenceReference'] },
      occurredAt: reportedAt,
    });
    const lineRows = db.prepare(`SELECT json FROM procurement_lines WHERE tenant_id=? AND kind='production_progress_line' AND document_id=? ORDER BY line_number,id`)
      .all(tenantId, progress.id) as Array<{ json: string }>;
    const overdueLines = lineRows.map((row) => safeJson(row.json)).filter((line) => {
      const expected = validDate(line['expectedReadyAt']);
      return expected && expected.getTime() < nowMs && line['progressStatus'] !== 'ready_to_ship';
    });
    if (overdueLines.length) candidates.push({
      fingerprint: `production-ready-overdue:${progress.id}`,
      type: 'production_ready_overdue', severity: 'high', tag: '生产履约',
      title: '预计可发运时间已逾期',
      message: `${overdueLines.length} 条 PO 行已超过最新预计可发运时间，尚未达到待发运状态。`,
      objectType: 'purchase_order', objectId: poId,
      evidence: { rule: 'production_expected_ready_overdue', purchaseOrderId: poId, productionProgressId: progress.id,
        poLineIds: overdueLines.map((line) => line['poLineId']), expectedReadyAt: overdueLines.map((line) => line['expectedReadyAt']) },
      occurredAt: reportedAt,
    });
  }

  const transportRows = db.prepare(`SELECT id,json FROM procurement_documents
    WHERE tenant_id=? AND kind='transport_event' ORDER BY json_extract(json,'$.occurredAt'),id`).all(tenantId) as Array<{ id: string; json: string }>;
  const latestEtaByPo = new Map<string, Record<string, unknown>>();
  for (const row of transportRows) {
    const event = safeJson(row.json);
    const poId = typeof event['poId'] === 'string' ? event['poId'] : undefined;
    const eventCode = String(event['eventCode'] ?? '');
    const occurredAt = validDate(event['occurredAt'])?.toISOString();
    if (!poId || !occurredAt) continue;
    if (event['estimatedArrivalAt']) latestEtaByPo.set(poId, { ...event, id: row.id });
    if (eventCode === 'customs_held' || eventCode === 'exception') candidates.push({
      fingerprint: `transport-risk:${row.id}`,
      type: eventCode === 'customs_held' ? 'customs_held' : 'transport_exception', severity: 'critical',
      tag: eventCode === 'customs_held' ? '进口清关' : '运输异常',
      title: eventCode === 'customs_held' ? '进口货物清关受阻' : '采购运输出现异常',
      message: `${String(event['location'] ?? '位置未提供')} 的运输节点需要人工处理；证据编号 ${String(event['externalId'] ?? row.id)}。`,
      objectType: 'purchase_order', objectId: poId,
      evidence: { rule: eventCode, purchaseOrderId: poId, transportEventId: row.id, shipmentId: event['shipmentId'], evidenceReference: event['evidenceReference'] },
      occurredAt,
    });
  }
  for (const [poId, event] of latestEtaByPo) {
    const eta = validDate(event['estimatedArrivalAt']);
    const poRow = poRows.find((row) => row.id === poId);
    if (!eta || eta.getTime() >= nowMs || !poRow || ['received', 'closed', 'cancelled'].includes(poRow.status)) continue;
    const days = Math.max(1, Math.ceil((nowMs - eta.getTime()) / 86_400_000));
    candidates.push({
      fingerprint: `shipment-eta-overdue:${poId}:${dateIdentity(eta.toISOString())}`,
      type: 'shipment_eta_overdue', severity: days >= 3 ? 'critical' : 'high', tag: '在途风险',
      title: '运输 ETA 已逾期', message: `预计到货时间已逾期 ${days} 天，尚未形成最终 GRN。`,
      objectType: 'purchase_order', objectId: poId,
      evidence: { rule: 'shipment_eta_overdue', purchaseOrderId: poId, transportEventId: event['id'], estimatedArrivalAt: eta.toISOString(), overdueDays: days },
      occurredAt: eta.toISOString(),
    });
  }

  const importDocumentRows = db.prepare(`SELECT po_id,status,summary_json,fingerprint,version,updated_at
    FROM procurement_import_document_evaluations
    WHERE tenant_id=? AND status IN ('missing','expired','security_blocked','policy_missing')
    ORDER BY updated_at,po_id`).all(tenantId) as Array<{ po_id: string; status: string; summary_json: string; fingerprint: string; version: number; updated_at: string }>;
  for (const row of importDocumentRows) {
    const summary = safeJson(row.summary_json);
    const severity: NotificationSeverity = row.status === 'security_blocked' ? 'critical' : row.status === 'expired' ? 'high' : 'warning';
    const label = row.status === 'security_blocked' ? '单证安全扫描未通过'
      : row.status === 'expired' ? '进口单证已过期'
        : row.status === 'policy_missing' ? '进口单证策略未发布' : '进口单证缺失';
    candidates.push({
      fingerprint: `import-document-gate:${row.po_id}:${row.fingerprint}`,
      type: 'import_document_gate', severity, tag: '进口单证', title: label,
      message: `进口采购订单在 ${String(summary['stage'] ?? '当前')} 阶段未通过单证门禁，完成收货前必须处理。`,
      objectType: 'purchase_order', objectId: row.po_id,
      evidence: { rule: 'import_document_completion_gate', purchaseOrderId: row.po_id, evaluationStatus: row.status, evaluationVersion: row.version, summary },
      occurredAt: row.updated_at,
    });
  }

  const draftRows = db.prepare(`SELECT id,purchase_order_id,subject,created_at FROM procurement_message_drafts
    WHERE tenant_id=? AND status='draft' ORDER BY created_at,id`).all(tenantId) as Array<{ id: string; purchase_order_id: string; subject: string; created_at: string }>;
  for (const row of draftRows) candidates.push({
    fingerprint: `draft-ready:${row.id}`, type: 'drafts_ready', severity: 'info', tag: '邮件草稿',
    title: '采购跟进邮件待审核', message: row.subject, objectType: 'message_draft', objectId: row.id,
    evidence: { rule: 'message_draft_ready_for_review', draftId: row.id, purchaseOrderId: row.purchase_order_id }, occurredAt: row.created_at,
  });

  const failedRows = db.prepare(`SELECT id,aggregate_id,action,failed_at,updated_at FROM procurement_outbox
    WHERE tenant_id=? AND status='failed' ORDER BY COALESCE(failed_at,updated_at),id`).all(tenantId) as Array<{ id: string; aggregate_id: string; action: string; failed_at: string | null; updated_at: string }>;
  for (const row of failedRows) candidates.push({
    fingerprint: `connector-failed:${row.id}:${dateIdentity(row.failed_at ?? row.updated_at)}`, type: 'connector_failed', severity: 'critical', tag: '系统消息',
    title: '采购连接器执行失败', message: `外部动作 ${row.action} 未得到成功确认，系统已保持失败关闭状态。`,
    objectType: 'purchase_order', objectId: row.aggregate_id,
    evidence: { rule: 'outbox_terminal_failure', outboxId: row.id, purchaseOrderId: row.aggregate_id, action: row.action }, occurredAt: row.failed_at ?? row.updated_at,
  });

  return candidates.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.fingerprint.localeCompare(b.fingerprint));
}

function listNotifications(db: DatabaseSync, tenantId: string, filter: NotificationFilter): Record<string, unknown> {
  const rows = (filter === 'unread'
    ? db.prepare(`SELECT * FROM procurement_notifications WHERE tenant_id=? AND status='unread' ORDER BY created_at DESC,id DESC LIMIT 200`).all(tenantId)
    : db.prepare(`SELECT * FROM procurement_notifications WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 200`).all(tenantId)) as unknown as NotificationRow[];
  const counts = db.prepare(`SELECT status,COUNT(*) AS count FROM procurement_notifications WHERE tenant_id=? GROUP BY status`).all(tenantId) as Array<{ status: string; count: number }>;
  const countMap = Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]));
  const watermark = db.prepare(`SELECT MAX(updated_at) AS value FROM procurement_notifications WHERE tenant_id=?`).get(tenantId) as { value: string | null } | undefined;
  return {
    items: rows.map(presentNotification),
    counts: { all: Number(countMap['unread'] ?? 0) + Number(countMap['read'] ?? 0), unread: Number(countMap['unread'] ?? 0), read: Number(countMap['read'] ?? 0) },
    generatedAt: watermark?.value ?? null,
  };
}

function presentNotification(row: NotificationRow): Record<string, unknown> {
  return {
    id: row.id, type: row.type, severity: row.severity, title: row.title, message: row.message, tag: row.tag,
    objectType: row.object_type, objectId: row.object_id, evidence: safeJson(row.evidence_json), status: row.status, version: row.version,
    readBy: row.read_by, readAt: row.read_at, createdAt: row.created_at, updatedAt: row.updated_at,
    targetSection: row.object_type === 'message_draft' ? 'message-drafts' : row.object_type === 'purchase_order' ? 'orders' : 'notifications',
  };
}

function getNotification(db: DatabaseSync, tenantId: string, id: string): NotificationRow | undefined {
  return db.prepare(`SELECT * FROM procurement_notifications WHERE tenant_id=? AND id=?`).get(tenantId, id) as unknown as NotificationRow | undefined;
}

function insertEvent(db: DatabaseSync, tenantId: string, notificationId: string, actorId: string, action: string, detail: unknown, at: string): void {
  db.prepare(`INSERT INTO procurement_notification_events (tenant_id,id,notification_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(tenantId, `procurement-notification-event:${randomUUID()}`, notificationId, actorId, action, JSON.stringify(detail), at);
}

function queryFilter(req: IncomingMessage): NotificationFilter {
  const value = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('filter') ?? 'all';
  if (value !== 'all' && value !== 'unread') throw new NotificationInputError('filter 只能是 all 或 unread');
  return value;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) { raw += String(chunk); if (raw.length > 20_000) throw new NotificationInputError('请求体过大'); }
  try {
    const value = JSON.parse(raw || '{}') as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new NotificationInputError('请求体必须是 JSON 对象'); }
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new NotificationInputError(`不允许的字段: ${key}`);
}
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new NotificationInputError(`${field} 必须是正整数`); return Number(value); }
function safeJson(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function validDate(value: unknown): Date | undefined { if (typeof value !== 'string' || !value) return undefined; const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date; }
function dateIdentity(value: string): string { return value.slice(0, 19); }
function addHours(date: Date, hours: number): string { return new Date(date.getTime() + hours * 3_600_000).toISOString(); }
function addDays(date: Date, days: number): string { return new Date(date.getTime() + days * 86_400_000).toISOString(); }
function decodePath(value: string): string { try { return decodeURIComponent(value); } catch { throw new NotificationInputError('通知 ID 编码无效'); } }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function forbidden(res: ServerResponse, message: string): true { sendJson(res, 403, { error: message, code: 'FORBIDDEN' }); return true; }
function sendNotificationError(res: ServerResponse, error: unknown): void {
  if (error instanceof NotificationNotFoundError) return sendJson(res, 404, { error: error.message, code: 'NOTIFICATION_NOT_FOUND' });
  if (error instanceof NotificationVersionError) return sendJson(res, 409, { error: error.message, code: 'NOTIFICATION_VERSION_CONFLICT', currentVersion: error.currentVersion });
  if (error instanceof NotificationInputError) return sendJson(res, 422, { error: error.message, code: 'INVALID_NOTIFICATION_INPUT' });
  throw error;
}

class NotificationInputError extends Error {}
class NotificationNotFoundError extends Error { constructor() { super('通知不存在'); } }
class NotificationVersionError extends Error { constructor(readonly currentVersion: number) { super(`通知版本已变更，当前版本为 ${currentVersion}`); } }
