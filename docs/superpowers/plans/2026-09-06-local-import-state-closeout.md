# Local And Import State Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Local and Import source, permission, idempotency, keyboard, error-state and three-viewport runtime gaps without changing route identity or fabricating procurement facts.

**Architecture:** Keep `ProcurementRouteWorkbench` as the shared Local/Import screen and the current procurement workbench, route, route-chat, execution and route-export handlers as the only business sources. Add a forward-only route-assignment idempotency receipt, make every browser write synchronously single-flight, consume server permissions fail-closed, keep the page shell mounted during initial reads, and verify all mutations against migrated temporary SQLite through real HTTP handlers.

**Tech Stack:** Node 24.20.0, pnpm 11.7.0, TypeScript 6.0.3, React 19.2.8, Next.js 16.3.3, Radix Dialog 1.1.23, JSDOM, Playwright Chrome, SQLite `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-09-02-navisight-clean-room-alignment-design.md` §§2.3, 6.1–6.3, 7.3–7.4, 9.4, 10–15, 18.

## Global Constraints

- The user approved scheme A and the written specification and requested no further approval prompts; execute inline and sequentially.
- All system UI and generated CSV system labels are Chinese. PO numbers, supplier names, material names, messages, filenames, MIME values, IDs, stable API enums and business-source text remain unchanged.
- Local and Import remain the same component with stable route values `local` and `import`; sessions, filters, exports, attachments and mutations are tenant/route scoped.
- A read-only user can inspect and navigate but must not see or trigger unavailable writes. Missing permissions fail closed.
- Every retryable POST/DELETE uses a non-empty `Idempotency-Key`; same key plus same normalized payload replays one durable result, while the same key plus a different payload returns 409.
- Loading, empty, failed read, 401, 403, 404, 409, 422, connector blocked, external pending/unknown and kill-switch-like readiness states remain distinct and never produce fabricated success.
- Browser writes run only against an automatically created temporary SQLite database and local in-memory object storage. No verifier starts an Outbox, Email, WhatsApp, Odoo or document worker.
- The workspace is not a Git repository. Use `apply_patch`, do not initialize Git/worktrees, and replace commit steps with evidence checkpoints.
- Every command uses Node 24.20.0 through `env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH"`.

---

### Task 1: Make route assignment durably idempotent

**Files:**
- Modify: `packages/persistence/src/index.ts`
- Modify: `packages/persistence/test/persistence.test.ts`
- Modify: `apps/api/src/procurement-routes.ts`
- Modify: `apps/api/test/procurement-routes.test.ts`
- Modify: `apps/console/features/procurement/route-workbench.tsx`
- Modify: `apps/console/test/route-workbench-interaction.test.tsx`

**Interfaces:**
- Consumes: `POST /api/procurement/routes/:poId/assign`, `route`, normalized `evidence`, `expectedVersion`, and request `Idempotency-Key`.
- Produces: migration 52 table `procurement_route_assignment_idempotency(tenant_id,idempotency_key,payload_hash,response_json,created_at)`, response field `replayed: boolean`, and a browser key retained across uncertain outcomes for the unchanged assignment candidate.

- [x] **Step 1: Write failing persistence and API assertions**

Add migration assertions for the exact five columns and tenant-scoped primary key. Extend the route API test so a manager assignment with key `route-assign:one` returns `replayed: false`, an identical replay returns the same assignment and events with `replayed: true` and no extra route event, the same key with another route/evidence returns 409 `ROUTE_ASSIGNMENT_IDEMPOTENCY_CONFLICT`, missing key returns 422, and another tenant may independently reuse the same key. Force an exception after the assignment write and assert the assignment, event and idempotency receipt roll back together.

- [x] **Step 2: Run RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test packages/persistence/test/persistence.test.ts apps/api/test/procurement-routes.test.ts
```

Expected: FAIL because migration 52 and the assignment receipt do not exist and assignment currently accepts a missing `Idempotency-Key`.

- [x] **Step 3: Add the forward-only receipt and transactional replay**

Append migration 52 named `procurement-route-assignment-idempotency`. Normalize the request before hashing, compute a stable hash over `{ poId, route, evidence, expectedVersion }`, check an existing receipt before version validation, and recheck it inside the same `BEGIN IMMEDIATE` transaction that writes the assignment and event. Store the response without `replayed`, return `replayed: false` on first commit and `replayed: true` for an identical receipt. Map a changed-payload collision to HTTP 409 with code `ROUTE_ASSIGNMENT_IDEMPOTENCY_CONFLICT`; keep 401/403/404/409-version/422 behavior unchanged.

- [x] **Step 4: Write the failing browser-key assertions**

In the real React test, open route confirmation, submit twice in the same event turn and assert exactly one POST with a key matching `route-assignment:<poId>:`. Reject the first call with status 0/408-shaped uncertainty, assert the dialog and reviewed values remain, retry without changing values and assert the same key. Change route, evidence type, evidence reference or notes and assert the next request uses a new key.

- [x] **Step 5: Implement the assignment single-flight/key lifecycle**

Add `assignmentInFlightRef` and `assignmentIdempotencyKeyRef`. Set the ref before the first `await`; include the key in the assignment request; retain it after status 0, 408, 500 or 503; clear it after an authoritative success; and reset it whenever any field contributing to the payload changes. Keep the dialog open with its inputs after 403/409/422 and show the server message/current version without inventing persistence.

- [x] **Step 6: Run GREEN and record the checkpoint**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test packages/persistence/test/persistence.test.ts apps/api/test/procurement-routes.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-name-pattern='route assignment idempotency' test/route-workbench-interaction.test.tsx
```

Expected: all tests PASS; the temporary route assignment, one route event and one receipt survive reopen, and no duplicate write is observable.

---

### Task 2: Keep the Local/Import shell stable and action reachability authoritative

**Files:**
- Modify: `apps/console/features/procurement/route-workbench.tsx`
- Modify: `apps/console/features/procurement/route-workbench-controls.tsx`
- Modify: `apps/console/features/procurement/route-chat.tsx`
- Modify: `apps/console/test/route-workbench-interaction.test.tsx`
- Modify: `apps/console/test/route-workbench-visual-boundary.test.ts`

**Interfaces:**
- Consumes: workbench `permissions.operate`, `permissions.approve`, `permissions.configure`, per-row `actionReadiness`, and route-chat `permissions.operate`.
- Produces: stable first-load DOM identified by `aria-label="本地采购加载中|进口采购加载中"` and `aria-busy="true"`; `RouteOrderActionCapabilities`; read-only menus containing only `查看详情`; and no unavailable Export, sync, assignment, follow-up, RIHD or risk mutation.

- [x] **Step 1: Write failing loading/cached-error assertions**

Hold the first workbench GET unresolved for Local and Import. Assert the H1, description, stage tabs, assistant card outline, search/filters and ten-column table skeleton remain mounted; no `尚无已确认` empty copy, KPI zero or business row is fabricated. Resolve a first-load 503 and assert the same page-owned header plus one retryable alert. After a successful populated read, reject a realtime/refresh read and assert the existing rows remain with explicit `显示的是上次成功数据` and the prior `generatedAt` watermark.

- [x] **Step 2: Run loading RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-name-pattern='Local/Import stable shell' test/route-workbench-interaction.test.tsx
```

Expected: FAIL because the current first-load branch replaces the entire page with a centered spinner and cached refresh errors lack a stale-watermark explanation.

- [x] **Step 3: Implement the stable shared shell**

Remove the full-page loading early return. Keep the existing measured header and two-column geometry mounted. Render a fixed assistant skeleton plus ten-column row skeleton while `loading && !portfolio`, render the failure panel inside that shell when `error && !portfolio`, and render real empty copy only after a successful portfolio response. While cached data exists, leave rows and controls mounted, add `aria-busy` during refresh, and annotate failures with the last successful `portfolio.generatedAt`.

- [x] **Step 4: Write failing role/action assertions**

Render manager, buyer and auditor workbench payloads plus a payload with missing permissions. Assert: manager sees View, Follow-up, RIHD, Risk, Export, route confirmation and Odoo sync; buyer sees View, Follow-up, Risk and Export but not RIHD/route confirmation/sync; auditor and missing-permission responses see only View and cannot emit any POST. Route-chat read-only responses retain persisted history and navigation but expose no new conversation, quick-question, input, attachment, retry or send mutation. Replace the hard-coded `管理员，您好` greeting with role-neutral `您好`.

- [x] **Step 5: Add fail-closed action capabilities**

Define:

```ts
export type RouteOrderActionCapabilities = {
  followup: boolean;
  updateRihd: boolean;
  markAtRisk: boolean;
};
```

Pass it from the authoritative workbench permissions into `RouteOrderActionsMenu`; always render `查看详情`, render each write item only when its permission is true, and render the separator only with the risk item. Hide Export unless `operate === true`; keep route confirmation/Odoo sync/evidence governance behind `configure === true`. Treat every absent permission as false. In RouteChat, hide write-only quick questions/form/retry controls for read-only users while retaining the persisted conversation and honest read-only explanation.

- [x] **Step 6: Run GREEN and record the checkpoint**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test test/route-workbench-interaction.test.tsx
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/console/test/route-workbench-visual-boundary.test.ts
```

Expected: all route workbench interaction/boundary tests PASS with no React warning and no unauthorized fetch.

---

### Task 3: Make the authoritative route CSV entirely Chinese and retry-safe

**Files:**
- Modify: `apps/api/src/procurement-route-exports.ts`
- Modify: `apps/api/test/procurement-route-exports.test.ts`
- Modify: `apps/console/features/procurement/route-workbench.tsx`
- Modify: `apps/console/test/route-workbench-interaction.test.tsx`

**Interfaces:**
- Consumes: normalized route filters, `POST /api/procurement/routes/:route/exports`, and authenticated `GET /api/procurement/route-exports/:id/download`.
- Produces: UTF-8 BOM RFC 4180 CSV with the exact ten Chinese system headings, Chinese known risk/completion/action labels, unchanged business values, and one stable browser idempotency key per unchanged export request.

- [x] **Step 1: Write the failing CSV contract assertions**

Change the expected first row to:

```text
"\uFEFF采购订单号","供应商","物料类型","当前阶段","要求到货日期（RIHD）","距 RIHD 天数","风险","下一步操作","总金额","行操作"
```

Assert known risk values are `高/中/低`, inactive rows use `已完成`, and the system row action is `查看详情`. Keep assertions that `Alpha, "Quoted"\nSupplier`, formula-leading cells, material names, PO numbers, currencies and numeric precision survive unchanged and safely escaped.

- [x] **Step 2: Run API RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-route-exports.test.ts
```

Expected: FAIL on the current English header, risk, completed and row-action strings.

- [x] **Step 3: Translate only generated system values**

Replace the ten CSV headings and the `High/Medium/Low`, `Completed`, `View details` mappings with the exact Chinese strings above. Do not translate supplier names, material names, PO numbers, stage fallbacks or next-action business text; keep the BOM, CRLF, RFC 4180 quoting, spreadsheet-formula protection, source watermark and SHA-256 behavior unchanged.

- [x] **Step 4: Write failing browser single-flight/error assertions**

Double-click Export in one event turn and assert one POST. For status 0/408/503, assert the page retains filters, reports that the result is not confirmed and reuses the same key on retry. For 403/409/422, retain filters and authoritative error text without clicking a fake download. On success, assert exactly one authenticated download URL is activated and a subsequent changed-filter export uses a new key.

- [x] **Step 5: Implement the export key lifecycle**

Add `exportInFlightRef` and `exportIdempotencyKeyRef`. Fence before `await`, derive one normalized filter snapshot, retain the key only for uncertain outcomes with the same snapshot, clear it after success, and reset it whenever search/stage/risk/supplier/date changes. Never create a Blob or client-built CSV. Keep the success notice bound to the server row count and content hash.

- [x] **Step 6: Run GREEN and record the checkpoint**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-route-exports.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-name-pattern='route export' test/route-workbench-interaction.test.tsx
```

Expected: both files PASS, the downloaded bytes are Chinese-system/unchanged-business content, and duplicate browser writes remain 0.

---

### Task 4: Close dialog keyboard, duplicate-write and conflict preservation gaps

**Files:**
- Modify: `apps/console/features/procurement/route-workbench.tsx`
- Modify: `apps/console/features/procurement/route-workbench-controls.tsx`
- Modify: `apps/console/features/procurement/route-chat.tsx`
- Modify: `apps/console/test/route-workbench-interaction.test.tsx`
- Create: `apps/console/test/route-workbench-actions-interaction.test.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: row-action trigger, route-confirmation trigger, `queue_followup`, `update_rihd`, `mark_at_risk`, supplier sync, evidence upload/bind/revoke and attachment retry handlers.
- Produces: Radix-backed or equivalently verified modal focus containment, Escape/close restoration, pending dismissal lock, synchronous one-write gates, and preserved inputs on 403/409/422/uncertain outcomes.

- [x] **Step 1: Write failing modal focus tests**

For Follow-up, RIHD, Risk and Route Confirmation, open from mouse and keyboard, assert focus moves into the dialog, Tab and Shift+Tab wrap, Escape and Close restore the originating row/menu/confirmation button, and `aria-labelledby` resolves to the visible Chinese title. While a POST is unresolved, assert Escape, overlay/Close/Cancel and a second submit do not dismiss or emit another request.

- [x] **Step 2: Run focus RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test test/route-workbench-actions-interaction.test.tsx
```

Expected: FAIL because the four current fixed overlays do not trap initial/loop focus or restore their menu trigger.

- [x] **Step 3: Implement accessible controlled dialogs**

Use the installed Radix Dialog primitive, preserve the measured 620px/680px content widths and existing Chinese content, and store the originating stable trigger element before each menu/queue action. Prevent close while the corresponding synchronous in-flight ref is true. On close autofocus, restore the captured trigger even though the menu item itself unmounted. Do not change endpoint, payload, version, route or evidence contracts.

- [x] **Step 4: Write failing mutation-state tests**

For Follow-up, RIHD, Risk, supplier sync, evidence upload, bind, revoke and RouteChat attachment retry/message send, issue two same-turn submits and assert one request. Return real-shaped 403/409/422 and assert every reviewed field/file reference remains available, no success notice appears, and no PO stage/route/risk/RIHD is changed in the rendered authoritative rows. For RIHD, cover `blocked`, `pending`, `processing`, `dispatched`, definite `failed` and result-unknown error text; only `dispatched` after readback may update the displayed RIHD.

- [x] **Step 5: Add synchronous gates and honest state retention**

Use dedicated refs for independent actions so unrelated reads remain possible. Set a gate before the first asynchronous boundary and clear it in `finally`; preserve action-specific idempotency keys across only uncertain outcomes. Never clear dialog input merely because a request was attempted. On 403/409/422, show the server error/current version and require an authoritative refresh before another changed write. Preserve the existing Outbox states and do not map `pending`, `processing`, `blocked`, `failed` or unknown-result wording to success.

- [x] **Step 6: Register and run GREEN**

Add the new TSX file to the serial Console portion of root `pnpm test`, then run:

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/route-workbench-interaction.test.tsx test/route-workbench-actions-interaction.test.tsx
```

Expected: all tests PASS, every action is one-write-per-intent, and focus/inputs survive all declared failure states.

---

### Task 5: Capture the isolated Local/Import runtime matrix

**Files:**
- Create: `artifacts/alignment-20260906/verify-local-import-matrix.ts`
- Create: `artifacts/alignment-20260906/verification-local-import-matrix-results.json`
- Create: `artifacts/alignment-20260906/local-import-matrix/*.png`
- Modify only if browser evidence finds a real defect: production/test files from Tasks 1–4.

**Interfaces:**
- Consumes: a migrated temporary SQLite database; real workbench, route, route-evidence, route-chat, route-export and execution handlers; memory object storage; Console at `127.0.0.1:3001`.
- Produces: exact per-route/per-viewport DOM, geometry, keyboard, request, persistence, CSV, screenshot and applicability evidence with production/external side-effect counters.

- [x] **Step 1: Build the handler-backed temporary proxy**

Seed distinct manager, buyer, auditor and denied tenants with Local, Import and unclassified POs, persisted route chats, clean/pending/blocked attachments, a connector-blocked RIHD Outbox and no external worker. Route every relevant browser request through the current handlers. Controlled 503 is permitted only for named transport-failure scenarios; 401/403/404/409/422 and durable mutations must come from real handlers. Reject every non-GET request not allowlisted for the active scenario.

- [x] **Step 2: Cover shared read/filter/permission states at three viewports**

For both Local and Import at 1280×720, 1440×900 and 1920×1080 capture: initial loading shell, populated manager, populated buyer, populated auditor, true empty, filtered empty, initial 401, initial 403, initial 503 and cached-refresh 503. Assert the 26px/700 H1, measured header/tab/search anchors, exact ten table columns, internal-only table scroll, no page overflow, no fabricated zero during error, stable business strings, route isolation and role-correct action reachability.

- [x] **Step 3: Cover filters, pagination, assistant and export at three viewports**

For both routes cover stage/search/risk/supplier/date filters, reset, ten-row pagination, row and priority navigation, assistant expand/collapse/new/archived/read-only states, quick question single-send, AI pending, 403, 409 refresh, attachment pending/ready/blocked/retry and unsupported file. Cover Chinese CSV creation/download, replay, 403 revocation, 409 collision, 422 filter validation, 503 storage unavailable and uncertain-browser retry. Assert route/user conversation isolation, exact original messages/files/MIME, visible focus rings, Escape/Home/End behavior, one POST per intent and no client-built CSV.

- [x] **Step 4: Cover row actions and route evidence at three viewports**

Use the real handlers and temporary DB to cover: View; Follow-up ready, identity missing, 403/409/422 and persisted draft; RIHD readiness blocked, connector blocked, pending/processing, dispatched readback, definite failed and result unknown; manual Risk ready/already marked, 403/409/422 and persisted exception; Route Confirmation by clean contract/Incoterm/ERP/manual evidence, missing evidence, pending scan, quarantined file, 404, 409 version, 422 validation, permission revocation and identical replay; evidence upload/bind/revoke and import-to-local downgrade rejection. Assert dialog focus containment/restoration, pending dismissal locks, input preservation, authoritative reloads and unchanged stage/status unless the real handler contract changes them.

- [x] **Step 5: Assert data and side-effect boundaries**

Before and after the matrix compare source PO counts/versions/stages, route assignments/events, drafts, exceptions, Outbox, attachments/evidence and route exports per test tenant. Assert every expected mutation appears exactly once and survives a fresh handler read/reopen; all non-target tenants remain unchanged; production Business API mutation attempts, Email/WhatsApp/Odoo network requests and started workers are 0. Enumerate expected 401/403/404/409/410/422/500/503 separately from unexpected failed responses and console diagnostics.

- [x] **Step 6: Run the browser verifier**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx artifacts/alignment-20260906/verify-local-import-matrix.ts
```

Expected: every declared scenario/viewport passes; page errors, unexpected console errors/warnings, unexpected failed reads, duplicate writes, production mutations and external requests are zero.

- [x] **Step 7: Visually inspect representative screenshots**

Inspect at minimum Local loading1280/populated1920/auditor1440/cached-503-1440; Import empty1280/populated1920; assistant blocked-attachment1440/pending-answer1280; Chinese-export-success1920; Follow-up 409-1280; RIHD blocked1440/pending1920/unknown1280/dispatched1920; Risk 422-1440; route-confirm clean1920/pending-scan1280/409-1440 and revoke-result1920. Reject clipping, overlap, English system labels, missing focus rings, route leakage or misleading success.

- [x] **Step 8: Record the checkpoint**

Check Task 5 only when the result JSON contains exact scenario counts, viewports, applicability map, request/status log, mutation allowlist, before/after SQLite facts, CSV byte/hash assertions, screenshot/source hashes, visual-inspection list and all zero side-effect counters.

---

### Task 6: Run release gates, freeze evidence and update the global ledger

**Files:**
- Create: `artifacts/alignment-20260906/verification-local-import-matrix-sha256.txt`
- Modify: `docs/ALIGNMENT-REVALIDATION-2026-09-06.md`

**Interfaces:**
- Consumes: Tasks 1–5 production/test/verifier files, result JSON and screenshots.
- Produces: verified SHA-256 manifest and a ledger that closes only Local/Import while retaining Suppliers/Base SLA/Configuration, PO combination and production Business API rollout gaps.

- [x] **Step 1: Run focused tests**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test packages/persistence/test/persistence.test.ts apps/api/test/procurement-routes.test.ts apps/api/test/procurement-route-chat.test.ts apps/api/test/procurement-route-exports.test.ts apps/console/test/route-workbench-view-model.test.ts apps/console/test/route-workbench-visual-boundary.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/route-workbench-interaction.test.tsx test/route-workbench-actions-interaction.test.tsx
```

Expected: every focused test passes.

- [x] **Step 2: Run release gates sequentially**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm typecheck
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsc --noEmit
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec eslint features/procurement/route-workbench.tsx features/procurement/route-workbench-controls.tsx features/procurement/route-chat.tsx test/route-workbench-interaction.test.tsx test/route-workbench-actions-interaction.test.tsx
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console build
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm test
```

Expected: every command exits 0. Run sequentially so the known slow route/risk/supplier DOM tests do not compete for CPU.

- [x] **Step 3: Freeze and verify hashes**

Hash every changed production/test/verifier file, the result JSON and every matrix screenshot into `verification-local-import-matrix-sha256.txt`, then run:

```bash
shasum -a 256 -c artifacts/alignment-20260906/verification-local-import-matrix-sha256.txt
```

Expected: every listed object reports `OK`.

- [x] **Step 4: Update the ledger and close this slice**

Append exact test counts, route/scenario/viewport counts, timestamp, expected-error map, Chinese CSV proof, visual inspection, source/data hashes and safety counters to `docs/ALIGNMENT-REVALIDATION-2026-09-06.md`. Mark Local and Import closed only after Steps 1–3 have fresh direct evidence. Keep the full platform goal active until Suppliers/Base SLA/Configuration, PO six-tab/action combination matrices and the latest Business API production rollout are verified.
