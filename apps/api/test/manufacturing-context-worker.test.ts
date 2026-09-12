import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { TwinProjectionJob } from '@readywork/core';
import { canonicalTwinJson, SqliteTwinProjectionQueue } from '@readywork/context';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import {
  ManufacturingContextWorker,
  resolveAffectedPurchaseOrderIds,
} from '../src/manufacturing-context-worker.js';

const at = '2026-08-29T08:00:00.000Z';

function insertDocument(
  db: DatabaseSync,
  tenantId: string,
  kind: string,
  document: Record<string, unknown>,
  version = 1,
): void {
  const id = String(document['id']);
  db.prepare(`INSERT INTO procurement_documents
    (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    tenantId, kind, id, String(document['sourceSystem'] ?? 'readywork'),
    String(document['externalId'] ?? id), String(document['status'] ?? 'active'), version,
    JSON.stringify({ tenantId, sourceSystem: 'readywork', externalId: id, status: 'active', createdAt: at, updatedAt: at, ...document }),
    at, at,
  );
}

function insertLine(
  db: DatabaseSync,
  tenantId: string,
  kind: string,
  documentId: string,
  line: Record<string, unknown>,
): void {
  db.prepare(`INSERT INTO procurement_lines
    (tenant_id,kind,id,document_id,line_number,json,projection_generation) VALUES (?,?,?,?,?,?,1)`).run(
    tenantId, kind, String(line['id']), documentId, String(line['lineNumber'] ?? '1'),
    JSON.stringify({ lineNumber: '1', itemId: 'item:1', uom: 'ea', ...line }),
  );
}

function enqueue(
  queue: SqliteTwinProjectionQueue,
  input: Pick<TwinProjectionJob, 'sourceTable' | 'sourceKey' | 'sourceRevision' | 'eventType'>,
): TwinProjectionJob {
  return queue.enqueue({ ...input, payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), availableAt: at });
}

function sourceGraphFixture(): { db: DatabaseSync; queue: SqliteTwinProjectionQueue } {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const poFixtures: Array<readonly [string, string, string | undefined, string]> = [
    ['po:1', 'supplier:1', 'award:1', '1'],
    ['po:2', 'supplier:2', undefined, '2'],
  ];
  for (const [poId, supplierId, awardId, suffix] of poFixtures) {
    insertDocument(db, 'tenant:a', 'purchase_order', { id: poId, supplierId, ...(awardId ? { awardId } : {}), currency: 'CNY', orderedAt: at });
    insertLine(db, 'tenant:a', 'purchase_order_line', poId, {
      id: `po-line:${suffix}`, poId, itemId: `item:${suffix}`,
      requisitionLineId: `req-line:${suffix}`, rfqLineId: `rfq-line:${suffix}`,
      quoteLineId: `quote-line:${suffix}`, ...(awardId ? { awardLineId: `award-line:${suffix}` } : {}),
      orderedQty: 1, unitPrice: 10, currency: 'CNY',
    });
    insertDocument(db, 'tenant:a', 'supplier', { id: supplierId, name: supplierId, currency: 'CNY', contacts: [] });
    if (awardId) {
      insertDocument(db, 'tenant:a', 'award', { id: awardId, rfqId: 'rfq:shared' });
      insertLine(db, 'tenant:a', 'award_line', awardId, {
        id: `award-line:${suffix}`, awardId, rfqLineId: `rfq-line:${suffix}`,
        quoteLineId: `quote-line:${suffix}`, supplierId, awardedQty: 1,
        unitPrice: 10, currency: 'CNY', selectionReason: 'approved',
      });
    }
    insertLine(db, 'tenant:a', 'rfq_line', 'rfq:shared', {
      id: `rfq-line:${suffix}`, lineNumber: suffix, rfqId: 'rfq:shared', requisitionLineId: `req-line:${suffix}`, requestedQty: 1,
    });
    insertLine(db, 'tenant:a', 'quote_line', `quote:${suffix}`, {
      id: `quote-line:${suffix}`, quoteId: `quote:${suffix}`, rfqLineId: `rfq-line:${suffix}`, quotedQty: 1, unitPrice: 10,
    });
  }
  insertDocument(db, 'tenant:a', 'rfq', { id: 'rfq:shared', buyerId: 'human:buyer', supplierIds: ['supplier:1', 'supplier:2'], currency: 'CNY', quoteDueAt: at });
  insertDocument(db, 'tenant:a', 'communication', {
    id: 'communication:1', businessObjectId: 'po:1', businessObjectType: 'purchase_order',
    supplierId: 'supplier:1', channel: 'email', direction: 'inbound', body: 'opaque reference only', attachmentIds: [], occurredAt: at,
  });
  insertDocument(db, 'tenant:a', 'shipment', { id: 'shipment:1', poId: 'po:1', supplierId: 'supplier:1', shippedAt: at });
  insertLine(db, 'tenant:a', 'shipment_line', 'shipment:1', { id: 'shipment-line:1', shipmentId: 'shipment:1', poLineId: 'po-line:1', shippedQty: 1 });

  db.prepare(`INSERT INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES ('tenant:a','stage:1','po:1','dispatch_transit','shipment','active',?,'shipment','shipment:1','human:buyer','{}',?)`).run(at, at);
  const quantityEvent = { tenantId: 'tenant:a', sourceSystem: 'readywork', sourceEventId: 'quantity:1', poLineId: 'po-line:1', dimension: 'shipped', delta: 1, occurredAt: at };
  db.prepare(`INSERT INTO procurement_po_line_quantity_events
    (tenant_id,source_system,source_event_id,po_line_id,dimension,delta,occurred_at,json)
    VALUES ('tenant:a','readywork','quantity:1','po-line:1','shipped',1,?,?)`).run(at, JSON.stringify(quantityEvent));
  db.prepare(`INSERT INTO procurement_po_line_quantity_projections
    (tenant_id,po_line_id,ordered_qty,confirmed_qty,shipped_qty,received_qty,invoiced_qty,cancelled_qty,projection_json,updated_at)
    VALUES ('tenant:a','po-line:1',1,1,1,0,0,0,?,?)`).run(JSON.stringify({ ...quantityEvent, orderedQty: 1 }), at);
  const outbox = { id: 'outbox:1', tenantId: 'tenant:a', channel: 'email', connectorId: 'email', action: 'purchase_order.send', aggregateId: 'po:1', idempotencyKey: 'send:1', status: 'dispatched', payload: {}, attempts: 1, createdAt: at, updatedAt: at, dispatchedAt: at };
  db.prepare(`INSERT INTO procurement_outbox
    (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,created_at,updated_at)
    VALUES ('tenant:a','outbox:1','email','email','purchase_order.send','po:1','send:1','dispatched','{}',?,?,?)`).run(JSON.stringify(outbox), at, at);
  db.prepare(`INSERT INTO procurement_sla_evaluations
    (tenant_id,po_id,policy_id,policy_version,rule_id,stage,status,due_at,grace_until,next_followup_at,followup_count,evidence_json,fingerprint,version,evaluated_at,updated_at)
    VALUES ('tenant:a','po:1','policy:1',1,'rule:1','dispatch_transit','on_track',NULL,NULL,NULL,0,'{}','fingerprint',1,?,?)`).run(at, at);

  // The same business IDs in another tenant must never be considered.
  insertDocument(db, 'tenant:b', 'purchase_order', { id: 'po:foreign', supplierId: 'supplier:1', currency: 'CNY', orderedAt: at });
  insertLine(db, 'tenant:b', 'purchase_order_line', 'po:foreign', { id: 'po-line:foreign', poId: 'po:foreign', itemId: 'item:1', orderedQty: 1, unitPrice: 1, currency: 'CNY' });
  return { db, queue: new SqliteTwinProjectionQueue(db, 'tenant:a') };
}

test('Context worker retries one failed job and then succeeds with the same identity', async () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const original = queue.enqueue({ sourceTable: 'procurement_documents', sourceKey: 'purchase_order:po:1', sourceRevision: '1', eventType: 'purchase_order.changed', payloadHash: 'hash:1', availableAt: at });
  let now = at;
  let calls = 0;
  const worker = new ManufacturingContextWorker({ queue, workerId: 'worker:test', now: () => now, project: () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary projection failure');
    return { projectedWatermark: 'watermark:1' };
  } });
  await worker.runOnce();
  const retry = queue.get(original.id)!;
  assert.equal(retry.status, 'retry_wait');
  now = retry.availableAt;
  await worker.runOnce();
  const completed = queue.get(original.id)!;
  assert.equal(completed.id, original.id);
  assert.equal(completed.status, 'succeeded');
});

test('resolver covers every durable mutation source family without crossing tenant or unrelated branches', () => {
  const { db } = sourceGraphFixture();
  const cases: Array<{ name: string; job: Pick<TwinProjectionJob, 'tenantId' | 'sourceTable' | 'sourceKey' | 'sourceRevision' | 'eventType'>; want: string[] }> = [
    { name: 'supplier document fan-out', job: { tenantId: 'tenant:a', sourceTable: 'procurement_documents', sourceKey: 'supplier:supplier:1', sourceRevision: '1', eventType: 'supplier.changed' }, want: ['po:1'] },
    { name: 'award document exact branch', job: { tenantId: 'tenant:a', sourceTable: 'procurement_documents', sourceKey: 'award:award:1', sourceRevision: '1', eventType: 'award.changed' }, want: ['po:1'] },
    { name: 'communication direct PO', job: { tenantId: 'tenant:a', sourceTable: 'procurement_documents', sourceKey: 'communication:communication:1', sourceRevision: '1', eventType: 'communication.changed' }, want: ['po:1'] },
    { name: 'execution document', job: { tenantId: 'tenant:a', sourceTable: 'procurement_documents', sourceKey: 'shipment:shipment:1', sourceRevision: '1', eventType: 'shipment.changed' }, want: ['po:1'] },
    { name: 'award line exact branch', job: { tenantId: 'tenant:a', sourceTable: 'procurement_lines', sourceKey: 'award_line:award-line:1', sourceRevision: '1', eventType: 'award_line.changed' }, want: ['po:1'] },
    { name: 'execution line', job: { tenantId: 'tenant:a', sourceTable: 'procurement_lines', sourceKey: 'shipment_line:shipment-line:1', sourceRevision: '1', eventType: 'shipment_line.changed' }, want: ['po:1'] },
    { name: 'stage event', job: { tenantId: 'tenant:a', sourceTable: 'procurement_po_stage_events', sourceKey: 'stage:1', sourceRevision: '1', eventType: 'procurement_po_stage_event.created' }, want: ['po:1'] },
    { name: 'quantity event', job: { tenantId: 'tenant:a', sourceTable: 'procurement_po_line_quantity_events', sourceKey: 'readywork:quantity:1', sourceRevision: '1', eventType: 'procurement_po_line_quantity_event.created' }, want: ['po:1'] },
    { name: 'quantity projection', job: { tenantId: 'tenant:a', sourceTable: 'procurement_po_line_quantity_projections', sourceKey: 'po-line:1', sourceRevision: 'hash', eventType: 'procurement_po_line_quantity_projection.changed' }, want: ['po:1'] },
    { name: 'Outbox completion/failure row', job: { tenantId: 'tenant:a', sourceTable: 'procurement_outbox', sourceKey: 'outbox:1', sourceRevision: 'hash', eventType: 'procurement_outbox.changed' }, want: ['po:1'] },
    { name: 'SLA materialization', job: { tenantId: 'tenant:a', sourceTable: 'procurement_sla_evaluations', sourceKey: 'po:1', sourceRevision: 'policy:1:v1', eventType: 'procurement_sla_evaluation.changed' }, want: ['po:1'] },
    { name: 'SLA tombstone', job: { tenantId: 'tenant:a', sourceTable: 'procurement_sla_evaluations', sourceKey: 'po:1', sourceRevision: 'policy:1:v2', eventType: 'procurement_sla_evaluation.deleted' }, want: ['po:1'] },
  ];
  for (const item of cases) {
    assert.deepEqual(resolveAffectedPurchaseOrderIds(db, item.job as TwinProjectionJob), item.want, item.name);
  }
});

test('RFQ communication projects only POs with explicit RFQ-line lineage in the same tenant', async () => {
  const { db, queue } = sourceGraphFixture();
  insertDocument(db, 'tenant:a', 'purchase_order', {
    id: 'po:unrelated', supplierId: 'supplier:2', currency: 'CNY', orderedAt: at,
  });
  insertLine(db, 'tenant:a', 'purchase_order_line', 'po:unrelated', {
    id: 'po-line:unrelated', poId: 'po:unrelated', itemId: 'item:unrelated',
    rfqLineId: 'rfq-line:unrelated', orderedQty: 1, unitPrice: 1, currency: 'CNY',
  });
  insertDocument(db, 'tenant:a', 'rfq', {
    id: 'rfq:unrelated', buyerId: 'human:buyer', supplierIds: ['supplier:2'], currency: 'CNY', quoteDueAt: at,
  });
  insertLine(db, 'tenant:a', 'rfq_line', 'rfq:unrelated', {
    id: 'rfq-line:unrelated', rfqId: 'rfq:unrelated', requestedQty: 1,
  });
  insertDocument(db, 'tenant:a', 'communication', {
    id: 'communication:rfq', businessObjectId: 'rfq:shared', businessObjectType: 'rfq',
    supplierId: 'supplier:1', channel: 'email', direction: 'inbound', body: 'opaque reference only',
    attachmentIds: [], occurredAt: at,
  });
  const original = enqueue(queue, {
    sourceTable: 'procurement_documents', sourceKey: 'communication:communication:rfq',
    sourceRevision: '1', eventType: 'communication.changed',
  });
  const projected: string[] = [];
  const worker = new ManufacturingContextWorker({
    db, queue, workerId: 'worker:rfq-communication', now: () => at,
    project: (job) => {
      projected.push(job.sourceKey);
      return { projectedWatermark: `watermark:${job.sourceKey}` };
    },
  });

  await worker.runOnce();

  assert.deepEqual(projected, ['po:1', 'po:2']);
  assert.equal(queue.get(original.id)?.status, 'succeeded');
  assert.equal(projected.includes('po:unrelated'), false);
  assert.equal(projected.includes('po:foreign'), false);
});

test('one RFQ job succeeds only after every affected PO projects and keeps its queue identity across retry', async () => {
  const { db, queue } = sourceGraphFixture();
  const original = enqueue(queue, { sourceTable: 'procurement_documents', sourceKey: 'rfq:rfq:shared', sourceRevision: '1', eventType: 'rfq.changed' });
  let now = at;
  let failSecond = true;
  const projected: string[] = [];
  const worker = new ManufacturingContextWorker({
    db, queue, workerId: 'worker:fanout', now: () => now,
    project: (job) => {
      projected.push(job.sourceKey);
      if (job.sourceKey === 'po:2' && failSecond) throw new Error('second PO failed');
      return { projectedWatermark: `watermark:${job.sourceKey}` };
    },
  });
  await worker.runOnce();
  assert.deepEqual(projected, ['po:1', 'po:2']);
  const retry = queue.get(original.id)!;
  assert.equal(retry.status, 'retry_wait');
  failSecond = false;
  now = retry.availableAt;
  await worker.runOnce();
  assert.deepEqual(projected, ['po:1', 'po:2', 'po:1', 'po:2']);
  assert.equal(queue.get(original.id)!.id, original.id);
  assert.equal(queue.get(original.id)!.status, 'succeeded');
});

test('unknown source/event remains observable as a retry with a safe error', async () => {
  const { db, queue } = sourceGraphFixture();
  const original = enqueue(queue, { sourceTable: 'mystery_table', sourceKey: 'opaque:1', sourceRevision: '1', eventType: 'mystery.changed' });
  const worker = new ManufacturingContextWorker({
    db, queue, workerId: 'worker:unsupported', now: () => at,
    project: () => { throw new Error('project must not be called'); },
  });
  await worker.runOnce();
  const failed = queue.get(original.id)!;
  assert.equal(failed.status, 'retry_wait');
  assert.match(failed.lastError ?? '', /unsupported.*source\/event/i);
  assert.doesNotMatch(failed.lastError ?? '', /opaque:1/);
});

test('an expired settlement cannot abort later claimed jobs and every original job remains reclaimable', async () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const originals = [
    enqueue(queue, { sourceTable: 'procurement_documents', sourceKey: 'purchase_order:po:lease-1', sourceRevision: '1', eventType: 'purchase_order.changed' }),
    enqueue(queue, { sourceTable: 'procurement_documents', sourceKey: 'purchase_order:po:lease-2', sourceRevision: '1', eventType: 'purchase_order.changed' }),
  ];
  let now = at;
  let expireFirstLease = true;
  const projected: string[] = [];
  const worker = new ManufacturingContextWorker({
    queue, workerId: 'worker:lease-expiry', now: () => now,
    project: (job) => {
      projected.push(job.sourceKey);
      if (expireFirstLease && projected.length === 1) {
        now = new Date(Date.parse(at) + 60_000).toISOString();
      }
      return { projectedWatermark: `watermark:${job.sourceKey}` };
    },
  });

  await assert.doesNotReject(worker.runOnce());
  assert.equal(projected.length, 2);
  assert.deepEqual(originals.map((job) => queue.get(job.id)?.status), ['processing', 'processing']);

  expireFirstLease = false;
  await assert.doesNotReject(worker.runOnce());
  assert.equal(projected.length, 4);
  assert.deepEqual(originals.map((job) => queue.get(job.id)?.status), ['succeeded', 'succeeded']);
  assert.deepEqual(originals.map((job) => queue.get(job.id)?.id), originals.map((job) => job.id));
});

test('runtime coordinator discovers every pending tenant and control surface remains worker-free', async () => {
  const workerModule = await import('../src/manufacturing-context-worker.js') as unknown as {
    createManufacturingContextRuntime?: (options: {
      surface: 'business' | 'control' | 'compat'; db: DatabaseSync; workerId: string; now: () => string;
    }) => undefined | {
      runOnce: () => Promise<Record<string, number>>;
      status: (tenantId: string) => { state: 'ready' | 'unavailable'; lastHeartbeatAt: string | null };
    };
  };
  assert.equal(typeof workerModule.createManufacturingContextRuntime, 'function');
  const { db, queue: tenantAQueue } = sourceGraphFixture();
  const tenantBQueue = new SqliteTwinProjectionQueue(db, 'tenant:b');
  const tenantAJob = enqueue(tenantAQueue, {
    sourceTable: 'procurement_documents', sourceKey: 'purchase_order:po:1',
    sourceRevision: '1', eventType: 'purchase_order.changed',
  });
  const tenantBJob = enqueue(tenantBQueue, {
    sourceTable: 'procurement_documents', sourceKey: 'purchase_order:po:foreign',
    sourceRevision: '1', eventType: 'purchase_order.changed',
  });
  let tick = 0;
  const createRuntime = workerModule.createManufacturingContextRuntime!;

  assert.equal(createRuntime({
    surface: 'control', db, workerId: 'context:control', now: () => at,
  }), undefined);
  const runtime = createRuntime({
    surface: 'business', db, workerId: 'context:multi',
    now: () => new Date(Date.parse(at) + tick++ * 100).toISOString(),
  });
  assert.ok(runtime);

  const result = await runtime.runOnce();

  assert.deepEqual(Object.keys(result), ['tenant:a', 'tenant:b']);
  assert.equal(tenantAQueue.get(tenantAJob.id)?.status, 'succeeded');
  assert.equal(tenantBQueue.get(tenantBJob.id)?.status, 'succeeded');
  const tenantAStatus = runtime.status('tenant:a');
  const tenantBStatus = runtime.status('tenant:b');
  assert.equal(tenantAStatus.state, 'ready');
  assert.equal(tenantBStatus.state, 'ready');
  assert.notEqual(tenantAStatus.lastHeartbeatAt, tenantBStatus.lastHeartbeatAt);
  assert.deepEqual(runtime.status('tenant:missing'), { state: 'unavailable', lastHeartbeatAt: null });
});

test('narrow recovery mode without a resolver database fails closed for non-PO jobs', async () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const original = enqueue(queue, { sourceTable: 'mystery_table', sourceKey: 'opaque:2', sourceRevision: '1', eventType: 'mystery.changed' });
  let projected = false;
  const worker = new ManufacturingContextWorker({
    queue, workerId: 'worker:narrow', now: () => at,
    project: () => { projected = true; return { projectedWatermark: 'must-not-succeed' }; },
  });
  await worker.runOnce();
  const failed = queue.get(original.id)!;
  assert.equal(projected, false);
  assert.equal(failed.status, 'retry_wait');
  assert.match(failed.lastError ?? '', /unsupported.*source\/event/i);
});

test('worker builds projector-compatible current PO backfill jobs from durable mutation jobs', async () => {
  const { db, queue } = sourceGraphFixture();
  enqueue(queue, { sourceTable: 'procurement_documents', sourceKey: 'shipment:shipment:1', sourceRevision: '1', eventType: 'shipment.changed' });
  let projected: TwinProjectionJob | undefined;
  const worker = new ManufacturingContextWorker({
    db, queue, workerId: 'worker:shape', now: () => at,
    project: (job) => { projected = job; return { projectedWatermark: 'watermark:po:1' }; },
  });
  await worker.runOnce();
  assert.equal(projected?.sourceTable, 'procurement_documents');
  assert.equal(projected?.sourceKey, 'po:1');
  assert.equal(projected?.eventType, 'purchase_order.backfill');
  assert.equal(projected?.sourceRevision, '1');
  const row = db.prepare("SELECT json FROM procurement_documents WHERE tenant_id='tenant:a' AND kind='purchase_order' AND id='po:1'").get() as { json: string };
  assert.equal(projected?.payloadHash, createHash('sha256').update(canonicalTwinJson(JSON.parse(row.json))).digest('hex'));
});
