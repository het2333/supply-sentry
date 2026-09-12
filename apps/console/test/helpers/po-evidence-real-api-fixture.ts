import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Communication, PurchaseOrder, PurchaseOrderLine, Supplier } from '../../../../packages/core/src/index.js';
import { createProcurementRepository, openPersistence, type PersistenceStore } from '../../../../packages/persistence/src/index.js';
import { resolveSession, type Session } from '../../../api/src/auth.js';
import { handleProcurementExecutionRequest } from '../../../api/src/procurement-execution.js';
import { handleProcurementTenantPreferencesRequest } from '../../../api/src/procurement-tenant-preferences.js';
import { handleProcurementWorkbenchRequest } from '../../../api/src/procurement-workbench.js';

export type PersistedEvidenceKind = 'confirmation' | 'production' | 'shipment' | 'transport' | 'receipt';

export const REAL_EVIDENCE_TENANT_ID = 'tenant:test:po-evidence-ui-sqlite';
export const REAL_EVIDENCE_MANAGER_ID = 'human:test:po-evidence-manager';
const at = '2026-08-21T00:00:00.000Z';
const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

export const realEvidenceIds: Record<PersistedEvidenceKind, { poId: string; lineId: string }> = {
  confirmation: { poId: 'po:test:evidence-ui:confirmation', lineId: 'po-line:test:evidence-ui:confirmation' },
  production: { poId: 'po:test:evidence-ui:production', lineId: 'po-line:test:evidence-ui:production' },
  shipment: { poId: 'po:test:evidence-ui:shipment', lineId: 'po-line:test:evidence-ui:shipment' },
  transport: { poId: 'po:test:evidence-ui:transport', lineId: 'po-line:test:evidence-ui:transport' },
  receipt: { poId: 'po:test:evidence-ui:receipt', lineId: 'po-line:test:evidence-ui:receipt' },
};

function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `rw1.${payload}.${signature}`;
}

function seedBaseDocuments(store: PersistenceStore): Partial<Record<PersistedEvidenceKind, string>> {
  store.db.prepare(`INSERT INTO procurement_communication_identities
    (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
    VALUES (?,?,?,?, 'active',1,?,?,?,?)`).run(
    REAL_EVIDENCE_TENANT_ID, '集成测试采购经理', '采购经理', '隔离测试租户',
    REAL_EVIDENCE_MANAGER_ID, REAL_EVIDENCE_MANAGER_ID, at, at,
  );

  const repository = createProcurementRepository(store.db, REAL_EVIDENCE_TENANT_ID);
  const supplier: Supplier = {
    id: 'supplier:test:evidence-ui', tenantId: REAL_EVIDENCE_TENANT_ID, sourceSystem: 'readywork',
    externalId: 'SUPPLIER-EVIDENCE-UI-TEST', status: 'active', createdAt: at, updatedAt: at,
    name: '隔离证据表单测试供应商', currency: 'CNY',
    contacts: [{ id: 'contact:test:evidence-ui', name: '测试联系人', email: 'evidence-fixture@example.test', primary: true }],
  };
  repository.saveDocument('supplier', supplier);

  const initialStatus: Record<PersistedEvidenceKind, PurchaseOrder['status']> = {
    confirmation: 'sent', production: 'confirmed', shipment: 'confirmed', transport: 'confirmed', receipt: 'confirmed',
  };
  for (const kind of Object.keys(realEvidenceIds) as PersistedEvidenceKind[]) {
    const ids = realEvidenceIds[kind];
    const po: PurchaseOrder = {
      id: ids.poId, tenantId: REAL_EVIDENCE_TENANT_ID, sourceSystem: 'readywork',
      externalId: `PO-EVIDENCE-UI-${kind.toUpperCase()}`, status: initialStatus[kind],
      createdAt: at, updatedAt: at, supplierId: supplier.id,
      currency: 'CNY', orderedAt: at, requiredInHouseAt: '2026-09-20T00:00:00.000Z',
    };
    const line: PurchaseOrderLine = {
      id: ids.lineId, poId: po.id, lineNumber: '10', itemId: `VALVE-${kind.toUpperCase()}`,
      description: `${kind} 隔离测试阀门`, uom: '件', orderedQty: 200,
      unitPrice: 127, currency: 'CNY', requestedAt: '2026-09-20T00:00:00.000Z',
    };
    repository.saveDocument('purchase_order', po);
    repository.saveLine('purchase_order_line', po.id, line);
  }

  const confirmationIds = realEvidenceIds.confirmation;
  const inbound: Communication = {
    id: 'communication:test:evidence-ui:confirmation', tenantId: REAL_EVIDENCE_TENANT_ID,
    sourceSystem: 'imap:test-disabled', externalId: '<evidence-ui-confirmation@example.test>', status: 'received',
    createdAt: at, updatedAt: at, businessObjectId: confirmationIds.poId, businessObjectType: 'purchase_order',
    supplierId: supplier.id, channel: 'email', direction: 'inbound', messageId: '<evidence-ui-confirmation@example.test>',
    from: 'evidence-fixture@example.test', subject: '隔离测试 PO 确认',
    body: '200 件，单价 127 CNY，2026-09-20 交货。', attachmentIds: [], occurredAt: at, receivedAt: at,
  };
  repository.saveDocument('communication', inbound);

  const seededShipmentIds: Partial<Record<PersistedEvidenceKind, string>> = {};
  for (const kind of ['transport', 'receipt'] as const) {
    const ids = realEvidenceIds[kind];
    const seeded = repository.executeProcurementMutation({
      action: 'record_shipment', idempotencyKey: `fixture:${kind}:seed-shipment`,
      payloadHash: `fixture:${kind}:seed-shipment:v1`, actorId: REAL_EVIDENCE_MANAGER_ID,
      permission: 'approve', aggregateId: ids.poId, expectedVersion: 1, occurredAt: at,
      evidenceSource: 'manual_verified', evidenceReference: `fixture:${kind}:seed-asn-source`,
      supplierReference: `ASN-FIXTURE-${kind.toUpperCase()}`, reason: '为隔离持久化测试预置真实发运事实',
      lines: [{ poLineId: ids.lineId, quantity: 100 }],
    });
    assert.equal(seeded.aggregate.version, 2);
    assert.equal(seeded.aggregate.document.status, 'partially_shipped');
    seededShipmentIds[kind] = seeded.createdDocuments[0]!.id;
  }
  return seededShipmentIds;
}

function bearerToken(): string {
  return signSession({
    username: 'test-po-evidence-manager', tenantId: REAL_EVIDENCE_TENANT_ID,
    humanId: REAL_EVIDENCE_MANAGER_ID, name: '隔离测试采购经理', role: '采购经理',
    expiresAt: Date.now() + 10 * 60_000,
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function startRealEvidenceApiFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-po-evidence-ui-sqlite-'));
  const databasePath = join(directory, 'po-evidence-ui.sqlite');
  const store = openPersistence(databasePath, { tenantId: REAL_EVIDENCE_TENANT_ID });
  const seededShipmentIds = seedBaseDocuments(store);
  const connectorChecks: string[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers['authorization'];
    const rawToken = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const session = resolveSession(rawToken);
    const executionConnectorReady = (channel: 'email' | 'erp', connectorId: string) => {
      connectorChecks.push(`${channel}:${connectorId}`);
      return false;
    };
    const workbenchConnectorReady = (connectorId: string) => {
      connectorChecks.push(`workbench:${connectorId}`);
      return false;
    };
    void (async () => {
      if (await handleProcurementExecutionRequest(req, res, url.pathname, req.method ?? 'GET', {
        db: store.db, session, connectorReady: executionConnectorReady,
      })) return;
      if (await handleProcurementWorkbenchRequest(req, res, url.pathname, req.method ?? 'GET', {
        db: store.db, session, connectorReady: workbenchConnectorReady,
      })) return;
      if (await handleProcurementTenantPreferencesRequest(req, res, url.pathname, req.method ?? 'GET', {
        db: store.db, session,
      })) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'isolated test route not found', path: url.pathname }));
    })().catch((error: unknown) => {
      if (res.headersSent) return res.end();
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = bearerToken();
  const nativeFetch = globalThis.fetch;

  const forwardFetch = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return nativeFetch(new URL(path, baseUrl), { ...init, headers });
  };
  const readContext = async (poId: string): Promise<Record<string, unknown>> => {
    const response = await nativeFetch(`${baseUrl}/api/procurement/workbench/context/${encodeURIComponent(poId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };

  return {
    store, databasePath, baseUrl, token, connectorChecks, seededShipmentIds, forwardFetch, readContext,
    async close() {
      await closeServer(server);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
