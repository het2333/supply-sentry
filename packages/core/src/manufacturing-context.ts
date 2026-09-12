export type TwinSourceSemantics =
  | 'verified_external'
  | 'approved_human'
  | 'deterministic'
  | 'model_derived'
  | 'observed_backfill';

export type TwinProjectionStatus = 'queued' | 'processing' | 'retry_wait' | 'succeeded' | 'dead_letter';
export type TwinEntityType = 'supplier' | 'contact' | 'material' | 'requisition' | 'rfq' | 'quote' | 'award'
  | 'purchase_order' | 'po_line' | 'communication' | 'shipment' | 'receipt' | 'invoice' | 'sla_evaluation';

export interface TwinAccessScope {
  permission: 'read' | 'operate' | 'approve' | 'configure' | 'admin';
  entityTypes: readonly TwinEntityType[];
  includeContactDetails: boolean;
  includeCommercialTerms: boolean;
}

export function twinSourcePriority(source: TwinSourceSemantics): 100 | 200 | 300 | 400 {
  if (source === 'verified_external') return 400;
  if (source === 'approved_human') return 300;
  if (source === 'model_derived') return 100;
  return 200;
}

export function assertTwinConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Twin confidence 必须是 0 到 1 的有限数值');
  return value;
}

export interface TwinEntity {
  tenantId: string; id: string; entityType: TwinEntityType; canonicalKey: string; label: string;
  lifecycleState: string; attributes: Record<string, unknown>; state: Record<string, unknown>;
  currentRevision: number; sourceWatermark: string; effectiveAt: string; observedAt: string;
  createdAt: string; updatedAt: string;
}
export interface TwinRelation {
  tenantId: string; id: string; relationType: string; fromEntityId: string; toEntityId: string;
  status: 'active' | 'superseded' | 'disputed'; sourceEvidenceId: string;
  validFrom: string; validTo?: string; createdAt: string; updatedAt: string;
}
export interface TwinEvidence {
  tenantId: string; id: string; entityId?: string; relationId?: string;
  sourceSemantics: TwinSourceSemantics; sourceKind: string; sourceId: string; sourceVersion: string;
  sourceHash: string; factPath: string; value: unknown; priority: 100 | 200 | 300 | 400;
  confidence: number; effectiveAt: string; observedAt: string; actorId: string;
  rawReference: Record<string, unknown>; supersedesEvidenceId?: string; createdAt: string;
}

function compareBinaryText(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return leftBytes.length === rightBytes.length ? 0 : leftBytes.length < rightBytes.length ? -1 : 1;
}

/**
 * Ascending source-aware version order. Pure unsigned integers use arbitrary-precision
 * numeric comparison; namespaced/opaque values use locale-independent UTF-8 binary keys.
 */
export function compareTwinSourceVersions(
  left: Pick<TwinEvidence, 'sourceKind' | 'sourceVersion'>,
  right: Pick<TwinEvidence, 'sourceKind' | 'sourceVersion'>,
): number {
  if (/^\d+$/.test(left.sourceVersion) && /^\d+$/.test(right.sourceVersion)) {
    const leftValue = BigInt(left.sourceVersion);
    const rightValue = BigInt(right.sourceVersion);
    return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
  }
  return compareBinaryText(
    `${left.sourceKind}\0${left.sourceVersion}`,
    `${right.sourceKind}\0${right.sourceVersion}`,
  );
}

/** Selected-first evidence precedence shared by storage, conflict and snapshot projections. */
export function compareTwinEvidencePrecedence(left: TwinEvidence, right: TwinEvidence): number {
  return right.priority - left.priority
    || -compareTwinSourceVersions(left, right)
    || -compareBinaryText(left.effectiveAt, right.effectiveAt)
    || -compareBinaryText(left.observedAt, right.observedAt)
    || compareBinaryText(left.id, right.id);
}
export type TwinAgentEventType = 'context_read' | 'extraction' | 'decision' | 'recommendation'
  | 'action_requested' | 'action_result' | 'human_feedback' | 'business_outcome';
export interface TwinAgentEvent {
  tenantId: string; id: string; employeeId: string; temporalWorkflowId?: string; runId: string;
  taskId: string; businessObjectId?: string; entityId?: string; eventType: TwinAgentEventType;
  inputSnapshotId?: string; model?: string; reasoningProfile?: string; promptHash?: string;
  responseHash?: string; actionName?: string; status: string; confidence?: number;
  evidenceIds: string[]; payload: Record<string, unknown>; createdAt: string;
}
export interface TwinSnapshot {
  tenantId: string; id: string; employeeId: string; rootEntityId: string; purpose: string;
  schemaVersion: 'manufacturing-context/v1'; sourceWatermark: string; permissionFingerprint: string;
  snapshot: Record<string, any>; contentHash: string; createdAt: string;
}
export interface TwinProjectionJob {
  tenantId: string; id: string; sourceTable: string; sourceKey: string; sourceRevision: string;
  eventType: string; payloadHash: string; status: TwinProjectionStatus; attempts: number; maxAttempts: 8;
  availableAt: string; leaseOwner?: string; leaseToken?: string; leaseExpiresAt?: string;
  projectedWatermark?: string; lastError?: string; createdAt: string; updatedAt: string; completedAt?: string;
}
export interface TwinFactConflict { factPath: string; selectedEvidenceId: string; conflictingEvidenceIds: string[]; }
export interface TwinResolvedFact { factPath: string; value: unknown; evidence: TwinEvidence; conflicts: TwinEvidence[]; }
export interface TwinNeighborhood {
  root: TwinEntity; entities: TwinEntity[]; relations: TwinRelation[]; evidence: TwinEvidence[];
  agentEvents: TwinAgentEvent[]; sourceWatermark: string; conflicts: TwinFactConflict[];
  missingFacts: string[]; truncated: boolean; nextCursor: string | null;
}
export type UpsertTwinEntityInput = Omit<TwinEntity, 'tenantId' | 'id' | 'currentRevision' | 'createdAt' | 'updatedAt'>;
export type AppendTwinEvidenceInput = Omit<TwinEvidence, 'tenantId' | 'id' | 'priority' | 'createdAt'>;
export type UpsertTwinRelationInput = Omit<TwinRelation, 'tenantId' | 'id' | 'createdAt' | 'updatedAt'>;
export interface CreateTwinSnapshotInput { employeeId: string; rootEntityId: string; purpose: string; scope: TwinAccessScope; }
export type AppendTwinAgentEventInput = Omit<TwinAgentEvent, 'tenantId' | 'id'>;

export class TwinProjectionPayloadConflictError extends Error {
  readonly code = 'TWIN_PROJECTION_PAYLOAD_CONFLICT' as const;
  constructor(readonly sourceKey: string) { super('同一 Twin 来源修订存在不同载荷'); }
}

export interface ManufacturingContextStore {
  upsertEntity(input: UpsertTwinEntityInput): TwinEntity;
  getEntity(entityId: string): TwinEntity | undefined;
  getByBusinessObjectId(businessObjectId: string): TwinEntity | undefined;
  upsertRelation(input: UpsertTwinRelationInput): TwinRelation;
  appendEvidence(input: AppendTwinEvidenceInput): TwinEvidence;
  listEvidence(entityId: string): TwinEvidence[];
  resolveFact(entityId: string, factPath: string): TwinResolvedFact | undefined;
  getNeighborhood(rootEntityId: string, options: { depth: 1 | 2; entityLimit: number; evidenceLimit: number }): TwinNeighborhood;
  createSnapshot(input: CreateTwinSnapshotInput): TwinSnapshot;
  getSnapshot(snapshotId: string): TwinSnapshot | undefined;
  appendAgentEvent(event: AppendTwinAgentEventInput): TwinAgentEvent;
}
