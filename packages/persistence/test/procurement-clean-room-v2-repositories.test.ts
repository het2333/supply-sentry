import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ProcurementPurchaseOrderAmendmentIdempotencyConflictError,
  ProcurementSupplierOperatingProfileVersionConflictError,
  createProcurementPurchaseOrderAmendment,
  createProcurementPurchaseOrderDocumentRequest,
  createProcurementPurchaseOrderDocumentSnapshot,
  createProcurementSupplierOperatingProfile,
  getProcurementPurchaseOrderAmendment,
  getProcurementPurchaseOrderDocumentRequest,
  getProcurementPurchaseOrderDocumentSnapshot,
  getProcurementSupplierOperatingProfile,
  listProcurementPurchaseOrderAmendmentAudit,
  listProcurementSupplierOperatingProfileEvents,
  openPersistence,
  markProcurementPurchaseOrderDocumentRequestFailed,
  markProcurementPurchaseOrderDocumentRequestReady,
  takeoverProcurementPurchaseOrderDocumentRequest,
  transitionProcurementPurchaseOrderAmendment,
  updateProcurementSupplierOperatingProfile,
} from '@readywork/persistence';
import type { SupplierOperatingProfile } from '@readywork/core';

const at = '2026-09-02T00:00:00.000Z';
const owner = 'tenant:owner';
const other = 'tenant:other';

function profile(supplierId = 'supplier:shared'): SupplierOperatingProfile {
  return { supplierId, countryCode: 'CN', route: 'import', supplierType: 'manufacturer', industry: 'Components', address: null,
    primaryMaterialCode: 'M8', primaryMaterialName: 'M8 bolt', defaultLeadTimeDays: 14, productCriticality: 'high',
    paymentTerms: 'Net 30', contractStartsOn: '2026-09-01', contractEndsOn: '2026-12-31', status: 'active', version: 1 };
}

function amendmentInput() {
  return { id: 'amendment:shared', poId: 'po:shared', action: 'edit' as const, sourcePoVersion: 4,
    normalizedPatch: { requiredInHouseAt: '2026-10-01T00:00:00.000Z' }, idempotencyKey: 'amendment-key',
    actorId: 'human:buyer', reason: 'Customer deadline changed', at };
}

test('one shared database isolates same supplier IDs while updates emit only changed-field diffs', () => {
  const store = openPersistence(':memory:', { tenantId: owner });
  try {
    createProcurementSupplierOperatingProfile(store.db, owner, { profile: profile(), actorId: 'human:buyer', reason: 'Initial setup', source: 'manual', at });
    createProcurementSupplierOperatingProfile(store.db, other, { profile: profile(), actorId: 'human:buyer', reason: 'Initial setup', source: 'manual', at });
    const updated = updateProcurementSupplierOperatingProfile(store.db, owner, {
      supplierId: 'supplier:shared', expectedVersion: 1, patch: { defaultLeadTimeDays: 21 }, actorId: 'human:buyer',
      reason: 'Verified new lead time', source: 'manual', at: '2026-09-03T00:00:00.000Z',
    });
    assert.equal(updated.version, 2);
    assert.equal(getProcurementSupplierOperatingProfile(store.db, other, 'supplier:shared')?.defaultLeadTimeDays, 14);
    assert.throws(() => updateProcurementSupplierOperatingProfile(store.db, owner, {
      supplierId: 'supplier:shared', expectedVersion: 1, patch: { status: 'inactive' }, actorId: 'human:buyer', reason: 'Stale', source: 'manual', at,
    }), ProcurementSupplierOperatingProfileVersionConflictError);
    assert.throws(() => updateProcurementSupplierOperatingProfile(store.db, owner, {
      supplierId: 'supplier:shared', expectedVersion: 2, patch: {}, actorId: 'human:buyer', reason: 'No change', source: 'manual', at,
    }), /no-op|changed/u);
    const events = listProcurementSupplierOperatingProfileEvents(store.db, owner, 'supplier:shared');
    assert.deepEqual(events[1]?.before, { defaultLeadTimeDays: 14 });
    assert.deepEqual(events[1]?.after, { defaultLeadTimeDays: 21 });
    assert.throws(() => store.db.prepare(`UPDATE procurement_supplier_operating_profile_events SET reason='rewritten'
      WHERE tenant_id=? AND id=?`).run(owner, events[0]!.id), /append-only|immutable/u);
  } finally { store.close(); }
});

test('profile creation and first event commit or roll back together', () => {
  const store = openPersistence(':memory:', { tenantId: owner });
  try {
    store.db.exec(`CREATE TRIGGER test_profile_event_failure BEFORE INSERT ON procurement_supplier_operating_profile_events
      BEGIN SELECT RAISE(ABORT, 'injected profile event failure'); END`);
    assert.throws(() => createProcurementSupplierOperatingProfile(store.db, owner, {
      profile: profile('supplier:rollback'), actorId: 'human:buyer', reason: 'Injected failure', source: 'manual', at,
    }), /injected profile event failure/u);
    assert.equal(getProcurementSupplierOperatingProfile(store.db, owner, 'supplier:rollback'), null);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_supplier_operating_profile_events WHERE tenant_id=?').get(owner) as { count: number }).count, 0);
  } finally { store.close(); }
});

test('amendments on one shared database preserve isolation, immutable requests, strict JSON, and evidence-backed unknown reconciliation', () => {
  const store = openPersistence(':memory:', { tenantId: owner });
  try {
    const input = amendmentInput();
    assert.equal(createProcurementPurchaseOrderAmendment(store.db, owner, input).replayed, false);
    assert.equal(createProcurementPurchaseOrderAmendment(store.db, other, input).replayed, false);
    assert.equal(createProcurementPurchaseOrderAmendment(store.db, owner, input).replayed, true);
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:conflict', normalizedPatch: { supplierId: 'supplier:two' } }), ProcurementPurchaseOrderAmendmentIdempotencyConflictError);
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:null', idempotencyKey: 'null', normalizedPatch: null as never }), /plain JSON object/u);
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:date', idempotencyKey: 'date', normalizedPatch: { value: new Date() } }), /plain JSON|prototype/u);
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:map', idempotencyKey: 'map', normalizedPatch: { value: new Map() } }), /prototype/u);
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:undefined', idempotencyKey: 'undefined', normalizedPatch: { value: undefined } }), /JSON values/u);
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:nonfinite', idempotencyKey: 'nonfinite', normalizedPatch: { value: Number.NaN } }), /finite JSON values/u);
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:array-holes', idempotencyKey: 'array-holes', normalizedPatch: { lines: new Array(2) } }), /sparse|array/u);
    const sparse = ['first']; sparse[2] = 'third';
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:sparse-array', idempotencyKey: 'sparse-array', normalizedPatch: { lines: sparse } }), /sparse|array/u);
    const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:cycle', idempotencyKey: 'cycle', normalizedPatch: cyclic }), /cycle/u);
    const withGetter = Object.defineProperty({}, 'value', { enumerable: true, get: () => 'side effect' });
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:getter', idempotencyKey: 'getter', normalizedPatch: withGetter }), /getter|plain JSON/u);
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...input, id: 'amendment:locale', idempotencyKey: 'locale', at: 'September 2, 2026 00:00:00 UTC' }), /RFC3339/u);

    assert.throws(() => transitionProcurementPurchaseOrderAmendment(store.db, owner, {
      id: input.id, state: 'pending', actorId: 'human:buyer', reason: 'Missing outbox', at,
    }), /outboxId/u);
    const pending = transitionProcurementPurchaseOrderAmendment(store.db, owner, {
      id: input.id, state: 'pending', actorId: 'human:buyer', reason: 'Queued for ERP', outboxId: 'outbox:one', at: '2026-09-02T08:01:00+08:00',
    });
    const dispatched = transitionProcurementPurchaseOrderAmendment(store.db, owner, {
      id: input.id, state: 'dispatched', actorId: 'worker:odoo', reason: 'ERP accepted', at,
    });
    const unknown = transitionProcurementPurchaseOrderAmendment(store.db, owner, {
      id: input.id, state: 'unknown', actorId: 'worker:odoo', reason: 'Readback mismatch', at,
    });
    assert.throws(() => transitionProcurementPurchaseOrderAmendment(store.db, owner, {
      id: input.id, state: 'applied', actorId: 'worker:odoo', reason: 'Missing receipt', at,
    }), /receiptReference/u);
    const applied = transitionProcurementPurchaseOrderAmendment(store.db, owner, {
      id: input.id, state: 'applied', actorId: 'worker:odoo', reason: 'Readback matched', receiptReference: 'odoo:receipt:one', at,
    });
    assert.deepEqual([pending.state, dispatched.state, unknown.state, applied.state], ['pending', 'dispatched', 'unknown', 'applied']);
    assert.equal(pending.updatedAt, '2026-09-02T00:01:00.000Z');
    assert.equal(getProcurementPurchaseOrderAmendment(store.db, other, input.id)?.state, 'requested');
    const audit = listProcurementPurchaseOrderAmendmentAudit(store.db, owner, input.id);
    assert.deepEqual(audit.map((event) => event.sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(audit.map((event) => event.toState), ['requested', 'pending', 'dispatched', 'unknown', 'applied']);
    assert.throws(() => store.db.prepare(`UPDATE procurement_purchase_order_amendments SET normalized_patch_json='{}'
      WHERE tenant_id=? AND id=?`).run(owner, input.id), /immutable amendment request/u);
    assert.throws(() => store.db.prepare(`UPDATE procurement_purchase_order_amendments SET tenant_id='tenant:rewritten'
      WHERE tenant_id=? AND id=?`).run(owner, input.id), /immutable amendment request/u);
    assert.throws(() => store.db.prepare(`UPDATE procurement_purchase_order_amendments SET id='amendment:rewritten'
      WHERE tenant_id=? AND id=?`).run(owner, input.id), /immutable amendment request/u);
    assert.equal(listProcurementPurchaseOrderAmendmentAudit(store.db, owner, input.id).length, 5);
    assert.throws(() => store.db.prepare(`DELETE FROM procurement_purchase_order_amendment_audit
      WHERE tenant_id=? AND id=?`).run(owner, audit[0]!.id), /append-only|immutable/u);
  } finally { store.close(); }
});

test('supplier-profile evidence and document snapshots require RFC3339 and canonicalize offsets', () => {
  const store = openPersistence(':memory:', { tenantId: owner });
  try {
    assert.throws(() => createProcurementSupplierOperatingProfile(store.db, owner, {
      profile: profile('supplier:locale'), actorId: 'human:buyer', reason: 'Locale time', source: 'manual', at: 'September 2, 2026 00:00:00 UTC',
    }), /RFC3339/u);
    createProcurementSupplierOperatingProfile(store.db, owner, {
      profile: profile('supplier:offset'), actorId: 'human:buyer', reason: 'Offset time', source: 'manual', at: '2026-09-02T08:00:00+08:00',
    });
    assert.equal(listProcurementSupplierOperatingProfileEvents(store.db, owner, 'supplier:offset')[0]?.createdAt, at);
    assert.throws(() => createProcurementPurchaseOrderDocumentSnapshot(store.db, owner, {
      id: 'snapshot:locale', poId: 'po:time', documentId: 'document:locale', snapshotKind: 'purchase_order', sourcePoVersion: 1,
      contextWatermark: 'po:time@1', templateVersion: 1, contentSha256: 'b'.repeat(64), objectKey: 'time.pdf', sizeBytes: 1,
      generatedBy: 'human:buyer', generatedAt: 'September 2, 2026 00:00:00 UTC',
    }), /RFC3339/u);
    const snapshot = createProcurementPurchaseOrderDocumentSnapshot(store.db, owner, {
      id: 'snapshot:offset', poId: 'po:time', documentId: 'document:offset', snapshotKind: 'purchase_order', sourcePoVersion: 1,
      contextWatermark: 'po:time@1', templateVersion: 1, contentSha256: 'c'.repeat(64), objectKey: 'offset.pdf', sizeBytes: 1,
      generatedBy: 'human:buyer', generatedAt: '2026-09-02T08:00:00+08:00',
    });
    assert.equal(snapshot.generatedAt, at);
  } finally { store.close(); }
});

test('supplier profiles round-trip exact ASCII country codes', () => {
  const store = openPersistence(':memory:', { tenantId: owner });
  try {
    createProcurementSupplierOperatingProfile(store.db, owner, {
      profile: { ...profile('supplier:country'), countryCode: 'US', address: { line1: '1 Main', line2: null, city: 'Austin', region: 'TX', postalCode: '78701', countryCode: 'US' } },
      actorId: 'human:buyer', reason: 'Country code', source: 'manual', at,
    });
    assert.equal(getProcurementSupplierOperatingProfile(store.db, owner, 'supplier:country')?.countryCode, 'US');
    assert.equal(getProcurementSupplierOperatingProfile(store.db, owner, 'supplier:country')?.address?.countryCode, 'US');
  } finally { store.close(); }
});

test('amendment creation and first audit roll back together and same-timestamp audits retain sequence order', () => {
  const store = openPersistence(':memory:', { tenantId: owner });
  try {
    store.db.exec(`CREATE TRIGGER test_amendment_audit_failure BEFORE INSERT ON procurement_purchase_order_amendment_audit
      BEGIN SELECT RAISE(ABORT, 'injected amendment audit failure'); END`);
    assert.throws(() => createProcurementPurchaseOrderAmendment(store.db, owner, { ...amendmentInput(), id: 'amendment:rollback', idempotencyKey: 'rollback' }), /injected amendment audit failure/u);
    assert.equal(getProcurementPurchaseOrderAmendment(store.db, owner, 'amendment:rollback'), null);
    store.db.exec('DROP TRIGGER test_amendment_audit_failure');
    const input = { ...amendmentInput(), id: 'amendment:sequence', idempotencyKey: 'sequence' };
    createProcurementPurchaseOrderAmendment(store.db, owner, input);
    transitionProcurementPurchaseOrderAmendment(store.db, owner, { id: input.id, state: 'pending', actorId: 'human:buyer', reason: 'Queue', outboxId: 'outbox:sequence', at });
    transitionProcurementPurchaseOrderAmendment(store.db, owner, { id: input.id, state: 'dispatched', actorId: 'worker:odoo', reason: 'Dispatch', at });
    assert.deepEqual(listProcurementPurchaseOrderAmendmentAudit(store.db, owner, input.id).map((event) => event.sequence), [1, 2, 3]);
  } finally { store.close(); }
});

test('document snapshots with the same IDs remain tenant-scoped and append-only in one database', () => {
  const store = openPersistence(':memory:', { tenantId: owner });
  try {
    const input = { id: 'snapshot:shared', poId: 'po:shared', documentId: 'document:shared', snapshotKind: 'purchase_order' as const,
      sourcePoVersion: 4, contextWatermark: 'po:shared@4', templateVersion: 1, contentSha256: 'a'.repeat(64),
      objectKey: 'po-shared.pdf', sizeBytes: 1024, generatedBy: 'human:buyer', generatedAt: at };
    createProcurementPurchaseOrderDocumentSnapshot(store.db, owner, input);
    createProcurementPurchaseOrderDocumentSnapshot(store.db, other, input);
    assert.equal(getProcurementPurchaseOrderDocumentSnapshot(store.db, owner, input.id)?.tenantId, owner);
    assert.equal(getProcurementPurchaseOrderDocumentSnapshot(store.db, other, input.id)?.tenantId, other);
    assert.throws(() => store.db.prepare(`UPDATE procurement_purchase_order_document_snapshots SET object_key='replaced'
      WHERE tenant_id=? AND id=?`).run(owner, input.id), /append-only|immutable/u);
  } finally { store.close(); }
});

test('PO document requests isolate tenants and fence stale lease owners', () => {
  const store = openPersistence(':memory:', { tenantId: owner });
  try {
    const input = {
      snapshotId: 'po-document:shared', poId: 'po:shared', sourcePoVersion: 4,
      payloadFingerprint: 'd'.repeat(64), projectionJson: '{"purchaseOrderId":"po:shared"}',
      generatedBy: 'human:buyer', generatedAt: at, state: 'generating' as const,
      ownerToken: 'owner:first', leaseVersion: 1, leaseExpiresAt: 10_000,
      lastError: null, createdAt: at, updatedAt: at,
    };
    createProcurementPurchaseOrderDocumentRequest(store.db, owner, input);
    createProcurementPurchaseOrderDocumentRequest(store.db, other, input);
    assert.equal(getProcurementPurchaseOrderDocumentRequest(store.db, owner, input.snapshotId)?.tenantId, owner);
    assert.equal(getProcurementPurchaseOrderDocumentRequest(store.db, other, input.snapshotId)?.tenantId, other);
    assert.equal(takeoverProcurementPurchaseOrderDocumentRequest(store.db, owner, {
      snapshotId: input.snapshotId, expectedLeaseVersion: 1, ownerToken: 'owner:early',
      leaseExpiresAt: 20_000, nowEpochMs: 9_999, updatedAt: '2026-09-02T00:00:01.000Z',
    }), null, 'an unexpired owner cannot be displaced');

    const taken = takeoverProcurementPurchaseOrderDocumentRequest(store.db, owner, {
      snapshotId: input.snapshotId, expectedLeaseVersion: 1, ownerToken: 'owner:second',
      leaseExpiresAt: 20_001, nowEpochMs: 10_000, updatedAt: '2026-09-02T00:00:02.000Z',
    });
    assert.equal(taken?.ownerToken, 'owner:second');
    assert.equal(taken?.leaseVersion, 2);
    assert.equal(markProcurementPurchaseOrderDocumentRequestReady(store.db, owner, {
      snapshotId: input.snapshotId, ownerToken: 'owner:first', leaseVersion: 1, updatedAt: '2026-09-02T00:00:03.000Z',
    }), false, 'the stale owner token and lease version are fenced');
    assert.equal(markProcurementPurchaseOrderDocumentRequestReady(store.db, owner, {
      snapshotId: input.snapshotId, ownerToken: 'owner:second', leaseVersion: 2, updatedAt: '2026-09-02T00:00:03.000Z',
    }), true);
    assert.equal(getProcurementPurchaseOrderDocumentRequest(store.db, owner, input.snapshotId)?.state, 'ready');
    assert.equal(takeoverProcurementPurchaseOrderDocumentRequest(store.db, owner, {
      snapshotId: input.snapshotId, expectedLeaseVersion: 2, ownerToken: 'owner:third',
      leaseExpiresAt: 40_000, nowEpochMs: 30_000, updatedAt: '2026-09-02T00:00:04.000Z',
    }), null, 'ready requests cannot be reclaimed');

    const failedInput = { ...input, snapshotId: 'po-document:failed', ownerToken: 'owner:failed' };
    createProcurementPurchaseOrderDocumentRequest(store.db, owner, failedInput);
    assert.equal(markProcurementPurchaseOrderDocumentRequestFailed(store.db, owner, {
      snapshotId: failedInput.snapshotId, ownerToken: 'owner:stale', leaseVersion: 1,
      lastError: 'stale failure', updatedAt: '2026-09-02T00:00:05.000Z',
    }), false);
    assert.equal(markProcurementPurchaseOrderDocumentRequestFailed(store.db, owner, {
      snapshotId: failedInput.snapshotId, ownerToken: 'owner:failed', leaseVersion: 1,
      lastError: 'storage unavailable', updatedAt: '2026-09-02T00:00:05.000Z',
    }), true);
    const failed = getProcurementPurchaseOrderDocumentRequest(store.db, owner, failedInput.snapshotId);
    assert.equal(failed?.state, 'failed');
    assert.equal(failed?.leaseExpiresAt, 0);
    assert.equal(failed?.lastError, 'storage unavailable');
    assert.throws(() => store.db.prepare(`UPDATE procurement_purchase_order_document_requests SET po_id='po:rewritten'
      WHERE tenant_id=? AND snapshot_id=?`).run(owner, input.snapshotId), /immutable document request/u);
  } finally { store.close(); }
});
