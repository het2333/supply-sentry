import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { PurchaseOrderLine, Supplier } from '@readywork/core';
import { can, type Session } from './auth.js';

export type ProcurementLeadTimeRoute = 'local' | 'import';
export type ProcurementLeadTimeMatchKind = 'item_code' | 'material' | 'supplier_route_default';
export type ProcurementLeadTimeCriticality = 'high' | 'medium' | 'low';

export interface ProcurementMaterialLeadTime {
  id: string;
  supplierId: string;
  supplierName: string;
  material: string;
  itemCode: string;
  materialType: string;
  procurementRoute: ProcurementLeadTimeRoute;
  standardLeadTimeDays: number;
  criticality: ProcurementLeadTimeCriticality;
  remarks: string;
  status: 'active' | 'retired';
  version: number;
  createdBy: string;
  updatedBy: string;
  retiredBy: string | null;
  createdAt: string;
  updatedAt: string;
  retiredAt: string | null;
}

export interface ProcurementLeadTimeEvidence {
  templateId: string;
  templateVersion: number;
  supplierId: string;
  supplierNameSnapshot: string;
  procurementRoute: ProcurementLeadTimeRoute;
  matchKind: ProcurementLeadTimeMatchKind;
  matchValue: string;
  standardLeadTimeDays: number;
  criticality: ProcurementLeadTimeCriticality;
  materialType: string;
  remarks: string;
  templateUpdatedAt: string;
  poLineId: string;
  itemId: string;
  itemCode: string | null;
  material: string | null;
}

interface LeadTimeRow {
  id: string;
  supplier_id: string;
  supplier_name_snapshot: string;
  material: string;
  item_code: string;
  material_type: string;
  procurement_route: ProcurementLeadTimeRoute;
  match_key: string;
  standard_lead_time_days: number;
  criticality: ProcurementLeadTimeCriticality;
  remarks: string;
  status: 'active' | 'retired';
  version: number;
  created_by: string;
  updated_by: string;
  retired_by: string | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

type SupplierRow = { version: number; json: string };

export interface ProcurementLeadTimeResolver {
  resolve(input: {
    supplierId: string;
    route: 'local' | 'import' | 'unclassified';
    line: PurchaseOrderLine & Record<string, unknown>;
  }): ProcurementLeadTimeEvidence | null;
}

/**
 * Load one immutable resolver per portfolio calculation. Matching is strict:
 * tenant + supplier id + reviewed route, then exact item code, exact material,
 * then the explicit supplier/route default. Supplier names never participate.
 */
export function loadProcurementLeadTimeResolver(db: DatabaseSync, tenantId: string): ProcurementLeadTimeResolver {
  const rows = db.prepare(`SELECT * FROM procurement_material_lead_times
    WHERE tenant_id=? AND status='active' ORDER BY updated_at DESC,id`).all(tenantId) as unknown as LeadTimeRow[];
  const byKey = new Map<string, LeadTimeRow>();
  for (const row of rows) byKey.set(`${row.supplier_id}\u0000${row.procurement_route}\u0000${row.match_key}`, row);
  return {
    resolve({ supplierId, route, line }) {
      if (route !== 'local' && route !== 'import') return null;
      const itemCodes = uniqueNormalized([line['itemCode'], line['sku'], line.itemId]);
      const materials = uniqueNormalized([line.description]);
      let row: LeadTimeRow | undefined;
      let matchKind: ProcurementLeadTimeMatchKind = 'supplier_route_default';
      let matchValue = '*';
      for (const code of itemCodes) {
        row = byKey.get(`${supplierId}\u0000${route}\u0000item:${code}`);
        if (row) { matchKind = 'item_code'; matchValue = row.item_code; break; }
      }
      if (!row) {
        for (const material of materials) {
          row = byKey.get(`${supplierId}\u0000${route}\u0000material:${material}`);
          if (row) { matchKind = 'material'; matchValue = row.material; break; }
        }
      }
      if (!row) row = byKey.get(`${supplierId}\u0000${route}\u0000*`);
      if (!row) return null;
      return {
        templateId: row.id,
        templateVersion: row.version,
        supplierId: row.supplier_id,
        supplierNameSnapshot: row.supplier_name_snapshot,
        procurementRoute: row.procurement_route,
        matchKind,
        matchValue,
        standardLeadTimeDays: row.standard_lead_time_days,
        criticality: row.criticality,
        materialType: row.material_type,
        remarks: row.remarks,
        templateUpdatedAt: row.updated_at,
        poLineId: line.id,
        itemId: line.itemId,
        itemCode: textOrNull(line['itemCode'] ?? line['sku']),
        material: textOrNull(line.description),
      };
    },
  };
}

export async function handleProcurementLeadTimeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: { db: DatabaseSync; session: Session | null; now?: () => Date },
): Promise<boolean> {
  const root = path === '/api/po/lead-times';
  const match = path.match(/^\/api\/po\/lead-times\/([^/]+)$/);
  if (!root && !match) return false;
  if (!context.session) return json(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { db, session } = context;
  if (!can(session, 'read')) return json(res, 403, { error: '无读取物料制造交期权限', code: 'FORBIDDEN' });

  try {
    if (root && method === 'GET') {
      const includeRetired = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('includeRetired') === 'true';
      const rows = db.prepare(`SELECT * FROM procurement_material_lead_times
        WHERE tenant_id=? ${includeRetired ? '' : "AND status='active'"}
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,supplier_name_snapshot,item_code,material,updated_at DESC,id`)
        .all(session.tenantId) as unknown as LeadTimeRow[];
      const suppliers = supplierOptions(db, session.tenantId);
      const events = db.prepare(`SELECT id,lead_time_id,actor_id,action,detail_json,created_at
        FROM procurement_material_lead_time_events WHERE tenant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50`)
        .all(session.tenantId) as Array<{ id: string; lead_time_id: string; actor_id: string; action: string; detail_json: string; created_at: string }>;
      return json(res, 200, {
        items: rows.map(presentPublic),
        suppliers,
        permissions: { read: true, configure: can(session, 'configure') },
        events: events.map((event) => ({
          id: event.id,
          leadTimeId: event.lead_time_id,
          actorId: event.actor_id,
          action: event.action,
          detail: safeJson(event.detail_json),
          createdAt: event.created_at,
        })),
      });
    }
    if (!can(session, 'configure')) return json(res, 403, { error: '只有采购经理或管理员可以配置物料制造交期', code: 'FORBIDDEN' });
    if (root && method === 'POST') {
      const body = await readJson(req);
      assertOnlyKeys(body, ['supplier_id', 'supplier_name', 'material', 'item_code', 'material_type', 'procurement_route', 'standard_lead_time_days', 'criticality', 'remarks', 'reason']);
      const value = leadTimeInput(db, session.tenantId, body);
      const reason = requiredText(body['reason'], '配置依据', 500, 10);
      const at = (context.now?.() ?? new Date()).toISOString();
      const id = `procurement-material-lead-time:${randomUUID()}`;
      db.exec('BEGIN IMMEDIATE');
      try {
        assertNoDuplicate(db, session.tenantId, value.supplierId, value.procurementRoute, value.matchKey);
        db.prepare(`INSERT INTO procurement_material_lead_times
          (tenant_id,id,supplier_id,supplier_name_snapshot,material,item_code,material_type,procurement_route,match_key,standard_lead_time_days,criticality,remarks,status,version,created_by,updated_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',1,?,?,?,?)`).run(
          session.tenantId, id, value.supplierId, value.supplierName, value.material, value.itemCode, value.materialType,
          value.procurementRoute, value.matchKey, value.standardLeadTimeDays, value.criticality, value.remarks,
          session.humanId, session.humanId, at, at,
        );
        insertEvent(db, session.tenantId, id, session.humanId, 'created', { current: value, version: 1, reason }, at);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return json(res, 201, { item: presentPublic(getRow(db, session.tenantId, id)!) });
    }
    if (match && method === 'PATCH') {
      const id = decodeURIComponent(match[1]!);
      const body = await readJson(req);
      assertOnlyKeys(body, ['expected_version', 'supplier_id', 'supplier_name', 'material', 'item_code', 'material_type', 'procurement_route', 'standard_lead_time_days', 'criticality', 'remarks', 'reason']);
      const expectedVersion = positiveInteger(body['expected_version'], 'expected_version');
      const reason = requiredText(body['reason'], '变更依据', 500, 10);
      const current = requiredActiveRow(db, session.tenantId, id);
      const merged = {
        supplier_id: body['supplier_id'] ?? current.supplier_id,
        supplier_name: body['supplier_name'] ?? current.supplier_name_snapshot,
        material: body['material'] ?? current.material,
        item_code: body['item_code'] ?? current.item_code,
        material_type: body['material_type'] ?? current.material_type,
        procurement_route: body['procurement_route'] ?? current.procurement_route,
        standard_lead_time_days: body['standard_lead_time_days'] ?? current.standard_lead_time_days,
        criticality: body['criticality'] ?? current.criticality,
        remarks: body['remarks'] ?? current.remarks,
      };
      const value = leadTimeInput(db, session.tenantId, merged);
      const at = (context.now?.() ?? new Date()).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const locked = requiredActiveRow(db, session.tenantId, id);
        if (locked.version !== expectedVersion) throw new LeadTimeVersionError(locked.version);
        assertNoDuplicate(db, session.tenantId, value.supplierId, value.procurementRoute, value.matchKey, id);
        const changed = db.prepare(`UPDATE procurement_material_lead_times SET
          supplier_id=?,supplier_name_snapshot=?,material=?,item_code=?,material_type=?,procurement_route=?,match_key=?,standard_lead_time_days=?,criticality=?,remarks=?,version=version+1,updated_by=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='active' AND version=?`).run(
          value.supplierId, value.supplierName, value.material, value.itemCode, value.materialType, value.procurementRoute,
          value.matchKey, value.standardLeadTimeDays, value.criticality, value.remarks, session.humanId, at, session.tenantId, id, expectedVersion,
        );
        if (changed.changes !== 1) throw new LeadTimeVersionError(getRow(db, session.tenantId, id)?.version ?? expectedVersion);
        insertEvent(db, session.tenantId, id, session.humanId, 'updated', {
          previous: snapshot(current), current: value, previousVersion: expectedVersion, version: expectedVersion + 1, reason,
        }, at);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return json(res, 200, { item: presentPublic(getRow(db, session.tenantId, id)!) });
    }
    if (match && method === 'DELETE') {
      const id = decodeURIComponent(match[1]!);
      const body = await readJson(req);
      assertOnlyKeys(body, ['expected_version', 'reason']);
      const expectedVersion = positiveInteger(body['expected_version'], 'expected_version');
      const reason = requiredText(body['reason'], '退役依据', 500, 10);
      const at = (context.now?.() ?? new Date()).toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = requiredActiveRow(db, session.tenantId, id);
        if (current.version !== expectedVersion) throw new LeadTimeVersionError(current.version);
        const changed = db.prepare(`UPDATE procurement_material_lead_times SET status='retired',version=version+1,updated_by=?,retired_by=?,updated_at=?,retired_at=?
          WHERE tenant_id=? AND id=? AND status='active' AND version=?`).run(
          session.humanId, session.humanId, at, at, session.tenantId, id, expectedVersion,
        );
        if (changed.changes !== 1) throw new LeadTimeVersionError(getRow(db, session.tenantId, id)?.version ?? expectedVersion);
        insertEvent(db, session.tenantId, id, session.humanId, 'retired', {
          previous: snapshot(current), previousVersion: expectedVersion, version: expectedVersion + 1, reason,
        }, at);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return json(res, 200, { item: presentPublic(getRow(db, session.tenantId, id)!) });
    }
    return json(res, 405, { error: '不支持的请求方法', code: 'METHOD_NOT_ALLOWED' });
  } catch (error) {
    if (error instanceof LeadTimeVersionError) return json(res, 409, { error: error.message, code: 'LEAD_TIME_VERSION_CONFLICT', current_version: error.currentVersion });
    if (error instanceof LeadTimeDuplicateError) return json(res, 409, { error: error.message, code: 'LEAD_TIME_DUPLICATE' });
    if (error instanceof LeadTimeNotFoundError) return json(res, 404, { error: error.message, code: 'LEAD_TIME_NOT_FOUND' });
    if (error instanceof LeadTimeInputError) return json(res, 422, { error: error.message, code: 'INVALID_LEAD_TIME' });
    return json(res, 500, { error: '物料制造交期保存失败', code: 'LEAD_TIME_WRITE_FAILED' });
  }
}

function leadTimeInput(db: DatabaseSync, tenantId: string, body: Record<string, unknown>) {
  const supplierId = requiredText(body['supplier_id'], 'supplier_id', 500, 1);
  const supplier = getSupplier(db, tenantId, supplierId);
  if (!supplier) throw new LeadTimeInputError('supplier_id 必须指向当前租户的真实供应商主数据');
  const suppliedName = optionalText(body['supplier_name'], 'supplier_name', 240);
  if (suppliedName && normalize(suppliedName) !== normalize(supplier.name)) throw new LeadTimeInputError('supplier_name 与 supplier_id 对应的主数据不一致');
  const material = optionalText(body['material'], 'material', 240);
  const itemCode = optionalText(body['item_code'], 'item_code', 160);
  const materialType = optionalText(body['material_type'], 'material_type', 160);
  const procurementRoute = routeValue(body['procurement_route']);
  const standardLeadTimeDays = positiveInteger(body['standard_lead_time_days'], 'standard_lead_time_days', 3650);
  const criticality = criticalityValue(body['criticality']);
  const remarks = optionalText(body['remarks'], 'remarks', 1000);
  return {
    supplierId,
    supplierName: supplier.name,
    material,
    itemCode,
    materialType,
    procurementRoute,
    matchKey: itemCode ? `item:${normalize(itemCode)}` : material ? `material:${normalize(material)}` : '*',
    standardLeadTimeDays,
    criticality,
    remarks,
  };
}

function supplierOptions(db: DatabaseSync, tenantId: string): Array<{ id: string; name: string; status: string; version: number }> {
  const rows = db.prepare(`SELECT d.version,d.status,d.json,COALESCE(p.status,d.status) AS operating_status
    FROM procurement_documents d LEFT JOIN procurement_supplier_operating_profiles p
      ON p.tenant_id=d.tenant_id AND p.supplier_id=d.id
    WHERE d.tenant_id=? AND d.kind='supplier' ORDER BY d.updated_at DESC,d.id`)
    .all(tenantId) as Array<{ version: number; status: string; operating_status: string; json: string }>;
  return rows.flatMap((row) => {
    try {
      const supplier = JSON.parse(row.json) as Supplier;
      return supplier?.id && supplier?.name ? [{ id: supplier.id, name: supplier.name, status: row.operating_status, version: row.version }] : [];
    } catch { return []; }
  });
}

function getSupplier(db: DatabaseSync, tenantId: string, supplierId: string): Supplier | null {
  const row = db.prepare(`SELECT version,json FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?`)
    .get(tenantId, supplierId) as SupplierRow | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.json) as Supplier;
    return value?.id === supplierId && typeof value.name === 'string' && value.name.trim() ? value : null;
  } catch { return null; }
}

function assertNoDuplicate(db: DatabaseSync, tenantId: string, supplierId: string, route: ProcurementLeadTimeRoute, matchKey: string, excludeId?: string): void {
  const row = db.prepare(`SELECT id FROM procurement_material_lead_times
    WHERE tenant_id=? AND supplier_id=? AND procurement_route=? AND match_key=? AND status='active' ${excludeId ? 'AND id<>?' : ''} LIMIT 1`)
    .get(...(excludeId ? [tenantId, supplierId, route, matchKey, excludeId] : [tenantId, supplierId, route, matchKey])) as { id: string } | undefined;
  if (row) throw new LeadTimeDuplicateError();
}

function getRow(db: DatabaseSync, tenantId: string, id: string): LeadTimeRow | undefined {
  return db.prepare('SELECT * FROM procurement_material_lead_times WHERE tenant_id=? AND id=?').get(tenantId, id) as unknown as LeadTimeRow | undefined;
}

function requiredActiveRow(db: DatabaseSync, tenantId: string, id: string): LeadTimeRow {
  const row = getRow(db, tenantId, id);
  if (!row || row.status !== 'active') throw new LeadTimeNotFoundError();
  return row;
}

function present(row: LeadTimeRow): ProcurementMaterialLeadTime {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name_snapshot,
    material: row.material,
    itemCode: row.item_code,
    materialType: row.material_type,
    procurementRoute: row.procurement_route,
    standardLeadTimeDays: row.standard_lead_time_days,
    criticality: row.criticality,
    remarks: row.remarks,
    status: row.status,
    version: row.version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    retiredBy: row.retired_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
  };
}

function presentPublic(row: LeadTimeRow): Record<string, unknown> {
  const item = present(row);
  return {
    id: item.id,
    supplier_id: item.supplierId,
    supplier_name: item.supplierName,
    material: item.material,
    item_code: item.itemCode,
    material_type: item.materialType,
    procurement_route: item.procurementRoute,
    standard_lead_time_days: item.standardLeadTimeDays,
    criticality: item.criticality,
    remarks: item.remarks,
    status: item.status,
    version: item.version,
    created_by: item.createdBy,
    updated_by: item.updatedBy,
    retired_by: item.retiredBy,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    retired_at: item.retiredAt,
  };
}

function snapshot(row: LeadTimeRow): Record<string, unknown> {
  return presentPublic(row);
}

function insertEvent(db: DatabaseSync, tenantId: string, leadTimeId: string, actorId: string, action: 'created' | 'updated' | 'retired', detail: unknown, at: string): void {
  db.prepare(`INSERT INTO procurement_material_lead_time_events
    (tenant_id,id,lead_time_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(tenantId, `procurement-material-lead-time-event:${randomUUID()}`, leadTimeId, actorId, action, JSON.stringify(detail), at);
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]): void {
  const fields = new Set(allowed);
  for (const key of Object.keys(body)) if (!fields.has(key)) throw new LeadTimeInputError(`不允许的字段: ${key}`);
}

function requiredText(value: unknown, label: string, maximum: number, minimum: number): string {
  if (typeof value !== 'string') throw new LeadTimeInputError(`${label} 必填`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < minimum || normalized.length > maximum) throw new LeadTimeInputError(`${label} 必须为 ${minimum}–${maximum} 个有效字符`);
  return normalized;
}

function optionalText(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new LeadTimeInputError(`${label} 必须是文本`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length > maximum) throw new LeadTimeInputError(`${label} 不能超过 ${maximum} 个字符`);
  return normalized;
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new LeadTimeInputError(`${label} 必须是 1–${maximum} 的整数`);
  return Number(value);
}

function routeValue(value: unknown): ProcurementLeadTimeRoute {
  if (value !== 'local' && value !== 'import') throw new LeadTimeInputError('procurement_route 必须是 local 或 import');
  return value;
}

function criticalityValue(value: unknown): ProcurementLeadTimeCriticality {
  if (value !== 'high' && value !== 'medium' && value !== 'low') throw new LeadTimeInputError('产品关键程度必须为高、中或低');
  return value;
}

function normalize(value: string): string { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US'); }
function uniqueNormalized(values: unknown[]): string[] { return [...new Set(values.flatMap((value) => typeof value === 'string' && value.trim() ? [normalize(value)] : []))]; }
function textOrNull(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return {}; } }

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_000) throw new LeadTimeInputError('请求体过大');
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    return parsed as Record<string, unknown>;
  } catch { throw new LeadTimeInputError('请求体必须是 JSON 对象'); }
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}

class LeadTimeInputError extends Error {}
class LeadTimeDuplicateError extends Error { constructor() { super('同一供应商、路线和物料匹配项已存在有效制造交期'); } }
class LeadTimeNotFoundError extends Error { constructor() { super('物料制造交期不存在或已退役'); } }
class LeadTimeVersionError extends Error {
  constructor(readonly currentVersion: number) { super(`物料制造交期版本已变化，当前版本 ${currentVersion}`); }
}
