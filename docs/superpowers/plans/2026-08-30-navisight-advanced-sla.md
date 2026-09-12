# Navisight Advanced SLA Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the independent, real-data Advanced SLA product surface publicly visible in Navisight: nine versioned rule domains, manual and CSV configuration, audited publish/retire, guarded auto-send, and a matching navigation entry without weakening Readywork safety controls.

**Architecture:** Reuse Readywork's existing `procurement_sla_*`, message-draft, Outbox, Temporal, PO route, import-document and GRN fact layers. Add one versioned Advanced SLA template/control layer above those immutable facts, plus import batches and a separate runtime kill switch. Advanced SLA never rewrites PO facts; publishing changes only the active rule template and the auto-send eligibility evaluator.

**Tech Stack:** Node 22 `node:sqlite`, TypeScript, `node:http`, Next.js/React/Tailwind, Papaparse (MIT) for CSV parsing, existing message-draft/Outbox/Temporal services.

**Spec:** `docs/NAVISIGHT-PUBLIC-APP-CONTRACT.md`

## Global Constraints

- All nine public Advanced SLA domains must exist as real persisted rule sections; no hardcoded ACME, PO, supplier, KPI or sample rows may enter production data.
- Manual edits and CSV import must call the same server-side rule validator.
- CSV import is preview-first; applying requires `configure` and `approve`, expected versions, and one SQLite transaction.
- Auto-send defaults off and cannot bypass an active named communication identity, published base SLA, verified channel credential, stage/channel/risk allowlists, the runtime kill switch, Outbox, or audit.
- Published policy versions and audit events are immutable; changes require a new draft or an explicit runtime-control event.
- All reads and writes are tenant scoped; unauthenticated requests fail closed.
- UI success appears only after the backend has persisted and returned the resulting version.

---

### Task 1: Versioned nine-domain Advanced SLA contract

**Files:**
- Create: `apps/api/src/procurement-advanced-sla.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/test/procurement-advanced-sla.test.ts`

**Interfaces:**
- Consumes: existing `Session`, `can`, `procurementPortfolio`, `procurement_sla_policies`, `procurement_communication_identities`, and `control_credentials`.
- Produces: `handleProcurementAdvancedSlaRequest(...)`, `publishedAdvancedSlaProfile(db, tenantId)`, `advancedSlaAutoSendDecision(db, tenantId, candidate)`, and REST routes rooted at `/api/procurement/advanced-sla`.

- [ ] **Step 1: Write the failing API test**

```ts
test('Advanced SLA persists nine domains with version, permissions, tenant isolation and immutable publish', async () => {
  const empty = await request('/api/procurement/advanced-sla');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.domains.map((item: any) => item.id), ADVANCED_SLA_DOMAINS);
  assert.equal(empty.body.publishedProfile, null);

  const forbidden = await request('/api/procurement/advanced-sla/profiles', 'POST', 'buyer', validProfile);
  assert.equal(forbidden.status, 403);

  const created = await request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', validProfile);
  assert.equal(created.status, 201);
  assert.equal(created.body.item.sections.length, 9);
  assert.equal(created.body.item.autoSend.enabled, false);

  const conflict = await request(`/api/procurement/advanced-sla/profiles/${created.body.item.id}`, 'PATCH', 'manager', {
    ...validProfile, expectedVersion: 999,
  });
  assert.equal(conflict.status, 409);

  const published = await request(`/api/procurement/advanced-sla/profiles/${created.body.item.id}/publish`, 'POST', 'manager', {
    expectedVersion: 1,
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.item.status, 'published');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm exec tsx --test apps/api/test/procurement-advanced-sla.test.ts`

Expected: FAIL because `procurement-advanced-sla.ts` and its tables/routes do not exist.

- [ ] **Step 3: Add schema and strict domain validator**

Add tenant-scoped tables:

```sql
procurement_advanced_sla_profiles(
  tenant_id,id,name,description,status,version,sections_json,auto_send_json,
  created_by,updated_by,published_by,created_at,updated_at,published_at
)
procurement_advanced_sla_profile_events(
  tenant_id,id,profile_id,actor_id,action,detail_json,created_at
)
procurement_advanced_sla_runtime_controls(
  tenant_id,profile_id,profile_version,paused,reason,version,updated_by,updated_at
)
procurement_advanced_sla_runtime_events(
  tenant_id,id,profile_id,profile_version,actor_id,action,detail_json,created_at
)
```

The validator accepts exactly these domains:

```ts
export const ADVANCED_SLA_DOMAINS = [
  'production_service_milestones',
  'communication_escalation',
  'payment_terms',
  'logistics_planning',
  'logistics_handover',
  'transit_monitoring',
  'regulatory_import_approval',
  'customs_clearance',
  'quality_inspection_grn',
] as const;
```

Each rule has `id`, `name`, `enabled`, `scope`, and a domain-specific `parameters` object. Reject unknown top-level keys, duplicate rule IDs, missing domains, invalid stage/route/risk/channel values, non-finite durations, and empty evidence/responsibility requirements.

- [ ] **Step 4: Implement CRUD, publish, retire, impact preview and runtime-control routes**

Routes:

```text
GET  /api/procurement/advanced-sla
POST /api/procurement/advanced-sla/profiles
PATCH /api/procurement/advanced-sla/profiles/:id
POST /api/procurement/advanced-sla/profiles/:id/publish
POST /api/procurement/advanced-sla/profiles/:id/retire
PUT  /api/procurement/advanced-sla/runtime-control
```

Publishing requires both `configure` and `approve`, retires the previous published version in the same transaction, creates an unpaused runtime-control row, and returns a read-only impact preview derived from the current PO portfolio.

- [ ] **Step 5: Run the targeted test and verify GREEN**

Run: `pnpm exec tsx --test apps/api/test/procurement-advanced-sla.test.ts`

Expected: PASS with no warnings.

---

### Task 2: CSV preview, diff and transactional approval

**Files:**
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/persistence/src/index.ts`
- Modify: `apps/api/src/procurement-advanced-sla.ts`
- Test: `apps/api/test/procurement-advanced-sla.test.ts`

**Interfaces:**
- Consumes: Task 1 validator and profile presentation functions.
- Produces: persistent `AdvancedSlaImportBatch`, preview/apply routes, and immutable batch history.

- [ ] **Step 1: Add failing preview/apply test**

```ts
const preview = await request('/api/procurement/advanced-sla/imports/preview', 'POST', 'manager', {
  sourceName: 'advanced-sla.csv',
  csv: csvContainingAllNineDomains,
  baseProfileId: draft.id,
  expectedBaseVersion: draft.version,
});
assert.equal(preview.status, 201);
assert.equal(preview.body.item.status, 'previewed');
assert.ok(preview.body.item.diff.added > 0);

const applied = await request(`/api/procurement/advanced-sla/imports/${preview.body.item.id}/apply`, 'POST', 'manager', {
  expectedBatchVersion: preview.body.item.version,
  expectedBaseVersion: draft.version,
});
assert.equal(applied.status, 200);
assert.equal(applied.body.profile.status, 'published');
assert.equal(applied.body.batch.status, 'applied');
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec tsx --test apps/api/test/procurement-advanced-sla.test.ts --test-name-pattern 'CSV'`

Expected: FAIL with missing import route/table.

- [ ] **Step 3: Add Papaparse and import-batch persistence**

Run: `pnpm --filter @readywork/app-api add papaparse && pnpm --filter @readywork/app-api add -D @types/papaparse`

Add:

```sql
procurement_advanced_sla_import_batches(
  tenant_id,id,source_name,status,version,base_profile_id,base_profile_version,
  parsed_sections_json,diff_json,error_json,created_by,applied_by,
  created_at,updated_at,applied_at
)
```

- [ ] **Step 4: Implement one validator for manual and CSV paths**

CSV columns are `domain,rule_id,name,enabled,scope_json,parameters_json`. Parse with Papaparse, reject duplicate headers/IDs and formula-prefixed cells, convert JSON cells, then call the exact Task 1 `validateAdvancedSlaSections` function. Preview persists the normalized sections and deterministic diff. Apply requires both permissions, exact batch/base versions, publishes the imported profile and marks the batch applied in one transaction.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm exec tsx --test apps/api/test/procurement-advanced-sla.test.ts`

Expected: PASS including malformed CSV, tenant isolation, stale versions, and replay behavior.

---

### Task 3: Guarded auto-send through existing Message Draft and Outbox

**Files:**
- Modify: `apps/api/src/procurement-message-drafts.ts`
- Modify: `apps/api/src/procurement-sla-automation.ts`
- Modify: `apps/api/src/procurement-advanced-sla.ts`
- Test: `apps/api/test/procurement-sla-automation.test.ts`
- Test: `apps/api/test/procurement-message-drafts.test.ts`

**Interfaces:**
- Consumes: `advancedSlaAutoSendDecision(...)`, existing draft identity snapshots, `control_credentials`, and Outbox schema.
- Produces: `queueApprovedMessageDraft(...)` service shared by manual approval and Advanced SLA auto-send; automation result fields `autoQueued`, `autoBlocked`, `manualReview`.

- [ ] **Step 1: Add failing safety-matrix tests**

```ts
assert.equal(decide({ profile: null }).code, 'advanced_sla_not_published');
assert.equal(decide({ autoSend: false }).code, 'auto_send_disabled');
assert.equal(decide({ paused: true }).code, 'kill_switch_paused');
assert.equal(decide({ identity: null }).code, 'communication_identity_missing');
assert.equal(decide({ credentialReady: false }).code, 'channel_unavailable');
assert.equal(decide({ stageAllowed: false }).code, 'stage_not_allowed');
assert.equal(decide(allReady).code, 'ready');
```

Add an integration assertion that `ready` creates exactly one pending Outbox row and replay creates no duplicate, while every blocked case leaves the draft in `draft`.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec tsx --test apps/api/test/procurement-sla-automation.test.ts apps/api/test/procurement-message-drafts.test.ts`

Expected: FAIL because the shared queue service and Advanced SLA decision do not exist.

- [ ] **Step 3: Extract idempotent draft queue service**

```ts
export function queueApprovedMessageDraft(db, input): {
  draft: Record<string, unknown>;
  outbox: ProcurementOutboxMessage;
  replayed: boolean;
}
```

Manual approval calls it with the human reviewer. Automation calls it with `ai:advanced-sla:<profileId>:v<version>` only after the decision returns `ready`. The Outbox remains the only external-send boundary.

- [ ] **Step 4: Persist auto-send decisions and run results**

Every candidate writes an Advanced SLA runtime event with profile/version, draft ID, PO ID, decision code, and Outbox ID when queued. Never store message bodies, credentials or tokens in this event. A paused or unavailable connector remains visible as a truthful blocked state.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm exec tsx --test apps/api/test/procurement-sla-automation.test.ts apps/api/test/procurement-message-drafts.test.ts apps/api/test/procurement-advanced-sla.test.ts`

Expected: PASS with exact-once queueing and no external connector call in unit tests.

---

### Task 4: Independent Advanced SLA page and exact navigation skeleton

**Files:**
- Create: `apps/console/features/procurement/advanced-sla-workbench.tsx`
- Create: `apps/console/features/procurement/advanced-sla-view-model.ts`
- Create: `apps/console/features/procurement/advanced-sla-view-model.test.ts`
- Modify: `apps/console/app/page.tsx`
- Modify: `apps/console/features/procurement/v1-readiness-panel.tsx`

**Interfaces:**
- Consumes: Task 1/2 root, CRUD, import and runtime-control APIs through `apiRequest`.
- Produces: independent `advanced-sla` section, 10-entry Navisight-aligned sidebar, Configuration deep link for PO Intake, and honest normal/empty/error/permission/connector-paused states.

- [ ] **Step 1: Write failing view-model test**

```ts
test('Advanced SLA view model always orders the nine public domains and reports missing data honestly', () => {
  const view = advancedSlaViewModel(apiPayload);
  assert.deepEqual(view.sections.map((item) => item.id), ADVANCED_SLA_DOMAIN_ORDER);
  assert.equal(view.autoSend.state, 'paused_missing_identity');
  assert.equal(view.usesDemoData, false);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec tsx --test apps/console/features/procurement/advanced-sla-view-model.test.ts`

Expected: FAIL because the view model does not exist.

- [ ] **Step 3: Implement page states and interactions**

The page header uses 26px title, 13.5px subtitle, 28px horizontal/24px vertical rhythm, `#2563eb` primary, 12px controls and light card shadows. It contains:

```text
Advanced SLA
  Published/Draft/Auto-send/Kill-switch summary
  [Manual configuration] [CSV import]
  9 ordered domain sections
  impact preview
  version/audit/import history
```

Manual save, publish, retire, CSV preview/apply and pause/resume use real APIs and reload the returned versions. Buttons are disabled with an explicit reason when permissions/readiness are missing.

- [ ] **Step 4: Align the sidebar without deleting PO Intake**

Replace the top-level `PO 待核验` entry with `Advanced SLA`; keep `po-intake` as a valid deep-link section and add a Configuration card/button labelled `邮箱 PO 待核验`. Add `advanced-sla` to `Section`, `SECTION_VALUES`, titles, shell treatment, mobile nav and component rendering.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
pnpm exec tsx --test apps/console/features/procurement/advanced-sla-view-model.test.ts
pnpm typecheck
pnpm --filter @readywork/app-console build
```

Expected: all pass with no hardcoded business records.

---

### Task 5: End-to-end verification and evidence update

**Files:**
- Modify: `docs/NAVISIGHT-V1-ALIGNMENT.md`
- Modify: `docs/NAVISIGHT-PUBLIC-APP-CONTRACT.md`
- Modify: `docs/NAVISIGHT-VISUAL-TOKENS.md`

**Interfaces:**
- Consumes: all prior tasks and the running 3001/4173/4174 services.
- Produces: browser/API/SQLite evidence for the Advanced SLA completion criteria.

- [ ] **Step 1: Run targeted and full automated verification**

```bash
pnpm exec tsx --test apps/api/test/procurement-advanced-sla.test.ts apps/api/test/procurement-sla-automation.test.ts apps/api/test/procurement-message-drafts.test.ts apps/console/features/procurement/advanced-sla-view-model.test.ts
pnpm test
pnpm typecheck
pnpm --filter @readywork/app-console build
```

- [ ] **Step 2: Restart the affected local services**

Restart the business API, control API and console using the repository scripts, leaving the real SMTP/Odoo/Outbox state untouched.

- [ ] **Step 3: Verify one local API/SQLite round trip**

Create a draft profile under the authenticated local manager, reload it, preview a CSV batch, and inspect the tenant-scoped SQLite rows. Do not publish a real auto-send policy or dispatch email during this acceptance run.

- [ ] **Step 4: Browser-verify the page states**

At 1440×900 and 1920×1080 verify navigation, empty/draft/published views, CSV diff, permission block, and kill-switch/connector block. The browser must show API-derived data only.

- [ ] **Step 5: Update alignment evidence**

Record exact tests, routes, tables, screenshots and remaining gaps. Do not mark the full Navisight goal complete until PO detail six-tab reorganization, shell token unification and every other public page/capability gap are separately verified.
