import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';
import { procurementPortfolio } from './procurement-workbench.js';

export interface ProcurementSupplierPerformanceContext { readonly db: DatabaseSync; readonly session: Session | null; readonly now?: () => Date }
type Dimension = { code: string; label: string; score: number | null; weight: number; eligible: number; passed: number; evidence: string };
type SnapshotRow = { id: string; source_watermark: string; rule_version: string; as_of: string; snapshot_json: string; created_by: string; created_at: string };
type JsonRow = { id: string; status: string; json: string; created_at: string; updated_at: string };

const RULE_VERSION = 'supplier-execution-score-v1.1';
const dayMs = 86_400_000;
const completionStatuses = new Set(['received', 'closed']);
const commitmentStatuses = new Set(['confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped', 'shipped', 'partially_received', 'received', 'closed']);
const eligibleStatuses = new Set(['sent', 'awaiting_confirmation', ...commitmentStatuses]);

export async function handleProcurementSupplierPerformanceRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementSupplierPerformanceContext,
): Promise<boolean> {
  const root = path === '/api/procurement/supplier-performance';
  const refresh = path === '/api/procurement/supplier-performance/refresh';
  if (!root && !refresh) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  const { db, session } = context;
  try {
    if (root && method === 'GET') {
      if (!can(session, 'read')) return forbidden(res, '无读取供应商绩效权限');
      const range = dateRange(req.url, context.now?.() ?? new Date());
      const rows = db.prepare(`SELECT * FROM procurement_supplier_performance_snapshots WHERE tenant_id=? AND as_of>=? AND as_of<=? ORDER BY as_of,id`)
        .all(session.tenantId, range.from, range.to) as unknown as SnapshotRow[];
      const snapshots = rows.map(presentSnapshot); const latest = snapshots.at(-1) ?? null; const previous = snapshots.length > 1 ? snapshots.at(-2) ?? null : null;
      sendJson(res, 200, {
        range: { from: range.from.slice(0, 10), to: range.to.slice(0, 10) }, latest, previous,
        trend: snapshots.map((snapshot) => ({ snapshotId: snapshot.id, asOf: snapshot.asOf, averageScore: snapshot.metrics.averageScore, atRiskSuppliers: snapshot.metrics.atRiskSuppliers, evidenceCoverage: snapshot.metrics.evidenceCoverage })),
        rule: scoreRule(), snapshotCount: snapshots.length,
      }); return true;
    }
    if (refresh && method === 'POST') {
      if (!can(session, 'operate')) return forbidden(res, '无生成供应商绩效快照权限');
      const now = context.now?.() ?? new Date(); const sourceWatermark = sourceFingerprint(db, session.tenantId, now);
      const existing = findByWatermark(db, session.tenantId, sourceWatermark);
      if (existing) { sendJson(res, 200, { item: presentSnapshot(existing), replayed: true }); return true; }
      const id = `supplier-performance-snapshot:${randomUUID()}`; const asOf = now.toISOString();
      const snapshot = buildSnapshot(db, session.tenantId, id, sourceWatermark, asOf);
      db.prepare(`INSERT OR IGNORE INTO procurement_supplier_performance_snapshots
        (tenant_id,id,source_watermark,rule_version,as_of,snapshot_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(session.tenantId, id, sourceWatermark, RULE_VERSION, asOf, JSON.stringify(snapshot), session.humanId, asOf);
      const saved = findByWatermark(db, session.tenantId, sourceWatermark)!;
      sendJson(res, saved.id === id ? 201 : 200, { item: presentSnapshot(saved), replayed: saved.id !== id }); return true;
    }
    sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' }); return true;
  } catch (error) {
    if (error instanceof PerformanceInputError) { sendJson(res, 422, { error: error.message, code: 'INVALID_SUPPLIER_PERFORMANCE_RANGE' }); return true; }
    throw error;
  }
}

function buildSnapshot(db: DatabaseSync, tenantId: string, id: string, sourceWatermark: string, asOf: string): Record<string, any> {
  const suppliers = (db.prepare(`SELECT id,status,json,created_at,updated_at FROM procurement_documents WHERE tenant_id=? AND kind='supplier' ORDER BY id`)
    .all(tenantId) as JsonRow[]).map((row) => ({ row, document: safeJson(row.json) }));
  const poRows = db.prepare(`SELECT id,status,json,created_at,updated_at FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' ORDER BY id`).all(tenantId) as JsonRow[];
  const poLines = db.prepare(`SELECT document_id,json FROM procurement_lines WHERE tenant_id=? AND kind='purchase_order_line' ORDER BY document_id,line_number`).all(tenantId) as Array<{ document_id: string; json: string }>;
  const linesByPo = group(poLines.map((row) => ({ poId: row.document_id, line: safeJson(row.json) })), (item) => item.poId);
  const receipts = db.prepare(`SELECT id,json,created_at FROM procurement_documents WHERE tenant_id=? AND kind='receipt' AND status='received' ORDER BY created_at,id`).all(tenantId) as Array<{ id: string; json: string; created_at: string }>;
  const receiptsByPo = group(receipts.map((row) => { const document = safeJson(row.json); return { id: row.id, poId: String(document['poId'] ?? ''), receivedAt: iso(document['receivedAt']) ?? row.created_at }; }).filter((item) => item.poId), (item) => item.poId);
  const communications = db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='communication'`).all(tenantId) as Array<{ json: string }>;
  const inboundByPo = group(communications.map((row) => safeJson(row.json)).filter((item) => item['businessObjectType'] === 'purchase_order' && item['direction'] === 'inbound' && typeof item['businessObjectId'] === 'string').map((item) => ({ poId: String(item['businessObjectId']), at: iso(item['receivedAt']) ?? iso(item['occurredAt']) ?? null })), (item) => item.poId);
  const slaRows = db.prepare(`SELECT po_id,status,due_at,grace_until,evaluated_at FROM procurement_sla_evaluations WHERE tenant_id=?`).all(tenantId) as Array<{ po_id: string; status: string; due_at: string | null; grace_until: string | null; evaluated_at: string }>;
  const slaByPo = new Map(slaRows.map((row) => [row.po_id, row] as const));
  const importRows = db.prepare(`SELECT po_id,status,summary_json,evaluated_at FROM procurement_import_document_evaluations WHERE tenant_id=?`).all(tenantId) as Array<{ po_id: string; status: string; summary_json: string; evaluated_at: string }>;
  const importByPo = new Map(importRows.map((row) => [row.po_id, row] as const));
  const portfolio = procurementPortfolio(db, tenantId) as { items?: Array<{ id: string; supplierId: string; riskScore: number; risk: string; riskFactors: unknown[] }> };
  const portfolioByPo = new Map((portfolio.items ?? []).map((item) => [item.id, item] as const));
  const poBySupplier = group(poRows.map((row) => ({ row, document: safeJson(row.json) })).filter((item) => typeof item.document['supplierId'] === 'string'), (item) => String(item.document['supplierId']));

  const items = suppliers.map(({ row, document: supplier }) => {
    const pos = poBySupplier.get(row.id) ?? []; const commitmentEligible = pos.filter((item) => eligibleStatuses.has(item.row.status));
    const committed = commitmentEligible.filter((item) => commitmentStatuses.has(item.row.status));
    const actualResponseEvidence: Array<{ poId: string; orderedAt: string; receivedAt: string; responseHours: number }> = [];
    for (const item of commitmentEligible) {
      const orderedAt = iso(item.document['orderedAt']) ?? item.row.created_at;
      const inbound = (inboundByPo.get(item.row.id) ?? []).map((entry) => entry.at).filter((value): value is string => Boolean(value)).sort()[0];
      if (inbound && Date.parse(inbound) >= Date.parse(orderedAt)) actualResponseEvidence.push({
        poId: item.row.id,
        orderedAt,
        receivedAt: inbound,
        responseHours: round((Date.parse(inbound) - Date.parse(orderedAt)) / 3_600_000, 1),
      });
    }
    const slaEligible = pos.map((item) => slaByPo.get(item.row.id)).filter((value): value is NonNullable<typeof value> => Boolean(value) && !['blocked_missing_evidence', 'unmatched'].includes(value!.status));
    const slaScores = slaEligible.map((item) => ({ on_track: 100, due_soon: 85, in_grace: 60, breached: 20, escalated: 0 }[item.status] ?? 0));
    const completed = pos.filter((item) => completionStatuses.has(item.row.status));
    const deliveryEvidence = completed.flatMap((item) => {
      const receiptAt = (receiptsByPo.get(item.row.id) ?? []).map((receipt) => receipt.receivedAt).sort().at(-1);
      const lineDates = (linesByPo.get(item.row.id) ?? []).map((entry) => iso(entry.line['requestedAt'])).filter((value): value is string => Boolean(value));
      const requiredAt = iso(item.document['requiredInHouseAt']) ?? iso(item.document['promisedAt']) ?? lineDates.sort().at(-1);
      return receiptAt && requiredAt ? [{ poId: item.row.id, receiptAt, requiredAt, onTime: Date.parse(receiptAt) <= Date.parse(requiredAt) }] : [];
    });
    const importEligible = pos.map((item) => importByPo.get(item.row.id)).filter((value): value is NonNullable<typeof value> => Boolean(value) && value!.status !== 'policy_missing');
    const importScores = importEligible.map((item) => item.status === 'passed' || item.status === 'on_track' ? 100 : item.status === 'missing' ? 25 : 0);
    const commitmentScore = commitmentEligible.length ? percent(committed.length, commitmentEligible.length) : null;
    const slaScore = slaScores.length ? average(slaScores) : null; const deliveryScore = deliveryEvidence.length ? percent(deliveryEvidence.filter((item) => item.onTime).length, deliveryEvidence.length) : null;
    const complianceScore = importScores.length ? average(importScores) : null;
    const dimensions: Dimension[] = [
      { code: 'supplier_commitment', label: '供应商承诺', score: commitmentScore, weight: 30, eligible: commitmentEligible.length, passed: committed.length, evidence: commitmentEligible.length ? `${committed.length}/${commitmentEligible.length} 张 PO 已取得承诺` : '没有进入承诺阶段的 PO' },
      { code: 'sla_compliance', label: 'SLA 履约', score: slaScore, weight: 25, eligible: slaEligible.length, passed: slaEligible.filter((item) => ['on_track', 'due_soon'].includes(item.status)).length, evidence: slaEligible.length ? `${slaEligible.length} 条已发布 SLA 评估` : '尚无可用 SLA 评估' },
      { code: 'on_time_delivery', label: '准时交付', score: deliveryScore, weight: 30, eligible: deliveryEvidence.length, passed: deliveryEvidence.filter((item) => item.onTime).length, evidence: deliveryEvidence.length ? `${deliveryEvidence.filter((item) => item.onTime).length}/${deliveryEvidence.length} 张完成 PO 准时到货` : '尚无同时具备 RIHD 与 GRN 的完成 PO' },
      { code: 'import_compliance', label: '进口单证合规', score: complianceScore, weight: 15, eligible: importEligible.length, passed: importEligible.filter((item) => ['passed', 'on_track'].includes(item.status)).length, evidence: importEligible.length ? `${importEligible.length} 条进口单证校验` : '尚无适用进口单证评估' },
    ];
    const available = dimensions.filter((item) => item.score !== null); const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
    const score = availableWeight ? round(available.reduce((sum, item) => sum + item.score! * item.weight, 0) / availableWeight, 1) : null;
    const riskItems = pos.map((item) => portfolioByPo.get(item.row.id)).filter(Boolean) as Array<{ riskScore: number; risk: string; riskFactors: unknown[] }>;
    const evidenceCoverage = availableWeight; const confidence = evidenceCoverage >= 75 && pos.length >= 5 ? 'high' : evidenceCoverage >= 45 && pos.length >= 2 ? 'medium' : 'low';
    return {
      supplierId: row.id, supplierName: String(supplier['name'] ?? row.id), status: row.status, currency: supplier['currency'] ?? null,
      contacts: Array.isArray(supplier['contacts']) ? supplier['contacts'] : [], purchaseOrders: pos.length,
      activePurchaseOrders: pos.filter((item) => !['draft', 'received', 'closed', 'cancelled'].includes(item.row.status)).length,
      completedPurchaseOrders: completed.length, score, grade: grade(score, evidenceCoverage), confidence, evidenceCoverage, dimensions,
      actualResponseSamples: actualResponseEvidence.length,
      averageResponseHours: actualResponseEvidence.length ? round(average(actualResponseEvidence.map((item) => item.responseHours)), 1) : null,
      actualResponseEvidence,
      slaBreaches: slaEligible.filter((item) => ['breached', 'escalated'].includes(item.status)).length,
      overduePurchaseOrders: riskItems.filter((item) => item.riskFactors.some((factor: any) => factor?.code === 'rihd_overdue')).length,
      averageRiskScore: riskItems.length ? round(average(riskItems.map((item) => item.riskScore)), 1) : null,
      highRiskPurchaseOrders: riskItems.filter((item) => item.risk === 'high').length,
      deliveryEvidence,
      purchaseOrderItems: pos.map((item) => {
        const portfolioItem = portfolioByPo.get(item.row.id);
        const lines = (linesByPo.get(item.row.id) ?? []).map((entry) => entry.line);
        const requiredInHouseAt = iso(item.document['requiredInHouseAt']) ?? iso(item.document['promisedAt'])
          ?? lines.map((line) => iso(line['requestedAt'])).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
        const amountTotal = typeof item.document['amountTotal'] === 'number' && Number.isFinite(item.document['amountTotal'])
          ? item.document['amountTotal']
          : lines.reduce((sum, line) => sum + numeric(line['orderedQty']) * numeric(line['unitPrice']), 0);
        return {
          id: item.row.id,
          number: String(item.document['externalId'] ?? item.row.id),
          status: item.row.status,
          orderedAt: iso(item.document['orderedAt']) ?? item.row.created_at,
          requiredInHouseAt,
          currency: item.document['currency'] ?? supplier['currency'] ?? null,
          amountTotal: round(amountTotal, 2),
          risk: portfolioItem?.risk ?? null,
          riskScore: portfolioItem?.riskScore ?? null,
          riskFactors: portfolioItem?.riskFactors ?? [],
          updatedAt: item.row.updated_at,
        };
      }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
      lastActivityAt: latest([row.updated_at, ...pos.map((item) => item.row.updated_at)]),
    };
  }).sort((left, right) => (left.score ?? 101) - (right.score ?? 101) || right.purchaseOrders - left.purchaseOrders || left.supplierName.localeCompare(right.supplierName));
  const scored = items.filter((item) => item.score !== null && item.grade !== 'insufficient_evidence'); const deliveryDims = items.flatMap((item) => item.dimensions.filter((dimension) => dimension.code === 'on_time_delivery' && dimension.eligible));
  const slaDims = items.flatMap((item) => item.dimensions.filter((dimension) => dimension.code === 'sla_compliance' && dimension.eligible));
  const commitmentDims = items.flatMap((item) => item.dimensions.filter((dimension) => dimension.code === 'supplier_commitment' && dimension.eligible));
  return {
    id, sourceWatermark, ruleVersion: RULE_VERSION, asOf, rule: scoreRule(),
    metrics: {
      totalSuppliers: items.length, scoredSuppliers: scored.length, averageScore: scored.length ? round(average(scored.map((item) => item.score!)), 1) : null,
      atRiskSuppliers: items.filter((item) => item.highRiskPurchaseOrders > 0 || item.slaBreaches > 0 || (item.grade !== 'insufficient_evidence' && item.score !== null && item.score < 70)).length,
      evidenceCoverage: items.length ? round(average(items.map((item) => item.evidenceCoverage)), 1) : 0,
      commitmentRate: ratioFromDimensions(commitmentDims), slaComplianceRate: ratioFromDimensions(slaDims), onTimeDeliveryRate: ratioFromDimensions(deliveryDims),
    },
    items,
  };
}

function scoreRule(): Record<string, unknown> { return { version: RULE_VERSION, basis: 'post_po_execution_only', missingEvidence: 'excluded_and_weight_renormalized', dimensions: [{ code: 'supplier_commitment', weight: 30 }, { code: 'sla_compliance', weight: 25 }, { code: 'on_time_delivery', weight: 30 }, { code: 'import_compliance', weight: 15 }], note: '评分仅使用真实 PO、已发布 SLA、GRN/RIHD 与进口单证事实；证据不足时单独显示覆盖率。' }; }
function sourceFingerprint(db: DatabaseSync, tenantId: string, now: Date): string {
  const documents = db.prepare(`SELECT kind,id,status,version,updated_at FROM procurement_documents WHERE tenant_id=? ORDER BY kind,id`).all(tenantId);
  const lines = db.prepare(`SELECT kind,id,document_id,line_number,json FROM procurement_lines WHERE tenant_id=? ORDER BY kind,id`).all(tenantId);
  const sla = db.prepare(`SELECT po_id,status,fingerprint,version,updated_at FROM procurement_sla_evaluations WHERE tenant_id=? ORDER BY po_id`).all(tenantId);
  const imports = db.prepare(`SELECT po_id,status,fingerprint,version,updated_at FROM procurement_import_document_evaluations WHERE tenant_id=? ORDER BY po_id`).all(tenantId);
  const routes = db.prepare(`SELECT po_id,route,source,version,updated_at FROM procurement_route_assignments WHERE tenant_id=? ORDER BY po_id`).all(tenantId);
  return createHash('sha256').update(JSON.stringify([documents, lines, sla, imports, routes, now.toISOString().slice(0, 10), RULE_VERSION])).digest('hex');
}
function findByWatermark(db: DatabaseSync, tenantId: string, watermark: string): SnapshotRow | undefined { return db.prepare(`SELECT * FROM procurement_supplier_performance_snapshots WHERE tenant_id=? AND source_watermark=?`).get(tenantId, watermark) as unknown as SnapshotRow | undefined; }
function presentSnapshot(row: SnapshotRow): Record<string, any> { const value = JSON.parse(row.snapshot_json) as Record<string, any>; return { ...value, id: row.id, sourceWatermark: row.source_watermark, ruleVersion: row.rule_version, asOf: row.as_of, createdBy: row.created_by, createdAt: row.created_at }; }
function dateRange(rawUrl: string | undefined, now: Date): { from: string; to: string } { const url = new URL(rawUrl ?? '/', 'http://127.0.0.1'); const toDefault = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999)); const fromDefault = new Date(toDefault.getTime() - 89 * dayMs); fromDefault.setUTCHours(0, 0, 0, 0); const from = parseDate(url.searchParams.get('from'), 'from', fromDefault, false); const to = parseDate(url.searchParams.get('to'), 'to', toDefault, true); if (from > to) throw new PerformanceInputError('开始日期不能晚于结束日期'); if (to.getTime() - from.getTime() > 366 * dayMs) throw new PerformanceInputError('日期范围不能超过 366 天'); return { from: from.toISOString(), to: to.toISOString() }; }
function parseDate(value: string | null, field: string, fallback: Date, end: boolean): Date { if (!value) return fallback; if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PerformanceInputError(`${field} 必须是 YYYY-MM-DD`); const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`); if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new PerformanceInputError(`${field} 日期无效`); return date; }
function ratioFromDimensions(items: Dimension[]): number | null { const eligible = items.reduce((sum, item) => sum + item.eligible, 0); return eligible ? round(items.reduce((sum, item) => sum + item.passed, 0) / eligible * 100, 1) : null; }
function grade(score: number | null, coverage: number): string { if (score === null || coverage < 45) return 'insufficient_evidence'; if (score >= 85) return 'strong'; if (score >= 70) return 'stable'; if (score >= 50) return 'watch'; return 'at_risk'; }
function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> { const result = new Map<string, T[]>(); for (const item of items) { const value = key(item); const list = result.get(value) ?? []; list.push(item); result.set(value, list); } return result; }
function safeJson(raw: string): Record<string, any> { try { const value = JSON.parse(raw) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; } catch { return {}; } }
function iso(value: unknown): string | null { if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) return null; return new Date(value).toISOString(); }
function latest(values: Array<string | null | undefined>): string | null { return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null; }
function percent(passed: number, total: number): number { return total ? round(passed / total * 100, 1) : 0; }
function average(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function numeric(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function round(value: number, digits: number): number { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function forbidden(res: ServerResponse, message: string): true { sendJson(res, 403, { error: message, code: 'FORBIDDEN' }); return true; }
class PerformanceInputError extends Error {}
