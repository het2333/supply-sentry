import type { DatabaseSync } from 'node:sqlite';
import {
  procurementV1Readiness,
  type ProcurementV1ReadinessView,
} from './procurement-v1-readiness.js';

export interface ManufacturingContextRuntimeReadiness {
  workerReady: boolean;
  lastHeartbeatAt: string | null;
  pollIntervalMs: number;
}

export const MANUFACTURING_CONTEXT_HEARTBEAT_FUTURE_SKEW_MS = 5_000;

function requiredText(value: string, label: string): string {
  if (!value.trim()) throw new Error(`Manufacturing Context ${label} 不能为空`);
  return value.trim();
}

function canonicalInstant(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Manufacturing Context heartbeat 必须是有效时间');
  return new Date(parsed).toISOString();
}

function trustedNowInstant(now: Date): { milliseconds: number; iso: string } {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('Manufacturing Context now 必须是有效时间');
  return { milliseconds, iso: new Date(milliseconds).toISOString() };
}

/** One UPSERT is the atomic publication boundary for a successful business-side poll. */
export function recordManufacturingContextHeartbeat(
  db: DatabaseSync,
  input: {
    tenantId: string;
    workerId: string;
    workerReady: boolean;
    lastHeartbeatAt: string;
    pollIntervalMs: number;
  },
  now = new Date(),
): ManufacturingContextRuntimeReadiness {
  const tenantId = requiredText(input.tenantId, 'tenantId');
  const workerId = requiredText(input.workerId, 'workerId');
  const lastHeartbeatAt = canonicalInstant(input.lastHeartbeatAt);
  const trustedNow = trustedNowInstant(now);
  if (Date.parse(lastHeartbeatAt) > trustedNow.milliseconds + MANUFACTURING_CONTEXT_HEARTBEAT_FUTURE_SKEW_MS) {
    throw new Error('Manufacturing Context heartbeat 超出允许的未来时钟偏差');
  }
  if (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs <= 0) {
    throw new Error('Manufacturing Context pollIntervalMs 必须是正整数');
  }
  db.prepare(`INSERT INTO twin_projection_worker_heartbeats
    (tenant_id,worker_id,worker_ready,last_heartbeat_at,poll_interval_ms,updated_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(tenant_id,worker_id) DO UPDATE SET
      worker_ready=excluded.worker_ready,
      last_heartbeat_at=excluded.last_heartbeat_at,
      poll_interval_ms=excluded.poll_interval_ms,
      updated_at=excluded.updated_at
    WHERE julianday(twin_projection_worker_heartbeats.last_heartbeat_at) IS NULL
       OR julianday(twin_projection_worker_heartbeats.last_heartbeat_at)>julianday(?)
       OR julianday(excluded.last_heartbeat_at)>=julianday(twin_projection_worker_heartbeats.last_heartbeat_at)`).run(
    tenantId, workerId, input.workerReady ? 1 : 0, lastHeartbeatAt, input.pollIntervalMs, lastHeartbeatAt,
    trustedNow.iso,
  );
  return { workerReady: input.workerReady, lastHeartbeatAt, pollIntervalMs: input.pollIntervalMs };
}

/** Control-side tenant-scoped read; an absent business heartbeat fails closed. */
export function persistedManufacturingContextReadiness(
  db: DatabaseSync,
  tenantId: string,
  now = new Date(),
): ManufacturingContextRuntimeReadiness {
  const trustedNow = trustedNowInstant(now);
  const rows = db.prepare(`SELECT worker_id,worker_ready,last_heartbeat_at,poll_interval_ms
    FROM twin_projection_worker_heartbeats WHERE tenant_id=?`).all(requiredText(tenantId, 'tenantId')) as Array<{
      worker_id: string;
      worker_ready: number;
      last_heartbeat_at: string;
      poll_interval_ms: number;
    }>;
  const validRows = rows.flatMap((row) => {
    const heartbeatMilliseconds = Date.parse(row.last_heartbeat_at);
    const pollIntervalMs = Number(row.poll_interval_ms);
    if (!Number.isFinite(heartbeatMilliseconds)
      || heartbeatMilliseconds > trustedNow.milliseconds
      || !Number.isSafeInteger(pollIntervalMs)
      || pollIntervalMs <= 0
      || (row.worker_ready !== 0 && row.worker_ready !== 1)) return [];
    return [{ row, heartbeatMilliseconds, pollIntervalMs }];
  }).sort((left, right) => {
    if (left.heartbeatMilliseconds !== right.heartbeatMilliseconds) {
      return right.heartbeatMilliseconds - left.heartbeatMilliseconds;
    }
    if (left.row.worker_id === right.row.worker_id) return 0;
    return left.row.worker_id < right.row.worker_id ? -1 : 1;
  });
  const selected = validRows[0];
  return selected ? {
    workerReady: selected.row.worker_ready === 1,
    lastHeartbeatAt: new Date(selected.heartbeatMilliseconds).toISOString(),
    pollIntervalMs: selected.pollIntervalMs,
  } : {
    workerReady: false,
    lastHeartbeatAt: null,
    pollIntervalMs: 3_000,
  };
}

/** Exact composer used by the control-surface `/api/operations/v1-readiness` route. */
export function procurementV1ReadinessForOperations(
  db: DatabaseSync,
  tenantId: string,
  operations: Parameters<typeof procurementV1Readiness>[2],
  now = new Date(),
): ProcurementV1ReadinessView {
  return procurementV1Readiness(db, tenantId, {
    ...operations,
    manufacturingContext: persistedManufacturingContextReadiness(db, tenantId, now),
  }, now);
}
