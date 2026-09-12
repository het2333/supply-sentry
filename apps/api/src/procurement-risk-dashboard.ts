import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { RiskModelV2Result } from '@readywork/core';
import { can, type Session } from './auth.js';
import { redactSensitiveValue } from './http-errors.js';
import { procurementPortfolio } from './procurement-workbench.js';

export interface ProcurementRiskDashboardContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly now?: () => Date;
}

type Risk = 'high' | 'medium' | 'low';
interface RiskFactor { code: string; label: string; score: number; evidence: string; evidenceDetail?: Record<string, unknown> }
interface PortfolioItem {
  id: string; number: string; supplierId: string; supplierName: string; materialType: string; route: string;
  risk: Risk; riskScore: number; riskFactors: RiskFactor[]; overdueDays: number; currency: string; amountTotal: number;
  requiredInHouseAt: string | null; nextAction: string;
  supplierPerformanceScore: number | null; active: boolean;
  riskModel: RiskModelV2Result;
  riskPublicationState: 'published' | 'provisional' | 'not_published';
  missingRiskComponents: string[];
  leadTimeConfiguration?: { autoCalculateLeadTime: boolean; preferenceVersion: number | null; inheritedDefault: boolean };
}
interface Portfolio {
  generatedAt: string;
  configurationWatermark: string;
  configuration?: Record<string, unknown>;
  items: PortfolioItem[];
}
interface SnapshotRow { id: string; source_watermark: string; as_of: string; snapshot_json: string; created_by: string; created_at: string }
interface CurrencyValues { [currency: string]: number }
interface RiskDashboardFilters {
  risk: Risk | null;
  route: 'local' | 'import' | 'unclassified' | null;
  supplierId: string | null;
  materialType: string | null;
}

const dayMs = 86_400_000;
const riskOrder: Risk[] = ['high', 'medium', 'low'];

export async function handleProcurementRiskDashboardRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementRiskDashboardContext,
): Promise<boolean> {
  const dashboard = path === '/api/procurement/risk-dashboard';
  const exportCsv = path === '/api/procurement/risk-dashboard/export';
  const refresh = path === '/api/procurement/risk-dashboard/refresh';
  if (!dashboard && !exportCsv && !refresh) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  const { db, session } = context;
  try {
    if (dashboard && method === 'GET') {
      if (!can(session, 'read')) return forbidden(res, '无读取采购风险权限');
      const now = context.now?.() ?? new Date();
      const range = dateRange(_req.url, now);
      const filters = dashboardFilters(_req.url);
      const rows = db.prepare(`SELECT id,source_watermark,as_of,snapshot_json,created_by,created_at
        FROM procurement_risk_snapshots WHERE tenant_id=? AND as_of>=? AND as_of<=?
        ORDER BY as_of,id`).all(session.tenantId, range.from, range.to) as unknown as SnapshotRow[];
      const unfilteredSnapshots = rows.map(presentSnapshot);
      const latestUnfiltered = unfilteredSnapshots.at(-1) ?? null;
      const snapshots = unfilteredSnapshots.map((snapshot) => filterSnapshot(snapshot, filters));
      const latest = snapshots.at(-1) ?? null;
      const previous = snapshots.length > 1 ? snapshots.at(-2) ?? null : null;
      const portfolio = procurementPortfolio(db, session.tenantId, now) as unknown as Portfolio;
      sendJson(res, 200, redactSensitiveValue({
        range: { from: range.from.slice(0, 10), to: range.to.slice(0, 10) },
        capabilities: { refresh: can(session, 'operate') },
        latest,
        previous,
        trend: snapshots.map((snapshot) => ({
          snapshotId: snapshot.id,
          modelVersion: snapshot.modelVersion,
          sourceWatermark: snapshot.sourceWatermark,
          asOf: snapshot.asOf,
          averageRiskScore: snapshot.metrics.averageRiskScore,
          highRiskPercent: snapshot.metrics.highRiskPercent,
          high: snapshot.metrics.high,
          medium: snapshot.metrics.medium,
          low: snapshot.metrics.low,
          atRiskValueByCurrency: snapshot.metrics.atRiskValueByCurrency,
          overviewMetrics: overviewMetrics(snapshot),
        })),
        snapshotCount: snapshots.length,
        appliedFilters: filters,
        filterOptions: filterOptions(latestUnfiltered),
        unfilteredItemCount: latestUnfiltered?.metrics?.total ?? 0,
        filteredItemCount: latest?.metrics?.total ?? 0,
        freshness: snapshotFreshness(portfolio, latestUnfiltered, now),
      }));
      return true;
    }
    if (exportCsv && method === 'GET') {
      if (!can(session, 'read')) return forbidden(res, '无导出采购风险权限');
      const range = dateRange(_req.url, context.now?.() ?? new Date());
      const filters = dashboardFilters(_req.url);
      const row = db.prepare(`SELECT id,source_watermark,as_of,snapshot_json,created_by,created_at
        FROM procurement_risk_snapshots WHERE tenant_id=? AND as_of>=? AND as_of<=?
        ORDER BY as_of DESC,id DESC LIMIT 1`).get(session.tenantId, range.from, range.to) as unknown as SnapshotRow | undefined;
      const snapshot = row ? filterSnapshot(presentSnapshot(row), filters) : null;
      sendCsv(res, snapshotCsv(snapshot), `readywork-risk-${range.to.slice(0, 10)}.csv`, snapshot?.id ?? null);
      return true;
    }
    if (refresh && method === 'POST') {
      if (!can(session, 'operate')) return forbidden(res, '无生成采购风险快照权限');
      const now = context.now?.() ?? new Date();
      const portfolio = procurementPortfolio(db, session.tenantId, now) as unknown as Portfolio;
      const sourceWatermark = portfolioSourceWatermark(portfolio, now);
      const existing = findByWatermark(db, session.tenantId, sourceWatermark);
      if (existing) { sendJson(res, 200, { item: presentSnapshot(existing), replayed: true }); return true; }
      const id = `procurement-risk-snapshot:${randomUUID()}`;
      const asOf = now.toISOString();
      const snapshot = buildSnapshot(portfolio, id, sourceWatermark, asOf);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`INSERT OR IGNORE INTO procurement_risk_snapshots
          (tenant_id,id,source_watermark,as_of,snapshot_json,created_by,created_at) VALUES (?,?,?,?,?,?,?)`)
          .run(session.tenantId, id, sourceWatermark, asOf, JSON.stringify(snapshot), session.humanId, asOf);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const saved = findByWatermark(db, session.tenantId, sourceWatermark)!;
      sendJson(res, saved.id === id ? 201 : 200, { item: presentSnapshot(saved), replayed: saved.id !== id });
      return true;
    }
    sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
    return true;
  } catch (error) {
    if (error instanceof RiskInputError) { sendJson(res, 422, { error: error.message, code: 'INVALID_RISK_RANGE' }); return true; }
    throw error;
  }
}

function snapshotFreshness(portfolio: Portfolio, latest: Record<string, any> | null, now: Date) {
  const currentSourceWatermark = portfolioSourceWatermark(portfolio, now);
  const activeItems = portfolio.items.filter((item) => item.active);
  const publishedItems = activeItems.filter((item) => item.riskPublicationState === 'published');
  const high = publishedItems.filter((item) => item.risk === 'high').length;
  const medium = publishedItems.filter((item) => item.risk === 'medium').length;
  const low = publishedItems.filter((item) => item.risk === 'low').length;
  const latestSourceWatermark = typeof latest?.['sourceWatermark'] === 'string' ? latest['sourceWatermark'] : null;
  const state = latestSourceWatermark === null ? 'missing'
    : latestSourceWatermark === currentSourceWatermark ? 'current' : 'stale';
  const latestWatermarkParts = latestSourceWatermark?.split('|') ?? [];
  const latestPortfolioWatermark = latestWatermarkParts[0] ?? null;
  const latestConfigurationWatermark = latestWatermarkParts[1] ?? null;
  const reason = state !== 'stale' ? null
    : latestPortfolioWatermark !== portfolio.generatedAt ? 'portfolio_facts_changed'
      : latestConfigurationWatermark !== portfolio.configurationWatermark ? 'configuration_changed'
        : 'calendar_day_changed';
  return {
    state,
    reason,
    evaluatedAt: now.toISOString(),
    currentSourceWatermark,
    latestSnapshotSourceWatermark: latestSourceWatermark,
    latestSnapshotAt: typeof latest?.['asOf'] === 'string' ? latest['asOf'] : null,
    liveMetrics: {
      total: activeItems.length,
      high,
      medium,
      low,
      overdue: activeItems.filter((item) => item.overdueDays > 0).length,
      highRiskPercent: activeItems.length ? round(high / activeItems.length * 100, 1) : 0,
    },
  };
}

/**
 * The Overview dashboard reuses the immutable risk snapshot instead of
 * inventing a second history table.  Every value below is reconstructed from
 * the PO evidence frozen in that snapshot, so old points remain auditable even
 * when the live portfolio later changes.
 */
function overviewMetrics(snapshot: Record<string, any>) {
  const items = Array.isArray(snapshot['items'])
    ? snapshot['items'].filter((item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
  const high = Number(snapshot['metrics']?.['high'] ?? 0);
  const medium = Number(snapshot['metrics']?.['medium'] ?? 0);
  return {
    highRisk: high,
    overdue: items.filter((item) => Number(item['overdueDays'] ?? 0) > 0).length,
    requireAttention: high + medium,
    activePurchaseOrders: Number(snapshot['metrics']?.['total'] ?? items.length),
    localProcurement: items.filter((item) => item['route'] === 'local').length,
    importProcurement: items.filter((item) => item['route'] === 'import').length,
  };
}

function buildSnapshot(portfolio: Portfolio, id: string, sourceWatermark: string, asOf: string) {
  const items = portfolio.items.filter((item) => item.active);
  const supplierProfileVersions = Object.fromEntries(items.flatMap((item) => {
    const reference = item.riskModel.components.productCriticality.evidenceReferences
      .find((candidate) => candidate.type === 'supplier_operating_profile');
    return reference ? [[item.supplierId, reference.version]] : [];
  }).sort(([left], [right]) => String(left).localeCompare(String(right))));
  return {
    ...aggregateSnapshot(items, id, sourceWatermark, asOf),
    modelVersion: 'risk-model-v2',
    thresholds: { high: 70, medium: 40 },
    inputWatermarks: { portfolio: portfolio.generatedAt, configuration: portfolio.configurationWatermark },
    tenantSettingsVersion: (portfolio.configuration?.['leadTime'] as Record<string, unknown> | undefined)?.['preferenceVersion'] ?? null,
    supplierProfileVersions,
    generatedAt: asOf,
    configuration: portfolio.configuration ?? null,
  };
}

function aggregateSnapshot(items: PortfolioItem[], id: string, sourceWatermark: string, asOf: string) {
  const publishedItems = items.filter((item) => item.riskPublicationState === undefined || item.riskPublicationState === 'published' || (item.riskPublicationState as string) === 'legacy');
  const high = publishedItems.filter((item) => item.risk === 'high').length;
  const medium = publishedItems.filter((item) => item.risk === 'medium').length;
  const low = publishedItems.filter((item) => item.risk === 'low').length;
  const provisional = items.filter((item) => item.riskPublicationState === 'provisional').length;
  const unpublished = items.filter((item) => item.riskPublicationState === 'not_published').length;
  const atRiskItems = publishedItems.filter((item) => item.risk !== 'low');
  const atRiskValueByCurrency = sumCurrency(atRiskItems);
  const averageRiskScore = roundedAverage(items.filter((item) => item.riskPublicationState !== 'not_published').map((item) => item.riskScore));

  const v2Definitions = ([
    ['supplier_performance', '供应商表现', 'supplierPerformance'],
    ['delivery_delay', '交付延迟', 'deliveryDelay'],
    ['po_value', 'PO 金额', 'poValue'],
    ['product_criticality', '产品关键性', 'productCriticality'],
    ['compliance_approval', '合规与审批', 'complianceApproval'],
  ] as const);
  const hasV2Components = items.some((item) => item.riskModel?.modelVersion === 'risk-model-v2');
  const riskBreakdown = hasV2Components ? v2Definitions.map(([code, label, componentName]) => {
    const components = items.filter((item) => item.riskModel?.modelVersion === 'risk-model-v2').map((item) => item.riskModel.components[componentName]);
    const usable = components.filter((component) => component.evidenceState === 'observed' || component.evidenceState === 'derived');
    return {
      code,
      label,
      weight: components[0]?.weight ?? { supplierPerformance: 0.30, deliveryDelay: 0.25, poValue: 0.20, productCriticality: 0.15, complianceApproval: 0.10 }[componentName],
      score: roundedAverage(usable.map((component) => component.score!)),
      evidenceCoverage: items.length ? round(usable.length / items.length, 2) : 0,
      affectedPurchaseOrders: usable.filter((component) => component.score! > 0).length,
    };
  }) : legacyRiskBreakdown(items);

  const supplierGroups = groupBy(items, (item) => item.supplierId);
  const suppliers = [...supplierGroups.values()].map((group) => ({
    supplierId: group[0]!.supplierId,
    supplierName: group[0]!.supplierName,
    purchaseOrders: group.length,
    riskScore: roundedAverage(group.map((item) => item.riskScore)),
    atRiskValueByCurrency: sumCurrency(group.filter((item) => (item.riskPublicationState === 'published' || (item.riskPublicationState as string) === 'legacy') && item.risk !== 'low')),
  })).sort((left, right) => right.riskScore - left.riskScore || left.supplierName.localeCompare(right.supplierName)).slice(0, 10);

  const agingDefinitions: Array<{ code: string; label: string; min: number; max: number }> = [
    { code: '1_7', label: '1–7 天', min: 1, max: 7 },
    { code: '8_14', label: '8–14 天', min: 8, max: 14 },
    { code: '15_30', label: '15–30 天', min: 15, max: 30 },
    { code: '31_60', label: '31–60 天', min: 31, max: 60 },
    { code: 'over_60', label: '60 天以上', min: 61, max: Number.POSITIVE_INFINITY },
  ];
  const aging = agingDefinitions.map((bucket) => {
    const matching = items.filter((item) => item.overdueDays >= bucket.min && item.overdueDays <= bucket.max);
    return { code: bucket.code, label: bucket.label, purchaseOrders: matching.length, atRiskValueByCurrency: sumCurrency(matching) };
  });

  const productGroups = groupBy(items.filter((item) => item.overdueDays > 0), (item) => item.materialType);
  const products = [...productGroups.entries()].map(([materialType, group]) => ({
    materialType,
    delayedPurchaseOrders: group.length,
    averageRiskScore: roundedAverage(group.map((item) => item.riskScore)),
    atRiskValueByCurrency: sumCurrency(group),
  })).sort((left, right) => right.delayedPurchaseOrders - left.delayedPurchaseOrders || right.averageRiskScore - left.averageRiskScore).slice(0, 10);

  return {
    id,
    sourceWatermark,
    asOf,
    metrics: {
      total: items.length,
      high,
      medium,
      low,
      highRiskPercent: items.length ? round(high / items.length * 100, 1) : 0,
      provisional,
      unpublished,
      atRiskValueByCurrency,
      averageRiskScore,
    },
    riskDistribution: riskOrder.map((risk) => ({ risk, count: { high, medium, low }[risk] })),
    riskBreakdown,
    suppliers,
    aging,
    products,
    items: items.map((item) => ({
      purchaseOrderId: item.id,
      number: item.number,
      supplierId: item.supplierId,
      supplierName: item.supplierName,
      materialType: item.materialType,
      route: item.route,
      risk: item.risk,
      riskScore: item.riskScore,
      riskModel: item.riskModel,
      riskPublicationState: item.riskPublicationState,
      missingRiskComponents: item.missingRiskComponents,
      riskFactors: item.riskFactors,
      requiredInHouseAt: item.requiredInHouseAt,
      overdueDays: item.overdueDays,
      currency: item.currency,
      amountTotal: item.amountTotal,
      nextAction: item.nextAction,
      supplierPerformanceScore: item.supplierPerformanceScore,
      leadTimeConfiguration: item.leadTimeConfiguration ?? null,
    })),
  };
}

function portfolioSourceWatermark(portfolio: Portfolio, now: Date): string {
  return `${portfolio.generatedAt}|${portfolio.configurationWatermark}|${now.toISOString().slice(0, 10)}`;
}

function filterSnapshot(snapshot: Record<string, any>, filters: RiskDashboardFilters): Record<string, any> {
  if (!Object.values(filters).some(Boolean)) return snapshot;
  const rawItems = Array.isArray(snapshot['items']) ? snapshot['items'] : [];
  const items = rawItems.filter((item: Record<string, any>) =>
    (!filters.risk || ((item['riskPublicationState'] === undefined || item['riskPublicationState'] === 'published' || item['riskPublicationState'] === 'legacy') && item['risk'] === filters.risk))
    && (!filters.route || item['route'] === filters.route)
    && (!filters.supplierId || item['supplierId'] === filters.supplierId)
    && (!filters.materialType || item['materialType'] === filters.materialType)
  ).map((item: Record<string, any>) => ({
    ...item,
    active: true,
    requiredInHouseAt: typeof item['requiredInHouseAt'] === 'string' ? item['requiredInHouseAt'] : null,
    nextAction: typeof item['nextAction'] === 'string' ? item['nextAction'] : '',
    supplierPerformanceScore: typeof item['supplierPerformanceScore'] === 'number' ? item['supplierPerformanceScore'] : null,
    riskFactors: Array.isArray(item['riskFactors']) ? item['riskFactors'] : [],
  })) as PortfolioItem[];
  return {
    ...snapshot,
    ...aggregateSnapshot(items, String(snapshot['id']), String(snapshot['sourceWatermark']), String(snapshot['asOf'])),
  };
}

function filterOptions(snapshot: Record<string, any> | null) {
  const items = snapshot && Array.isArray(snapshot['items']) ? snapshot['items'] as Array<Record<string, any>> : [];
  const suppliers = new Map<string, string>();
  for (const item of items) {
    if (typeof item['supplierId'] === 'string' && typeof item['supplierName'] === 'string') suppliers.set(item['supplierId'], item['supplierName']);
  }
  return {
    risks: riskOrder.filter((risk) => items.some((item) => (item['riskPublicationState'] === undefined || item['riskPublicationState'] === 'published' || item['riskPublicationState'] === 'legacy') && item['risk'] === risk)),
    routes: ['local', 'import', 'unclassified'].filter((route) => items.some((item) => item['route'] === route)),
    suppliers: [...suppliers.entries()].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name)),
    materialTypes: [...new Set(items.map((item) => String(item['materialType'] ?? '')).filter(Boolean))].sort((left, right) => left.localeCompare(right)),
  };
}

function dashboardFilters(rawUrl: string | undefined): RiskDashboardFilters {
  const url = new URL(rawUrl ?? '/api/procurement/risk-dashboard', 'http://127.0.0.1');
  const risk = optionalParam(url, 'risk');
  const route = optionalParam(url, 'route');
  const supplierId = optionalParam(url, 'supplierId', 200);
  const materialType = optionalParam(url, 'materialType', 300);
  if (risk && !riskOrder.includes(risk as Risk)) throw new RiskInputError('风险等级必须是 high、medium 或 low');
  if (route && !['local', 'import', 'unclassified'].includes(route)) throw new RiskInputError('采购路线必须是 local、import 或 unclassified');
  return {
    risk: risk as Risk | null,
    route: route as RiskDashboardFilters['route'],
    supplierId,
    materialType,
  };
}

function optionalParam(url: URL, name: string, maxLength = 40): string | null {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === '') return null;
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new RiskInputError(`${name} 过长`);
  return normalized;
}

function snapshotCsv(snapshot: Record<string, any> | null): string {
  const header = ['PO Number', 'Supplier', 'Route', 'Material Type', 'Risk', 'Risk Score', 'Risk Model Version', 'Evidence Coverage', 'Score State', 'Missing Components', 'Required In-House Date', 'Overdue Days', 'Currency', 'PO Value', 'Next Action', 'Risk Factors'];
  const items = snapshot && Array.isArray(snapshot['items']) ? snapshot['items'] as Array<Record<string, any>> : [];
  const rows = items.map((item) => [
    item['number'], item['supplierName'], item['route'], item['materialType'], item['risk'], item['riskScore'], item['riskModel']?.['modelVersion'] ?? snapshot?.['modelVersion'] ?? 'legacy-risk-v1',
    item['riskModel']?.['evidenceCoverage'] ?? '', item['riskPublicationState'] ?? 'legacy', Array.isArray(item['missingRiskComponents']) ? item['missingRiskComponents'].join(' | ') : '',
    item['requiredInHouseAt'], item['overdueDays'], item['currency'], item['amountTotal'], item['nextAction'],
    Array.isArray(item['riskFactors']) ? item['riskFactors'].map((factor: Record<string, any>) => factor['code']).filter(Boolean).join(' | ') : '',
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function legacyRiskBreakdown(items: PortfolioItem[]) {
  return [
    ['supplier_performance', '供应商表现', (item: PortfolioItem) => Math.max(
      legacyFactorScore(item, ['supplier_no_response']),
      item.supplierPerformanceScore === null ? 0 : Math.max(0, 100 - item.supplierPerformanceScore),
    )],
    ['delivery_delay', '交付延迟', (item: PortfolioItem) => legacyFactorScore(item, ['rihd_overdue', 'manufacturing_lead_time_shortfall', 'production_delayed', 'production_blocked', 'shipment_eta_overdue', 'transport_exception'])],
    ['po_value', 'PO 金额', (item: PortfolioItem) => item.risk === 'low' ? 0 : item.riskScore],
    ['product_criticality', '产品关键性', (item: PortfolioItem) => legacyFactorScore(item, ['product_criticality', 'critical_item'])],
    ['compliance_approval', '合规与审批', (item: PortfolioItem) => legacyFactorScore(item, ['approval_pending', 'connector_failed', 'import_documents:', 'customs_held', 'exception:'])],
  ].map(([code, label, scoreOf]) => ({
    code: String(code),
    label: String(label),
    score: roundedAverage(items.map(scoreOf as (item: PortfolioItem) => number)),
    affectedPurchaseOrders: items.filter((item) => (scoreOf as (item: PortfolioItem) => number)(item) > 0).length,
  }));
}

function legacyFactorScore(item: PortfolioItem, prefixes: string[]): number {
  return Math.max(0, ...item.riskFactors.filter((factor) => prefixes.some((prefix) => factor.code === prefix || factor.code.startsWith(prefix))).map((factor) => factor.score));
}

function roundedAverage(values: number[]): number { return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 1) : 0; }
function round(value: number, digits: number): number { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function sumCurrency(items: PortfolioItem[]): CurrencyValues {
  const result: CurrencyValues = {};
  for (const item of items) result[item.currency] = round((result[item.currency] ?? 0) + item.amountTotal, 2);
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) { const key = keyOf(item); const group = result.get(key) ?? []; group.push(item); result.set(key, group); }
  return result;
}
function findByWatermark(db: DatabaseSync, tenantId: string, watermark: string): SnapshotRow | undefined {
  return db.prepare(`SELECT id,source_watermark,as_of,snapshot_json,created_by,created_at
    FROM procurement_risk_snapshots WHERE tenant_id=? AND source_watermark=?`).get(tenantId, watermark) as unknown as SnapshotRow | undefined;
}
function presentSnapshot(row: SnapshotRow): Record<string, any> {
  const snapshot = JSON.parse(row.snapshot_json) as Record<string, any>;
  const modelVersion = snapshot['modelVersion'] ?? 'legacy-risk-v1';
  const items = Array.isArray(snapshot['items']) ? snapshot['items'].map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (record['riskModel'] || modelVersion !== 'legacy-risk-v1') return record;
    return {
      ...record,
      riskPublicationState: 'legacy',
      riskModel: {
        modelVersion: 'legacy-risk-v1', evidenceCoverage: null, totalScore: null, provisionalScore: null, provisionalBand: null,
      },
      missingRiskComponents: Array.isArray(record['missingRiskComponents']) ? record['missingRiskComponents'] : [],
    };
  }) : [];
  return { ...snapshot, items, modelVersion, id: row.id, sourceWatermark: row.source_watermark, asOf: row.as_of, createdBy: row.created_by, createdAt: row.created_at };
}
function dateRange(rawUrl: string | undefined, now: Date): { from: string; to: string } {
  const url = new URL(rawUrl ?? '/api/procurement/risk-dashboard', 'http://127.0.0.1');
  const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const defaultFrom = new Date(defaultTo.getTime() - 29 * dayMs); defaultFrom.setUTCHours(0, 0, 0, 0);
  const from = parseDate(url.searchParams.get('from'), 'from', defaultFrom, false);
  const to = parseDate(url.searchParams.get('to'), 'to', defaultTo, true);
  if (from.getTime() > to.getTime()) throw new RiskInputError('开始日期不能晚于结束日期');
  if (to.getTime() - from.getTime() > 366 * dayMs) throw new RiskInputError('日期范围不能超过 366 天');
  return { from: from.toISOString(), to: to.toISOString() };
}
function parseDate(value: string | null, field: string, fallback: Date, endOfDay: boolean): Date {
  if (value === null) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RiskInputError(`${field} 必须是 YYYY-MM-DD`);
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RiskInputError(`${field} 日期无效`);
  return date;
}
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function sendCsv(res: ServerResponse, body: string, filename: string, snapshotId: string | null): void {
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    ...(snapshotId ? { 'x-readywork-snapshot-id': snapshotId } : {}),
    'cache-control': 'no-store',
  });
  res.end(body);
}
function forbidden(res: ServerResponse, message: string): true { sendJson(res, 403, { error: message, code: 'FORBIDDEN' }); return true; }
class RiskInputError extends Error {}
