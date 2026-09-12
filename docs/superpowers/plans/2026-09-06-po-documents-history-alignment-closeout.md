# PO Documents / History Alignment Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining PO Documents regression and make History match the approved reference structure while projecting every persisted PO event source through the real workbench API.

**Architecture:** Keep the reference-facing UI deliberately small: Documents remains a seven-column table with a 340px detail column, and History exposes the reference `Filter` / `All Activity` controls as inert buttons. Extend the existing `procurement-po-history.ts` projector and the workbench context read path to normalize immutable stage, route, route-evidence, SLA, import-document, and quantity events without inventing facts or mutating production data.

**Tech Stack:** TypeScript, React 19, Next.js 16, Node 24 test runner, SQLite `node:sqlite`, Playwright-based local browser collectors.

**Spec:** `docs/ALIGNMENT-REVALIDATION-2026-09-06.md` and `artifacts/alignment-20260906/reference-po-contract.json`

## Global Constraints

- The workspace is not a Git repository; edit in place and do not initialize Git or create commits.
- Use `apply_patch` for source, test, verifier, and documentation edits.
- Use Node 24 from `/Users/etheralia/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`.
- All write-path verification must use a temporary isolated SQLite database; do not send email, approve orders, import production data, publish SLA, or mutate the production database.
- Preserve Readywork branding, API codes, versions, permissions, idempotency keys, business-language source text, and external-receipt gates.
- Chinese labels are system UI only; unknown business values remain byte-for-byte visible.
- Reference runtime behavior is authoritative for visible Documents / History structure.

---

### Task 1: Repair unknown Documents category rendering

**Files:**
- Modify: `apps/console/features/procurement/po-employee.tsx`
- Test: `apps/console/test/po-detail-reference-states-interaction.test.tsx`

**Interfaces:**
- Consumes: `documentCategoryLabel(value, fallback)` and the existing immutable-snapshot fixture.
- Produces: a non-empty category label that prefers a non-empty requirement label, then preserves the raw unknown category, then displays `—`.

- [x] **Step 1: Preserve the already-observed RED evidence**

Run:

```bash
pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/po-detail-reference-states-interaction.test.tsx
```

Expected: the immutable-snapshot test fails because `Custom Category` renders as an empty string.

- [x] **Step 2: Implement the minimal helper correction**

Change `documentCategoryLabel` so an empty fallback is treated as absent:

```ts
const fallbackLabel = asText(fallback, "");
return labels[key] ?? fallbackLabel || key || "—";
```

Use parentheses or separate statements so TypeScript does not mix `??` and `||` illegally.

- [x] **Step 3: Verify GREEN**

Run the exact command from Step 1. Expected: 20/20 pass with no warnings.

---

### Task 2: Add normalized History projectors for every persisted PO event source

**Files:**
- Modify: `apps/api/src/procurement-po-history.ts`
- Modify: `apps/api/test/procurement-po-history.test.ts`

**Interfaces:**
- Consumes: the existing three positional arrays plus an optional fourth `PoHistoryAdditionalSources` object containing `stageEvents`, `routeEvents`, `routeEvidenceEvents`, `slaEvents`, `importDocumentEvents`, and `quantityEvents`.
- Produces: `PoHistoryEvent[]` with stable `id`, stable `type`, Chinese `typeLabel` / `label`, original `actor` / `at` / `state` / `summary`, a precise `source`, and structured read-only `evidence` references.

- [x] **Step 1: Write a literal failing projector test**

Add one table-style test whose fixtures contain one row from each real SQLite table schema. Assert exact ordered values for:

```ts
{
  source: 'stage' | 'route' | 'route_evidence' | 'sla' | 'import_document' | 'quantity',
  type: string,
  typeLabel: string,
  actor: string | null,
  state: string | null,
  summary: string | null,
  evidence: Record<string, unknown> | null,
}
```

The expected literals must prove that stage `source_kind/source_id`, route evidence `document_id`, SLA `policy_id/rule_id`, import `import_document_id`, and quantity `po_line_id/source_system/source_event_id/dimension/delta` are retained. Include an unknown action and original business note so normalization cannot erase source text.

- [x] **Step 2: Run the focused test and verify RED**

```bash
pnpm exec tsx --test apps/api/test/procurement-po-history.test.ts
```

Expected: TypeScript/runtime failure because the fourth source argument and source kinds do not exist.

- [x] **Step 3: Implement one projector per source**

Add source-specific projection functions that parse JSON objects defensively, use immutable database identifiers and timestamps without truncation, map only known system codes to Chinese, retain unknown action codes, and expose evidence as data rather than interpolated claims. Extend `PoHistoryEventSource` and `PoHistoryEvent` without changing existing activity/outbox/amendment behavior.

- [x] **Step 4: Verify focused GREEN and legacy compatibility**

Run the command from Step 2. Expected: all existing and new tests pass.

---

### Task 3: Aggregate the new History sources through the real workbench context API

**Files:**
- Modify: `apps/api/src/procurement-workbench.ts`
- Modify: `apps/api/test/procurement-workbench.test.ts`

**Interfaces:**
- Consumes: tenant ID, authoritative PO ID, current PO line IDs, and the six persisted event tables.
- Produces: `poDetail.history.events` containing tenant-scoped normalized events from all nine sources via `buildPoHistoryEvents`.

- [x] **Step 1: Write the failing vertical integration test**

Extend the temporary-SQLite workbench suite to insert one event for the same PO into each of:

```text
procurement_po_stage_events
procurement_route_events
procurement_route_evidence_document_events
procurement_sla_evaluation_events
procurement_import_document_events
procurement_po_line_quantity_events
```

Insert a second tenant's rows with recognizable secret values. GET the existing signed workbench context route and assert exact source types, evidence references, chronological ordering, and absence of the other tenant's values.

- [x] **Step 2: Run the workbench test and verify RED**

```bash
pnpm exec tsx --test apps/api/test/procurement-workbench.test.ts
```

Expected: the new source events are absent from `poDetail.history.events`.

- [x] **Step 3: Add tenant- and PO-scoped read queries**

Query each event table only for the current tenant and PO. For quantity events, restrict by the current PO's persisted line IDs. Pass raw database rows to the fourth projector argument; do not generate synthetic events, summaries, actors, timestamps, or success states.

- [x] **Step 4: Verify vertical GREEN**

Run the command from Step 2 and the projector test from Task 2. Expected: all pass and the context GET remains read-only.

---

### Task 4: Align the History controls and event list to the reference runtime

**Files:**
- Modify: `apps/console/features/procurement/po-employee.tsx`
- Modify: `apps/console/test/po-detail-reference-states-interaction.test.tsx`
- Modify: `apps/console/test/po-employee-documents-history-interaction.test.tsx`

**Interfaces:**
- Consumes: authoritative `poDetail.history.events` and the existing main-column / 320px aside layout.
- Produces: reference-shaped `筛选` and `全部活动` buttons, no invented filter state, no request on activation, stable event rendering, and unchanged PO/stage aside.

- [x] **Step 1: Write failing DOM behavior assertions**

Assert that History contains two enabled buttons named `筛选` and `全部活动`, contains no `select`, and that mouse, Enter, and Space activation do not hide events, change pressed/expanded state, or issue a request. Assert that two events with the same raw ID but different sources both render without React key warnings.

- [x] **Step 2: Run the two focused DOM files and verify RED**

```bash
pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/po-detail-reference-states-interaction.test.tsx test/po-employee-documents-history-interaction.test.tsx
```

Expected: the current custom `<select>` and stateful filtering violate the reference behavior.

- [x] **Step 3: Implement the minimal reference controls**

Remove `historyFilter`, its reset effect, and `visibleAuditEvents`. Render the two reference buttons using the same 36px tool-button styling as Documents; keep them intentionally stateless. Render all authoritative events and use a composite React key from source and ID.

- [x] **Step 4: Verify DOM GREEN**

Run the command from Step 2. Expected: every Documents / History interaction test passes with no React warnings or network writes.

---

### Task 5: Revalidate Documents and History in three desktop viewports

**Files:**
- Modify: `artifacts/alignment-20260906/verify-documents-history-round.ts`
- Update: `artifacts/alignment-20260906/live-documents-history-round-results.json`
- Update: corresponding screenshots under `/tmp` or the existing artifact screenshot directory.

**Interfaces:**
- Consumes: current HTTP handler, migrated temporary SQLite fixture, and the reference contract.
- Produces: 1280×720, 1440×900, and 1920×1080 evidence for Documents seven-column table/detail behavior and History stateless buttons/full event feed.

- [x] **Step 1: Update stale collector assertions**

Replace every obsolete eight-column or `<select>` expectation with exact seven-column Documents headers, row/detail activation, stateless History controls, all persisted event source labels, no global overflow, and zero business writes.

- [x] **Step 2: Run the collector against isolated SQLite**

Use the collector's documented Node 24 command. Expected: all viewport/state cases pass, page errors are zero, unexpected console errors are zero, failed reads are zero, business writes are zero, and the isolated outbox remains zero.

- [x] **Step 3: Visually inspect representative screenshots**

Inspect Documents at 1280 and 1920 plus History at 1440. Reject clipped controls, page-level horizontal overflow, empty category cells, duplicated cards, hidden events, or English system UI.

---

### Task 6: Freeze the source and run final repository gates for this round

**Files:**
- Update: `docs/ALIGNMENT-REVALIDATION-2026-09-06.md`
- Update: `artifacts/alignment-20260906/verification-documents-history-round-results.json`
- Update: any stale source-hash manifest named by the verification document.

**Interfaces:**
- Consumes: frozen source, focused tests, three-viewport browser evidence.
- Produces: current hashes and command results that can be checked against the exact current files.

- [x] **Step 1: Run focused lint and both type checks**

```bash
pnpm typecheck
pnpm --dir apps/console exec tsc --noEmit
pnpm --dir apps/console exec eslint features/procurement/po-employee.tsx test/po-detail-reference-states-interaction.test.tsx test/po-employee-documents-history-interaction.test.tsx
```

Expected: exit 0 for each command.

- [x] **Step 2: Run the full registered test suite**

```bash
pnpm test
```

Expected: exit 0 with no failed, cancelled, or unregistered focused tests.

Actual: session 54979, exit 0; 771 + 1 + 174 = 946/946, failed 0, cancelled 0.

- [x] **Step 3: Run the production Console build**

```bash
pnpm --dir apps/console build
```

Expected: compilation, TypeScript, and static page generation all succeed.

Actual: session 66144, exit 0; compilation, TypeScript, and 6 static pages succeeded.

- [x] **Step 4: Recompute hashes after the final source edit**

Record SHA-256 values for every modified source, test, collector, result, and screenshot. Do not reuse hashes from a prior source round.

Actual: current hashes for 12 source/test/collector/result files and all 12 browser screenshots are recorded in `artifacts/alignment-20260906/verification-documents-history-round-results.json`.

- [x] **Step 5: Update the alignment ledger honestly**

Document the exact commands, pass counts, viewports, fixture isolation, zero-write evidence, visual inspection, and any scope still not proven. Do not infer full-platform 100% completion from this PO-only round.

Actual: ledger updated with 946/946, build/typecheck/lint evidence, three-viewports, isolated SQLite/Outbox=0, visual inspection, production API not restarted, and remaining full-platform matrix.
