import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';

export type ProcurementDeploymentMode = 'odoo_connected' | 'email_only';

export interface ProcurementDeploymentProfile {
  mode: ProcurementDeploymentMode;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface ProfileRow {
  mode: ProcurementDeploymentMode;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export function getProcurementDeploymentProfile(db: DatabaseSync, tenantId: string): ProcurementDeploymentProfile | null {
  const row = db.prepare(`SELECT mode,version,created_by,updated_by,created_at,updated_at
    FROM procurement_deployment_profiles WHERE tenant_id=?`).get(tenantId) as ProfileRow | undefined;
  return row ? present(row) : null;
}

export function effectiveProcurementDeploymentMode(db: DatabaseSync, tenantId: string): ProcurementDeploymentMode {
  return getProcurementDeploymentProfile(db, tenantId)?.mode ?? 'odoo_connected';
}

export async function handleProcurementDeploymentProfileRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: { db: DatabaseSync; session: Session | null; now?: () => Date },
): Promise<boolean> {
  if (path !== '/api/procurement/deployment-profile') return false;
  if (!context.session) return json(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { db, session } = context;
  if (!can(session, 'read')) return json(res, 403, { error: '无读取采购部署模式权限', code: 'FORBIDDEN' });

  if (method === 'GET') return json(res, 200, view(db, session));
  if (method !== 'PUT') return json(res, 405, { error: '不支持的请求方法', code: 'METHOD_NOT_ALLOWED' });
  if (!can(session, 'configure')) return json(res, 403, { error: '只有采购经理或管理员可以切换采购部署模式', code: 'FORBIDDEN' });

  try {
    const body = await readJson(req);
    const allowed = new Set(['expectedVersion', 'mode', 'reason']);
    for (const key of Object.keys(body)) if (!allowed.has(key)) throw new DeploymentProfileInputError(`不允许的字段: ${key}`);
    const expectedVersion = nonNegativeInteger(body['expectedVersion'], 'expectedVersion');
    const mode = deploymentMode(body['mode']);
    const reason = requiredText(body['reason'], '切换依据', 500, 10);
    const at = (context.now?.() ?? new Date()).toISOString();
    let created = false;

    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getProcurementDeploymentProfile(db, session.tenantId);
      if (!current) {
        if (expectedVersion !== 0) throw new DeploymentProfileVersionError(0);
        db.prepare(`INSERT INTO procurement_deployment_profiles
          (tenant_id,mode,version,created_by,updated_by,created_at,updated_at) VALUES (?,?,1,?,?,?,?)`)
          .run(session.tenantId, mode, session.humanId, session.humanId, at, at);
        insertEvent(db, session.tenantId, session.humanId, 'created', {
          previousMode: 'odoo_connected', mode, previousVersion: 0, version: 1, reason,
        }, at);
        created = true;
      } else {
        if (current.version !== expectedVersion) throw new DeploymentProfileVersionError(current.version);
        if (current.mode !== mode) {
          const changed = db.prepare(`UPDATE procurement_deployment_profiles
            SET mode=?,version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND version=?`)
            .run(mode, session.humanId, at, session.tenantId, expectedVersion);
          if (changed.changes !== 1) throw new DeploymentProfileVersionError(getProcurementDeploymentProfile(db, session.tenantId)?.version ?? expectedVersion);
          insertEvent(db, session.tenantId, session.humanId, 'mode_changed', {
            previousMode: current.mode, mode, previousVersion: expectedVersion, version: expectedVersion + 1, reason,
          }, at);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, created ? 201 : 200, view(db, session));
  } catch (error) {
    if (error instanceof DeploymentProfileVersionError) return json(res, 409, {
      error: error.message, code: 'DEPLOYMENT_PROFILE_VERSION_CONFLICT', currentVersion: error.currentVersion,
    });
    if (error instanceof DeploymentProfileInputError) return json(res, 422, { error: error.message, code: 'INVALID_DEPLOYMENT_PROFILE' });
    return json(res, 500, { error: '采购部署模式保存失败', code: 'DEPLOYMENT_PROFILE_WRITE_FAILED' });
  }
}

function view(db: DatabaseSync, session: Session): Record<string, unknown> {
  const item = getProcurementDeploymentProfile(db, session.tenantId);
  const acceptedEmailPo = db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_intake_candidates
    WHERE tenant_id=? AND status='accepted' AND accepted_po_id IS NOT NULL`).get(session.tenantId) as { count: number };
  const odooPo = db.prepare(`SELECT COUNT(*) AS count FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' AND source_system='odoo'`).get(session.tenantId) as { count: number };
  const events = db.prepare(`SELECT id,actor_id,action,detail_json,created_at
    FROM procurement_deployment_profile_events WHERE tenant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20`)
    .all(session.tenantId) as Array<{ id: string; actor_id: string; action: string; detail_json: string; created_at: string }>;
  return {
    item,
    effectiveMode: item?.mode ?? 'odoo_connected',
    inheritedDefault: !item,
    evidence: { acceptedEmailPurchaseOrders: Number(acceptedEmailPo.count ?? 0), odooPurchaseOrders: Number(odooPo.count ?? 0) },
    permissions: { read: can(session, 'read'), configure: can(session, 'configure') },
    events: events.map((event) => ({
      id: event.id, actorId: event.actor_id, action: event.action, detail: safeJson(event.detail_json), createdAt: event.created_at,
    })),
  };
}

function present(row: ProfileRow): ProcurementDeploymentProfile {
  return {
    mode: row.mode, version: row.version, createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function insertEvent(db: DatabaseSync, tenantId: string, actorId: string, action: string, detail: unknown, at: string): void {
  db.prepare(`INSERT INTO procurement_deployment_profile_events
    (tenant_id,id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?)`)
    .run(tenantId, `deployment-profile-event:${randomUUID()}`, actorId, action, JSON.stringify(detail), at);
}

function deploymentMode(value: unknown): ProcurementDeploymentMode {
  if (value !== 'odoo_connected' && value !== 'email_only') throw new DeploymentProfileInputError('mode 必须是 odoo_connected 或 email_only');
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new DeploymentProfileInputError(`${label} 必须是非负整数`);
  return Number(value);
}

function requiredText(value: unknown, label: string, maximum: number, minimum: number): string {
  if (typeof value !== 'string') throw new DeploymentProfileInputError(`${label} 必填`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < minimum || normalized.length > maximum) throw new DeploymentProfileInputError(`${label} 必须为 ${minimum}–${maximum} 个有效字符`);
  return normalized;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_000) throw new DeploymentProfileInputError('请求体过大');
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    return parsed as Record<string, unknown>;
  } catch { throw new DeploymentProfileInputError('请求体必须是 JSON 对象'); }
}

function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return {}; } }
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
  return true;
}

class DeploymentProfileInputError extends Error {}
class DeploymentProfileVersionError extends Error {
  constructor(readonly currentVersion: number) { super(`采购部署模式版本已变化，当前版本 ${currentVersion}`); }
}
