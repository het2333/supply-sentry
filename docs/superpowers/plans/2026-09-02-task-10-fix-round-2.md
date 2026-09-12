# Task 10 Fix Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. The controlling task explicitly forbids subagent dispatch.

**Goal:** Replace the long-lived PO-document SQLite transaction with a durable fenced reservation workflow, repeat PDF table headers, and make Console focus restoration deterministic.

**Architecture:** Migration 49 gains an internal tenant-scoped request table that freezes the canonical projection and owns a short lease. API calls claim or take over that request in short synchronous transactions, perform rendering/object I/O/polling outside transactions, reconcile lost PUT acknowledgements through `HEAD`, and atomically append the final snapshot plus a fenced ready transition. Console focus moves in layout effects keyed to committed state rather than uncancelled animation-frame callbacks.

**Tech Stack:** TypeScript, Node 24 `node:sqlite`, `@react-pdf/renderer` 4.9.0, React 19, jsdom, Node test runner.

**Spec:** `.superpowers/sdd/2026-09-02-navisight-clean-room-alignment/progress.md` Task 10 rulings and `.superpowers/sdd/2026-09-02-navisight-clean-room-alignment/task-10-fix-round-1-open.md`.

## Global Constraints

- Do not dispatch subagents.
- Do not write the formal SQLite database or call formal Odoo/email systems; tests use temporary or in-memory stores only.
- Keep the public snapshot API and append-only snapshot rows unchanged.
- Keep eight visible columns: `# / CODE / DESCRIPTION / QTY / UOM / UNIT PRICE / AMOUNT / CCY`.
- Never hold a SQLite transaction across PDF rendering, object-store I/O, sleep, polling, hooks, or any other `await`.
- Use behavior-first RED→GREEN evidence for every finding and append exact output to the existing Task 10 report.

---

### Task 1: Add the reservation schema and typed repository boundary

**Files:**
- Modify: `packages/persistence/src/index.ts`
- Modify: `packages/persistence/test/procurement-clean-room-v2-migration.test.ts`
- Modify: `packages/persistence/test/procurement-clean-room-v2-repositories.test.ts`

**Interfaces:**
- Produces `ProcurementPurchaseOrderDocumentRequest` with immutable PO/version/fingerprint/projection/generated metadata and mutable `state`, `ownerToken`, `leaseVersion`, `leaseExpiresAt`, and error metadata.
- Produces typed create/get, conditional takeover, fenced ready, and fenced failed repository operations.

- [ ] Add migration tests requiring `procurement_purchase_order_document_requests`, its tenant/state/lease index, exact columns/checks, immutable-request trigger, and inclusion in migration-49 drift/fingerprint validation.
- [ ] Run the migration test and record RED because the table is absent.
- [ ] Add repository tests proving tenant isolation, immutable payload fields, conditional stale takeover, old-owner fencing, ready transition, and failed-claim release.
- [ ] Run the repository test and record RED because typed operations are absent.
- [ ] Add the table/index/trigger additively to the still-unapplied migration 49, update its manifest/fingerprint validation, and implement the typed operations with literal input validation.
- [ ] Run both persistence suites and record GREEN.

### Task 2: Specify failure-safe API reservation behavior

**Files:**
- Modify: `apps/api/test/procurement-po-documents.test.ts`
- Modify: `apps/api/test/fixtures/procurement-po-document-controller.ts`

**Interfaces:**
- Controller commands expose post-claim, PUT, and pre-finalize barriers plus deterministic lease durations and a durable-write/lost-ack storage mode.
- The API context exposes only test clock/duration hooks needed to prove transaction and lease boundaries.

- [ ] Add a 6.5-second same-key two-process test that expects `[200, 201]`, one final row, one intact object, and no SQLite busy-timeout failure.
- [ ] Add a lost PUT acknowledgement test whose storage durably writes and then throws; expect reconciliation through exact `HEAD`, one snapshot, and no delete.
- [ ] Add a same-connection test that commits a PO version-2 write while snapshot object I/O is pending, then forces snapshot failure and verifies the PO write survives.
- [ ] Add a same-process different-key test that holds both object puts concurrently and expects two `201` snapshots without shared rollback.
- [ ] Add a stale-lease two-process test in which owner 1 pauses after commit, owner 2 takes the expired lease and finalizes, and owner 1 is fenced to a `200` replay.
- [ ] Run only these tests against the old implementation and record their expected RED statuses/data-loss evidence.

### Task 3: Implement short-transaction claim, polling, reconciliation, and fencing

**Files:**
- Modify: `apps/api/src/procurement-po-documents.ts`
- Modify: `apps/api/src/attachment-object-storage.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/test/fixtures/procurement-po-document-controller.ts`

**Interfaces:**
- `claimSnapshotRequest` freezes canonical projection/generated time and commits before returning ownership or wait state.
- Reservation lease duration is greater than the configured object-store request timeout; polling happens outside transactions.
- Owners first `HEAD` the exact expected integrity, then PUT only if absent; a thrown PUT is reconciled with a second exact `HEAD`.
- `finalizeSnapshotRequest` inserts the append-only snapshot and marks the request ready in one short owner-token/lease-version-fenced transaction.

- [ ] Make projection loading synchronous and remove every async hook from transaction scope.
- [ ] Replace the long transaction/cleanup path with a claim-or-wait loop using a payload fingerprint and canonical stored projection.
- [ ] Render and perform `HEAD`/PUT outside transactions; on lost acknowledgement finalize only when exact hash/size/key/content-type metadata is proven.
- [ ] On missing object, mark the current lease failed and return storage failure; on uncertain ownership/integrity, do not delete and do not claim success.
- [ ] Fence final insert/ready and failure release by owner token plus lease version; a stale owner loops to the winner rather than mutating state.
- [ ] Run Task 2 tests and the existing API suite; record GREEN.

### Task 4: Repeat the eight-column PDF header on every page

**Files:**
- Modify: `apps/api/test/procurement-po-documents.test.ts`
- Modify: `apps/api/src/procurement-po-documents.ts`

**Interfaces:**
- PDF pages retain the existing eight headings and repeat the same header row on every wrapped page.

- [ ] Add 60+ literal line rows, render a PDF of at least three pages, extract each page independently, and require `UNIT PRICE`, `AMOUNT`, and `CCY` on every page.
- [ ] Run the multipage test and record RED `[true,false,false]` or equivalent missing-header evidence.
- [ ] Mark the PDF header row as a repeating fixed element without changing the eight-column definitions.
- [ ] Re-run the multipage and projection-parity tests and record GREEN.

### Task 5: Make menu/document focus a committed lifecycle effect

**Files:**
- Modify: `apps/console/features/procurement/po-employee.tsx`
- Modify: `apps/console/test/po-employee-edit-interaction.test.tsx`

**Interfaces:**
- Opening the menu focuses its first enabled item in a layout effect.
- Successful document generation focuses Actions after the menu is committed closed.
- Failed generation focuses the initiating menu item after it is committed enabled while the menu/error remain visible.

- [ ] Strengthen the interaction test so success and failure assertions use committed state and lightweight scalar identity diagnostics.
- [ ] Run independent jsdom processes against the current animation-frame implementation and record the focus RED.
- [ ] Replace uncancelled requestAnimationFrame focus callbacks with `useLayoutEffect` plus explicit focus-intent refs.
- [ ] Run ten independent jsdom processes and require all ten to pass.

### Task 6: Full verification and evidence ledger

**Files:**
- Modify: `.superpowers/sdd/2026-09-02-navisight-clean-room-alignment/task-10-report.md`

- [ ] Run focused API/source-boundary tests, migration tests, and repository tests on Node 24.
- [ ] Run the Console jsdom suite from `apps/console`.
- [ ] Run `pnpm typecheck` and `pnpm --filter @readywork/app-console build` on Node 24.
- [ ] Perform later Chrome focus acceptance if the local app can be exercised without formal writes; otherwise record it as the only deferred concern.
- [ ] Append exact RED/GREEN commands, output, changed files, and architectural concerns to the existing Task 10 report.
- [ ] Confirm no temporary DB, object, PDF, bundle, or diagnostic process remains.
