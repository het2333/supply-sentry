import type { DatabaseSync } from 'node:sqlite';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import { procurementPortfolio } from './procurement-workbench.js';
import { securityIncidentSummary } from './production-operations.js';
import { effectiveProcurementDeploymentMode, type ProcurementDeploymentMode } from './procurement-deployment-profile.js';

export type ProcurementV1ReadinessStatus = 'ready' | 'blocked';

export interface ProcurementV1ReadinessGate {
  id:
    | 'communication_identity'
    | 'published_sla'
    | 'outbound_email'
    | 'inbound_email'
    | 'odoo'
    | 'document_security'
    | 'durable_runtime'
    | 'manufacturing_context'
    | 'security_events'
    | 'local_purchase_order'
    | 'five_stage_closed_loop';
  label: string;
  status: ProcurementV1ReadinessStatus;
  summary: string;
  detail: string;
  target: 'communication-identity' | 'sla' | 'connector-email' | 'connector-erp' | 'po-intake' | 'document-gate' | 'runtime' | 'security-events' | 'local-procurement';
}

export interface ProcurementV1ReadinessView {
  status: ProcurementV1ReadinessStatus;
  checkedAt: string;
  deploymentMode: ProcurementDeploymentMode;
  readyGates: number;
  totalGates: number;
  gates: ProcurementV1ReadinessGate[];
  portfolio: {
    totalPurchaseOrders: number;
    activePurchaseOrders: number;
    local: number;
    import: number;
    unclassified: number;
    byStage: Record<'po_sent' | 'supplier_commitment' | 'fulfilment_production' | 'dispatch_transit' | 'delivery_grn', number>;
    fiveStageClosedLoop: number;
  };
}

type OperationsReadiness = {
  queue?: {
    workerReady?: boolean;
    pollerCount?: number;
    deadLetter?: number;
    staleRuns?: number;
  };
  sideEffects?: {
    failed?: number;
    manualReconciliation?: number;
    expiredLeases?: number;
  };
  outbox?: {
    failed?: number;
    blocked?: number;
    expiredLeases?: number;
  };
  documents?: {
    failed?: number;
    expiredLeases?: number;
    pendingMalwareScan?: number;
    quarantined?: number;
    scanFailed?: number;
    malwareScanner?: { status?: string };
  };
  manufacturingContext?: {
    workerReady?: boolean;
    lastHeartbeatAt?: string | null;
    pollIntervalMs?: number;
  };
};

type PortfolioItem = {
  id: string;
  active: boolean;
  route: 'local' | 'import' | 'unclassified';
  stage: 'po_sent' | 'supplier_commitment' | 'fulfilment_production' | 'dispatch_transit' | 'delivery_grn';
};

interface CredentialRow { name: string; status: string; last_tested_at: string | null; last_error: string | null }
interface InboundMailRow {
  configured: number;
  connected: number;
  provider: string | null;
  mailbox: string | null;
  last_completed_at: string | null;
  last_status: string | null;
  last_error: string | null;
  next_poll_at: string | null;
  consecutive_failures: number;
}

/**
 * Navisight-aligned V1 release gates. Every value is computed from persisted
 * tenant facts plus the already-observed production runtime snapshot. The
 * console must not reinterpret credentials, queue state, or PO stage evidence.
 */
export function procurementV1Readiness(
  db: DatabaseSync,
  tenantId: string,
  operations: OperationsReadiness,
  now = new Date(),
): ProcurementV1ReadinessView {
  initializeControlPlaneSchema(db);

  const identity = db.prepare(`SELECT display_name,title,organization_name,status,version
    FROM procurement_communication_identities WHERE tenant_id=?`).get(tenantId) as Record<string, unknown> | undefined;
  const publishedSla = db.prepare(`SELECT id,name,version,published_at
    FROM procurement_sla_policies WHERE tenant_id=? AND status='published'
    ORDER BY published_at DESC,id LIMIT 1`).get(tenantId) as Record<string, unknown> | undefined;
  const emailCredential = latestCredential(db, tenantId, 'email');
  const erpCredential = latestCredential(db, tenantId, 'erp');
  const inboundMail = db.prepare(`SELECT configured,connected,provider,mailbox,last_completed_at,last_status,last_error,next_poll_at,consecutive_failures
    FROM procurement_inbound_mail_status WHERE tenant_id=?`).get(tenantId) as unknown as InboundMailRow | undefined;

  const portfolio = procurementPortfolio(db, tenantId);
  const items = Array.isArray(portfolio['items']) ? portfolio['items'] as PortfolioItem[] : [];
  const active = items.filter((item) => item.active);
  const deploymentMode = effectiveProcurementDeploymentMode(db, tenantId);
  const closedLoopPoIds = completedFiveStagePoIds(db, tenantId, deploymentMode);
  const fiveStageClosedLoop = items.filter((item) => item.route === 'local' && closedLoopPoIds.has(item.id)).length;
  const byStage: ProcurementV1ReadinessView['portfolio']['byStage'] = {
    po_sent: 0,
    supplier_commitment: 0,
    fulfilment_production: 0,
    dispatch_transit: 0,
    delivery_grn: 0,
  };
  for (const item of active) byStage[item.stage] += 1;

  const identityReady = identity?.['status'] === 'active';
  const slaReady = Boolean(publishedSla);
  const outboundReady = emailCredential?.status === 'connected' && !emailCredential.last_error;
  const inboundReady = inboundMail?.configured === 1
    && inboundMail.connected === 1
    && (inboundMail.last_status === 'completed'
      || (inboundMail.last_status === 'running' && inboundMail.last_completed_at !== null))
    && Number(inboundMail.consecutive_failures) === 0;
  const odooReady = erpCredential?.status === 'connected' && !erpCredential.last_error;
  const acceptedEmailPurchaseOrders = Number((db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_intake_candidates
    WHERE tenant_id=? AND status='accepted' AND accepted_po_id IS NOT NULL`).get(tenantId) as { count: number }).count ?? 0);
  const orderSourceReady = deploymentMode === 'email_only' ? acceptedEmailPurchaseOrders > 0 : odooReady;

  const documents = operations.documents ?? {};
  const documentIssues = sum([
    documents.failed,
    documents.expiredLeases,
    documents.pendingMalwareScan,
    documents.quarantined,
    documents.scanFailed,
  ]);
  const documentReady = documents.malwareScanner?.status === 'ready' && documentIssues === 0;

  const queue = operations.queue ?? {};
  const sideEffects = operations.sideEffects ?? {};
  const outbox = operations.outbox ?? {};
  const runtimeIssues = sum([
    queue.deadLetter,
    queue.staleRuns,
    sideEffects.failed,
    sideEffects.manualReconciliation,
    sideEffects.expiredLeases,
    outbox.failed,
    outbox.blocked,
    outbox.expiredLeases,
  ]);
  const runtimeReady = queue.workerReady === true && Number(queue.pollerCount ?? 0) > 0 && runtimeIssues === 0;

  const manufacturingContext = operations.manufacturingContext ?? {};
  const projectionHealth = db.prepare(`SELECT
      SUM(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END) AS dead_letter,
      MIN(CASE WHEN status IN ('queued','retry_wait') THEN available_at END) AS oldest_pending_at
    FROM twin_projection_jobs WHERE tenant_id=?`).get(tenantId) as unknown as {
      dead_letter: number | null;
      oldest_pending_at: string | null;
    };
  const contextDeadLetter = Number(projectionHealth.dead_letter ?? 0);
  const contextPollIntervalMs = Number(manufacturingContext.pollIntervalMs);
  const contextHeartbeatAt = manufacturingContext.lastHeartbeatAt === null
    || manufacturingContext.lastHeartbeatAt === undefined
    ? Number.NaN
    : Date.parse(manufacturingContext.lastHeartbeatAt);
  const contextHeartbeatAgeMs = now.getTime() - contextHeartbeatAt;
  const oldestPendingAt = projectionHealth.oldest_pending_at;
  const oldestPendingAgeMs = oldestPendingAt === null ? 0 : now.getTime() - Date.parse(oldestPendingAt);
  const manufacturingContextReady = manufacturingContext.workerReady === true
    && Number.isFinite(contextPollIntervalMs)
    && contextPollIntervalMs > 0
    && Number.isFinite(contextHeartbeatAgeMs)
    && contextHeartbeatAgeMs >= 0
    && contextHeartbeatAgeMs <= 2 * contextPollIntervalMs
    && contextDeadLetter === 0
    && Number.isFinite(oldestPendingAgeMs)
    && oldestPendingAgeMs <= 10 * 60_000;

  const securityIncidents = securityIncidentSummary(db, tenantId);
  const openSecurityWarnings = securityIncidents.open;
  const localCount = active.filter((item) => item.route === 'local').length;
  const localPortfolioCount = items.filter((item) => item.route === 'local').length;

  const gates: ProcurementV1ReadinessGate[] = [
    gate('communication_identity', '供应商可见采购身份', identityReady,
      identityReady ? `${String(identity?.['display_name'])} · ${String(identity?.['title'])}` : '尚未配置具名采购联系人',
      identityReady ? `${String(identity?.['organization_name'])} · v${Number(identity?.['version'] ?? 0)}` : '缺少真实姓名、职位或公司时，草稿生成、审批和外发保持阻断。',
      'communication-identity'),
    gate('published_sla', '正式 SLA 策略', slaReady,
      slaReady ? `${String(publishedSla?.['name'])} · v${Number(publishedSla?.['version'] ?? 0)}` : '没有已发布 SLA',
      slaReady ? `发布时间：${String(publishedSla?.['published_at'] ?? '未记录')}` : '草稿不会启动正式阶段时钟；必须由有双权限的采购经理确认发布。',
      'sla'),
    gate('outbound_email', '企业邮箱外发', outboundReady,
      outboundReady ? `${emailCredential!.name} · 已验证` : credentialSummary(emailCredential),
      outboundReady ? `最近验证：${emailCredential!.last_tested_at ?? '时间未记录'}` : credentialDetail(emailCredential, 'SMTP'),
      'connector-email'),
    gate('inbound_email', '供应商回信接收', inboundReady,
      inboundReady ? `${inboundMail!.provider ?? 'IMAP'} · 正常轮询` : inboundMailSummary(inboundMail),
      inboundReady ? `邮箱：${inboundMail!.mailbox ?? '已配置'}；最近轮询完成且无连续失败` : inboundMailDetail(inboundMail, now),
      'connector-email'),
    gate('odoo', deploymentMode === 'email_only' ? '纯邮箱 PO 接入' : '本地 Odoo ERP', orderSourceReady,
      deploymentMode === 'email_only'
        ? acceptedEmailPurchaseOrders > 0 ? `${acceptedEmailPurchaseOrders} 张邮箱 PO 已通过人工核验接入` : '尚无已核验的邮箱 PO'
        : odooReady ? `${erpCredential!.name} · 已验证` : credentialSummary(erpCredential),
      deploymentMode === 'email_only'
        ? '当前为纯邮箱模式：PO 附件必须经 ClamAV、解析和人工核验后进入五阶段，Odoo 不作为发布门槛。'
        : odooReady ? `最近验证：${erpCredential!.last_tested_at ?? '时间未记录'}` : credentialDetail(erpCredential, 'Odoo'),
      deploymentMode === 'email_only' ? 'po-intake' : 'connector-erp'),
    gate('document_security', 'ClamAV 与附件外发门禁', documentReady,
      documentReady ? '扫描器已验证，当前无不安全附件' : '附件安全门禁尚未完全就绪',
      `扫描器：${documents.malwareScanner?.status ?? '未观测'}；待处理或失败：${documentIssues}`,
      'document-gate'),
    gate('durable_runtime', '可靠队列、重试与死信', runtimeReady,
      runtimeReady ? `Temporal Worker 在线 · ${Number(queue.pollerCount ?? 0)} 个 Poller` : '生产运行时存在阻断项',
      `死信 ${Number(queue.deadLetter ?? 0)} · 停滞 ${Number(queue.staleRuns ?? 0)} · 副作用/Outbox 问题 ${runtimeIssues}`,
      'runtime'),
    gate('manufacturing_context', '制造上下文投影', manufacturingContextReady,
      manufacturingContextReady ? 'Context Worker 在线，投影队列健康' : 'Context 投影运行时存在阻断项',
      `心跳 ${manufacturingContext.lastHeartbeatAt ?? '未观测'} · 死信 ${contextDeadLetter} · 最早待处理 ${oldestPendingAt ?? '无'}`,
      'runtime'),
    gate('security_events', '安全告警处置', openSecurityWarnings === 0,
      openSecurityWarnings === 0 ? '没有未处置的 warning / critical 安全事故' : `${openSecurityWarnings} 个安全事故未处置`,
      openSecurityWarnings === 0 ? `安全事件原始证据和处置审计均保留；历史原始事件 ${securityIncidents.rawEvents} 条。` : `对应 ${securityIncidents.rawEvents} 条不可变原始事件；必须修复或由管理员记录接受风险依据，系统不会自动清除。`,
      'security-events'),
    gate('local_purchase_order', '真实本地采购订单', localPortfolioCount > 0,
      localPortfolioCount > 0 ? `${localPortfolioCount} 张 PO 已取得本地路线证据` : '当前没有明确归类的本地 PO',
      `${active.length} 张活跃 PO：本地 ${localCount}、进口 ${active.filter((item) => item.route === 'import').length}、未分类 ${active.filter((item) => item.route === 'unclassified').length}；已完成的本地闭环仍保留为发布证据。`,
      'local-procurement'),
    gate('five_stage_closed_loop', '真实五阶段闭环', fiveStageClosedLoop > 0,
      fiveStageClosedLoop > 0 ? `${fiveStageClosedLoop} 张本地 PO 已完成五阶段闭环` : '尚无本地 PO 完成真实五阶段闭环',
      deploymentMode === 'email_only'
        ? '闭环要求五阶段均有非迁移的精确完成证据；最终 Delivery / GRN 可来自 Odoo/WMS，或由有权限人员核验真实仓库 GRN 依据。'
        : '闭环要求五阶段均有非迁移的精确完成证据，最终 Delivery / GRN 必须来自 Odoo/WMS 回执。',
      'local-procurement'),
  ];
  const readyGates = gates.filter((item) => item.status === 'ready').length;
  return {
    status: readyGates === gates.length ? 'ready' : 'blocked',
    checkedAt: now.toISOString(),
    deploymentMode,
    readyGates,
    totalGates: gates.length,
    gates,
    portfolio: {
      totalPurchaseOrders: items.length,
      activePurchaseOrders: active.length,
      local: active.filter((item) => item.route === 'local').length,
      import: active.filter((item) => item.route === 'import').length,
      unclassified: active.filter((item) => item.route === 'unclassified').length,
      byStage,
      fiveStageClosedLoop,
    },
  };
}

function gate(
  id: ProcurementV1ReadinessGate['id'],
  label: string,
  ready: boolean,
  summary: string,
  detail: string,
  target: ProcurementV1ReadinessGate['target'],
): ProcurementV1ReadinessGate {
  return { id, label, status: ready ? 'ready' : 'blocked', summary, detail, target };
}

function latestCredential(db: DatabaseSync, tenantId: string, connectorId: string): CredentialRow | undefined {
  return db.prepare(`SELECT name,status,last_tested_at,last_error FROM control_credentials
    WHERE tenant_id=? AND connector_id=? ORDER BY updated_at DESC,id DESC LIMIT 1`)
    .get(tenantId, connectorId) as unknown as CredentialRow | undefined;
}

function credentialSummary(credential: CredentialRow | undefined): string {
  if (!credential) return '尚未保存凭据';
  return `${credential.name} · ${credential.status}`;
}

function credentialDetail(credential: CredentialRow | undefined, channel: string): string {
  if (!credential) return `${channel} 凭据缺失，外部动作保持阻断。`;
  return credential.last_error ? `${channel} 最近验证失败：${credential.last_error}` : `${channel} 尚未取得成功连接回执。`;
}

function inboundMailSummary(status: InboundMailRow | undefined): string {
  if (!status?.configured) return 'IMAP 尚未配置';
  if (!status.connected) return 'IMAP 未连接';
  if (status.last_status === 'failed' && status.next_poll_at) return 'IMAP 已配置，但当前限流或退避中';
  if (status.last_status === 'running') return 'IMAP 正在轮询，尚未完成';
  return `IMAP 最近状态：${status.last_status ?? '未验证'}`;
}

function inboundMailDetail(status: InboundMailRow | undefined, now: Date): string {
  if (!status) return '没有持久化入站邮箱运行状态。';
  const retryAt = status.next_poll_at && Date.parse(status.next_poll_at) > now.getTime() ? `；下次自动重试 ${status.next_poll_at}` : '';
  const error = status.last_error ? `；最近错误：${status.last_error}` : '';
  return `邮箱：${status.mailbox ?? '未提供'}；连续失败 ${Number(status.consecutive_failures)}${retryAt}${error}`;
}

function completedFiveStagePoIds(db: DatabaseSync, tenantId: string, deploymentMode: ProcurementDeploymentMode): Set<string> {
  const acceptedGrnSources = deploymentMode === 'email_only'
    ? "'odoo_grn','wms_grn','manual_verified_grn'"
    : "'odoo_grn','wms_grn'";
  const rows = db.prepare(`SELECT po_id
    FROM procurement_po_stage_events
    WHERE tenant_id=? AND state='completed'
      AND source_kind NOT IN ('migration','document_snapshot')
      AND COALESCE(json_extract(evidence_json,'$.exactTransitionTime'),0)=1
    GROUP BY po_id
    HAVING COUNT(DISTINCT stage)=5
      AND SUM(CASE WHEN stage='delivery_grn' AND source_kind IN (${acceptedGrnSources}) THEN 1 ELSE 0 END)>0`)
    .all(tenantId) as Array<{ po_id: string }>;
  return new Set(rows.map((row) => row.po_id));
}

function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + Number(value ?? 0), 0);
}
