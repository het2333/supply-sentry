import type {
  TwinAccessScope,
  TwinAgentEvent,
  TwinEntity,
  TwinEvidence,
  TwinNeighborhood,
  TwinRelation,
} from '@readywork/core';
import { compareTwinEvidencePrecedence } from '@readywork/core';
import {
  isCommercialFieldName,
  isRestrictedFieldName,
  sanitizeContextValue,
  scopeForSession,
  type ContextAccessScope,
} from './context-access-policy.js';

export const TWIN_SNAPSHOT_MAX_BYTES = 512 * 1024;
export const TWIN_SNAPSHOT_DEPTH = 2 as const;
export const TWIN_SNAPSHOT_ENTITY_LIMIT = 500;
export const TWIN_SNAPSHOT_EVIDENCE_LIMIT = 2_000;
export const TWIN_SNAPSHOT_RECENT_AGENT_EVENT_LIMIT = 50;

type JsonObject = Record<string, any>;

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Twin JSON 值无效');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('Twin JSON 值无效');
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function canonicalize(value: unknown): any {
  if (Array.isArray(value)) {
    return value.map(canonicalize).map((item) => ({ item, key: stableJson(item) }))
      .sort((left, right) => left.key === right.key ? 0 : left.key < right.key ? -1 : 1)
      .map(({ item }) => item);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Twin JSON 值无效');
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Twin JSON 值无效');
  return value;
}

function policy(scope: TwinAccessScope, purpose: string): ContextAccessScope {
  return scopeForSession(scope.permission, {
    entityTypes: scope.entityTypes,
    purpose,
  });
}

function sanitize(value: unknown, scope: TwinAccessScope, path: readonly string[] = []): any {
  return sanitizeContextValue(value, {
    includeContactDetails: scope.includeContactDetails,
    includeCommercialTerms: scope.includeCommercialTerms,
  }, path);
}

function sanitizeFactValue(
  value: unknown,
  factPath: string,
  scope: TwinAccessScope,
  path: readonly string[],
): any {
  const segments = factPath.split(/[.\/\[\]]+/).filter((segment) => segment.length > 0);
  const valueKey = segments.at(-1);
  if (!valueKey) throw new Error('Twin factPath 结构不受支持');
  const wrapped = sanitize({ [valueKey]: value }, scope, [...path, ...segments.slice(0, -1)]);
  if (!Object.prototype.hasOwnProperty.call(wrapped, valueKey)) {
    throw new Error('Twin factPath 在当前范围不可见');
  }
  return wrapped[valueKey];
}

function presentEntity(entity: TwinEntity, scope: TwinAccessScope): JsonObject {
  return sanitize({
    id: entity.id,
    entityType: entity.entityType,
    canonicalKey: entity.canonicalKey,
    label: entity.label,
    lifecycleState: entity.lifecycleState,
    attributes: entity.attributes,
    state: entity.state,
    currentRevision: entity.currentRevision,
    sourceWatermark: entity.sourceWatermark,
    effectiveAt: entity.effectiveAt,
    observedAt: entity.observedAt,
  }, scope, ['entities', entity.id]);
}

function presentRelation(relation: TwinRelation, scope: TwinAccessScope): JsonObject {
  return sanitize({
    id: relation.id,
    relationType: relation.relationType,
    fromEntityId: relation.fromEntityId,
    toEntityId: relation.toEntityId,
    status: relation.status,
    sourceEvidenceId: relation.sourceEvidenceId,
    validFrom: relation.validFrom,
    ...(relation.validTo === undefined ? {} : { validTo: relation.validTo }),
  }, scope, ['relations', relation.id]);
}

function factPathAllowed(factPath: string, scope: TwinAccessScope): boolean {
  if (isRestrictedFieldName(factPath)) return false;
  return scope.includeCommercialTerms || !factPath.split('.').some(isCommercialFieldName);
}

function normalizedRawReference(evidence: TwinEvidence, scope: TwinAccessScope): JsonObject {
  const reference = evidence.rawReference;
  const value = (key: string, fallback: string): string => {
    const candidate = reference[key];
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : fallback;
  };
  return sanitize({
    table: value('table', evidence.sourceKind),
    primaryKey: value('primaryKey', evidence.sourceId),
    sourceVersion: value('sourceVersion', evidence.sourceVersion),
    contentHash: value('contentHash', evidence.sourceHash),
  }, scope, ['evidence', evidence.id, 'rawReference']);
}

function presentEvidence(
  evidence: TwinEvidence,
  scope: TwinAccessScope,
  retainedEvidenceIds: ReadonlySet<string>,
): JsonObject | undefined {
  if (!factPathAllowed(evidence.factPath, scope)) return undefined;
  return sanitize({
    id: evidence.id,
    ...(evidence.entityId === undefined ? {} : { entityId: evidence.entityId }),
    ...(evidence.relationId === undefined ? {} : { relationId: evidence.relationId }),
    sourceSemantics: evidence.sourceSemantics,
    sourceKind: evidence.sourceKind,
    sourceId: evidence.sourceId,
    sourceVersion: evidence.sourceVersion,
    sourceHash: evidence.sourceHash,
    factPath: evidence.factPath,
    value: sanitizeFactValue(evidence.value, evidence.factPath, scope, ['evidence', evidence.id, 'value']),
    priority: evidence.priority,
    confidence: evidence.confidence,
    effectiveAt: evidence.effectiveAt,
    observedAt: evidence.observedAt,
    actorId: evidence.actorId,
    rawReference: normalizedRawReference(evidence, scope),
    ...(evidence.supersedesEvidenceId === undefined || !retainedEvidenceIds.has(evidence.supersedesEvidenceId)
      ? {} : { supersedesEvidenceId: evidence.supersedesEvidenceId }),
  }, scope, ['evidence', evidence.id]);
}

function presentAgentEvent(event: TwinAgentEvent, scope: TwinAccessScope): JsonObject {
  return sanitize({
    id: event.id,
    employeeId: event.employeeId,
    ...(event.temporalWorkflowId === undefined ? {} : { temporalWorkflowId: event.temporalWorkflowId }),
    runId: event.runId,
    taskId: event.taskId,
    ...(event.businessObjectId === undefined ? {} : { businessObjectId: event.businessObjectId }),
    ...(event.entityId === undefined ? {} : { entityId: event.entityId }),
    eventType: event.eventType,
    ...(event.inputSnapshotId === undefined ? {} : { inputSnapshotId: event.inputSnapshotId }),
    ...(event.model === undefined ? {} : { model: event.model }),
    ...(event.reasoningProfile === undefined ? {} : { reasoningProfile: event.reasoningProfile }),
    ...(event.promptHash === undefined ? {} : { promptHash: event.promptHash }),
    ...(event.responseHash === undefined ? {} : { responseHash: event.responseHash }),
    ...(event.actionName === undefined ? {} : { actionName: event.actionName }),
    status: event.status,
    ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
    evidenceIds: event.evidenceIds,
    payload: event.payload,
    createdAt: event.createdAt,
  }, scope, ['agentEvents', event.id]);
}

function rootFacts(rootId: string, evidence: readonly TwinEvidence[], scope: TwinAccessScope): JsonObject {
  const facts: JsonObject = {};
  for (const item of [...evidence].filter((candidate) => candidate.entityId === rootId).sort(compareTwinEvidencePrecedence)) {
    if (facts[item.factPath] !== undefined || !factPathAllowed(item.factPath, scope)) continue;
    facts[item.factPath] = sanitize({
      value: sanitizeFactValue(item.value, item.factPath, scope, ['root', 'facts', item.factPath, 'value']),
      evidenceId: item.id,
      sourceSemantics: item.sourceSemantics,
      confidence: item.confidence,
      effectiveAt: item.effectiveAt,
      observedAt: item.observedAt,
    }, scope, ['root', 'facts', item.factPath]);
  }
  return facts;
}

function auxiliaryValues(evidence: readonly TwinEvidence[], matcher: RegExp, scope: TwinAccessScope): unknown[] {
  return evidence.filter((item) => matcher.test(item.factPath) && factPathAllowed(item.factPath, scope))
    .sort(compareTwinEvidencePrecedence)
    .map((item) => sanitizeFactValue(item.value, item.factPath, scope, ['state', item.factPath]));
}

function missingFacts(neighborhood: TwinNeighborhood): string[] {
  if (neighborhood.missingFacts.length > 0) return [...neighborhood.missingFacts];
  const value = neighborhood.root.state['missingFacts'];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

interface CandidateInput {
  neighborhood: TwinNeighborhood;
  scope: ContextAccessScope;
  allEntities: readonly TwinEntity[];
  allEvidence: readonly TwinEvidence[];
  entities: readonly TwinEntity[];
  evidence: readonly TwinEvidence[];
}

function firstOmittedId<T extends { id: string }>(all: readonly T[], retainedIds: ReadonlySet<string>): string | null {
  return all.find((item) => !retainedIds.has(item.id))?.id ?? null;
}

function closeRetainedGraph(
  initialRelations: readonly TwinRelation[],
  initialEvidence: readonly TwinEvidence[],
): { relations: readonly TwinRelation[]; evidence: readonly TwinEvidence[]; evidenceIds: ReadonlySet<string> } {
  let relations = initialRelations;
  let evidence = initialEvidence;
  const maximumIterations = relations.length + evidence.length + 1;
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    const evidenceIds = new Set(evidence.map((item) => item.id));
    const nextRelations = relations.filter((item) => evidenceIds.has(item.sourceEvidenceId));
    const relationIds = new Set(nextRelations.map((item) => item.id));
    const nextEvidence = evidence.filter((item) => item.relationId === undefined || relationIds.has(item.relationId));
    if (nextRelations.length === relations.length && nextEvidence.length === evidence.length) {
      return {
        relations: nextRelations,
        evidence: nextEvidence,
        evidenceIds: new Set(nextEvidence.map((item) => item.id)),
      };
    }
    relations = nextRelations;
    evidence = nextEvidence;
  }
  throw new Error('Twin 快照图闭包未能收敛');
}

function candidate(input: CandidateInput): JsonObject {
  const { neighborhood, scope, entities } = input;
  const includedIds = new Set(entities.map((item) => item.id));
  const endpointRelations = [...neighborhood.relations]
    .sort((left, right) => left.id.localeCompare(right.id))
    .filter((item) => includedIds.has(item.fromEntityId) && includedIds.has(item.toEntityId));
  const entityEvidence = input.evidence.filter((item) => (
    factPathAllowed(item.factPath, scope)
    && (item.entityId === undefined || includedIds.has(item.entityId))
  ));
  const closed = closeRetainedGraph(endpointRelations, entityEvidence);
  const relations = closed.relations;
  const evidence = closed.evidence;
  const evidenceIds = closed.evidenceIds;

  const allAgentEvents = [...neighborhood.agentEvents]
    .filter((item) => item.entityId === undefined || includedIds.has(item.entityId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const agentEvents = allAgentEvents.slice(0, TWIN_SNAPSHOT_RECENT_AGENT_EVENT_LIMIT);
  const root = presentEntity(neighborhood.root, scope);
  root['facts'] = rootFacts(neighborhood.root.id, evidence, scope);
  const conflicts = neighborhood.conflicts
    .filter((item) => evidenceIds.has(item.selectedEvidenceId)
      && item.conflictingEvidenceIds.length > 0
      && item.conflictingEvidenceIds.every((id) => evidenceIds.has(id))
      && factPathAllowed(item.factPath, scope));
  const entityIds = new Set(entities.map((item) => item.id));
  const relationOutputIds = new Set(relations.map((item) => item.id));
  const eventIds = new Set(agentEvents.map((item) => item.id));
  const cursors = {
    entities: firstOmittedId(input.allEntities, entityIds),
    evidence: firstOmittedId(input.allEvidence, evidenceIds),
    relations: firstOmittedId(
      [...neighborhood.relations].sort((left, right) => left.id.localeCompare(right.id)),
      relationOutputIds,
    ),
    agentEvents: firstOmittedId(allAgentEvents, eventIds),
    neighborhood: neighborhood.truncated
      ? (neighborhood.nextCursor ?? 'neighborhood:depth=2:entities=500:evidence=2000') : null,
  };
  const output: JsonObject = {
    schemaVersion: 'manufacturing-context/v1',
    root,
    entities: entities.map((item) => presentEntity(item, scope)),
    relations: relations.map((item) => presentRelation(item, scope)),
    evidence: evidence.map((item) => presentEvidence(item, scope, evidenceIds))
      .filter((item): item is JsonObject => item !== undefined),
    conflicts: sanitize(conflicts, scope, ['conflicts']),
    missingFacts: sanitize(missingFacts(neighborhood), scope, ['missingFacts']),
    stage: auxiliaryValues(evidence, /stage/i, scope),
    sla: [
      ...entities.filter((item) => item.entityType === 'sla_evaluation').map((item) => presentEntity(item, scope)),
      ...auxiliaryValues(evidence, /sla/i, scope),
    ],
    approvals: auxiliaryValues(evidence, /approval/i, scope),
    outbox: auxiliaryValues(evidence, /outbox/i, scope),
    agentEvents: agentEvents.map((item) => presentAgentEvent(item, scope)),
    sourceWatermark: neighborhood.sourceWatermark,
    scope,
    truncated: neighborhood.truncated || Object.values(cursors).some((cursor) => cursor !== null),
    cursors,
    nextCursor: cursors.evidence ?? cursors.entities ?? cursors.relations
      ?? cursors.agentEvents ?? cursors.neighborhood,
  };
  if (scope.includeProjectionHealth) {
    output['projectionHealth'] = {
      sourceWatermark: neighborhood.sourceWatermark,
      entityCount: entities.length,
      evidenceCount: evidence.length,
      neighborhoodTruncated: neighborhood.truncated,
    };
  }
  const normalized = canonicalize(output);
  normalized['evidence'] = (normalized['evidence'] as TwinEvidence[]).sort(compareTwinEvidencePrecedence);
  return normalized;
}

function serializedBytes(value: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function largestFittingPrefix(length: number, build: (length: number) => JsonObject): { length: number; value: JsonObject } {
  let low = 0;
  let high = length;
  let bestLength = 0;
  let best = build(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const current = build(middle);
    if (serializedBytes(current) <= TWIN_SNAPSHOT_MAX_BYTES) {
      bestLength = middle;
      best = current;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { length: bestLength, value: best };
}

export function buildTwinSnapshot(
  neighborhood: TwinNeighborhood,
  requestedScope: TwinAccessScope,
  purpose = '',
): JsonObject {
  const scope = policy(requestedScope, purpose);
  const entityTypes = new Set(scope.entityTypes);
  const allNonRoot = neighborhood.entities
    .filter((item) => item.id !== neighborhood.root.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const nonRoot = allNonRoot
    .filter((item) => entityTypes.size === 0 || entityTypes.has(item.entityType))
    .sort((left, right) => left.id.localeCompare(right.id));
  const allEntities = [neighborhood.root, ...allNonRoot];
  const entities = [neighborhood.root, ...nonRoot].slice(0, TWIN_SNAPSHOT_ENTITY_LIMIT);
  const allEvidence = [...neighborhood.evidence].sort(compareTwinEvidencePrecedence);
  const evidence = allEvidence.slice(0, TWIN_SNAPSHOT_EVIDENCE_LIMIT);
  const base = (keptEntities: readonly TwinEntity[], keptEvidence: readonly TwinEvidence[]): CandidateInput => ({
    neighborhood,
    scope,
    allEntities,
    allEvidence,
    entities: keptEntities,
    evidence: keptEvidence,
  });
  const complete = candidate(base(entities, evidence));
  if (serializedBytes(complete) <= TWIN_SNAPSHOT_MAX_BYTES) return complete;

  const withoutEvidence = candidate(base(entities, []));
  if (serializedBytes(withoutEvidence) <= TWIN_SNAPSHOT_MAX_BYTES) {
    return largestFittingPrefix(evidence.length, (count) => candidate(base(entities, evidence.slice(0, count)))).value;
  }

  const rootOnly = candidate(base([neighborhood.root], []));
  if (serializedBytes(rootOnly) > TWIN_SNAPSHOT_MAX_BYTES) {
    throw new Error('Twin 根实体与 missingFacts 超过 512 KiB 快照上限');
  }
  return largestFittingPrefix(nonRoot.length, (count) => (
    candidate(base([neighborhood.root, ...nonRoot.slice(0, count)], []))
  )).value;
}

function storedRecord(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Twin 已存快照 ${label} 结构不受支持`);
  }
  return value as JsonObject;
}

function storedArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`Twin 已存快照 ${label} 结构不受支持`);
  }
  return value as JsonObject[];
}

function storedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Twin 已存快照 ${label} 结构不受支持`);
  return value;
}

function requireStoredJsonArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Twin 已存快照 ${label} 结构不受支持`);
  return value;
}

function sanitizedStoredEvidence(
  item: JsonObject,
  scope: TwinAccessScope,
): JsonObject {
  const id = storedString(item['id'], 'evidence.id');
  const factPath = storedString(item['factPath'], 'evidence.factPath');
  if (!Object.prototype.hasOwnProperty.call(item, 'value')) {
    throw new Error('Twin 已存快照 evidence.value 结构不受支持');
  }
  return sanitize({
    ...item,
    value: sanitizeFactValue(item['value'], factPath, scope, ['evidence', id, 'value']),
  }, scope, ['evidence', id]);
}

function storedAuxiliaryValues(
  evidence: readonly JsonObject[],
  matcher: RegExp,
  scope: TwinAccessScope,
): unknown[] {
  return evidence.flatMap((item) => {
    const factPath = storedString(item['factPath'], 'evidence.factPath');
    if (!matcher.test(factPath) || !factPathAllowed(factPath, scope)) return [];
    if (!Object.prototype.hasOwnProperty.call(item, 'value')) {
      throw new Error('Twin 已存快照 evidence.value 结构不受支持');
    }
    return [sanitizeFactValue(item['value'], factPath, scope, ['state', factPath])];
  });
}

/**
 * Produces a response-only monotonic reduction of an immutable v1 snapshot.
 * Unknown legacy shapes fail closed because their reference closure cannot be proven.
 */
export function reduceStoredTwinSnapshot(
  stored: Record<string, any>,
  requestedScope: TwinAccessScope,
  purpose = 'web_stored_snapshot_read',
): JsonObject {
  const allowedKeys = new Set([
    'schemaVersion', 'root', 'entities', 'relations', 'evidence', 'conflicts', 'missingFacts',
    'stage', 'sla', 'approvals', 'outbox', 'agentEvents', 'sourceWatermark', 'scope', 'truncated',
    'cursors', 'nextCursor', 'projectionHealth',
  ]);
  if (stored['schemaVersion'] !== 'manufacturing-context/v1'
    || Object.keys(stored).some((key) => !allowedKeys.has(key))) {
    throw new Error('Twin 已存快照版本或结构不受支持');
  }
  const scope = policy(requestedScope, purpose);
  const allowedEntityTypes = new Set(scope.entityTypes);
  const root = storedRecord(stored['root'], 'root');
  const rootId = storedString(root['id'], 'root.id');
  const rootType = storedString(root['entityType'], 'root.entityType');
  if (allowedEntityTypes.size > 0 && !allowedEntityTypes.has(rootType as TwinEntity['entityType'])) {
    throw new Error('Twin 已存快照根实体不在当前授权范围');
  }

  const entities = storedArray(stored['entities'], 'entities').filter((entity) => {
    storedString(entity['id'], 'entities.id');
    const entityType = storedString(entity['entityType'], 'entities.entityType');
    return allowedEntityTypes.size === 0 || allowedEntityTypes.has(entityType as TwinEntity['entityType']);
  });
  if (!entities.some((entity) => entity['id'] === rootId)) throw new Error('Twin 已存快照缺少根实体');
  const entityIds = new Set(entities.map((entity) => storedString(entity['id'], 'entities.id')));
  let relations = storedArray(stored['relations'], 'relations').filter((relation) => (
    entityIds.has(storedString(relation['fromEntityId'], 'relations.fromEntityId'))
      && entityIds.has(storedString(relation['toEntityId'], 'relations.toEntityId'))
  ));
  let evidence = storedArray(stored['evidence'], 'evidence').filter((item) => {
    storedString(item['id'], 'evidence.id');
    const factPath = storedString(item['factPath'], 'evidence.factPath');
    return factPathAllowed(factPath, scope)
      && (item['entityId'] === undefined || entityIds.has(storedString(item['entityId'], 'evidence.entityId')));
  });

  const maximumIterations = relations.length + evidence.length + 1;
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    const evidenceIds = new Set(evidence.map((item) => storedString(item['id'], 'evidence.id')));
    const nextRelations = relations.filter((relation) => evidenceIds.has(
      storedString(relation['sourceEvidenceId'], 'relations.sourceEvidenceId'),
    ));
    const relationIds = new Set(nextRelations.map((relation) => storedString(relation['id'], 'relations.id')));
    const nextEvidence = evidence.filter((item) => (
      item['relationId'] === undefined || relationIds.has(storedString(item['relationId'], 'evidence.relationId'))
    ));
    if (nextRelations.length === relations.length && nextEvidence.length === evidence.length) {
      relations = nextRelations;
      evidence = nextEvidence;
      break;
    }
    relations = nextRelations;
    evidence = nextEvidence;
    if (iteration === maximumIterations - 1) throw new Error('Twin 已存快照图闭包未能收敛');
  }

  const evidenceIds = new Set(evidence.map((item) => storedString(item['id'], 'evidence.id')));
  const rootFacts = storedRecord(root['facts'] ?? {}, 'root.facts');
  const { facts: _storedFacts, ...rootWithoutFacts } = root;
  const reducedRoot = sanitize(rootWithoutFacts, scope, ['root']);
  reducedRoot['facts'] = Object.fromEntries(Object.entries(rootFacts).filter(([factPath, item]) => {
    if (!factPathAllowed(factPath, scope)) return false;
    const fact = storedRecord(item, `root.facts.${factPath}`);
    return evidenceIds.has(storedString(fact['evidenceId'], `root.facts.${factPath}.evidenceId`));
  }).map(([factPath, item]) => {
    const fact = storedRecord(item, `root.facts.${factPath}`);
    if (!Object.prototype.hasOwnProperty.call(fact, 'value')) {
      throw new Error(`Twin 已存快照 root.facts.${factPath}.value 结构不受支持`);
    }
    return [factPath, sanitize({
      ...fact,
      value: sanitizeFactValue(fact['value'], factPath, scope, ['root', 'facts', factPath, 'value']),
    }, scope, ['root', 'facts', factPath])];
  }));

  const conflicts = storedArray(stored['conflicts'], 'conflicts').flatMap((item) => {
    const selectedEvidenceId = storedString(item['selectedEvidenceId'], 'conflicts.selectedEvidenceId');
    if (!evidenceIds.has(selectedEvidenceId) || !factPathAllowed(storedString(item['factPath'], 'conflicts.factPath'), scope)) return [];
    if (!Array.isArray(item['conflictingEvidenceIds'])) throw new Error('Twin 已存快照 conflicts 结构不受支持');
    const conflictingEvidenceIds = item['conflictingEvidenceIds']
      .map((id: unknown) => storedString(id, 'conflicts.conflictingEvidenceIds'))
      .filter((id: string) => evidenceIds.has(id));
    return conflictingEvidenceIds.length === 0 ? [] : [{ ...item, conflictingEvidenceIds }];
  });
  const agentEvents = storedArray(stored['agentEvents'], 'agentEvents').flatMap((event) => {
    if (event['entityId'] === undefined
      || !entityIds.has(storedString(event['entityId'], 'agentEvents.entityId'))) return [];
    if (!Array.isArray(event['evidenceIds'])) throw new Error('Twin 已存快照 agentEvents 结构不受支持');
    const originalEvidenceIds = event['evidenceIds']
      .map((id: unknown) => storedString(id, 'agentEvents.evidenceIds'));
    if (originalEvidenceIds.length === 0 || !originalEvidenceIds.every((id: string) => evidenceIds.has(id))) return [];
    return [sanitize({ ...event, evidenceIds: originalEvidenceIds }, scope, [
      'agentEvents', storedString(event['id'], 'agentEvents.id'),
    ])];
  });
  requireStoredJsonArray(stored['stage'], 'stage');
  requireStoredJsonArray(stored['sla'], 'sla');
  requireStoredJsonArray(stored['approvals'], 'approvals');
  requireStoredJsonArray(stored['outbox'], 'outbox');
  const sanitizedEntities = entities.map((entity) => sanitize(
    entity, scope, ['entities', storedString(entity['id'], 'entities.id')],
  ));
  const sanitizedEvidence = evidence.map((item) => sanitizedStoredEvidence(item, scope));
  const reduced = {
    schemaVersion: 'manufacturing-context/v1',
    root: reducedRoot,
    entities: sanitizedEntities,
    relations: relations.map((relation) => sanitize(relation, scope, ['relations', storedString(relation['id'], 'relations.id')])),
    evidence: sanitizedEvidence,
    conflicts: sanitize(conflicts, scope, ['conflicts']),
    missingFacts: sanitize(requireStoredJsonArray(stored['missingFacts'], 'missingFacts'), scope, ['missingFacts']),
    stage: storedAuxiliaryValues(evidence, /stage/i, scope),
    sla: [
      ...entities.flatMap((entity, index) => entity['entityType'] === 'sla_evaluation'
        ? [sanitizedEntities[index]] : []),
      ...storedAuxiliaryValues(evidence, /sla/i, scope),
    ],
    approvals: storedAuxiliaryValues(evidence, /approval/i, scope),
    outbox: storedAuxiliaryValues(evidence, /outbox/i, scope),
    agentEvents,
    sourceWatermark: storedString(stored['sourceWatermark'], 'sourceWatermark'),
    scope,
    truncated: stored['truncated'] === true,
    cursors: { entities: null, evidence: null, relations: null, agentEvents: null, neighborhood: null },
    nextCursor: null,
    ...(scope.includeProjectionHealth && stored['projectionHealth'] !== undefined
      ? { projectionHealth: sanitize(stored['projectionHealth'], scope, ['projectionHealth']) } : {}),
  };
  return canonicalize(reduced);
}

export function twinSnapshotSerializedBytes(snapshot: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
}
