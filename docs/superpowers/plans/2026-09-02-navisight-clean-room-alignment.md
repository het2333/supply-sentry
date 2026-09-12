# Readywork × Navisight Clean-room Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved desktop clean-room alignment under the Readywork brand, with ten exact procurement navigation entries and real API/SQLite/Temporal/Outbox/Odoo/Email/WhatsApp behavior for every visible business action.

**Architecture:** Keep the existing Readywork procurement ledger and runtime as the single source of truth. Add shared typed domain contracts in `packages/core`, additive migration 49 in `packages/persistence`, business API services in focused `apps/api/src/procurement-*` modules, and thin Console view models/components that reload authoritative state after mutations. Work is split into independently testable vertical slices; no slice may use mock production data or infer successful external effects.

**Tech Stack:** Node 24.19+, pnpm 11.7.0, TypeScript 6.0.3, Next.js 16.3.3, React 19.2.8, Tailwind CSS 4.3.3, SQLite `node:sqlite`, Temporal, existing Connector/Outbox services, Zod 4.5.4, TanStack Table 8.21.3, TanStack Virtual 3.14.10, Radix UI primitives, Recharts 3.10.1, date-fns 4.4.0, react-day-picker 10.0.1, cmdk 1.1.1, DOMPurify 3.4.14, Papa Parse 5.5.4, `@react-pdf/renderer` 4.9.0.

**Spec:** `docs/superpowers/specs/2026-09-02-navisight-clean-room-alignment-design.md`

## Global Constraints

- User approved the spec on 2026-09-02 and requested no further decision prompts; execute sequentially and stop only for an unsafe external side effect or a genuinely undiscoverable credential/business fact.
- Readywork is the only user-facing brand. Production source and browser network traffic must not load `navisight.ai` assets or render Navisight product/company copy.
- Procurement sidebar order is exactly Overview, Notifications, Drafted Emails, Local, Import, Risk Dashboard, Suppliers, SLA, Advanced SLA, Configuration.
- Desktop acceptance covers exactly 1280×720, 1440×900, and 1920×1080. Mobile alignment is outside this release.
- No mock production data, Demo Seed, hard-coded PO/supplier/KPI/risk/rule rows, localStorage business persistence, fake timers, or fake success.
- Formal `data/readywork.sqlite` is never used by automated write tests and receives no sample data. Tests use `:memory:`, temporary SQLite copies without credentials, fake/local connectors, and explicit test tenants.
- All retriable mutations require `Idempotency-Key`; all updates require `expectedVersion`; server code rechecks tenant, object authorization, business state, and external connector readiness.
- No user-visible `Sent`, `Synced`, `Cancelled`, or equivalent final success until the authoritative connector receipt/readback is successful.
- Migration 49 is additive and named `navisight-clean-room-alignment-v2`; if another migration lands before execution, mechanically renumber this exact migration to the next continuous integer without changing its schema contract.
- Read `apps/console/AGENTS.md` and the relevant Next.js 16 docs before every Console task. Mandatory first reads are `01-app/01-getting-started/05-server-and-client-components.md`, `04-linking-and-navigating.md`, `11-css.md`, `12-images.md`, `14-metadata-and-og-images.md`, `02-guides/lazy-loading.md`, `02-guides/testing/index.md`, `02-guides/production-checklist.md`, and `03-architecture/accessibility.md`.
- Use the workspace Node runtime for every pnpm/test/build command:

```bash
export PATH="/Users/etheralia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/etheralia/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/usr/bin:/bin"
```

- The workspace is not a Git repository. Do not initialize Git and do not claim commits. Each task ends with fresh verification evidence and a checked plan checkpoint.
- Before claiming a slice complete, run its focused tests, root `pnpm typecheck`, Console lint/build when affected, and the relevant browser/API/SQLite checks.

## File and Interface Map

| Responsibility | Primary files |
|---|---|
| Procurement pack/ten-entry IA | `packages/supply-chain/src/procurement-employee-pack.ts`, `packages/supply-chain/test/employee-pack.test.ts`, `apps/console/app/page.tsx` |
| Brand/public assets/legal | `apps/console/app/product/*`, `apps/console/features/marketing/*`, `apps/console/app/privacy/page.tsx`, `apps/console/app/terms/page.tsx`, `apps/console/public/readywork/*` |
| Notifications/drafts | `apps/api/src/procurement-notifications.ts`, `apps/api/src/procurement-message-drafts.ts`, `apps/console/features/procurement/notifications.tsx`, `message-drafts.tsx` |
| Route workbench/exports | `apps/api/src/procurement-routes.ts`, `procurement-workbench.ts`, new `procurement-route-exports.ts`, `apps/console/features/procurement/route-workbench.tsx` |
| PO context/actions/documents | `apps/api/src/procurement-workbench.ts`, `procurement-execution.ts`, new `procurement-po-documents.ts`, `apps/console/features/procurement/po-employee.tsx`, `po-detail-view-model.ts` |
| RiskModelV2 | new `packages/core/src/procurement-risk-model-v2.ts`, `apps/api/src/procurement-risk-dashboard.ts`, `apps/console/features/procurement/risk-dashboard*` |
| Supplier operating profile | new `packages/core/src/procurement-supplier-profile.ts`, persistence repositories, `apps/api/src/procurement-rfqs.ts`, `procurement-lead-times.ts`, `apps/console/features/procurement/suppliers-workbench.tsx` |
| SLA/Advanced SLA v2 | `packages/core/src/procurement-advanced-sla.ts`, `apps/api/src/procurement-sla.ts`, `procurement-advanced-sla.ts`, `apps/console/features/procurement/sla-workbench.tsx`, `advanced-sla-*` |
| Configuration | `apps/api/src/procurement-tenant-preferences.ts`, `procurement-configuration-connections.ts`, `apps/console/features/procurement/configuration-workbench.tsx` |
| Additive schema/repositories | `packages/persistence/src/index.ts` and focused test files under `packages/persistence/test/` |
| Program evidence | `docs/THIRD-PARTY-LICENSES.md`, `docs/NAVISIGHT-V1-ALIGNMENT.md`, this plan |

---

### Task 1: Freeze dependencies and create the third-party license ledger

**Files:**
- Create: `docs/THIRD-PARTY-LICENSES.md`
- Create: `apps/console/test/dependency-license-boundary.test.ts`
- Modify: `apps/console/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: current lockfile-resolved Console versions and the component decisions in spec §6.4.
- Produces: exact-version dependency manifest and a human-auditable license ledger required by every later component task.

- [x] **Step 1: Write the dependency boundary test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const exact = /^\d+\.\d+\.\d+$/;

test("Console dependencies are exact and never use latest or ranges", () => {
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.match(version, exact, `${name} must be pinned exactly`);
  }
});

test("every direct dependency is recorded in the license ledger", () => {
  const ledger = readFileSync(new URL("../../../docs/THIRD-PARTY-LICENSES.md", import.meta.url), "utf8");
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const escapedName = name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
    assert.match(ledger, new RegExp("\\| `" + escapedName + "` \\|"));
  }
});
```

- [x] **Step 2: Run the new test and verify it fails**

Run:

```bash
export PATH="/Users/etheralia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/etheralia/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/usr/bin:/bin"
pnpm exec tsx --test apps/console/test/dependency-license-boundary.test.ts
```

Expected: FAIL because `latest` ranges remain and `docs/THIRD-PARTY-LICENSES.md` does not exist.

- [x] **Step 3: Pin the current verified Console dependency versions**

Set the existing manifest values exactly to:

```json
{
  "@tailwindcss/postcss": "4.3.3",
  "@xyflow/react": "12.11.3",
  "class-variance-authority": "0.7.1",
  "clsx": "2.1.1",
  "geist": "1.7.2",
  "lucide-react": "1.37.0",
  "next": "16.3.3",
  "react": "19.2.8",
  "react-dom": "19.2.8",
  "tailwind-merge": "3.6.0",
  "tailwindcss": "4.3.3",
  "@types/node": "26.4.0",
  "@types/react": "19.2.18",
  "@types/react-dom": "19.2.5",
  "eslint": "9.39.2",
  "eslint-config-next": "16.3.3",
  "typescript": "6.0.3"
}
```

Do not add the future UI packages in this step. Add each package only in the task that first uses it, with the exact version from the Tech Stack header.

- [x] **Step 4: Create the license ledger**

Use this exact table schema and record all current direct Console and API parsing dependencies:

```markdown
# Readywork Third-Party Components and Licenses

| Package/service | Exact version | SPDX / terms | Direct / transitive | Source / vendor | Purpose | Trial expiry | Account / quota | Data leaves tenant environment | Production entitlement | NOTICE / attribution | OSS fallback | Owner | Commercial release conclusion |
|---|---:|---|---|---|---|---|---|---|---|---|---|---|---|
| `next` | `16.3.3` | MIT | Direct Console dependency | https://github.com/vercel/next.js | Console runtime | Not applicable | Not applicable | No | OSS approved | Retain copyright and license | Not applicable | Engineering | Approved under MIT |
```

For trial/commercial services, `Production entitlement` must be `not approved` until a purchase record exists. Do not write vendor credentials, contract prices, or tokens in the ledger.

- [x] **Step 5: Regenerate lockfile and verify**

Run:

```bash
export PATH="/Users/etheralia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/etheralia/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/usr/bin:/bin"
pnpm install --lockfile-only
pnpm exec tsx --test apps/console/test/dependency-license-boundary.test.ts
pnpm --filter @readywork/app-console build
```

Expected: dependency boundary tests PASS and the Next.js production build exits 0 without changing resolved versions.

- [x] **Step 6: Record the verified checkpoint**

Check this task in the plan and append the exact test/build commands and counts to `docs/NAVISIGHT-V1-ALIGNMENT.md`. Do not claim a Git commit.

---

### Task 2: Replace the procurement pack brand and freeze the ten-entry business IA

**Files:**
- Modify: `packages/core/src/employee-pack.ts`
- Modify: `packages/core/test/employee-pack.test.ts`
- Modify: `packages/supply-chain/src/procurement-employee-pack.ts`
- Modify: `packages/supply-chain/src/index.ts`
- Modify: `packages/supply-chain/test/procurement-employee-pack.test.ts`
- Modify: `apps/console/test/employee-packs.test.ts`

**Interfaces:**
- Consumes: `EmployeePackManifest` validation and the ten labels from the approved spec.
- Produces: `PROCUREMENT_BUSINESS_NAVIGATION` and a Readywork-branded pack whose navigation is the single source for the Console sidebar.

- [x] **Step 1: Write the exact navigation/brand tests**

```ts
const expected = [
  ["home", "Overview"],
  ["notifications", "Notifications"],
  ["message-drafts", "Drafted Emails"],
  ["local-procurement", "Local"],
  ["import-procurement", "Import"],
  ["risk-dashboard", "Risk Dashboard"],
  ["suppliers", "Suppliers"],
  ["sla", "SLA"],
  ["advanced-sla", "Advanced SLA"],
  ["settings", "Configuration"],
];
const items = PROCUREMENT_EMPLOYEE_PACK.interfaces.business.navigationGroups.flatMap((group) => group.items);
assert.deepEqual(items.map(({ id, label }) => [id, label]), expected);
assert.equal(PROCUREMENT_EMPLOYEE_PACK.name, "Readywork Procurement Execution");
assert.equal(PROCUREMENT_EMPLOYEE_PACK.branding.themeId, "readywork-procurement");
assert.ok(PROCUREMENT_EMPLOYEE_PACK.interfaces.business.ownedSectionIds.includes("orders"));
assert.ok(PROCUREMENT_EMPLOYEE_PACK.interfaces.business.ownedSectionIds.includes("po-intake"));
```

Also assert that business navigation contains neither `orders`, `po-intake`, `employees`, nor a developer/flow item.
Add a core contract assertion that a navigation group may use the exact empty label `""` while interface labels and item labels remain non-empty. Add a Console assertion that the navigation builder preserves the empty group label and does not turn owned deep-link sections into visible items.

- [x] **Step 2: Run focused pack tests and verify they fail**

Run:

```bash
pnpm exec tsx --test packages/core/test/employee-pack.test.ts packages/supply-chain/test/procurement-employee-pack.test.ts apps/console/test/employee-packs.test.ts
```

Expected: FAIL on the current Navisight pack name, theme ID, Chinese grouped labels, and extra navigation behavior.

- [x] **Step 3: Export the canonical navigation and update the pack**

Implement:

```ts
export const PROCUREMENT_BUSINESS_NAVIGATION = [
  { id: "home", label: "Overview", icon: "layout-dashboard" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "message-drafts", label: "Drafted Emails", icon: "mail" },
  { id: "local-procurement", label: "Local", icon: "shopping-cart" },
  { id: "import-procurement", label: "Import", icon: "globe-2" },
  { id: "risk-dashboard", label: "Risk Dashboard", icon: "activity" },
  { id: "suppliers", label: "Suppliers", icon: "users-round" },
  { id: "sla", label: "SLA", icon: "clock-3" },
  { id: "advanced-sla", label: "Advanced SLA", icon: "shield-check" },
  { id: "settings", label: "Configuration", icon: "settings" },
] as const;
```

Allow only navigation-group labels to be empty in `validateEmployeePackManifest`; interface and item labels remain non-empty. Use one navigation group with an empty label. Preserve `orders` and `po-intake` in `ownedSectionIds` as deep links. Preserve the developer interface and its `employees` ownership, but do not add it to business navigation. Re-export `PROCUREMENT_BUSINESS_NAVIGATION` from `packages/supply-chain/src/index.ts`.

- [x] **Step 4: Run focused tests**

Run the Step 2 command. Expected: PASS.

- [x] **Step 5: Record the verified checkpoint**

Append the exact test count to the alignment evidence document and check Task 2. No Git action.

---

### Task 3: Make the Console shell consume the exact IA and remove the developer sidebar entry

**Files:**
- Modify: `apps/console/app/page.tsx`
- Modify: `apps/console/test/app-shell-visual-boundary.test.ts`
- Modify: `apps/console/test/employee-packs.test.ts`
- Modify: `apps/console/features/procurement/navigation-state.ts`
- Test: `apps/console/features/procurement/navigation-state.test.ts`

**Interfaces:**
- Consumes: Task 2 pack manifest and existing `resolveEmployeePackSection` deep-link resolution.
- Produces: exact ten-entry sidebar, English procurement page titles, `readywork-procurement` shell detection, and preserved developer direct deep link without a visible business nav button.

- [x] **Step 1: Write failing shell tests**

Assert the rendered source path follows these boundaries:

```ts
assert.match(pageSource, /themeId === "readywork-procurement"/);
assert.doesNotMatch(pageSource, /activePack\?\.interfaces\.developer\.enabled && <div className="border-t/);
assert.doesNotMatch(pageSource, />流程图</);
assert.match(pageSource, /navigateToSection\("employees", \{ viewMode: "developer" \}\)/);
```

Update the pack navigation test to assert one group and ten items in order. Add a navigation-state test proving `?section=employees&view=developer` still resolves to the developer view while `?section=home` resolves to business.

- [x] **Step 2: Run tests and verify failure**

```bash
pnpm exec tsx --test apps/console/test/app-shell-visual-boundary.test.ts apps/console/test/employee-packs.test.ts apps/console/features/procurement/navigation-state.test.ts
```

Expected: FAIL because the current shell uses `navisight-procurement` and appends the Flow/Orchestration entry.

- [x] **Step 3: Update shell ownership and titles**

Rename local implementation variables from `navisightSection` to `procurementSection`. Use `activePack.branding.themeId === "readywork-procurement"`. Remove the developer button block under business navigation; keep `openWorkflowEditor` only for explicit platform/developer paths. Set the ten procurement entries' titles from the pack manifest instead of the legacy Chinese `sectionTitle` map.

- [x] **Step 4: Run focused and type verification**

```bash
pnpm exec tsx --test apps/console/test/app-shell-visual-boundary.test.ts apps/console/test/employee-packs.test.ts apps/console/features/procurement/navigation-state.test.ts
pnpm typecheck
pnpm --filter @readywork/app-console lint
```

Expected: all commands exit 0.

- [x] **Step 5: Browser-verify sidebar at the three desktop viewports**

Use the logged-in local Console. At 1280×720, 1440×900, and 1920×1080 assert ten visible sidebar buttons in exact order, no Flow/Developer item, no page-level horizontal overflow, and a directly entered developer deep link still opens for an authorized user. Do not execute workflow actions.

- [x] **Step 6: Record the verified checkpoint**

Record viewport dimensions, navigation labels, console error/warning count, and focused test counts in the evidence doc.

---

### Task 4: Remove production Navisight assets and copy from public, login, and legal surfaces

**Files:**
- Create: `apps/console/public/readywork/readywork-mark.svg`
- Create: `apps/console/features/marketing/readywork-product-visuals.tsx`
- Create: `apps/console/test/readywork-brand-boundary.test.ts`
- Modify: `apps/console/app/product/page.tsx`
- Modify: `apps/console/app/product/layout.tsx`
- Modify: `apps/console/app/privacy/page.tsx`
- Modify: `apps/console/app/terms/page.tsx`
- Modify: `apps/console/features/marketing/legal-page.tsx`
- Modify: `apps/console/app/product/demo-request-form.tsx`
- Modify: `apps/console/test/product-page-visual-boundary.test.ts`
- Modify: `apps/console/test/legal-pages-visual-boundary.test.ts`

**Interfaces:**
- Consumes: Readywork brand, public Demo request API, and the approved clean-room copy boundary.
- Produces: fully local self-owned marketing visuals with no reference-host network request and no fixed business metrics.

- [x] **Step 1: Write the production brand scanner test**

```ts
const productionFiles = [
  "../app/product/page.tsx",
  "../app/product/layout.tsx",
  "../app/privacy/page.tsx",
  "../app/terms/page.tsx",
  "../features/marketing/legal-page.tsx",
  "../../../packages/supply-chain/src/procurement-employee-pack.ts",
];
for (const relative of productionFiles) {
  const source = readFileSync(new URL(relative, import.meta.url), "utf8");
  assert.doesNotMatch(source, /navisight(?:\.ai)?/i, relative);
}
```

Also assert `readywork-mark.svg` exists, product metadata begins with `Readywork`, Demo idempotency keys begin with `readywork-demo:`, and public product media sources are relative `/readywork/` URLs or local React visuals.

- [x] **Step 2: Run brand tests and verify failure**

```bash
pnpm exec tsx --test apps/console/test/readywork-brand-boundary.test.ts apps/console/test/product-page-visual-boundary.test.ts apps/console/test/legal-pages-visual-boundary.test.ts
```

Expected: FAIL on remote `navisight.ai` assets, metadata, legal copy, logo, and Demo key prefix.

- [x] **Step 3: Create self-owned brand/visual components**

Create a simple vector Readywork mark using `#2563eb` and `#0f172a`. Create local React product visuals that show page geometry, labels, status shapes, and explicit `No persisted data`/`Evidence required` states without PO numbers, supplier names, currency values, KPI counts, or screenshots from another product.

The visual API is:

```ts
export type ReadyworkProductVisual =
  | "overview"
  | "notifications"
  | "drafted-emails"
  | "po-timeline"
  | "risk-dashboard"
  | "route-local"
  | "route-import";

export function ReadyworkProductVisual({ kind }: { kind: ReadyworkProductVisual }): React.JSX.Element;
```

- [x] **Step 4: Replace user-facing copy and metadata**

Use `Readywork Procurement Execution` consistently. Replace reference-company FAQ answers with Readywork facts: supervised execution, named identity gate, ERP optionality, draft approval, route evidence, connector receipts, and pre-release legal status. Remove claims about addresses, certifications, response times, fixed PO/KPI totals, or partnership.

- [x] **Step 5: Run focused tests and production build**

```bash
pnpm exec tsx --test apps/console/test/readywork-brand-boundary.test.ts apps/console/test/product-page-visual-boundary.test.ts apps/console/test/legal-pages-visual-boundary.test.ts apps/api/test/public-demo-requests.test.ts
pnpm --filter @readywork/app-console build
```

Expected: all pass; `rg -n -i 'navisight' apps/console/app apps/console/features/marketing packages/supply-chain/src` only finds zero production matches.

- [x] **Step 6: Browser-verify public routes**

Open `/product`, `/privacy`, and `/terms` at all three desktop viewports. Confirm no request to `navisight.ai`, no horizontal overflow, local assets render, Demo validation remains real, and no form is submitted during read-only verification.

- [x] **Step 7: Record the verified checkpoint**

Record tests, build, three routes/viewports, and network-domain scan in the evidence doc.

---

### Task 5: Align Notifications and make Drafted Emails recipient editing real

**Files:**
- Modify: `apps/api/src/procurement-message-drafts.ts`
- Modify: `apps/api/test/procurement-message-drafts.test.ts`
- Modify: `apps/console/features/procurement/message-drafts.tsx`
- Modify: `apps/console/test/message-drafts-visual-boundary.test.ts`
- Modify: `apps/console/features/procurement/notifications.tsx`
- Modify: `apps/console/test/notifications-read-boundary.test.ts`

**Interfaces:**
- Consumes: existing draft/outbox/receipt, named identity, notification, SSE, and audit services.
- Produces: `UpdateMessageDraftInput` with recipient plus honest queued/sent states; no new message table.

- [x] **Step 1: Add failing API tests for recipient editing**

Use this exact input contract:

```ts
type UpdateMessageDraftInput = {
  expectedVersion: number;
  recipient: string;
  subject: string;
  body: string;
  reason: string;
};
```

Cover normalized valid email, E.164 WhatsApp, invalid/placeholder recipient 422, unknown field 422, stale version 409, cross-tenant 404, and audit metadata containing only masked recipient plus SHA-256.

- [x] **Step 2: Run API tests and verify failure**

```bash
pnpm exec tsx --test apps/api/test/procurement-message-drafts.test.ts
```

Expected: FAIL because PATCH currently accepts only `expectedVersion`, `subject`, and `body`.

- [x] **Step 3: Implement channel-aware recipient normalization**

Add focused pure functions:

```ts
export function normalizeDraftRecipient(channel: "email" | "whatsapp", value: string): string;
export function maskDraftRecipient(channel: "email" | "whatsapp", normalized: string): string;
export function hashDraftRecipient(normalized: string): string;
```

Reject placeholder domains such as `example.com`, `example.org`, `invalid`, and local-only domains. Email stays lower-cased and trimmed; WhatsApp is normalized to E.164. Persist recipient with the same draft version transaction and do not allow channel/PO/supplier/identity changes.

- [x] **Step 4: Update the double-column editor and status copy**

Add To, Subject, Body, and edit reason fields. Keep Pending/All, 340–380px queue, and Approve & Send/Edit/Discard. Map Outbox states to `Queued`, `Waiting for connector receipt`, `Sent`, `Failed`, and `Needs attention`; only the successful receipt maps to Sent.

- [x] **Step 5: Verify API, Console, and browser states**

```bash
pnpm exec tsx --test apps/api/test/procurement-message-drafts.test.ts apps/api/test/procurement-notifications.test.ts apps/console/test/message-drafts-visual-boundary.test.ts apps/console/test/notifications-read-boundary.test.ts
pnpm typecheck
pnpm --filter @readywork/app-console lint
```

Use an isolated draft fixture to verify normal, empty, 403, 409, connector-not-ready, queued, failed, and receipt-success states. Do not send through formal credentials.

- [x] **Step 6: Record the verified checkpoint**

Record exact state evidence and confirm formal Outbox counts are unchanged.

---

### Task 6: Fix Local/Import table contracts and add authoritative route exports

**Files:**
- Create: `apps/api/src/procurement-route-exports.ts`
- Create: `apps/api/test/procurement-route-exports.test.ts`
- Create: `packages/persistence/test/procurement-clean-room-v2-migration.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `packages/persistence/test/procurement-route-exports.test.ts`
- Modify: `apps/console/features/procurement/route-workbench.tsx`
- Modify: `apps/console/test/route-workbench-visual-boundary.test.ts`

**Interfaces:**
- Consumes: migration 48, route workbench filters, object storage, current tenant/route portfolio, idempotency, and audit.
- Produces: additive migration 49 (`navisight-clean-room-alignment-v2`), `POST /api/procurement/routes/:route/exports`, and an authorized download endpoint backed by `procurement_route_exports`.

- [x] **Step 1: Write persistence/API tests**

```ts
type RouteExportRequest = {
  query: string;
  stages: string[];
  risks: Array<"high" | "medium" | "low">;
  supplierIds: string[];
  rihdFrom: string | null;
  rihdTo: string | null;
  sort: "rihd_asc" | "risk_desc" | "po_number_asc";
};
```

Assert route enum, tenant isolation, same filter normalization as the list, stable waterline, RFC 4180 quoting, row count/hash, same-key replay, same-key different-body 409, and object-store failure rollback. In the migration test, cover a fresh DB, a recorded migration 48 DB, rerun, and two processes sharing a temp DB. Assert the exact migration name, no seed rows, supplier profile/event tables, PO amendment table, document snapshot metadata, route exports, Advanced SLA `schema_version`, import-validation columns, and their CHECK constraints.

- [x] **Step 2: Run tests and verify failure**

```bash
pnpm exec tsx --test packages/persistence/test/procurement-clean-room-v2-migration.test.ts packages/persistence/test/procurement-route-exports.test.ts apps/api/test/procurement-route-exports.test.ts apps/api/test/procurement-routes.test.ts
```

Expected: FAIL because migration 49 and the export service/repository/routes do not exist.

- [x] **Step 3: Add migration 49, the export repository, and API**

Implement migration 49 with `BEGIN IMMEDIATE` and rechecked version semantics. Add every schema contract in spec §11.2 in one atomic additive migration: supplier profile/events, PO amendments, document snapshot metadata, route exports, Risk V2 JSON compatibility, Advanced SLA `schema_version`, and import validation metadata. Do not backfill guessed values or create sample rows. Then implement the route export repository/API using existing object storage. Expired objects may be deleted, but generation/download audit remains. The download route checks tenant and returns `Content-Type: text/csv; charset=utf-8` and a safe filename.

- [x] **Step 4: Replace browser CSV and freeze the ten table columns**

Render the logged-in reference contract exactly: PO Number, Supplier, Material Type, Current Stage, Required In-House Date (RIHD), Days to RIHD, Risk, Next Action, Total Value, and one visually blank accessible row-action column. Move transport/ETA/customs/documents/route evidence into existing PO detail or row disclosure. Keep Assistant and route-specific quick questions connected to real data.

- [x] **Step 5: Verify**

```bash
pnpm exec tsx --test packages/persistence/test/procurement-clean-room-v2-migration.test.ts packages/persistence/test/procurement-route-exports.test.ts apps/api/test/procurement-route-exports.test.ts apps/api/test/procurement-routes.test.ts apps/console/test/route-workbench-visual-boundary.test.ts apps/console/test/route-chat-desktop-boundary.test.ts
pnpm typecheck
pnpm --filter @readywork/app-console build
```

Browser-verify formal Local=0 and Import=0 remain honest and no export row is generated unless the user explicitly runs export in an isolated environment.

- [x] **Step 6: Record the verified checkpoint**

Record table columns, empty states, export hash test, and unchanged formal route counts.

---

### Task 7: Complete the six PO detail read contracts

**Files:**
- Modify: `apps/api/src/procurement-workbench.ts`
- Modify: `apps/api/test/procurement-workbench.test.ts`
- Modify: `apps/console/features/procurement/po-detail-view-model.ts`
- Modify: `apps/console/features/procurement/po-detail-view-model.test.ts`
- Modify: `apps/console/features/procurement/po-employee.tsx`
- Modify: `apps/console/test/po-employee-actions-visual-boundary.test.ts`

**Interfaces:**
- Consumes: same-tenant PO context, supplierId, lines, documents, events, communications, drafts, shipments, receipts, SLA and audit.
- Produces: complete Overview/Items/Supplier/Documents/History/Communication view model without invented zero/low/pending values.

- [ ] **Step 1: Write failing view-model/API assertions**

Define stable output types:

```ts
type PoItemRow = {
  id: string; description: string; category: string | null;
  orderedQuantity: number | null; confirmedQuantity: number | null;
  unit: string | null; unitPrice: Money | null; tax: Money | null;
  total: Money | null; shippedQuantity: number | null;
  receivedQuantity: number | null; status: string | null;
};
type PoDocumentKpis = { total: number; verified: number; pending: number; missing: number };
type PoCommunicationKpis = { total: number; inbound: number; outbound: number; pendingDrafts: number };
```

Assert supplier fields always come from `po.supplierId` within tenant. Test missing supplier, missing quantities, multi-currency lines, required-vs-present document missing count, normalized event types, communication ordering and related-thread non-mutating behavior.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
pnpm exec tsx --test apps/api/test/procurement-workbench.test.ts apps/console/features/procurement/po-detail-view-model.test.ts apps/console/features/procurement/po-detail-navigation.test.ts
```

Expected: FAIL on the new fields/KPIs.

- [ ] **Step 3: Extend the single PO context projection**

Add missing category/unit/tax/total/status, supplier operating fields when available, document requirement diff, event display type, communication KPIs and related thread summaries. Do not add a second detail endpoint or infer supplier identity from name/email.

- [ ] **Step 4: Render the six tabs with progressive evidence disclosure**

Keep the canonical order and keyboard roving focus. Use `—` for unknown. Keep wide tables internally scrollable and the page itself overflow-free. Related communication navigation may open threads/drafts but cannot invoke execution actions.

- [ ] **Step 5: Verify**

```bash
pnpm exec tsx --test apps/api/test/procurement-workbench.test.ts apps/console/features/procurement/po-detail-view-model.test.ts apps/console/features/procurement/po-detail-navigation.test.ts apps/console/test/po-employee-actions-visual-boundary.test.ts
pnpm typecheck
pnpm --filter @readywork/app-console lint
```

Browser-verify all six tabs at three viewports with normal, missing-evidence, read-error, 403, and stale-background-refresh states.

- [ ] **Step 6: Record the verified checkpoint**

Record PO IDs used for read-only verification and confirm no action endpoint was called.

---

### Task 8: Complete shared v2 contracts and repositories over migration 49

**Files:**
- Modify: `packages/persistence/src/index.ts`
- Create: `packages/persistence/test/procurement-clean-room-v2-repositories.test.ts`
- Create: `packages/core/src/procurement-supplier-profile.ts`
- Create: `packages/core/test/procurement-supplier-profile.test.ts`

**Interfaces:**
- Consumes: Task 6 migration 49 schema and existing procurement documents, snapshots, Advanced SLA profiles/import batches.
- Produces: typed tenant-scoped repositories for supplier profiles/events, PO amendments, and document snapshots, plus the shared supplier operating profile contract.

- [ ] **Step 1: Write repository and shared-contract tests**

Test supplier profile create/read/optimistic update/event append, PO amendment create/state transition/idempotent replay, and document snapshot metadata create/read. Assert tenant isolation, version conflicts, immutable event history, append-only amendment audit, and no business rows after migration alone. Test the exact `PostalAddress` and `SupplierOperatingProfile` validation contract from the spec.

- [ ] **Step 2: Run persistence tests and verify failure**

```bash
pnpm exec tsx --test packages/core/test/procurement-supplier-profile.test.ts packages/persistence/test/procurement-clean-room-v2-repositories.test.ts
```

Expected: FAIL because the shared contract and repositories do not exist.

- [ ] **Step 3: Add shared supplier profile contract**

Implement the exact `PostalAddress` and `SupplierOperatingProfile` types from the spec, with route/type/criticality/status enums, ISO date validation, non-negative lead time, and contract end ≥ start.

- [ ] **Step 4: Add tenant-scoped repositories over migration 49**

Add supplier profile/event, PO amendment, and document snapshot repository methods with tenant in every key. Use optimistic version update for mutable profiles and explicit legal state transitions for amendments; keep events and snapshots append-only. Do not backfill guessed supplier values. Existing Advanced SLA rows remain schema version 1.

- [ ] **Step 5: Verify migration**

```bash
pnpm exec tsx --test packages/core/test/procurement-supplier-profile.test.ts packages/persistence/test/procurement-clean-room-v2-migration.test.ts packages/persistence/test/procurement-clean-room-v2-repositories.test.ts packages/persistence/test/*.test.ts
pnpm typecheck
```

Expected: all pass. Run no migration command against `data/readywork.sqlite` in automated verification.

- [ ] **Step 6: Record the verified checkpoint**

Record temp database paths/counts and a read-only formal DB statement showing it remains at its pre-execution state until an explicitly scheduled deployment migration.

---

### Task 9: Implement Edit PO with source-aware amendment behavior

**Files:**
- Modify: `apps/api/src/procurement-execution.ts`
- Modify: `apps/api/test/procurement-execution.test.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `apps/console/features/procurement/po-employee.tsx`
- Modify: `apps/console/test/po-employee-actions-visual-boundary.test.ts`
- Modify: `apps/console/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `docs/THIRD-PARTY-LICENSES.md`

**Interfaces:**
- Consumes: migration 49 amendment repository, PO source/status/version, Odoo Outbox, route evidence service.
- Produces: `POST /api/procurement/execution/edit_po` and a 560px Edit PO dialog.

- [ ] **Step 1: Write failing execution tests**

```ts
type EditPurchaseOrderInput = {
  aggregateId: string;
  expectedVersion: number;
  patch: {
    supplierId?: string;
    requiredInHouseAt?: string;
    materialType?: "direct" | "indirect";
    contactId?: string | null;
    lines?: Array<{ id: string; itemCode: string; description: string; quantity: number; unit: string; unitPrice: number | null; taxRate: number | null }>;
  };
  reason: string;
};
```

Test same-tenant Readywork Draft atomic edit, Odoo/executing PO amendment+Outbox pending, readback success, readback mismatch unknown, stage/status/route/externalId rejection, supplier change after execution rejection, version conflict, idempotency replay and cross-tenant hiding.

- [ ] **Step 2: Run and verify failure**

```bash
pnpm exec tsx --test apps/api/test/procurement-execution.test.ts
```

- [ ] **Step 3: Implement the source-aware action**

Readywork Draft writes PO/lines/version/activity/audit atomically. Odoo or executing PO writes amendment and queues the existing Odoo Outbox; it does not change the local authoritative projection until successful readback. Route changes are absent from this patch and continue through route evidence APIs.

- [ ] **Step 4: Add the Edit dialog and its first consumed primitive**

Add `@radix-ui/react-dialog@1.1.23` to the Console manifest/lockfile and its license to the third-party ledger, then use it for the Edit dialog. Stage and Status are read-only. Supplier selector submits supplierId, never name/email. Preserve user fields on 409 and show current server version.

- [ ] **Step 5: Verify**

```bash
pnpm exec tsx --test apps/api/test/procurement-execution.test.ts apps/console/test/po-employee-actions-visual-boundary.test.ts
pnpm typecheck
pnpm --filter @readywork/app-console build
```

Use fake Odoo in isolated DB for pending/success/unknown. Do not call formal Odoo.

- [ ] **Step 6: Record the verified checkpoint**

Record source PO hash before/after and isolated amendment/Outbox IDs.

---

### Task 10: Implement deterministic PO PDF and Print snapshots

**Files:**
- Create: `apps/api/src/procurement-po-documents.ts`
- Create: `apps/api/test/procurement-po-documents.test.ts`
- Create: `apps/console/features/procurement/po-print-view.tsx`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/console/features/procurement/po-employee.tsx`
- Modify: `apps/api/package.json`
- Modify: `docs/THIRD-PARTY-LICENSES.md`

**Interfaces:**
- Consumes: one versioned PO context, object storage, document metadata, authorization and idempotency.
- Produces: `POST /api/procurement/purchase-orders/:id/document-snapshots`, authorized HTML/PDF reads, and shared download/print content hash.

- [ ] **Step 1: Write failing document tests**

```ts
type CreatePoDocumentSnapshotInput = {
  expectedVersion: number;
  purpose: "download" | "print";
};
type PoDocumentSnapshot = {
  id: string; purchaseOrderId: string; sourcePoVersion: number;
  contextWatermark: string; templateVersion: "po-document-v1";
  contentSha256: string; documentId: string; generatedAt: string;
};
```

Assert deterministic same-input content hash, tenant authorization, object-store rollback, stale version 409, same-key replay, different-key new immutable snapshot, and Print/PDF projection equality.

- [ ] **Step 2: Add exact PDF dependencies and ledger entries**

Add `@react-pdf/renderer` `4.9.0` to the server-side package that generates bytes. Add a redistribution-approved Noto Sans CJK subset under `apps/api/assets/fonts/` with SIL OFL 1.1 license text. Do not use remote fonts.

- [ ] **Step 3: Implement snapshot creation and authorized reads**

Generate from server PO context only. Commit object and metadata atomically with compensating object cleanup. Mark the document `system-generated snapshot`, include version/watermark/time, and never label it a signed original.

- [ ] **Step 4: Wire Download PDF and Print**

Download streams the authorized PDF. Print opens the authorized server HTML projection in a dedicated printable view; it never serializes the current browser DOM.

- [ ] **Step 5: Verify**

```bash
pnpm exec tsx --test apps/api/test/procurement-po-documents.test.ts apps/console/test/po-employee-actions-visual-boundary.test.ts
pnpm typecheck
pnpm --filter @readywork/app-console build
```

Open isolated snapshots at three viewports, verify hash metadata, then delete only the isolated test DB/object prefix.

- [ ] **Step 6: Record the verified checkpoint**

Record content hashes and exact dependency/license entries.

---

### Task 11: Implement additive Cancel PO with Odoo receipt/readback

**Files:**
- Modify: `apps/api/src/procurement-execution.ts`
- Modify: `apps/api/test/procurement-execution.test.ts`
- Modify: `packages/temporal-runtime/src/workflows.ts`
- Modify: `packages/temporal-runtime/test/procurement-workflows.test.ts`
- Modify: `apps/console/features/procurement/po-employee.tsx`

**Interfaces:**
- Consumes: amendment repository, action gateway, Outbox/Odoo resolver, PO execution facts and approval permissions.
- Produces: `POST /api/procurement/execution/cancel_po` with local final or Odoo pending/final/unknown outcomes.

- [ ] **Step 1: Write failing state-machine tests**

```ts
type CancelPurchaseOrderInput = {
  aggregateId: string;
  expectedVersion: number;
  reason: string;
};
type CancelPurchaseOrderResult = {
  requestId: string;
  status: "cancelled" | "pending_external" | "failed" | "unknown";
  purchaseOrderVersion: number;
  outboxId: string | null;
};
```

Cover local active cancellation, shipped/received/GRN/invoice blocks, dual permission, reason, tenant, version, replay, Odoo success+readback, rejection and network-unknown.

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm exec tsx --test apps/api/test/procurement-execution.test.ts packages/temporal-runtime/test/procurement-workflows.test.ts
```

- [ ] **Step 3: Implement additive events and workflow**

Never DELETE PO/lines/documents/history. Local eligible PO adds `purchase_order.cancelled`. Odoo PO stores request and queues one external action; only successful readback projects Cancelled. Unknown remains Needs attention and retains the same workflow/idempotency identity.

- [ ] **Step 4: Add danger dialog and honest states**

Use Radix Dialog with reason, consequences, blockers, Pending/Needs attention status, retry/reconcile under the same request, and preserved evidence.

- [ ] **Step 5: Verify**

Run focused API/Temporal/Console tests, typecheck and Console build. Use fake Odoo only; formal Odoo and formal PO facts remain untouched.

- [ ] **Step 6: Record the verified checkpoint**

Record isolated event chains and prove no DELETE statement or missing history.

---

### Task 12: Introduce RiskModelV2 and versioned immutable snapshots

**Files:**
- Create: `packages/core/src/procurement-risk-model-v2.ts`
- Create: `packages/core/test/procurement-risk-model-v2.test.ts`
- Modify: `apps/api/src/procurement-workbench.ts`
- Modify: `apps/api/src/procurement-risk-dashboard.ts`
- Modify: `apps/api/test/procurement-risk-dashboard.test.ts`
- Modify: `apps/console/features/procurement/risk-dashboard.tsx`
- Modify: `apps/console/features/procurement/risk-dashboard-view-model.ts`

**Interfaces:**
- Consumes: supplier performance, delay/RIHD, normalized PO value, supplier profile criticality, compliance/approval evidence.
- Produces: exact V2 components, evidence coverage, total/provisional scores, immutable model-versioned snapshots and Dashboard UI.

- [x] **Step 1: Write red unit tests for the exact formula**

```ts
assert.equal(calculateRiskModelV2({ S: 80, D: 60, V: 50, C: 40, A: 20 }).totalScore, 57);
```

Test weights 0.30/0.25/0.20/0.15/0.10, bands High≥70/Medium≥40, total only at coverage 1.00, provisional only at coverage≥0.70 with Delivery Delay, stale/missing exclusion, and no zero substitution.

- [x] **Step 2: Run and verify failure**

```bash
pnpm exec tsx --test packages/core/test/procurement-risk-model-v2.test.ts apps/api/test/procurement-risk-dashboard.test.ts
```

- [x] **Step 3: Implement pure model and evidence contract**

Use the exact `RiskComponent` and `RiskModelV2Result` types from the spec. Reject caller-provided weights. Freeze evidence references/version/observedAt and input watermarks.

- [x] **Step 4: Replace max-factor scoring and update snapshots/API**

Remove `Math.max(10, ...factors.map(score))` from the production portfolio risk score. Keep old snapshots readable by `modelVersion`; never rewrite them. All chart/table/export consumers read the same snapshot row.

- [x] **Step 5: Update Dashboard and verify**

Add exact model weights, coverage, Provisional/Not published, missing components and stable High/Medium/Low semantics. Run focused core/API/Console tests, typecheck, lint and build; browser-verify all state classes at three viewports.

- [x] **Step 6: Record the verified checkpoint**

Record formula vectors, snapshot JSON model version, and unchanged formal snapshot count unless the user explicitly creates one.

---

### Task 13: Add Supplier Operating Profile and full supplier actions

**Files:**
- Modify: `packages/persistence/src/index.ts`
- Modify: `apps/api/src/procurement-rfqs.ts`
- Modify: `apps/api/test/procurement-rfqs.test.ts`
- Modify: `apps/api/src/procurement-lead-times.ts`
- Modify: `apps/console/features/procurement/suppliers-workbench.tsx`
- Modify: `apps/console/features/procurement/material-lead-times-panel.tsx`
- Modify: `apps/console/test/suppliers-workbench-visual-boundary.test.ts`

**Interfaces:**
- Consumes: Task 8 profile contract/repository, Odoo master source, lead-time templates and supplierId associations.
- Produces: transactional Add, versioned Edit, Deactivate/Reactivate, exact main table, lead-time management and risk criticality input.

- [x] **Step 1: Write failing profile API tests**

Test Add with master+profile one transaction; Edit expectedVersion; route unclassified; country/type/material/lead time/criticality validation; Odoo authoritative field protection; deactivate/reactivate; cross-tenant; rollback; and PO association by supplierId only.

- [x] **Step 2: Run and verify failure**

```bash
pnpm exec tsx --test packages/core/test/procurement-supplier-profile.test.ts apps/api/test/procurement-rfqs.test.ts apps/api/test/procurement-lead-times.test.ts
```

- [x] **Step 3: Implement API/repository behavior**

Create/update master and profile in one transaction. Odoo fields use sync/change proposal; Readywork-only operating fields update locally. Deactivation is additive and preserves POs/events.

- [x] **Step 4: Align the supplier workbench**

Use Code, Supplier, Country, Route, Type, Material, Lead Time, Criticality, Status, Actions. Add More menu entries View details, Edit supplier, Manage lead times, View purchase orders, Deactivate/Reactivate. Use exact supplierId navigation.

- [ ] **Step 5: Verify**

Run focused persistence/API/Console tests, typecheck, lint/build, and isolated create-edit-refresh-deactivate-read flow. Formal supplier rows remain unchanged.

Source/API/persistence/DOM verification is complete. The remaining unchecked gate is real Google Chrome acceptance at all three desktop viewports; on 2026-09-03 Chrome was running and the extension/native-host diagnostics passed, but the browser instance was not available to the control channel after the single permitted reconnect attempt.

- [ ] **Step 6: Record the verified checkpoint**

Record isolated supplier/profile/event IDs and no formal DB change.

---

### Task 14: Simplify the base SLA directory without weakening governance

**Files:**
- Modify: `apps/console/features/procurement/sla-workbench.tsx`
- Modify: `apps/console/test/sla-workbench-visual-boundary.test.ts`
- Create: `apps/console/test/sla-workbench-interaction.test.tsx`
- Modify: `apps/api/src/procurement-sla.ts`
- Modify: `apps/api/test/procurement-sla.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing draft/publish/retire/evaluation/calendar/audit.
- Produces: seven-column directory, exact Add/Edit primary fields, Advanced options and folded governance.

- [x] **Step 1: Write failing visual/contract tests**

Assert columns Process/Stage, Description, SLA Target, Grace Period, Escalation After, Applies To, Status/Actions; exact empty copy `No SLA rules match your filters.`; main form fields in spec; and policy governance collapsed by default.

- [x] **Step 2: Run and verify failure**

```bash
pnpm exec tsx --test apps/api/test/procurement-sla.test.ts apps/console/test/sla-workbench-visual-boundary.test.ts
```

- [x] **Step 3: Normalize API view fields and update UI**

Keep existing stored rule fields; add a stable view adapter for days/hours and Applies To. Place calendar/risk/route/channel/follow-up interval under Advanced options. Keep configure+approve and expectedVersion unchanged.

- [ ] **Step 4: Verify**

Run SLA API/calendar/automation/Console tests, typecheck, build, and three-viewports states for empty, draft, published, 403, 409 and runtime disabled.

Source/API/persistence and rendered DOM verification pass. The user's real Chrome session also reloaded the isolated Draft v2 and confirmed the aligned directory with zero page-level horizontal overflow, zero application error/warn logs and zero visible alerts. Full three-viewport click/focus coverage for every listed state remains open because the Chrome extension control channel detached before that matrix could be completed; DOM interaction tests are not substituted for this browser gate.

- [x] **Step 5: Record the verified checkpoint**

Confirm no formal SLA publish/retire action occurred.

---

### Task 15: Upgrade Advanced SLA to schema v2 and typed per-domain CSV

**Files:**
- Modify: `packages/core/src/procurement-advanced-sla.ts`
- Modify: `apps/api/src/procurement-advanced-sla.ts`
- Modify: `apps/api/test/procurement-advanced-sla.test.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `apps/console/features/procurement/advanced-sla-editor-state.ts`
- Modify: `apps/console/features/procurement/advanced-sla-view-model.ts`
- Modify: `apps/console/features/procurement/advanced-sla-workbench.tsx`
- Modify: Advanced SLA Console tests and fixtures

**Interfaces:**
- Consumes: migration 49 schema version/import columns, current profile/version/runtime/kill switch and nine domain facts.
- Produces: `AdvancedSlaRuleV2Base`, nine discriminated parameter interfaces, per-domain flat templates, row validation, valid-row apply and standardized histories.

- [x] **Step 1: Write core red tests for v2 normalization**

Test all common metadata, exact domains/order, date range, priority, status, section/base/parameter domain equality, unknown fields, overlapping same-priority scope, dangling/self/cyclic dependencies, and v1 read-only upgrade preview.

- [x] **Step 2: Write API red tests for templates/imports**

For each domain, assert header columns contain input common metadata plus flat typed fields and no `scope_json`/`parameters_json`. Test total/valid/invalid/warning counts, row numbers/codes, valid-row-only apply, candidate graph conflict rollback, batch/profile/candidate version conflict and immutable history.

- [x] **Step 3: Run tests and verify failure**

```bash
pnpm exec tsx --test apps/api/test/procurement-advanced-sla.test.ts apps/console/features/procurement/advanced-sla-editor-state.test.ts apps/console/features/procurement/advanced-sla-view-model.test.ts apps/console/test/advanced-sla-desktop-boundary.test.ts
```

- [x] **Step 4: Implement shared Zod v2 schemas**

Add exact `zod` `4.5.4` to the owning shared package and license ledger. Define nine strict objects and one discriminated union. Generate form descriptors and CSV columns from the same schema metadata; server-generated actor/time/approval fields are not importable.

- [x] **Step 5: Implement API/persistence compatibility**

Keep v1 profiles readable. Opening v1 for edit produces an upgrade preview with explicit missing common fields; it cannot publish until valid v2. Apply one candidate transaction and preserve invalid rows/history.

- [x] **Step 6: Update the desktop workbench**

Keep nine left sections and four tabs. Add Template download, typed Add/Edit dialog, per-row Validation Results, standard Upload/Version History, and all runtime/auto-send/readiness controls. Remove JSON editing from the primary flow.

- [ ] **Step 7: Verify**

Run all Advanced SLA/API/automation/message draft/Outbox tests, root typecheck, Console lint/build, and three-viewports normal/empty/error/403/409/connector/kill-switch browser states using isolated profiles only.

Source, API, persistence, rendered-DOM interaction and the logged-in Chrome happy-path interaction loop are complete. The isolated browser flow covered all nine domain Add Rule dialogs, Payment Term LC conditional fields, editable Rule ID, save/reload persistence, View details, Deactivate, Delete cancel/confirm, direct Template download and a real Quality CSV file preview/apply/reload. Application-origin console errors and warnings were both zero. The external Chrome viewport override did not change the window dimensions, so the three generated captures are not accepted as three distinct viewport proofs and the full state/view matrix remains open.

- [x] **Step 8: Record the verified checkpoint**

Record nine-domain round-trip counts and prove formal profile/import/event counts are unchanged.

Checkpoint: Core/API/editor-state focused tests `26/26`, rendered-DOM interaction `1/1`, full repository `725/725`, TypeScript, targeted Console ESLint and Next.js 16.3.3 production build all pass. Browser writes used only `MEMORY=1` isolated APIs. Formal `data/readywork.sqlite` remained read-only with SHA-256 `b1904986a2281ba2c3a44a9c96b5d1c670530d04b14c2bb7e5607e911dd1d4ec` and maximum migration `48 | procurement-route-chat-attachments`; no formal profile, import or event was created, no SLA was published, and no Odoo, Email or WhatsApp side effect occurred.

---

### Task 16: Align Configuration conclusion-first cards and auto-send readiness

**Files:**
- Modify: `apps/api/src/procurement-configuration-connections.ts`
- Modify: `apps/api/test/procurement-configuration-connections.test.ts`
- Modify: `apps/console/features/procurement/configuration-workbench.tsx`
- Modify: `apps/console/features/procurement/channel-connections-view-model.ts`
- Modify: `apps/console/test/configuration-workbench-visual-boundary.test.ts`

**Interfaces:**
- Consumes: tenant preferences, connection summary, identity, Advanced SLA runtime/readiness, admin control plane.
- Produces: General Settings, Email/WhatsApp/WeChat Agent Setup, ERP Business Systems, precise auto-send blockers and folded Advanced Governance.

- [x] **Step 1: Write failing role/state tests**

Assert manager sees real redacted statuses and no admin children/requests; admin sees management actions. WhatsApp Cloud API is labeled Cloud API and never shows QR. Unconfigured WeChat is honest. Auto-send returns named blockers for permission, profile, identity, allowlists, target, connector and kill switch.

- [x] **Step 2: Run and verify failure**

```bash
pnpm exec tsx --test apps/api/test/procurement-configuration-connections.test.ts apps/console/test/configuration-workbench-visual-boundary.test.ts apps/console/test/channel-connections.test.ts
```

- [x] **Step 3: Extend the redacted readiness view**

Return only `id`, `connectionType`, `status`, `runtimeHealthy`, `credentialReady`, `externalVerified`, `credentialCount`, `lastTestedAt`, `healthMessage`, `permissions.manage`, and auto-send blockers. Never return credential IDs/fields/secrets to non-admins.

- [x] **Step 4: Update page hierarchy**

Render General Settings first, then Agent Setup Email/WhatsApp/WeChat, then ERP/Odoo Business Systems, Auto-send explanation/readiness, and collapsed Advanced Governance. No action that inevitably returns 403 is clickable.

- [ ] **Step 5: Verify**

Run preference/calendar/config/readiness/Console tests, typecheck/build, and three-role/three-viewport browser checks without testing or disconnecting formal connectors.

- [x] **Step 6: Record the verified checkpoint**

Record redaction keys and verify formal preference/credential/event counts unchanged.

Checkpoint: source/API/rendered-DOM and logged-in Chrome admin-path verification are complete. The configuration response exposes only `autoSend / connections / permissions`; each connection is limited to `id / connectionType / status / runtimeHealthy / credentialReady / externalVerified / credentialCount / lastTestedAt / healthMessage`. General Settings, three communication cards, separate Business Systems, seven auto-send gates and folded Advanced Governance render from real APIs. Focused configuration/readiness/calendar checks are `36/36`; full repository verification is `728/728` source tests plus `6/6` rendered-DOM interactions; TypeScript, targeted ESLint and Next.js 16.3.3 build pass. Chrome verified the reference and local hierarchy, disabled WeChat, Email management deep-link and Escape collapse. The external Chrome binding exposes no viewport capability, so three distinct viewport/role browser evidence remains open and Step 5 is intentionally not checked. Formal SQLite remained SHA-256 `b1904986a2281ba2c3a44a9c96b5d1c670530d04b14c2bb7e5607e911dd1d4ec`, migration `48|procurement-route-chat-attachments`, preferences `0`, credentials `2`, connector events `19`.

---

### Task 17: Integrate approved component wrappers without changing business truth

**Files:**
- Create: focused wrappers under `apps/console/components/ui/` for Dialog, DropdownMenu, Popover, Tooltip, DataTable, DateRange, CommandMenu
- Modify: `apps/console/package.json`, `pnpm-lock.yaml`, `docs/THIRD-PARTY-LICENSES.md`
- Create: component accessibility tests under `apps/console/test/`

**Interfaces:**
- Consumes: exact dependency versions and completed page contracts.
- Produces: reusable accessible wrappers; pages remain owners of API/state.

- [x] **Step 1: Add failing wrapper contract tests**

Assert stable exports, aria labels, focus trap/restore, Escape, roving focus, table empty/loading/error slots, and no success-state prop in UI primitives.

- [x] **Step 2: Add exact packages and ledger entries**

Add only packages actually consumed and not already introduced by Task 9: TanStack Table `8.21.3`, TanStack Virtual `3.14.10`, Radix Dropdown Menu `2.1.24`, Popover `1.1.23`, Tooltip `1.2.16`, Recharts `3.10.1`, react-day-picker `10.0.1`, date-fns `4.4.0`, cmdk `1.1.1`, DOMPurify `3.4.14`. Reuse Radix Dialog `1.1.23` from Task 9. Do not install MapLibre, Tiptap Pro, AG Grid Enterprise or browser `react-pdf` unless a completed page has a proven need.

- [x] **Step 3: Implement wrappers and migrate page-local primitives**

Wrappers receive view state and callbacks only. They never fetch, persist, infer permissions, or translate pending to success. Recharts is dynamically imported by the Risk route.

- [x] **Step 4: Verify**

Run component tests, all Console tests, typecheck, lint, build, license boundary and browser keyboard checks. Inspect the production bundle for unexpected duplicate chart/table libraries.

- [x] **Step 5: Record the verified checkpoint**

Record exact versions/licenses, bundle comparison and accessibility evidence.

---

### Task 18: Full release audit, formal-data protection, and visual acceptance

**Files:**
- Modify: `docs/NAVISIGHT-V1-ALIGNMENT.md`
- Modify: this plan checkboxes
- No production source change unless the audit exposes a concrete defect, in which case return to the owning task's red/green cycle.

**Interfaces:**
- Consumes: all previous slice outputs.
- Produces: requirement-by-requirement completion evidence for the approved spec; it does not automatically mark readiness gates satisfied.

- [x] **Step 1: Run brand and production-source scans**

```bash
rg -n -i 'navisight(?:\.ai)?' apps/console/app apps/console/features/marketing packages/supply-chain/src
rg -n -i 'TO[D]O|TB[D]|FIX[M]E|mock data|demo seed|fake success' apps/console/features/procurement apps/api/src packages/core/src packages/persistence/src
```

Expected: zero forbidden production brand/assets and zero introduced placeholders/fake paths. Internal evidence/test descriptions may retain clearly scoped reference names outside production sources.

- [x] **Step 2: Run the complete automated suite**

```bash
export PATH="/Users/etheralia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/etheralia/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:/usr/bin:/bin"
pnpm test
pnpm typecheck
pnpm --filter @readywork/app-console lint
pnpm --filter @readywork/app-console build
pnpm audit --prod
```

Expected: all tests pass, typecheck/lint/build exit 0, and audit findings are either zero or recorded with exact dependency, severity, exploitability and release disposition.

- [x] **Step 3: Read-only snapshot formal SQLite before browser QA**

Record integrity, migration version, PO/active/route/stage/SLA/security incident/supplier/profile/snapshot/Outbox counts and file hash/mtime. Do not run write endpoints against the formal database.

- [x] **Step 4: Browser-verify every page/state/view**

At 1280×720, 1440×900, and 1920×1080 verify ten exact navigation entries; Overview; Notifications; Drafted Emails; Local; Import; Risk Dashboard; Suppliers; SLA; Advanced SLA; Configuration; PO six tabs and five Actions; Product/Privacy/Terms. Cover normal, empty, loading, read error, 403, 404, 409, 422, connector-not-ready, external pending/unknown and kill switch using isolated runtime/state injection, not formal writes.

- [x] **Step 5: Re-run read-only formal SQLite snapshot**

Compare every count/hash/mtime-sensitive fact from Step 3. Any unexplained write fails acceptance and must be investigated before proceeding. Expected business counts are unchanged unless the user explicitly initiated a real action outside automated QA.

- [x] **Step 6: Audit every spec requirement against authoritative evidence**

Create a table in `docs/NAVISIGHT-V1-ALIGNMENT.md` with `Requirement`, `Evidence`, `Status`, `Remaining external gate`. Mark UI/engineering alignment complete only if each row has direct test/browser/API/SQLite evidence. Keep named identity, published formal SLA, security incidents, real Local PO and real five-stage/GRN readiness separate from engineering completion.

- [x] **Step 7: Record final checkpoint**

Check the final plan task only after all commands and evidence pass. Because there is no Git repository, report changed files and verification results rather than a commit hash.

Checkpoint: approved engineering scope is complete. Logged-in Chrome covers all ten business entries at 1280×720, 1440×900 and 1920×1080, Product/Privacy/Terms at all three viewports, PO tabs/actions from the owning task checkpoints, and fresh isolated states for normal, empty, loading, read error, 403, 404, 409, 422, connector-not-ready, pending external, unknown and kill switch. Repository source tests are `732/732`; rendered React interactions are `7/7`; TypeScript, Console ESLint and the Next.js 16.3.3 production build pass. `pnpm audit --prod` has one documented moderate ExcelJS→uuid advisory whose affected caller-buffer path is not used by ExcelJS 4.4.0. Formal SQLite remained read-only with integrity `ok`, SHA-256 `b1904986a2281ba2c3a44a9c96b5d1c670530d04b14c2bb7e5607e911dd1d4ec`, size `24854528`, mtime `2026-09-02T00:43:27+0800` and migration `48|procurement-route-chat-attachments`. Production rollout remains separately blocked by formal business facts and approvals; engineering completion does not waive those gates.
