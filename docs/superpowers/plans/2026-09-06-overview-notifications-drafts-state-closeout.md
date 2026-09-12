# Overview, Notifications And Drafted Emails State Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining loading, authorization and runtime-state gaps for Overview, Notifications and Drafted Emails with authoritative API capabilities and a reproducible three-viewport browser matrix.

**Architecture:** Keep the existing workbench, risk-dashboard, notification and message-draft handlers as the only business-data sources. Add read-only capability fields to notification and draft GET responses, consume those fields directly in the React pages, preserve stable page shells during loading, and drive browser acceptance through current handlers backed by an automatically created temporary SQLite database. Controlled transport failures may be injected by the verifier, but normal, empty, authorization, validation, conflict, connector and persisted-action states must come from the real handlers.

**Tech Stack:** Node 24.20.0, pnpm 11.7.0, TypeScript 6.0.3, Next.js 16.3.3, React 19.2.8, JSDOM, Playwright Chrome, SQLite `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-09-02-navisight-clean-room-alignment-design.md` §§2.3, 7.1, 9.1–9.2, 14, 15.1–15.5, 18.

## Global Constraints

- The user approved scheme A and the written specification and requested no further approval prompts; execute inline and sequentially.
- All system UI is Chinese. Purchase-order numbers, supplier names, recipients, subjects, bodies, tags and other business-source strings remain unchanged.
- Overview, Notifications and Drafted Emails retain the already measured reference header positions and desktop geometry.
- A read-only user may inspect and navigate but must not see or trigger unavailable write actions.
- Capability fields are authoritative server output. A missing capability from an undeployed backend defaults to false in the browser.
- Browser writes are allowed only against an automatically created temporary SQLite database. The verifier must not call the production Business API for a mutation.
- A connector-blocked message draft is a truthful durable Outbox state, not a successful send. No verifier delivers email or WhatsApp.
- The workspace is not a Git repository. Use `apply_patch`, do not initialize Git, and replace commit steps with evidence checkpoints.

---

### Task 1: Preserve the Overview page shell during first load and first-load failure

**Files:**
- Modify: `apps/console/test/home-dashboard-interaction.test.tsx`
- Modify: `apps/console/features/procurement/home-dashboard.tsx`

**Interfaces:**
- Consumes: the existing parallel GETs to `/api/procurement/workbench?limit=100` and `/api/procurement/risk-dashboard?from=...&to=...`.
- Produces: a stable `总览` page header, date control and content skeleton identified by `aria-label="总览加载中"` and `aria-busy="true"` while the first reads are pending.

- [x] **Step 1: Write failing loading and error assertions**

Add a dedicated test that holds both initial GET promises unresolved and asserts: the `总览` H1 remains visible; the date trigger remains visible and disabled; `[aria-label="总览加载中"][aria-busy="true"]` exists; six `[data-overview-loading-kpi]` and two `[data-overview-loading-panel]` nodes exist; no empty-table message or business row is fabricated. Reject both initial GETs with a Chinese 503-shaped error and assert the same shell remains with one `role="alert"`, no success copy and no business data.

- [x] **Step 2: Run RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-name-pattern='Overview initial loading' test/home-dashboard-interaction.test.tsx
```

Expected: FAIL because the current `if (loading && !portfolio)` early return removes the H1, date control and page-owned layout.

- [x] **Step 3: Implement the stable Overview shell**

Remove the early return. Keep the page container and header mounted, set the date trigger disabled while no portfolio exists, render the fixed skeleton before the populated branch, and render an honest empty portfolio only after a successful workbench response. A failed first load must show the alert plus the shell; it must not derive zero KPIs from missing data.

- [x] **Step 4: Run GREEN and the complete Overview interaction file**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test test/home-dashboard-interaction.test.tsx
```

Expected: all Overview tests PASS without React warnings.

- [x] **Step 5: Record the checkpoint**

Check Task 1 only after the test has demonstrated the old full-page spinner failure and the new stable shell passes.

---

### Task 2: Make Notification write reachability authoritative

**Files:**
- Modify: `apps/api/test/procurement-notifications.test.ts`
- Modify: `apps/api/src/procurement-notifications.ts`
- Modify: `apps/console/test/notifications-interaction.test.tsx`
- Modify: `apps/console/features/procurement/notifications.tsx`

**Interfaces:**
- Consumes: `can(session, 'operate')`, notification list GET, single-read POST and read-all POST.
- Produces: list field `capabilities: { markRead: boolean }`; UI that marks unread rows only when `markRead` is true and otherwise navigates without a mutation.

- [x] **Step 1: Write failing API capability assertions**

Extend the real notification handler test with a buyer and an auditor. Assert both GETs return the same tenant-scoped notification facts, buyer receives `capabilities.markRead === true`, auditor receives `false`, and auditor single-read/read-all POSTs return 403 without changing notification version, status or events.

- [x] **Step 2: Run API RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-notifications.test.ts
```

Expected: FAIL because the current list payload has no `capabilities` field.

- [x] **Step 3: Add the authoritative list capability**

Add exactly `capabilities: { markRead: can(session, 'operate') }` to every successful notification list payload, including refresh and read-all responses built from the list helper. Do not loosen POST authorization.

- [x] **Step 4: Write failing UI authorization assertions**

Update the existing list factory with the capability. Add an auditor case that asserts no `全部标为已读` action, clicking an unread PO notification emits no POST and still invokes `onNavigate('orders', objectId)`, and the unread count/status remains unchanged. Add a permission-revocation case that starts with `markRead: true`, returns a real-shaped 403 to the single-read POST, retains the authoritative unread item/count and renders no false read state.

- [x] **Step 5: Run UI RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-name-pattern='Notifications read-only|Notifications permission revocation' test/notifications-interaction.test.tsx
```

Expected: FAIL because the component currently always exposes the read-all action and always POSTs before navigation for an unread item.

- [x] **Step 6: Enforce `markRead` in the component**

Extend `NotificationList` with `capabilities`. Treat a missing field as false. Hide the read-all action for read-only sessions; for an unread item with `markRead: false`, navigate directly and retain unread state. When a POST is attempted and fails, retain the current list/counts and show the server error without claiming success.

- [x] **Step 7: Run API and UI GREEN**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-notifications.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test test/notifications-interaction.test.tsx
```

Expected: both files PASS and all write attempts remain explicit.

- [x] **Step 8: Record the checkpoint**

Check Task 2 only after API permission, UI reachability and mutation-preservation assertions all pass.

---

### Task 3: Separate Message Draft edit, discard and approval capabilities

**Files:**
- Modify: `apps/api/test/procurement-message-drafts.test.ts`
- Modify: `apps/api/src/procurement-message-drafts.ts`
- Modify: `apps/console/test/message-drafts-interaction.test.tsx`
- Modify: `apps/console/features/procurement/message-drafts.tsx`

**Interfaces:**
- Consumes: `can(session, 'operate')`, `can(session, 'approve')`, list/detail GET, PATCH, approve POST and discard POST.
- Produces: list/detail field `capabilities: { edit: boolean; discard: boolean; approve: boolean }`; action controls gated independently by the server response.

- [x] **Step 1: Write failing API capability assertions**

In the real message-draft API test assert: manager receives all three capabilities true; buyer receives edit/discard true and approve false; auditor receives all false. Verify the existing 403 responses remain for prohibited PATCH/approve/discard calls and that the draft row, events and Outbox do not change.

- [x] **Step 2: Run API RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-message-drafts.test.ts
```

Expected: FAIL because successful GET responses do not expose action capabilities.

- [x] **Step 3: Add capabilities to list and detail responses**

Return the same capability object from successful list and detail GETs. Do not infer approval from edit permission, do not change stable draft/Outbox enums, and do not weaken the POST/PATCH authorization checks.

- [x] **Step 4: Write failing UI role and revocation assertions**

Update test payloads with capabilities. Assert a buyer sees `编辑` and `丢弃` but not `批准并加入发送队列`; an auditor sees none of those write actions but can select/read a draft; a manager sees all three. Add a stale-capability case in which approve starts visible but the real-shaped POST returns 403, then assert the draft remains `draft`, no queued/sent notice appears, and the error is visible. Add an undeployed-response case with no capability field and assert fail-closed controls.

- [x] **Step 5: Run UI RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-name-pattern='Drafted Emails capabilities|Drafted Emails permission revocation' test/message-drafts-interaction.test.tsx
```

Expected: FAIL because all draft-status actions currently render from status alone.

- [x] **Step 6: Gate each control independently**

Store the authoritative capabilities from list/detail reads. Render approve only for `approve`, edit only for `edit`, discard only for `discard`, and default every missing bit to false. Preserve the selected draft and user input after 403/409/422; never convert `approved_queued` to sent without a connector receipt.

- [x] **Step 7: Run API and UI GREEN**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-message-drafts.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test test/message-drafts-interaction.test.tsx
```

Expected: both files PASS, including existing edit payload, version, idempotency and delivery-state assertions.

- [x] **Step 8: Record the checkpoint**

Check Task 3 only after every role and mid-session revocation has direct evidence.

Checkpoint: the API file passes 7/7 and the UI file passes 9/9. The UI RED failed for buyer, auditor and missing-capability responses because status-only rendering exposed write controls; GREEN now consumes list/detail capabilities independently, defaults absent bits to false, and retains the draft with authoritative 403 feedback when approval permission is revoked.

---

### Task 4: Capture the isolated three-page runtime matrix

**Files:**
- Create: `artifacts/alignment-20260906/verify-overview-notifications-drafts-matrix.ts`
- Create: `artifacts/alignment-20260906/verification-overview-notifications-drafts-matrix-results.json`
- Create: `artifacts/alignment-20260906/overview-notifications-drafts-matrix/*.png`
- Modify only if browser evidence finds a real defect: the production/test files from Tasks 1–3.

**Interfaces:**
- Consumes: migrated temporary SQLite; real workbench, risk-dashboard, tenant-preferences, notification and message-draft handlers; current Console at `127.0.0.1:3001`.
- Produces: per-scenario DOM, geometry, keyboard, request, persistence and screenshot evidence, plus an endpoint-specific applicability map.

- [x] **Step 1: Build the temporary-database proxy**

Create one temporary database with seeded business-source strings and distinct manager, buyer, auditor and denied sessions. Route every `/api/procurement/**` browser request through the current handler matching its path. The verifier may return controlled 503 only for named transport-failure scenarios; 401, 403, 404, 409 and 422 must be emitted by the real handlers. Record method/path/status/role for every request and reject any non-GET request that is not explicitly allowlisted for the current scenario.

- [x] **Step 2: Cover Overview at all three viewports**

At 1280×720, 1440×900 and 1920×1080 capture: first-load pending shell; populated portfolio; successful empty portfolio; first-load 401; first-load 403; controlled first-load 503; and a populated filter/date/pagination/PO-navigation interaction. Assert the 26px/700 H1, measured header anchor, no document overflow, six loading KPIs/two loading panels, no fabricated zero metrics during failure, filter/date Escape focus restoration and correct deep-link navigation. Record 404/409/422/connector/pending/unknown/kill-switch as not applicable because Overview is a read-only aggregate.

- [x] **Step 3: Cover Notifications at all three viewports**

Capture: pending load; populated manager; populated auditor; true empty all; true empty unread; initial 401; initial 403; controlled cached-read 503; successful single-read navigation; successful read-all; single-read 409 conflict; and permission revoked after read. Assert unread counts, filters, exact business text preservation, capability-controlled action visibility, no false read state after failure, keyboard focus visibility, target navigation and no document overflow. Record connector/pending/unknown/kill-switch as not applicable to notification read-state mutations.

- [x] **Step 4: Cover Drafted Emails at all three viewports**

Capture: pending load; all persisted delivery states (`draft`, queued pending, processing, blocked, failed, dispatched/sent, discarded); manager controls; buyer controls; auditor read-only; true empty ready; SLA-policy-missing CTA; communication-identity-missing CTA; initial 401; initial 403; detail 404; edit 422 with inputs retained; edit 409 with inputs retained; approve 403 after capability revocation; connector-blocked approval; connector-ready queued approval; and discard success. Assert exact role controls, status labels, original recipient/subject/body preservation, `expectedVersion`, non-empty idempotency key, no duplicate write while pending, no queued-as-sent claim, CTA navigation, no document overflow and correct focus behavior.

- [x] **Step 5: Assert data and side-effect boundaries**

Before and after the matrix compare temporary purchase-order/source summaries. Assert production Business API mutation attempts 0, temporary Outbox rows equal only the two explicitly approved temporary scenarios, no delivery worker is started, no Email/WhatsApp/Odoo network request occurs, and every mutation is tenant-scoped and visible through a subsequent real GET. Expected 401/403/404/409/422/503 responses must be enumerated separately from unexpected failed reads and console diagnostics.

- [x] **Step 6: Run the browser verifier**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx artifacts/alignment-20260906/verify-overview-notifications-drafts-matrix.ts
```

Expected: every declared page/state/viewport passes; page errors, unexpected console errors/warnings, unexpected failed reads, production mutations and external requests are zero.

- [x] **Step 7: Visually inspect representative screenshots**

Inspect at minimum Overview loading1280/populated1920/503-1440; Notifications manager1920/auditor1440/409-1280; Drafts all-states1920/auditor1440/edit-422-1280/edit-409-1440/connector-blocked1920. Reject clipping, overlap, English system UI, absent focus rings or misleading success.

- [x] **Step 8: Record the checkpoint**

Check Task 4 only when the result JSON contains exact scenario counts, viewports, applicability, request log, state assertions, screenshot hashes, source hashes and the visual-inspection list.

Checkpoint: the isolated HTTP/SQLite browser matrix generated at `2026-09-06T11:20:20.689Z` passes 36 scenario classes across 1280×720, 1440×900 and 1920×1080 for **108/108** checks. All 12 recorded source/verifier hashes and all 108 screenshot hashes still match the current files. Unexpected failed responses, page errors, console diagnostics, external requests, production Business API mutations and unexpected mutations are all 0; source purchase-order/document summaries are unchanged. The isolated Outbox contains only the explicitly approved connector-blocked `blocked` row and connector-ready queued `pending` row. Eleven required representative screenshots are recorded as visually inspected with no clipping, overlap, English system UI or misleading success.

---

### Task 5: Run release gates, freeze evidence and update the global ledger

**Files:**
- Create: `artifacts/alignment-20260906/verification-overview-notifications-drafts-matrix-sha256.txt`
- Modify: `docs/ALIGNMENT-REVALIDATION-2026-09-06.md`

**Interfaces:**
- Consumes: Tasks 1–4 production/test/verifier files, result JSON and screenshots.
- Produces: verified SHA-256 manifest and an honest global ledger that closes only these three page slices.

- [x] **Step 1: Run focused tests**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-notifications.test.ts apps/api/test/procurement-message-drafts.test.ts apps/console/test/home-dashboard-visual-boundary.test.ts apps/console/test/notifications-read-boundary.test.ts apps/console/test/message-drafts-visual-boundary.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/home-dashboard-interaction.test.tsx test/notifications-interaction.test.tsx test/message-drafts-interaction.test.tsx
```

Expected: all tests PASS.

- [x] **Step 2: Run release gates sequentially**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm typecheck
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsc --noEmit
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec eslint features/procurement/home-dashboard.tsx features/procurement/notifications.tsx features/procurement/message-drafts.tsx test/home-dashboard-interaction.test.tsx test/notifications-interaction.test.tsx test/message-drafts-interaction.test.tsx
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console build
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm test
```

Expected: every command exits 0. Run sequentially to avoid CPU-contention timeouts.

- [x] **Step 3: Freeze and verify hashes**

Hash all changed production/test/verifier files, the result JSON and every screenshot into `verification-overview-notifications-drafts-matrix-sha256.txt`, then run:

```bash
shasum -a 256 -c artifacts/alignment-20260906/verification-overview-notifications-drafts-matrix-sha256.txt
```

Expected: every listed object reports `OK`.

- [x] **Step 4: Update the ledger**

Append exact test counts, scenario/viewports, screenshot count, timestamp, expected-error map, visual inspection, source/data hashes and safety counters to `docs/ALIGNMENT-REVALIDATION-2026-09-06.md`. Mark Overview, Notifications and Drafted Emails state slices closed, but preserve the remaining Local/Import, Suppliers/SLA/Configuration, PO six-tab/action combination matrices and production Business API rollout gaps.

- [x] **Step 5: Close this slice**

Check Task 5 only after Steps 1–4 have current direct evidence. The full platform goal remains active until all other page/PO matrices and the production Business API rollout are verified.

Checkpoint: focused API/boundary tests pass 16/16 and Overview/Notifications/Drafted Emails React interaction tests pass 20/20. Root TypeScript, Console TypeScript, focused ESLint and the Console production build all exit 0. The serial full suite passes **773 + 1 + 185 = 959/959**. The SHA-256 manifest freezes 14 production/test/verifier files, the result JSON and all 108 screenshots, and `shasum -a 256 -c` reports **123/123 OK**. The global ledger now closes only Overview, Notifications and Drafted Emails while retaining every remaining full-platform matrix and production rollout gap.
