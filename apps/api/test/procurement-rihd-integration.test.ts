import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { PurchaseOrder, PurchaseOrderLine } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementExecutionRequest } from '../src/procurement-execution.js';
import { ProcurementOutboxWorker } from '../src/procurement-outbox-worker.js';
import { handleProcurementWorkbenchRequest } from '../src/procurement-workbench.js';

const at = '2026-09-01T08:00:00.000Z';
const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

test('Edit RIHD 真实纵切: Web API 入队 → Odoo 写/读核验 → SQLite/Twin/审计 → 刷新读回', async () => {
  const tenantId = 'tenant:rihd:e2e';
  const store = openPersistence(':memory:', { tenantId });
  const repository = createProcurementRepository(store.db, tenantId);
  const po = {
    id: 'po:rihd:e2e', tenantId, sourceSystem: 'odoo', externalId: 'purchase.order:22', status: 'confirmed',
    createdAt: at, updatedAt: at, supplierId: 'supplier:rihd:e2e', currency: 'CNY', orderedAt: at,
    number: 'P00022', requiredInHouseAt: '2026-09-10T00:00:00.000Z', promisedAt: '2026-09-10T00:00:00.000Z',
  } as PurchaseOrder & { number: string };
  const line: PurchaseOrderLine = {
    id: 'po-line:rihd:e2e', poId: po.id, lineNumber: '91', itemId: 'VALVE-22', description: '气动阀', uom: '件',
    orderedQty: 8, unitPrice: 20, currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z',
  };
  repository.saveDocument('purchase_order', po);
  repository.saveLine('purchase_order_line', po.id, line);

  const managerToken = signSession({
    username: 'manager', tenantId, humanId: 'human:manager', name: '采购经理', role: '采购经理', expiresAt: Date.now() + 60_000,
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const session = resolveSession(token);
    void handleProcurementExecutionRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session, connectorReady: (channel, connectorId) => channel === 'erp' && connectorId === 'erp',
    }).then(async (handled) => {
      if (handled) return;
      const workbenchHandled = await handleProcurementWorkbenchRequest(req, res, url.pathname, req.method ?? 'GET', {
        db: store.db, session, now: () => new Date(at), connectorReady: (connectorId) => connectorId === 'erp',
      });
      if (!workbenchHandled) res.writeHead(404).end();
    }).catch((error: unknown) => res.writeHead(500).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${managerToken}` };

  try {
    const queuedResponse = await fetch(`${base}/api/procurement/execution/update_rihd`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'rihd-e2e-1' },
      body: JSON.stringify({ aggregateId: po.id, expectedVersion: 1, connectorId: 'erp', requiredInHouseAt: '2026-09-30', reason: '项目需求日已经审批调整' }),
    });
    const queued = await queuedResponse.json() as Record<string, any>;
    assert.equal(queuedResponse.status, 201);
    assert.equal(queued['outbox']['status'], 'pending');
    assert.equal(queued['aggregate']['document']['requiredInHouseAt'], '2026-09-10T00:00:00.000Z', '入队不得冒充 ERP 成功');

    const before = await (await fetch(`${base}/api/procurement/workbench/context/${encodeURIComponent(po.id)}`, { headers })).json() as Record<string, any>;
    assert.equal(before['purchaseOrders'][0]['requiredInHouseAt'], '2026-09-10T00:00:00.000Z');

    let externalWrite: { poNumber: string; eta: string } | undefined;
    const worker = new ProcurementOutboxWorker(store.db, () => ({
      execute: async () => { throw new Error('tenant-scoped Odoo runtime must be used'); },
      listCredentials: () => [{ id: 'credential:erp:e2e', connectorId: 'erp', status: 'connected' }],
      getCredential: () => ({ apiKey: 'must-not-be-used' }),
    }), {
      now: () => new Date('2026-09-01T08:00:01.000Z'),
      odooRuntimeResolver: { resolve: () => ({
        client: {
          updateETA: async (poNumber: string, eta: string) => { externalWrite = { poNumber, eta }; return { updated: 1, lines: 1 }; },
          readPO: async () => ({ name: 'P00022', lines: [{ id: 91, datePlanned: '2026-09-30 00:00:00' }] }),
        } as never,
        credential: { credentialId: 'credential:erp:e2e', credentialVersion: 'v1', lastTestedAt: at },
      }) },
    });
    assert.equal((await worker.runTenant(tenantId)).dispatched, 1);
    assert.deepEqual(externalWrite, { poNumber: 'P00022', eta: '2026-09-30T00:00:00.000Z' });

    const after = await (await fetch(`${base}/api/procurement/workbench/context/${encodeURIComponent(po.id)}`, { headers })).json() as Record<string, any>;
    assert.equal(after['purchaseOrders'][0]['version'], 2);
    assert.equal(after['purchaseOrders'][0]['requiredInHouseAt'], '2026-09-30T00:00:00.000Z');
    assert.equal(after['purchaseOrders'][0]['lines'][0]['requestedAt'], '2026-09-30T00:00:00.000Z');
    assert.ok(after['activities'].some((activity: Record<string, unknown>) => activity['action'] === 'purchase_order.rihd_updated'));
    assert.equal(repository.getOutboxMessage(queued['outbox']['id'])?.status, 'dispatched');
    const projectionJobs = store.db.prepare(`SELECT event_type FROM twin_projection_jobs
      WHERE tenant_id=? AND source_key IN (?,?,?)`).all(
      tenantId,
      `purchase_order:${po.id}`,
      `purchase_order_line:${line.id}`,
      queued['outbox']['id'],
    ) as Array<{ event_type: string }>;
    assert.ok(projectionJobs.some((job) => job.event_type === 'purchase_order.changed'));
    assert.ok(projectionJobs.some((job) => job.event_type === 'purchase_order_line.changed'));
    assert.ok(projectionJobs.some((job) => job.event_type === 'procurement_outbox.changed'));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
