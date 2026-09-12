import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import {
  SqliteManufacturingContextStore,
  SqliteTwinProjectionQueue,
} from '@readywork/context';
import {
  decideTwinCorrection,
  requestTwinCorrection,
  type ManufacturingContextCorrectionContext,
} from '../src/manufacturing-context-corrections.js';

const at = '2026-08-29T00:00:00.000Z';

function correctionFixture() {
  const persistence = openPersistence(':memory:', { tenantId: 'tenant:a' });
  const store = new SqliteManufacturingContextStore(persistence.db, 'tenant:a');
  const queue = new SqliteTwinProjectionQueue(persistence.db, 'tenant:a');
  const po = store.upsertEntity({
    entityType: 'purchase_order', canonicalKey: 'readywork:po:1', label: 'PO-1', lifecycleState: 'sent',
    attributes: { businessObjectId: 'po:1' }, state: {}, sourceWatermark: 'w1', effectiveAt: at, observedAt: at,
  });
  const context: ManufacturingContextCorrectionContext = { db: persistence.db, tenantId: 'tenant:a', store, queue };
  return { persistence, store, queue, po, context };
}

function request(fixture: ReturnType<typeof correctionFixture>, overrides: Record<string, unknown> = {}) {
  return requestTwinCorrection(fixture.context, {
    entityId: fixture.po.id,
    factPath: 'purchase_order.promised_at',
    oldValue: null,
    newValue: '2026-09-08T00:00:00.000Z',
    reason: '已核对供应商盖章确认',
    evidenceReference: 'attachment:confirmation:1',
    requestedBy: 'human:buyer',
    requesterPermission: 'operate',
    requestedAt: at,
    ...overrides,
  });
}

test('Twin correction requires operate and a nonempty evidence reference', () => {
  const fixture = correctionFixture();
  assert.throws(() => request(fixture, { requesterPermission: 'read' }), /operate/);
  assert.throws(() => request(fixture, { evidenceReference: '  ' }), /证据引用/);
  assert.equal(fixture.store.listEvidence(fixture.po.id).length, 0);
  fixture.persistence.close();
});

test('Twin correction requires a different approver and cannot hide external evidence', () => {
  const fixture = correctionFixture();
  fixture.store.appendEvidence({
    entityId: fixture.po.id, sourceSemantics: 'verified_external', sourceKind: 'connector',
    sourceId: 'po:1', sourceVersion: '1', sourceHash: 'external-v1', factPath: 'purchase_order.promised_at',
    value: '2026-09-09T00:00:00.000Z', confidence: 1, effectiveAt: at, observedAt: at,
    actorId: 'connector:erp', rawReference: { receipt: 'connector:po:1' },
  });
  const pending = request(fixture);
  assert.throws(() => decideTwinCorrection(fixture.context, {
    approvalId: pending.id, decision: 'approved', decidedBy: 'human:buyer', approverPermission: 'approve', decidedAt: at,
  }), /不能审批自己/);
  const approved = decideTwinCorrection(fixture.context, {
    approvalId: pending.id, decision: 'approved', decidedBy: 'human:manager', approverPermission: 'approve', decidedAt: at,
  });
  assert.equal(approved.status, 'approved');
  const resolved = fixture.store.resolveFact(fixture.po.id, 'purchase_order.promised_at')!;
  assert.equal(resolved.evidence.sourceSemantics, 'verified_external');
  assert.equal(resolved.conflicts.length, 1);
  assert.equal(resolved.conflicts[0]?.sourceSemantics, 'approved_human');
  assert.equal(resolved.conflicts[0]?.priority, 300);
  assert.equal(fixture.queue.status().queued, 1);
  assert.equal(fixture.persistence.activities.list('po:1').filter((activity) => activity.action === 'twin.correction_approved').length, 1);
  assert.equal(fixture.store.getNeighborhood(fixture.po.id, { depth: 1, entityLimit: 10, evidenceLimit: 10 })
    .agentEvents.some((event) => event.eventType === 'human_feedback'), true);
  fixture.persistence.close();
});

test('Twin correction decision is idempotent and rejects conflicting follow-up decisions', () => {
  const fixture = correctionFixture();
  const pending = request(fixture);
  const approved = decideTwinCorrection(fixture.context, {
    approvalId: pending.id, decision: 'approved', decidedBy: 'human:manager', approverPermission: 'approve', decidedAt: at,
  });
  const replayed = decideTwinCorrection(fixture.context, {
    approvalId: pending.id, decision: 'approved', decidedBy: 'human:manager', approverPermission: 'approve', decidedAt: at,
  });
  assert.deepEqual(replayed, approved);
  assert.equal(fixture.store.listEvidence(fixture.po.id).length, 1);
  assert.equal(fixture.queue.status().queued, 1);
  assert.throws(() => decideTwinCorrection(fixture.context, {
    approvalId: pending.id, decision: 'rejected', decidedBy: 'human:manager', approverPermission: 'approve', decidedAt: at,
  }), /冲突/);
  fixture.persistence.close();
});

test('Rejected Twin correction records the decision without correction evidence', () => {
  const fixture = correctionFixture();
  const pending = request(fixture);
  const rejected = decideTwinCorrection(fixture.context, {
    approvalId: pending.id, decision: 'rejected', decidedBy: 'human:manager', approverPermission: 'approve', decidedAt: at,
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(fixture.store.listEvidence(fixture.po.id).length, 0);
  assert.equal(fixture.queue.status().queued, 0);
  assert.equal(fixture.persistence.activities.list('po:1').filter((activity) => activity.action === 'twin.correction_rejected').length, 1);
  fixture.persistence.close();
});

test('Twin correction decisions are tenant-bound', () => {
  const fixture = correctionFixture();
  const pending = request(fixture);
  const otherContext: ManufacturingContextCorrectionContext = {
    ...fixture.context,
    tenantId: 'tenant:b',
    store: new SqliteManufacturingContextStore(fixture.persistence.db, 'tenant:b'),
    queue: new SqliteTwinProjectionQueue(fixture.persistence.db, 'tenant:b'),
  };
  assert.throws(() => decideTwinCorrection(otherContext, {
    approvalId: pending.id, decision: 'approved', decidedBy: 'human:manager', approverPermission: 'approve', decidedAt: at,
  }), /不存在或不属于当前租户/);
  assert.equal(fixture.store.listEvidence(fixture.po.id).length, 0);
  fixture.persistence.close();
});

test('Twin correction rejects a Store bound to a different tenant', () => {
  const fixture = correctionFixture();
  const otherStore = new SqliteManufacturingContextStore(fixture.persistence.db, 'tenant:b');
  const otherPo = otherStore.upsertEntity({
    entityType: 'purchase_order', canonicalKey: 'readywork:po:other', label: 'PO-other', lifecycleState: 'sent',
    attributes: { businessObjectId: 'po:other' }, state: {}, sourceWatermark: 'w1', effectiveAt: at, observedAt: at,
  });
  assert.throws(() => requestTwinCorrection({ ...fixture.context, store: otherStore }, {
    entityId: otherPo.id, factPath: 'purchase_order.promised_at', oldValue: null,
    newValue: '2026-09-08T00:00:00.000Z', reason: '跨租户不得写入', evidenceReference: 'attachment:other:1',
    requestedBy: 'human:buyer', requesterPermission: 'operate', requestedAt: at,
  }), /Store|上下文/);
  assert.equal(fixture.persistence.db.prepare(`SELECT COUNT(*) AS count FROM procurement_execution_approvals
    WHERE tenant_id=?`).get('tenant:a')?.['count'], 0);
  fixture.persistence.close();
});

test('Twin correction rejects a Queue bound to a different tenant before any write', () => {
  const fixture = correctionFixture();
  const otherPersistence = openPersistence(':memory:', { tenantId: 'tenant:b' });
  const otherQueue = new SqliteTwinProjectionQueue(otherPersistence.db, 'tenant:b');
  assert.throws(() => requestTwinCorrection({ ...fixture.context, queue: otherQueue }, {
    entityId: fixture.po.id, factPath: 'purchase_order.promised_at', oldValue: null,
    newValue: '2026-09-08T00:00:00.000Z', reason: '队列不能跨租户', evidenceReference: 'attachment:queue:1',
    requestedBy: 'human:buyer', requesterPermission: 'operate', requestedAt: at,
  }), /Queue|上下文/);
  assert.equal(fixture.persistence.db.prepare(`SELECT COUNT(*) AS count FROM procurement_execution_approvals
    WHERE tenant_id=?`).get('tenant:a')?.['count'], 0);
  assert.equal(otherPersistence.db.prepare(`SELECT COUNT(*) AS count FROM twin_projection_jobs
    WHERE tenant_id=?`).get('tenant:b')?.['count'], 0);
  otherPersistence.close();
  fixture.persistence.close();
});

test('Twin correction rejects Store and Queue from another SQLite connection before any partial commit', () => {
  const fixture = correctionFixture();
  const otherPersistence = openPersistence(':memory:', { tenantId: 'tenant:a' });
  const otherStore = new SqliteManufacturingContextStore(otherPersistence.db, 'tenant:a');
  const otherQueue = new SqliteTwinProjectionQueue(otherPersistence.db, 'tenant:a');
  const otherPo = otherStore.upsertEntity({
    entityType: 'purchase_order', canonicalKey: 'readywork:po:cross-connection', label: 'PO-cross', lifecycleState: 'sent',
    attributes: { businessObjectId: 'po:cross' }, state: {}, sourceWatermark: 'w1', effectiveAt: at, observedAt: at,
  });
  assert.throws(() => requestTwinCorrection({ ...fixture.context, store: otherStore, queue: otherQueue }, {
    entityId: otherPo.id, factPath: 'purchase_order.promised_at', oldValue: null,
    newValue: '2026-09-08T00:00:00.000Z', reason: '连接不能混用', evidenceReference: 'attachment:cross:1',
    requestedBy: 'human:buyer', requesterPermission: 'operate', requestedAt: at,
  }), /Store|Queue|上下文/);
  assert.equal(fixture.persistence.db.prepare(`SELECT COUNT(*) AS count FROM procurement_execution_approvals
    WHERE tenant_id=?`).get('tenant:a')?.['count'], 0);
  assert.equal(otherStore.listEvidence(otherPo.id).length, 0);
  assert.equal(otherQueue.status().queued, 0);
  otherPersistence.close();
  fixture.persistence.close();
});

test('Twin correction rejects unbounded references and sensitive or raw-content payloads before persistence', () => {
  const fixture = correctionFixture();
  const unsafeInputs = [
    { evidenceReference: `attachment:${'x'.repeat(200)}` },
    { reason: 'Authorization: Bearer must-not-persist' },
    { newValue: { email: { body: 'Subject: secret\nBody: must-not-persist' } } },
    { oldValue: { attachment: { content: 'data:application/pdf;base64,bXVzdC1ub3QtcGVyc2lzdA==' } } },
  ];
  for (const overrides of unsafeInputs) {
    assert.throws(() => request(fixture, overrides), /证据引用|敏感|事实值/);
  }
  const approvals = fixture.persistence.db.prepare(`SELECT json FROM procurement_execution_approvals
    WHERE tenant_id=?`).all('tenant:a') as Array<{ json: string }>;
  assert.equal(approvals.length, 0);
  assert.equal(fixture.store.listEvidence(fixture.po.id).length, 0);
  assert.equal(fixture.store.getNeighborhood(fixture.po.id, { depth: 1, entityLimit: 10, evidenceLimit: 10 }).agentEvents.length, 0);
  assert.equal(fixture.persistence.activities.list('po:1').length, 0);
  fixture.persistence.close();
});

test('Twin correction accepts matching explicit Store and Queue dependencies in one transaction', () => {
  const fixture = correctionFixture();
  const explicitContext: ManufacturingContextCorrectionContext = {
    ...fixture.context,
    store: fixture.store,
    queue: fixture.queue,
  };
  const pending = requestTwinCorrection(explicitContext, {
    entityId: fixture.po.id, factPath: 'purchase_order.promised_at', oldValue: null,
    newValue: '2026-09-08T00:00:00.000Z', reason: '供应商确认交期', evidenceReference: 'attachment:confirmation:2',
    requestedBy: 'human:buyer', requesterPermission: 'operate', requestedAt: at,
  });
  const approved = decideTwinCorrection(explicitContext, {
    approvalId: pending.id, decision: 'approved', decidedBy: 'human:manager', approverPermission: 'approve', decidedAt: at,
  });
  assert.equal(approved.status, 'approved');
  assert.equal(fixture.store.listEvidence(fixture.po.id).length, 1);
  assert.equal(fixture.queue.status().queued, 1);
  assert.equal(fixture.persistence.activities.list('po:1').length, 1);
  fixture.persistence.close();
});

test('Twin correction rejects short single-line raw email and attachment-like strings before any payload write', () => {
  const unsafeInputs = [
    { newValue: 'Subject: supplier confirmation; body: private delivery details' },
    { oldValue: 'JVBERi0xLjQgc2hvcnQgYXR0YWNobWVudCBjb250ZW50' },
    { reason: 'Subject: confidential supplier email body' },
  ];
  for (const overrides of unsafeInputs) {
    const fixture = correctionFixture();
    assert.throws(() => request(fixture, overrides), /事实值|reason|内容/);
    assert.equal(fixture.persistence.db.prepare(`SELECT COUNT(*) AS count FROM procurement_execution_approvals
      WHERE tenant_id=?`).get('tenant:a')?.['count'], 0);
    assert.equal(fixture.store.listEvidence(fixture.po.id).length, 0);
    assert.equal(fixture.store.getNeighborhood(fixture.po.id, { depth: 1, entityLimit: 10, evidenceLimit: 10 }).agentEvents.length, 0);
    assert.equal(fixture.persistence.activities.list('po:1').length, 0);
    fixture.persistence.close();
  }
});

test('Twin correction rejects a Store subclass that could lie about its binding before writes', () => {
  class ForgedStore extends SqliteManufacturingContextStore {
    override getEntity(entityId: string) {
      return super.getEntity(entityId);
    }
  }
  const fixture = correctionFixture();
  const forgedStore = new ForgedStore(fixture.persistence.db, 'tenant:a');
  assert.throws(() => requestTwinCorrection({ ...fixture.context, store: forgedStore }, {
    entityId: fixture.po.id, factPath: 'purchase_order.promised_at', oldValue: null,
    newValue: '2026-09-08T00:00:00.000Z', reason: '供应商确认交期', evidenceReference: 'attachment:subclass:1',
    requestedBy: 'human:buyer', requesterPermission: 'operate', requestedAt: at,
  }), /Store|绑定/);
  assert.equal(fixture.persistence.db.prepare(`SELECT COUNT(*) AS count FROM procurement_execution_approvals
    WHERE tenant_id=?`).get('tenant:a')?.['count'], 0);
  fixture.persistence.close();
});
