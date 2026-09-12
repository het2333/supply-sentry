import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertTwinConfidence,
  compareTwinEvidencePrecedence,
  nowIso,
  twinSourcePriority,
  type AppendTwinAgentEventInput,
  type AppendTwinEvidenceInput,
  type CreateTwinSnapshotInput,
  type ManufacturingContextStore,
  type TwinAgentEvent,
  type TwinEntity,
  type TwinEvidence,
  type TwinFactConflict,
  type TwinNeighborhood,
  type TwinRelation,
  type TwinResolvedFact,
  type TwinSnapshot,
  type UpsertTwinEntityInput,
  type UpsertTwinRelationInput,
} from '@readywork/core';
import { contextSourceWatermark, stableTwinEntityId } from './context-identity.js';
import {
  agentEventIdempotencyKey,
  assertTwinAgentEventType,
  sanitizeAgentEventPayload,
} from './agent-events.js';
import {
  buildTwinSnapshot,
  TWIN_SNAPSHOT_DEPTH,
  TWIN_SNAPSHOT_ENTITY_LIMIT,
  TWIN_SNAPSHOT_EVIDENCE_LIMIT,
  TWIN_SNAPSHOT_MAX_BYTES,
  TWIN_SNAPSHOT_RECENT_AGENT_EVENT_LIMIT,
  twinSnapshotSerializedBytes,
} from './snapshot-builder.js';

type SqlValue = string | number | bigint | null | Uint8Array;
type SqlRow = Record<string, SqlValue>;

interface ManufacturingContextStoreBinding {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  readonly concrete: boolean;
}

const MANUFACTURING_CONTEXT_STORE_BINDINGS = new WeakMap<object, ManufacturingContextStoreBinding>();

/**
 * Proves that an object is a concrete Store constructed for this exact SQLite
 * handle and tenant. The binding is module-owned and never exposes the handle.
 */
export function isSqliteManufacturingContextStoreBoundTo(
  value: unknown,
  db: DatabaseSync,
  tenantId: string,
): value is SqliteManufacturingContextStore {
  if (typeof value !== 'object' || value === null) return false;
  const binding = MANUFACTURING_CONTEXT_STORE_BINDINGS.get(value);
  return binding?.concrete === true && binding.db === db && binding.tenantId === tenantId;
}

function parseJson<T>(value: SqlValue | undefined): T {
  if (value === undefined) throw new Error('Twin 持久化 JSON 列缺失');
  return JSON.parse(String(value)) as T;
}

const TWIN_JSON_INVALID_MESSAGE = 'Twin JSON 值无效';
export const TWIN_CONTEXT_ROOT_ENTITY_ID_KEY = 'contextRootEntityId';
const TWIN_CONTEXT_ROOT_JSON_PATH = `$.${TWIN_CONTEXT_ROOT_ENTITY_ID_KEY}`;
const PO_PROJECTOR_ACTOR_ID = 'system:procurement-po-projector';
const LEGACY_PO_CONTEXTUAL_FACT_PATHS = [
  'material.reference',
  'award.line',
  'quote.line',
  'rfq.line',
  'shipment.line',
  'receipt.line',
  'invoice.line',
] as const;

function invalidTwinJson(): never {
  throw new Error(TWIN_JSON_INVALID_MESSAGE);
}

export function canonicalTwinJson(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalidTwinJson();
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') return invalidTwinJson();

  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return invalidTwinJson();
    if (ancestors.has(value)) return invalidTwinJson();
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string') return invalidTwinJson();
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          return invalidTwinJson();
        }
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) return invalidTwinJson();
        items.push(canonicalTwinJson(descriptor.value, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const object = value as Record<string, unknown>;
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== 'string') return invalidTwinJson();
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return invalidTwinJson();
      entries.push([key, descriptor.value]);
    }
    entries.sort(([left], [right]) => ascendingText(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalTwinJson(item, ancestors)}`).join(',')}}`;
  } catch (error) {
    if (error instanceof Error && error.message === TWIN_JSON_INVALID_MESSAGE) throw error;
    return invalidTwinJson();
  } finally {
    ancestors.delete(value);
  }
}

function digest(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function ascendingText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function resolveTwinFact(
  evidence: readonly TwinEvidence[],
  factPath: string,
): TwinResolvedFact | undefined {
  const candidates = evidence.filter((item) => item.factPath === factPath).sort(compareTwinEvidencePrecedence);
  const selected = candidates[0];
  if (!selected) return undefined;
  const selectedValue = canonicalTwinJson(selected.value);
  return {
    factPath,
    value: selected.value,
    evidence: selected,
    conflicts: candidates.slice(1).filter((item) => canonicalTwinJson(item.value) !== selectedValue),
  };
}

function entityFromRow(row: SqlRow): TwinEntity {
  return {
    tenantId: String(row.tenant_id),
    id: String(row.id),
    entityType: String(row.entity_type) as TwinEntity['entityType'],
    canonicalKey: String(row.canonical_key),
    label: String(row.label),
    lifecycleState: String(row.lifecycle_state),
    attributes: parseJson<Record<string, unknown>>(row.attributes_json),
    state: parseJson<Record<string, unknown>>(row.state_json),
    currentRevision: Number(row.current_revision),
    sourceWatermark: String(row.source_watermark),
    effectiveAt: String(row.effective_at),
    observedAt: String(row.observed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function relationFromRow(row: SqlRow): TwinRelation {
  return {
    tenantId: String(row.tenant_id),
    id: String(row.id),
    relationType: String(row.relation_type),
    fromEntityId: String(row.from_entity_id),
    toEntityId: String(row.to_entity_id),
    status: String(row.status) as TwinRelation['status'],
    sourceEvidenceId: String(row.source_evidence_id),
    validFrom: String(row.valid_from),
    ...(row.valid_to === null ? {} : { validTo: String(row.valid_to) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function evidenceFromRow(row: SqlRow): TwinEvidence {
  return {
    tenantId: String(row.tenant_id),
    id: String(row.id),
    ...(row.entity_id === null ? {} : { entityId: String(row.entity_id) }),
    ...(row.relation_id === null ? {} : { relationId: String(row.relation_id) }),
    sourceSemantics: String(row.source_semantics) as TwinEvidence['sourceSemantics'],
    sourceKind: String(row.source_kind),
    sourceId: String(row.source_id),
    sourceVersion: String(row.source_version),
    sourceHash: String(row.source_hash),
    factPath: String(row.fact_path),
    value: parseJson<unknown>(row.value_json),
    priority: Number(row.priority) as TwinEvidence['priority'],
    confidence: Number(row.confidence),
    effectiveAt: String(row.effective_at),
    observedAt: String(row.observed_at),
    actorId: String(row.actor_id),
    rawReference: parseJson<Record<string, unknown>>(row.raw_reference_json),
    ...(row.supersedes_evidence_id === null ? {} : { supersedesEvidenceId: String(row.supersedes_evidence_id) }),
    createdAt: String(row.created_at),
  };
}

function agentEventFromRow(row: SqlRow): TwinAgentEvent {
  return {
    tenantId: String(row.tenant_id),
    id: String(row.id),
    employeeId: String(row.employee_id),
    ...(row.temporal_workflow_id === null ? {} : { temporalWorkflowId: String(row.temporal_workflow_id) }),
    runId: String(row.run_id),
    taskId: String(row.task_id),
    ...(row.business_object_id === null ? {} : { businessObjectId: String(row.business_object_id) }),
    ...(row.entity_id === null ? {} : { entityId: String(row.entity_id) }),
    eventType: String(row.event_type) as TwinAgentEvent['eventType'],
    ...(row.input_snapshot_id === null ? {} : { inputSnapshotId: String(row.input_snapshot_id) }),
    ...(row.model === null ? {} : { model: String(row.model) }),
    ...(row.reasoning_profile === null ? {} : { reasoningProfile: String(row.reasoning_profile) }),
    ...(row.prompt_hash === null ? {} : { promptHash: String(row.prompt_hash) }),
    ...(row.response_hash === null ? {} : { responseHash: String(row.response_hash) }),
    ...(row.action_name === null ? {} : { actionName: String(row.action_name) }),
    status: String(row.status),
    ...(row.confidence === null ? {} : { confidence: Number(row.confidence) }),
    evidenceIds: parseJson<string[]>(row.evidence_ids_json),
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function snapshotFromRow(row: SqlRow): TwinSnapshot {
  return {
    tenantId: String(row.tenant_id),
    id: String(row.id),
    employeeId: String(row.employee_id),
    rootEntityId: String(row.root_entity_id),
    purpose: String(row.purpose),
    schemaVersion: 'manufacturing-context/v1',
    sourceWatermark: String(row.source_watermark),
    permissionFingerprint: String(row.permission_fingerprint),
    snapshot: parseJson<Record<string, any>>(row.snapshot_json),
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
  };
}

export class SqliteManufacturingContextStore implements ManufacturingContextStore {
  constructor(
    private readonly db: DatabaseSync,
    readonly tenantId: string,
  ) {
    if (!tenantId) throw new Error('Twin tenantId 不能为空');
    MANUFACTURING_CONTEXT_STORE_BINDINGS.set(this, {
      db,
      tenantId,
      concrete: new.target === SqliteManufacturingContextStore,
    });
  }

  upsertEntity(input: UpsertTwinEntityInput): TwinEntity {
    const id = stableTwinEntityId(this.tenantId, input.entityType, input.canonicalKey);
    const at = nowIso();
    const attributesJson = canonicalTwinJson(input.attributes);
    const stateJson = canonicalTwinJson(input.state);
    this.db.prepare(`INSERT INTO twin_entities
      (tenant_id,id,entity_type,canonical_key,label,lifecycle_state,attributes_json,state_json,current_revision,source_watermark,effective_at,observed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?)
      ON CONFLICT(tenant_id,entity_type,canonical_key) DO UPDATE SET
        label=excluded.label,
        lifecycle_state=excluded.lifecycle_state,
        attributes_json=excluded.attributes_json,
        state_json=excluded.state_json,
        current_revision=twin_entities.current_revision+1,
        source_watermark=excluded.source_watermark,
        effective_at=excluded.effective_at,
        observed_at=excluded.observed_at,
        updated_at=excluded.updated_at
      WHERE twin_entities.label IS NOT excluded.label
         OR twin_entities.lifecycle_state IS NOT excluded.lifecycle_state
         OR twin_entities.attributes_json IS NOT excluded.attributes_json
         OR twin_entities.state_json IS NOT excluded.state_json
         OR twin_entities.source_watermark IS NOT excluded.source_watermark
         OR twin_entities.effective_at IS NOT excluded.effective_at
         OR twin_entities.observed_at IS NOT excluded.observed_at`).run(
      this.tenantId, id, input.entityType, input.canonicalKey, input.label, input.lifecycleState,
      attributesJson, stateJson, input.sourceWatermark,
      input.effectiveAt, input.observedAt, at, at,
    );
    const row = this.db.prepare(
      'SELECT * FROM twin_entities WHERE tenant_id=? AND entity_type=? AND canonical_key=?',
    ).get(this.tenantId, input.entityType, input.canonicalKey) as SqlRow | undefined;
    if (!row) throw new Error('Twin 实体写入失败');
    return entityFromRow(row);
  }

  getEntity(entityId: string): TwinEntity | undefined {
    const row = this.db.prepare('SELECT * FROM twin_entities WHERE tenant_id=? AND id=?')
      .get(this.tenantId, entityId) as SqlRow | undefined;
    return row ? entityFromRow(row) : undefined;
  }

  getByBusinessObjectId(businessObjectId: string): TwinEntity | undefined {
    const row = this.db.prepare(`SELECT * FROM twin_entities
      WHERE tenant_id=? AND (canonical_key=? OR json_extract(attributes_json, '$.businessObjectId')=?)
      ORDER BY id ASC LIMIT 1`).get(this.tenantId, businessObjectId, businessObjectId) as SqlRow | undefined;
    return row ? entityFromRow(row) : undefined;
  }

  upsertRelation(input: UpsertTwinRelationInput): TwinRelation {
    if (!this.getEntity(input.fromEntityId) || !this.getEntity(input.toEntityId)) {
      throw new Error('Twin 关系端点实体在当前租户不存在');
    }
    const id = `twin:relation:${digest(
      this.tenantId, input.relationType, input.fromEntityId, input.toEntityId, input.sourceEvidenceId,
    ).slice(0, 32)}`;
    const at = nowIso();
    this.db.prepare(`INSERT INTO twin_relations
      (tenant_id,id,relation_type,from_entity_id,to_entity_id,status,source_evidence_id,valid_from,valid_to,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,relation_type,from_entity_id,to_entity_id,source_evidence_id) DO UPDATE SET
        status=excluded.status, valid_from=excluded.valid_from, valid_to=excluded.valid_to, updated_at=excluded.updated_at
      WHERE twin_relations.status IS NOT excluded.status
         OR twin_relations.valid_from IS NOT excluded.valid_from
         OR twin_relations.valid_to IS NOT excluded.valid_to`).run(
      this.tenantId, id, input.relationType, input.fromEntityId, input.toEntityId, input.status,
      input.sourceEvidenceId, input.validFrom, input.validTo ?? null, at, at,
    );
    const row = this.db.prepare('SELECT * FROM twin_relations WHERE tenant_id=? AND id=?')
      .get(this.tenantId, id) as SqlRow | undefined;
    if (!row) throw new Error('Twin 关系写入失败');
    return relationFromRow(row);
  }

  appendEvidence(input: AppendTwinEvidenceInput): TwinEvidence {
    const confidence = assertTwinConfidence(input.confidence);
    if (!input.entityId && !input.relationId) throw new Error('Twin 证据必须关联实体或关系');
    if (input.entityId && !this.getEntity(input.entityId)) throw new Error('Twin 证据实体在当前租户不存在');
    if (input.relationId) {
      const relation = this.db.prepare('SELECT id FROM twin_relations WHERE tenant_id=? AND id=?')
        .get(this.tenantId, input.relationId);
      if (!relation) throw new Error('Twin 证据关系在当前租户不存在');
    }
    const id = `twin:evidence:${digest(
      this.tenantId, input.sourceKind, input.sourceId, input.sourceVersion, input.factPath, input.sourceHash,
    ).slice(0, 32)}`;
    this.db.prepare(`INSERT OR IGNORE INTO twin_evidence
      (tenant_id,id,entity_id,relation_id,source_semantics,source_kind,source_id,source_version,source_hash,fact_path,value_json,priority,confidence,effective_at,observed_at,actor_id,raw_reference_json,supersedes_evidence_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      this.tenantId, id, input.entityId ?? null, input.relationId ?? null, input.sourceSemantics,
      input.sourceKind, input.sourceId, input.sourceVersion, input.sourceHash, input.factPath,
      canonicalTwinJson(input.value), twinSourcePriority(input.sourceSemantics), confidence, input.effectiveAt,
      input.observedAt, input.actorId, canonicalTwinJson(input.rawReference), input.supersedesEvidenceId ?? null, nowIso(),
    );
    const row = this.db.prepare(`SELECT * FROM twin_evidence
      WHERE tenant_id=? AND source_kind=? AND source_id=? AND source_version=? AND fact_path=? AND source_hash=?`)
      .get(this.tenantId, input.sourceKind, input.sourceId, input.sourceVersion, input.factPath, input.sourceHash) as SqlRow | undefined;
    if (!row) throw new Error('Twin 证据写入失败');
    return evidenceFromRow(row);
  }

  listEvidence(entityId: string): TwinEvidence[] {
    if (!this.getEntity(entityId)) return [];
    const rows = this.db.prepare(`SELECT * FROM twin_evidence
      WHERE tenant_id=? AND entity_id=? ORDER BY priority DESC,id ASC LIMIT 10001`)
      .all(this.tenantId, entityId) as SqlRow[];
    if (rows.length > 10_000) throw new Error('Twin 证据候选超过安全排序上限');
    return rows.map(evidenceFromRow).sort(compareTwinEvidencePrecedence);
  }

  resolveFact(entityId: string, factPath: string): TwinResolvedFact | undefined {
    if (!this.getEntity(entityId)) return undefined;
    const rows = this.db.prepare(`SELECT * FROM twin_evidence
      WHERE tenant_id=? AND entity_id=? AND fact_path=? ORDER BY priority DESC,id ASC LIMIT 10001`)
      .all(this.tenantId, entityId, factPath) as SqlRow[];
    if (rows.length > 10_000) throw new Error('Twin 事实证据候选超过安全排序上限');
    return resolveTwinFact(rows.map(evidenceFromRow), factPath);
  }

  getNeighborhood(
    rootEntityId: string,
    options: { depth: 1 | 2; entityLimit: number; evidenceLimit: number },
  ): TwinNeighborhood {
    const root = this.getEntity(rootEntityId);
    if (!root) throw new Error('Twin 根实体在当前租户不存在');
    if (!Number.isInteger(options.entityLimit) || options.entityLimit < 1) throw new Error('Twin entityLimit 必须大于 0');
    if (!Number.isInteger(options.evidenceLimit) || options.evidenceLimit < 0) throw new Error('Twin evidenceLimit 不能为负数');

    const entityIds = new Set([rootEntityId]);
    const hasContextRoot = this.db.prepare(`SELECT 1 FROM twin_evidence
      WHERE tenant_id=? AND json_extract(value_json, ?)=? LIMIT 1`)
      .get(this.tenantId, TWIN_CONTEXT_ROOT_JSON_PATH, rootEntityId) !== undefined;
    const relationContextFilter = hasContextRoot
      ? `AND (json_extract(e.value_json, ?)=?
          OR (e.id IS NOT NULL AND json_extract(e.value_json, ?) IS NULL AND e.actor_id<>?))`
      : '';
    let frontier = [rootEntityId];
    const relationById = new Map<string, TwinRelation>();
    let truncated = false;
    for (let level = 0; level < options.depth && frontier.length > 0; level += 1) {
      const placeholders = frontier.map(() => '?').join(',');
      const rows = this.db.prepare(`SELECT r.* FROM twin_relations r
        LEFT JOIN twin_evidence e ON e.tenant_id=r.tenant_id AND e.id=r.source_evidence_id
        WHERE r.tenant_id=? AND (r.from_entity_id IN (${placeholders}) OR r.to_entity_id IN (${placeholders}))
        ${relationContextFilter}
        ORDER BY r.id ASC`).all(
        this.tenantId, ...frontier, ...frontier,
        ...(hasContextRoot ? [
          TWIN_CONTEXT_ROOT_JSON_PATH, rootEntityId,
          TWIN_CONTEXT_ROOT_JSON_PATH, PO_PROJECTOR_ACTOR_ID,
        ] : []),
      ) as SqlRow[];
      const next = new Set<string>();
      for (const row of rows) {
        const relation = relationFromRow(row);
        relationById.set(relation.id, relation);
        for (const candidate of [relation.fromEntityId, relation.toEntityId]) {
          if (entityIds.has(candidate)) continue;
          if (entityIds.size >= options.entityLimit) {
            truncated = true;
            continue;
          }
          entityIds.add(candidate);
          next.add(candidate);
        }
      }
      frontier = [...next].sort();
    }

    const entities = [...entityIds].map((id) => this.getEntity(id)).filter((item): item is TwinEntity => item !== undefined);
    const includedIds = new Set(entities.map((item) => item.id));
    const relations = [...relationById.values()].filter(
      (item) => includedIds.has(item.fromEntityId) && includedIds.has(item.toEntityId),
    );
    const placeholders = entities.map(() => '?').join(',');
    const legacyFactPathPlaceholders = LEGACY_PO_CONTEXTUAL_FACT_PATHS.map(() => '?').join(',');
    const evidenceContextFilter = hasContextRoot
      ? `AND (json_extract(value_json, ?)=?
          OR (json_extract(value_json, ?) IS NULL
            AND NOT (actor_id=? AND (fact_path LIKE 'relation.%'
              OR fact_path IN (${legacyFactPathPlaceholders})))))`
      : '';
    const evidenceRows = entities.length === 0 ? [] : this.db.prepare(`SELECT * FROM twin_evidence
      WHERE tenant_id=? AND entity_id IN (${placeholders}) ${evidenceContextFilter}
      ORDER BY priority DESC,id ASC LIMIT 10001`).all(
      this.tenantId, ...entities.map((item) => item.id),
      ...(hasContextRoot ? [
        TWIN_CONTEXT_ROOT_JSON_PATH, rootEntityId,
        TWIN_CONTEXT_ROOT_JSON_PATH, PO_PROJECTOR_ACTOR_ID,
        ...LEGACY_PO_CONTEXTUAL_FACT_PATHS,
      ] : []),
    ) as SqlRow[];
    if (evidenceRows.length > 10_000) throw new Error('Twin 邻域证据候选超过安全排序上限');
    if (evidenceRows.length > options.evidenceLimit) truncated = true;
    const evidence = evidenceRows.map(evidenceFromRow).sort(compareTwinEvidencePrecedence).slice(0, options.evidenceLimit);
    const rootBusinessObjectId = typeof root.attributes['businessObjectId'] === 'string'
      ? root.attributes['businessObjectId'] : null;
    const agentEventRows = entities.length === 0 ? [] : this.db.prepare(`SELECT * FROM twin_agent_events
      WHERE tenant_id=? AND (
        entity_id IN (${placeholders})
        OR (entity_id IS NULL AND (
          input_snapshot_id IN (SELECT id FROM twin_snapshots WHERE tenant_id=? AND root_entity_id=?)
          OR (? IS NOT NULL AND business_object_id=?)
        ))
      )
      ORDER BY created_at DESC, id ASC LIMIT ?`).all(
      this.tenantId, ...entities.map((item) => item.id),
      this.tenantId, rootEntityId, rootBusinessObjectId, rootBusinessObjectId,
      TWIN_SNAPSHOT_RECENT_AGENT_EVENT_LIMIT + 1,
    ) as SqlRow[];
    const agentEvents = agentEventRows.map(agentEventFromRow);

    const sources = [
      ...entities.map((item) => ({
        sourceTable: 'twin_entities', sourceKey: item.id,
        sourceRevision: String(item.currentRevision), sourceHash: item.sourceWatermark,
      })),
      ...evidence.map((item) => ({
        sourceTable: item.sourceKind, sourceKey: item.sourceId,
        sourceRevision: item.sourceVersion, sourceHash: item.sourceHash,
      })),
    ];
    const conflicts: TwinFactConflict[] = [];
    const evidenceByPath = new Map<string, TwinEvidence[]>();
    for (const item of evidence) {
      const key = `${item.entityId ?? ''}\0${item.factPath}`;
      const group = evidenceByPath.get(key) ?? [];
      group.push(item);
      evidenceByPath.set(key, group);
    }
    for (const group of evidenceByPath.values()) {
      const selected = group[0];
      if (!selected) continue;
      const selectedValue = canonicalTwinJson(selected.value);
      const conflictingEvidenceIds = group.slice(1)
        .filter((item) => canonicalTwinJson(item.value) !== selectedValue)
        .map((item) => item.id);
      if (conflictingEvidenceIds.length > 0) {
        conflicts.push({ factPath: selected.factPath, selectedEvidenceId: selected.id, conflictingEvidenceIds });
      }
    }

    return {
      root,
      entities,
      relations,
      evidence,
      agentEvents,
      sourceWatermark: contextSourceWatermark(sources),
      conflicts,
      missingFacts: [],
      truncated,
      nextCursor: null,
    };
  }

  createSnapshot(input: CreateTwinSnapshotInput): TwinSnapshot {
    const neighborhood = this.getNeighborhood(input.rootEntityId, {
      depth: TWIN_SNAPSHOT_DEPTH,
      entityLimit: TWIN_SNAPSHOT_ENTITY_LIMIT,
      evidenceLimit: TWIN_SNAPSHOT_EVIDENCE_LIMIT,
    });
    const snapshot = buildTwinSnapshot(neighborhood, input.scope, input.purpose);
    const permissionFingerprint = digest(canonicalTwinJson(snapshot['scope']));
    const snapshotJson = canonicalTwinJson(snapshot);
    if (twinSnapshotSerializedBytes(snapshot) > TWIN_SNAPSHOT_MAX_BYTES
      || Buffer.byteLength(snapshotJson, 'utf8') > TWIN_SNAPSHOT_MAX_BYTES) {
      throw new Error('Twin 快照超过 512 KiB 上限');
    }
    const contentHash = digest(snapshotJson);
    const id = `twin:snapshot:${digest(
      this.tenantId, input.employeeId, input.rootEntityId, input.purpose,
      neighborhood.sourceWatermark, permissionFingerprint, contentHash,
    ).slice(0, 32)}`;
    this.db.prepare(`INSERT OR IGNORE INTO twin_snapshots
      (tenant_id,id,employee_id,root_entity_id,purpose,schema_version,source_watermark,permission_fingerprint,snapshot_json,content_hash,created_at)
      VALUES (?,?,?,?,?,'manufacturing-context/v1',?,?,?,?,?)`).run(
      this.tenantId, id, input.employeeId, input.rootEntityId, input.purpose,
      neighborhood.sourceWatermark, permissionFingerprint, snapshotJson, contentHash, nowIso(),
    );
    const created = this.getSnapshot(id);
    if (!created) throw new Error('Twin 快照写入失败');
    return created;
  }

  getSnapshot(snapshotId: string): TwinSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM twin_snapshots WHERE tenant_id=? AND id=?')
      .get(this.tenantId, snapshotId) as SqlRow | undefined;
    return row ? snapshotFromRow(row) : undefined;
  }

  appendAgentEvent(event: AppendTwinAgentEventInput): TwinAgentEvent {
    assertTwinAgentEventType(event.eventType);
    if (event.confidence !== undefined) assertTwinConfidence(event.confidence);
    const payload = sanitizeAgentEventPayload(event.payload);
    canonicalTwinJson(event.status);
    if (event.entityId && !this.getEntity(event.entityId)) throw new Error('Twin Agent Event 实体在当前租户不存在');
    if (event.inputSnapshotId) {
      const snapshot = this.getSnapshot(event.inputSnapshotId);
      if (!snapshot || snapshot.employeeId !== event.employeeId) {
        throw new Error('Twin Agent Event 快照不存在或不属于调用方');
      }
    }
    if (event.evidenceIds.length > 0) {
      const placeholders = event.evidenceIds.map(() => '?').join(',');
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM twin_evidence
        WHERE tenant_id=? AND id IN (${placeholders})`).get(this.tenantId, ...event.evidenceIds) as SqlRow | undefined;
      if (Number(row?.count ?? 0) !== new Set(event.evidenceIds).size) {
        throw new Error('Twin Agent Event 证据在当前租户不存在');
      }
    }
    const idempotencyKey = agentEventIdempotencyKey(event);
    const id = `twin:agent-event:${digest(this.tenantId, idempotencyKey).slice(0, 32)}`;
    const existing = this.db.prepare('SELECT * FROM twin_agent_events WHERE tenant_id=? AND id=?')
      .get(this.tenantId, id) as SqlRow | undefined;
    if (existing) {
      const stored = agentEventFromRow(existing);
      if (stored.employeeId !== event.employeeId
        || (stored.inputSnapshotId ?? null) !== (event.inputSnapshotId ?? null)) {
        throw new Error('Twin Agent Event 幂等事件不存在或不属于调用方');
      }
      if (agentEventIdempotencyKey(stored) !== idempotencyKey) {
        throw new Error('Twin Agent Event 幂等键冲突');
      }
      return stored;
    }
    this.db.prepare(`INSERT OR IGNORE INTO twin_agent_events
      (tenant_id,id,employee_id,temporal_workflow_id,run_id,task_id,business_object_id,entity_id,event_type,input_snapshot_id,model,reasoning_profile,prompt_hash,response_hash,action_name,status,confidence,evidence_ids_json,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      this.tenantId, id, event.employeeId, event.temporalWorkflowId ?? null, event.runId, event.taskId,
      event.businessObjectId ?? null, event.entityId ?? null, event.eventType, event.inputSnapshotId ?? null,
      event.model ?? null, event.reasoningProfile ?? null, event.promptHash ?? null, event.responseHash ?? null,
      event.actionName ?? null, event.status, event.confidence ?? null, canonicalTwinJson(event.evidenceIds),
      canonicalTwinJson(payload), event.createdAt,
    );
    const row = this.db.prepare('SELECT * FROM twin_agent_events WHERE tenant_id=? AND id=?')
      .get(this.tenantId, id) as SqlRow | undefined;
    if (!row) throw new Error('Twin Agent Event 写入失败');
    return agentEventFromRow(row);
  }
}
