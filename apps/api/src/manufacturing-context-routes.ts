import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AppendTwinAgentEventInput,
  PermissionRule,
  TwinAccessScope,
  TwinFactConflict,
  TwinEntityType,
  TwinProjectionStatus,
} from '@readywork/core';
import { PolicyEngine } from '@readywork/core';
import {
  buildTwinSnapshot,
  reduceStoredTwinSnapshot,
  sanitizeContextValue,
  scopeForSession,
  SqliteManufacturingContextStore,
  SqliteTwinProjectionQueue,
} from '@readywork/context';
import {
  decideTwinCorrection,
  requestTwinCorrection,
} from './manufacturing-context-corrections.js';
import { can, type PlatformPermission, type Session } from './auth.js';

type ProjectionStatus = 'current' | 'lagging' | 'degraded' | 'unavailable';

export type ContextEnvelope<T> = {
  data: T;
  sourceWatermark: string;
  projectionStatus: ProjectionStatus;
  missingFacts: string[];
  conflicts: TwinFactConflict[];
  truncated: boolean;
  nextCursor: string | null;
};

export interface ManufacturingContextRouteContext {
  db: DatabaseSync;
  session: Session | null;
  internal: boolean;
  workerStatus: (tenantId: string) => { state: 'ready' | 'unavailable'; lastHeartbeatAt: string | null };
}

interface ProjectionJobStatusRow {
  status: TwinProjectionStatus;
  count: number;
}

interface ProjectionHealth {
  status: ProjectionStatus;
  queue: { queued: number; processing: number; retryWait: number; succeeded: number; deadLetter: number };
  oldestPendingAgeMs: number | null;
  latestSuccess: { projectedWatermark: string; completedAt: string } | null;
  latestFailure: { error: string; updatedAt: string } | null;
  worker: { state: 'ready' | 'unavailable'; lastHeartbeatAt: string | null };
  counts: { entities: number; relations: number; evidence: number; agentEvents: number; snapshots: number };
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
  return true;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1_048_576) throw new Error('Context 请求体超过 1 MiB 上限');
    chunks.push(value);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('Context 请求体必须是 JSON 对象');
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('Context 路径参数无效');
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Context ${field} 不能为空`);
  return value.trim();
}

function requiredIsoInstant(value: unknown, field: string): string {
  const text = requiredString(value, field);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) throw new Error(`Context ${field} 必须是有效 ISO 时间`);
  const [, year, month, day, hour, minute, second, , zone] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  const validCalendar = Number.isFinite(calendar.getTime())
    && calendar.getUTCFullYear() === Number(year)
    && calendar.getUTCMonth() + 1 === Number(month)
    && calendar.getUTCDate() === Number(day);
  const offset = zone === 'Z' ? [0, 0] : zone!.slice(1).split(':').map(Number);
  if (!validCalendar || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || offset[0]! > 23 || offset[1]! > 59) {
    throw new Error(`Context ${field} 必须是有效 ISO 时间`);
  }
  const instant = Date.parse(text);
  if (!Number.isFinite(instant)) throw new Error(`Context ${field} 必须是有效 ISO 时间`);
  return new Date(instant).toISOString();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const EMPLOYEE_CONTEXT_TYPE_ALIASES: Readonly<Record<string, TwinEntityType>> = {
  supplier: 'supplier', contact: 'contact', material: 'material',
  requisition: 'requisition', rfq: 'rfq', quote: 'quote', award: 'award',
  po: 'purchase_order', purchase_order: 'purchase_order', po_line: 'po_line',
  email: 'communication', communication: 'communication', shipment: 'shipment', receipt: 'receipt',
  invoice: 'invoice', sla_evaluation: 'sla_evaluation',
};

export function mapEmployeeContextScope(values: readonly string[]): TwinEntityType[] {
  return [...new Set(values.map((value) => EMPLOYEE_CONTEXT_TYPE_ALIASES[value.trim().toLowerCase()])
    .filter((value): value is TwinEntityType => value !== undefined))].sort();
}

interface PersistedEmployeeContextAuthority {
  entityTypes: TwinEntityType[];
  permissions: PermissionRule[];
}

interface ContextCapabilityCheck {
  action: string;
  resource: string;
}

interface ContextPurposeCapability {
  read: ContextCapabilityCheck;
  operate?: ContextCapabilityCheck;
}

const V1_CONTEXT_PURPOSE_CAPABILITIES: Readonly<Record<
string,
Partial<Record<TwinEntityType, ContextPurposeCapability>>
>> = {
  po_supplier_commitment: {
    purchase_order: { read: { action: 'po.get', resource: 'erp' }, operate: { action: 'send', resource: 'email' } },
  },
  quote_comparison: {
    rfq: { read: { action: 'rfq.create', resource: 'erp' }, operate: { action: 'rfq.award', resource: 'erp' } },
    quote: { read: { action: 'rfq.create', resource: 'erp' }, operate: { action: 'rfq.award', resource: 'erp' } },
    purchase_order: { read: { action: 'po.get', resource: 'erp' }, operate: { action: 'rfq.award', resource: 'erp' } },
  },
  create_odoo_po_draft: {
    purchase_order: { read: { action: 'po.get', resource: 'erp' }, operate: { action: 'po.create_draft', resource: 'erp' } },
  },
  send_po: {
    purchase_order: { read: { action: 'po.get', resource: 'erp' }, operate: { action: 'send', resource: 'email' } },
  },
  record_confirmation: {
    purchase_order: { read: { action: 'po.get', resource: 'erp' }, operate: { action: 'po.update', resource: 'erp' } },
  },
  record_invoice: {
    invoice: { read: { action: 'invoice.get', resource: 'erp' }, operate: { action: 'invoice.update', resource: 'erp' } },
    purchase_order: { read: { action: 'po.get', resource: 'erp' }, operate: { action: 'invoice.update', resource: 'erp' } },
  },
  match_invoice: {
    invoice: { read: { action: 'invoice.get', resource: 'erp' }, operate: { action: 'invoice.update', resource: 'erp' } },
    purchase_order: { read: { action: 'po.get', resource: 'erp' }, operate: { action: 'invoice.update', resource: 'erp' } },
  },
};

const contextPolicy = new PolicyEngine();

function persistedEmployeeContextAuthority(
  db: DatabaseSync,
  tenantId: string,
  employeeId: string,
): PersistedEmployeeContextAuthority {
  const employee = db.prepare(`SELECT current_version_id FROM workforce_employees
    WHERE tenant_id=? AND id=?`).get(tenantId, employeeId) as { current_version_id: string } | undefined;
  const deployment = db.prepare(`SELECT version_id FROM workforce_employee_deployments
    WHERE tenant_id=? AND employee_id=?`).get(tenantId, employeeId) as { version_id: string } | undefined;
  if (!employee || !deployment || !employee.current_version_id || deployment.version_id !== employee.current_version_id) {
    throw new Error('Context 员工当前规格不存在或已过期');
  }
  const storedVersion = db.prepare(`SELECT employee_id,definition_json FROM workforce_employee_versions
    WHERE tenant_id=? AND id=?`).get(tenantId, employee.current_version_id) as {
      employee_id: string; definition_json: string;
    } | undefined;
  if (!storedVersion || storedVersion.employee_id !== employeeId) throw new Error('Context 员工当前规格不存在或已过期');
  let version: Record<string, unknown>;
  try {
    version = JSON.parse(storedVersion.definition_json) as Record<string, unknown>;
  } catch {
    throw new Error('Context 员工当前规格无效');
  }
  if (version['tenantId'] !== tenantId || version['employeeId'] !== employeeId || version['id'] !== employee.current_version_id) {
    throw new Error('Context 员工当前规格无效');
  }
  const spec = version['spec'];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Context 员工当前规格无效');
  const contextScope = (spec as Record<string, unknown>)['contextScope'];
  const permissions = (spec as Record<string, unknown>)['permissions'];
  if (!Array.isArray(contextScope) || contextScope.some((value) => typeof value !== 'string')
    || !Array.isArray(permissions)) throw new Error('Context 员工当前规格无效');
  const entityTypes = mapEmployeeContextScope(contextScope as string[]);
  if (entityTypes.length === 0) throw new Error('Context 员工当前实体范围为空');
  const trustedPermissions: PermissionRule[] = [];
  for (const permission of permissions) {
    if (!permission || typeof permission !== 'object' || Array.isArray(permission)) throw new Error('Context 员工当前规格无效');
    const rule = permission as Record<string, unknown>;
    if ((rule['effect'] !== 'allow' && rule['effect'] !== 'deny')
      || typeof rule['action'] !== 'string' || typeof rule['resource'] !== 'string') {
      throw new Error('Context 员工当前规格无效');
    }
    trustedPermissions.push({
      effect: rule['effect'], action: rule['action'], resource: rule['resource'],
      ...(typeof rule['note'] === 'string' ? { note: rule['note'] } : {}),
    });
  }
  return { permissions: trustedPermissions, entityTypes };
}

function internalSnapshotScope(
  authority: PersistedEmployeeContextAuthority,
  body: Record<string, unknown>,
  purpose: string,
  rootEntityType: TwinEntityType,
): TwinAccessScope {
  const capability = V1_CONTEXT_PURPOSE_CAPABILITIES[purpose]?.[rootEntityType];
  if (!capability || !contextPolicy.can(
    authority.permissions, capability.read.action, capability.read.resource,
  )) {
    throw new Error('Context 员工规格未授权当前用途和根实体可见性');
  }
  const maximumPermission: 'read' | 'operate' = capability.operate && contextPolicy.can(
    authority.permissions, capability.operate.action, capability.operate.resource,
  ) ? 'operate' : 'read';
  const order = ['read', 'operate', 'approve', 'configure', 'admin'] as const;
  const permission = body['permission'] === undefined
    ? maximumPermission : requiredString(body['permission'], 'permission') as TwinAccessScope['permission'];
  if (!order.includes(permission) || order.indexOf(permission) > order.indexOf(maximumPermission)) {
    throw new Error('Context 调用方请求的权限超出员工规格');
  }
  let entityTypes = authority.entityTypes;
  if (body['entityTypes'] !== undefined) {
    if (!Array.isArray(body['entityTypes'])) throw new Error('Context entityTypes 必须是数组');
    const requested = body['entityTypes'].map((item) => requiredString(item, 'entityTypes'));
    if (requested.some((item) => EMPLOYEE_CONTEXT_TYPE_ALIASES[item] !== item)) {
      throw new Error('Context 调用方请求的实体类型无效');
    }
    if (requested.some((item) => !authority.entityTypes.includes(item as TwinEntityType))) {
      throw new Error('Context 调用方请求的实体类型超出员工规格');
    }
    entityTypes = [...new Set(requested as TwinEntityType[])].sort();
  }
  if (!entityTypes.includes(rootEntityType)) throw new Error('Context 根实体不在员工授权范围');
  return scopeForSession(permission, { entityTypes, purpose });
}

function projectionHealth(
  db: DatabaseSync,
  tenantId: string,
  worker: ManufacturingContextRouteContext['workerStatus'],
): ProjectionHealth {
  const rows = db.prepare(`SELECT status,COUNT(*) AS count FROM twin_projection_jobs
    WHERE tenant_id=? GROUP BY status`).all(tenantId) as unknown as ProjectionJobStatusRow[];
  const counts: Record<TwinProjectionStatus, number> = { queued: 0, processing: 0, retry_wait: 0, succeeded: 0, dead_letter: 0 };
  for (const row of rows) counts[row.status] = Number(row.count);
  const oldest = db.prepare(`SELECT MIN(available_at) AS available_at FROM twin_projection_jobs
    WHERE tenant_id=? AND status IN ('queued','processing','retry_wait')`).get(tenantId) as { available_at: string | null };
  const success = db.prepare(`SELECT projected_watermark,completed_at FROM twin_projection_jobs
    WHERE tenant_id=? AND status='succeeded' AND projected_watermark IS NOT NULL AND completed_at IS NOT NULL
    ORDER BY completed_at DESC,id ASC LIMIT 1`).get(tenantId) as { projected_watermark: string; completed_at: string } | undefined;
  const failure = db.prepare(`SELECT last_error,updated_at FROM twin_projection_jobs
    WHERE tenant_id=? AND last_error IS NOT NULL ORDER BY updated_at DESC,id ASC LIMIT 1`)
    .get(tenantId) as { last_error: string; updated_at: string } | undefined;
  const observedWorker = worker(tenantId);
  const heartbeatAge = observedWorker.lastHeartbeatAt === null
    ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(observedWorker.lastHeartbeatAt);
  const oldestPendingAgeMs = oldest.available_at === null ? null : Math.max(0, Date.now() - Date.parse(oldest.available_at));
  const workerUnavailable = observedWorker.state === 'unavailable' || !Number.isFinite(heartbeatAge) || heartbeatAge > 6_000;
  const status: ProjectionStatus = workerUnavailable ? 'unavailable'
    : counts.dead_letter > 0 || (oldestPendingAgeMs !== null && oldestPendingAgeMs > 600_000) ? 'degraded'
      : counts.queued > 0 || counts.processing > 0 || counts.retry_wait > 0 ? 'lagging' : 'current';
  const tableCount = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id=?`)
    .get(tenantId) as { count: number }).count);
  return {
    status,
    queue: { queued: counts.queued, processing: counts.processing, retryWait: counts.retry_wait, succeeded: counts.succeeded, deadLetter: counts.dead_letter },
    oldestPendingAgeMs,
    latestSuccess: success ? { projectedWatermark: success.projected_watermark, completedAt: success.completed_at } : null,
    latestFailure: failure ? { error: failure.last_error, updatedAt: failure.updated_at } : null,
    worker: observedWorker,
    counts: {
      entities: tableCount('twin_entities'), relations: tableCount('twin_relations'),
      evidence: tableCount('twin_evidence'), agentEvents: tableCount('twin_agent_events'), snapshots: tableCount('twin_snapshots'),
    },
  };
}

function effectivePermission(session: Session): TwinAccessScope['permission'] {
  for (const permission of ['admin', 'configure', 'approve', 'operate', 'read'] as const) {
    if (can(session, permission)) return permission;
  }
  return 'read';
}

function currentWebReaderScope(session: Session, purpose: string): TwinAccessScope {
  const authenticated = session as Session & {
    contextPermission?: TwinAccessScope['permission'];
    contextEntityTypes?: TwinAccessScope['entityTypes'];
  };
  const rolePermission = effectivePermission(session);
  const order = ['read', 'operate', 'approve', 'configure', 'admin'] as const;
  const requestedPermission = authenticated.contextPermission ?? rolePermission;
  if (!order.includes(requestedPermission)
    || order.indexOf(requestedPermission) > order.indexOf(rolePermission)) {
    throw new Error('Context 当前会话范围无效');
  }
  const entityTypes = authenticated.contextEntityTypes ?? [];
  if (!Array.isArray(entityTypes)) throw new Error('Context 当前会话实体范围无效');
  return scopeForSession(requestedPermission, { entityTypes, purpose });
}

function withoutTenantMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTenantMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'tenantId' && key !== 'tenant_id')
    .map(([key, item]) => [key, withoutTenantMetadata(item)]));
}

function safeResponse<T>(value: T): T {
  return withoutTenantMetadata(sanitizeContextValue(value, {
    includeContactDetails: true,
    includeCommercialTerms: true,
  })) as T;
}

function envelope<T>(
  data: T,
  sourceWatermark: string,
  health: ProjectionHealth,
  options: { missingFacts?: string[]; conflicts?: TwinFactConflict[]; truncated?: boolean; nextCursor?: string | null } = {},
): ContextEnvelope<T> {
  return {
    data: safeResponse(data),
    sourceWatermark,
    projectionStatus: health.status,
    missingFacts: options.missingFacts ?? [],
    conflicts: options.conflicts ?? [],
    truncated: options.truncated ?? false,
    nextCursor: options.nextCursor ?? null,
  };
}

function forbidden(res: ServerResponse, permission: PlatformPermission): true {
  return sendJson(res, 403, { error: `当前角色无「${permission}」权限`, code: 'FORBIDDEN' });
}

function webSession(res: ServerResponse, context: ManufacturingContextRouteContext): Session | undefined {
  if (!context.session) {
    sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
    return undefined;
  }
  return context.session;
}

function snapshotReadModel(
  store: SqliteManufacturingContextStore,
  entityId: string,
  session: Session,
  depth: 1 | 2,
  purpose: string,
): Record<string, any> {
  const neighborhood = store.getNeighborhood(entityId, { depth, entityLimit: 500, evidenceLimit: 2_000 });
  return buildTwinSnapshot(neighborhood, scopeForSession(effectivePermission(session), { purpose }), purpose);
}

function responseForError(res: ServerResponse, error: unknown): true {
  const message = error instanceof Error ? error.message : 'Context 请求失败';
  const status = /不存在|不属于当前租户/.test(message) ? 404
    : /冲突|状态不允许|不能审批自己|死信/.test(message) ? 409 : 400;
  return sendJson(res, status, { error: message, code: status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'INVALID_CONTEXT_REQUEST' });
}

function graphEnvelope(
  model: Record<string, any>,
  health: ProjectionHealth,
  data: unknown = model,
): ContextEnvelope<unknown> {
  return envelope(data, String(model['sourceWatermark'] ?? ''), health, {
    missingFacts: Array.isArray(model['missingFacts']) ? model['missingFacts'] as string[] : [],
    conflicts: Array.isArray(model['conflicts']) ? model['conflicts'] as TwinFactConflict[] : [],
    truncated: model['truncated'] === true,
    nextCursor: typeof model['nextCursor'] === 'string' ? model['nextCursor'] : null,
  });
}

/** Handles only Manufacturing Context paths and returns false for all other routes. */
export async function handleManufacturingContextRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ManufacturingContextRouteContext,
): Promise<boolean> {
  const isWebPath = path.startsWith('/api/context/v1/');
  const isInternalPath = path.startsWith('/api/internal/context/v1/');
  if (!isWebPath && !isInternalPath) return false;
  if (isInternalPath && !context.internal) return sendJson(res, 401, { error: '内部回调未授权', code: 'INTERNAL_UNAUTHORIZED' });

  try {
    if (isInternalPath) {
      if (method !== 'POST') return sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
      const body = await readJsonBody(req);
      const tenantId = requiredString(body['tenantId'], 'tenantId');
      const store = new SqliteManufacturingContextStore(context.db, tenantId);
      const health = projectionHealth(context.db, tenantId, context.workerStatus);
      if (path === '/api/internal/context/v1/snapshots') {
        const employeeId = requiredString(body['employeeId'], 'employeeId');
        const requestedRootEntityId = optionalString(body['rootEntityId']);
        const rootBusinessObjectId = optionalString(body['rootBusinessObjectId']);
        if (!requestedRootEntityId && !rootBusinessObjectId) throw new Error('Context rootEntityId 或 rootBusinessObjectId 不能同时为空');
        const businessRoot = rootBusinessObjectId ? store.getByBusinessObjectId(rootBusinessObjectId) : undefined;
        if (rootBusinessObjectId && !businessRoot) {
          return sendJson(res, 404, { error: 'Context 根业务对象不存在', code: 'NOT_FOUND' });
        }
        if (requestedRootEntityId && businessRoot && requestedRootEntityId !== businessRoot.id) {
          throw new Error('Context 根实体与根业务对象关联冲突');
        }
        const rootEntityId = requestedRootEntityId ?? businessRoot!.id;
        const purpose = requiredString(body['purpose'], 'purpose');
        const rootEntity = store.getEntity(rootEntityId);
        if (!rootEntity) return sendJson(res, 404, { error: 'Context 根实体不存在', code: 'NOT_FOUND' });
        const authority = persistedEmployeeContextAuthority(context.db, tenantId, employeeId);
        const snapshot = store.createSnapshot({
          employeeId, rootEntityId, purpose,
          scope: internalSnapshotScope(authority, body, purpose, rootEntity.entityType),
        });
        return sendJson(res, 201, envelope(snapshot, snapshot.sourceWatermark, health, {
          missingFacts: Array.isArray(snapshot.snapshot['missingFacts']) ? snapshot.snapshot['missingFacts'] as string[] : [],
          conflicts: Array.isArray(snapshot.snapshot['conflicts']) ? snapshot.snapshot['conflicts'] as TwinFactConflict[] : [],
          truncated: snapshot.snapshot['truncated'] === true,
          nextCursor: typeof snapshot.snapshot['nextCursor'] === 'string' ? snapshot.snapshot['nextCursor'] : null,
        }));
      }
      if (path === '/api/internal/context/v1/agent-events') {
        const event: AppendTwinAgentEventInput = {
          employeeId: requiredString(body['employeeId'], 'employeeId'),
          runId: requiredString(body['runId'], 'runId'),
          taskId: requiredString(body['taskId'], 'taskId'),
          eventType: requiredString(body['eventType'], 'eventType') as AppendTwinAgentEventInput['eventType'],
          status: requiredString(body['status'], 'status'),
          evidenceIds: Array.isArray(body['evidenceIds']) ? body['evidenceIds'].map((item) => requiredString(item, 'evidenceIds')) : [],
          payload: typeof body['payload'] === 'object' && body['payload'] !== null && !Array.isArray(body['payload'])
            ? body['payload'] as Record<string, unknown> : {},
          createdAt: requiredIsoInstant(body['createdAt'], 'createdAt'),
          ...(optionalString(body['temporalWorkflowId']) ? { temporalWorkflowId: optionalString(body['temporalWorkflowId'])! } : {}),
          ...(optionalString(body['businessObjectId']) ? { businessObjectId: optionalString(body['businessObjectId'])! } : {}),
          ...(optionalString(body['entityId']) ? { entityId: optionalString(body['entityId'])! } : {}),
          ...(optionalString(body['inputSnapshotId']) ? { inputSnapshotId: optionalString(body['inputSnapshotId'])! } : {}),
          ...(optionalString(body['model']) ? { model: optionalString(body['model'])! } : {}),
          ...(optionalString(body['reasoningProfile']) ? { reasoningProfile: optionalString(body['reasoningProfile'])! } : {}),
          ...(optionalString(body['promptHash']) ? { promptHash: optionalString(body['promptHash'])! } : {}),
          ...(optionalString(body['responseHash']) ? { responseHash: optionalString(body['responseHash'])! } : {}),
          ...(optionalString(body['actionName']) ? { actionName: optionalString(body['actionName'])! } : {}),
          ...(typeof body['confidence'] === 'number' ? { confidence: body['confidence'] } : {}),
        };
        const created = store.appendAgentEvent(event);
        const snapshot = created.inputSnapshotId ? store.getSnapshot(created.inputSnapshotId) : undefined;
        const entity = created.entityId ? store.getEntity(created.entityId) : undefined;
        return sendJson(res, 201, envelope(created, snapshot?.sourceWatermark ?? entity?.sourceWatermark ?? '', health));
      }
      return sendJson(res, 404, { error: 'Context 内部路由不存在', code: 'NOT_FOUND' });
    }

    const session = webSession(res, context);
    if (!session) return true;
    const store = new SqliteManufacturingContextStore(context.db, session.tenantId);
    const queue = new SqliteTwinProjectionQueue(context.db, session.tenantId);
    const health = projectionHealth(context.db, session.tenantId, context.workerStatus);

    if (path === '/api/context/v1/projections/status') {
      if (method !== 'GET') return sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
      if (!can(session, 'configure') && !can(session, 'admin')) return forbidden(res, 'configure');
      return sendJson(res, 200, envelope(health, health.latestSuccess?.projectedWatermark ?? '', health));
    }

    const replayMatch = path.match(/^\/api\/context\/v1\/projections\/([^/]+)\/replay$/);
    if (replayMatch) {
      if (method !== 'POST') return sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
      if (!can(session, 'configure') && !can(session, 'admin')) return forbidden(res, 'configure');
      const jobId = decode(replayMatch[1]!);
      const current = queue.get(jobId);
      if (!current) return sendJson(res, 404, { error: 'Context 投影任务不存在', code: 'NOT_FOUND' });
      const replayed = queue.replayDeadLetter({ id: jobId, actorId: session.humanId, replayedAt: new Date().toISOString() });
      return sendJson(res, 200, envelope(replayed, replayed.projectedWatermark ?? '', projectionHealth(context.db, session.tenantId, context.workerStatus)));
    }

    const decisionMatch = path.match(/^\/api\/context\/v1\/corrections\/([^/]+)\/decision$/);
    if (decisionMatch) {
      if (method !== 'POST') return sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
      if (!can(session, 'approve')) return forbidden(res, 'approve');
      const approvalId = decode(decisionMatch[1]!);
      const exists = context.db.prepare(`SELECT 1 FROM procurement_execution_approvals
        WHERE tenant_id=? AND id=? AND kind='twin_fact_correction'`).get(session.tenantId, approvalId);
      if (!exists) return sendJson(res, 404, { error: 'Context 纠正审批不存在', code: 'NOT_FOUND' });
      const body = await readJsonBody(req);
      const decision = requiredString(body['decision'], 'decision');
      if (decision !== 'approved' && decision !== 'rejected') throw new Error('Context decision 不受支持');
      const decided = decideTwinCorrection({ db: context.db, tenantId: session.tenantId, store, queue }, {
        approvalId, decision, decidedBy: session.humanId, approverPermission: 'approve', decidedAt: new Date().toISOString(),
      });
      const entity = store.getEntity(decided.entityId);
      return sendJson(res, 200, envelope(decided, entity?.sourceWatermark ?? '', projectionHealth(context.db, session.tenantId, context.workerStatus)));
    }

    const correctionMatch = path.match(/^\/api\/context\/v1\/entities\/([^/]+)\/corrections$/);
    if (correctionMatch) {
      if (method !== 'POST') return sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
      if (!can(session, 'operate')) return forbidden(res, 'operate');
      const entityId = decode(correctionMatch[1]!);
      const entity = store.getEntity(entityId);
      if (!entity) return sendJson(res, 404, { error: 'Context 实体不存在', code: 'NOT_FOUND' });
      const body = await readJsonBody(req);
      const created = requestTwinCorrection({ db: context.db, tenantId: session.tenantId, store, queue }, {
        entityId,
        factPath: requiredString(body['factPath'], 'factPath'),
        oldValue: body['oldValue'], newValue: body['newValue'],
        reason: requiredString(body['reason'], 'reason'),
        evidenceReference: requiredString(body['evidenceReference'], 'evidenceReference'),
        requestedBy: session.humanId, requesterPermission: 'operate', requestedAt: new Date().toISOString(),
      });
      return sendJson(res, 201, envelope(created, entity.sourceWatermark, health));
    }

    if (method !== 'GET') return sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
    if (!can(session, 'read')) return forbidden(res, 'read');

    const snapshotMatch = path.match(/^\/api\/context\/v1\/snapshots\/([^/]+)$/);
    if (snapshotMatch) {
      const snapshot = store.getSnapshot(decode(snapshotMatch[1]!));
      if (!snapshot) return sendJson(res, 404, { error: 'Context 快照不存在', code: 'NOT_FOUND' });
      const reducedSnapshot = reduceStoredTwinSnapshot(
        snapshot.snapshot,
        currentWebReaderScope(session, 'web_stored_snapshot_read'),
        'web_stored_snapshot_read',
      );
      const responseSnapshot = { ...snapshot, snapshot: reducedSnapshot };
      return sendJson(res, 200, envelope(responseSnapshot, snapshot.sourceWatermark, health, {
        missingFacts: Array.isArray(reducedSnapshot['missingFacts']) ? reducedSnapshot['missingFacts'] as string[] : [],
        conflicts: Array.isArray(reducedSnapshot['conflicts']) ? reducedSnapshot['conflicts'] as TwinFactConflict[] : [],
        truncated: reducedSnapshot['truncated'] === true,
        nextCursor: typeof reducedSnapshot['nextCursor'] === 'string' ? reducedSnapshot['nextCursor'] : null,
      }));
    }

    const objectMatch = path.match(/^\/api\/context\/v1\/objects\/([^/]+)$/);
    if (objectMatch) {
      const entity = store.getByBusinessObjectId(decode(objectMatch[1]!));
      if (!entity) return sendJson(res, 404, { error: 'Context 业务对象不存在', code: 'NOT_FOUND' });
      const model = snapshotReadModel(store, entity.id, session, 2, 'web_context_object_read');
      return sendJson(res, 200, graphEnvelope(model, health));
    }

    const neighborhoodMatch = path.match(/^\/api\/context\/v1\/entities\/([^/]+)\/neighborhood$/);
    if (neighborhoodMatch) {
      const entityId = decode(neighborhoodMatch[1]!);
      if (!store.getEntity(entityId)) return sendJson(res, 404, { error: 'Context 实体不存在', code: 'NOT_FOUND' });
      const url = new URL(req.url ?? path, 'http://127.0.0.1');
      const depthText = url.searchParams.get('depth') ?? '1';
      if (depthText !== '1' && depthText !== '2') throw new Error('Context depth 必须是 1 或 2');
      const model = snapshotReadModel(store, entityId, session, Number(depthText) as 1 | 2, 'web_context_neighborhood_read');
      const include = new Set((url.searchParams.get('include') ?? 'evidence,agent_events').split(',').filter(Boolean));
      for (const value of include) if (!['evidence', 'agent_events'].includes(value)) throw new Error('Context include 不受支持');
      if (!include.has('evidence')) model['evidence'] = [];
      if (!include.has('agent_events')) model['agentEvents'] = [];
      return sendJson(res, 200, graphEnvelope(model, health));
    }

    const entityMatch = path.match(/^\/api\/context\/v1\/entities\/([^/]+)$/);
    if (entityMatch) {
      const entityId = decode(entityMatch[1]!);
      if (!store.getEntity(entityId)) return sendJson(res, 404, { error: 'Context 实体不存在', code: 'NOT_FOUND' });
      const model = snapshotReadModel(store, entityId, session, 1, 'web_context_entity_read');
      return sendJson(res, 200, graphEnvelope(model, health, model['root']));
    }
    return sendJson(res, 404, { error: 'Context 路由不存在', code: 'NOT_FOUND' });
  } catch (error) {
    return responseForError(res, error);
  }
}
