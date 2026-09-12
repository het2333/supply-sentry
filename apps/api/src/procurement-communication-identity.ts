import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';

export interface ProcurementCommunicationIdentity {
  displayName: string;
  title: string;
  organizationName: string;
  status: 'active' | 'disabled';
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

interface IdentityRow {
  display_name: string;
  title: string;
  organization_name: string;
  status: 'active' | 'disabled';
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface LegacyDraftIdentityStats {
  withoutIdentity: number;
  eligibleForRebind: number;
  requiresManualReview: number;
  reboundInThisWrite: number;
}

interface LegacyDraftRow {
  id: string;
  body: string;
  version: number;
  trigger_evidence_json: string;
}

const LEGACY_READYWORK_SIGNATURE = '\u6b64\u81f4\nReadywork \u91c7\u8d2d\u6267\u884c\u52a9\u624b\uff08\u4ee3\u91c7\u8d2d\u65b9\u53d1\u9001\uff09';

export function getProcurementCommunicationIdentity(db: DatabaseSync, tenantId: string): ProcurementCommunicationIdentity | null {
  const row = db.prepare(`SELECT display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at
    FROM procurement_communication_identities WHERE tenant_id=?`).get(tenantId) as IdentityRow | undefined;
  return row ? present(row) : null;
}

export function communicationSignature(identity: Pick<ProcurementCommunicationIdentity, 'displayName' | 'title' | 'organizationName'>): string {
  return `此致\n${identity.displayName}\n${identity.title}｜${identity.organizationName}`;
}

export async function handleProcurementCommunicationIdentityRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: { db: DatabaseSync; session: Session | null; now?: () => Date },
): Promise<boolean> {
  if (path !== '/api/procurement/communication-identity') return false;
  if (!context.session) return json(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { db, session } = context;

  if (method === 'GET') {
    if (!can(session, 'read')) return json(res, 403, { error: '无读取采购沟通身份权限', code: 'FORBIDDEN' });
    return json(res, 200, view(db, session, 0));
  }

  if (method === 'PUT') {
    if (!can(session, 'configure')) return json(res, 403, { error: '只有采购经理或管理员可以配置供应商沟通身份', code: 'FORBIDDEN' });
    try {
      const body = await readJson(req);
      const allowed = new Set(['expectedVersion', 'displayName', 'title', 'organizationName']);
      for (const key of Object.keys(body)) if (!allowed.has(key)) throw new IdentityInputError(`不允许的字段: ${key}`);
      const expectedVersion = nonNegativeInteger(body['expectedVersion'], 'expectedVersion');
      const displayName = requiredText(body['displayName'], '联系人姓名', 100);
      const title = requiredText(body['title'], '职位', 100);
      const organizationName = requiredText(body['organizationName'], '公司名称', 160);
      const now = (context.now?.() ?? new Date()).toISOString();
      let reboundDrafts = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = getProcurementCommunicationIdentity(db, session.tenantId);
        if (!current) {
          if (expectedVersion !== 0) throw new IdentityVersionError(0);
          db.prepare(`INSERT INTO procurement_communication_identities
            (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
            VALUES (?,?,?,?,'active',1,?,?,?,?)`).run(
              session.tenantId, displayName, title, organizationName, session.humanId, session.humanId, now, now,
            );
          reboundDrafts = rebindEligibleLegacyDrafts(db, session.tenantId, session.humanId, {
            displayName, title, organizationName, version: 1,
          }, now);
          insertEvent(db, session.tenantId, session.humanId, 'created', { displayName, title, organizationName, version: 1, reboundDrafts }, now);
        } else {
          if (current.version !== expectedVersion) throw new IdentityVersionError(current.version);
          const changed = db.prepare(`UPDATE procurement_communication_identities
            SET display_name=?,title=?,organization_name=?,status='active',version=version+1,updated_by=?,updated_at=?
            WHERE tenant_id=? AND version=?`).run(displayName, title, organizationName, session.humanId, now, session.tenantId, expectedVersion);
          if (changed.changes !== 1) throw new IdentityVersionError(getProcurementCommunicationIdentity(db, session.tenantId)?.version ?? expectedVersion);
          // Draft sender snapshots are immutable once present. Updating the
          // tenant setting never rewrites an already reviewed identity.
          reboundDrafts = rebindEligibleLegacyDrafts(db, session.tenantId, session.humanId, {
            displayName, title, organizationName, version: expectedVersion + 1,
          }, now);
          insertEvent(db, session.tenantId, session.humanId, 'updated', { displayName, title, organizationName, previousVersion: expectedVersion, version: expectedVersion + 1, reboundDrafts }, now);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return json(res, expectedVersion === 0 ? 201 : 200, view(db, session, reboundDrafts));
    } catch (error) {
      if (error instanceof IdentityVersionError) return json(res, 409, { error: error.message, code: 'COMMUNICATION_IDENTITY_VERSION_CONFLICT', currentVersion: error.currentVersion });
      if (error instanceof IdentityInputError) return json(res, 422, { error: error.message, code: 'INVALID_COMMUNICATION_IDENTITY' });
      return json(res, 500, { error: '采购沟通身份保存失败', code: 'COMMUNICATION_IDENTITY_WRITE_FAILED' });
    }
  }

  return json(res, 405, { error: '不支持的请求方法', code: 'METHOD_NOT_ALLOWED' });
}

function view(db: DatabaseSync, session: Session, reboundInThisWrite: number): Record<string, unknown> {
  const item = getProcurementCommunicationIdentity(db, session.tenantId);
  const events = db.prepare(`SELECT id,actor_id,action,detail_json,created_at
    FROM procurement_communication_identity_events WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 20`).all(session.tenantId) as Array<{
      id: string; actor_id: string; action: string; detail_json: string; created_at: string;
    }>;
  return {
    item,
    readiness: item?.status === 'active' ? 'ready' : 'missing',
    suggested: { displayName: session.name, title: session.role },
    permissions: { read: can(session, 'read'), configure: can(session, 'configure') },
    legacyDrafts: legacyDraftStats(db, session.tenantId, reboundInThisWrite),
    events: events.map((event) => ({ id: event.id, actorId: event.actor_id, action: event.action, detail: safeJson(event.detail_json), createdAt: event.created_at })),
  };
}

function legacyDraftStats(db: DatabaseSync, tenantId: string, reboundInThisWrite: number): LegacyDraftIdentityStats {
  const row = db.prepare(`SELECT
      COUNT(*) AS without_identity,
      SUM(CASE WHEN created_by='ai:procurement-sla'
        AND trigger_code LIKE 'sla:%'
        AND body LIKE '%' || ?
        AND NOT EXISTS (
          SELECT 1 FROM procurement_message_draft_events e
          WHERE e.tenant_id=d.tenant_id AND e.draft_id=d.id AND e.action='edited'
        ) THEN 1 ELSE 0 END) AS eligible
    FROM procurement_message_drafts d
    WHERE tenant_id=? AND status='draft'
      AND (sender_name IS NULL OR trim(sender_name)='' OR sender_title IS NULL OR trim(sender_title)=''
        OR sender_organization IS NULL OR trim(sender_organization)='')`)
    .get(LEGACY_READYWORK_SIGNATURE, tenantId) as { without_identity: number; eligible: number | null };
  const withoutIdentity = Number(row.without_identity ?? 0);
  const eligibleForRebind = Number(row.eligible ?? 0);
  return {
    withoutIdentity,
    eligibleForRebind,
    requiresManualReview: Math.max(0, withoutIdentity - eligibleForRebind),
    reboundInThisWrite,
  };
}

/**
 * Upgrade only untouched, still-pending SLA drafts whose exact legacy footer
 * proves they were generated by the old product identity. Human-edited,
 * approved, sent and discarded messages are never rewritten.
 */
function rebindEligibleLegacyDrafts(
  db: DatabaseSync,
  tenantId: string,
  actorId: string,
  identity: Pick<ProcurementCommunicationIdentity, 'displayName' | 'title' | 'organizationName' | 'version'>,
  at: string,
): number {
  const rows = db.prepare(`SELECT d.id,d.body,d.version,d.trigger_evidence_json
    FROM procurement_message_drafts d
    WHERE d.tenant_id=? AND d.status='draft'
      AND (d.sender_name IS NULL OR trim(d.sender_name)='' OR d.sender_title IS NULL OR trim(d.sender_title)=''
        OR d.sender_organization IS NULL OR trim(d.sender_organization)='')
      AND d.created_by='ai:procurement-sla' AND d.trigger_code LIKE 'sla:%'
      AND d.body LIKE '%' || ?
      AND NOT EXISTS (
        SELECT 1 FROM procurement_message_draft_events e
        WHERE e.tenant_id=d.tenant_id AND e.draft_id=d.id AND e.action='edited'
      )
    ORDER BY d.created_at,d.id`).all(tenantId, LEGACY_READYWORK_SIGNATURE) as unknown as LegacyDraftRow[];
  let rebound = 0;
  for (const row of rows) {
    if (!row.body.endsWith(LEGACY_READYWORK_SIGNATURE)) continue;
    const body = `${row.body.slice(0, -LEGACY_READYWORK_SIGNATURE.length)}${communicationSignature(identity)}`;
    const priorEvidence = safeJson(row.trigger_evidence_json);
    const evidence = priorEvidence && typeof priorEvidence === 'object' && !Array.isArray(priorEvidence)
      ? priorEvidence as Record<string, unknown>
      : {};
    const communicationIdentity = {
      displayName: identity.displayName,
      title: identity.title,
      organizationName: identity.organizationName,
      version: identity.version,
    };
    const changed = db.prepare(`UPDATE procurement_message_drafts
      SET body=?,trigger_evidence_json=?,sender_name=?,sender_title=?,sender_organization=?,version=version+1,updated_at=?
      WHERE tenant_id=? AND id=? AND version=? AND status='draft'
        AND (sender_name IS NULL OR trim(sender_name)='' OR sender_title IS NULL OR trim(sender_title)=''
          OR sender_organization IS NULL OR trim(sender_organization)='')`).run(
      body,
      JSON.stringify({ ...evidence, communicationIdentity, identityReboundAt: at, identityReboundFromLegacy: true }),
      identity.displayName,
      identity.title,
      identity.organizationName,
      at,
      tenantId,
      row.id,
      row.version,
    );
    if (changed.changes !== 1) throw new Error('旧沟通草稿身份重绑发生并发冲突');
    db.prepare(`INSERT INTO procurement_message_draft_events
      (tenant_id,id,draft_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`).run(
      tenantId,
      `message-draft-event:${randomUUID()}`,
      row.id,
      actorId,
      'identity_rebound',
      JSON.stringify({ previousVersion: row.version, version: row.version + 1, communicationIdentity, legacySignatureRemoved: true }),
      at,
    );
    rebound += 1;
  }
  return rebound;
}

function present(row: IdentityRow): ProcurementCommunicationIdentity {
  return {
    displayName: row.display_name,
    title: row.title,
    organizationName: row.organization_name,
    status: row.status,
    version: row.version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insertEvent(db: DatabaseSync, tenantId: string, actorId: string, action: string, detail: unknown, at: string): void {
  db.prepare(`INSERT INTO procurement_communication_identity_events
    (tenant_id,id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?)`)
    .run(tenantId, `communication-identity-event:${randomUUID()}`, actorId, action, JSON.stringify(detail), at);
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new IdentityInputError(`${label} 必填`);
  if (/[\r\n\u0000]/.test(value)) throw new IdentityInputError(`${label} 不能包含换行或空字符`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > maximum) throw new IdentityInputError(`${label} 必须为 1–${maximum} 个有效字符`);
  return normalized;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new IdentityInputError(`${label} 必须是非负整数`);
  return Number(value);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_000) throw new IdentityInputError('请求体过大');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    return parsed as Record<string, unknown>;
  } catch { throw new IdentityInputError('请求体必须是 JSON 对象'); }
}

function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return {}; } }
function json(res: ServerResponse, status: number, body: unknown): true { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); return true; }

class IdentityInputError extends Error {}
class IdentityVersionError extends Error {
  constructor(readonly currentVersion: number) { super(`采购沟通身份版本已变化，当前版本 ${currentVersion}`); }
}
