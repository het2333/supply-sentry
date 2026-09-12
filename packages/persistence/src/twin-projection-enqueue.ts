import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { TwinProjectionPayloadConflictError } from '@readywork/core';

export interface EnqueueTwinProjectionInCurrentTransactionInput {
  readonly tenantId: string;
  readonly sourceTable: string;
  readonly sourceKey: string;
  readonly sourceRevision: string;
  readonly eventType: string;
  readonly payloadHash: string;
  readonly availableAt: string;
}

export interface PersistProcurementLineProjectionInCurrentTransactionInput {
  readonly tenantId: string;
  readonly kind: string;
  readonly lineId: string;
  readonly documentId: string;
  readonly lineNumber: string;
  readonly line: unknown;
  readonly availableAt: string;
}

export interface PersistProcurementLineProjectionInCurrentTransactionResult {
  readonly disposition: 'created' | 'updated' | 'unchanged';
  readonly generation: number;
}

function requiredText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Twin projection ${field} 不能为空`);
  return value.trim();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Twin projection payload 必须是有限 JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('Twin projection payload 必须是 JSON');
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** SHA-256 over canonical JSON; only the digest is persisted in a projection job. */
export function twinProjectionPayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Stable identity for the queue uniqueness tuple, independent of payload contents. */
export function stableProjectionJobId(input: Omit<EnqueueTwinProjectionInCurrentTransactionInput, 'payloadHash' | 'availableAt'>): string {
  const identity = [input.tenantId, input.sourceTable, input.sourceKey, input.sourceRevision, input.eventType]
    .map((part, index) => requiredText(part, ['tenantId', 'sourceTable', 'sourceKey', 'sourceRevision', 'eventType'][index]!))
    .join('\0');
  return `twin:projection-job:${createHash('sha256').update(identity).digest('hex')}`;
}

/**
 * Enqueue a source-row projection beside its owning business write.  This
 * helper deliberately does not open or finish a transaction: callers retain
 * transaction ownership, so an enqueue conflict rolls the business fact back.
 */
export function enqueueTwinProjectionInCurrentTransaction(
  db: DatabaseSync,
  input: EnqueueTwinProjectionInCurrentTransactionInput,
): void {
  const normalized = {
    tenantId: requiredText(input.tenantId, 'tenantId'),
    sourceTable: requiredText(input.sourceTable, 'sourceTable'),
    sourceKey: requiredText(input.sourceKey, 'sourceKey'),
    sourceRevision: requiredText(input.sourceRevision, 'sourceRevision'),
    eventType: requiredText(input.eventType, 'eventType'),
    payloadHash: requiredText(input.payloadHash, 'payloadHash'),
    availableAt: new Date(input.availableAt).toISOString(),
  };
  const existing = db.prepare(`SELECT id,payload_hash FROM twin_projection_jobs
    WHERE tenant_id=? AND source_table=? AND source_key=? AND source_revision=? AND event_type=?`)
    .get(normalized.tenantId, normalized.sourceTable, normalized.sourceKey, normalized.sourceRevision, normalized.eventType) as {
      id: string; payload_hash: string;
    } | undefined;
  if (existing) {
    if (existing.payload_hash === normalized.payloadHash) return;
    db.prepare(`INSERT INTO control_security_events
      (tenant_id,event_type,severity,request_id,method,path,actor_id,message,created_at)
      VALUES (?,'twin_projection_payload_conflict','warning',?,'ENQUEUE','/twin/projection-jobs',NULL,?,?)`)
      .run(normalized.tenantId, existing.id.slice(0, 128), JSON.stringify({
        jobId: existing.id,
        sourceTable: normalized.sourceTable,
        sourceKey: normalized.sourceKey,
        sourceRevision: normalized.sourceRevision,
        eventType: normalized.eventType,
        existingPayloadHash: existing.payload_hash,
        incomingPayloadHash: normalized.payloadHash,
      }), normalized.availableAt);
    throw new TwinProjectionPayloadConflictError(normalized.sourceKey);
  }
  db.prepare(`INSERT INTO twin_projection_jobs
    (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,available_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'queued',0,8,?,?,?)`).run(
    normalized.tenantId,
    stableProjectionJobId(normalized),
    normalized.sourceTable,
    normalized.sourceKey,
    normalized.sourceRevision,
    normalized.eventType,
    normalized.payloadHash,
    normalized.availableAt,
    normalized.availableAt,
    normalized.availableAt,
  );
}

/**
 * Persist a mutable procurement line and enqueue its projection under one
 * monotonic mutation generation. The caller owns the surrounding transaction.
 * Canonically identical replays do not update the row or create another job.
 */
export function persistProcurementLineProjectionInCurrentTransaction(
  db: DatabaseSync,
  input: PersistProcurementLineProjectionInCurrentTransactionInput,
): PersistProcurementLineProjectionInCurrentTransactionResult {
  const tenantId = requiredText(input.tenantId, 'tenantId');
  const kind = requiredText(input.kind, 'kind');
  const lineId = requiredText(input.lineId, 'lineId');
  const documentId = requiredText(input.documentId, 'documentId');
  const lineNumber = requiredText(input.lineNumber, 'lineNumber');
  const payloadHash = twinProjectionPayloadHash(input.line);
  const lineJson = JSON.stringify(input.line);
  if (lineJson === undefined) throw new Error('Procurement line 必须是 JSON');
  const existing = db.prepare(`SELECT document_id,line_number,json,projection_generation FROM procurement_lines
    WHERE tenant_id=? AND kind=? AND id=?`).get(tenantId, kind, lineId) as {
      document_id: string;
      line_number: string;
      json: string;
      projection_generation: number;
    } | undefined;

  let disposition: PersistProcurementLineProjectionInCurrentTransactionResult['disposition'];
  let generation: number;
  if (!existing) {
    disposition = 'created';
    generation = 1;
    db.prepare(`INSERT INTO procurement_lines
      (tenant_id,kind,id,document_id,line_number,json,projection_generation) VALUES (?,?,?,?,?,?,?)`)
      .run(tenantId, kind, lineId, documentId, lineNumber, lineJson, generation);
  } else {
    const storedPayloadHash = twinProjectionPayloadHash(JSON.parse(existing.json) as unknown);
    if (existing.document_id === documentId && existing.line_number === lineNumber && storedPayloadHash === payloadHash) {
      return { disposition: 'unchanged', generation: existing.projection_generation };
    }
    disposition = 'updated';
    generation = existing.projection_generation + 1;
    const updated = db.prepare(`UPDATE procurement_lines
      SET document_id=?,line_number=?,json=?,projection_generation=?
      WHERE tenant_id=? AND kind=? AND id=? AND projection_generation=?`)
      .run(documentId, lineNumber, lineJson, generation, tenantId, kind, lineId, existing.projection_generation);
    if (Number(updated.changes) !== 1) throw new Error(`Procurement line 世代冲突: ${kind}/${lineId}`);
  }

  enqueueTwinProjectionInCurrentTransaction(db, {
    tenantId,
    sourceTable: 'procurement_lines',
    sourceKey: `${kind}:${lineId}`,
    sourceRevision: String(generation),
    eventType: `${kind}.changed`,
    payloadHash,
    availableAt: input.availableAt,
  });
  return { disposition, generation };
}
