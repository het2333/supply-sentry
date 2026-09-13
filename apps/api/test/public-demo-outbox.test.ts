import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { ProcurementOutboxWorker, type OutboxConnectorPort } from '../src/procurement-outbox-worker.js';
import { PUBLIC_DEMO_TENANT_ID } from '../src/public-demo-mode.js';
import { resetPublicDemo } from '../src/public-demo-reset.js';
import { PUBLIC_DEMO_IDS } from '../src/public-demo-seed.js';

const at = '2026-09-13T04:15:00.000Z';

function insertPendingOutbox(
  db: ReturnType<typeof openPersistence>['db'],
  input: { id: string; aggregateId: string },
): void {
  const value = {
    id: input.id,
    tenantId: PUBLIC_DEMO_TENANT_ID,
    channel: 'email',
    connectorId: 'email',
    action: 'purchase_order.followup',
    aggregateId: input.aggregateId,
    idempotencyKey: input.id,
    status: 'pending',
    payload: { synthetic: true },
    attempts: 0,
    createdAt: at,
    updatedAt: at,
  };
  db.prepare(`INSERT INTO procurement_outbox
    (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,attempt,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      PUBLIC_DEMO_TENANT_ID,
      value.id,
      value.channel,
      value.connectorId,
      value.action,
      value.aggregateId,
      value.idempotencyKey,
      value.status,
      JSON.stringify(value.payload),
      JSON.stringify(value),
      value.attempts,
      value.createdAt,
      value.updatedAt,
    );
}

test('Outbox persists accepted and uncertain demo receipts without resolving adapters or credentials', async () => {
  const store = openPersistence(':memory:', { tenantId: PUBLIC_DEMO_TENANT_ID });
  resetPublicDemo(store.db, new Date('2026-09-13T04:00:00.000Z'));
  const acceptedId = 'outbox:public-demo:accepted-runtime';
  const uncertainId = 'outbox:public-demo:uncertain-runtime';
  insertPendingOutbox(store.db, { id: acceptedId, aggregateId: PUBLIC_DEMO_IDS.normalPo });
  insertPendingOutbox(store.db, { id: uncertainId, aggregateId: PUBLIC_DEMO_IDS.delayedImportPo });

  let connectorResolutionCalls = 0;
  let executeCalls = 0;
  let credentialReads = 0;
  const connectorsForTenant = (): OutboxConnectorPort => {
    connectorResolutionCalls += 1;
    return {
      execute: async () => {
        executeCalls += 1;
        throw new Error('a public demo outbox reached a real connector');
      },
      listCredentials: () => {
        credentialReads += 1;
        throw new Error('a public demo outbox listed real credentials');
      },
      getCredential: () => {
        credentialReads += 1;
        throw new Error('a public demo outbox read a real credential');
      },
    };
  };
  let messageGatewayCalls = 0;
  const worker = new ProcurementOutboxWorker(store.db, connectorsForTenant, {
    now: () => new Date(at),
    messageGatewayForTenant: () => ({
      deliver: async () => {
        messageGatewayCalls += 1;
        throw new Error('a public demo outbox reached the real message gateway');
      },
    }),
  });

  const summary = await worker.runTenant(PUBLIC_DEMO_TENANT_ID);
  assert.deepEqual(summary, { claimed: 2, dispatched: 1, retryScheduled: 0, failed: 1 });
  assert.equal(connectorResolutionCalls, 0);
  assert.equal(executeCalls, 0);
  assert.equal(credentialReads, 0);
  assert.equal(messageGatewayCalls, 0);

  const repository = createProcurementRepository(store.db, PUBLIC_DEMO_TENANT_ID);
  const accepted = repository.getOutboxMessage(acceptedId)!;
  assert.equal(accepted.status, 'dispatched');
  assert.deepEqual(accepted.connectorResult, {
    receiptKind: 'simulated_demo',
    outcome: 'accepted',
    externalDelivery: false,
    connector: 'email',
    action: 'purchase_order.followup',
    reference: accepted.connectorResult?.['reference'],
    generatedAt: at,
    generation: 1,
  });

  const uncertain = repository.getOutboxMessage(uncertainId)!;
  assert.equal(uncertain.status, 'failed');
  assert.equal(uncertain.connectorResult?.['receiptKind'], 'simulated_demo');
  assert.equal(uncertain.connectorResult?.['outcome'], 'uncertain');
  assert.equal(uncertain.connectorResult?.['externalDelivery'], false);
  const exception = store.db.prepare(`SELECT json FROM runtime_exceptions
    WHERE tenant_id=? AND object_id=?`).get(PUBLIC_DEMO_TENANT_ID, PUBLIC_DEMO_IDS.delayedImportPo) as { json: string } | undefined;
  assert.equal(JSON.parse(exception!.json).type, 'external_delivery_uncertain');

  const audits = store.db.prepare(`SELECT detail_json FROM public_demo_audit
    WHERE tenant_id=? AND event_type='public_demo.external_action.simulated' ORDER BY created_at,id`).all(PUBLIC_DEMO_TENANT_ID) as Array<{ detail_json: string }>;
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map((row) => JSON.parse(row.detail_json).receipt.outcome).sort(), ['accepted', 'uncertain']);
  store.close();
});
