import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import { redactSensitive } from './http-errors.js';

export type SecuritySeverity = 'info' | 'warning' | 'critical';
export type SecurityResolutionStatus = 'open' | 'accepted_risk' | 'resolved';
export type SecurityIncidentStatus = SecurityResolutionStatus | 'mixed';

export class SecurityEventResolutionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'VERSION_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'SecurityEventResolutionError';
  }
}

export interface SecurityEventInput {
  tenantId?: string;
  eventType: 'origin_denied' | 'authentication_failed' | 'authorization_denied' | 'invalid_webhook_signature' | 'internal_callback_denied' | 'supplier_email_identity_rejected';
  severity: SecuritySeverity;
  requestId: string;
  method: string;
  path: string;
  actorId?: string;
  message: string;
}

export interface SecurityIncidentView {
  incidentKey: string;
  eventType: string;
  severity: SecuritySeverity;
  requestId: string;
  method: string;
  path: string;
  actorId?: string;
  message: string;
  rawEventCount: number;
  eventSeqs: number[];
  firstSeenAt: string;
  lastSeenAt: string;
  version: string;
  resolution: {
    status: SecurityIncidentStatus;
    reason?: string;
    actorId?: string;
    updatedAt?: string;
  };
  related?: {
    providerUid: string;
    poNumber: string;
    reasonCode: string;
    attempts: number;
    firstSeenAt: string;
    lastSeenAt: string;
    nextAttemptAt?: string;
    supplierId?: string;
    supplierName?: string;
    expectedEmails: string[];
    observedSender?: string;
    observedSenderAvailable: boolean;
  };
}

export interface RuntimeHealthSnapshot {
  status?: string;
  workerObserved?: boolean;
  pollerCount?: number;
  error?: string;
}

export interface ConnectorHealthSnapshot {
  id: string;
  status?: string;
  runtime?: string;
  runtimeHealthy?: boolean;
  externalVerified?: boolean;
  credentialReady?: boolean;
}

export interface AttachmentStorageHealthSnapshot {
  backend: 'sqlite' | 's3';
  configured: boolean;
  status: 'local' | 'configured_unverified' | 'ready' | 'unavailable';
  integrityVerification: boolean;
  encryption: string;
}

export interface MalwareScannerHealthSnapshot {
  engine: 'clamd' | 'clamscan';
  configured: boolean;
  status: 'configured_unverified' | 'ready' | 'not_observed' | 'unavailable';
}

/**
 * Report scanner readiness from an observed terminal scan, not merely from the
 * presence of a binary or daemon configuration. Pending scans describe files,
 * not scanner health, so only clean/quarantined/failed observations take part.
 */
export function observedMalwareScannerHealth(
  db: DatabaseSync,
  tenantId: string,
  engine: MalwareScannerHealthSnapshot['engine'],
  configured: boolean,
): MalwareScannerHealthSnapshot {
  if (!configured) return { engine, configured: false, status: 'not_observed' };
  const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='procurement_attachment_audit'").get() as { present: number } | undefined;
  if (!table) return { engine, configured: true, status: 'configured_unverified' };
  const row = db.prepare(`SELECT action FROM procurement_attachment_audit
    WHERE tenant_id=? AND action IN ('malware_scan_clean','malware_quarantined','malware_scan_failed')
    ORDER BY created_at DESC,id DESC LIMIT 1`).get(tenantId) as { action: string } | undefined;
  if (!row) return { engine, configured: true, status: 'configured_unverified' };
  return {
    engine,
    configured: true,
    status: row.action === 'malware_scan_failed' ? 'unavailable' : 'ready',
  };
}

interface CountRow { count: number }

/**
 * 只记录安全判定的最小审计事实。请求头、请求体、Token 和凭据永不进入该表。
 */
export function recordSecurityEvent(db: DatabaseSync | undefined, input: SecurityEventInput): void {
  if (!db) return;
  initializeControlPlaneSchema(db);
  db.prepare(`INSERT INTO control_security_events
    (tenant_id,event_type,severity,request_id,method,path,actor_id,message,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    input.tenantId ?? 'unknown',
    input.eventType,
    input.severity,
    input.requestId.slice(0, 128),
    input.method.slice(0, 16),
    safePath(input.path),
    input.actorId?.slice(0, 200) ?? null,
    redactSensitive(input.message, 500),
    new Date().toISOString(),
  );
}

export function listSecurityEvents(db: DatabaseSync, tenantId: string, limit = 100): Array<Record<string, unknown>> {
  initializeControlPlaneSchema(db);
  return db.prepare(`SELECT e.seq,e.event_type,e.severity,e.request_id,e.method,e.path,e.actor_id,e.message,e.created_at,
      r.status AS resolution_status,r.reason AS resolution_reason,r.actor_id AS resolution_actor_id,
      r.version AS resolution_version,r.created_at AS resolution_created_at,r.updated_at AS resolution_updated_at
    FROM control_security_events e
    LEFT JOIN control_security_event_resolutions r ON r.tenant_id=e.tenant_id AND r.event_seq=e.seq
    WHERE e.tenant_id=? ORDER BY e.seq DESC LIMIT ?`)
    .all(tenantId, Math.min(500, Math.max(1, Math.trunc(limit))))
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        seq: row['seq'], eventType: row['event_type'], severity: row['severity'], requestId: row['request_id'],
        method: row['method'], path: row['path'], actorId: row['actor_id'] ?? undefined,
        message: row['message'], createdAt: row['created_at'],
        resolution: {
          status: row['resolution_status'] ?? 'open',
          reason: row['resolution_reason'] ?? undefined,
          actorId: row['resolution_actor_id'] ?? undefined,
          version: Number(row['resolution_version'] ?? 0),
          createdAt: row['resolution_created_at'] ?? undefined,
          updatedAt: row['resolution_updated_at'] ?? undefined,
        },
      };
    });
}

/**
 * Collapse immutable raw events into actionable incidents. A provider request
 * ID is part of the fingerprint, so repeated writes for one IMAP UID become
 * one incident while distinct supplier messages remain independently auditable.
 */
export function listSecurityIncidents(db: DatabaseSync, tenantId: string, limit = 100): SecurityIncidentView[] {
  initializeControlPlaneSchema(db);
  const bounded = Math.min(500, Math.max(1, Math.trunc(limit)));
  const rows = securityIncidentRows(db, tenantId);
  const groups = new Map<string, SecurityIncidentRow[]>();
  for (const row of rows) {
    const key = securityIncidentKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([incidentKey, group]) => securityIncidentView(db, tenantId, incidentKey, group))
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt) || right.incidentKey.localeCompare(left.incidentKey))
    .slice(0, bounded);
}

export function securityIncidentSummary(db: DatabaseSync, tenantId: string): { total: number; open: number; rawEvents: number } {
  const items = listSecurityIncidents(db, tenantId, 500);
  return {
    total: items.length,
    open: items.filter((item) => item.resolution.status === 'open' || item.resolution.status === 'mixed').length,
    rawEvents: items.reduce((sum, item) => sum + item.rawEventCount, 0),
  };
}

export function resolveSecurityIncident(
  db: DatabaseSync,
  input: {
    tenantId: string;
    incidentKey: string;
    status: SecurityResolutionStatus;
    reason: string;
    actorId: string;
    expectedVersion: string;
  },
  now = new Date(),
): { item: SecurityIncidentView; replayed: boolean; updatedEvents: number } {
  initializeControlPlaneSchema(db);
  const incidentKey = input.incidentKey.trim().toLowerCase();
  const reason = input.reason.trim();
  const actorId = input.actorId.trim();
  if (!/^[a-f0-9]{40}$/.test(incidentKey)) throw new SecurityEventResolutionError('INVALID_INPUT', '安全事故编号无效');
  if (!['open', 'accepted_risk', 'resolved'].includes(input.status)) throw new SecurityEventResolutionError('INVALID_INPUT', '处置状态无效');
  if (reason.length < 5 || reason.length > 500) throw new SecurityEventResolutionError('INVALID_INPUT', '处置依据需为 5–500 个字符');
  if (!actorId || actorId.length > 200) throw new SecurityEventResolutionError('INVALID_INPUT', '处置人无效');
  if (!/^[a-f0-9]{64}$/.test(input.expectedVersion)) throw new SecurityEventResolutionError('INVALID_INPUT', 'expectedVersion 无效');

  const group = securityIncidentRows(db, input.tenantId).filter((row) => securityIncidentKey(row) === incidentKey);
  if (!group.length) throw new SecurityEventResolutionError('NOT_FOUND', '安全事故不存在');
  const currentVersion = securityIncidentVersion(group);
  const exactReplay = group.every((row) => (row.resolution_status ?? 'open') === input.status
    && row.resolution_reason === reason && row.resolution_actor_id === actorId);
  if (currentVersion !== input.expectedVersion) {
    if (!exactReplay) throw new SecurityEventResolutionError('VERSION_CONFLICT', '安全事故已被其他管理员或新事件更新，请刷新后重试');
    return { item: securityIncidentView(db, input.tenantId, incidentKey, group), replayed: true, updatedEvents: 0 };
  }

  const timestamp = now.toISOString();
  let updatedEvents = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of group) {
      const currentStatus = String(row.resolution_status ?? 'open');
      if (currentStatus === input.status && row.resolution_reason === reason && row.resolution_actor_id === actorId) continue;
      const nextVersion = Number(row.resolution_version ?? 0) + 1;
      db.prepare(`INSERT INTO control_security_event_resolutions
        (tenant_id,event_seq,status,reason,actor_id,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(tenant_id,event_seq) DO UPDATE SET
          status=excluded.status,reason=excluded.reason,actor_id=excluded.actor_id,
          version=excluded.version,updated_at=excluded.updated_at`).run(
        input.tenantId, row.seq, input.status, reason, actorId, nextVersion,
        row.resolution_created_at ?? timestamp, timestamp,
      );
      db.prepare(`INSERT INTO control_security_event_resolution_audit
        (tenant_id,event_seq,from_status,to_status,reason,actor_id,version,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(input.tenantId, row.seq, currentStatus, input.status, reason, actorId, nextVersion, timestamp);
      updatedEvents += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  const refreshed = securityIncidentRows(db, input.tenantId).filter((row) => securityIncidentKey(row) === incidentKey);
  return { item: securityIncidentView(db, input.tenantId, incidentKey, refreshed), replayed: false, updatedEvents };
}

/**
 * A previously rejected message that later passes the same tenant/PO/supplier
 * identity checks is authoritative proof that the rejection's root cause has
 * been remediated. Preserve every raw event and append a connector-authored
 * resolution instead of leaving a stale release blocker for an operator to
 * dismiss manually.
 */
export function resolveSupplierEmailIdentityIncidentsAfterSuccessfulIngest(
  db: DatabaseSync,
  tenantId: string,
  providerUid: string,
  now = new Date(),
): { incidents: number; events: number } {
  initializeControlPlaneSchema(db);
  const requestId = `imap:${providerUid.trim()}`;
  const groups = new Map<string, SecurityIncidentRow[]>();
  for (const row of securityIncidentRows(db, tenantId)) {
    if (row.event_type !== 'supplier_email_identity_rejected' || row.request_id !== requestId) continue;
    const key = securityIncidentKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  let incidents = 0;
  let events = 0;
  for (const [incidentKey, rows] of groups) {
    const current = securityIncidentView(db, tenantId, incidentKey, rows);
    if (current.resolution.status === 'resolved') continue;
    const result = resolveSecurityIncident(db, {
      tenantId,
      incidentKey,
      status: 'resolved',
      reason: '同一 IMAP 邮件已通过供应商身份校验并成功写入采购证据链',
      actorId: 'connector:email',
      expectedVersion: current.version,
    }, now);
    incidents += 1;
    events += result.updatedEvents;
  }
  return { incidents, events };
}

/**
 * Some providers copy outbound messages into INBOX. A message whose parsed
 * From address exactly matches the verified mailbox is buyer-authored
 * evidence, never a supplier reply. Raw events remain immutable and receive
 * an append-only connector-authored resolution.
 */
export function resolveSupplierEmailIdentityIncidentsForMailboxSelfSender(
  db: DatabaseSync,
  input: {
    tenantId: string;
    providerUid: string;
    observedSender: string;
    mailboxAddress: string;
  },
  now = new Date(),
): { matched: boolean; incidents: number; events: number } {
  const observed = normalizedEmailAddress(input.observedSender);
  const mailbox = normalizedEmailAddress(input.mailboxAddress);
  if (!observed || !mailbox || observed !== mailbox) return { matched: false, incidents: 0, events: 0 };
  initializeControlPlaneSchema(db);
  const requestId = `imap:${input.providerUid.trim()}`;
  const groups = new Map<string, SecurityIncidentRow[]>();
  for (const row of securityIncidentRows(db, input.tenantId)) {
    if (row.event_type !== 'supplier_email_identity_rejected' || row.request_id !== requestId) continue;
    const key = securityIncidentKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  let incidents = 0;
  let events = 0;
  for (const [incidentKey, rows] of groups) {
    const current = securityIncidentView(db, input.tenantId, incidentKey, rows);
    if (current.resolution.status === 'resolved') continue;
    const result = resolveSecurityIncident(db, {
      tenantId: input.tenantId,
      incidentKey,
      status: 'resolved',
      reason: '邮件 From 与已验证采购邮箱身份一致，确认为本方发件副本，未作为供应商回复处理',
      actorId: 'connector:email',
      expectedVersion: current.version,
    }, now);
    incidents += 1;
    events += result.updatedEvents;
  }
  return { matched: true, incidents, events };
}

export function resolveSecurityEvent(
  db: DatabaseSync,
  input: {
    tenantId: string;
    eventSeq: number;
    status: SecurityResolutionStatus;
    reason: string;
    actorId: string;
    expectedVersion: number;
  },
  now = new Date(),
): { item: Record<string, unknown>; replayed: boolean } {
  initializeControlPlaneSchema(db);
  const eventSeq = Math.trunc(input.eventSeq);
  const expectedVersion = Math.trunc(input.expectedVersion);
  const reason = input.reason.trim();
  const actorId = input.actorId.trim();
  if (!Number.isInteger(eventSeq) || eventSeq <= 0) throw new SecurityEventResolutionError('INVALID_INPUT', '安全告警编号无效');
  if (!['open', 'accepted_risk', 'resolved'].includes(input.status)) throw new SecurityEventResolutionError('INVALID_INPUT', '处置状态无效');
  if (reason.length < 5 || reason.length > 500) throw new SecurityEventResolutionError('INVALID_INPUT', '处置依据需为 5–500 个字符');
  if (!actorId || actorId.length > 200) throw new SecurityEventResolutionError('INVALID_INPUT', '处置人无效');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new SecurityEventResolutionError('INVALID_INPUT', 'expectedVersion 无效');
  const event = db.prepare('SELECT seq FROM control_security_events WHERE tenant_id=? AND seq=?').get(input.tenantId, eventSeq);
  if (!event) throw new SecurityEventResolutionError('NOT_FOUND', '安全告警不存在');
  const timestamp = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare(`SELECT status,reason,actor_id,version,created_at,updated_at
      FROM control_security_event_resolutions WHERE tenant_id=? AND event_seq=?`).get(input.tenantId, eventSeq) as Record<string, unknown> | undefined;
    const currentVersion = Number(current?.['version'] ?? 0);
    if (currentVersion !== expectedVersion) {
      const exactReplay = currentVersion === expectedVersion + 1
        && current?.['status'] === input.status
        && current?.['reason'] === reason
        && current?.['actor_id'] === actorId;
      if (!exactReplay) throw new SecurityEventResolutionError('VERSION_CONFLICT', '安全告警已被其他管理员更新，请刷新后重试');
      db.exec('COMMIT');
      return { item: listSecurityEvents(db, input.tenantId, 500).find((item) => item['seq'] === eventSeq)!, replayed: true };
    }
    const nextVersion = currentVersion + 1;
    const fromStatus = String(current?.['status'] ?? 'open');
    db.prepare(`INSERT INTO control_security_event_resolutions
      (tenant_id,event_seq,status,reason,actor_id,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,event_seq) DO UPDATE SET
        status=excluded.status,reason=excluded.reason,actor_id=excluded.actor_id,
        version=excluded.version,updated_at=excluded.updated_at`).run(
      input.tenantId, eventSeq, input.status, reason, actorId, nextVersion,
      String(current?.['created_at'] ?? timestamp), timestamp,
    );
    db.prepare(`INSERT INTO control_security_event_resolution_audit
      (tenant_id,event_seq,from_status,to_status,reason,actor_id,version,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(input.tenantId, eventSeq, fromStatus, input.status, reason, actorId, nextVersion, timestamp);
    db.exec('COMMIT');
    return { item: listSecurityEvents(db, input.tenantId, 500).find((item) => item['seq'] === eventSeq)!, replayed: false };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** 聚合持久队列、副作用、连接器和安全审计，供管理员判断是否可安全自动运行。 */
export function productionReadiness(
  db: DatabaseSync,
  tenantId: string,
  runtime: RuntimeHealthSnapshot,
  connectors: ConnectorHealthSnapshot[],
  now = new Date(),
  attachmentStorage: AttachmentStorageHealthSnapshot = {
    backend: 'sqlite', configured: false, status: 'local', integrityVerification: true, encryption: 'database-file-controls',
  },
  malwareScanner: MalwareScannerHealthSnapshot = {
    engine: 'clamscan', configured: false, status: 'not_observed',
  },
): Record<string, unknown> {
  initializeControlPlaneSchema(db);
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - 15 * 60_000).toISOString();
  const sinceIso = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();

  const actionCounts = groupedCounts(db, 'SELECT status, COUNT(*) AS count FROM action_executions WHERE tenant_id=? GROUP BY status', tenantId);
  const outboxCounts = groupedCounts(db, 'SELECT status, COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=? GROUP BY status', tenantId);
  // V1 production readiness only reflects deployed/shadow execution. Editor
  // simulations deliberately block side effects and may be retained forever as
  // design/audit evidence, so a failed simulation is not a production dead
  // letter. Keep the count visible separately without degrading the worker.
  const runCounts = groupedCounts(db, `SELECT status, COUNT(*) AS count FROM control_workflow_runs
    WHERE tenant_id=? AND mode<>'simulate' GROUP BY status`, tenantId);
  const failedSimulations = scalar(db, `SELECT COUNT(*) AS count FROM control_workflow_runs
    WHERE tenant_id=? AND mode='simulate' AND status='failed'`, tenantId);
  const documentJobCounts = groupedCounts(db, 'SELECT status, COUNT(*) AS count FROM procurement_document_jobs WHERE tenant_id=? GROUP BY status', tenantId);
  const documentSecurityCounts = groupedCounts(db, 'SELECT security_status AS status, COUNT(*) AS count FROM procurement_attachments WHERE tenant_id=? AND status=\'active\' GROUP BY security_status', tenantId);
  const expiredLeases = scalar(db, `SELECT COUNT(*) AS count FROM action_executions
    WHERE tenant_id=? AND status IN ('pending','recovering') AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`, tenantId, nowIso);
  const expiredOutboxLeases = scalar(db, `SELECT COUNT(*) AS count FROM procurement_outbox
    WHERE tenant_id=? AND status='processing' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`, tenantId, nowIso);
  const staleRuns = scalar(db, `SELECT COUNT(*) AS count FROM control_workflow_runs
    WHERE tenant_id=? AND mode<>'simulate' AND status IN ('queued','running') AND updated_at<=?`, tenantId, staleIso);
  const expiredDocumentLeases = scalar(db, `SELECT COUNT(*) AS count FROM procurement_document_jobs
    WHERE tenant_id=? AND status='processing' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`, tenantId, nowIso);
  const connectorFailures24h = scalar(db, `SELECT COUNT(*) AS count FROM control_connector_events
    WHERE tenant_id=? AND created_at>=? AND lower(status) IN ('failed','error','unhealthy','denied')`, tenantId, sinceIso);
  const securityWarnings24h = scalar(db, `SELECT COUNT(*) AS count FROM control_security_events e
    LEFT JOIN control_security_event_resolutions r ON r.tenant_id=e.tenant_id AND r.event_seq=e.seq
    WHERE e.tenant_id=? AND e.created_at>=? AND e.severity IN ('warning','critical')
      AND COALESCE(r.status,'open')='open'`, tenantId, sinceIso);
  const securityAccepted24h = scalar(db, `SELECT COUNT(*) AS count FROM control_security_events e
    JOIN control_security_event_resolutions r ON r.tenant_id=e.tenant_id AND r.event_seq=e.seq
    WHERE e.tenant_id=? AND e.created_at>=? AND e.severity IN ('warning','critical') AND r.status='accepted_risk'`, tenantId, sinceIso);
  const securityResolved24h = scalar(db, `SELECT COUNT(*) AS count FROM control_security_events e
    JOIN control_security_event_resolutions r ON r.tenant_id=e.tenant_id AND r.event_seq=e.seq
    WHERE e.tenant_id=? AND e.created_at>=? AND e.severity IN ('warning','critical') AND r.status='resolved'`, tenantId, sinceIso);
  const credentialFailures = scalar(db, `SELECT COUNT(*) AS count FROM control_credentials
    WHERE tenant_id=? AND status='failed'`, tenantId);
  const isolatedConnectors = connectors.filter((item) => item.runtime === 'local_process' || item.runtime === 'remote_http' || item.runtime === 'serverless').length;
  const connected = connectors.filter((item) => item.externalVerified).length;
  const unhealthy = connectors.filter((item) => item.status === 'installed' && item.runtimeHealthy === false).length;
  const workerReady = runtime.status === 'ready' && runtime.workerObserved !== false && Number(runtime.pollerCount ?? 0) > 0;
  const manualReconciliation = actionCounts['manual_reconciliation'] ?? 0;
  const failedActions = actionCounts['failed'] ?? 0;
  const retryingActions = actionCounts['retryable_failed'] ?? 0;
  const deadLetter = runCounts['failed'] ?? 0;
  const outboxFailed = outboxCounts['failed'] ?? 0;
  const outboxBlocked = outboxCounts['blocked'] ?? 0;
  const documentJobsFailed = documentJobCounts['failed'] ?? 0;
  const pendingDocumentScans = documentSecurityCounts['pending_scan'] ?? 0;
  const quarantinedDocuments = documentSecurityCounts['quarantined'] ?? 0;
  const failedDocumentScans = documentSecurityCounts['scan_failed'] ?? 0;
  const critical = !workerReady || expiredLeases > 0 || expiredOutboxLeases > 0 || expiredDocumentLeases > 0 || staleRuns > 0 || unhealthy > 0;
  const degraded = critical || deadLetter > 0 || manualReconciliation > 0 || failedActions > 0 || outboxFailed > 0 || outboxBlocked > 0 || connectorFailures24h > 0 || credentialFailures > 0
    || documentJobsFailed > 0 || pendingDocumentScans > 0 || quarantinedDocuments > 0 || failedDocumentScans > 0 || securityWarnings24h > 0;

  return {
    status: critical ? 'critical' : degraded ? 'degraded' : 'ready',
    checkedAt: nowIso,
    queue: {
      engine: 'temporal', durable: true, workerReady, pollerCount: Number(runtime.pollerCount ?? 0),
      queued: runCounts['queued'] ?? 0, running: runCounts['running'] ?? 0,
      waitingApproval: runCounts['waiting_approval'] ?? 0, waitingExternal: runCounts['waiting_external'] ?? 0,
      deadLetter, staleRuns, failedSimulations,
      retryPolicy: { maximumAttempts: 3, initialIntervalMs: 1_000, maximumIntervalMs: 10_000, activityTimeoutMs: 120_000 },
    },
    sideEffects: {
      pending: actionCounts['pending'] ?? 0, retrying: retryingActions, completed: actionCounts['completed'] ?? 0,
      failed: failedActions, manualReconciliation, expiredLeases,
      safety: 'tenant-scoped-idempotency-and-leases',
    },
    outbox: {
      pending: outboxCounts['pending'] ?? 0, processing: outboxCounts['processing'] ?? 0,
      dispatched: outboxCounts['dispatched'] ?? 0, blocked: outboxBlocked, failed: outboxFailed,
      expiredLeases: expiredOutboxLeases, retry: 'exponential-safe-before-dispatch-only',
    },
    documents: {
      queued: documentJobCounts['queued'] ?? 0, processing: documentJobCounts['processing'] ?? 0,
      completed: documentJobCounts['completed'] ?? 0, failed: documentJobsFailed, expiredLeases: expiredDocumentLeases,
      pendingMalwareScan: pendingDocumentScans, quarantined: quarantinedDocuments, scanFailed: failedDocumentScans,
      externalSendGate: 'requires-security-status-clean',
      storage: attachmentStorage,
      malwareScanner,
    },
    connectors: {
      total: connectors.length, connected, unhealthy, isolated: isolatedConnectors,
      isolation: 'credential-vault-and-adapter-boundary', failures24h: connectorFailures24h, credentialFailures,
    },
    security: {
      monitoring: true, warnings24h: securityWarnings24h, openWarnings24h: securityWarnings24h,
      acceptedRisk24h: securityAccepted24h, resolved24h: securityResolved24h,
      controls: ['origin-allowlist', 'signed-session', 'role-permissions', 'tenant-isolation', 'signed-webhook', 'redacted-errors'],
    },
    alerts: [
      ...(!workerReady ? ['Temporal Worker/Poller 未就绪'] : []),
      ...(deadLetter > 0 ? [`${deadLetter} 个工作流运行已进入死信 / 终态失败`] : []),
      ...(expiredLeases > 0 ? [`${expiredLeases} 个副作用租约已过期`] : []),
      ...(expiredOutboxLeases > 0 ? [`${expiredOutboxLeases} 个 Outbox 派发租约已过期`] : []),
      ...(expiredDocumentLeases > 0 ? [`${expiredDocumentLeases} 个文档解析租约已过期`] : []),
      ...(staleRuns > 0 ? [`${staleRuns} 个运行超过 15 分钟未更新`] : []),
      ...(manualReconciliation > 0 ? [`${manualReconciliation} 个外部动作等待人工对账`] : []),
      ...(outboxBlocked > 0 ? [`${outboxBlocked} 个 Outbox 消息因连接器未配置被阻断`] : []),
      ...(outboxFailed > 0 ? [`${outboxFailed} 个 Outbox 消息已进入终态失败`] : []),
      ...(unhealthy > 0 ? [`${unhealthy} 个已安装连接器运行异常`] : []),
      ...(credentialFailures > 0 ? [`${credentialFailures} 个连接凭据校验失败`] : []),
      ...(documentJobsFailed > 0 ? [`${documentJobsFailed} 个文档任务已进入终态失败`] : []),
      ...(pendingDocumentScans > 0 ? [`${pendingDocumentScans} 个附件待恶意软件扫描，已阻止外发`] : []),
      ...(quarantinedDocuments > 0 ? [`${quarantinedDocuments} 个附件已隔离`] : []),
      ...(failedDocumentScans > 0 ? [`${failedDocumentScans} 个附件安全扫描失败`] : []),
      ...(securityWarnings24h > 0 ? [`24 小时内 ${securityWarnings24h} 个安全告警`] : []),
    ],
  };
}

function groupedCounts(db: DatabaseSync, sql: string, tenantId: string): Record<string, number> {
  const rows = db.prepare(sql).all(tenantId) as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

interface SecurityIncidentRow {
  seq: number;
  event_type: string;
  severity: SecuritySeverity;
  request_id: string;
  method: string;
  path: string;
  actor_id: string | null;
  message: string;
  created_at: string;
  resolution_status: SecurityResolutionStatus | null;
  resolution_reason: string | null;
  resolution_actor_id: string | null;
  resolution_version: number | null;
  resolution_created_at: string | null;
  resolution_updated_at: string | null;
}

function securityIncidentRows(db: DatabaseSync, tenantId: string): SecurityIncidentRow[] {
  return db.prepare(`SELECT e.seq,e.event_type,e.severity,e.request_id,e.method,e.path,e.actor_id,e.message,e.created_at,
      r.status AS resolution_status,r.reason AS resolution_reason,r.actor_id AS resolution_actor_id,
      r.version AS resolution_version,r.created_at AS resolution_created_at,r.updated_at AS resolution_updated_at
    FROM control_security_events e
    LEFT JOIN control_security_event_resolutions r ON r.tenant_id=e.tenant_id AND r.event_seq=e.seq
    WHERE e.tenant_id=? ORDER BY e.seq DESC`)
    .all(tenantId) as unknown as SecurityIncidentRow[];
}

function securityIncidentKey(row: Pick<SecurityIncidentRow, 'event_type' | 'request_id' | 'method' | 'path' | 'message'>): string {
  return createHash('sha1').update(JSON.stringify([row.event_type, row.request_id, row.method, row.path, row.message])).digest('hex');
}

function securityIncidentVersion(rows: SecurityIncidentRow[]): string {
  const projection = [...rows]
    .sort((left, right) => left.seq - right.seq)
    .map((row) => [row.seq, row.resolution_status ?? 'open', Number(row.resolution_version ?? 0)]);
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

function securityIncidentView(
  db: DatabaseSync,
  tenantId: string,
  incidentKey: string,
  rows: SecurityIncidentRow[],
): SecurityIncidentView {
  const ordered = [...rows].sort((left, right) => left.seq - right.seq);
  const first = ordered[0]!;
  const statuses = new Set(ordered.map((row) => row.resolution_status ?? 'open'));
  const status: SecurityIncidentStatus = statuses.size === 1 ? [...statuses][0]! : 'mixed';
  const latestResolution = [...ordered]
    .filter((row) => row.resolution_updated_at)
    .sort((left, right) => String(right.resolution_updated_at).localeCompare(String(left.resolution_updated_at)))[0];
  const sameResolution = status !== 'mixed' && ordered.every((row) =>
    row.resolution_reason === first.resolution_reason && row.resolution_actor_id === first.resolution_actor_id);
  const related = first.event_type === 'supplier_email_identity_rejected'
    ? supplierEmailIncidentEvidence(db, tenantId, first.request_id)
    : undefined;
  return {
    incidentKey,
    eventType: first.event_type,
    severity: ordered.some((row) => row.severity === 'critical') ? 'critical'
      : ordered.some((row) => row.severity === 'warning') ? 'warning' : 'info',
    requestId: first.request_id,
    method: first.method,
    path: first.path,
    ...(first.actor_id ? { actorId: first.actor_id } : {}),
    message: first.message,
    rawEventCount: ordered.length,
    eventSeqs: ordered.map((row) => row.seq),
    firstSeenAt: ordered[0]!.created_at,
    lastSeenAt: ordered.at(-1)!.created_at,
    version: securityIncidentVersion(ordered),
    resolution: {
      status,
      ...(sameResolution && first.resolution_reason ? { reason: first.resolution_reason } : {}),
      ...(sameResolution && first.resolution_actor_id ? { actorId: first.resolution_actor_id } : {}),
      ...(latestResolution?.resolution_updated_at ? { updatedAt: latestResolution.resolution_updated_at } : {}),
    },
    ...(related ? { related } : {}),
  };
}

function supplierEmailIncidentEvidence(
  db: DatabaseSync,
  tenantId: string,
  requestId: string,
): SecurityIncidentView['related'] | undefined {
  if (!requestId.startsWith('imap:')) return undefined;
  const providerUid = requestId.slice('imap:'.length);
  const rejection = db.prepare(`SELECT provider_uid,observed_sender,po_number,reason_code,attempts,first_seen_at,last_seen_at,next_attempt_at
    FROM procurement_inbound_mail_rejections WHERE tenant_id=? AND provider_uid=?
    ORDER BY last_seen_at DESC LIMIT 1`).get(tenantId, providerUid) as {
      provider_uid: string; observed_sender: string | null; po_number: string; reason_code: string; attempts: number;
      first_seen_at: string; last_seen_at: string; next_attempt_at: string | null;
    } | undefined;
  if (!rejection) return undefined;
  const poRow = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' AND (
      id=? OR external_id=? OR json_extract(json,'$.number')=?
    ) ORDER BY updated_at DESC,id LIMIT 1`).get(tenantId, rejection.po_number, rejection.po_number, rejection.po_number) as { json: string } | undefined;
  let supplierId: string | undefined;
  let supplierName: string | undefined;
  let expectedEmails: string[] = [];
  try {
    const po = poRow ? JSON.parse(poRow.json) as Record<string, unknown> : undefined;
    supplierId = typeof po?.['supplierId'] === 'string' ? po['supplierId'] : undefined;
    if (supplierId) {
      const supplierRow = db.prepare(`SELECT json FROM procurement_documents
        WHERE tenant_id=? AND kind='supplier' AND id=?`).get(tenantId, supplierId) as { json: string } | undefined;
      const supplier = supplierRow ? JSON.parse(supplierRow.json) as Record<string, unknown> : undefined;
      supplierName = typeof supplier?.['name'] === 'string' ? supplier['name'] : undefined;
      const contacts = Array.isArray(supplier?.['contacts']) ? supplier['contacts'] : [];
      expectedEmails = [...new Set(contacts.flatMap((contact) => {
        if (!contact || typeof contact !== 'object' || Array.isArray(contact)) return [];
        const email = (contact as Record<string, unknown>)['email'];
        return typeof email === 'string' && email.trim() ? [email.trim().toLowerCase()] : [];
      }))];
    }
  } catch {
    // Malformed historical business JSON must not prevent incident visibility.
  }
  return {
    providerUid: rejection.provider_uid,
    poNumber: rejection.po_number,
    reasonCode: rejection.reason_code,
    attempts: Number(rejection.attempts),
    firstSeenAt: rejection.first_seen_at,
    lastSeenAt: rejection.last_seen_at,
    ...(rejection.next_attempt_at ? { nextAttemptAt: rejection.next_attempt_at } : {}),
    ...(supplierId ? { supplierId } : {}),
    ...(supplierName ? { supplierName } : {}),
    expectedEmails,
    ...(rejection.observed_sender ? { observedSender: rejection.observed_sender } : {}),
    observedSenderAvailable: Boolean(rejection.observed_sender),
  };
}

function scalar(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  return Number((db.prepare(sql).get(...params) as CountRow | undefined)?.count ?? 0);
}

function safePath(path: string): string {
  // 查询串可能含业务 ID 或临时签名；安全监控只保留路由路径。
  return path.split('?')[0]!.slice(0, 500);
}

function normalizedEmailAddress(value: string): string | undefined {
  const bracketed = /<\s*([^<>]+?)\s*>/.exec(value);
  const candidate = (bracketed?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate) ? candidate : undefined;
}
