import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';
import { redactSensitive } from './http-errors.js';
import { advancedSlaAutoSendDecision, recordAdvancedSlaAutoSendDecision, type AdvancedSlaAutoSendDecisionCode } from './procurement-advanced-sla.js';
import { queueApprovedMessageDraft, refreshSlaDrafts } from './procurement-message-drafts.js';
import { effectiveProcurementTenantPreferences, getProcurementTenantPreferences } from './procurement-tenant-preferences.js';

export interface ProcurementSlaAutomationOptions {
  workerId?: string;
  intervalSeconds?: number;
  leaseDurationMs?: number;
  now?: () => Date;
}

export interface ProcurementSlaAutomationResult {
  tenantId: string;
  status: 'completed' | 'failed' | 'skipped';
  runId?: string;
  reason?: 'no_published_policy' | 'disabled' | 'not_due' | 'lease_held';
  result?: SlaAutomationRunResult;
  error?: string;
  nextRunAt?: string;
}

export interface SlaAutomationRunResult {
  created: number;
  examined: number;
  skippedWithoutRecipient: number;
  autoQueued: number;
  autoBlocked: Array<{ draftId: string; poId: string; decisionCode: AdvancedSlaAutoSendDecisionCode }>;
  manualReview: Array<{ draftId: string; poId: string; reason: string }>;
}

interface AdvancedAutoSendDraftRow {
  id: string;
  version: number;
  purchase_order_id: string;
  channel: 'email' | 'whatsapp';
  stage: 'po_sent' | 'supplier_commitment' | 'fulfilment_production' | 'dispatch_transit' | 'delivery_grn';
  evidence_json: string;
}

interface LeaseRow {
  tenant_id: string;
  enabled: number;
  interval_seconds: number;
  next_run_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_started_at: string | null;
  last_completed_at: string | null;
  last_status: string | null;
  last_result_json: string | null;
  last_error: string | null;
  consecutive_failures: number;
  updated_at: string;
}

export class ProcurementSlaAutomationWorker {
  private readonly workerId: string;
  private readonly intervalSeconds: number;
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;

  constructor(private readonly db: DatabaseSync, options: ProcurementSlaAutomationOptions = {}) {
    this.workerId = options.workerId ?? `procurement-sla:${process.pid}`;
    this.intervalSeconds = boundedInteger(options.intervalSeconds ?? 300, 30, 86_400, 'intervalSeconds');
    this.leaseDurationMs = boundedInteger(options.leaseDurationMs ?? 120_000, 10_000, 3_600_000, 'leaseDurationMs');
    this.now = options.now ?? (() => new Date());
  }

  async runPendingTenants(): Promise<Record<string, ProcurementSlaAutomationResult>> {
    const rows = this.db.prepare(`SELECT DISTINCT tenant_id FROM procurement_sla_policies WHERE status='published'
      UNION
      SELECT DISTINCT d.tenant_id FROM procurement_message_drafts d JOIN procurement_sla_evaluations e
        ON e.tenant_id=d.tenant_id AND e.po_id=d.purchase_order_id
        AND json_extract(d.trigger_evidence_json,'$.slaEvaluationFingerprint')=e.fingerprint
      WHERE d.status='draft' AND e.status IN ('breached','escalated')
      ORDER BY tenant_id`)
      .all() as Array<{ tenant_id: string }>;
    const output: Record<string, ProcurementSlaAutomationResult> = {};
    for (const row of rows) output[row.tenant_id] = await this.runTenant(row.tenant_id);
    return output;
  }

  async runTenant(tenantId: string, options: { force?: boolean; actorId?: string } = {}): Promise<ProcurementSlaAutomationResult> {
    const preferences = effectiveProcurementTenantPreferences(this.db, tenantId);
    if (!preferences.slaEscalationsEnabled) return { tenantId, status: 'skipped', reason: 'disabled' };
    const policy = this.db.prepare("SELECT id FROM procurement_sla_policies WHERE tenant_id=? AND status='published'").get(tenantId) as { id: string } | undefined;
    const existingCandidates = !policy && this.hasExistingAdvancedAutoSendCandidates(tenantId);
    if (!policy && !existingCandidates) return { tenantId, status: 'skipped', reason: 'no_published_policy' };
    const started = this.now();
    const startedAt = started.toISOString();
    const leaseToken = `procurement-sla-lease:${randomUUID()}`;
    const runId = `procurement-sla-run:${randomUUID()}`;
    const leaseExpiresAt = new Date(started.getTime() + this.leaseDurationMs).toISOString();
    let intervalSeconds = this.intervalSeconds;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT OR IGNORE INTO procurement_sla_automation_leases
        (tenant_id,enabled,interval_seconds,next_run_at,consecutive_failures,updated_at)
        VALUES (?,1,?,?,0,?)`).run(tenantId, this.intervalSeconds, startedAt, startedAt);
      const current = this.getLease(tenantId)!;
      intervalSeconds = current.interval_seconds;
      if (current.enabled !== 1) {
        this.db.exec('COMMIT');
        return { tenantId, status: 'skipped', reason: 'disabled', nextRunAt: current.next_run_at };
      }
      if (!options.force && Date.parse(current.next_run_at) > started.getTime()) {
        this.db.exec('COMMIT');
        return { tenantId, status: 'skipped', reason: 'not_due', nextRunAt: current.next_run_at };
      }
      if (current.lease_token && current.lease_expires_at && Date.parse(current.lease_expires_at) > started.getTime()) {
        this.db.exec('COMMIT');
        return { tenantId, status: 'skipped', reason: 'lease_held', nextRunAt: current.next_run_at };
      }
      if (current.lease_token) {
        this.db.prepare(`UPDATE procurement_sla_automation_runs SET status='abandoned',completed_at=?,error=?
          WHERE tenant_id=? AND status='running'`).run(startedAt, '上一个 worker 租约过期；本次运行已接管', tenantId);
      }
      const claimed = this.db.prepare(`UPDATE procurement_sla_automation_leases SET lease_owner=?,lease_token=?,lease_expires_at=?,last_started_at=?,last_status='running',last_error=NULL,updated_at=?
        WHERE tenant_id=? AND enabled=1 AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at<=?)`)
        .run(this.workerId, leaseToken, leaseExpiresAt, startedAt, startedAt, tenantId, startedAt);
      if (Number(claimed.changes) !== 1) {
        this.db.exec('COMMIT');
        return { tenantId, status: 'skipped', reason: 'lease_held', nextRunAt: current.next_run_at };
      }
      this.db.prepare(`INSERT INTO procurement_sla_automation_runs
        (tenant_id,id,worker_id,status,started_at,created_at) VALUES (?,?,?,'running',?,?)`)
        .run(tenantId, runId, this.workerId, startedAt, startedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      rollback(this.db);
      throw error;
    }

    try {
      const identityActive = Boolean(this.db.prepare("SELECT 1 FROM procurement_communication_identities WHERE tenant_id=? AND status='active'").get(tenantId));
      const refreshed = policy && identityActive
        ? refreshSlaDrafts(this.db, tenantId, options.actorId ?? 'ai:procurement-sla', this.now())
        : { created: 0, examined: 0, skippedWithoutRecipient: 0 };
      const result = queueReadyAdvancedSlaDrafts(this.db, tenantId, this.now(), refreshed);
      const completedAt = this.now().toISOString();
      const nextRunAt = new Date(Date.parse(completedAt) + intervalSeconds * 1_000).toISOString();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare(`UPDATE procurement_sla_automation_runs SET status='completed',completed_at=?,result_json=?,error=NULL
          WHERE tenant_id=? AND id=? AND status='running'`).run(completedAt, JSON.stringify(result), tenantId, runId);
        const released = this.db.prepare(`UPDATE procurement_sla_automation_leases SET next_run_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
          last_completed_at=?,last_status='completed',last_result_json=?,last_error=NULL,consecutive_failures=0,updated_at=?
          WHERE tenant_id=? AND lease_token=?`).run(nextRunAt, completedAt, JSON.stringify(result), completedAt, tenantId, leaseToken);
        if (Number(released.changes) !== 1) throw new Error('SLA 自动检查租约在完成前已失效');
        this.db.exec('COMMIT');
      } catch (error) { rollback(this.db); throw error; }
      return { tenantId, status: 'completed', runId, result, nextRunAt };
    } catch (error) {
      const failedAt = this.now().toISOString();
      const message = redactSensitive(error, 500) || 'SLA 自动检查失败';
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.getLease(tenantId);
        const failures = Math.max(1, (current?.consecutive_failures ?? 0) + 1);
        const delaySeconds = Math.min(3_600, intervalSeconds * 2 ** Math.min(5, failures - 1));
        const nextRunAt = new Date(Date.parse(failedAt) + delaySeconds * 1_000).toISOString();
        this.db.prepare(`UPDATE procurement_sla_automation_runs SET status='failed',completed_at=?,error=?
          WHERE tenant_id=? AND id=? AND status='running'`).run(failedAt, message, tenantId, runId);
        this.db.prepare(`UPDATE procurement_sla_automation_leases SET next_run_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
          last_completed_at=?,last_status='failed',last_result_json=NULL,last_error=?,consecutive_failures=?,updated_at=?
          WHERE tenant_id=? AND lease_token=?`).run(nextRunAt, failedAt, message, failures, failedAt, tenantId, leaseToken);
        this.db.exec('COMMIT');
        return { tenantId, status: 'failed', runId, error: message, nextRunAt };
      } catch (finalizeError) { rollback(this.db); throw finalizeError; }
    }
  }

  private getLease(tenantId: string): LeaseRow | undefined {
    return this.db.prepare('SELECT * FROM procurement_sla_automation_leases WHERE tenant_id=?').get(tenantId) as unknown as LeaseRow | undefined;
  }

  private hasExistingAdvancedAutoSendCandidates(tenantId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM procurement_message_drafts d JOIN procurement_sla_evaluations e
      ON e.tenant_id=d.tenant_id AND e.po_id=d.purchase_order_id
      AND json_extract(d.trigger_evidence_json,'$.slaEvaluationFingerprint')=e.fingerprint
      WHERE d.tenant_id=? AND d.status='draft' AND e.status IN ('breached','escalated') LIMIT 1`).get(tenantId));
  }
}

function queueReadyAdvancedSlaDrafts(
  db: DatabaseSync,
  tenantId: string,
  now: Date,
  refreshed: { created: number; examined: number; skippedWithoutRecipient: number },
): SlaAutomationRunResult {
  const output: SlaAutomationRunResult = { ...refreshed, autoQueued: 0, autoBlocked: [], manualReview: [] };
  const rows = db.prepare(`SELECT d.id,d.version,d.purchase_order_id,d.channel,e.stage,e.evidence_json
    FROM procurement_message_drafts d JOIN procurement_sla_evaluations e
      ON e.tenant_id=d.tenant_id AND e.po_id=d.purchase_order_id
      AND json_extract(d.trigger_evidence_json,'$.slaEvaluationFingerprint')=e.fingerprint
    WHERE d.tenant_id=? AND d.status='draft' AND e.status IN ('breached','escalated')
    ORDER BY d.created_at,d.id`).all(tenantId) as unknown as AdvancedAutoSendDraftRow[];
  const timestamp = now.toISOString();
  for (const row of rows) {
    const evidence = parseObject(row.evidence_json) ?? {};
    const risk = evidence['risk'];
    const riskPublicationState = evidence['riskPublicationState'];
    if (riskPublicationState !== 'published' || (risk !== 'high' && risk !== 'medium' && risk !== 'low')) {
      const decision = advancedSlaAutoSendDecision(db, tenantId, { stage: row.stage, channel: row.channel, risk: 'all' });
      const profileId = decision.profileId ?? 'unpublished';
      const profileVersion = decision.profileVersion ?? 0;
      const actorId = `ai:advanced-sla:${profileId}:v${profileVersion}`;
      output.manualReview.push({
        draftId: row.id,
        poId: row.purchase_order_id,
        reason: riskPublicationState === 'published' ? 'candidate_risk_missing' : 'candidate_risk_not_published',
      });
      recordAdvancedSlaAutoSendDecision(db, tenantId, {
        ...decision, draftId: row.id, purchaseOrderId: row.purchase_order_id, decisionCode: 'risk_not_allowed', actorId, timestamp,
      });
      continue;
    }
    const decision = advancedSlaAutoSendDecision(db, tenantId, { stage: row.stage, channel: row.channel, risk });
    const profileId = decision.profileId ?? 'unpublished';
    const profileVersion = decision.profileVersion ?? 0;
    const actorId = `ai:advanced-sla:${profileId}:v${profileVersion}`;
    if (!decision.allowed) {
      output.autoBlocked.push({ draftId: row.id, poId: row.purchase_order_id, decisionCode: decision.reason });
      recordAdvancedSlaAutoSendDecision(db, tenantId, {
        ...decision, draftId: row.id, purchaseOrderId: row.purchase_order_id, decisionCode: decision.reason, actorId, timestamp,
      });
      continue;
    }
    const queued = queueApprovedMessageDraft(db, {
      tenantId, draftId: row.id, expectedVersion: row.version, actorId,
      correlationId: `advanced-sla:${profileId}:v${profileVersion}:${row.id}`,
      credentialId: decision.credentialId,
      connectorReady: () => true,
      onQueuedInTransaction: ({ outbox }) => recordAdvancedSlaAutoSendDecision(db, tenantId, {
        ...decision, draftId: row.id, purchaseOrderId: row.purchase_order_id, decisionCode: decision.reason,
        outboxId: outbox.id, actorId, timestamp,
      }),
      now,
    });
    if (queued.replayed) output.manualReview.push({ draftId: row.id, poId: row.purchase_order_id, reason: 'queue_replayed' });
    else output.autoQueued += 1;
  }
  return output;
}

export interface ProcurementSlaAutomationContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly now?: () => Date;
}

export async function handleProcurementSlaAutomationRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementSlaAutomationContext,
): Promise<boolean> {
  const root = path === '/api/procurement/sla/automation';
  const run = path === '/api/procurement/sla/automation/run';
  if (!root && !run) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  if (root && method === 'GET') {
    if (!can(context.session, 'read')) { sendJson(res, 403, { error: '无读取 SLA 自动化权限', code: 'FORBIDDEN' }); return true; }
    sendJson(res, 200, automationView(context.db, context.session.tenantId, context.now?.() ?? new Date()));
    return true;
  }
  if (run && method === 'POST') {
    if (!can(context.session, 'operate')) { sendJson(res, 403, { error: '无运行 SLA 自动检查权限', code: 'FORBIDDEN' }); return true; }
    try {
      const worker = new ProcurementSlaAutomationWorker(context.db, {
        workerId: `manual:${context.session.humanId}`,
        ...(context.now ? { now: context.now } : {}),
      });
      const result = await worker.runTenant(context.session.tenantId, { force: true, actorId: context.session.humanId });
      sendJson(res, result.status === 'completed' ? 200 : result.status === 'failed' ? 503 : 409, { result, automation: automationView(context.db, context.session.tenantId, context.now?.() ?? new Date()) });
    } catch (error) {
      sendJson(res, 503, { error: redactSensitive(error, 500) || 'SLA 自动检查失败', code: 'SLA_AUTOMATION_FAILED' });
    }
    return true;
  }
  sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
  return true;
}

function automationView(db: DatabaseSync, tenantId: string, now: Date) {
  const policy = db.prepare("SELECT id,version,name FROM procurement_sla_policies WHERE tenant_id=? AND status='published'").get(tenantId) as { id: string; version: number; name: string } | undefined;
  const storedPreferences = getProcurementTenantPreferences(db, tenantId);
  const preferences = effectiveProcurementTenantPreferences(db, tenantId);
  const lease = db.prepare('SELECT * FROM procurement_sla_automation_leases WHERE tenant_id=?').get(tenantId) as unknown as LeaseRow | undefined;
  const runRows = db.prepare(`SELECT id,worker_id,status,started_at,completed_at,result_json,error FROM procurement_sla_automation_runs
    WHERE tenant_id=? ORDER BY started_at DESC,id DESC LIMIT 20`).all(tenantId) as Array<{ id: string; worker_id: string; status: string; started_at: string; completed_at: string | null; result_json: string | null; error: string | null }>;
  const running = Boolean(lease?.lease_token && lease.lease_expires_at && Date.parse(lease.lease_expires_at) > now.getTime());
  return {
    policy: policy ?? null,
    status: !policy ? 'waiting_for_policy' : !preferences.slaEscalationsEnabled ? 'disabled' : running ? 'running' : lease?.last_status === 'failed' ? 'failed' : lease ? 'scheduled' : 'not_started',
    enabled: Boolean(policy && preferences.slaEscalationsEnabled && lease?.enabled !== 0),
    preferenceVersion: storedPreferences?.version ?? null,
    inheritedPreferenceDefault: !storedPreferences,
    intervalSeconds: lease?.interval_seconds ?? null,
    nextRunAt: lease?.next_run_at ?? null,
    leaseExpiresAt: running ? lease?.lease_expires_at ?? null : null,
    lastStartedAt: lease?.last_started_at ?? null,
    lastCompletedAt: lease?.last_completed_at ?? null,
    lastStatus: lease?.last_status ?? null,
    lastResult: parseObject(lease?.last_result_json),
    lastError: lease?.last_error ? redactSensitive(lease.last_error, 500) : null,
    consecutiveFailures: lease?.consecutive_failures ?? 0,
    runs: runRows.map((row) => ({
      id: row.id,
      workerId: row.worker_id,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      result: parseObject(row.result_json),
      error: row.error ? redactSensitive(row.error, 500) : null,
    })),
  };
}

function parseObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; }
  catch { return null; }
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${field} 必须是 ${min}-${max} 的整数`);
  return value;
}

function rollback(db: DatabaseSync): void { try { db.exec('ROLLBACK'); } catch { /* no active transaction */ } }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
