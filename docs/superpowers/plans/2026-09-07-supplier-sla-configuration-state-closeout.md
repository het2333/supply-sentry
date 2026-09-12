# Supplier, Base SLA And Configuration State Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Suppliers, base SLA and Configuration source, permission, mutation, persistence, keyboard, error-state and three-viewport gaps without fabricating connector, policy or supplier facts.

**Architecture:** Keep the current supplier, SLA, tenant-preference and configuration-connection handlers as the only business sources. Extend read contracts only where the frontend cannot currently fail closed, fence every browser mutation synchronously, keep page-owned shells mounted while required reads are pending, isolate optional-source failures, and verify the three pages against real handlers backed by a migrated temporary SQLite database.

**Tech Stack:** Node 24.20.0, pnpm 11.7.0, TypeScript 6.0.3, React 19.2.8, Next.js 16.3.3, Radix Dialog 1.1.23, JSDOM, Playwright Chrome, SQLite `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-09-02-navisight-clean-room-alignment-design.md` §§2.3, 6.1–6.3, 9.8–9.11, 10–15, 18.

## Global Constraints

- The user approved scheme A and the written specification and requested no further approval prompts; execute inline and sequentially.
- All system UI is Chinese. Supplier names, contacts, material names, rule names/descriptions, connection health text, IDs, stable API enums and other business-source text remain unchanged.
- Required reads, optional reads, empty data, permission denial and dependency failure remain distinct. A failed source must never be rendered as an empty list, zero metric, disconnected connector or disabled policy.
- Missing read capabilities fail closed. Read-only users may inspect and navigate but must not see or trigger Add, Edit, Duplicate, Deactivate/Reactivate, Lead Time, Publish, Retire, Evaluate, Run Automation or connector-management writes they cannot perform.
- Every browser mutation is synchronously single-flight before the first `await`. Versioned writes preserve reviewed input on 409/422; uncertain transport outcomes require an authoritative read before retry and never show success.
- Supplier master/profile and lead-time writes, SLA policy/events/evaluations and tenant preferences must survive a completely fresh read after closing and reopening the temporary SQLite database.
- Browser writes run only against an automatically created temporary SQLite database and local in-memory connector snapshots. No verifier starts an Outbox, Email, WhatsApp, Odoo, document or Temporal worker.
- The workspace is not a Git repository. Use `apply_patch`, do not initialize Git/worktrees, and replace commit steps with evidence checkpoints.
- Every command uses Node 24.20.0 through `env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH"`.

---

### Task 1: Make supplier permissions and required/optional reads authoritative

**Files:**
- Modify: `apps/api/src/procurement-rfqs.ts`
- Modify: `apps/api/test/procurement-rfqs.test.ts`
- Modify: `apps/console/features/procurement/suppliers-workbench.tsx`
- Modify: `apps/console/test/suppliers-workbench-interaction.test.tsx`
- Modify: `apps/console/test/suppliers-workbench-visual-boundary.test.ts`

**Interfaces:**
- Consumes: `GET /api/procurement/suppliers`, optional `GET /api/procurement/supplier-performance`, optional `GET /api/po/lead-times`, and session capabilities.
- Produces: `SupplierDirectoryResponse { items, permissions: { read, configure } }`; a stable page shell for loading/401/403/503; honest optional-source warnings; and capability-gated supplier controls.

- [x] **Step 1: Write the failing API permission assertions**

Extend the supplier API test so manager, buyer and auditor list reads return the same tenant-scoped supplier facts plus literal permissions. Manager/admin returns `{ read: true, configure: true }`; buyer/auditor returns `{ read: true, configure: false }`; missing session remains 401 and a session without read remains 403. Assert no contacts, profile fields or supplier counts from another tenant leak into any response.

- [x] **Step 2: Run supplier API RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test --test-name-pattern='supplier.*permissions|供应商.*权限' apps/api/test/procurement-rfqs.test.ts
```

Expected: FAIL because the current supplier directory response contains only `items`.

- [x] **Step 3: Return explicit directory permissions**

In the authenticated GET branch return:

```ts
{
  items,
  permissions: {
    read: can(context.session, 'read'),
    configure: can(context.session, 'configure'),
  },
}
```

Do not infer permissions in the client from role labels, supplier data, source system or the presence of buttons.

- [x] **Step 4: Write failing required/optional source and role assertions**

Hold the supplier directory GET unresolved and assert the Chinese H1, description, Add-area placeholder, filters and eight-column table skeleton remain mounted without KPI zeroes or an empty-state message. Cover required directory 401/403/503, true empty, populated manager, populated read-only user, performance-only 503, lead-time-only 503 and both optional reads failing. Assert optional failure keeps real master rows with `—` only for genuinely missing optional evidence. Read-only and missing-permission payloads must have no Add, Edit, Deactivate/Reactivate or Manage Lead Times controls and emit no writes.

- [x] **Step 5: Implement the stable supplier shell and fail-closed controls**

Parse the required response as `SupplierDirectoryResponse`; retain the page-owned header/filter/table shell during the first read; render a loading row until the required directory settles; render empty copy only after a successful empty directory read; and preserve cached rows with a stale-data warning if a later directory refresh fails. Gate Add, inline Edit and every write menu item on `permissions.configure === true`; always retain View Details and View Purchase Orders. Do not pass a `manageSupplierId` request to the lead-time panel when configure permission is absent.

- [x] **Step 6: Run supplier read/permission GREEN**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test --test-name-pattern='supplier.*permissions|供应商.*权限' apps/api/test/procurement-rfqs.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-name-pattern='Supplier required and optional sources|Supplier workbench matches' test/suppliers-workbench-interaction.test.tsx
```

Expected: all selected tests PASS and read-only rendering produces zero POST/PATCH/DELETE requests.

---

### Task 2: Preserve supplier and material-lead-time mutations exactly once

**Files:**
- Modify: `apps/console/features/procurement/suppliers-workbench.tsx`
- Modify: `apps/console/features/procurement/material-lead-times-panel.tsx`
- Modify: `apps/console/test/suppliers-workbench-interaction.test.tsx`
- Modify: `apps/console/test/material-lead-times-panel-interaction.test.tsx`
- Modify only if a handler defect is proven by RED: `apps/api/src/procurement-rfqs.ts`, `apps/api/src/procurement-lead-times.ts`
- Modify only if a handler defect is proven by RED: `apps/api/test/procurement-rfqs.test.ts`, `apps/api/test/procurement-lead-times.test.ts`

**Interfaces:**
- Consumes: supplier POST/PATCH/status endpoints, lead-time POST/PATCH/DELETE endpoints, supplier/profile versions, lead-time version and current input.
- Produces: synchronous per-action mutation fences, preserved dialog data on 403/409/422/unknown outcomes, explicit refresh/review after conflict, and one persisted event per accepted intent.

- [x] **Step 1: Write failing same-turn duplicate assertions**

For Add Supplier, Edit Supplier, Deactivate/Reactivate, Add Lead Time, Edit Lead Time and Retire Lead Time, dispatch submit twice before React can commit state and hold the first request unresolved. Assert each intent produces exactly one write, the pending dialog cannot be dismissed through Escape/overlay/Cancel, and its submit control exposes `aria-busy=true` or equivalent observable pending state.

- [x] **Step 2: Run supplier mutation RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/suppliers-workbench-interaction.test.tsx test/material-lead-times-panel-interaction.test.tsx
```

Expected: FAIL because React state alone does not fence two submissions in the same event turn and lead-time 409 currently closes the reviewed editor.

- [x] **Step 3: Add synchronous mutation fences**

Add dedicated refs for supplier create/edit/status and lead-time save/retire. Set the relevant ref before the first asynchronous boundary, clear it only in `finally`, and check it together with state/capability/validation at the start of each handler. Keep unrelated read/navigation actions available. Supplier create retains its current idempotency key across transport-unknown outcomes and replaces it only after an authoritative success or a changed candidate.

- [x] **Step 4: Write failing conflict/input-preservation assertions**

Return real-shaped 403, 409 and 422 responses for every editor. Assert supplier code/name/contact/profile values, status reason, lead-time supplier/route/material/days/criticality/remarks/reason and the originating trigger remain available. On 409, assert no implicit reload discards reviewed values; instead show current version and one explicit `重新读取` path. On transport failure after dispatch, assert no success notice and no immediate resubmit until an authoritative read completes.

- [x] **Step 5: Implement honest mutation outcomes and focus restoration**

Keep dialogs open after 403/409/422. Change the lead-time 409 copy from “已重新读取” to an accurate retained-input message, store the conflict version where returned, and require explicit reload before resubmission. Use the existing Radix dialog close-autofocus contract to restore Add/Edit/More triggers only after the dialog really closes. Accepted writes may close, reload from the handler and show success only after the authoritative response.

- [x] **Step 6: Verify fresh reopen persistence**

Extend real-handler API tests to create/update/deactivate/reactivate one supplier profile and create/update/retire one lead-time rule in a temporary file database. Close the database, reopen it, and assert exact master/profile versions, statuses, event counts and tenant isolation. Do not add a new backend mechanism unless RED proves the existing transactional implementation fails.

- [x] **Step 7: Run supplier mutation GREEN**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-rfqs.test.ts apps/api/test/procurement-lead-times.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/suppliers-workbench-interaction.test.tsx test/material-lead-times-panel-interaction.test.tsx
```

Expected: all files PASS, rejected mutations persist nothing, accepted mutations persist exactly once, and the reopened database matches the final UI facts.

---

### Task 3: Close base SLA loading, authority, governance and mutation states

**Files:**
- Modify: `apps/console/features/procurement/sla-workbench.tsx`
- Modify: `apps/console/test/sla-workbench-interaction.test.tsx`
- Modify: `apps/console/test/sla-workbench-visual-boundary.test.ts`
- Modify only if real handler evidence finds a defect: `apps/api/src/procurement-sla.ts`, `apps/api/src/procurement-sla-automation.ts`
- Modify only if real handler evidence finds a defect: `apps/api/test/procurement-sla.test.ts`, `apps/api/test/procurement-sla-automation.test.ts`

**Interfaces:**
- Consumes: required `GET /api/procurement/sla`, optional `GET /api/procurement/sla/automation`, policy capabilities and versioned policy/evaluation endpoints.
- Produces: stable base-SLA shell, independent automation failure state, fail-closed directory actions, synchronous write fences, honest Draft/Published/Retired states and persistent policy/evaluation evidence.

- [x] **Step 1: Write failing loading and independent-source assertions**

Hold the required SLA GET unresolved and assert H1, purpose, filters and eight-column skeleton remain mounted with no fabricated zero metrics or “暂无规则” text. Cover required 401/403/503, true empty, draft-only, published-only, retired history, cached refresh 503 and an automation-only 503. An automation failure must leave the real base directory visible and show a separate automation warning only inside the governance layer.

- [x] **Step 2: Run base SLA loading RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-name-pattern='SLA stable shell|automation source failure' test/sla-workbench-interaction.test.tsx
```

Expected: FAIL because the first read currently replaces the entire page with a spinner and `Promise.all` lets the optional automation read fail the required directory.

- [x] **Step 3: Keep the SLA directory shell mounted and isolate automation**

Load required SLA and optional automation through `Promise.allSettled`. Treat required failure as the page error; retain `automationError` separately. Render the header/filter/table shell for loading and first failure, render empty copy only after a successful empty payload, and preserve cached directory data if refresh fails. Do not compute KPI zeroes until the required payload exists.

- [x] **Step 4: Write failing permission and keyboard assertions**

Render configure+approve+operate, configure-only, operate-only, read-only and missing-capability payloads. Assert Add/Edit/Duplicate/Delete require configure; Publish/Retire require configure+approve; Evaluate/Run Automation require operate; and absent flags expose no write. For More menus verify ArrowUp/ArrowDown/Home/End, Escape and return focus. For Add/Edit/Delete/Publish/Retire dialogs verify initial focus, Tab/Shift+Tab containment, Escape/close return focus and pending dismissal lock.

- [x] **Step 5: Gate every SLA action from the authoritative payload**

Never show an edit pencil or write-only More item when `permissions.configure !== true`. Render governance actions only for their exact capability combination. Missing permissions default false. Move fixed confirmation overlays to the installed Dialog primitive or provide the same verified focus containment/restore behavior without changing the measured widths and Chinese content.

- [x] **Step 6: Write failing same-turn and failure-state assertions**

For create draft, save editor, duplicate, delete, save draft, publish, evaluate, retire and run automation, dispatch twice in one event turn and assert one request. Cover 403, 404, 409, 422 and 503/transport-unknown where the endpoint contract applies. Preserve editor/draft input on 409/422, show current version, never publish/retire/evaluate locally, and require the subsequent handler read to establish the new state.

- [x] **Step 7: Implement SLA single-flight and conflict retention**

Use an in-flight ref keyed by action name or independent refs where actions may legitimately overlap. Set before `await`, clear in `finally`, and keep `busy` as the render state only. Keep draft/editor values after rejected writes; successful writes reload the authoritative root before success presentation. Do not create a policy, evaluation, event or automation run from client state.

- [x] **Step 8: Verify real-handler lifecycle and reopen**

Against a temporary file database cover empty→draft→edited→published→evaluated→replacement published→retired and an automation run that creates only allowed pending draft/Outbox facts. Close/reopen and assert exact policy versions/statuses, event/evaluation/run counts, prior published retirement, tenant isolation and zero external worker/network activity.

- [x] **Step 9: Run base SLA GREEN**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-sla.test.ts apps/api/test/procurement-sla-automation.test.ts apps/api/test/procurement-sla-calendar.test.ts apps/api/test/procurement-sla-working-days.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test test/sla-workbench-interaction.test.tsx
```

Expected: every test PASS with no duplicate policy, event, evaluation, automation run, draft or Outbox fact.

---

### Task 4: Make Configuration connection and auto-send states non-fabricating

**Files:**
- Modify: `apps/console/app/page.tsx`
- Modify: `apps/console/features/procurement/configuration-workbench.tsx`
- Modify: `apps/console/features/procurement/channel-connections-panel.tsx`
- Modify: `apps/console/features/procurement/channel-connections-view-model.ts`
- Modify: `apps/console/test/configuration-workbench-interaction.test.tsx`
- Modify: `apps/console/test/configuration-workbench-visual-boundary.test.ts`
- Modify only if a contract defect is proven: `apps/api/src/procurement-configuration-connections.ts`
- Modify only if a contract defect is proven: `apps/api/test/procurement-configuration-connections.test.ts`

**Interfaces:**
- Consumes: required tenant preferences; required configuration connection summary; four explicit connector identities; seven server-computed auto-send gates; manager/admin permissions; and real connector-control-plane callbacks.
- Produces: stable General Settings and Agent Setup shells, stale-response protection, honest read failures, exact Email/WhatsApp Cloud API/WeChat/ERP states and role-correct governance disclosure.

- [x] **Step 1: Write failing connection-load ordering and error assertions**

Start two connection-summary reads, resolve the newer read first, then resolve the older read and assert the newer version remains rendered. Cover first-load 401/403/503 and cached-refresh 503. On first failure, assert no fallback “未配置”, “7 项阻塞”, `0/3` external verification or zero credential count is rendered. On cached failure, retain the last successful four-card summary with a stale warning and no management writes.

- [x] **Step 2: Run Configuration read RED**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-name-pattern='Configuration connection read ordering|connection failure' test/configuration-workbench-interaction.test.tsx
```

Expected: FAIL because an older request can overwrite a newer response and an empty/error input currently synthesizes unavailable connector cards and seven blockers.

- [x] **Step 3: Add latest-read-wins and explicit source-state rendering**

Fence `loadConfigurationConnections` with an incrementing request generation or AbortController. Accept state only from the latest request. Keep cached summaries on refresh failure. In the connection panel, return a loading shell while loading, an alert-only source failure on first error, and cards only after an authoritative successful response. In auto-send and governance summaries, distinguish `loading`, `unavailable`, `blocked` and `ready`; never manufacture gates from `autoSend=null` after a failed read.

- [x] **Step 4: Write role, connector and auto-send matrix assertions**

Cover buyer, procurement manager and admin with Email/WhatsApp/ERP states `available`, `installed+unverified`, `installed+verified`, `disabled`, `failed`, runtime unhealthy and credential revoked. Assert WeChat is always a truthful non-actionable “暂不可用 / 未配置”; WhatsApp says `Meta WhatsApp Cloud API` and contains no QR/pairing path; ERP remains under Business Systems. Buyer/manager read redacted summaries but never load credential/catalog/admin counts; admin alone gets connector management. Exercise each of the seven gates blocked individually and all-ready, and assert the switch is disabled unless the server returns `ready=true`.

- [x] **Step 5: Keep connector management and auto-send navigation capability-bound**

Do not infer manageability from connector status. Ensure every communication switch and card action is disabled for non-admins, and admin callbacks route to the real credential/control-plane flow. Auto-send remains a read-only readiness control that navigates to the versioned SLA policy; it does not toggle client state or create an Outbox row. Preserve business-source health text with `data-preserve-language`.

- [x] **Step 6: Revalidate tenant-preference mutation states**

Run the existing first-load/read-only/save/reopen/same-tick/422/409/transport-unknown cases against the real tenant-preferences handler and temporary SQLite. Confirm successful PUT survives reopen, rejected writes do not change version, and connection/auto-send reads never mutate preferences or connector state.

- [x] **Step 7: Run Configuration GREEN**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-configuration-connections.test.ts apps/api/test/procurement-tenant-preferences.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test test/configuration-workbench-interaction.test.tsx
```

Expected: all tests PASS; first failures display no fabricated connector/readiness facts and non-admin connector writes remain zero.

---

### Task 5: Capture the joint isolated browser and persistence matrix

**Files:**
- Create: `artifacts/alignment-20260906/verify-supplier-sla-configuration-matrix.ts`
- Create: `artifacts/alignment-20260906/verification-supplier-sla-configuration-matrix-results.json`
- Create: `artifacts/alignment-20260906/supplier-sla-configuration-matrix/*.png`
- Modify only when browser evidence proves a defect: production/test files from Tasks 1–4.

**Interfaces:**
- Consumes: a migrated temporary SQLite database; real supplier, performance, lead-time, SLA, SLA-automation, tenant-preference and configuration-connection handlers; controlled in-memory connector summaries; Console at `127.0.0.1:3001`.
- Produces: per-page/per-viewport DOM, geometry, keyboard, request, persistence, screenshot and applicability evidence with production/external side-effect counters.

- [x] **Step 1: Build the handler-backed temporary proxy**

Seed distinct manager, buyer, auditor, denied and other-tenant identities; active/inactive manual and Odoo suppliers; optional performance evidence; active/retired lead-time rows; draft/published/retired SLA policies; evaluation/automation evidence; tenant preferences; Email/WhatsApp/ERP connection states and WeChat unavailability. Use the real handlers for every required read and mutation. Permit injected transport 503 only for named source-failure scenarios. Reject every non-GET request not explicitly allowlisted for the active scenario.

- [x] **Step 2: Cover Suppliers at three viewports**

At 1280×720, 1440×900 and 1920×1080 capture initial loading, required 401/403/503, true empty, populated manager, populated read-only, optional performance failure, optional lead-time failure, search/status filtering, pagination, details, linked PO navigation, Add/Edit 409/422/success, Deactivate/Reactivate, Lead Time Add/Edit/Retire and permission revocation. Assert eight reference columns, internal-only table scroll, stable business strings, role-correct actions, focus containment/restore, one write per intent and exact persisted versions/events.

- [x] **Step 3: Cover base SLA at three viewports**

Capture initial loading, required 401/403/503, true empty, draft-only, published, retired history, read-only, optional automation failure, filters/no-match, Add/Edit/Duplicate/Delete, 403/404/409/422, publish, evaluate, automation run, retire and mid-session permission revocation. Assert eight-column directory geometry, explicit Draft versus no-published status, no zero metrics before a required read, keyboard menus/dialogs, one write per intent and exact authoritative reloads.

- [x] **Step 4: Cover Configuration at three viewports**

Capture preference loading/error/read-only/edit/save/409/422/unknown/reopen; connection loading/401/403/503/cached-stale; manager redacted cards; admin management; every connector state; seven individually blocked auto-send gates; all-ready; advanced disclosure; Escape/focus return; and Email/WhatsApp/ERP navigation. Assert three communication cards plus separate ERP, no fake WeChat/QR flow, no fabricated zero on error, switch gating, source text preservation and no connector mutation outside explicit admin scenarios.

- [x] **Step 5: Assert persistence and side-effect boundaries**

Before and after compare suppliers, profiles, profile events, lead times, lead-time events, SLA policies/events/evaluations/automation runs, tenant preferences/events, Outbox and all non-target tenants. Close the database and perform fresh handler reads after reopen. Assert exact allowed deltas, production Business API mutation attempts 0, Email/WhatsApp/Odoo network requests 0, started workers 0 and temporary database deletion in `finally`.

- [x] **Step 6: Run the browser verifier**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx artifacts/alignment-20260906/verify-supplier-sla-configuration-matrix.ts
```

Expected: every declared scenario and viewport passes; page errors, unexpected console errors/warnings, unexpected failed responses, duplicate writes, production mutations and external requests are zero.

- [x] **Step 7: Visually inspect representative screenshots**

Inspect at minimum Suppliers loading1280/manager1920/auditor1440/optional-source-failure1440/Edit-409-1280/Lead-Time-422-1440; SLA loading1280/draft-only1440/published1920/automation-failure1440/read-only1280/publish-confirm1920/retire-confirm1280; Configuration connection-error1280/manager1440/admin1920/WhatsApp-attention1440/all-gates-ready1920/preference-409-1280. Reject clipping, overlap, English system labels, missing focus rings, fabricated zero/success, hidden actions or page-level horizontal overflow.

- [x] **Step 8: Record the matrix checkpoint**

Check Task 5 only when the result JSON contains exact scenario/viewports counts, applicability, request/status log, mutation allowlist, pre/post/reopen SQLite facts, screenshot/source hashes, visual-inspection list, temporary-path cleanup and all external/production zero counters.

---

### Task 6: Run release gates, freeze evidence and close the three-page slice

**Files:**
- Create: `artifacts/alignment-20260906/verification-supplier-sla-configuration-matrix-sha256.txt`
- Modify: `docs/ALIGNMENT-REVALIDATION-2026-09-06.md`
- Modify: `docs/superpowers/plans/2026-09-07-supplier-sla-configuration-state-closeout.md`

**Interfaces:**
- Consumes: Tasks 1–5 production/test/verifier files, result JSON and authoritative screenshots.
- Produces: verified SHA-256 manifest and a global ledger that closes Suppliers/base SLA/Configuration only while retaining PO six-tab/action combinations and latest Business API production rollout gaps.

- [x] **Step 1: Run focused tests**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/procurement-rfqs.test.ts apps/api/test/procurement-lead-times.test.ts apps/api/test/procurement-supplier-performance.test.ts apps/api/test/procurement-sla.test.ts apps/api/test/procurement-sla-calendar.test.ts apps/api/test/procurement-sla-working-days.test.ts apps/api/test/procurement-sla-automation.test.ts apps/api/test/procurement-configuration-connections.test.ts apps/api/test/procurement-tenant-preferences.test.ts
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/suppliers-workbench-interaction.test.tsx test/material-lead-times-panel-interaction.test.tsx test/sla-workbench-interaction.test.tsx test/configuration-workbench-interaction.test.tsx
```

Expected: every focused test passes without React warnings.

- [x] **Step 2: Run release gates sequentially**

```bash
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm typecheck
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec tsc --noEmit
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console exec eslint app/page.tsx features/procurement/suppliers-workbench.tsx features/procurement/material-lead-times-panel.tsx features/procurement/sla-workbench.tsx features/procurement/configuration-workbench.tsx features/procurement/channel-connections-panel.tsx features/procurement/channel-connections-view-model.ts test/suppliers-workbench-interaction.test.tsx test/material-lead-times-panel-interaction.test.tsx test/sla-workbench-interaction.test.tsx test/configuration-workbench-interaction.test.tsx
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm --dir apps/console build
env PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:$PATH" pnpm test
```

Expected: every command exits 0. Run sequentially so the browser/JSDOM matrices do not compete for CPU.

- [x] **Step 3: Freeze and verify hashes**

Hash every changed production/test/verifier file, the result JSON and every screenshot referenced by that result into `verification-supplier-sla-configuration-matrix-sha256.txt`, then run:

```bash
shasum -a 256 -c artifacts/alignment-20260906/verification-supplier-sla-configuration-matrix-sha256.txt
```

Expected: every listed object reports `OK`; unreferenced screenshots are excluded rather than presented as authority.

- [x] **Step 4: Update the ledger and close only this slice**

Append exact test totals, page/scenario/viewport counts, timestamp, expected-error applicability, optional-source isolation, role boundaries, persistence/reopen facts, screenshot inspection, hashes and safety counters to `docs/ALIGNMENT-REVALIDATION-2026-09-06.md`. Keep the full platform goal active until PO six-tab/five-action combinations and the latest Business API production deployment/runtime verification are also closed.

Checkpoint: focused API tests pass **47/47** and the four React page files pass **37/37**. The current handler-backed browser matrix passes **72 scenarios × 3 viewports = 216/216**, all 21 designated screenshots pass manual inspection, and every unexpected/error/external/production-write/worker safety counter is zero. Root and Console TypeScript, targeted ESLint, Next.js 16.3.3 production build and the serial full suite **778 + 1 + 223 = 1002/1002** all pass. The SHA-256 manifest verifies **250/250 OK**. Suppliers, base SLA and Configuration are closed; the platform ledger advances to **32/41 (78.0%)** while PO six-tab/five-action combinations and the latest Business API production rollout remain open.
