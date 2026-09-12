import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TwinProjectionJob } from '@readywork/core';
import {
  canonicalTwinJson,
  ProcurementPoProjector,
  purchaseOrderMissingFacts,
  SqliteManufacturingContextStore,
  SqliteTwinProjectionQueue,
} from '@readywork/context';

const ACCEPTANCE_PO_ID = 'po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a';
const EXPECTED_MISSING_FACTS = [
  'odoo_purchase_order',
  'supplier_confirmation',
  'production_progress',
  'shipment',
  'grn',
] as const;
const VALIDATION_EMPLOYEE_ID = 'employee:manufacturing-context-validation';
const VALIDATION_RUN_ID = 'validation:manufacturing-context:v2';

type JsonObject = Record<string, unknown>;
type GraphCounts = { entities: number; relations: number; evidence: number };

function requiredArgument(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function openRealDatabase(inputPath: string): { db: DatabaseSync; databasePath: string } {
  if (inputPath === ':memory:' || inputPath.startsWith('file::memory:')) {
    throw new Error('Manufacturing Context acceptance refuses in-memory databases');
  }
  const databasePath = resolve(inputPath);
  if (!statSync(databasePath).isFile()) throw new Error('Manufacturing Context database path must be an existing file');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  return { db, databasePath };
}

function parseObject(json: string, label: string): JsonObject {
  const value = JSON.parse(json) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as JsonObject;
}

function projectionPayloadHash(json: string): string {
  return createHash('sha256').update(canonicalTwinJson(JSON.parse(json) as unknown)).digest('hex');
}

function claimOnlyAcceptanceJob(
  db: DatabaseSync,
  tenantId: string,
  queue: SqliteTwinProjectionQueue,
  job: TwinProjectionJob,
): TwinProjectionJob {
  if (job.status === 'succeeded') return job;
  if (!['queued', 'retry_wait'].includes(job.status)) {
    throw new Error(`Acceptance will not replay projection job in status ${job.status}`);
  }
  const claimedAt = new Date().toISOString();
  if (Date.parse(job.availableAt) > Date.parse(claimedAt)) {
    throw new Error('Acceptance will not bypass a projection retry delay');
  }
  const leaseToken = `twin-projection-lease:validation:${randomUUID()}`;
  const leaseExpiresAt = new Date(Date.parse(claimedAt) + 5 * 60_000).toISOString();
  const changed = db.prepare(`UPDATE twin_projection_jobs
    SET status='processing',attempts=attempts+1,lease_owner=?,lease_token=?,lease_expires_at=?,updated_at=?
    WHERE tenant_id=? AND id=? AND status IN ('queued','retry_wait') AND available_at<=?`)
    .run('worker:manufacturing-context-validation', leaseToken, leaseExpiresAt, claimedAt,
      tenantId, job.id, claimedAt);
  if (Number(changed.changes) !== 1) throw new Error('Acceptance projection job was claimed concurrently');
  const claimed = queue.get(job.id);
  if (!claimed?.leaseToken) throw new Error('Acceptance projection lease was not persisted');
  return claimed;
}

function graphCounts(
  store: SqliteManufacturingContextStore,
  rootEntityId: string,
): { counts: GraphCounts; entityTypes: string[]; sourceWatermark: string } {
  const graph = store.getNeighborhood(rootEntityId, { depth: 2, entityLimit: 500, evidenceLimit: 2_000 });
  return {
    counts: { entities: graph.entities.length, relations: graph.relations.length, evidence: graph.evidence.length },
    entityTypes: [...new Set(graph.entities.map((entity) => entity.entityType))].sort(),
    sourceWatermark: graph.sourceWatermark,
  };
}

function main(): void {
  const databaseArgument = requiredArgument(process.argv[2], 'database path');
  const tenantId = requiredArgument(process.argv[3], 'tenant ID');
  const poId = requiredArgument(process.argv[4], 'purchase order ID');
  assert.equal(poId, ACCEPTANCE_PO_ID, 'Acceptance is restricted to the briefed real purchase order');

  const { db, databasePath } = openRealDatabase(databaseArgument);
  try {
    const poRow = db.prepare(`SELECT version,json FROM procurement_documents
      WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, poId) as {
        version: number;
        json: string;
      } | undefined;
    assert.ok(poRow, 'Real purchase order must exist in the configured tenant');
    const po = parseObject(poRow.json, 'purchase order');
    assert.equal(po['status'], 'sent');
    assert.equal(po['currency'], 'CNY');

    const supplierRow = db.prepare(`SELECT json FROM procurement_documents
      WHERE tenant_id=? AND kind='supplier' AND id=?`).get(tenantId, String(po['supplierId'])) as {
        json: string;
      } | undefined;
    assert.ok(supplierRow, 'Real supplier must exist');
    const supplier = parseObject(supplierRow.json, 'supplier');
    assert.equal(supplier['name'], '上海卓越阀门');

    const lineRows = db.prepare(`SELECT id,json FROM procurement_lines
      WHERE tenant_id=? AND kind='purchase_order_line' AND document_id=? ORDER BY line_number,id`)
      .all(tenantId, poId) as Array<{ id: string; json: string }>;
    assert.equal(lineRows.length, 1, 'Acceptance PO must have exactly one line');
    const line = parseObject(lineRows[0]!.json, 'purchase order line');
    assert.equal(line['itemId'], 'PV-30');
    assert.equal(line['orderedQty'], 200);
    assert.equal(line['unitPrice'], 127);
    assert.equal(line['currency'], 'CNY');

    const outboxRow = db.prepare(`SELECT id,action,status,json FROM procurement_outbox
      WHERE tenant_id=? AND aggregate_id=? AND action='purchase_order.send'
      ORDER BY created_at,id LIMIT 1`).get(tenantId, poId) as {
        id: string;
        action: string;
        status: string;
        json: string;
      } | undefined;
    assert.ok(outboxRow, 'purchase_order.send Outbox receipt must exist');
    assert.equal(outboxRow.action, 'purchase_order.send');
    assert.equal(outboxRow.status, 'dispatched');
    const outbox = parseObject(outboxRow.json, 'purchase order Outbox receipt');
    assert.equal(outbox['action'], 'purchase_order.send');
    assert.equal(outbox['status'], 'dispatched');

    const stageRow = db.prepare(`SELECT id,stage,event_type,state,source_kind
      FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=?
      ORDER BY occurred_at DESC,id DESC LIMIT 1`).get(tenantId, poId) as {
        id: string;
        stage: string;
        event_type: string;
        state: string;
        source_kind: string;
      } | undefined;
    assert.ok(stageRow, 'Observed migration stage history must exist');
    assert.equal(stageRow.stage, 'supplier_commitment');
    assert.equal(stageRow.state, 'active');
    assert.equal(stageRow.event_type, 'observed_status_backfill');
    assert.equal(stageRow.source_kind, 'migration');

    const missingFacts = purchaseOrderMissingFacts(db, tenantId, poId);
    assert.deepEqual(missingFacts, [...EXPECTED_MISSING_FACTS]);

    const context = new SqliteManufacturingContextStore(db, tenantId);
    const queue = new SqliteTwinProjectionQueue(db, tenantId);
    const projector = new ProcurementPoProjector(db, tenantId, context);
    const payloadHash = projectionPayloadHash(poRow.json);
    const enqueued = queue.enqueue({
      sourceTable: 'procurement_documents',
      sourceKey: poId,
      sourceRevision: String(poRow.version),
      eventType: 'purchase_order.backfill',
      payloadHash,
      availableAt: new Date().toISOString(),
    });
    const job = claimOnlyAcceptanceJob(db, tenantId, queue, enqueued);

    const firstRoot = projector.project(job);
    const firstProjection = graphCounts(context, firstRoot.id);
    const secondRoot = projector.project(job);
    const secondProjection = graphCounts(context, secondRoot.id);
    assert.equal(secondRoot.id, firstRoot.id);
    assert.deepEqual(secondProjection.counts, firstProjection.counts);
    assert.equal(secondProjection.sourceWatermark, firstProjection.sourceWatermark);
    for (const requiredType of ['purchase_order', 'po_line', 'supplier', 'material', 'rfq', 'quote', 'award']) {
      assert.ok(secondProjection.entityTypes.includes(requiredType), `Real PO graph is missing ${requiredType}`);
    }

    let settledJob = job;
    if (job.status === 'processing') {
      settledJob = queue.succeed({
        id: job.id,
        leaseToken: job.leaseToken!,
        completedAt: new Date().toISOString(),
        projectedWatermark: secondRoot.sourceWatermark,
      });
    }
    assert.equal(settledJob.status, 'succeeded');

    const rootEvidence = context.listEvidence(firstRoot.id);
    const stageEvidence = rootEvidence.find((evidence) => (
      evidence.sourceKind === 'procurement_po_stage_events'
      && evidence.sourceId === stageRow.id
      && evidence.factPath === 'purchase_order.stage_event'
    ));
    assert.ok(stageEvidence, 'Projected migration stage evidence must exist');
    assert.equal(stageEvidence.sourceSemantics, 'observed_backfill');
    const outboxEvidence = rootEvidence.find((evidence) => (
      evidence.sourceKind === 'procurement_outbox'
      && evidence.sourceId === outboxRow.id
      && evidence.factPath === 'purchase_order.outbox'
    ));
    assert.ok(outboxEvidence, 'Projected Outbox receipt evidence must exist');
    const outboxEvidenceValue = outboxEvidence.value as JsonObject;
    assert.equal(outboxEvidenceValue['status'], 'dispatched');
    assert.equal(outboxEvidenceValue['action'], 'purchase_order.send');
    assert.deepEqual(firstRoot.state['missingFacts'], [...EXPECTED_MISSING_FACTS]);

    const validationCorrelation = createHash('sha256').update(canonicalTwinJson({
      tenantId,
      purchaseOrderId: poId,
      rootEntityId: firstRoot.id,
      sourceWatermark: secondProjection.sourceWatermark,
    })).digest('hex').slice(0, 32);
    const validationTaskId = `validation:real-po:v2:${validationCorrelation}`;
    const existingEvent = db.prepare(`SELECT id,input_snapshot_id,business_object_id,entity_id
      FROM twin_agent_events
      WHERE tenant_id=? AND employee_id=? AND run_id=? AND task_id=? AND event_type='context_read'
        AND business_object_id=? AND entity_id=?
      ORDER BY created_at,id LIMIT 1`).get(
      tenantId, VALIDATION_EMPLOYEE_ID, VALIDATION_RUN_ID, validationTaskId, poId, firstRoot.id,
    ) as {
      id: string;
      input_snapshot_id: string | null;
      business_object_id: string | null;
      entity_id: string | null;
    } | undefined;
    const snapshot = existingEvent?.input_snapshot_id
      ? context.getSnapshot(existingEvent.input_snapshot_id)
      : context.createSnapshot({
          employeeId: VALIDATION_EMPLOYEE_ID,
          rootEntityId: firstRoot.id,
          purpose: `manufacturing-context-real-po-validation:v2:${validationCorrelation}`,
          scope: {
            permission: 'operate',
            entityTypes: [],
            includeContactDetails: false,
            includeCommercialTerms: true,
          },
        });
    assert.ok(snapshot, 'Validation snapshot must exist');
    assert.equal(snapshot.rootEntityId, firstRoot.id, 'Validation snapshot root must match the current PO root');
    assert.equal(snapshot.sourceWatermark, secondProjection.sourceWatermark,
      'Validation snapshot watermark must match the current graph');
    const agentEvent = context.appendAgentEvent({
      employeeId: VALIDATION_EMPLOYEE_ID,
      runId: VALIDATION_RUN_ID,
      taskId: validationTaskId,
      businessObjectId: poId,
      entityId: firstRoot.id,
      eventType: 'context_read',
      inputSnapshotId: snapshot.id,
      status: 'completed',
      confidence: 1,
      evidenceIds: [stageEvidence.id, outboxEvidence.id],
      payload: { validation: 'manufacturing_context', purchaseOrderId: poId, result: 'accepted' },
      createdAt: snapshot.createdAt,
    });
    const reloadedSnapshot = context.getSnapshot(snapshot.id);
    const reloadedEvent = db.prepare(`SELECT id,business_object_id,entity_id,input_snapshot_id,status FROM twin_agent_events
      WHERE tenant_id=? AND id=?`).get(tenantId, agentEvent.id) as {
        id: string;
        business_object_id: string | null;
        entity_id: string | null;
        input_snapshot_id: string | null;
        status: string;
      } | undefined;
    assert.ok(reloadedSnapshot, 'Validation snapshot must reload');
    assert.ok(reloadedEvent, 'Validation Agent Event must reload');
    assert.equal(reloadedEvent.business_object_id, poId);
    assert.equal(reloadedEvent.entity_id, firstRoot.id);
    assert.equal(reloadedEvent.input_snapshot_id, reloadedSnapshot.id);
    assert.equal(agentEvent.inputSnapshotId, reloadedSnapshot.id);
    assert.equal(reloadedSnapshot.rootEntityId, firstRoot.id);
    assert.equal(reloadedSnapshot.sourceWatermark, secondProjection.sourceWatermark);

    const safeOutput = {
      status: 'PASS',
      databasePath,
      tenantId,
      purchaseOrder: {
        id: poId,
        supplier: supplier['name'],
        item: line['itemId'],
        quantity: line['orderedQty'],
        unitPrice: line['unitPrice'],
        currency: line['currency'],
        status: po['status'],
        currentStage: stageRow.stage,
        outboxStatus: outboxRow.status,
        missingFacts,
      },
      projection: {
        jobId: settledJob.id,
        jobStatus: settledJob.status,
        sourceRevision: settledJob.sourceRevision,
        payloadHash,
        projectedWatermark: settledJob.projectedWatermark ?? secondRoot.sourceWatermark,
        first: { rootEntityId: firstRoot.id, ...firstProjection },
        second: { rootEntityId: secondRoot.id, ...secondProjection },
        countsStable: true,
      },
      evidence: {
        migrationSemantics: stageEvidence.sourceSemantics,
        migrationEvidenceId: stageEvidence.id,
        outboxEvidenceId: outboxEvidence.id,
      },
      snapshot: {
        id: reloadedSnapshot.id,
        sourceWatermark: reloadedSnapshot.sourceWatermark,
        contentHash: reloadedSnapshot.contentHash,
      },
      agentEvent: {
        id: reloadedEvent.id,
        inputSnapshotId: reloadedEvent.input_snapshot_id,
        status: reloadedEvent.status,
      },
      externalSideEffects: {
        emailSent: false,
        odooPurchaseOrderCreated: false,
        shipmentCreated: false,
        grnCreated: false,
      },
    };
    console.log(JSON.stringify(safeOutput, null, 2));
  } finally {
    db.close();
  }
}

main();
