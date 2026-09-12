import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  createProcurementRouteExport,
  findProcurementRouteExportByIdempotency,
  getProcurementRouteExport,
  type ProcurementRouteExportRecord,
} from '@readywork/persistence';
import { can, type Session } from './auth.js';
import type { AttachmentObjectStorage } from './attachment-object-storage.js';
import { procurementPortfolio } from './procurement-workbench.js';

type ProcurementRoute = 'local' | 'import';
type RouteRisk = 'high' | 'medium' | 'low';
type RouteExportSort = 'rihd_asc' | 'risk_desc' | 'po_number_asc';

export type RouteExportRequest = {
  query: string;
  stages: string[];
  risks: RouteRisk[];
  supplierIds: string[];
  rihdFrom: string | null;
  rihdTo: string | null;
  sort: RouteExportSort;
};

type RoutePortfolioItem = {
  id: string; number: string; supplierId: string; supplierName: string; materialType: string;
  route: string; stage: string; stageLabel: string; requiredInHouseAt: string | null;
  risk: RouteRisk; nextAction: string; currency: string; amountTotal: number; active: boolean;
};

type RoutePortfolio = { generatedAt?: unknown; configurationWatermark?: unknown; items?: unknown };

export interface ProcurementRouteExportContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly attachmentObjectStorage?: AttachmentObjectStorage;
  readonly now?: () => Date;
}

const allowedStages = new Set(['po_sent', 'supplier_commitment', 'fulfilment_production', 'dispatch_transit', 'delivery_grn', 'completed']);
const allowedRisks = new Set<RouteRisk>(['high', 'medium', 'low']);
const allowedSorts = new Set<RouteExportSort>(['rihd_asc', 'risk_desc', 'po_number_asc']);
const requestKeys = new Set(['query', 'stages', 'risks', 'supplierIds', 'rihdFrom', 'rihdTo', 'sort']);
const dayMs = 86_400_000;

export function normalizeRouteExportRequest(value: unknown): RouteExportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RouteExportInputError('导出筛选必须是 JSON 对象');
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !requestKeys.has(key));
  if (unknown.length) throw new RouteExportInputError(`不支持的导出字段: ${unknown.join(', ')}`);
  const query = typeof body['query'] === 'string' ? body['query'].trim().toLocaleLowerCase('zh-CN') : '';
  if (query.length > 200) throw new RouteExportInputError('query 最长 200 个字符');
  const stages = normalizedStringSet(body['stages'], 'stages', allowedStages);
  const risks = normalizedStringSet(body['risks'], 'risks', allowedRisks) as RouteRisk[];
  const supplierIds = normalizedIdentifiers(body['supplierIds']);
  const rihdFrom = normalizedDate(body['rihdFrom'], 'rihdFrom');
  const rihdTo = normalizedDate(body['rihdTo'], 'rihdTo');
  if (rihdFrom && rihdTo && rihdFrom > rihdTo) throw new RouteExportInputError('rihdFrom 不能晚于 rihdTo');
  const sort = body['sort'] === undefined ? 'risk_desc' : body['sort'];
  if (typeof sort !== 'string' || !allowedSorts.has(sort as RouteExportSort)) throw new RouteExportInputError('sort 无效');
  return { query, stages, risks, supplierIds, rihdFrom, rihdTo, sort: sort as RouteExportSort };
}

function normalizedStringSet(value: unknown, field: string, allowed: ReadonlySet<string>): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new RouteExportInputError(`${field} 必须是最多 20 项的数组`);
  const normalized = value.map((item) => typeof item === 'string' ? item.trim().toLowerCase() : '');
  if (normalized.some((item) => !item || !allowed.has(item))) throw new RouteExportInputError(`${field} 包含无效值`);
  return [...new Set(normalized)].sort();
}

function normalizedIdentifiers(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new RouteExportInputError('supplierIds 必须是最多 200 项的数组');
  const normalized = value.map((item) => typeof item === 'string' ? item.trim() : '');
  if (normalized.some((item) => !item || item.length > 300 || /[\u0000-\u001f\u007f]/u.test(item))) throw new RouteExportInputError('supplierIds 包含无效值');
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function normalizedDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new RouteExportInputError(`${field} 必须是 YYYY-MM-DD 或 null`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new RouteExportInputError(`${field} 日期无效`);
  return value;
}

export function filterRoutePortfolioItems(items: readonly RoutePortfolioItem[], route: ProcurementRoute, filters: RouteExportRequest): RoutePortfolioItem[] {
  const riskRank: Record<RouteRisk, number> = { high: 0, medium: 1, low: 2 };
  return items.filter((item) => {
    if (item.route !== route) return false;
    if (filters.stages.length && !filters.stages.some((stage) => stage === 'completed' ? !item.active : item.active && item.stage === stage)) return false;
    if (filters.risks.length && !filters.risks.includes(item.risk)) return false;
    if (filters.supplierIds.length && !filters.supplierIds.includes(item.supplierId)) return false;
    const rihd = item.requiredInHouseAt?.slice(0, 10) ?? null;
    if (filters.rihdFrom && (!rihd || rihd < filters.rihdFrom)) return false;
    if (filters.rihdTo && (!rihd || rihd > filters.rihdTo)) return false;
    return !filters.query || [item.number, item.supplierName, item.materialType]
      .some((candidate) => candidate.toLocaleLowerCase('zh-CN').includes(filters.query));
  }).sort((left, right) => {
    if (filters.sort === 'po_number_asc') return left.number.localeCompare(right.number, 'en') || left.id.localeCompare(right.id);
    if (filters.sort === 'rihd_asc') return (left.requiredInHouseAt ?? '9999-12-31').localeCompare(right.requiredInHouseAt ?? '9999-12-31') || left.id.localeCompare(right.id);
    return riskRank[left.risk] - riskRank[right.risk]
      || (left.requiredInHouseAt ?? '9999-12-31').localeCompare(right.requiredInHouseAt ?? '9999-12-31')
      || left.id.localeCompare(right.id);
  });
}

function csvCell(value: string | number): string {
  const text = String(value);
  const protectedText = /^[=+@]/u.test(text) || /^-\D/u.test(text) ? `'${text}` : text;
  return `"${protectedText.replaceAll('"', '""')}"`;
}

function daysToRihd(requiredInHouseAt: string | null, now: Date): string | number {
  if (!requiredInHouseAt) return '';
  const required = Date.parse(`${requiredInHouseAt.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(required)) return '';
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.ceil((required - today) / dayMs);
}

export function buildRouteExportCsv(items: readonly RoutePortfolioItem[], now: Date): Uint8Array {
  const riskLabels: Record<RouteRisk, string> = { high: '高', medium: '中', low: '低' };
  const rows: Array<Array<string | number>> = [[
    '采购订单号', '供应商', '物料类型', '当前阶段', '要求到货日期（RIHD）', '距 RIHD 天数', '风险', '下一步操作', '总金额', '行操作',
  ]];
  for (const item of items) rows.push([
    item.number, item.supplierName, item.materialType, item.active ? item.stageLabel : '已完成', item.requiredInHouseAt?.slice(0, 10) ?? '',
    daysToRihd(item.requiredInHouseAt, now), riskLabels[item.risk], item.nextAction,
    `${item.currency} ${item.amountTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })}`,
    '查看详情',
  ]);
  return Buffer.from(`\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`, 'utf8');
}

export async function handleProcurementRouteExportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementRouteExportContext,
): Promise<boolean> {
  const createMatch = path.match(/^\/api\/procurement\/routes\/([^/]+)\/exports$/u);
  const downloadMatch = path.match(/^\/api\/procurement\/route-exports\/([^/]+)\/download$/u);
  if (!createMatch && !downloadMatch) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  try {
    if (createMatch) {
      if (method !== 'POST') { sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' }); return true; }
      if (!can(context.session, 'operate')) return forbidden(res, '无生成采购路线导出的权限');
      const route = decodeURIComponent(createMatch[1]!);
      if (route !== 'local' && route !== 'import') throw new RouteExportInputError('route 必须是 local 或 import');
      if (!context.attachmentObjectStorage) throw new RouteExportStorageUnavailableError();
      const key = routeExportIdempotencyKey(req);
      const filters = normalizeRouteExportRequest(await readJsonBody(req));
      const filtersJson = JSON.stringify(filters);
      const replay = findProcurementRouteExportByIdempotency(context.db, context.session.tenantId, key);
      if (replay) return sendReplayOrConflict(res, replay, route, filtersJson);

      let portfolio: RoutePortfolio;
      context.db.exec('BEGIN');
      try {
        portfolio = procurementPortfolio(context.db, context.session.tenantId, context.now?.() ?? Date.now()) as RoutePortfolio;
        context.db.exec('COMMIT');
      } catch (error) { rollback(context.db); throw error; }
      const sourceWatermark = `${String(portfolio.generatedAt ?? '1970-01-01T00:00:00.000Z')}|${String(portfolio.configurationWatermark ?? 'configuration:unknown')}`;
      const items = Array.isArray(portfolio.items) ? portfolio.items as RoutePortfolioItem[] : [];
      const filtered = filterRoutePortfolioItems(items, route, filters);
      const now = context.now?.() ?? new Date();
      const csv = buildRouteExportCsv(filtered, now);
      const contentSha256 = createHash('sha256').update(csv).digest('hex');
      const id = `route-export:${randomUUID()}`;
      const identity = { tenantId: context.session.tenantId, attachmentId: id, version: 1 } as const;
      let metadata;
      try {
        metadata = await context.attachmentObjectStorage.put({ ...identity, sha256: contentSha256, sizeBytes: csv.byteLength, body: csv, contentType: 'text/csv; charset=utf-8' });
      } catch (error) { throw new RouteExportStorageError(error); }
      const record: ProcurementRouteExportRecord = {
        tenantId: context.session.tenantId, id, route, normalizedFiltersJson: filtersJson, sourceWatermark,
        rowCount: filtered.length, contentSha256, sizeBytes: csv.byteLength, objectKey: metadata.key, state: 'ready',
        createdBy: context.session.humanId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
        idempotencyKey: key,
      };
      let concurrent: ProcurementRouteExportRecord | null = null;
      try {
        context.db.exec('BEGIN IMMEDIATE');
        concurrent = findProcurementRouteExportByIdempotency(context.db, context.session.tenantId, key);
        if (!concurrent) createProcurementRouteExport(context.db, record);
        context.db.exec('COMMIT');
      } catch (error) {
        rollback(context.db);
        await safeDelete(context.attachmentObjectStorage, identity);
        throw error;
      }
      if (concurrent) {
        await safeDelete(context.attachmentObjectStorage, identity);
        return sendReplayOrConflict(res, concurrent, route, filtersJson);
      }
      sendJson(res, 201, presentExport(record, false));
      return true;
    }

    if (method !== 'GET') { sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' }); return true; }
    if (!can(context.session, 'read')) return forbidden(res, '无读取采购路线导出的权限');
    if (!context.attachmentObjectStorage) throw new RouteExportStorageUnavailableError();
    let id: string;
    try { id = decodeURIComponent(downloadMatch![1]!); } catch { throw new RouteExportInputError('导出 ID 无效'); }
    const record = getProcurementRouteExport(context.db, context.session.tenantId, id);
    if (!record) throw new RouteExportNotFoundError();
    const now = context.now?.() ?? new Date();
    if (record.state !== 'ready' || Date.parse(record.expiresAt) <= now.getTime()) throw new RouteExportExpiredError();
    let value;
    try {
      value = await context.attachmentObjectStorage.get({ tenantId: record.tenantId, attachmentId: record.id, version: 1, sha256: record.contentSha256, sizeBytes: record.sizeBytes });
    } catch (error) { throw new RouteExportStorageError(error); }
    const filename = `readywork-${record.route}-purchase-orders-${record.createdAt.slice(0, 10)}.csv`;
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(value.body.byteLength), 'cache-control': 'private, no-store', 'x-content-sha256': record.contentSha256,
    });
    res.end(value.body);
    return true;
  } catch (error) {
    handleError(res, error);
    return true;
  }
}

function presentExport(record: ProcurementRouteExportRecord, replayed: boolean): Record<string, unknown> {
  return {
    id: record.id, route: record.route, sourceWatermark: record.sourceWatermark, rowCount: record.rowCount,
    contentSha256: record.contentSha256, state: record.state, createdAt: record.createdAt, expiresAt: record.expiresAt,
    downloadUrl: `/api/procurement/route-exports/${encodeURIComponent(record.id)}/download`, replayed,
  };
}

function sendReplayOrConflict(res: ServerResponse, record: ProcurementRouteExportRecord, route: ProcurementRoute, filtersJson: string): true {
  if (record.route !== route || record.normalizedFiltersJson !== filtersJson) throw new RouteExportIdempotencyConflictError();
  sendJson(res, 200, presentExport(record, true));
  return true;
}

async function safeDelete(storage: AttachmentObjectStorage, identity: { tenantId: string; attachmentId: string; version: number }): Promise<void> {
  try { await storage.delete(identity); } catch { /* orphan cleanup is best effort; no DB record points at this object */ }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) throw new RouteExportInputError('导出请求体过大');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown; }
  catch { throw new RouteExportInputError('请求体不是有效 JSON'); }
}

function routeExportIdempotencyKey(req: IncomingMessage): string {
  const value = req.headers['idempotency-key'];
  const key = (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/u.test(key)) throw new RouteExportInputError('Idempotency-Key 必填且最长 200 个字符');
  return key;
}

function rollback(db: DatabaseSync): void { try { db.exec('ROLLBACK'); } catch { /* no active transaction */ } }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function forbidden(res: ServerResponse, message: string): true { sendJson(res, 403, { error: message, code: 'FORBIDDEN' }); return true; }

function handleError(res: ServerResponse, error: unknown): void {
  if (error instanceof RouteExportInputError) return sendJson(res, 422, { error: error.message, code: 'INVALID_ROUTE_EXPORT_INPUT' });
  if (error instanceof RouteExportIdempotencyConflictError) return sendJson(res, 409, { error: error.message, code: 'ROUTE_EXPORT_IDEMPOTENCY_CONFLICT' });
  if (error instanceof RouteExportNotFoundError) return sendJson(res, 404, { error: error.message, code: 'ROUTE_EXPORT_NOT_FOUND' });
  if (error instanceof RouteExportExpiredError) return sendJson(res, 410, { error: error.message, code: 'ROUTE_EXPORT_EXPIRED' });
  if (error instanceof RouteExportStorageUnavailableError) return sendJson(res, 503, { error: error.message, code: 'ROUTE_EXPORT_STORAGE_UNAVAILABLE' });
  if (error instanceof RouteExportStorageError) return sendJson(res, 500, { error: error.message, code: 'ROUTE_EXPORT_STORAGE_FAILED' });
  sendJson(res, 500, { error: '采购路线导出失败', code: 'ROUTE_EXPORT_FAILED' });
}

class RouteExportInputError extends Error {}
class RouteExportIdempotencyConflictError extends Error { constructor() { super('该 Idempotency-Key 已用于不同的路线导出请求'); } }
class RouteExportNotFoundError extends Error { constructor() { super('采购路线导出不存在'); } }
class RouteExportExpiredError extends Error { constructor() { super('采购路线导出已过期'); } }
class RouteExportStorageUnavailableError extends Error { constructor() { super('采购路线导出对象存储未配置'); } }
class RouteExportStorageError extends Error { constructor(_cause: unknown) { super('采购路线导出对象存储失败'); } }
