import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Session } from '../src/auth.js';
import { SqliteManufacturingContextStore, SqliteTwinProjectionQueue } from '@readywork/context';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import { handleManufacturingContextRequest, mapEmployeeContextScope } from '../src/manufacturing-context-routes.js';
import { routeDomain, surfaceAllows } from '../src/service-surface.js';

const at = '2026-08-29T08:00:00.000Z';

function seedPersistedEmployee(
  db: DatabaseSync,
  tenantId: string,
  employeeId: string,
  contextScope: string[],
  permissions: Array<{ effect: 'allow' | 'deny'; action: string; resource: string }>,
): void {
  const versionId = `${employeeId}:version:1`;
  const definition = { id: employeeId, tenantId, name: employeeId, role: 'test', departmentId: 'dept:test', capabilityPackIds: [], createdAt: at, updatedAt: at };
  const version = {
    id: versionId, tenantId, employeeId, version: '1', capabilityPackIds: [], workflowIds: [], connectorGrantIds: [], createdAt: at,
    spec: { id: `spec:${employeeId}`, name: employeeId, departmentId: 'dept:test', version: '1', role: 'test', goals: [], workers: [], workflows: [], skills: [], tools: [], permissions, policies: [], approvalRules: [], contextScope, evalCriteria: [], humanEscalation: { contactIds: [] } },
  };
  db.prepare(`INSERT INTO workforce_employees
    (tenant_id,id,definition_json,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(tenantId, employeeId, JSON.stringify(definition), versionId, at, at);
  db.prepare(`INSERT INTO workforce_employee_versions
    (tenant_id,id,employee_id,version,definition_json,created_at) VALUES (?,?,?,?,?,?)`)
    .run(tenantId, versionId, employeeId, '1', JSON.stringify(version), at);
  db.prepare(`INSERT INTO workforce_employee_deployments
    (tenant_id,employee_id,version_id,deploy_mode,connector_grant_ids_json,updated_at) VALUES (?,?,?,'supervised','[]',?)`)
    .run(tenantId, employeeId, versionId, at);
}

async function contextApiFixture() {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const tenantA = new SqliteManufacturingContextStore(db, 'tenant:a');
  const tenantB = new SqliteManufacturingContextStore(db, 'tenant:b');
  const own = tenantA.upsertEntity({ entityType: 'purchase_order', canonicalKey: 'readywork:po:a', label: 'PO-A', lifecycleState: 'sent', attributes: { businessObjectId: 'po:a', authorization: 'Bearer route-secret' }, state: {}, sourceWatermark: 'wa', effectiveAt: at, observedAt: at });
  const other = tenantB.upsertEntity({ entityType: 'purchase_order', canonicalKey: 'readywork:po:b', label: 'PO-B', lifecycleState: 'sent', attributes: { businessObjectId: 'po:b' }, state: {}, sourceWatermark: 'wb', effectiveAt: at, observedAt: at });
  seedPersistedEmployee(db, 'tenant:a', 'ai:procurement', ['po', 'supplier', 'email', 'unknown-domain'], [
    { effect: 'allow', action: 'po.get', resource: 'erp' },
    { effect: 'allow', action: 'send', resource: 'email' },
  ]);
  const sessions: Record<string, Session> = {
    buyer: { username: 'buyer', tenantId: 'tenant:a', humanId: 'human:buyer', name: '采购员', role: '采购专员', expiresAt: Date.now() + 60_000 },
    manager: { username: 'manager', tenantId: 'tenant:a', humanId: 'human:manager', name: '经理', role: '采购经理', expiresAt: Date.now() + 60_000 },
    reader: {
      username: 'reader', tenantId: 'tenant:a', humanId: 'human:reader', name: '只读审计员',
      role: '采购专员', expiresAt: Date.now() + 60_000,
      contextPermission: 'read', contextEntityTypes: ['purchase_order', 'supplier'],
    } as Session,
  };
  const workerStatusTenants: unknown[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    void handleManufacturingContextRequest(req, res, path, req.method ?? 'GET', {
      db,
      session: sessions[token] ?? null,
      workerStatus: (tenantId?: string) => {
        workerStatusTenants.push(tenantId);
        return { state: 'ready', lastHeartbeatAt: new Date().toISOString() };
      },
      internal: token === 'internal',
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    db, ownEntityId: own.id, buyerToken: 'buyer', readerToken: 'reader', managerToken: 'manager', internalToken: 'internal', otherTenantEntityId: other.id,
    workerStatusTenants,
    async request(method: string, path: string, token: string, body?: Record<string, unknown>) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('stored snapshots are monotonically reduced to the current authenticated reader scope', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  const store = new SqliteManufacturingContextStore(fixture.db, 'tenant:a');
  const supplier = store.upsertEntity({
    entityType: 'supplier', canonicalKey: 'readywork:supplier:a', label: 'Supplier A', lifecycleState: 'active',
    attributes: { contacts: [{ email: 'buyer@supplier.example', phone: '13800138000' }], paymentTerms: 'NET30' },
    state: {}, sourceWatermark: 'supplier:w1', effectiveAt: at, observedAt: at,
  });
  const line = store.upsertEntity({
    entityType: 'po_line', canonicalKey: 'readywork:po-line:a', label: 'Line A', lifecycleState: 'ordered',
    attributes: { businessObjectId: 'po-line:a' }, state: { unitPrice: 127, currency: 'CNY' },
    sourceWatermark: 'line:w1', effectiveAt: at, observedAt: at,
  });
  const rootEvidence = store.appendEvidence({
    entityId: fixture.ownEntityId, sourceSemantics: 'deterministic', sourceKind: 'procurement_documents',
    sourceId: 'po:a', sourceVersion: '1', sourceHash: 'hash:po:a', factPath: 'purchase_order.status', value: 'sent',
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'system:test', rawReference: {},
  });
  const lineEvidence = store.appendEvidence({
    entityId: line.id, sourceSemantics: 'deterministic', sourceKind: 'procurement_lines', sourceId: 'po-line:a',
    sourceVersion: '1', sourceHash: 'hash:line:a', factPath: 'po_line.unit_price', value: 127,
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'system:test', rawReference: {},
  });
  const hiddenDerivedMarkers = ['hidden-stage-value', 'hidden-sla-value', 'hidden-approval-value', 'hidden-outbox-value'];
  for (const [index, factPath] of ['po_line.stage', 'po_line.sla', 'po_line.approval', 'po_line.outbox'].entries()) {
    store.appendEvidence({
      entityId: line.id, sourceSemantics: 'deterministic', sourceKind: 'hidden-line-source',
      sourceId: `hidden-derived:${index}`, sourceVersion: '1', sourceHash: `hash:hidden-derived:${index}`,
      factPath, value: { hiddenEntityId: line.id, marker: hiddenDerivedMarkers[index] },
      confidence: 1, effectiveAt: at, observedAt: at, actorId: 'system:test', rawReference: {},
    });
  }
  const rootContactEvidence = store.appendEvidence({
    entityId: fixture.ownEntityId, sourceSemantics: 'approved_human', sourceKind: 'contact',
    sourceId: 'contact:root-email', sourceVersion: '1', sourceHash: 'hash:root-contact-email',
    factPath: 'contact.email', value: 'root.contact@example.com',
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'human:manager', rawReference: {},
  });
  const supplierEmailEvidence = store.appendEvidence({
    entityId: supplier.id, sourceSemantics: 'approved_human', sourceKind: 'supplier',
    sourceId: 'supplier:contact-email', sourceVersion: '1', sourceHash: 'hash:supplier-contact-email',
    factPath: 'supplier.contact_email', value: 'sales@supplier.example',
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'human:manager', rawReference: {},
  });
  const supplierPhoneEvidence = store.appendEvidence({
    entityId: supplier.id, sourceSemantics: 'approved_human', sourceKind: 'supplier',
    sourceId: 'supplier:contact-phone', sourceVersion: '1', sourceHash: 'hash:supplier-contact-phone',
    factPath: 'supplier.contact_phone', value: ['13900139000', { value: '13700137000' }],
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'human:manager', rawReference: {},
  });
  store.appendEvidence({
    entityId: line.id, sourceSemantics: 'approved_human', sourceKind: 'approval', sourceId: 'approval:line:a',
    sourceVersion: '1', sourceHash: 'hash:line:conflict', factPath: 'po_line.unit_price', value: 128,
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'human:manager', rawReference: {},
  });
  store.upsertRelation({
    relationType: 'ordered_from', fromEntityId: fixture.ownEntityId, toEntityId: supplier.id,
    status: 'active', sourceEvidenceId: rootEvidence.id, validFrom: at,
  });
  store.upsertRelation({
    relationType: 'contains_line', fromEntityId: fixture.ownEntityId, toEntityId: line.id,
    status: 'active', sourceEvidenceId: lineEvidence.id, validFrom: at,
  });
  store.appendAgentEvent({
    employeeId: 'ai:procurement', runId: 'run:hidden-line', taskId: 'task:hidden-line', entityId: line.id,
    eventType: 'decision', status: 'completed', evidenceIds: [lineEvidence.id], payload: { unitPrice: 127 }, createdAt: at,
  });
  store.appendAgentEvent({
    employeeId: 'ai:procurement', runId: 'run:partial-dependency', taskId: 'task:partial-dependency',
    entityId: fixture.ownEntityId, eventType: 'decision', status: 'completed',
    evidenceIds: [rootEvidence.id, lineEvidence.id], payload: { notes: 'root-event-hidden-payload' }, createdAt: at,
  });
  store.appendAgentEvent({
    employeeId: 'ai:procurement', runId: 'run:no-dependency', taskId: 'task:no-dependency',
    eventType: 'decision', status: 'completed', evidenceIds: [], payload: { notes: 'entityless-zero-evidence-payload' }, createdAt: at,
  });
  const broad = store.createSnapshot({
    employeeId: 'ai:procurement', rootEntityId: fixture.ownEntityId, purpose: 'po_supplier_commitment',
    scope: { permission: 'approve', entityTypes: [], includeContactDetails: true, includeCommercialTerms: true },
  });
  const before = fixture.db.prepare(`SELECT snapshot_json,content_hash FROM twin_snapshots
    WHERE tenant_id='tenant:a' AND id=?`).get(broad.id) as { snapshot_json: string; content_hash: string };

  const reduced = await fixture.request('GET', `/api/context/v1/snapshots/${encodeURIComponent(broad.id)}`, fixture.readerToken);
  assert.equal(reduced.status, 200);
  const snapshot = reduced.body.data.snapshot as Record<string, any>;
  const serialized = JSON.stringify(snapshot);
  assert.match(serialized, /b\*\*\*@supplier\.example/);
  assert.match(serialized, /r\*\*\*@example\.com/);
  assert.match(serialized, /s\*\*\*@supplier\.example/);
  assert.match(serialized, /139\*\*\*\*9000/);
  assert.match(serialized, /137\*\*\*\*7000/);
  assert.doesNotMatch(serialized, new RegExp([
    'buyer@supplier\\.example', '13800138000', 'NET30', 'unitPrice', 'unit_price', '127', '128',
    'root\\.contact@example\\.com', 'sales@supplier\\.example', '13900139000', '13700137000',
    ...hiddenDerivedMarkers, 'root-event-hidden-payload', 'entityless-zero-evidence-payload',
  ].join('|')));
  assert.deepEqual(snapshot.stage, []);
  assert.deepEqual(snapshot.sla, []);
  assert.deepEqual(snapshot.approvals, []);
  assert.deepEqual(snapshot.outbox, []);
  assert.deepEqual((snapshot.entities as Array<Record<string, unknown>>).map((entity) => entity.entityType).sort(), ['purchase_order', 'supplier']);
  const retainedEntityIds = new Set((snapshot.entities as Array<Record<string, string>>).map((entity) => entity.id));
  const retainedRelationIds = new Set((snapshot.relations as Array<Record<string, string>>).map((relation) => relation.id));
  const retainedEvidenceIds = new Set((snapshot.evidence as Array<Record<string, string>>).map((evidence) => evidence.id));
  assert.equal((snapshot.relations as Array<Record<string, string>>).every((relation) => (
    retainedEntityIds.has(relation.fromEntityId) && retainedEntityIds.has(relation.toEntityId)
      && retainedEvidenceIds.has(relation.sourceEvidenceId)
  )), true);
  assert.equal((snapshot.evidence as Array<Record<string, string>>).every((evidence) => (
    (!evidence.entityId || retainedEntityIds.has(evidence.entityId))
      && (!evidence.relationId || retainedRelationIds.has(evidence.relationId))
  )), true);
  assert.equal((snapshot.agentEvents as Array<Record<string, string>>).every((event) => !event.entityId || retainedEntityIds.has(event.entityId)), true);
  assert.deepEqual(snapshot.agentEvents, []);

  const authorized = await fixture.request('GET', `/api/context/v1/snapshots/${encodeURIComponent(broad.id)}`, fixture.managerToken);
  assert.equal(authorized.status, 200);
  const authorizedSerialized = JSON.stringify(authorized.body.data.snapshot);
  assert.match(authorizedSerialized, /buyer@supplier\.example/);
  assert.match(authorizedSerialized, /NET30/);
  assert.match(authorizedSerialized, /root\.contact@example\.com/);
  assert.match(authorizedSerialized, /sales@supplier\.example/);
  assert.match(authorizedSerialized, /13900139000/);
  assert.match(authorizedSerialized, /13700137000/);
  for (const marker of hiddenDerivedMarkers) assert.match(authorizedSerialized, new RegExp(marker));
  assert.match(authorizedSerialized, /root-event-hidden-payload/);
  assert.doesNotMatch(authorizedSerialized, /entityless-zero-evidence-payload/);
  assert.deepEqual(new Set((authorized.body.data.snapshot.agentEvents as Array<Record<string, any>>)
    .find((event) => event.payload?.notes === 'root-event-hidden-payload')?.evidenceIds),
  new Set([rootEvidence.id, lineEvidence.id]));
  assert.ok([rootContactEvidence, supplierEmailEvidence, supplierPhoneEvidence]
    .every((item) => authorizedSerialized.includes(item.id)));

  const foreignStore = new SqliteManufacturingContextStore(fixture.db, 'tenant:b');
  const foreign = foreignStore.createSnapshot({
    employeeId: 'ai:foreign', rootEntityId: fixture.otherTenantEntityId, purpose: 'foreign',
    scope: { permission: 'approve', entityTypes: [], includeContactDetails: true, includeCommercialTerms: true },
  });
  const crossTenant = await fixture.request('GET', `/api/context/v1/snapshots/${encodeURIComponent(foreign.id)}`, fixture.readerToken);
  assert.equal(crossTenant.status, 404);

  const after = fixture.db.prepare(`SELECT snapshot_json,content_hash FROM twin_snapshots
    WHERE tenant_id='tenant:a' AND id=?`).get(broad.id) as { snapshot_json: string; content_hash: string };
  assert.deepEqual(after, before);
  assert.equal(after.content_hash, broad.contentHash);
});

test('Context API returns 404 for another tenant and configure-only projection health', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  const other = await fixture.request('GET', `/api/context/v1/entities/${fixture.otherTenantEntityId}`, fixture.buyerToken);
  assert.equal(other.status, 404);
  const correction = await fixture.request('POST', `/api/context/v1/entities/${fixture.otherTenantEntityId}/corrections`, fixture.buyerToken, {
    factPath: 'purchase_order.status', oldValue: 'sent', newValue: 'confirmed', reason: 'verified', evidenceReference: 'confirmation:foreign',
  });
  assert.equal(correction.status, 404);
  const buyerHealth = await fixture.request('GET', '/api/context/v1/projections/status', fixture.buyerToken);
  assert.equal(buyerHealth.status, 403);
  const managerHealth = await fixture.request('GET', '/api/context/v1/projections/status', fixture.managerToken);
  assert.equal(managerHealth.status, 200);
});

test('Context routes remain on their ruled business and internal service surfaces', () => {
  for (const [method, path] of [
    ['GET', '/api/context/v1/entities/twin:1'],
    ['GET', '/api/context/v1/projections/status'],
    ['POST', '/api/context/v1/entities/twin:1/corrections'],
    ['POST', '/api/context/v1/corrections/approval:1/decision'],
    ['POST', '/api/context/v1/projections/job:1/replay'],
  ]) {
    assert.equal(routeDomain(method!, path!), 'business');
    assert.equal(surfaceAllows('business', method!, path!), true);
    assert.equal(surfaceAllows('control', method!, path!), false);
  }
  for (const path of ['/api/internal/context/v1/snapshots', '/api/internal/context/v1/agent-events']) {
    assert.equal(routeDomain('POST', path), 'control');
    assert.equal(surfaceAllows('business', 'POST', path), false);
    assert.equal(surfaceAllows('control', 'POST', path), true);
  }
});

test('read routes use stable envelopes, stay side-effect free and never return session or credential values', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  const before = Number((fixture.db.prepare("SELECT COUNT(*) AS count FROM twin_snapshots WHERE tenant_id='tenant:a'").get() as { count: number }).count);
  let sourceWatermark: string | undefined;
  for (const path of [
    `/api/context/v1/entities/${encodeURIComponent(fixture.ownEntityId)}`,
    `/api/context/v1/entities/${encodeURIComponent(fixture.ownEntityId)}/neighborhood?depth=1&include=evidence,agent_events`,
    '/api/context/v1/objects/po%3Aa',
  ]) {
    const response = await fixture.request('GET', path, fixture.buyerToken);
    assert.equal(response.status, 200, path);
    assert.deepEqual(Object.keys(response.body).sort(), ['conflicts', 'data', 'missingFacts', 'nextCursor', 'projectionStatus', 'sourceWatermark', 'truncated']);
    assert.ok(String(response.body.sourceWatermark).length > 0);
    sourceWatermark ??= String(response.body.sourceWatermark);
    assert.equal(response.body.sourceWatermark, sourceWatermark);
    assert.equal(typeof response.body.truncated, 'boolean');
    assert.equal(response.body.nextCursor, null);
    const serialized = JSON.stringify(response.body);
    assert.doesNotMatch(serialized, /route-secret|Bearer|human:buyer|buyerToken|tenant:a/);
  }
  const after = Number((fixture.db.prepare("SELECT COUNT(*) AS count FROM twin_snapshots WHERE tenant_id='tenant:a'").get() as { count: number }).count);
  assert.equal(after, before);
});

test('correction request, decision and dead-letter replay enforce operate, approve and configure permissions', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  const requested = await fixture.request('POST', `/api/context/v1/entities/${encodeURIComponent(fixture.ownEntityId)}/corrections`, fixture.buyerToken, {
    factPath: 'purchase_order.status', oldValue: 'sent', newValue: 'confirmed', reason: 'supplier confirmed', evidenceReference: 'confirmation:1',
  });
  assert.equal(requested.status, 201);
  const approvalId = String(requested.body.data.id);
  const buyerDecision = await fixture.request('POST', `/api/context/v1/corrections/${encodeURIComponent(approvalId)}/decision`, fixture.buyerToken, { decision: 'approved' });
  assert.equal(buyerDecision.status, 403);
  const managerDecision = await fixture.request('POST', `/api/context/v1/corrections/${encodeURIComponent(approvalId)}/decision`, fixture.managerToken, { decision: 'approved' });
  assert.equal(managerDecision.status, 200);

  const queue = new SqliteTwinProjectionQueue(fixture.db, 'tenant:a');
  const dead = queue.enqueue({ sourceTable: 'unsupported', sourceKey: 'dead:1', sourceRevision: '1', eventType: 'unsupported.changed', payloadHash: 'hash', availableAt: at });
  fixture.db.prepare("UPDATE twin_projection_jobs SET status='dead_letter',attempts=8,last_error='safe failure' WHERE tenant_id='tenant:a' AND id=?").run(dead.id);
  const buyerReplay = await fixture.request('POST', `/api/context/v1/projections/${encodeURIComponent(dead.id)}/replay`, fixture.buyerToken);
  assert.equal(buyerReplay.status, 403);
  const managerReplay = await fixture.request('POST', `/api/context/v1/projections/${encodeURIComponent(dead.id)}/replay`, fixture.managerToken);
  assert.equal(managerReplay.status, 200);
  assert.equal(managerReplay.body.data.id, dead.id);
  assert.equal(queue.get(dead.id)?.status, 'queued');
});

test('internal snapshot and Agent Event writes require the gated internal context and accept tenant only there', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  const input = {
    tenantId: 'tenant:a', employeeId: 'ai:procurement', rootEntityId: fixture.ownEntityId,
    purpose: 'po_supplier_commitment', permission: 'operate', entityTypes: ['purchase_order'],
  };
  const webAttempt = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.managerToken, input);
  assert.equal(webAttempt.status, 401);
  const created = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, input);
  assert.equal(created.status, 201);
  assert.equal(created.body.data.rootEntityId, fixture.ownEntityId);
  assert.equal(created.body.data.tenantId, undefined);

  const event = await fixture.request('POST', '/api/internal/context/v1/agent-events', fixture.internalToken, {
    tenantId: 'tenant:a', employeeId: 'ai:procurement', runId: 'run:1', taskId: 'task:1', businessObjectId: 'po:a',
    entityId: fixture.ownEntityId, eventType: 'decision', inputSnapshotId: created.body.data.id,
    status: 'completed', evidenceIds: [], payload: { authorization: 'Bearer event-secret', summary: 'approved' }, createdAt: at,
  });
  assert.equal(event.status, 201);
  assert.doesNotMatch(JSON.stringify(event.body), /event-secret|Bearer|tenant:a/);
  const stored = fixture.db.prepare("SELECT payload_json FROM twin_agent_events WHERE tenant_id='tenant:a' AND id=?").get(event.body.data.id) as { payload_json: string };
  assert.doesNotMatch(stored.payload_json, /event-secret|Bearer/);

  const crossTenant = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, { ...input, tenantId: 'tenant:b' });
  assert.equal(crossTenant.status, 404);
});

test('internal snapshots enforce the current persisted employee spec and reject caller broadening', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  const base = {
    tenantId: 'tenant:a', employeeId: 'ai:procurement', rootBusinessObjectId: 'po:a', purpose: 'po_supplier_commitment',
  };

  const persisted = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, base);
  assert.equal(persisted.status, 201);
  assert.deepEqual(persisted.body.data.snapshot.scope.entityTypes, ['communication', 'purchase_order', 'supplier']);
  assert.equal(persisted.body.data.snapshot.scope.permission, 'operate');

  const reduced = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, {
    ...base, permission: 'read', entityTypes: ['purchase_order'],
  });
  assert.equal(reduced.status, 201);
  assert.deepEqual(reduced.body.data.snapshot.scope.entityTypes, ['purchase_order']);
  assert.equal(reduced.body.data.snapshot.scope.permission, 'read');

  for (const body of [
    { ...base, permission: 'approve' },
    { ...base, entityTypes: ['purchase_order', 'invoice'] },
    { ...base, entityTypes: [] },
  ]) {
    const denied = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, body);
    assert.equal(denied.status, 400, JSON.stringify(body));
  }
  const missing = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, {
    ...base, employeeId: 'ai:missing',
  });
  assert.equal(missing.status, 404);

  seedPersistedEmployee(fixture.db, 'tenant:b', 'ai:foreign-only', ['po'], [{ effect: 'allow', action: 'po.get', resource: 'erp' }]);
  const crossTenantEmployee = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, {
    ...base, employeeId: 'ai:foreign-only',
  });
  assert.equal(crossTenantEmployee.status, 404);

  fixture.db.prepare(`UPDATE workforce_employee_deployments SET version_id='stale:version'
    WHERE tenant_id='tenant:a' AND employee_id='ai:procurement'`).run();
  const stale = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, base);
  assert.equal(stale.status, 404);
});

test('internal snapshot authority uses the trusted purpose and root capability policy', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  const request = (employeeId: string, extra: Record<string, unknown> = {}) => fixture.request(
    'POST', '/api/internal/context/v1/snapshots', fixture.internalToken, {
      tenantId: 'tenant:a', employeeId, rootBusinessObjectId: 'po:a',
      purpose: 'po_supplier_commitment', ...extra,
    },
  );
  const readRule = { effect: 'allow' as const, action: 'po.get', resource: 'erp' };
  const operateRule = { effect: 'allow' as const, action: 'send', resource: 'email' };
  assert.deepEqual(mapEmployeeContextScope([
    'order', 'product', 'sla', 'po', 'email', 'material', 'sla_evaluation', 'purchase_order', 'communication',
  ]), ['communication', 'material', 'purchase_order', 'sla_evaluation']);

  seedPersistedEmployee(fixture.db, 'tenant:a', 'ai:deny-wins', ['po'], [
    readRule, operateRule, { effect: 'deny', action: 'send', resource: 'email' },
  ]);
  const denyMaximum = await request('ai:deny-wins');
  assert.equal(denyMaximum.status, 201);
  assert.equal(denyMaximum.body.data.snapshot.scope.permission, 'read');
  assert.equal((await request('ai:deny-wins', { permission: 'operate' })).status, 400);

  seedPersistedEmployee(fixture.db, 'tenant:a', 'ai:resource-mismatch', ['po'], [
    readRule, { effect: 'allow', action: 'send', resource: 'crm' },
  ]);
  const mismatchedMaximum = await request('ai:resource-mismatch');
  assert.equal(mismatchedMaximum.status, 201);
  assert.equal(mismatchedMaximum.body.data.snapshot.scope.permission, 'read');
  assert.equal((await request('ai:resource-mismatch', { permission: 'operate' })).status, 400);

  seedPersistedEmployee(fixture.db, 'tenant:a', 'ai:unrelated-write', ['po'], [
    readRule, { effect: 'allow', action: 'invoice.update', resource: 'erp' },
  ]);
  const unrelatedMaximum = await request('ai:unrelated-write');
  assert.equal(unrelatedMaximum.status, 201);
  assert.equal(unrelatedMaximum.body.data.snapshot.scope.permission, 'read');
  assert.equal((await request('ai:unrelated-write', { permission: 'operate' })).status, 400);

  seedPersistedEmployee(fixture.db, 'tenant:a', 'ai:empty-policy', ['po'], []);
  assert.equal((await request('ai:empty-policy')).status, 400);
  seedPersistedEmployee(fixture.db, 'tenant:a', 'ai:all-deny', ['po'], [
    { effect: 'deny', action: 'po.get', resource: 'erp' },
    { effect: 'deny', action: 'send', resource: 'email' },
  ]);
  assert.equal((await request('ai:all-deny')).status, 400);

  seedPersistedEmployee(fixture.db, 'tenant:a', 'ai:sales-order', ['order'], [readRule, operateRule]);
  assert.equal((await request('ai:sales-order')).status, 400);

  const allowed = await request('ai:procurement');
  assert.equal(allowed.status, 201);
  assert.equal(allowed.body.data.snapshot.scope.permission, 'operate');
  assert.deepEqual(allowed.body.data.snapshot.scope.entityTypes, ['communication', 'purchase_order', 'supplier']);
  const exactReduction = await request('ai:procurement', {
    permission: 'read', entityTypes: ['purchase_order'],
  });
  assert.equal(exactReduction.status, 201);
  assert.equal(exactReduction.body.data.snapshot.scope.permission, 'read');
  assert.deepEqual(exactReduction.body.data.snapshot.scope.entityTypes, ['purchase_order']);
  assert.equal((await request('ai:procurement', { entityTypes: ['purchase_order', 'invoice'] })).status, 400);
  assert.equal((await request('ai:procurement', { purpose: 'unknown_context_purpose' })).status, 400);

  seedPersistedEmployee(fixture.db, 'tenant:a', 'ai:all-v1-purposes', ['po'], [
    readRule, operateRule,
    { effect: 'allow', action: 'rfq.award', resource: 'erp' },
    { effect: 'allow', action: 'po.create_draft', resource: 'erp' },
    { effect: 'allow', action: 'po.update', resource: 'erp' },
    { effect: 'allow', action: 'invoice.update', resource: 'erp' },
  ]);
  for (const purpose of [
    'po_supplier_commitment', 'quote_comparison', 'create_odoo_po_draft', 'send_po',
    'record_confirmation', 'record_invoice', 'match_invoice',
  ]) {
    const supported = await request('ai:all-v1-purposes', { purpose });
    assert.equal(supported.status, 201, purpose);
    assert.equal(supported.body.data.snapshot.scope.permission, 'operate', purpose);
  }
});

test('internal snapshot resolves rootBusinessObjectId tenant-locally and rejects conflicting roots', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  const base = {
    tenantId: 'tenant:a', employeeId: 'ai:procurement', purpose: 'po_supplier_commitment',
    permission: 'operate', entityTypes: ['purchase_order'],
  };

  const created = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, {
    ...base, rootBusinessObjectId: 'po:a',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.rootEntityId, fixture.ownEntityId);

  const missing = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, {
    ...base, rootBusinessObjectId: 'po:missing',
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');

  const crossTenant = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, {
    ...base, rootBusinessObjectId: 'po:b',
  });
  assert.equal(crossTenant.status, 404);
  assert.equal(crossTenant.body.code, 'NOT_FOUND');

  const conflict = await fixture.request('POST', '/api/internal/context/v1/snapshots', fixture.internalToken, {
    ...base, rootBusinessObjectId: 'po:a', rootEntityId: fixture.otherTenantEntityId,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'CONFLICT');
});

test('internal Agent Events reject invalid createdAt and canonicalize valid offset instants', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  const before = Number((fixture.db.prepare("SELECT COUNT(*) AS count FROM twin_agent_events WHERE tenant_id='tenant:a'").get() as { count: number }).count);
  const base = {
    tenantId: 'tenant:a', employeeId: 'ai:procurement', taskId: 'task:timestamp',
    businessObjectId: 'po:a', entityId: fixture.ownEntityId, eventType: 'decision',
    status: 'completed', evidenceIds: [], payload: { summary: 'timestamp boundary' },
  };

  const invalid = await fixture.request('POST', '/api/internal/context/v1/agent-events', fixture.internalToken, {
    ...base, runId: 'run:invalid-timestamp', createdAt: 'not-an-iso-instant',
  });
  assert.equal(invalid.status, 400);
  assert.equal(Number((fixture.db.prepare("SELECT COUNT(*) AS count FROM twin_agent_events WHERE tenant_id='tenant:a'").get() as { count: number }).count), before);

  const valid = await fixture.request('POST', '/api/internal/context/v1/agent-events', fixture.internalToken, {
    ...base, runId: 'run:offset-timestamp', createdAt: '2026-08-29T16:00:00+08:00',
  });
  assert.equal(valid.status, 201);
  assert.equal(valid.body.data.createdAt, at);
  const stored = fixture.db.prepare("SELECT created_at FROM twin_agent_events WHERE tenant_id='tenant:a' AND id=?")
    .get(valid.body.data.id) as { created_at: string };
  assert.equal(stored.created_at, at);
});

test('projection status is tenant-bound and reports deterministic health/count metadata', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  new SqliteTwinProjectionQueue(fixture.db, 'tenant:b').enqueue({
    sourceTable: 'foreign', sourceKey: 'foreign:1', sourceRevision: '1', eventType: 'foreign.changed', payloadHash: 'foreign-hash', availableAt: at,
  });
  const status = await fixture.request('GET', '/api/context/v1/projections/status', fixture.managerToken);
  assert.equal(status.status, 200);
  assert.equal(status.body.data.queue.queued, 0);
  assert.equal(status.body.data.counts.entities, 1);
  assert.deepEqual(status.body.data.worker, { state: 'ready', lastHeartbeatAt: status.body.data.worker.lastHeartbeatAt });
  assert.deepEqual(fixture.workerStatusTenants, ['tenant:a']);
  assert.doesNotMatch(JSON.stringify(status.body), /tenant:b|foreign:1|foreign-hash/);
});
