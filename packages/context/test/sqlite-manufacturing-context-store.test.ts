import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import { contextSourceWatermark, stableTwinEntityId } from '../src/context-identity.js';
import { resolveTwinFact, SqliteManufacturingContextStore } from '../src/sqlite-manufacturing-context-store.js';

const at = '2026-08-21T00:00:00.000Z';

function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  return db;
}

function entityInput(overrides: Record<string, unknown> = {}) {
  return {
    entityType: 'purchase_order' as const,
    canonicalKey: 'readywork:po:1',
    label: 'PO-1',
    lifecycleState: 'sent',
    attributes: { businessObjectId: 'po:1', commercialTerm: 'NET30' },
    state: { status: 'sent' },
    sourceWatermark: 'w1',
    effectiveAt: at,
    observedAt: at,
    ...overrides,
  };
}

test('stable Twin identities and aggregate source watermarks are deterministic', () => {
  assert.equal(
    stableTwinEntityId('tenant:a', 'purchase_order', 'readywork:po:1'),
    stableTwinEntityId('tenant:a', 'purchase_order', 'readywork:po:1'),
  );
  assert.notEqual(
    stableTwinEntityId('tenant:a', 'purchase_order', 'readywork:po:1'),
    stableTwinEntityId('tenant:b', 'purchase_order', 'readywork:po:1'),
  );

  const a = { sourceTable: 'procurement_documents', sourceKey: 'po:1', sourceRevision: '7', sourceHash: 'h-po' };
  const b = { sourceTable: 'procurement_lines', sourceKey: 'line:1', sourceRevision: '2', sourceHash: 'h-line' };
  assert.equal(contextSourceWatermark([a, b]), contextSourceWatermark([b, a]));
  assert.notEqual(contextSourceWatermark([a]), contextSourceWatermark([{ ...a, sourceRevision: '8' }]));
});

test('pure fact resolution preserves conflicting evidence in deterministic precedence order', () => {
  const evidence = (id: string, priority: 100 | 200 | 300 | 400, sourceVersion: string, value: unknown) => ({
    tenantId: 'tenant:a', id, entityId: 'entity:1', sourceSemantics: 'deterministic' as const,
    sourceKind: 'test', sourceId: id, sourceVersion, sourceHash: `hash:${id}`,
    factPath: 'purchase_order.status', value, priority, confidence: 1,
    effectiveAt: at, observedAt: at, actorId: 'system', rawReference: {}, createdAt: at,
  });
  const selected = evidence('evidence:selected', 400, '2', 'sent');
  const resolved = resolveTwinFact([
    evidence('evidence:model', 100, '9', 'confirmed'),
    evidence('evidence:older', 400, '1', 'draft'),
    selected,
  ], 'purchase_order.status');

  assert.equal(resolved?.evidence.id, 'evidence:selected');
  assert.deepEqual(resolved?.conflicts.map((item) => item.id), ['evidence:older', 'evidence:model']);
});

test('entity upserts keep a stable ID, advance revisions, and remain tenant scoped', () => {
  const db = createDb();
  const tenantA = new SqliteManufacturingContextStore(db, 'tenant:a');
  const first = tenantA.upsertEntity(entityInput());
  const second = tenantA.upsertEntity(entityInput({ label: 'PO-1 revised', sourceWatermark: 'w2' }));

  assert.equal(first.id, second.id);
  assert.equal(first.currentRevision, 1);
  assert.equal(second.currentRevision, 2);
  assert.equal(second.label, 'PO-1 revised');
  assert.equal(tenantA.getByBusinessObjectId('po:1')?.id, first.id);
  assert.equal(new SqliteManufacturingContextStore(db, 'tenant:b').getEntity(first.id), undefined);
  assert.equal(new SqliteManufacturingContextStore(db, 'tenant:b').getByBusinessObjectId('po:1'), undefined);
  db.close();
});

test('entity upsert rejects nested non-JSON values before writing any row', () => {
  const db = createDb();
  const store = new SqliteManufacturingContextStore(db, 'tenant:a');
  let message = '';
  try {
    store.upsertEntity(entityInput({ attributes: { nested: { invalid: undefined } } }));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  const count = Number((db.prepare('SELECT COUNT(*) AS count FROM twin_entities WHERE tenant_id=?')
    .get('tenant:a') as { count: number }).count);

  assert.deepEqual({ message, count }, { message: 'Twin JSON 值无效', count: 0 });
  db.close();
});

test('every Twin JSON write rejects unsupported recursive values with one stable error', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const symbolKey = { [Symbol('hidden')]: 'secret' };
  const nonEnumerable: Record<string, unknown> = {};
  Object.defineProperty(nonEnumerable, 'hidden', { value: 'secret', enumerable: false });
  const sparse = new Array<unknown>(1);
  const extendedArray: unknown[] & { hidden?: string } = [];
  extendedArray.hidden = 'secret';
  const unsupported: readonly unknown[] = [
    undefined, () => undefined, Symbol('secret'), 1n, Number.NaN, Number.POSITIVE_INFINITY,
    new Date(at), circular, [true, { invalid: undefined }], symbolKey, nonEnumerable, sparse, extendedArray,
  ];
  for (const [index, invalid] of unsupported.entries()) {
    const db = createDb();
    const store = new SqliteManufacturingContextStore(db, 'tenant:a');
    assert.throws(
      () => store.upsertEntity(entityInput({
        canonicalKey: `readywork:po:invalid:${index}`,
        attributes: { nested: invalid },
      })),
      (error: unknown) => error instanceof Error && error.message === 'Twin JSON 值无效',
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM twin_entities WHERE tenant_id=?')
      .get('tenant:a') as { count: number }).count, 0);
    db.close();
  }

  const db = createDb();
  const store = new SqliteManufacturingContextStore(db, 'tenant:a');
  const entity = store.upsertEntity(entityInput());
  const evidence = {
    entityId: entity.id,
    sourceSemantics: 'deterministic' as const,
    sourceKind: 'readywork', sourceId: 'po:invalid', sourceVersion: '1', sourceHash: 'invalid',
    factPath: 'purchase_order.status', value: 'sent', confidence: 1,
    effectiveAt: at, observedAt: at, actorId: 'system', rawReference: {},
  };
  assert.throws(
    () => store.upsertEntity(entityInput({ canonicalKey: 'readywork:po:invalid-state', state: { invalid: Number.NaN } })),
    (error: unknown) => error instanceof Error && error.message === 'Twin JSON 值无效',
  );
  assert.throws(
    () => store.appendEvidence({ ...evidence, value: { invalid: undefined } }),
    (error: unknown) => error instanceof Error && error.message === 'Twin JSON 值无效',
  );
  assert.throws(
    () => store.appendEvidence({ ...evidence, rawReference: { invalid: () => undefined } }),
    (error: unknown) => error instanceof Error && error.message === 'Twin JSON 值无效',
  );
  assert.throws(
    () => store.appendAgentEvent({
      employeeId: 'ai:buyer', runId: 'run:invalid', taskId: 'task:invalid', entityId: entity.id,
      eventType: 'context_read', status: 'failed', evidenceIds: [],
      payload: { invalid: Symbol('secret') }, createdAt: at,
    }),
    (error: unknown) => error instanceof Error && error.message === 'Twin JSON 值无效',
  );
  assert.throws(
    () => store.createSnapshot({
      employeeId: 'ai:buyer', rootEntityId: entity.id, purpose: 'invalid',
      scope: {
        permission: 'read', entityTypes: ['purchase_order', undefined] as never,
        includeContactDetails: false, includeCommercialTerms: false,
      },
    }),
    (error: unknown) => error instanceof Error && error.message === 'Twin JSON 值无效',
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM twin_entities WHERE tenant_id=?')
    .get('tenant:a') as { count: number }).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM twin_evidence WHERE tenant_id=?')
    .get('tenant:a') as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM twin_agent_events WHERE tenant_id=?')
    .get('tenant:a') as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM twin_snapshots WHERE tenant_id=?')
    .get('tenant:a') as { count: number }).count, 0);
  db.close();
});

test('SQLite Twin keeps evidence immutable and resolves external facts above model facts', () => {
  const db = createDb();
  const store = new SqliteManufacturingContextStore(db, 'tenant:a');
  const entity = store.upsertEntity(entityInput());
  const model = store.appendEvidence({
    entityId: entity.id,
    sourceSemantics: 'model_derived',
    sourceKind: 'llm',
    sourceId: 'run:1',
    sourceVersion: '1',
    sourceHash: 'h-model',
    factPath: 'purchase_order.status',
    value: 'confirmed',
    confidence: 0.99,
    effectiveAt: at,
    observedAt: at,
    actorId: 'ai:po',
    rawReference: {},
  });
  const external = store.appendEvidence({
    entityId: entity.id,
    sourceSemantics: 'verified_external',
    sourceKind: 'odoo',
    sourceId: 'purchase.order:1',
    sourceVersion: '7',
    sourceHash: 'h-odoo',
    factPath: 'purchase_order.status',
    value: 'sent',
    confidence: 1,
    effectiveAt: at,
    observedAt: at,
    actorId: 'source:odoo',
    rawReference: { table: 'procurement_documents', id: 'po:1' },
  });

  const resolved = store.resolveFact(entity.id, 'purchase_order.status');
  assert.equal(model.priority, 100);
  assert.equal(external.priority, 400);
  assert.equal(resolved?.value, 'sent');
  assert.equal(resolved?.evidence.id, external.id);
  assert.deepEqual(resolved?.conflicts.map((item) => item.id), [model.id]);
  assert.equal(store.listEvidence(entity.id).length, 2);
  assert.equal(new SqliteManufacturingContextStore(db, 'tenant:b').resolveFact(entity.id, 'purchase_order.status'), undefined);
  db.close();
});

test('evidence append validates confidence and cannot overwrite an idempotent row', () => {
  const db = createDb();
  const store = new SqliteManufacturingContextStore(db, 'tenant:a');
  const entity = store.upsertEntity(entityInput());
  const evidence = {
    entityId: entity.id,
    sourceSemantics: 'deterministic' as const,
    sourceKind: 'readywork',
    sourceId: 'po:1',
    sourceVersion: '1',
    sourceHash: 'h1',
    factPath: 'purchase_order.status',
    value: 'sent',
    confidence: 1,
    effectiveAt: at,
    observedAt: at,
    actorId: 'system',
    rawReference: {},
  };
  const first = store.appendEvidence(evidence);
  const replay = store.appendEvidence({ ...evidence, value: 'changed', confidence: 0.2 });

  assert.equal(first.priority, 200);
  assert.equal(replay.id, first.id);
  assert.equal(replay.value, 'sent');
  assert.equal(replay.confidence, 1);
  assert.equal(store.listEvidence(entity.id).length, 1);
  assert.throws(() => store.appendEvidence({ ...evidence, sourceVersion: '2', confidence: Number.NaN }), /confidence|0.*1|信心/i);
  assert.throws(() => store.appendEvidence({ ...evidence, sourceVersion: '2', confidence: 1.01 }), /confidence|0.*1|信心/i);
  db.close();
});

test('fact resolution applies source version, effective time, observed time, then ID precedence', () => {
  const db = createDb();
  const store = new SqliteManufacturingContextStore(db, 'tenant:a');
  const entity = store.upsertEntity(entityInput());
  const insert = db.prepare(`INSERT INTO twin_evidence
    (tenant_id,id,entity_id,relation_id,source_semantics,source_kind,source_id,source_version,source_hash,fact_path,value_json,priority,confidence,effective_at,observed_at,actor_id,raw_reference_json,supersedes_evidence_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const row = (id: string, version: string, effectiveAt: string, observedAt: string, value: string) => insert.run(
    'tenant:a', id, entity.id, null, 'deterministic', 'test', id, version, `hash:${id}`,
    'purchase_order.term', JSON.stringify(value), 200, 1, effectiveAt, observedAt, 'system', '{}', null, at,
  );
  row('evidence:z-old-version', '1', '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z', 'old-version');
  row('evidence:z-old-effective', '2', '2026-08-20T00:00:00.000Z', '2026-08-30T00:00:00.000Z', 'old-effective');
  row('evidence:z-old-observed', '2', '2026-08-21T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 'old-observed');
  row('evidence:z-id', '2', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z', 'larger-id');
  row('evidence:a-id', '2', '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z', 'selected');

  const resolved = store.resolveFact(entity.id, 'purchase_order.term');
  assert.equal(resolved?.value, 'selected');
  assert.equal(resolved?.evidence.id, 'evidence:a-id');
  assert.deepEqual(resolved?.conflicts.map((item) => item.id), [
    'evidence:z-id', 'evidence:z-old-observed', 'evidence:z-old-effective', 'evidence:z-old-version',
  ]);
  db.close();
});

test('store, conflict construction and snapshot agree that numeric source version 10 is newer than 9', () => {
  const db = createDb();
  const store = new SqliteManufacturingContextStore(db, 'tenant:a');
  const entity = store.upsertEntity(entityInput());
  const append = (version: string, value: string) => store.appendEvidence({
    entityId: entity.id, sourceSemantics: 'deterministic', sourceKind: 'odoo', sourceId: `status:${version}`,
    sourceVersion: version, sourceHash: `hash:${version}`, factPath: 'purchase_order.status', value,
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'system', rawReference: {},
  });
  const version9 = append('9', 'draft');
  const version10 = append('10', 'sent');

  assert.deepEqual(store.listEvidence(entity.id).map((item) => item.id), [version10.id, version9.id]);
  assert.equal(store.resolveFact(entity.id, 'purchase_order.status')?.evidence.id, version10.id);
  const neighborhood = store.getNeighborhood(entity.id, { depth: 1, entityLimit: 10, evidenceLimit: 10 });
  assert.deepEqual(neighborhood.evidence.map((item) => item.id), [version10.id, version9.id]);
  assert.equal(neighborhood.conflicts[0]?.selectedEvidenceId, version10.id);
  const snapshot = store.createSnapshot({
    employeeId: 'ai:ordering', rootEntityId: entity.id, purpose: 'ordering',
    scope: { permission: 'read', entityTypes: ['purchase_order'], includeContactDetails: false, includeCommercialTerms: false },
  });
  assert.equal(snapshot.snapshot['root']['facts']['purchase_order.status']['evidenceId'], version10.id);
  assert.deepEqual(snapshot.snapshot['evidence'].map((item: Record<string, unknown>) => item['id']), [version10.id, version9.id]);
  db.close();
});

test('relations require both endpoints in the bound tenant and upsert deterministically', () => {
  const db = createDb();
  const tenantA = new SqliteManufacturingContextStore(db, 'tenant:a');
  const tenantB = new SqliteManufacturingContextStore(db, 'tenant:b');
  const from = tenantA.upsertEntity(entityInput());
  const to = tenantA.upsertEntity(entityInput({
    entityType: 'supplier', canonicalKey: 'readywork:supplier:1', label: '供应商 A', attributes: {}, state: {},
  }));
  const foreign = tenantB.upsertEntity(entityInput({ canonicalKey: 'readywork:po:foreign' }));
  const relation = tenantA.upsertRelation({
    relationType: 'ordered_from', fromEntityId: from.id, toEntityId: to.id, status: 'active',
    sourceEvidenceId: 'evidence:source', validFrom: at,
  });
  const updated = tenantA.upsertRelation({
    relationType: 'ordered_from', fromEntityId: from.id, toEntityId: to.id, status: 'disputed',
    sourceEvidenceId: 'evidence:source', validFrom: at, validTo: '2026-08-22T00:00:00.000Z',
  });

  assert.equal(updated.id, relation.id);
  assert.equal(updated.status, 'disputed');
  assert.throws(() => tenantA.upsertRelation({
    relationType: 'invalid', fromEntityId: from.id, toEntityId: foreign.id, status: 'active',
    sourceEvidenceId: 'evidence:source', validFrom: at,
  }), /endpoint|entity|端点|实体/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM twin_relations WHERE tenant_id=?').get('tenant:a')?.count, 1);
  db.close();
});

test('neighborhood, snapshots, and agent events are persisted without crossing tenants', () => {
  const db = createDb();
  const tenantA = new SqliteManufacturingContextStore(db, 'tenant:a');
  const root = tenantA.upsertEntity(entityInput());
  const supplier = tenantA.upsertEntity(entityInput({
    entityType: 'supplier', canonicalKey: 'readywork:supplier:1', label: '供应商 A', attributes: {}, state: {},
  }));
  tenantA.upsertRelation({
    relationType: 'ordered_from', fromEntityId: root.id, toEntityId: supplier.id, status: 'active',
    sourceEvidenceId: 'evidence:source', validFrom: at,
  });
  const evidence = tenantA.appendEvidence({
    entityId: root.id, sourceSemantics: 'verified_external', sourceKind: 'odoo', sourceId: 'po:1',
    sourceVersion: '7', sourceHash: 'h7', factPath: 'purchase_order.status', value: 'sent', confidence: 1,
    effectiveAt: at, observedAt: at, actorId: 'source:odoo', rawReference: {},
  });
  const event = tenantA.appendAgentEvent({
    employeeId: 'ai:buyer', runId: 'run:1', taskId: 'task:1', businessObjectId: 'po:1', entityId: root.id,
    eventType: 'context_read', status: 'completed', confidence: 1, evidenceIds: [evidence.id],
    payload: { purpose: 'review' }, createdAt: at,
  });
  const neighborhood = tenantA.getNeighborhood(root.id, { depth: 1, entityLimit: 10, evidenceLimit: 10 });

  assert.equal(neighborhood.root.id, root.id);
  assert.deepEqual(neighborhood.entities.map((item) => item.id).sort(), [root.id, supplier.id].sort());
  assert.equal(neighborhood.relations.length, 1);
  assert.equal(neighborhood.evidence[0]?.id, evidence.id);
  assert.equal(neighborhood.agentEvents[0]?.id, event.id);
  assert.equal(neighborhood.truncated, false);
  assert.equal(neighborhood.nextCursor, null);
  assert.match(neighborhood.sourceWatermark, /^[a-f0-9]{64}$/);

  const snapshot = tenantA.createSnapshot({
    employeeId: 'ai:buyer', rootEntityId: root.id, purpose: 'review',
    scope: { permission: 'read', entityTypes: ['purchase_order', 'supplier'], includeContactDetails: false, includeCommercialTerms: false },
  });
  assert.equal(tenantA.getSnapshot(snapshot.id)?.contentHash, snapshot.contentHash);
  assert.equal(new SqliteManufacturingContextStore(db, 'tenant:b').getSnapshot(snapshot.id), undefined);
  assert.throws(
    () => new SqliteManufacturingContextStore(db, 'tenant:b').getNeighborhood(root.id, { depth: 1, entityLimit: 10, evidenceLimit: 10 }),
    /root|entity|根|实体/i,
  );
  db.close();
});
