import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  redactSensitive,
  TwinProjectionPayloadConflictError,
  type TwinProjectionJob,
  type TwinProjectionStatus,
} from '@readywork/core';

const RETRY_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 14_400_000] as const;

interface TwinProjectionQueueBinding {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  readonly concrete: boolean;
}

const TWIN_PROJECTION_QUEUE_BINDINGS = new WeakMap<object, TwinProjectionQueueBinding>();

/**
 * Proves that an object is a concrete Queue constructed for this exact SQLite
 * handle and tenant. The binding is module-owned and never exposes the handle.
 */
export function isSqliteTwinProjectionQueueBoundTo(
  value: unknown,
  db: DatabaseSync,
  tenantId: string,
): value is SqliteTwinProjectionQueue {
  if (typeof value !== 'object' || value === null) return false;
  const binding = TWIN_PROJECTION_QUEUE_BINDINGS.get(value);
  return binding?.concrete === true && binding.db === db && binding.tenantId === tenantId;
}

interface ProjectionJobRow {
  tenant_id: string;
  id: string;
  source_table: string;
  source_key: string;
  source_revision: string;
  event_type: string;
  payload_hash: string;
  status: TwinProjectionStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  projected_watermark: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface EnqueueTwinProjectionInput {
  sourceTable: string;
  sourceKey: string;
  sourceRevision: string;
  eventType: string;
  payloadHash: string;
  availableAt: string;
}

export interface ClaimTwinProjectionInput {
  workerId: string;
  claimedAt: string;
  leaseDurationMs: number;
  limit: number;
}

export interface SucceedTwinProjectionInput {
  id: string;
  leaseToken: string;
  completedAt: string;
  projectedWatermark: string;
}

export interface FailTwinProjectionInput {
  id: string;
  leaseToken: string;
  failedAt: string;
  error: unknown;
}

export interface ReplayTwinProjectionInput {
  id: string;
  actorId: string;
  replayedAt: string;
}

export interface TwinProjectionQueueStatus {
  queued: number;
  processing: number;
  retryWait: number;
  succeeded: number;
  deadLetter: number;
}

export function projectionRetryAt(failedAt: string, attempts: number): string | undefined {
  const normalizedFailedAt = requireIsoDate(failedAt, 'failedAt');
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('Twin projection attempts 必须是正整数');
  if (attempts >= 8) return undefined;
  return new Date(Date.parse(normalizedFailedAt) + RETRY_MS[attempts - 1]!).toISOString();
}

function projectionJobFromRow(row: ProjectionJobRow): TwinProjectionJob {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    sourceTable: row.source_table,
    sourceKey: row.source_key,
    sourceRevision: row.source_revision,
    eventType: row.event_type,
    payloadHash: row.payload_hash,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: 8,
    availableAt: row.available_at,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.projected_watermark === null ? {} : { projectedWatermark: row.projected_watermark }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  };
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Twin projection ${field} 不能为空`);
  return value.trim();
}

function requireIsoDate(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (typeof value !== 'string' || !value || !Number.isFinite(parsed)) {
    throw new Error(`Twin projection ${field} 必须是有效时间`);
  }
  return new Date(parsed).toISOString();
}

function withImmediateTransaction<T>(db: DatabaseSync, body: () => T): T {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    if (ownsTransaction) db.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction && db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export class SqliteTwinProjectionQueue {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tenantId: string,
  ) {
    if (!tenantId) throw new Error('Twin projection tenantId 不能为空');
    TWIN_PROJECTION_QUEUE_BINDINGS.set(this, {
      db,
      tenantId,
      concrete: new.target === SqliteTwinProjectionQueue,
    });
  }

  enqueue(input: EnqueueTwinProjectionInput): TwinProjectionJob {
    const sourceTable = requireText(input.sourceTable, 'sourceTable');
    const sourceKey = requireText(input.sourceKey, 'sourceKey');
    const sourceRevision = requireText(input.sourceRevision, 'sourceRevision');
    const eventType = requireText(input.eventType, 'eventType');
    const payloadHash = requireText(input.payloadHash, 'payloadHash');
    const availableAt = requireIsoDate(input.availableAt, 'availableAt');
    const id = `twin:projection-job:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    let conflict = false;
    let result: TwinProjectionJob | undefined;

    withImmediateTransaction(this.db, () => {
      const existing = this.db.prepare(`SELECT * FROM twin_projection_jobs
        WHERE tenant_id=? AND source_table=? AND source_key=? AND source_revision=? AND event_type=?`)
        .get(this.tenantId, sourceTable, sourceKey, sourceRevision, eventType) as unknown as ProjectionJobRow | undefined;
      if (existing) {
        if (existing.payload_hash === payloadHash) {
          result = projectionJobFromRow(existing);
        } else {
          const securityMessage = JSON.stringify({
            jobId: existing.id,
            sourceTable,
            sourceKey,
            sourceRevision,
            eventType,
            existingPayloadHash: existing.payload_hash,
            incomingPayloadHash: payloadHash,
          });
          this.db.prepare(`INSERT INTO control_security_events
            (tenant_id,event_type,severity,request_id,method,path,actor_id,message,created_at)
            VALUES (?,'twin_projection_payload_conflict','warning',?,'ENQUEUE','/twin/projection-jobs',NULL,?,?)`)
            .run(this.tenantId, existing.id.slice(0, 128), securityMessage, createdAt);
          conflict = true;
        }
      } else {
        this.db.prepare(`INSERT INTO twin_projection_jobs
          (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,
           available_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'queued',0,8,?,?,?)`).run(
          this.tenantId, id, sourceTable, sourceKey, sourceRevision, eventType, payloadHash,
          availableAt, createdAt, createdAt,
        );
        result = projectionJobFromRow(this.jobRowOrThrow(id));
      }
    });

    if (conflict) throw new TwinProjectionPayloadConflictError(sourceKey);
    if (!result) throw new Error('Twin projection 任务写入失败');
    return result;
  }

  get(id: string): TwinProjectionJob | undefined {
    const row = this.db.prepare('SELECT * FROM twin_projection_jobs WHERE tenant_id=? AND id=?')
      .get(this.tenantId, id) as unknown as ProjectionJobRow | undefined;
    return row ? projectionJobFromRow(row) : undefined;
  }

  claim(input: ClaimTwinProjectionInput): TwinProjectionJob[] {
    const workerId = requireText(input.workerId, 'workerId');
    const claimedAt = requireIsoDate(input.claimedAt, 'claimedAt');
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new Error('Twin projection leaseDurationMs 必须大于 0');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error('Twin projection limit 必须是正整数');
    }
    const leaseExpiresAt = new Date(Date.parse(claimedAt) + input.leaseDurationMs).toISOString();

    return withImmediateTransaction(this.db, () => {
      this.db.prepare(`UPDATE twin_projection_jobs
        SET status='dead_letter',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            last_error='Twin projection lease expired at maximum attempts',updated_at=?,completed_at=?
        WHERE tenant_id=? AND status='processing' AND attempts>=max_attempts
          AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`).run(
        claimedAt, claimedAt, this.tenantId, claimedAt,
      );
      const candidates = this.db.prepare(`SELECT id FROM twin_projection_jobs
        WHERE tenant_id=? AND attempts<max_attempts AND (
          (status IN ('queued','retry_wait') AND available_at<=?)
          OR (status='processing' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?)
        ) ORDER BY available_at,created_at,id LIMIT ?`)
        .all(this.tenantId, claimedAt, claimedAt, input.limit) as unknown as Array<{ id: string }>;
      const claimed: TwinProjectionJob[] = [];
      for (const candidate of candidates) {
        const leaseToken = `twin-projection-lease:${randomUUID()}`;
        const changed = this.db.prepare(`UPDATE twin_projection_jobs
          SET status='processing',attempts=attempts+1,lease_owner=?,lease_token=?,lease_expires_at=?,updated_at=?
          WHERE tenant_id=? AND id=? AND attempts<max_attempts AND (
            (status IN ('queued','retry_wait') AND available_at<=?)
            OR (status='processing' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?)
          )`).run(
          workerId, leaseToken, leaseExpiresAt, claimedAt,
          this.tenantId, candidate.id, claimedAt, claimedAt,
        );
        if (Number(changed.changes) !== 1) continue;
        claimed.push(projectionJobFromRow(this.jobRowOrThrow(candidate.id)));
      }
      return claimed;
    });
  }

  succeed(input: SucceedTwinProjectionInput): TwinProjectionJob {
    const id = requireText(input.id, 'id');
    const leaseToken = requireText(input.leaseToken, 'leaseToken');
    const completedAt = requireIsoDate(input.completedAt, 'completedAt');
    const projectedWatermark = requireText(input.projectedWatermark, 'projectedWatermark');
    return withImmediateTransaction(this.db, () => {
      const changed = this.db.prepare(`UPDATE twin_projection_jobs
        SET status='succeeded',projected_watermark=?,last_error=NULL,lease_owner=NULL,lease_token=NULL,
            lease_expires_at=NULL,completed_at=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='processing' AND lease_token=?
          AND lease_expires_at IS NOT NULL AND lease_expires_at>?`).run(
        projectedWatermark, completedAt, completedAt,
        this.tenantId, id, leaseToken, completedAt,
      );
      if (Number(changed.changes) !== 1) throw new Error('Twin projection 租约冲突');
      return projectionJobFromRow(this.jobRowOrThrow(id));
    });
  }

  fail(input: FailTwinProjectionInput): TwinProjectionJob {
    const id = requireText(input.id, 'id');
    const leaseToken = requireText(input.leaseToken, 'leaseToken');
    const failedAt = requireIsoDate(input.failedAt, 'failedAt');
    const lastError = redactSensitive(input.error, 500);
    if (!lastError) throw new Error('Twin projection error 不能为空');
    return withImmediateTransaction(this.db, () => {
      const current = this.db.prepare(`SELECT * FROM twin_projection_jobs
        WHERE tenant_id=? AND id=? AND status='processing' AND lease_token=?
          AND lease_expires_at IS NOT NULL AND lease_expires_at>?`)
        .get(this.tenantId, id, leaseToken, failedAt) as unknown as ProjectionJobRow | undefined;
      if (!current) throw new Error('Twin projection 租约冲突');
      const retryAt = projectionRetryAt(failedAt, Number(current.attempts));
      const changed = this.db.prepare(`UPDATE twin_projection_jobs
        SET status=?,available_at=?,last_error=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            updated_at=?,completed_at=NULL
        WHERE tenant_id=? AND id=? AND status='processing' AND lease_token=?
          AND lease_expires_at IS NOT NULL AND lease_expires_at>?`).run(
        retryAt === undefined ? 'dead_letter' : 'retry_wait', retryAt ?? current.available_at, lastError,
        failedAt, this.tenantId, id, leaseToken, failedAt,
      );
      if (Number(changed.changes) !== 1) throw new Error('Twin projection 租约冲突');
      return projectionJobFromRow(this.jobRowOrThrow(id));
    });
  }

  replayDeadLetter(input: ReplayTwinProjectionInput): TwinProjectionJob {
    const id = requireText(input.id, 'id');
    const actorId = requireText(input.actorId, 'actorId');
    const replayedAt = requireIsoDate(input.replayedAt, 'replayedAt');
    return withImmediateTransaction(this.db, () => {
      const previous = this.db.prepare(`SELECT * FROM twin_projection_jobs
        WHERE tenant_id=? AND id=? AND status='dead_letter'`)
        .get(this.tenantId, id) as unknown as ProjectionJobRow | undefined;
      if (!previous) throw new Error('Twin projection 死信不存在或状态不允许重放');
      const changed = this.db.prepare(`UPDATE twin_projection_jobs
        SET status='queued',attempts=0,available_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
            completed_at=NULL,updated_at=?
        WHERE tenant_id=? AND id=? AND status='dead_letter'`).run(
        replayedAt, replayedAt, this.tenantId, id,
      );
      if (Number(changed.changes) !== 1) throw new Error('Twin projection 死信不存在或状态不允许重放');
      const job = projectionJobFromRow(this.jobRowOrThrow(id));
      const activity = {
        id: `activity:${randomUUID()}`,
        at: replayedAt,
        objectId: id,
        actor: actorId,
        action: 'twin.projection_replayed',
        summary: 'Twin projection dead letter replayed',
        context: { attempts: job.attempts, previousAttempts: Number(previous.attempts), previousStatus: 'dead_letter' },
      };
      this.db.prepare(`INSERT INTO runtime_activities
        (tenant_id,id,object_id,json,updated_at) VALUES (?,?,?,?,?)`)
        .run(this.tenantId, activity.id, id, JSON.stringify(activity), replayedAt);
      return job;
    });
  }

  status(): TwinProjectionQueueStatus {
    const rows = this.db.prepare(`SELECT status,COUNT(*) AS count FROM twin_projection_jobs
      WHERE tenant_id=? GROUP BY status`).all(this.tenantId) as unknown as Array<{
        status: TwinProjectionStatus;
        count: number;
      }>;
    const counts: Record<TwinProjectionStatus, number> = {
      queued: 0,
      processing: 0,
      retry_wait: 0,
      succeeded: 0,
      dead_letter: 0,
    };
    for (const row of rows) counts[row.status] = Number(row.count);
    return {
      queued: counts.queued,
      processing: counts.processing,
      retryWait: counts.retry_wait,
      succeeded: counts.succeeded,
      deadLetter: counts.dead_letter,
    };
  }

  private jobRowOrThrow(id: string): ProjectionJobRow {
    const row = this.db.prepare('SELECT * FROM twin_projection_jobs WHERE tenant_id=? AND id=?')
      .get(this.tenantId, id) as unknown as ProjectionJobRow | undefined;
    if (!row) throw new Error('Twin projection 任务不存在或不属于当前租户');
    return row;
  }
}
