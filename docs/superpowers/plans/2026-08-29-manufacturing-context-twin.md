# Manufacturing Context / Twin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, evidence-backed Manufacturing Context/Twin to the existing procurement execution system and expose it in the PO workbench without replacing the authoritative SQLite procurement facts.

**Architecture:** Existing procurement transactions remain authoritative and enqueue idempotent projection jobs in the same SQLite transaction. A leased projector materializes tenant-scoped entities, relations, immutable evidence, agent events, and immutable snapshots; API and Web consumers only read those projections and always surface missing or stale facts. Temporal and the Agent Runtime consume saved snapshots, while every external side effect continues to pass through Action Gateway and Connector Runtime.

**Tech Stack:** Node.js 22.18+, TypeScript, `node:sqlite`, Node test runner through `tsx --test`, Next.js/React, existing Readywork Business API, Temporal runtime, SQLite WAL.

**Spec:** `docs/superpowers/specs/2026-08-29-manufacturing-context-twin-design.md`

## Global Constraints

- Keep `Business API + Control API + Temporal + DeepSeek Harness + Action Gateway + Connector Runtime` in place.
- `procurement_documents`, `procurement_lines`, stage events, Outbox, Odoo, email and warehouse/GRN receipts remain authoritative; Twin is a projection and context index.
- Use SQLite for V1; do not add PostgreSQL, graph, vector, or object-storage dependencies in this plan.
- Every Twin table and every query is tenant-scoped; cross-tenant object lookup returns 404 and does not disclose existence.
- Source priority is fixed at external receipt 400, approved human correction 300, deterministic parser/rule 200, model-derived 100.
- Projection failure never rolls back or rewrites a successful procurement fact.
- Evidence, agent events, and snapshots are immutable append-only records.
- A snapshot is capped at 512 KiB, depth 2, 500 entities and 2,000 evidence records and must report truncation explicitly.
- Credentials, authentication headers, cookies, tokens, complete attachment bytes and unrestricted raw email bodies never enter Twin or snapshots.
- Do not manufacture Odoo, supplier-confirmation, production, shipment, receipt or GRN success.
- The real acceptance root is `po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a` in `data/readywork.sqlite`.
- New test files that use the shared `at` fixture define `const at = '2026-08-29T00:00:00.000Z';` at module scope.
- Production code follows red-green-refactor: every behavior change begins with a failing test that fails for the expected reason.
- The workspace currently has no `.git`; each commit step is conditional on `git rev-parse --is-inside-work-tree`. If it returns false, record the changed-file checkpoint and continue without claiming a commit.

---

### Task 1: Manufacturing Context contracts and deterministic primitives

**Files:**
- Create: `packages/core/src/manufacturing-context.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/manufacturing-context.test.ts`

**Interfaces:**
- Consumes: existing `EntityId` and ISO date string conventions from `@readywork/core`.
- Produces: `TwinEntity`, `TwinRelation`, `TwinEvidence`, `TwinAgentEvent`, `TwinSnapshot`, `TwinProjectionJob`, `TwinSourceSemantics`, `TwinAccessScope`, `ManufacturingContextStore`, `twinSourcePriority()` and `assertTwinConfidence()`.

- [ ] **Step 1: Write the failing source-priority and confidence tests**

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertTwinConfidence, twinSourcePriority } from '../src/manufacturing-context.js';

test('Twin source priority cannot let a model override an external receipt', () => {
  assert.equal(twinSourcePriority('verified_external'), 400);
  assert.equal(twinSourcePriority('approved_human'), 300);
  assert.equal(twinSourcePriority('deterministic'), 200);
  assert.equal(twinSourcePriority('model_derived'), 100);
  assert.equal(twinSourcePriority('observed_backfill'), 200);
});

test('Twin confidence is finite and between zero and one', () => {
  assert.equal(assertTwinConfidence(0.94), 0.94);
  assert.throws(() => assertTwinConfidence(1.1), /0 到 1/);
  assert.throws(() => assertTwinConfidence(Number.NaN), /0 到 1/);
});
```

- [ ] **Step 2: Run the test and verify the missing module failure**

Run: `pnpm exec tsx --test packages/core/test/manufacturing-context.test.ts`  
Expected: FAIL because `packages/core/src/manufacturing-context.ts` does not exist.

- [ ] **Step 3: Add the exact source semantics and shared contracts**

```ts
export type TwinSourceSemantics =
  | 'verified_external'
  | 'approved_human'
  | 'deterministic'
  | 'model_derived'
  | 'observed_backfill';

export type TwinProjectionStatus = 'queued' | 'processing' | 'retry_wait' | 'succeeded' | 'dead_letter';
export type TwinEntityType = 'supplier' | 'contact' | 'material' | 'requisition' | 'rfq' | 'quote' | 'award'
  | 'purchase_order' | 'po_line' | 'communication' | 'shipment' | 'receipt' | 'invoice' | 'sla_evaluation';

export interface TwinAccessScope {
  permission: 'read' | 'operate' | 'approve' | 'configure' | 'admin';
  entityTypes: readonly TwinEntityType[];
  includeContactDetails: boolean;
  includeCommercialTerms: boolean;
}

export function twinSourcePriority(source: TwinSourceSemantics): 100 | 200 | 300 | 400 {
  if (source === 'verified_external') return 400;
  if (source === 'approved_human') return 300;
  if (source === 'model_derived') return 100;
  return 200;
}

export function assertTwinConfidence(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Twin confidence 必须是 0 到 1 的有限数值');
  return value;
}
```

Add these exact shared shapes in the same file:

```ts
export interface TwinEntity {
  tenantId: string; id: string; entityType: TwinEntityType; canonicalKey: string; label: string;
  lifecycleState: string; attributes: Record<string, unknown>; state: Record<string, unknown>;
  currentRevision: number; sourceWatermark: string; effectiveAt: string; observedAt: string;
  createdAt: string; updatedAt: string;
}
export interface TwinRelation {
  tenantId: string; id: string; relationType: string; fromEntityId: string; toEntityId: string;
  status: 'active' | 'superseded' | 'disputed'; sourceEvidenceId: string;
  validFrom: string; validTo?: string; createdAt: string; updatedAt: string;
}
export interface TwinEvidence {
  tenantId: string; id: string; entityId?: string; relationId?: string;
  sourceSemantics: TwinSourceSemantics; sourceKind: string; sourceId: string; sourceVersion: string;
  sourceHash: string; factPath: string; value: unknown; priority: 100 | 200 | 300 | 400;
  confidence: number; effectiveAt: string; observedAt: string; actorId: string;
  rawReference: Record<string, unknown>; supersedesEvidenceId?: string; createdAt: string;
}
export type TwinAgentEventType = 'context_read' | 'extraction' | 'decision' | 'recommendation'
  | 'action_requested' | 'action_result' | 'human_feedback' | 'business_outcome';
export interface TwinAgentEvent {
  tenantId: string; id: string; employeeId: string; temporalWorkflowId?: string; runId: string;
  taskId: string; businessObjectId?: string; entityId?: string; eventType: TwinAgentEventType;
  inputSnapshotId?: string; model?: string; reasoningProfile?: string; promptHash?: string;
  responseHash?: string; actionName?: string; status: string; confidence?: number;
  evidenceIds: string[]; payload: Record<string, unknown>; createdAt: string;
}
export interface TwinSnapshot {
  tenantId: string; id: string; employeeId: string; rootEntityId: string; purpose: string;
  schemaVersion: 'manufacturing-context/v1'; sourceWatermark: string; permissionFingerprint: string;
  snapshot: Record<string, any>; contentHash: string; createdAt: string;
}
export interface TwinProjectionJob {
  tenantId: string; id: string; sourceTable: string; sourceKey: string; sourceRevision: string;
  eventType: string; payloadHash: string; status: TwinProjectionStatus; attempts: number; maxAttempts: 8;
  availableAt: string; leaseOwner?: string; leaseToken?: string; leaseExpiresAt?: string;
  projectedWatermark?: string; lastError?: string; createdAt: string; updatedAt: string; completedAt?: string;
}
export interface TwinFactConflict { factPath: string; selectedEvidenceId: string; conflictingEvidenceIds: string[]; }
export interface TwinResolvedFact { factPath: string; value: unknown; evidence: TwinEvidence; conflicts: TwinEvidence[]; }
export interface TwinNeighborhood {
  root: TwinEntity; entities: TwinEntity[]; relations: TwinRelation[]; evidence: TwinEvidence[];
  agentEvents: TwinAgentEvent[]; sourceWatermark: string; conflicts: TwinFactConflict[];
  missingFacts: string[]; truncated: boolean; nextCursor: string | null;
}
export type UpsertTwinEntityInput = Omit<TwinEntity, 'tenantId' | 'id' | 'currentRevision' | 'createdAt' | 'updatedAt'>;
export type AppendTwinEvidenceInput = Omit<TwinEvidence, 'tenantId' | 'id' | 'priority' | 'createdAt'>;
export type UpsertTwinRelationInput = Omit<TwinRelation, 'tenantId' | 'id' | 'createdAt' | 'updatedAt'>;
export interface CreateTwinSnapshotInput { employeeId: string; rootEntityId: string; purpose: string; scope: TwinAccessScope; }
export type AppendTwinAgentEventInput = Omit<TwinAgentEvent, 'tenantId' | 'id'>;

export class TwinProjectionPayloadConflictError extends Error {
  readonly code = 'TWIN_PROJECTION_PAYLOAD_CONFLICT' as const;
  constructor(readonly sourceKey: string) { super('同一 Twin 来源修订存在不同载荷'); }
}

export interface ManufacturingContextStore {
  upsertEntity(input: UpsertTwinEntityInput): TwinEntity;
  getEntity(entityId: string): TwinEntity | undefined;
  getByBusinessObjectId(businessObjectId: string): TwinEntity | undefined;
  upsertRelation(input: UpsertTwinRelationInput): TwinRelation;
  appendEvidence(input: AppendTwinEvidenceInput): TwinEvidence;
  listEvidence(entityId: string): TwinEvidence[];
  resolveFact(entityId: string, factPath: string): TwinResolvedFact | undefined;
  getNeighborhood(rootEntityId: string, options: { depth: 1 | 2; entityLimit: number; evidenceLimit: number }): TwinNeighborhood;
  createSnapshot(input: CreateTwinSnapshotInput): TwinSnapshot;
  getSnapshot(snapshotId: string): TwinSnapshot | undefined;
  appendAgentEvent(event: AppendTwinAgentEventInput): TwinAgentEvent;
}
```

- [ ] **Step 4: Export the contracts and verify the focused test**

Add `export * from './manufacturing-context.js';` to `packages/core/src/index.ts`.

Run: `pnpm exec tsx --test packages/core/test/manufacturing-context.test.ts`  
Expected: PASS with 2 tests.

- [ ] **Step 5: Verify the repository typecheck**

Run: `pnpm typecheck`  
Expected: PASS without TypeScript diagnostics.

- [ ] **Step 6: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add packages/core/src/manufacturing-context.ts packages/core/src/index.ts packages/core/test/manufacturing-context.test.ts && git commit -m "feat: define manufacturing context contracts" || true`

### Task 2: SQLite schema and migration 35

**Files:**
- Create: `packages/persistence/src/manufacturing-context-schema.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `packages/persistence/test/procurement-persistence.test.ts`

**Interfaces:**
- Consumes: `openPersistence()`, `runMigrations()` and migration version 34.
- Produces: `MANUFACTURING_CONTEXT_SCHEMA`, `ensureManufacturingContextSchema(db)` and migration 35 named `manufacturing-context-twin`.

- [ ] **Step 1: Write a failing migration test**

```ts
test('migration 35 installs six tenant-scoped Manufacturing Context tables', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:context' });
    const tables = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'twin_%' ORDER BY name`)
      .all().map((row) => String((row as { name: string }).name));
    assert.deepEqual(tables, [
      'twin_agent_events', 'twin_entities', 'twin_evidence',
      'twin_projection_jobs', 'twin_relations', 'twin_snapshots',
    ]);
    const migration = store.db.prepare('SELECT name FROM schema_migrations WHERE version=35').get() as { name: string };
    assert.equal(migration.name, 'manufacturing-context-twin');
    store.close();
  } finally { temp.cleanup(); }
});
```

- [ ] **Step 2: Run the focused persistence test and confirm the six-table assertion fails**

Run: `pnpm exec tsx --test packages/persistence/test/procurement-persistence.test.ts --test-name-pattern "migration 35"`  
Expected: FAIL because no `twin_*` tables exist.

- [ ] **Step 3: Define the six tables and indexes**

Create `MANUFACTURING_CONTEXT_SCHEMA` with the exact tables from Section 6 of the spec. Use these mandatory constraints:

```sql
UNIQUE (tenant_id, entity_type, canonical_key)
UNIQUE (tenant_id, relation_type, from_entity_id, to_entity_id, source_evidence_id)
UNIQUE (tenant_id, source_kind, source_id, source_version, fact_path, source_hash)
UNIQUE (tenant_id, source_table, source_key, source_revision, event_type)
CHECK (priority IN (100,200,300,400))
CHECK (confidence >= 0 AND confidence <= 1)
CHECK (status IN ('queued','processing','retry_wait','succeeded','dead_letter'))
```

Add indexes for entity lookup, both relation directions, evidence-by-entity, agent-event-by-entity/time, snapshot-by-root/time, and projection claim order.

- [ ] **Step 4: Register migration 35 in both initialization paths**

Import `MANUFACTURING_CONTEXT_SCHEMA` and `ensureManufacturingContextSchema` in `packages/persistence/src/index.ts`. Append:

```ts
{ version: 35, name: 'manufacturing-context-twin', sql: MANUFACTURING_CONTEXT_SCHEMA },
```

Call `ensureManufacturingContextSchema(db)` from both `initializeControlPlaneSchema()` and the post-migration ensure section in `runMigrations()`.

- [ ] **Step 5: Verify migration from an empty database and a copy of the real v34 database**

Run: `pnpm exec tsx --test packages/persistence/test/procurement-persistence.test.ts --test-name-pattern "migration 35"`  
Expected: PASS.

Run:

```bash
context_migration_dir=$(mktemp -d)
cp data/readywork.sqlite "$context_migration_dir/readywork.sqlite"
node --import tsx -e "import {openPersistence} from '@readywork/persistence'; const s=openPersistence(process.argv[1],{tenantId:'t:acme'}); console.log(s.db.prepare('select name from schema_migrations where version=35').get()); s.close()" "$context_migration_dir/readywork.sqlite"
```

Expected: prints `{ name: 'manufacturing-context-twin' }`; the original `data/readywork.sqlite` remains untouched.

- [ ] **Step 6: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add packages/persistence/src/manufacturing-context-schema.ts packages/persistence/src/index.ts packages/persistence/test/procurement-persistence.test.ts && git commit -m "feat: add manufacturing context schema" || true`

### Task 3: Tenant-scoped SQLite Context Store and fact resolution

**Files:**
- Create: `packages/context/src/sqlite-manufacturing-context-store.ts`
- Create: `packages/context/src/context-identity.ts`
- Modify: `packages/context/src/index.ts`
- Modify: `packages/context/package.json`
- Create: `packages/context/test/sqlite-manufacturing-context-store.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 contracts and Task 2 tables.
- Produces: `SqliteManufacturingContextStore`, `stableTwinEntityId()`, `contextSourceWatermark()` and `resolveTwinFact()`.

- [ ] **Step 1: Write failing store, tenant-isolation and precedence tests**

```ts
test('SQLite Twin keeps evidence immutable and resolves external facts above model facts', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const store = new SqliteManufacturingContextStore(db, 'tenant:a');
  const entity = store.upsertEntity({ entityType: 'purchase_order', canonicalKey: 'readywork:po:1', label: 'PO-1', lifecycleState: 'sent', attributes: {}, state: {}, sourceWatermark: 'w1', effectiveAt: at, observedAt: at });
  store.appendEvidence({ entityId: entity.id, sourceSemantics: 'model_derived', sourceKind: 'llm', sourceId: 'run:1', sourceVersion: '1', sourceHash: 'h-model', factPath: 'purchase_order.status', value: 'confirmed', confidence: 0.99, effectiveAt: at, observedAt: at, actorId: 'ai:po', rawReference: {} });
  store.appendEvidence({ entityId: entity.id, sourceSemantics: 'verified_external', sourceKind: 'odoo', sourceId: 'purchase.order:1', sourceVersion: '7', sourceHash: 'h-odoo', factPath: 'purchase_order.status', value: 'sent', confidence: 1, effectiveAt: at, observedAt: at, actorId: 'source:odoo', rawReference: { table: 'procurement_documents', id: 'po:1' } });
  assert.equal(store.resolveFact(entity.id, 'purchase_order.status')?.value, 'sent');
  assert.equal(store.listEvidence(entity.id).length, 2);
  assert.equal(new SqliteManufacturingContextStore(db, 'tenant:b').getEntity(entity.id), undefined);
});
```

- [ ] **Step 2: Run the test and confirm the missing store failure**

Run: `pnpm exec tsx --test packages/context/test/sqlite-manufacturing-context-store.test.ts`  
Expected: FAIL because the SQLite store module does not exist.

- [ ] **Step 3: Implement deterministic identity and watermarks**

```ts
export function stableTwinEntityId(tenantId: string, entityType: string, canonicalKey: string): string {
  const digest = createHash('sha256').update(`${tenantId}\0${entityType}\0${canonicalKey}`).digest('hex').slice(0, 32);
  return `twin:${entityType}:${digest}`;
}

export function contextSourceWatermark(sources: readonly { sourceTable: string; sourceKey: string; sourceRevision: string; sourceHash: string }[]): string {
  const normalized = [...sources].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
```

- [ ] **Step 4: Implement store reads and writes with tenant-bound SQL**

`SqliteManufacturingContextStore` receives `(db: DatabaseSync, tenantId: string)` and never accepts a tenant override per method. Implement `upsertEntity`, `getEntity`, `getByBusinessObjectId`, `upsertRelation`, `appendEvidence`, `listEvidence`, `resolveFact`, `getNeighborhood`, `createSnapshot`, `getSnapshot`, and `appendAgentEvent` using prepared statements whose first predicate is `tenant_id=?`. Before `upsertRelation`, load both endpoints through the bound tenant and reject the write unless both exist; never probe another tenant to produce a more specific error.

`resolveFact()` sorts immutable evidence by:

```ts
[priority DESC, sourceVersion DESC, effectiveAt DESC, observedAt DESC, id ASC]
```

If the ID exists in another tenant but not the bound tenant, return `undefined` from read methods. The test uses a service-level assertion to convert this to 404; do not throw a cross-tenant-specific error that leaks existence.

- [ ] **Step 5: Export the store and include Context tests in the root suite**

Add these dependencies to `packages/context/package.json`:

```json
{
  "@readywork/core": "workspace:*",
  "@readywork/persistence": "workspace:*"
}
```

Export the new modules from `packages/context/src/index.ts`. Add `packages/context/test/*.test.ts` to the root `test` script before `packages/control-tower` tests.

- [ ] **Step 6: Verify store tests and typecheck**

Run: `pnpm exec tsx --test packages/context/test/sqlite-manufacturing-context-store.test.ts`  
Expected: PASS.

Run: `pnpm typecheck`  
Expected: PASS.

- [ ] **Step 7: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add packages/context packages/core package.json pnpm-lock.yaml && git commit -m "feat: persist tenant scoped manufacturing context" || true`

### Task 4: Durable projection queue, retry, dead letter and replay

**Files:**
- Create: `packages/context/src/projection-queue.ts`
- Modify: `packages/context/src/index.ts`
- Create: `packages/context/test/projection-queue.test.ts`

**Interfaces:**
- Consumes: `twin_projection_jobs` from Task 2 and `TwinProjectionJob` from Task 1.
- Produces: `SqliteTwinProjectionQueue.enqueue()`, `.get()`, `.claim()`, `.succeed()`, `.fail()`, `.replayDeadLetter()`, `.status()` and `projectionRetryAt()`.

- [ ] **Step 1: Write failing lease, retry and dead-letter tests**

```ts
test('projection queue reclaims expired leases and dead-letters the eighth failure', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const job = queue.enqueue({ sourceTable: 'procurement_documents', sourceKey: 'purchase_order:po:1', sourceRevision: '1', eventType: 'purchase_order.changed', payloadHash: 'hash:1', availableAt: at });
  let claimed = queue.claim({ workerId: 'worker:1', claimedAt: at, leaseDurationMs: 1_000, limit: 1 })[0]!;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const failedAt = new Date(Date.parse(at) + attempt * 5_000).toISOString();
    const failed = queue.fail({ id: claimed.id, leaseToken: claimed.leaseToken!, failedAt, error: 'token=must-not-leak' });
    if (attempt === 8) {
      assert.equal(failed.status, 'dead_letter');
      assert.doesNotMatch(failed.lastError ?? '', /must-not-leak/);
      break;
    }
    claimed = queue.claim({ workerId: 'worker:1', claimedAt: failed.availableAt!, leaseDurationMs: 1_000, limit: 1 })[0]!;
  }
  assert.equal(queue.status().deadLetter, 1);
});
```

- [ ] **Step 2: Run the queue test and confirm the missing queue failure**

Run: `pnpm exec tsx --test packages/context/test/projection-queue.test.ts`  
Expected: FAIL because `SqliteTwinProjectionQueue` is not defined.

- [ ] **Step 3: Implement the exact retry schedule and lease rules**

```ts
const RETRY_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 14_400_000] as const;

export function projectionRetryAt(failedAt: string, attempts: number): string | undefined {
  if (attempts >= 8) return undefined;
  return new Date(Date.parse(failedAt) + RETRY_MS[attempts - 1]!).toISOString();
}
```

Use `BEGIN IMMEDIATE` for `claim`, `fail`, `succeed` and replay. Reclaim only `processing` rows whose `lease_expires_at<=claimedAt`. Every completion/failure update includes `tenant_id`, `id`, current status and matching lease token in its `WHERE` clause.

- [ ] **Step 4: Enforce enqueue payload integrity**

On the unique source key, return the existing job only when `payload_hash` matches. When it differs, insert a `control_security_events` record with `event_type='twin_projection_payload_conflict'` and throw `TwinProjectionPayloadConflictError`; the security payload contains IDs and hashes, never the raw source payload.

- [ ] **Step 5: Implement audited replay**

`replayDeadLetter({ id, actorId, replayedAt })` appends a `runtime_activities` record with action `twin.projection_replayed`, retains attempts and last error, clears lease fields, and moves the job to `queued`.

- [ ] **Step 6: Verify the queue suite**

Run: `pnpm exec tsx --test packages/context/test/projection-queue.test.ts`  
Expected: PASS for claim, expired lease, payload conflict, retry schedule, dead letter and replay tests.

- [ ] **Step 7: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add packages/context/src/projection-queue.ts packages/context/src/index.ts packages/context/test/projection-queue.test.ts && git commit -m "feat: add durable twin projection queue" || true`

### Task 5: PO graph projector and honest backfill

**Files:**
- Create: `packages/context/src/procurement-po-projector.ts`
- Create: `packages/context/src/procurement-po-missing-facts.ts`
- Modify: `packages/context/src/index.ts`
- Create: `packages/context/test/procurement-po-projector.test.ts`

**Interfaces:**
- Consumes: `SqliteManufacturingContextStore`, `SqliteTwinProjectionQueue` and existing procurement tables.
- Produces: `ProcurementPoProjector.project(job)`, `enqueuePurchaseOrderBackfill(db, tenantId, at)` and `purchaseOrderMissingFacts(db, tenantId, poId)`.

- [ ] **Step 1: Write a failing PO graph test with real V1 semantics**

```ts
function seedPoSourcingChain(store: PersistenceStore, input: { poId: string; supplierId: string; itemId: string; status: PurchaseOrder['status'] }): void {
  const common = { tenantId: store.tenantId, sourceSystem: 'readywork', createdAt: at, updatedAt: at };
  const supplier: Supplier = { ...common, id: input.supplierId, externalId: 'SUP-1', status: 'active', name: '上海卓越阀门', currency: 'CNY', contacts: [] };
  const rfq: RequestForQuotation = { ...common, id: 'rfq:1', externalId: 'RFQ-1', status: 'awarded', buyerId: 'human:buyer', supplierIds: [supplier.id], currency: 'CNY', quoteDueAt: at };
  const rfqLine: RequestForQuotationLine = { id: 'rfq-line:1', rfqId: rfq.id, lineNumber: '10', itemId: input.itemId, uom: '件', requestedQty: 200 };
  const quote: SupplierQuote = { ...common, id: 'quote:1', externalId: 'QUOTE-1', status: 'received', rfqId: rfq.id, supplierId: supplier.id, currency: 'CNY', receivedAt: at };
  const quoteLine: SupplierQuoteLine = { id: 'quote-line:1', quoteId: quote.id, rfqLineId: rfqLine.id, lineNumber: '10', itemId: input.itemId, uom: '件', quotedQty: 200, unitPrice: 127, currency: 'CNY' };
  const award: Award = { ...common, id: 'award:1', externalId: 'AWARD-1', status: 'approved', rfqId: rfq.id, approvedBy: 'human:manager', approvedAt: at };
  const awardLine: AwardLine = { id: 'award-line:1', awardId: award.id, rfqLineId: rfqLine.id, quoteLineId: quoteLine.id, supplierId: supplier.id, lineNumber: '10', itemId: input.itemId, uom: '件', awardedQty: 200, unitPrice: 127, currency: 'CNY', selectionReason: '批准报价' };
  const po: PurchaseOrder = { ...common, id: input.poId, externalId: input.poId, status: input.status, awardId: award.id, supplierId: supplier.id, currency: 'CNY', orderedAt: at };
  const poLine: PurchaseOrderLine = { id: 'po-line:1', poId: po.id, awardLineId: awardLine.id, quoteLineId: quoteLine.id, rfqLineId: rfqLine.id, lineNumber: '10', itemId: input.itemId, description: '气动阀 PV-30，按制造规格验收', uom: '件', orderedQty: 200, unitPrice: 127, currency: 'CNY' };
  store.procurement.saveDocument('supplier', supplier);
  store.procurement.saveDocument('rfq', rfq); store.procurement.saveLine('rfq_line', rfq.id, rfqLine);
  store.procurement.saveDocument('quote', quote); store.procurement.saveLine('quote_line', quote.id, quoteLine);
  store.procurement.saveDocument('award', award); store.procurement.saveLine('award_line', award.id, awardLine);
  store.procurement.saveDocument('purchase_order', po); store.procurement.saveLine('purchase_order_line', po.id, poLine);
}

test('PO projector links the sourcing chain and does not invent unobserved fulfilment facts', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  seedPoSourcingChain(store, { poId: 'po:1', supplierId: 'supplier:1', itemId: 'PV-30', status: 'sent' });
  const queue = new SqliteTwinProjectionQueue(store.db, 'tenant:a');
  const context = new SqliteManufacturingContextStore(store.db, 'tenant:a');
  enqueuePurchaseOrderBackfill(store.db, 'tenant:a', at);
  const job = queue.claim({ workerId: 'projector:1', claimedAt: at, leaseDurationMs: 30_000, limit: 1 })[0]!;
  new ProcurementPoProjector(store.db, 'tenant:a', context).project(job);
  queue.succeed({ id: job.id, leaseToken: job.leaseToken!, completedAt: at, projectedWatermark: 'w1' });
  const root = context.getByBusinessObjectId('po:1')!;
  const graph = context.getNeighborhood(root.id, { depth: 2, entityLimit: 500, evidenceLimit: 2_000 });
  assert.ok(graph.entities.some((entity) => entity.entityType === 'supplier'));
  assert.ok(graph.entities.some((entity) => entity.entityType === 'award'));
  assert.ok(graph.entities.some((entity) => entity.entityType === 'quote'));
  assert.deepEqual(root.state.missingFacts, ['odoo_purchase_order','supplier_confirmation','production_progress','shipment','grn']);
  assert.equal(graph.entities.some((entity) => entity.entityType === 'receipt'), false);
});
```

- [ ] **Step 2: Run the test and confirm the missing projector failure**

Run: `pnpm exec tsx --test packages/context/test/procurement-po-projector.test.ts`  
Expected: FAIL because the PO projector does not exist.

- [ ] **Step 3: Implement deterministic graph projection**

Project the root PO, PO lines, supplier, material IDs, Award, Award lines, selected Quote/Quote lines, RFQ/RFQ lines, associated purchase-order communications, stage events, Outbox rows, production progress, shipments, transport events, receipts, invoices, SLA evaluation, approvals and exceptions.

Use these relation names exactly:

```ts
'ordered_from' | 'contains_line' | 'for_material' | 'created_from_award' |
'selected_quote' | 'sourced_from_rfq' | 'about' | 'fulfilled_by' |
'has_transport_event' | 'received_as' | 'invoiced_by'
```

Each projected value appends evidence with a raw reference containing only table, primary key, source version and content hash. `observed_status_backfill` becomes `observed_backfill`; exact Outbox connector completion becomes `verified_external`.

- [ ] **Step 4: Implement missing-fact computation from authoritative rows**

```ts
export const PO_MISSING_FACT_ORDER = [
  'odoo_purchase_order', 'supplier_confirmation', 'production_progress', 'shipment', 'grn',
] as const;
```

- `odoo_purchase_order` is missing when a Readywork PO has no validated `odooReference`.
- `supplier_confirmation` is missing when no confirmation belongs to this PO.
- `production_progress` is missing when no production-progress document belongs to this PO.
- `shipment` is missing when no shipment belongs to this PO.
- `grn` is missing when no receipt belongs to this PO; a carrier `delivered` event is not a GRN.

- [ ] **Step 5: Implement idempotent backfill**

`enqueuePurchaseOrderBackfill()` reads all purchase orders for the tenant and enqueues one `purchase_order.backfill` job per `(id, version, json hash)`. It never writes stage events or procurement documents.

- [ ] **Step 6: Verify idempotency and missing facts**

Run: `pnpm exec tsx --test packages/context/test/procurement-po-projector.test.ts`  
Expected: PASS, including a second projection that leaves entity, relation and evidence counts unchanged.

- [ ] **Step 7: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add packages/context/src/procurement-po-projector.ts packages/context/src/procurement-po-missing-facts.ts packages/context/src/index.ts packages/context/test/procurement-po-projector.test.ts && git commit -m "feat: project procurement PO context" || true`

### Task 6: Atomic projection enqueue on PO business writes

**Files:**
- Create: `packages/persistence/src/twin-projection-enqueue.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `packages/persistence/test/procurement-persistence.test.ts`

**Interfaces:**
- Consumes: Task 4 job uniqueness and existing repository transactions.
- Produces: `enqueueTwinProjectionInCurrentTransaction(db, input)` and atomic jobs for PO creation, updates, stage events, Outbox changes, Odoo mapping, communication, delivery and SLA changes.

- [ ] **Step 1: Write failing atomicity tests for PO updates, Outbox completion and receipt**

```ts
test('PO writes enqueue Twin projection jobs in the same transaction', () => {
  const temp = tmpDb();
  try {
    const store = openPersistence(temp.dbPath, { tenantId: 'tenant:atomic' });
    const poId = 'po:atomic';
    const initial = purchaseOrder('tenant:atomic', { id: poId, externalId: 'PO-ATOMIC', status: 'draft' });
    store.procurement.saveDocument('purchase_order', initial);
    const job = store.db.prepare(`SELECT source_key,status FROM twin_projection_jobs WHERE tenant_id=? AND source_key=?`)
      .get('tenant:atomic', `purchase_order:${poId}`) as { source_key: string; status: string };
    assert.equal(job.status, 'queued');
    store.db.prepare(`INSERT INTO twin_projection_jobs
      (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,available_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'purchase_order.changed','conflicting-hash','queued',0,8,?,?,?)`)
      .run('tenant:atomic', 'job:conflict-v2', 'procurement_documents', `purchase_order:${poId}`, '2', at, at, at);
    assert.throws(
      () => store.procurement.saveDocument('purchase_order', { ...initial, status: 'sent', updatedAt: '2026-08-21T01:00:00.000Z' }, 1),
      /不同载荷/,
    );
    const persisted = store.procurement.getDocument<PurchaseOrder>('purchase_order', poId)!;
    assert.equal(persisted.version, 1);
    assert.equal(persisted.document.status, 'draft');
  } finally { temp.cleanup(); }
});

function queuedTwinSources(db: DatabaseSync, tenantId: string): string[] {
  return db.prepare(`SELECT source_table || ':' || source_key FROM twin_projection_jobs
    WHERE tenant_id=? AND status='queued' ORDER BY source_table,source_key`)
    .all(tenantId).map((row) => String(Object.values(row as Record<string, unknown>)[0]));
}
```

In the existing test `采购执行主链: 确认差异审批、累计发运收货、三单匹配与阻塞式 outbox`, add these assertions immediately after `completeOutboxMessage()` and `record_receipt` respectively:

```ts
assert.ok(queuedTwinSources(store.db, tenantId).some((key) => key.startsWith('procurement_outbox:')));
assert.ok(queuedTwinSources(store.db, tenantId).some((key) => key === `procurement_documents:purchase_order:${po.id}`));
assert.ok(queuedTwinSources(store.db, tenantId).some((key) => key.startsWith('procurement_po_stage_events:')));

assert.ok(queuedTwinSources(store.db, tenantId).some((key) => key.startsWith('procurement_documents:receipt:')));
assert.ok(queuedTwinSources(store.db, tenantId).some((key) => key.startsWith('procurement_lines:receipt_line:')));
assert.ok(queuedTwinSources(store.db, tenantId).some((key) => key.startsWith('procurement_po_line_quantity_projections:')));
```

- [ ] **Step 2: Run the focused tests and confirm no jobs are created**

Run: `pnpm exec tsx --test packages/persistence/test/procurement-persistence.test.ts --test-name-pattern "Twin projection jobs"`  
Expected: FAIL because business writes do not enqueue Twin jobs.

- [ ] **Step 3: Implement the transaction-local enqueue helper**

```ts
export function enqueueTwinProjectionInCurrentTransaction(db: DatabaseSync, input: {
  tenantId: string; sourceTable: string; sourceKey: string; sourceRevision: string;
  eventType: string; payloadHash: string; availableAt: string;
}): void {
  db.prepare(`INSERT INTO twin_projection_jobs
    (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,available_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'queued',0,8,?,?,?)
    ON CONFLICT(tenant_id,source_table,source_key,source_revision,event_type) DO NOTHING`)
    .run(input.tenantId, stableProjectionJobId(input), input.sourceTable, input.sourceKey,
      input.sourceRevision, input.eventType, input.payloadHash, input.availableAt, input.availableAt, input.availableAt);
}
```

Before treating a conflict as a replay, query and compare `payload_hash`; mismatches raise the Task 4 integrity error.

- [ ] **Step 4: Wire every common PO mutation inside its existing transaction**

Call the helper from:

- `awardRfqAndCreateDraftPurchaseOrders()` after each PO and its lines are inserted;
- `saveDocument()` / `saveLine()` for PO-context kinds, wrapping standalone saves in an immediate transaction only when `db.isTransaction` is false;
- `insertExecutionDocument()`, `insertExecutionLine()`, `updateExecutionDocument()` and `recordPoStageEvent()`;
- `completeOutboxMessage()` and `failOutboxMessage()` after persisted status changes;
- supplier sync, inbound communication persistence and Odoo sync paths;
- SLA evaluation writes in `apps/api/src/procurement-sla.ts` and `apps/api/src/procurement-sla-automation.ts`.

Do not use SQLite triggers because the required SHA-256 payload hash and integrity-event behavior are application semantics.

- [ ] **Step 5: Prove projection failure does not alter committed procurement facts**

Add a test that deliberately makes projector processing fail after a successful `send_po` Outbox completion, then asserts PO status remains `sent` and the projection job is `retry_wait`.

Run: `pnpm exec tsx --test packages/persistence/test/procurement-persistence.test.ts --test-name-pattern "Twin projection jobs|projection failure"`  
Expected: PASS.

- [ ] **Step 6: Run the complete persistence suite**

Run: `pnpm exec tsx --test packages/persistence/test/*.test.ts`  
Expected: PASS.

- [ ] **Step 7: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add packages/persistence apps/api/src/procurement-sla.ts apps/api/src/procurement-sla-automation.ts && git commit -m "feat: enqueue twin projections atomically" || true`

### Task 7: Immutable snapshots, field policy and Agent Events

**Files:**
- Create: `packages/context/src/context-access-policy.ts`
- Create: `packages/context/src/snapshot-builder.ts`
- Create: `packages/context/src/agent-events.ts`
- Modify: `packages/context/src/sqlite-manufacturing-context-store.ts`
- Modify: `packages/context/src/index.ts`
- Create: `packages/context/test/snapshot-builder.test.ts`

**Interfaces:**
- Consumes: neighborhood queries from Task 3 and projected PO graph from Task 5.
- Produces: `scopeForSession()`, `buildTwinSnapshot()`, immutable `createSnapshot()` and `appendAgentEvent()`.

- [ ] **Step 1: Write failing masking and immutability tests**

```ts
function contextFixture() {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const store = new SqliteManufacturingContextStore(db, 'tenant:a');
  const po = store.upsertEntity({ entityType: 'purchase_order', canonicalKey: 'readywork:po:1', label: 'PO-1', lifecycleState: 'sent', attributes: { businessObjectId: 'po:1' }, state: { missingFacts: [] }, sourceWatermark: 'w1', effectiveAt: at, observedAt: at });
  const supplier = store.upsertEntity({ entityType: 'supplier', canonicalKey: 'odoo:partner:6', label: '上海卓越阀门', lifecycleState: 'active', attributes: { contacts: [{ email: 'supplier@supplysentry.invalid' }] }, state: {}, sourceWatermark: 'w1', effectiveAt: at, observedAt: at });
  const statusEvidence = store.appendEvidence({ entityId: po.id, sourceSemantics: 'verified_external', sourceKind: 'outbox', sourceId: 'outbox:1', sourceVersion: '1', sourceHash: 'hash:sent', factPath: 'purchase_order.status', value: 'sent', confidence: 1, effectiveAt: at, observedAt: at, actorId: 'connector:email', rawReference: { table: 'procurement_outbox', id: 'outbox:1' } });
  store.upsertRelation({ relationType: 'ordered_from', fromEntityId: po.id, toEntityId: supplier.id, status: 'active', sourceEvidenceId: statusEvidence.id, validFrom: at });
  return { db, store, po, supplier };
}

function externalStatusEvidence(entityId: string, value: string, sourceVersion: string): AppendTwinEvidenceInput {
  return { entityId, sourceSemantics: 'verified_external', sourceKind: 'odoo', sourceId: 'purchase.order:1', sourceVersion, sourceHash: `hash:${value}:${sourceVersion}`, factPath: 'purchase_order.status', value, confidence: 1, effectiveAt: at, observedAt: at, actorId: 'source:odoo', rawReference: { table: 'procurement_documents', id: 'po:1' } };
}

test('snapshot masks contacts for read-only scope and never changes after source updates', () => {
  const fixture = contextFixture();
  const first = fixture.store.createSnapshot({ employeeId: 'ai:po', rootEntityId: fixture.po.id,
    purpose: 'po_supplier_commitment', scope: { permission: 'read', entityTypes: ['purchase_order','supplier','contact'], includeContactDetails: false, includeCommercialTerms: false } });
  const supplier = (first.snapshot['entities'] as Array<Record<string, any>>).find((entity) => entity['entityType'] === 'supplier')!;
  assert.equal((supplier['attributes'] as Record<string, any>)['contacts'][0].email, 's***@supplysentry.invalid');
  fixture.store.appendEvidence(externalStatusEvidence(fixture.po.id, 'confirmed', 'v2'));
  const loaded = fixture.store.getSnapshot(first.id)!;
  assert.equal(loaded.contentHash, first.contentHash);
  const rootFacts = (loaded.snapshot['root'] as Record<string, any>)['facts'] as Record<string, Record<string, unknown>>;
  assert.equal(rootFacts['purchase_order.status']!['value'], 'sent');
});
```

- [ ] **Step 2: Run the test and confirm the masking/immutability failure**

Run: `pnpm exec tsx --test packages/context/test/snapshot-builder.test.ts`  
Expected: FAIL because snapshot policy is not implemented.

- [ ] **Step 3: Implement the explicit field policy**

`scopeForSession()` maps existing permissions exactly:

```ts
read       -> masked contact, no commercial terms
operate    -> full operational contact, commercial terms required by the action
approve    -> full contact and commercial terms
configure  -> full context and projection health
admin      -> full context and projection health
```

Drop keys matching credential/secret/token/password/cookie/authorization patterns at every depth. Replace email and phone values with deterministic masks when `includeContactDetails=false`. Replace raw email body and attachment content with `{ sourceObjectId, contentHash, restricted: true }` references.

- [ ] **Step 4: Implement canonical snapshot construction and size limits**

Build a JSON object with `schemaVersion`, root, entities, relations, selected evidence, conflicts, `missingFacts`, stage/SLA/approval/Outbox state, recent Agent Events, `sourceWatermark`, `truncated` and cursors. Canonically sort object keys and arrays before hashing. Exclude snapshot ID and `createdAt` from `contentHash`.

If serialized bytes exceed 512 KiB, reduce evidence first and then non-root entities while setting `truncated=true` and a continuation cursor; never truncate the root or `missingFacts`.

- [ ] **Step 5: Implement immutable Agent Event writes**

`appendAgentEvent()` validates event type, snapshot ownership and tenant, redacts payload, and inserts once using an idempotency key based on `(runId, taskId, eventType, promptHash, responseHash, actionName)`.

- [ ] **Step 6: Verify snapshot and Agent Event tests**

Run: `pnpm exec tsx --test packages/context/test/snapshot-builder.test.ts`  
Expected: PASS for masking, commercial-term scope, immutable reload, stable hash, explicit truncation and Agent Event idempotency.

- [ ] **Step 7: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add packages/context && git commit -m "feat: add immutable context snapshots" || true`

### Task 8: Approved human correction workflow

**Files:**
- Create: `apps/api/src/manufacturing-context-corrections.ts`
- Create: `apps/api/test/manufacturing-context-corrections.test.ts`

**Interfaces:**
- Consumes: existing `procurement_execution_approvals`, Task 3 evidence store and Task 4 queue.
- Produces: `ManufacturingContextCorrectionContext`, `requestTwinCorrection()` and `decideTwinCorrection()`.

- [ ] **Step 1: Write failing four-eyes and precedence tests**

```ts
function correctionFixture() {
  const persistence = openPersistence(':memory:', { tenantId: 'tenant:a' });
  const store = new SqliteManufacturingContextStore(persistence.db, 'tenant:a');
  const queue = new SqliteTwinProjectionQueue(persistence.db, 'tenant:a');
  const po = store.upsertEntity({ entityType: 'purchase_order', canonicalKey: 'readywork:po:1', label: 'PO-1', lifecycleState: 'sent', attributes: { businessObjectId: 'po:1' }, state: {}, sourceWatermark: 'w1', effectiveAt: at, observedAt: at });
  const context: ManufacturingContextCorrectionContext = { db: persistence.db, tenantId: 'tenant:a', store, queue };
  return { persistence, store, queue, po, context };
}

test('Twin correction requires a different approver and cannot hide external evidence', () => {
  const fixture = correctionFixture();
  const pending = requestTwinCorrection(fixture.context, {
    entityId: fixture.po.id, factPath: 'purchase_order.promised_at', oldValue: null,
    newValue: '2026-09-08T00:00:00.000Z', reason: '已核对供应商盖章确认',
    evidenceReference: 'attachment:confirmation:1', requestedBy: 'human:buyer', requesterPermission: 'operate', requestedAt: at,
  });
  assert.throws(() => decideTwinCorrection(fixture.context, { approvalId: pending.id, decision: 'approved', decidedBy: 'human:buyer', approverPermission: 'approve', decidedAt: at }), /不能审批自己/);
  const approved = decideTwinCorrection(fixture.context, { approvalId: pending.id, decision: 'approved', decidedBy: 'human:manager', approverPermission: 'approve', decidedAt: at });
  assert.equal(approved.status, 'approved');
  assert.equal(fixture.store.listEvidence(fixture.po.id).some((e) => e.sourceSemantics === 'approved_human'), true);
});
```

- [ ] **Step 2: Run the test and confirm the missing service failure**

Run: `pnpm exec tsx --test apps/api/test/manufacturing-context-corrections.test.ts`  
Expected: FAIL because the correction service does not exist.

- [ ] **Step 3: Implement correction requests in existing approval storage**

Store pending JSON with `kind='twin_fact_correction'`, entity ID, fact path, old/new JSON, reason, evidence reference, requester and version. Require `operate` for request creation and reject missing evidence references.

```ts
export interface ManufacturingContextCorrectionContext {
  db: DatabaseSync;
  tenantId: string;
  store: SqliteManufacturingContextStore;
  queue: SqliteTwinProjectionQueue;
}
```

- [ ] **Step 4: Implement approval and projection**

On approval, in one `BEGIN IMMEDIATE` transaction:

1. verify pending status and different human identity;
2. set approval to `approved` with decision metadata;
3. append immutable `approved_human` evidence with priority 300;
4. enqueue a correction projection;
5. append `human_feedback` Agent Event and `runtime_activities` audit.

When priority-400 evidence conflicts, keep it selected and expose the human correction in `conflicts`; do not update the procurement source row.

- [ ] **Step 5: Verify correction tests**

Run: `pnpm exec tsx --test apps/api/test/manufacturing-context-corrections.test.ts`  
Expected: PASS for authorization, four-eyes, idempotent decision, rejection, conflict display and audit.

- [ ] **Step 6: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add apps/api/src/manufacturing-context-corrections.ts apps/api/test/manufacturing-context-corrections.test.ts && git commit -m "feat: govern twin fact corrections" || true`

### Task 9: Projector worker and Context API

**Files:**
- Create: `apps/api/src/manufacturing-context-worker.ts`
- Create: `apps/api/src/manufacturing-context-routes.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/test/manufacturing-context-worker.test.ts`
- Create: `apps/api/test/manufacturing-context-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 3–8.
- Produces: leased polling worker and the exact `/api/context/v1` endpoints from the spec.

- [ ] **Step 1: Write failing worker recovery and API authorization tests**

```ts
async function contextApiFixture() {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const tenantA = new SqliteManufacturingContextStore(db, 'tenant:a');
  const tenantB = new SqliteManufacturingContextStore(db, 'tenant:b');
  tenantA.upsertEntity({ entityType: 'purchase_order', canonicalKey: 'readywork:po:a', label: 'PO-A', lifecycleState: 'sent', attributes: { businessObjectId: 'po:a' }, state: {}, sourceWatermark: 'wa', effectiveAt: at, observedAt: at });
  const other = tenantB.upsertEntity({ entityType: 'purchase_order', canonicalKey: 'readywork:po:b', label: 'PO-B', lifecycleState: 'sent', attributes: { businessObjectId: 'po:b' }, state: {}, sourceWatermark: 'wb', effectiveAt: at, observedAt: at });
  const sessions: Record<string, Session> = {
    buyer: { username: 'buyer', tenantId: 'tenant:a', humanId: 'human:buyer', name: '采购员', role: '采购专员', expiresAt: Date.now() + 60_000 },
    manager: { username: 'manager', tenantId: 'tenant:a', humanId: 'human:manager', name: '经理', role: '采购经理', expiresAt: Date.now() + 60_000 },
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    void handleManufacturingContextRequest(req, res, path, req.method ?? 'GET', {
      db, session: sessions[token] ?? null, workerStatus: () => ({ state: 'ready', lastHeartbeatAt: at }), internal: false,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    buyerToken: 'buyer', managerToken: 'manager', otherTenantEntityId: other.id,
    async request(method: string, path: string, token: string) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('Context API returns 404 for another tenant and configure-only projection health', async (t) => {
  const fixture = await contextApiFixture();
  t.after(() => fixture.close());
  const other = await fixture.request('GET', `/api/context/v1/entities/${fixture.otherTenantEntityId}`, fixture.buyerToken);
  assert.equal(other.status, 404);
  const buyerHealth = await fixture.request('GET', '/api/context/v1/projections/status', fixture.buyerToken);
  assert.equal(buyerHealth.status, 403);
  const managerHealth = await fixture.request('GET', '/api/context/v1/projections/status', fixture.managerToken);
  assert.equal(managerHealth.status, 200);
});

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
  }});
  await worker.runOnce();
  const retry = queue.get(original.id)!;
  assert.equal(retry.status, 'retry_wait');
  now = retry.availableAt;
  await worker.runOnce();
  const completed = queue.get(original.id)!;
  assert.equal(completed.id, original.id);
  assert.equal(completed.status, 'succeeded');
});
```

- [ ] **Step 2: Run both focused tests and confirm missing worker/handler failures**

Run: `pnpm exec tsx --test apps/api/test/manufacturing-context-worker.test.ts apps/api/test/manufacturing-context-routes.test.ts`  
Expected: FAIL because the worker and route handler do not exist.

- [ ] **Step 3: Implement the worker**

`ManufacturingContextWorker.runOnce()` claims at most 25 jobs for 60 seconds, dispatches `purchase_order.*` jobs to `ProcurementPoProjector`, marks each success with its returned watermark, and independently fails each error through the queue. `start()` polls every configured 3 seconds, prevents overlapping cycles and publishes heartbeat state in process memory for the status API.

```ts
export interface ManufacturingContextWorkerOptions {
  queue: SqliteTwinProjectionQueue;
  workerId: string;
  now: () => string;
  project: (job: TwinProjectionJob) => { projectedWatermark: string };
}
```

- [ ] **Step 4: Implement Web APIs with stable response envelopes**

```ts
type ContextEnvelope<T> = {
  data: T;
  sourceWatermark: string;
  projectionStatus: 'current' | 'lagging' | 'degraded' | 'unavailable';
  missingFacts: string[];
  conflicts: TwinFactConflict[];
  truncated: boolean;
  nextCursor: string | null;
};

export interface ManufacturingContextRouteContext {
  db: DatabaseSync;
  session: Session | null;
  internal: boolean;
  workerStatus: () => { state: 'ready' | 'unavailable'; lastHeartbeatAt: string | null };
}
```

Implement:

```text
GET /api/context/v1/entities/:entityId
GET /api/context/v1/entities/:entityId/neighborhood
GET /api/context/v1/objects/:businessObjectId
GET /api/context/v1/snapshots/:snapshotId
GET /api/context/v1/projections/status
POST /api/context/v1/entities/:entityId/corrections
POST /api/context/v1/corrections/:approvalId/decision
POST /api/context/v1/projections/:jobId/replay
POST /api/internal/context/v1/snapshots
POST /api/internal/context/v1/agent-events
```

Web routes derive tenant from Session. Internal routes require the existing internal token gate and accept a tenant only after that gate. Read operations require `read`; corrections require `operate`/`approve`; status and replay require `configure` or `admin`.

- [ ] **Step 5: Register routes and worker without crossing service surfaces**

Register read APIs on the business surface, correction and replay mutations on the existing authenticated business surface, and internal snapshot/event writes behind `/api/internal/`. Start the projector only when `SERVICE_SURFACE !== 'control'`. Keep control-only deployments read-free from procurement context.

- [ ] **Step 6: Verify routes, worker and API typecheck**

Run: `pnpm exec tsx --test apps/api/test/manufacturing-context-worker.test.ts apps/api/test/manufacturing-context-routes.test.ts`  
Expected: PASS.

Run: `pnpm typecheck`  
Expected: PASS.

- [ ] **Step 7: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add apps/api/src/manufacturing-context-worker.ts apps/api/src/manufacturing-context-routes.ts apps/api/src/index.ts apps/api/test/manufacturing-context-worker.test.ts apps/api/test/manufacturing-context-routes.test.ts && git commit -m "feat: expose manufacturing context api" || true`

### Task 10: Temporal Agent snapshots and Agent Event recording

**Files:**
- Modify: `apps/temporal-worker/src/node-activity.ts`
- Modify: `apps/temporal-worker/src/index.ts`
- Modify: `apps/temporal-worker/test/node-activity.test.ts`

**Interfaces:**
- Consumes: internal snapshot and Agent Event APIs from Task 9.
- Produces: `NodeActivityContextPort`, snapshot-backed Agent requests, and event records for context read, decision, action request and action result.

- [ ] **Step 1: Write a failing Agent snapshot correlation test**

```ts
test('AI node uses one immutable Twin snapshot and records the decision against it', async () => {
  const events: Array<Record<string, unknown>> = [];
  const context: NodeActivityContextPort = {
    createSnapshot: async () => ({
      id: 'snapshot:1',
      sourceWatermark: 'watermark:1',
      contextSnapshot: { employeeId: 'ai:test', at, entities: [], relationships: [], memory: { rootEntityId: 'po:1' } },
    }),
    appendAgentEvent: async (event) => { events.push(event); },
  };
  const agent: AgentRuntimePort = {
    async execute() {
      return {
        reasoning: '承诺日期已提取',
        actions: [],
        stateUpdates: { promise_date: '2026-09-03', confidence: 0.94 },
      };
    },
  };
  const input = activityInput('ai:eta-extract', 'supervised', { businessObjectId: 'po:1', text: '承诺 9 月 3 日到货' });
  await executeWorkforceNode(input, { executeGateway: async () => ({ ok: true }), agent, context });
  assert.equal(events.some((event) => event.eventType === 'context_read' && event.inputSnapshotId === 'snapshot:1'), true);
  assert.equal(events.some((event) => event.eventType === 'decision' && event.inputSnapshotId === 'snapshot:1'), true);
});
```

- [ ] **Step 2: Run the test and confirm the missing Context Port failure**

Run: `pnpm exec tsx --test apps/temporal-worker/test/node-activity.test.ts --test-name-pattern "immutable Twin snapshot"`  
Expected: FAIL because `NodeActivityContextPort` is absent.

- [ ] **Step 3: Add the injected Context Port and root resolution**

```ts
export interface NodeActivityContextPort {
  createSnapshot(input: { tenantId: string; employeeId: string; rootBusinessObjectId: string; purpose: string }): Promise<{
    id: string;
    sourceWatermark: string;
    contextSnapshot: ContextSnapshot;
  }>;
  appendAgentEvent(input: Record<string, unknown>): Promise<void>;
}

export interface NodeActivityPorts {
  executeGateway(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  agent?: AgentRuntimePort;
  agentMetadata?: AgentRuntimeMetadata;
  context?: NodeActivityContextPort;
}
```

Resolve the root only from `businessObjectId`, `aggregateId`, `poId` or a typed node parameter. If no root exists, keep the current empty context behavior and record no false context correlation.

- [ ] **Step 4: Create one snapshot before an AI call and record immutable correlations**

Use `saved.contextSnapshot` in `AgentRequest.contextSnapshot`, and use `saved.id` as every correlated event's `inputSnapshotId`. Record `context_read` before execution, `decision` after a successful model result, `action_requested` before Gateway execution, `action_result` only after the Gateway returns. Store model/provider and prompt/response hashes, never model credentials or raw unrestricted input.

- [ ] **Step 5: Wire the worker entry to the signed internal API client**

Create the port in `apps/temporal-worker/src/index.ts` using the existing callback base URL and `READYWORK_INTERNAL_TOKEN`. A failed Context write must fail the AI Activity before the model call, allowing Temporal retry; a failed post-Gateway event write must not replay a completed external side effect and instead use the existing idempotent Action Gateway result on retry.

- [ ] **Step 6: Verify all Temporal worker tests**

Run: `pnpm exec tsx --test apps/temporal-worker/test/*.test.ts`  
Expected: PASS, including analysis-only safeguards and Action Gateway isolation.

- [ ] **Step 7: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add apps/temporal-worker && git commit -m "feat: bind agent runs to context snapshots" || true`

### Task 11: Manufacturing Context in the PO workbench

**Files:**
- Create: `apps/console/features/procurement/manufacturing-context-view-model.ts`
- Create: `apps/console/features/procurement/manufacturing-context-view-model.test.ts`
- Create: `apps/console/features/procurement/manufacturing-context-panel.tsx`
- Modify: `apps/console/features/procurement/po-employee.tsx`

**Interfaces:**
- Consumes: `GET /api/context/v1/objects/:businessObjectId` and correction APIs.
- Produces: a `context` PO detail tab with real entity, relation, evidence, missing-fact, conflict, Agent Event and projection-health states.

- [ ] **Step 1: Write a failing view-model test**

```ts
test('context view model keeps missing facts visible and labels observed backfill honestly', () => {
  const model = manufacturingContextViewModel({
    data: { root: { label: 'PO-1' }, evidence: [{ sourceSemantics: 'observed_backfill', factPath: 'purchase_order.status', value: 'sent' }] },
    sourceWatermark: 'watermark:1', projectionStatus: 'current',
    missingFacts: ['odoo_purchase_order','supplier_confirmation','production_progress','shipment','grn'],
    conflicts: [], truncated: false, nextCursor: null,
  });
  assert.deepEqual(model.missingFacts.map((item) => item.label), ['Odoo 采购订单','供应商正式确认','生产 / 备货进度','发运 / ASN','最终 GRN']);
  assert.equal(model.evidence[0]!.sourceLabel, '历史状态观察（非精确迁移时间）');
});
```

- [ ] **Step 2: Run the view-model test and confirm the missing function failure**

Run: `pnpm exec tsx --test apps/console/features/procurement/manufacturing-context-view-model.test.ts`  
Expected: FAIL because `manufacturingContextViewModel` does not exist.

- [ ] **Step 3: Implement deterministic presentation mappings**

Map source semantics, entity types, relation types and missing-fact codes to Chinese labels. Do not infer completion from status text. Map `lagging`, `degraded` and `unavailable` to explicit warning copy that the projection may be stale while procurement facts remain authoritative.

- [ ] **Step 4: Build the panel with real loading, empty and error states**

The panel loads the selected PO ID with `apiRequest`, aborts stale requests, and renders these sections:

```text
实体摘要
关系与上游来源
事实与证据
缺失事实
冲突与人工纠正
Agent 记录
投影状态与水位
```

Use compact cards and lists already present in `po-employee.tsx`; do not add a graph library. Only show a correction submit action when `permissions.operate` is true. Show no success state until the correction API returns the persisted approval.

- [ ] **Step 5: Add the new PO detail tab**

Extend `DetailTab` with `'context'`, add `['context', '制造上下文']` to the tab list, and render `<ManufacturingContextPanel purchaseOrderId={asText(po.id)} permissions={permissions} />`. Keep the existing analysis, timeline, messages, documents and audit tabs unchanged.

- [ ] **Step 6: Verify view model, lint and production build**

Run: `pnpm exec tsx --test apps/console/features/procurement/manufacturing-context-view-model.test.ts`  
Expected: PASS.

Run: `pnpm --filter @readywork/app-console lint`  
Expected: PASS.

Run: `pnpm --filter @readywork/app-console build`  
Expected: PASS.

- [ ] **Step 7: Verify the running page in the in-app browser**

Open `http://127.0.0.1:3001/?section=orders&poId=po%3A7c4c2aa5-b119-4e14-8953-a9fc78882e2a`, select “制造上下文”, and confirm the real PO shows five missing facts, the dispatched Outbox evidence, and no invented supplier confirmation or GRN.

- [ ] **Step 8: Create the task checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add apps/console/features/procurement && git commit -m "feat: show manufacturing context in PO workbench" || true`

### Task 12: Readiness gate, real PO acceptance and runbook

**Files:**
- Modify: `apps/api/src/procurement-v1-readiness.ts`
- Modify: `apps/api/test/procurement-v1-readiness.test.ts`
- Create: `apps/validation/src/manufacturing-context-chain.ts`
- Modify: `apps/validation/package.json`
- Modify: `package.json`
- Create: `docs/MANUFACTURING-CONTEXT-RUNBOOK.md`

**Interfaces:**
- Consumes: completed Context/Twin storage, worker, API and UI.
- Produces: a `manufacturing_context` readiness gate, a repeatable real-database acceptance command and an operations runbook.

- [ ] **Step 1: Write a failing readiness gate test**

```ts
test('V1 readiness blocks when Context projection is dead-lettered or stale', () => {
  const tenantId = 'tenant:context-readiness';
  const at = '2026-08-28T08:00:00.000Z';
  const store = openPersistence(':memory:', { tenantId });
  try {
    store.db.prepare(`INSERT INTO twin_projection_jobs
      (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,available_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'dead_letter',8,8,?,?,?)`)
      .run(tenantId, 'job:dead', 'procurement_documents', 'purchase_order:po:1', '1', 'purchase_order.changed', 'hash', at, at, at);
    const operations = {
      ...readyOperations,
      manufacturingContext: { workerReady: true, lastHeartbeatAt: '2026-08-28T07:59:59.000Z', pollIntervalMs: 3_000 },
    };
    const view = procurementV1Readiness(store.db, tenantId, operations, new Date(at));
    assert.equal(view.gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'blocked');
  } finally {
    store.close();
  }
});
```

- [ ] **Step 2: Run the readiness test and confirm the missing gate failure**

Run: `pnpm exec tsx --test apps/api/test/procurement-v1-readiness.test.ts --test-name-pattern "Context projection"`  
Expected: FAIL because `manufacturing_context` is not a valid gate.

- [ ] **Step 3: Add the readiness gate without weakening existing gates**

Extend the gate union with `manufacturing_context` and add this exact optional runtime input:

```ts
manufacturingContext?: {
  workerReady?: boolean;
  lastHeartbeatAt?: string | null;
  pollIntervalMs?: number;
};
```

Read `dead_letter` count and the oldest `queued` / `retry_wait` `available_at` directly from `twin_projection_jobs` for the current tenant. Mark the gate ready only when the worker is ready, its heartbeat age is at most `2 * pollIntervalMs`, `dead_letter=0`, and the oldest pending job is no more than 10 minutes old. Add a ready `manufacturingContext` value to the existing `readyOperations` test fixture and update the all-ready assertion from 10 to 11 gates. Add separate assertions for stale heartbeat and a job older than 10 minutes. Keep the existing real five-stage closed-loop result unchanged and route the new gate to the existing `runtime` target.

- [ ] **Step 4: Implement the real PO acceptance chain**

`manufacturing-context-chain.ts` must:

1. require an explicit database path and refuse `:memory:`;
2. open `data/readywork.sqlite` for the configured tenant;
3. enqueue and run idempotent backfill for only `po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a`;
4. assert supplier `上海卓越阀门`, item `PV-30`, quantity `200`, unit price `127 CNY`, PO status `sent`;
5. assert the `purchase_order.send` Outbox is `dispatched`;
6. assert current stage `supplier_commitment` and evidence semantics `observed_backfill` for migration history;
7. assert missing Odoo PO, supplier confirmation, production progress, shipment and GRN;
8. run the projection twice and assert entity/relation/evidence counts remain stable;
9. create a snapshot, append a correlated Agent Event, reload both and assert the shared snapshot ID;
10. print counts, IDs, watermarks and hashes without printing email credentials or raw message bodies.

Add root script:

```json
"validate:manufacturing-context": "tsx apps/validation/src/manufacturing-context-chain.ts data/readywork.sqlite t:acme po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a"
```

- [ ] **Step 5: Write the operations runbook**

Document worker startup, API health checks, queue SQL diagnostics, dead-letter replay authorization, backfill semantics, snapshot limits, evidence priorities, incident response and the exact real PO validation command. Explicitly state that validation does not send email, create Odoo POs or create GRNs.

- [ ] **Step 6: Run focused and full verification**

Run: `pnpm exec tsx --test apps/api/test/procurement-v1-readiness.test.ts`  
Expected: PASS.

Run: `pnpm validate:manufacturing-context`  
Expected: PASS with the real PO facts and five honest missing facts.

Run: `pnpm test`  
Expected: PASS.

Run: `pnpm typecheck`  
Expected: PASS.

Run: `pnpm --filter @readywork/app-console lint && pnpm --filter @readywork/app-console build`  
Expected: PASS.

- [ ] **Step 7: Verify persistence directly**

Run:

```bash
sqlite3 -readonly -header -column data/readywork.sqlite "SELECT status,COUNT(*) AS count FROM twin_projection_jobs WHERE tenant_id='t:acme' GROUP BY status ORDER BY status;"
sqlite3 -readonly -header -column data/readywork.sqlite "SELECT entity_type,COUNT(*) AS count FROM twin_entities WHERE tenant_id='t:acme' GROUP BY entity_type ORDER BY entity_type;"
sqlite3 -readonly -header -column data/readywork.sqlite "SELECT source_semantics,COUNT(*) AS count FROM twin_evidence WHERE tenant_id='t:acme' GROUP BY source_semantics ORDER BY source_semantics;"
```

Expected: no `dead_letter`; the real PO graph includes PO, line, supplier, material and sourcing entities; evidence includes the real Outbox receipt and honest backfill semantics.

- [ ] **Step 8: Create the final checkpoint**

Run: `git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git add apps/api apps/validation package.json docs/MANUFACTURING-CONTEXT-RUNBOOK.md && git commit -m "feat: complete manufacturing context v1" || true`
