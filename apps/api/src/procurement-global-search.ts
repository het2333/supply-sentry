import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';

export type ProcurementSearchTarget = 'home' | 'orders' | 'suppliers' | 'notifications' | 'message-drafts';

export interface ProcurementSearchResult {
  readonly id: string;
  readonly kind: 'purchase_order' | 'supplier' | 'item' | 'message_draft' | 'notification' | 'communication';
  readonly title: string;
  readonly subtitle: string;
  readonly meta: string;
  readonly targetSection: ProcurementSearchTarget;
  readonly objectId: string | null;
  readonly updatedAt: string;
  readonly score: number;
}

export interface ProcurementGlobalSearchContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
}

interface DocumentRow { id: string; external_id: string; status: string; updated_at: string; json: string }

export async function handleProcurementGlobalSearchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementGlobalSearchContext,
): Promise<boolean> {
  if (path !== '/api/procurement/search') return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  if (method !== 'GET') { sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' }); return true; }
  if (!can(context.session, 'read')) { sendJson(res, 403, { error: '无全局搜索权限', code: 'FORBIDDEN' }); return true; }
  try {
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('q')?.trim() ?? '';
    if (query.length < 2) { sendJson(res, 200, { query, items: [], minimumLength: 2 }); return true; }
    if (query.length > 80 || /\u0000/.test(query)) throw new SearchInputError('搜索词不能超过 80 个字符');
    sendJson(res, 200, { query, items: searchProcurement(context.db, context.session.tenantId, query), minimumLength: 2 });
  } catch (error) {
    sendJson(res, error instanceof SearchInputError ? 422 : 500, {
      error: error instanceof SearchInputError ? error.message : '全局搜索失败',
      code: error instanceof SearchInputError ? 'INVALID_SEARCH_QUERY' : 'SEARCH_FAILED',
    });
  }
  return true;
}

export function searchProcurement(db: DatabaseSync, tenantId: string, query: string): ProcurementSearchResult[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2) return [];
  const like = `%${escapeLike(normalized)}%`;
  const results: ProcurementSearchResult[] = [];

  const purchaseOrders = db.prepare(`SELECT d.id,d.external_id,d.status,d.updated_at,d.json
    FROM procurement_documents d
    WHERE d.tenant_id=? AND d.kind='purchase_order' AND (
      lower(d.id) LIKE ? ESCAPE '\\' OR lower(d.external_id) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(json_extract(d.json,'$.number'),'')) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM procurement_documents s WHERE s.tenant_id=d.tenant_id AND s.kind='supplier'
        AND s.id=json_extract(d.json,'$.supplierId') AND lower(COALESCE(json_extract(s.json,'$.name'),'')) LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM procurement_lines l WHERE l.tenant_id=d.tenant_id AND l.kind='purchase_order_line'
        AND l.document_id=d.id AND lower(l.json) LIKE ? ESCAPE '\\')
    ) ORDER BY d.updated_at DESC,d.id LIMIT 8`)
    .all(tenantId, like, like, like, like, like) as unknown as DocumentRow[];
  for (const row of purchaseOrders) {
    const po = safeJson(row.json);
    const number = text(po['number']) ?? row.external_id;
    const supplier = supplierName(db, tenantId, text(po['supplierId']));
    const materials = db.prepare(`SELECT json FROM procurement_lines WHERE tenant_id=? AND kind='purchase_order_line' AND document_id=? ORDER BY line_number LIMIT 3`)
      .all(tenantId, row.id) as Array<{ json: string }>;
    const materialSummary = materials.map((line) => {
      const value = safeJson(line.json); return text(value['itemName']) ?? text(value['description']) ?? text(value['itemId']);
    }).filter((value): value is string => Boolean(value)).join('、');
    results.push({
      id: `purchase_order:${row.id}`, kind: 'purchase_order', title: number,
      subtitle: [supplier, materialSummary].filter(Boolean).join(' · ') || '采购订单',
      meta: row.status, targetSection: 'orders', objectId: row.id, updatedAt: row.updated_at,
      score: relevance(normalized, [number, supplier, materialSummary]),
    });
  }

  const suppliers = db.prepare(`SELECT id,external_id,status,updated_at,json FROM procurement_documents
    WHERE tenant_id=? AND kind='supplier' AND (lower(id) LIKE ? ESCAPE '\\' OR lower(external_id) LIKE ? ESCAPE '\\' OR lower(json) LIKE ? ESCAPE '\\')
    ORDER BY updated_at DESC,id LIMIT 6`).all(tenantId, like, like, like) as unknown as DocumentRow[];
  for (const row of suppliers) {
    const supplier = safeJson(row.json);
    const name = text(supplier['name']) ?? row.external_id;
    const contacts = Array.isArray(supplier['contacts']) ? supplier['contacts'] as Array<Record<string, unknown>> : [];
    const contact = contacts.map((item) => text(item['email']) ?? text(item['phone'])).find(Boolean) ?? '暂无主要联系人';
    results.push({
      id: `supplier:${row.id}`, kind: 'supplier', title: name, subtitle: contact, meta: row.status,
      targetSection: 'suppliers', objectId: row.id, updatedAt: row.updated_at,
      score: relevance(normalized, [name, contact, row.external_id]),
    });
  }

  const items = db.prepare(`SELECT id,external_id,status,updated_at,json FROM procurement_documents
    WHERE tenant_id=? AND kind='item' AND (lower(id) LIKE ? ESCAPE '\\' OR lower(external_id) LIKE ? ESCAPE '\\' OR lower(json) LIKE ? ESCAPE '\\')
    ORDER BY updated_at DESC,id LIMIT 5`).all(tenantId, like, like, like) as unknown as DocumentRow[];
  for (const row of items) {
    const item = safeJson(row.json);
    const name = text(item['name']) ?? row.external_id;
    const sku = text(item['sku']) ?? row.external_id;
    results.push({
      id: `item:${row.id}`, kind: 'item', title: name, subtitle: sku, meta: text(item['category']) ?? '物料',
      targetSection: 'home', objectId: row.id, updatedAt: row.updated_at,
      score: relevance(normalized, [name, sku]),
    });
  }

  const drafts = db.prepare(`SELECT id,subject,recipient,status,purchase_order_id,updated_at FROM procurement_message_drafts
    WHERE tenant_id=? AND (lower(id) LIKE ? ESCAPE '\\' OR lower(subject) LIKE ? ESCAPE '\\' OR lower(recipient) LIKE ? ESCAPE '\\')
    ORDER BY updated_at DESC,id LIMIT 5`).all(tenantId, like, like, like) as Array<{ id: string; subject: string; recipient: string; status: string; purchase_order_id: string; updated_at: string }>;
  for (const row of drafts) results.push({
    id: `message_draft:${row.id}`, kind: 'message_draft', title: row.subject,
    subtitle: `${row.recipient} · ${poNumber(db, tenantId, row.purchase_order_id)}`,
    meta: row.status, targetSection: 'message-drafts', objectId: row.id, updatedAt: row.updated_at,
    score: relevance(normalized, [row.subject, row.recipient]),
  });

  const notifications = db.prepare(`SELECT id,title,message,tag,status,object_type,object_id,updated_at FROM procurement_notifications
    WHERE tenant_id=? AND (lower(title) LIKE ? ESCAPE '\\' OR lower(message) LIKE ? ESCAPE '\\' OR lower(tag) LIKE ? ESCAPE '\\')
    ORDER BY updated_at DESC,id LIMIT 5`).all(tenantId, like, like, like) as Array<{ id: string; title: string; message: string; tag: string; status: string; object_type: string | null; object_id: string | null; updated_at: string }>;
  for (const row of notifications) results.push({
    id: `notification:${row.id}`, kind: 'notification', title: row.title, subtitle: row.message,
    meta: `${row.tag} · ${row.status === 'unread' ? '未读' : '已读'}`,
    targetSection: row.object_type === 'purchase_order' ? 'orders' : row.object_type === 'message_draft' ? 'message-drafts' : 'notifications',
    objectId: row.object_id ?? row.id, updatedAt: row.updated_at,
    score: relevance(normalized, [row.title, row.message, row.tag]),
  });

  const communications = db.prepare(`SELECT id,external_id,status,updated_at,json FROM procurement_documents
    WHERE tenant_id=? AND kind='communication' AND (lower(external_id) LIKE ? ESCAPE '\\' OR lower(COALESCE(json_extract(json,'$.subject'),'')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(json_extract(json,'$.from'),'')) LIKE ? ESCAPE '\\')
    ORDER BY updated_at DESC,id LIMIT 5`).all(tenantId, like, like, like) as unknown as DocumentRow[];
  for (const row of communications) {
    const communication = safeJson(row.json);
    const subject = text(communication['subject']) ?? '供应商沟通';
    const objectId = text(communication['businessObjectId']);
    results.push({
      id: `communication:${row.id}`, kind: 'communication', title: subject,
      subtitle: text(communication['from']) ?? text(communication['to']) ?? 'Email',
      meta: text(communication['direction']) === 'inbound' ? '供应商回信' : '外发沟通',
      targetSection: objectId ? 'orders' : 'message-drafts', objectId: objectId ?? row.id, updatedAt: row.updated_at,
      score: relevance(normalized, [subject, text(communication['from']), text(communication['to'])]),
    });
  }

  return results.sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).slice(0, 16);
}

function supplierName(db: DatabaseSync, tenantId: string, supplierId: string | undefined): string {
  if (!supplierId) return '';
  const row = db.prepare(`SELECT json_extract(json,'$.name') AS name FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?`)
    .get(tenantId, supplierId) as { name: string | null } | undefined;
  return row?.name ?? '';
}

function poNumber(db: DatabaseSync, tenantId: string, poId: string): string {
  const row = db.prepare(`SELECT external_id,json_extract(json,'$.number') AS number FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND id=?`)
    .get(tenantId, poId) as { external_id: string; number: string | null } | undefined;
  return row?.number ?? row?.external_id ?? poId;
}

function relevance(query: string, fields: Array<string | undefined>): number {
  let score = 0;
  for (const raw of fields) {
    const field = raw?.toLowerCase() ?? '';
    if (!field) continue;
    if (field === query) score = Math.max(score, 100);
    else if (field.startsWith(query)) score = Math.max(score, 80);
    else if (field.includes(query)) score = Math.max(score, 50);
  }
  return score;
}

function escapeLike(value: string): string { return value.replace(/[\\%_]/g, (character) => `\\${character}`); }
function safeJson(value: string): Record<string, unknown> { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
class SearchInputError extends Error {}
