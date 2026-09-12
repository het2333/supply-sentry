# Top-level Runtime Geometry Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ten authenticated procurement pages use the reference runtime's observable desktop title and primary-control geometry while retaining Chinese system UI and authoritative Readywork business state.

**Architecture:** Keep the current single Console shell and real API paths. Correct page-owned header spacing and DOM order at the component source, then verify rendered coordinates against the frozen read-only reference contract; business-only panels such as unclassified orders stay truthful but may not displace the reference primary workbench.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS, Node test runner, JSDOM, Playwright, real local Business/Control API reads.

**Spec:** `docs/superpowers/specs/2026-09-02-navisight-clean-room-alignment-design.md`

## Global Constraints

- The user-approved Scheme A and later all-Chinese instruction are already authoritative; do not request another design approval.
- Preserve Readywork branding, system Chinese, business-source-language boundaries, tenant isolation, RBAC, versions, idempotency, audit, connector gates, and honest external outcomes.
- Reference access is read-only. Browser acceptance may read the local live platform, but must not send email, approve/cancel orders, publish SLA, connect channels, or import production data.
- Do not hide, delete, or fabricate unclassified orders to obtain visual similarity. Keep them visible and actionable after the route workbench.
- Width differences caused only by Chinese translations are not geometry failures; x/y/height, section order, table columns, focus, overflow, and click behavior are.
- The workspace is not a Git repository. Do not initialize Git or create a worktree.

---

### Task 1: Freeze current geometry and DOM-order failures

**Files:**
- Create: `artifacts/alignment-20260906/verify-top-level-geometry-round.ts`
- Modify: `apps/console/test/notifications-interaction.test.tsx`
- Modify: `apps/console/test/message-drafts-interaction.test.tsx`
- Modify: `apps/console/test/route-workbench-interaction.test.tsx`
- Modify: `apps/console/test/suppliers-workbench-visual-boundary.test.ts`
- Modify: `apps/console/test/sla-workbench-visual-boundary.test.ts`
- Modify: `apps/console/test/risk-dashboard-visual-boundary.test.ts`
- Modify: `apps/console/test/configuration-workbench-visual-boundary.test.ts`
- Modify: `apps/console/test/advanced-sla-desktop-boundary.test.ts`

**Interfaces:**
- Consumes: `reference-page-contracts.json`, the running Console at `http://127.0.0.1:3001`, and existing authenticated local API routes.
- Produces: a read-only Playwright verifier with explicit coordinate assertions and registered source/DOM regressions for component-owned geometry and route panel order.

- [x] **Step 1: Add the read-only browser verifier**

The verifier must authenticate through `/api/auth/login`, visit the ten canonical sections at 1832×1344, wait for stable DOM and fonts, and assert these reference anchors with ±1px y tolerance and ±1px height tolerance:

```ts
const anchors = {
  home: { titleY: 20 },
  notifications: { titleY: 34, primaryY: 148 },
  "message-drafts": { titleY: 34, primaryY: 148 },
  "local-procurement": { titleY: 12, primaryY: 143, searchY: 208 },
  "import-procurement": { titleY: 12, primaryY: 143, searchY: 208 },
  "risk-dashboard": { titleY: 70, primaryY: 70, primaryHeight: 36 },
  suppliers: { titleY: 34, primaryY: 181, actionY: 21 },
  sla: { titleY: 34, primaryY: 181, actionY: 21 },
  "advanced-sla": { titleY: 34, primaryY: 172, searchY: 258 },
  settings: { titleY: 34, primaryY: 284, actionY: 21 },
} as const;
```

It must additionally assert title x=276, 26px font, 700 weight, no document-level horizontal overflow at 1280×720, 1440×900, and 1920×1080, zero page errors, zero console errors/warnings, zero failed reads, and zero mutation attempts.

- [x] **Step 2: Add component-level failing assertions**

Add focused assertions that Notifications/Drafted Emails use the corrected title inset, Supplier uses `READYWORK_PAGE_TITLE_CLASS`, Settings places Save Changes in the reference top action row, and Local/Import render the primary assistant/table grid before the truthful unclassified-order panel.

- [x] **Step 3: Run RED**

Run the affected Node/JSDOM tests and the new Playwright verifier. Expected: failures show the current title deltas (+8, +12, -14, +14.5, +18), Settings action y=75.5 rather than 21, and Local/Import primary y≈472 rather than 143.

---

### Task 2: Correct page-owned header spacing and primary section order

**Files:**
- Modify: `apps/console/features/procurement/notifications.tsx`
- Modify: `apps/console/features/procurement/message-drafts.tsx`
- Modify: `apps/console/features/procurement/route-workbench.tsx`
- Modify: `apps/console/features/procurement/risk-dashboard.tsx`
- Modify: `apps/console/features/procurement/suppliers-workbench.tsx`
- Modify: `apps/console/features/procurement/sla-workbench.tsx`
- Modify: `apps/console/features/procurement/advanced-sla-workbench.tsx`
- Modify: `apps/console/features/procurement/configuration-workbench.tsx`

**Interfaces:**
- Consumes: the existing page data, action handlers, permissions, and component state without contract changes.
- Produces: the same API behavior and content with reference-aligned desktop geometry and unchanged Chinese/business-language boundaries.

- [x] **Step 1: Align stable list-page title baselines**

Adjust only component-owned header insets so Notifications and Drafted Emails render title y=34 without changing their 124.25px header boundary or filter y=148. Supplier and SLA must render the 26px shared page title at y=34, top action y=21, and filter/search y=181.

- [x] **Step 2: Restore Local/Import primary workbench geometry**

Move the unclassified-order panel after the assistant/table grid in DOM order and apply the route page's reference top offset. Preserve the exact unclassified rows, View Order actions, Confirm Route permissions, refresh behavior, business data, and API requests. Expected anchors: title y=12, route tabs y=143, search y=208.

- [x] **Step 3: Align Risk, Advanced SLA, and Configuration anchors**

Keep the real stale snapshot warning and empty Advanced SLA state, but align the page title and primary controls independently: Risk title/control y=70 with 36px header controls; Advanced SLA title y=34, first domain y=172, rule search y=258; Configuration title y=34, Save Changes y=21, country control y=284.

- [x] **Step 4: Run GREEN after each page group**

Run the focused tests and verifier after Steps 1–3. A page group is green only when its explicit anchors pass and no prior page regresses.

---

### Task 3: Verify interaction preservation and freeze evidence

**Files:**
- Create: `artifacts/alignment-20260906/verification-top-level-geometry-round-results.json`
- Update: `docs/ALIGNMENT-REVALIDATION-2026-09-06.md`
- Update: this plan.

**Interfaces:**
- Consumes: frozen source, focused RED/GREEN evidence, Playwright screenshots, and the full registered suite.
- Produces: exact current hashes, command results, viewport evidence, and an honest remaining-scope ledger.

- [x] **Step 1: Run focused interaction regressions**

Run Notifications, Drafted Emails, Route Workbench, Risk Dashboard, Suppliers, SLA, Advanced SLA, and Configuration interaction tests serially from `apps/console`. Require all existing click, Enter/Space, focus, Escape, permission, version, persistence, and no-fake-success assertions to pass.

- [x] **Step 2: Run type, lint, full suite, and production build gates**

Run `pnpm typecheck`, Console `tsc --noEmit`, scoped ESLint for every changed Console file/test, `pnpm test`, and `pnpm --dir apps/console build`. All commands must exit 0.

- [x] **Step 3: Re-run browser acceptance at three viewports**

Require every geometry anchor, page `scrollWidth === clientWidth`, zero uncontained overflow, zero page/console errors or warnings, zero failed API reads, and zero business mutations. Visually inspect at least Local 1280, Supplier 1440, Risk 1920, Advanced SLA 1440, and Configuration 1920 screenshots.

- [x] **Step 4: Freeze hashes and update the ledger**

Record SHA-256 for all changed source/tests/verifiers/results/screenshots. State explicitly that geometry closure does not prove the remaining normal/empty/loading/error/401/403/404/409/422/connector/pending/unknown/kill-switch matrix or production Business API deployment.
