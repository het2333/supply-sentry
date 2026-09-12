# Risk Dashboard State And Density Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Risk Dashboard gap by matching the reference analytical-heading density, preserving the page skeleton during initial loading, enforcing the real snapshot-refresh permission in the API and UI, and capturing a reproducible isolated runtime state matrix.

**Architecture:** Keep `procurement_risk_snapshots` and `handleProcurementRiskDashboardRequest` as the only risk source. Add a read-only capability bit to the existing dashboard response, render every state from that response or an honest HTTP error, and use a Playwright proxy backed by migrated temporary SQLite plus the real handler for runtime evidence. The production Business API and formal SQLite remain untouched.

**Tech Stack:** Node 24.19+, pnpm 11.7.0, TypeScript 6.0.3, Next.js 16.3.3, React 19.2.8, Tailwind CSS 4.3.3, JSDOM, Playwright Chrome, SQLite `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-09-02-navisight-clean-room-alignment-design.md` §§2.3, 7.3–7.4, 9.7, 14, 15.2, 15.4–15.5.

## Global Constraints

- The user approved scheme A and the written specification and requested no more approval prompts; execute inline and sequentially.
- All system UI is Chinese. PO numbers, supplier names, material types, evidence and other business-source strings remain unchanged.
- Reference Risk Dashboard analytical section headings are exactly 15px and weight 600; the page title remains 26px and weight 700.
- Initial loading keeps the page header and stable skeleton, announces progress, does not flash an empty state, and does not create a snapshot.
- Snapshot refresh is a local persisted read-model mutation, not an external connector action. The UI may offer it only when the authoritative GET response says the current session can refresh.
- Every browser write is restricted to an automatically created temporary SQLite database. Production Business API, formal SQLite, Outbox, Odoo, Email, WhatsApp and connectors are not mutated.
- Risk Dashboard has no object-addressed 404, optimistic-concurrency 409, external pending/unknown, connector-readiness, or kill-switch action contract. The matrix must record these as not applicable with endpoint evidence, not fabricate UI states.
- The workspace is not a Git repository. Use `apply_patch`, do not initialize Git, and replace commit steps with evidence checkpoints.

---

### Task 1: Preserve the Risk Dashboard shell during initial loading

**Files:**
- Modify: `apps/console/test/risk-dashboard-interaction.test.tsx`
- Modify: `apps/console/features/procurement/risk-dashboard.tsx`

**Interfaces:**
- Consumes: existing `loading`, `data`, `readError`, header controls and `load()` lifecycle.
- Produces: `aria-label="风险看板加载中"`, `aria-busy="true"`, five KPI skeletons and three analytical-panel skeletons while the first GET is pending.

- [x] **Step 1: Write the failing component assertion**

Extend `risk initial loading and true empty snapshot stay distinct and never auto-create a snapshot` to assert that the unresolved first request still renders the `风险看板` H1, the date/filter/export header controls, one `[aria-label="风险看板加载中"][aria-busy="true"]`, five `[data-risk-loading-kpi]` nodes, three `[data-risk-loading-panel]` nodes, no table and no `所选日期范围内没有风险快照` text.

- [x] **Step 2: Run RED**

```bash
pnpm --dir apps/console exec tsx --test --test-name-pattern='risk initial loading' test/risk-dashboard-interaction.test.tsx
```

Expected: FAIL because the current early return removes the H1, header controls and loading skeleton.

- [x] **Step 3: Implement the stable loading shell**

Remove the initial `if (loading && !data) return ...` branch. Keep the existing page container and header mounted, disable filter/export while there is no dashboard payload, and render a dedicated loading section before the empty/snapshot branches. The section must contain the current Chinese progress copy and fixed skeleton counts from Step 1; it must not call `refreshSnapshot()` or construct business rows.

- [x] **Step 4: Run GREEN**

Run the Step 2 command and the complete `risk-dashboard-interaction.test.tsx`. Expected: all tests PASS with no React warnings.

- [x] **Step 5: Record the checkpoint**

Check Task 1 only after RED and GREEN outputs are both observed.

---

### Task 2: Expose and enforce snapshot-refresh permission end to end

**Files:**
- Modify: `apps/api/test/procurement-risk-dashboard.test.ts`
- Modify: `apps/api/src/procurement-risk-dashboard.ts`
- Modify: `apps/console/test/risk-dashboard-interaction.test.tsx`
- Modify: `apps/console/features/procurement/risk-dashboard.tsx`

**Interfaces:**
- Consumes: `can(session, 'operate')` and the existing dashboard GET/refresh POST.
- Produces: dashboard response field `capabilities: { refresh: boolean }`; empty/current/stale UI that renders snapshot creation/update controls only when `refresh` is true.

- [x] **Step 1: Write failing API assertions**

Add an `审计员` session with read-only permission. Assert dashboard GET returns `capabilities.refresh === true` for `采购专员` and `false` for `审计员`; assert auditor refresh POST remains 403 and does not change `procurement_risk_snapshots`.

- [x] **Step 2: Run API RED**

```bash
pnpm exec tsx --test --test-name-pattern='采购风险看板：快照持久化' apps/api/test/procurement-risk-dashboard.test.ts
```

Expected: FAIL because dashboard GET does not yet return `capabilities`.

- [x] **Step 3: Add the authoritative capability**

In the dashboard GET response add exactly:

```ts
capabilities: { refresh: can(session, 'operate') },
```

Do not infer this field in the browser and do not loosen the refresh POST authorization.

- [x] **Step 4: Run API GREEN**

Run the Step 2 command. Expected: PASS.

- [x] **Step 5: Write failing UI assertions**

Add `capabilities.refresh` to the test dashboard factory. Add a read-only empty-state case that sets it to `false`, expects no `创建首个快照` button, and expects Chinese guidance that a user with operation permission must create the snapshot. Add a permission-revocation case that loads with `refresh: true`, makes refresh POST return a real-shaped 403 response, and proves the immutable tables remain visible with no false success.

- [x] **Step 6: Run UI RED**

```bash
pnpm --dir apps/console exec tsx --test --test-name-pattern='risk read-only|risk refresh permission' test/risk-dashboard-interaction.test.tsx
```

Expected: FAIL because refresh controls currently ignore an authoritative capability and empty read-only guidance does not exist.

- [x] **Step 7: Enforce the capability in the component**

Extend `Dashboard` with `capabilities: { refresh: boolean }`. Hide create/update controls when false, render the read-only Chinese guidance in the empty state, and preserve the current snapshot when a refresh POST fails. Treat a missing field from a stale server as `false` so an undeployed backend cannot accidentally expose a write.

- [x] **Step 8: Run UI GREEN**

Run the complete risk component and API test files. Expected: PASS.

- [x] **Step 9: Record the checkpoint**

Check Task 2 only after the API and UI gates pass.

- [x] **Step 10: Localize validation field labels without changing enums**

Assert invalid `risk` and `route` requests retain HTTP 422 and the stable `INVALID_RISK_RANGE` code while their user-visible error text names “风险等级” and “采购路线”. Observe RED against the raw internal field labels, then update only those two messages and rerun the API test.

---

### Task 3: Match analytical heading density to the reference contract

**Files:**
- Modify: `apps/console/test/risk-dashboard-visual-boundary.test.ts`
- Modify: `apps/console/features/procurement/risk-dashboard.tsx`

**Interfaces:**
- Consumes: reference headings in `artifacts/alignment-20260906/reference-page-contracts.json` page `Risk Dashboard`.
- Produces: seven analytical H2 headings at 15px/600 while preserving the 26px/700 H1 and the existing 70px header-control anchor.

- [x] **Step 1: Write the failing density contract**

Add a source boundary assertion that the seven named analytical headings use a shared `RISK_ANALYTICAL_HEADING_CLASS` equal to `text-[15px] font-semibold text-[#242b38]`, and that the component contains no `text-[17px]` analytical heading class.

- [x] **Step 2: Run density RED**

```bash
pnpm exec tsx --test apps/console/test/risk-dashboard-visual-boundary.test.ts
```

Expected: FAIL on current `text-[17px] font-bold` headings.

- [x] **Step 3: Apply the shared heading token**

Define the exact constant next to the other Risk Dashboard visual constants and use it for 风险评分分布、风险构成、供应商风险、逾期未结订单账龄分布、受延期订单影响的产品、风险趋势 and 高风险采购订单. Do not change the H1 token.

- [x] **Step 4: Run density GREEN**

Run the Step 2 command and the complete risk interaction test. Expected: PASS.

- [x] **Step 5: Record the checkpoint**

Check Task 3 only after the computed-style browser assertions in Task 4 also report 15px/600.

---

### Task 4: Capture the isolated Risk Dashboard runtime matrix and freeze evidence

**Files:**
- Create: `artifacts/alignment-20260906/verify-risk-dashboard-matrix-round.ts`
- Create: `artifacts/alignment-20260906/verification-risk-dashboard-matrix-round-results.json`
- Create: `artifacts/alignment-20260906/verification-risk-dashboard-matrix-round-sha256.txt`
- Create: `artifacts/alignment-20260906/risk-dashboard-matrix-round/*.png`
- Modify: `docs/ALIGNMENT-REVALIDATION-2026-09-06.md`

**Interfaces:**
- Consumes: migrated temporary SQLite, `risk-dashboard-browser-fixture.ts`, real risk/preferences HTTP handlers and the current Console at `127.0.0.1:3001`.
- Produces: reproducible screenshots, network/state assertions, source hashes and an explicit applicability map for the Risk Dashboard.

- [x] **Step 1: Build the isolated verifier**

At 1280×720, 1440×900 and 1920×1080 capture and assert: initial loading shell; true empty operator; true empty read-only auditor; current V2 with published/provisional/unpublished rows; no-match filter; cached refresh read failure; initial 403; real 422 invalid-query response; stale `calendar_day_changed`; stale `configuration_changed`; stale `portfolio_facts_changed`; legacy snapshot; and refresh permission revoked after a successful read. Use the real handler for 401/403/422 and every persisted snapshot state. The only allowed POST writes snapshots into the temporary database.

For each normal render assert the seven analytical H2 computed styles are 15px/600, H1 is 26px/700, date/filter/export controls remain 36px high, document-level horizontal overflow is absent, and wide-table overflow stays contained. Assert filter/date Escape restores trigger focus and the filtered export query matches the visible filter.

- [x] **Step 2: Record applicability instead of fabricated states**

Write these entries into the result JSON:

```json
{
  "404": "not_applicable_collection_route_has_no_object_identifier",
  "409": "not_applicable_refresh_is_watermark_idempotent_without_expected_version",
  "connector_not_ready": "not_applicable_no_external_action",
  "external_pending_unknown": "not_applicable_no_external_action",
  "kill_switch": "not_applicable_snapshot_refresh_is_local_read_model_write"
}
```

- [x] **Step 3: Run focused source and browser gates**

```bash
pnpm exec tsx --test apps/api/test/procurement-risk-dashboard.test.ts apps/console/test/risk-dashboard-view-model.test.ts apps/console/test/risk-dashboard-visual-boundary.test.ts
pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/risk-dashboard-interaction.test.tsx
pnpm exec tsx artifacts/alignment-20260906/verify-risk-dashboard-matrix-round.ts
```

Expected: all tests and every browser state pass; page errors, console errors/warnings, unexpected failed reads, production business writes and isolated Outbox rows are zero.

- [x] **Step 4: Run release gates sequentially**

```bash
pnpm typecheck
pnpm --dir apps/console typecheck
pnpm --dir apps/console exec eslint features/procurement/risk-dashboard.tsx test/risk-dashboard-interaction.test.tsx test/risk-dashboard-visual-boundary.test.ts
pnpm --dir apps/console build
pnpm test
```

Expected: every command exits 0. Run sequentially to avoid the previously diagnosed CPU-contention timeouts.

- [x] **Step 5: Visually inspect representative screenshots**

Inspect at minimum: loading 1280, current V2 1920, empty auditor 1440, cached error 1920, each stale reason at one viewport, legacy 1440 and revoked refresh 1280. Reject clipping, overlap, page-level horizontal overflow, English system UI or misleading success.

- [x] **Step 6: Freeze hashes and update the ledger**

Hash the changed production/test/verifier files, result JSON and all screenshots; verify the SHA-256 manifest with `shasum -a 256 -c`. Append the exact counts, screenshots, timestamp, applicability map and remaining global-platform gaps to `docs/ALIGNMENT-REVALIDATION-2026-09-06.md`. Do not claim the entire platform is complete.

- [x] **Step 7: Close this slice**

Check Task 4 only when Steps 1–6 have direct evidence. The overall goal remains active until the other ten-page/PO combination matrices and production Business API rollout evidence are also closed.
