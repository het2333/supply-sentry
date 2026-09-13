# Public Demo Runtime and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an isolated, writable SupplySentry public demo at port 3002 with synthetic data, fail-closed side-effect simulation, hourly atomic resets, and one-command Docker startup.

**Architecture:** A dedicated `READYWORK_PUBLIC_DEMO=1` runtime fixes every authenticated request to tenant `t:public-demo`, adds a purpose-built public session endpoint, and blocks administrative and egress surfaces in the server before route dispatch. A tenant-scoped seed/reset service owns one SQLite transaction and generation lease, while `ActionGateway` and the procurement Outbox both write typed `simulated_demo` receipts instead of resolving connectors. A separate Compose project and named volume run the existing console, APIs, Temporal worker, deterministic mock model, and reset worker without any production mounts or credentials.

**Tech Stack:** Node.js 24, TypeScript, `node:http`, `node:sqlite`, React 19, Next.js 16, Temporal 1.28, Docker Compose, GHCR, Node test runner

**Spec:** `docs/superpowers/specs/2026-09-13-public-demo-and-portfolio-release-design.md`

## Global Constraints

- Runtime mode is enabled only by process environment `READYWORK_PUBLIC_DEMO=1`; query parameters, cookies, and request headers cannot enable it.
- Public-demo tenant is exactly `t:public-demo` and public identity is limited to procurement-manager permissions.
- Public demo must never mount or access `/opt/readywork/shared`, production SQLite files, Hermes state, DeepSeek credentials, or connector credentials.
- Email, WeChat, WeCom, WhatsApp, ERP, webhook, MCP, upload, credential, and arbitrary file egress are denied or recorded as `simulated_demo` before connector resolution.
- Reset deletes and reseeds only `t:public-demo` inside one `BEGIN IMMEDIATE` SQLite transaction and increments a visible generation.
- Local public binding defaults to `127.0.0.1:3002`; server deployment explicitly sets `0.0.0.0:3002`.
- Node.js is 24.20.0 for implementation verification and pnpm is 11.7.0.
- User-facing demo mode, errors, and simulation labels are available in Chinese and English.
- Never log message bodies, cookies, tokens, credentials, or provider payloads.

---

### Task 1: Public-demo mode contract and session boundary

**Files:**
- Create: `apps/api/src/public-demo-mode.ts`
- Create: `apps/api/test/public-demo-mode.test.ts`
- Modify: `apps/api/src/auth.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/service-surface.ts`
- Test: `apps/api/test/auth.test.ts`
- Test: `apps/api/test/service-surface.test.ts`

**Interfaces:**
- Consumes: `sessionCookieHeader(token: string, secure: boolean): string`, `Session`, and the existing API route dispatcher.
- Produces: `PUBLIC_DEMO_TENANT_ID`, `publicDemoMode(): boolean`, `assertPublicDemoConfiguration(): void`, `createPublicDemoSession(now?: number): { token: string; session: Session }`, `publicDemoCapabilities(): PublicDemoCapabilities`, and `POST /api/auth/public-demo`.

- [ ] **Step 1: Write the mode and route contract tests**

```ts
test('public demo is enabled only by READYWORK_PUBLIC_DEMO=1', () => {
  withEnv({ READYWORK_PUBLIC_DEMO: '1' }, () => assert.equal(publicDemoMode(), true));
  withEnv({ READYWORK_PUBLIC_DEMO: 'true' }, () => assert.equal(publicDemoMode(), false));
});

test('public demo session is fixed to the limited tenant identity', () => {
  const { session } = createPublicDemoSession(1_800_000_000_000);
  assert.deepEqual(
    { tenantId: session.tenantId, humanId: session.humanId, role: session.role },
    { tenantId: 't:public-demo', humanId: 'h:public-demo-manager', role: '采购经理' },
  );
});
```

Add an HTTP contract asserting `POST /api/auth/public-demo` returns `404` outside public-demo mode, returns an HttpOnly session in public-demo mode, and `/api/auth/config` returns `{ mode: 'public_demo', passwordLogin: false, demoMode: true }`.

- [ ] **Step 2: Run the focused tests and verify the new imports/routes fail**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/public-demo-mode.test.ts apps/api/test/auth.test.ts apps/api/test/service-surface.test.ts`

Expected: FAIL because `public-demo-mode.ts`, `publicDemoMode`, and the public-demo route do not exist.

- [ ] **Step 3: Implement the fail-closed mode object and signed session**

```ts
export const PUBLIC_DEMO_TENANT_ID = 't:public-demo';

export interface PublicDemoCapabilities {
  demoMode: true;
  tenantId: typeof PUBLIC_DEMO_TENANT_ID;
  syntheticData: true;
  externalDelivery: false;
  uploads: false;
  credentialManagement: false;
}

export function publicDemoMode(): boolean {
  return process.env['READYWORK_PUBLIC_DEMO'] === '1';
}

export function assertPublicDemoConfiguration(): void {
  if (!publicDemoMode()) return;
  if (process.env['READYWORK_PUBLIC_DEMO_TENANT'] !== PUBLIC_DEMO_TENANT_ID) {
    throw new Error('Public demo tenant configuration is invalid');
  }
  if (process.env['READYWORK_PUBLIC_DEMO_SIMULATION_POLICY'] !== 'simulated_demo') {
    throw new Error('Public demo simulation policy is missing');
  }
}
```

Reuse the existing signed-session primitive in `auth.ts`; do not add a static password or accept tenant/role fields from the request body. Extend `AuthConfig['mode']` to include `public_demo`, and include `demoMode` in config, session, and health responses.

- [ ] **Step 4: Add server-side deny rules before route handlers**

In `apps/api/src/index.ts`, reject public-demo access to connector callbacks, credential/config mutation, raw exports, uploads, developer control surfaces, and non-demo tenant identifiers before calling any handler. Return stable codes `PUBLIC_DEMO_CAPABILITY_DISABLED` or `PUBLIC_DEMO_TENANT_MISMATCH`.

```ts
const PUBLIC_DEMO_DENIED = [
  /^\/api\/connectors\//,
  /^\/api\/editor\/(credentials|connectors)/,
  /^\/api\/messaging\/platforms\/.+\/configure/,
  /^\/api\/procurement\/(imports|documents)\/upload/,
  /^\/api\/operations\//,
];
```

- [ ] **Step 5: Run focused and full API authorization tests**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/public-demo-mode.test.ts apps/api/test/auth.test.ts apps/api/test/service-surface.test.ts apps/api/test/security-events.test.ts`

Expected: PASS; a header, cookie value, or query parameter cannot switch a normal process into public-demo mode.

- [ ] **Step 6: Commit the mode boundary**

```bash
git add apps/api/src/public-demo-mode.ts apps/api/src/auth.ts apps/api/src/index.ts apps/api/src/service-surface.ts apps/api/test/public-demo-mode.test.ts apps/api/test/auth.test.ts apps/api/test/service-surface.test.ts
git commit -m "feat: add isolated public demo identity boundary"
```

### Task 2: Atomic synthetic seed and reset service

**Files:**
- Create: `apps/api/src/public-demo-seed.ts`
- Create: `apps/api/src/public-demo-reset.ts`
- Create: `apps/api/test/public-demo-reset.test.ts`
- Create: `scripts/demo/seed-public-demo.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `packages/persistence/src/index.ts`
- Test: `packages/persistence/test/procurement-persistence.test.ts`

**Interfaces:**
- Consumes: `DatabaseSync`, `initializeControlPlaneSchema(db)`, current procurement document/line schemas, and internal token authentication.
- Produces: `PUBLIC_DEMO_SEED_VERSION = 'public-demo-v1'`, `seedPublicDemo(db: DatabaseSync, input: { resetAt: string; generation: number }): PublicDemoSeedSummary`, `resetPublicDemo(db: DatabaseSync, now?: Date): PublicDemoResetResult`, `readPublicDemoStatus(db: DatabaseSync): PublicDemoStatus`, `POST /internal/demo/reset`, and `GET /api/public-demo/status`.

- [ ] **Step 1: Write transaction, tenant isolation, and data-coherence tests**

```ts
test('reset replaces only t:public-demo and increments generation atomically', () => {
  const db = openTestDatabase();
  seedForeignTenantSentinel(db, 't:acme');
  const first = resetPublicDemo(db, new Date('2026-09-13T04:00:00.000Z'));
  mutateDemoOrder(db, 'purchase-order:public-demo:partial');
  const second = resetPublicDemo(db, new Date('2026-09-13T05:00:00.000Z'));
  assert.equal(second.generation, first.generation + 1);
  assert.equal(readForeignTenantSentinel(db, 't:acme'), 'untouched');
  assert.equal(readDemoOrderStatus(db, 'purchase-order:public-demo:partial'), 'partially_shipped');
});

test('seed failure rolls back deletion and preserves the previous generation', () => {
  const before = snapshotDemoTables(db);
  assert.throws(() => resetPublicDemo(db, fixedNow, { failAfterTable: 'procurement_documents' }));
  assert.deepEqual(snapshotDemoTables(db), before);
});
```

Also assert stable fictional IDs, reserved email domains, relative timestamps, a pending short-delivery approval, accepted and uncertain simulated receipts, notifications, drafts, SLA, routes, supplier rows, audit events, and safe seeded attachment metadata.

- [ ] **Step 2: Run reset tests and verify they fail on missing services**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/public-demo-reset.test.ts`

Expected: FAIL because reset and seed modules do not exist.

- [ ] **Step 3: Add the public-demo control tables**

Extend persistence initialization with:

```sql
CREATE TABLE IF NOT EXISTS public_demo_state (
  tenant_id TEXT PRIMARY KEY CHECK (tenant_id = 't:public-demo'),
  seed_version TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  reset_at TEXT NOT NULL,
  reset_status TEXT NOT NULL CHECK (reset_status IN ('healthy','degraded')),
  last_error_code TEXT
);
CREATE TABLE IF NOT EXISTS public_demo_reset_lease (
  tenant_id TEXT PRIMARY KEY CHECK (tenant_id = 't:public-demo'),
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL
);
```

- [ ] **Step 4: Implement one-transaction reset and coherent seed**

Use `BEGIN IMMEDIATE`, validate seed version and simulation policy before deletion, delete only rows whose `tenant_id = ?`, seed through repository-compatible JSON shapes, append `public_demo.reset.completed`, and commit once. Any exception rolls back and updates degraded health in a separate transaction without deleting the prior generation.

The fixed scenario IDs are:

```ts
export const PUBLIC_DEMO_IDS = {
  normalPo: 'purchase-order:public-demo:normal',
  awaitingConfirmationPo: 'purchase-order:public-demo:awaiting-confirmation',
  vagueReplyPo: 'purchase-order:public-demo:vague-reply',
  partialShipmentPo: 'purchase-order:public-demo:partial',
  delayedImportPo: 'purchase-order:public-demo:delayed-import',
  shortDeliveryApproval: 'approval:public-demo:short-delivery',
  acceptedReceipt: 'receipt:public-demo:accepted',
  uncertainReceipt: 'receipt:public-demo:uncertain',
} as const;
```

- [ ] **Step 5: Wire authenticated reset and public read-only status**

`POST /internal/demo/reset` must exist only in public-demo mode, require `x-readywork-internal-token`, return `409 DEMO_RESET_IN_PROGRESS` for an active lease, and return `{ ok, seedVersion, generation, resetAt }`. `GET /api/public-demo/status` returns only redacted mode/status metadata.

- [ ] **Step 6: Add the standalone seed verifier**

`scripts/demo/seed-public-demo.ts` opens `DB_PATH`, invokes reset with `--reset-at` when provided, asserts every required scenario, and prints a single JSON summary. It must refuse to run unless public-demo mode, tenant, and simulation policy match exactly.

- [ ] **Step 7: Run seed, reset, and persistence tests**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/public-demo-reset.test.ts packages/persistence/test/procurement-persistence.test.ts`

Run: `tmp_dir="$(mktemp -d)"; PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" READYWORK_PUBLIC_DEMO=1 READYWORK_PUBLIC_DEMO_TENANT=t:public-demo READYWORK_PUBLIC_DEMO_SIMULATION_POLICY=simulated_demo DB_PATH="$tmp_dir/demo.sqlite" pnpm exec tsx scripts/demo/seed-public-demo.ts --reset-at 2026-09-13T04:00:00.000Z`

Expected: tests PASS and the verifier prints `"scenarioCount":8` with `"tenantId":"t:public-demo"`.

- [ ] **Step 8: Commit atomic demo state**

```bash
git add apps/api/src/public-demo-seed.ts apps/api/src/public-demo-reset.ts apps/api/src/index.ts apps/api/test/public-demo-reset.test.ts packages/persistence/src/index.ts packages/persistence/test/procurement-persistence.test.ts scripts/demo/seed-public-demo.ts
git commit -m "feat: seed and reset the public demo atomically"
```

### Task 3: External side-effect simulation at both execution boundaries

**Files:**
- Create: `apps/api/src/public-demo-receipts.ts`
- Create: `apps/api/test/public-demo-action-gateway.test.ts`
- Create: `apps/api/test/public-demo-outbox.test.ts`
- Modify: `apps/api/src/action-gateway.ts`
- Modify: `apps/api/src/procurement-outbox-worker.ts`
- Modify: `packages/persistence/src/index.ts`

**Interfaces:**
- Consumes: `ActionGatewayInput`, `ActionGatewayResult`, `ProcurementOutboxMessage`, and `PUBLIC_DEMO_TENANT_ID`.
- Produces: `PublicDemoReceipt`, `createSimulatedDemoReceipt(input): PublicDemoReceipt`, `isPublicDemoTenant(tenantId: string): boolean`, connector result metadata `{ receiptKind: 'simulated_demo'; outcome: 'accepted' | 'uncertain'; externalDelivery: false }`.

- [ ] **Step 1: Write connector-spy tests for Action Gateway and Outbox**

```ts
test('ActionGateway never resolves a connector for the public demo tenant', async () => {
  const connectors = connectorSpyThatThrows();
  const result = await gateway.execute(publicDemoEmailInput());
  assert.equal(result.ok, true);
  assert.equal((result.output as PublicDemoReceipt).receiptKind, 'simulated_demo');
  assert.equal(connectors.executeCalls, 0);
  assert.equal(connectors.credentialReads, 0);
});

test('uncertain simulated receipt remains visible for reconciliation', async () => {
  const result = await worker.dispatchOne(seedUncertainDemoOutbox());
  assert.equal(result.status, 'unknown');
  assert.equal(result.connectorResult?.receiptKind, 'simulated_demo');
  assert.equal(realAdapter.calls, 0);
});
```

- [ ] **Step 2: Run focused tests and confirm real connector spies are reached**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/public-demo-action-gateway.test.ts apps/api/test/public-demo-outbox.test.ts`

Expected: FAIL because the current gateways attempt normal connector resolution.

- [ ] **Step 3: Implement typed deterministic receipts**

```ts
export interface PublicDemoReceipt {
  receiptKind: 'simulated_demo';
  outcome: 'accepted' | 'uncertain';
  externalDelivery: false;
  connector: string;
  action: string;
  reference: string;
  generatedAt: string;
  generation: number;
}
```

Derive `outcome` only from seeded scenario metadata, never user-provided connector identifiers. The accepted path becomes a dispatched Outbox record; the uncertain path becomes the existing `unknown`/manual-reconciliation state and is never silently marked successful.

- [ ] **Step 4: Intercept before credential or adapter lookup**

Place the tenant/mode check at the first executable line of `ActionGateway.execute` after structural input validation and in `ProcurementOutboxWorker` before `loadChannelConfiguration`, `getCredential`, or adapter selection. Persist the same redacted receipt in action execution JSON, Outbox connector result, audit history, and API response.

- [ ] **Step 5: Run side-effect and regression suites**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/public-demo-action-gateway.test.ts apps/api/test/public-demo-outbox.test.ts apps/api/test/action-gateway.test.ts apps/api/test/procurement-outbox-worker.test.ts`

Expected: PASS; spies report zero credential reads and zero adapter calls for public-demo requests, while non-demo behavior remains unchanged.

- [ ] **Step 6: Commit simulation boundary**

```bash
git add apps/api/src/public-demo-receipts.ts apps/api/src/action-gateway.ts apps/api/src/procurement-outbox-worker.ts packages/persistence/src/index.ts apps/api/test/public-demo-action-gateway.test.ts apps/api/test/public-demo-outbox.test.ts
git commit -m "feat: simulate public demo external receipts"
```

### Task 4: Public-demo console entry, banner, and disabled controls

**Files:**
- Create: `apps/console/features/public-demo/public-demo-context.tsx`
- Create: `apps/console/features/public-demo/public-demo-banner.tsx`
- Create: `apps/console/test/public-demo-interaction.test.tsx`
- Modify: `apps/console/features/auth/auth-gate.tsx`
- Modify: `apps/console/app/layout.tsx`
- Modify: `apps/console/app/page.tsx`
- Modify: `apps/console/features/procurement/global-header.tsx`
- Modify: `apps/console/features/procurement/configuration-workbench.tsx`
- Modify: `apps/console/features/localization/en-platform.json`
- Modify: `apps/console/features/localization/chinese-ui-localization.tsx`

**Interfaces:**
- Consumes: `GET /api/auth/config`, `POST /api/auth/public-demo`, and `GET /api/public-demo/status`.
- Produces: `PublicDemoState`, `usePublicDemo(): PublicDemoState`, persistent bilingual banner, public entry CTA, and disabled-capability explanations.

- [ ] **Step 1: Read the installed Next.js 16 app-router guidance**

Run: `sed -n '1,240p' apps/console/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.mdx`

Expected: confirms metadata and root layout conventions used by this repository version.

- [ ] **Step 2: Write UI interaction tests**

Cover: public entry without username/password; persistent `Public demo · synthetic data · external delivery disabled` banner; generation display; bilingual text; configuration and upload controls absent or disabled with an explanation; normal local-demo login unchanged.

```tsx
render(<AuthGate><div>workspace</div></AuthGate>);
await user.click(await screen.findByRole('button', { name: 'Enter public demo' }));
expect(await screen.findByText('workspace')).toBeVisible();
expect(screen.getByText(/synthetic data/i)).toBeVisible();
```

- [ ] **Step 3: Run UI tests and verify the public entry is absent**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/public-demo-interaction.test.tsx test/auth-gate-interaction.test.tsx test/configuration-workbench-interaction.test.tsx`

Expected: FAIL on the missing public entry and banner.

- [ ] **Step 4: Implement provider, entry flow, and banner**

Use API-returned `demoMode`; never infer mode from `location`, port, or query. After entry, render the banner outside the scrolling page content so it remains visible on every section. Add `robots: { index: false, follow: false }` only when injected build/runtime demo metadata is enabled.

- [ ] **Step 5: Remove public reachability of dangerous controls**

Pass explicit capabilities to configuration, upload, connector, credential, tenant administration, export, and developer panels. Server denial remains authoritative; UI denial provides a clear reason and no callable button.

- [ ] **Step 6: Run localization, UI, and build checks**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/public-demo-interaction.test.tsx test/auth-gate-interaction.test.tsx test/configuration-workbench-interaction.test.tsx test/ui-language-interaction.test.tsx`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" READYWORK_PUBLIC_DEMO=1 pnpm --filter @readywork/app-console build`

Expected: tests and production build PASS in Chinese and English.

- [ ] **Step 7: Commit public-demo UX**

```bash
git add apps/console/features/public-demo apps/console/features/auth/auth-gate.tsx apps/console/app/layout.tsx apps/console/app/page.tsx apps/console/features/procurement/global-header.tsx apps/console/features/procurement/configuration-workbench.tsx apps/console/features/localization/en-platform.json apps/console/features/localization/chinese-ui-localization.tsx apps/console/test/public-demo-interaction.test.tsx
git commit -m "feat: add safe public demo experience"
```

### Task 5: Mutation generation guard, rate limits, and request caps

**Files:**
- Create: `apps/api/src/public-demo-abuse-controls.ts`
- Create: `apps/api/test/public-demo-abuse-controls.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/console/features/shared/api-client.ts`
- Modify: `apps/console/features/public-demo/public-demo-context.tsx`
- Modify: `apps/console/features/localization/en-platform.json`
- Modify: `apps/console/features/localization/chinese-ui-localization.tsx`

**Interfaces:**
- Consumes: demo session identity, request IP, method/path, `public_demo_state.generation`, and client header `x-readywork-demo-generation`.
- Produces: `PublicDemoRateLimiter.check(input): RateLimitDecision`, `requireCurrentDemoGeneration(req, db): number`, response header `x-readywork-demo-generation`, and stable errors `DEMO_RATE_LIMITED`, `DEMO_GENERATION_CONFLICT`, and `BODY_TOO_LARGE`.

- [ ] **Step 1: Write abuse and concurrent-reset tests**

Use a fake clock and assert separate token buckets for entry/login, mutations, search, chat, and reset-sensitive reads; `429` responses include `Retry-After`. Assert public uploads are rejected before reading the body, every JSON body is capped at 1 MB, chat is capped at its smaller existing limit, and a stale mutation generation receives `409 DEMO_GENERATION_CONFLICT` without changing SQLite.

```ts
test('stale generation cannot mutate the reseeded demo', async () => {
  const before = readPublicDemoState(db);
  resetPublicDemo(db, later);
  const response = await mutate({ headers: { 'x-readywork-demo-generation': String(before.generation) } });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'DEMO_GENERATION_CONFLICT');
  assert.equal(readMutationCount(db), 0);
});
```

- [ ] **Step 2: Run focused tests and verify controls are absent**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/public-demo-abuse-controls.test.ts`

Expected: FAIL because rate limiter and generation guard do not exist.

- [ ] **Step 3: Implement bounded in-memory token buckets**

Key buckets by a one-way hash of normalized IP plus session username; never log the raw key. Cap retained keys and evict expired entries. Apply limits only in public-demo mode: entry 10/minute, mutations 120/minute, search 60/minute, chat 20/minute, and reset-sensitive reads 120/minute. Return localized retry metadata without reflecting request content.

- [ ] **Step 4: Enforce generation on every public-demo mutation**

The API publishes current generation on authenticated reads and requires the matching header on non-idempotent demo mutations. Reset requests use internal authentication and are exempt. The client stores generation only in React memory, refreshes status on conflict, discards the stale response, and shows `公开演示数据已重置，页面已刷新` / `Public demo data was reset; this view has been refreshed`.

- [ ] **Step 5: Run abuse, auth, chat, and UI tests**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test apps/api/test/public-demo-abuse-controls.test.ts apps/api/test/auth.test.ts apps/api/test/procurement-route-chat.test.ts`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm --dir apps/console exec tsx --test --test-concurrency=1 test/public-demo-interaction.test.tsx`

Expected: PASS; stale writes do not alter state and overload responses are stable.

- [ ] **Step 6: Commit abuse controls**

```bash
git add apps/api/src/public-demo-abuse-controls.ts apps/api/src/index.ts apps/api/test/public-demo-abuse-controls.test.ts apps/console/features/shared/api-client.ts apps/console/features/public-demo/public-demo-context.tsx apps/console/features/localization/en-platform.json apps/console/features/localization/chinese-ui-localization.tsx apps/console/test/public-demo-interaction.test.tsx
git commit -m "feat: harden public demo abuse boundaries"
```

### Task 6: Demo Compose topology and one-command CLI

**Files:**
- Create: `infra/demo/compose.yml`
- Create: `infra/demo/compose.build.yml`
- Create: `infra/demo/README.md`
- Create: `infra/demo/test/compose-contract.test.mjs`
- Create: `infra/demo/test/demo-script-contract.test.mjs`
- Create: `scripts/demo/demo.sh`
- Create: `.env.demo.example`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `infra/production/Dockerfile`

**Interfaces:**
- Consumes: image `ghcr.io/het2333/supply-sentry-demo:latest`, `POST /internal/demo/reset`, API and console health endpoints.
- Produces: `./scripts/demo/demo.sh up|down|logs|reset|purge`, Compose project `supplysentry-demo`, volume `supplysentry_demo_data`, and published `${READYWORK_DEMO_BIND_ADDRESS:-127.0.0.1}:${READYWORK_DEMO_PORT:-3002}`.

- [ ] **Step 1: Write Compose and shell contract tests**

Render the topology with `docker compose config --format json` and assert exactly these services: `console`, `business-api`, `control-api`, `temporal-db`, `temporal`, `temporal-worker`, `mock-model`, `reset-worker`. Assert only console publishes a port, no `/opt/readywork/shared` mounts exist, no Hermes/ERP/DeepSeek environment names exist, and all app services use `READYWORK_PUBLIC_DEMO=1`, `t:public-demo`, and `simulated_demo`.

- [ ] **Step 2: Run contract tests and verify files are missing**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node --test infra/demo/test/*.test.mjs`

Expected: FAIL because the demo topology and CLI do not exist.

- [ ] **Step 3: Implement Compose and reset worker**

The reset worker runs one reset after API health succeeds, then waits 3600 seconds between calls. It uses the internal Docker network and reads only the generated internal token. Configure a dedicated named SQLite volume at `/app/data`; configure the deterministic mock model rather than DeepSeek.

- [ ] **Step 4: Implement the safe shell command**

`up` creates ignored `infra/demo/.env` using `openssl rand -hex 32` or `/dev/urandom`, pulls by default, starts with `--wait`, checks `http://127.0.0.1:${READYWORK_DEMO_PORT:-3002}/`, and prints logs/down commands. `purge` requires an interactive exact `purge` confirmation and is the only command using `down --volumes`.

- [ ] **Step 5: Add a demo image target**

Pin the base to Node 24.20.0 and pnpm 11.7.0, build the console, retain the unprivileged `readywork` user, expose no secret build arguments, and add OCI source/revision labels supplied by the build workflow.

- [ ] **Step 6: Run render, shell, image, and seed checks**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node --test infra/demo/test/*.test.mjs infra/production/test/image-contract.test.mjs`

Run: `READYWORK_DEMO_IMAGE=readywork-demo:local ./scripts/demo/demo.sh up --build`

Run: `curl --fail --silent http://127.0.0.1:3002/api/public-demo/status`

Expected: tests PASS, containers healthy, and status reports `demoMode: true`, `tenantId: t:public-demo`, and a positive generation.

- [ ] **Step 7: Verify reset and teardown**

Run: `./scripts/demo/demo.sh reset && ./scripts/demo/demo.sh down`

Expected: reset returns the next generation; shutdown preserves the named volume.

- [ ] **Step 8: Commit one-command Docker demo**

```bash
git add infra/demo scripts/demo/demo.sh .env.demo.example .gitignore package.json infra/production/Dockerfile
git commit -m "feat: add one-command public demo stack"
```

### Task 7: CI, GHCR publishing, and isolated server deployment

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/demo-image.yml`
- Create: `scripts/demo/deploy-server.sh`
- Create: `scripts/demo/verify-public-demo.mjs`
- Create: `infra/demo/test/server-deployment-contract.test.mjs`
- Modify: `infra/demo/README.md`

**Interfaces:**
- Consumes: prior demo image target, deterministic evaluation command from the evaluation plan, GitHub `GITHUB_TOKEN`, and server SSH already authorized by the repository owner.
- Produces: GHCR tags `sha-<commit>`, version tag, gated `latest`, `/opt/supplysentry-demo`, Compose project `supplysentry-demo`, and external URL `http://47.102.116.148:3002` only after verification.

- [ ] **Step 1: Write workflow and server isolation contract tests**

Assert CI uses Node 24.20.0 and pnpm 11.7.0, frozen install, typecheck, full tests, localization, deployment contracts, deterministic evaluation diff, seed verifier, Compose render, console build, and container health smoke. Assert publish uses `packages: write`, SHA tags, provenance/source labels, and gates `latest` on all mandatory jobs.

- [ ] **Step 2: Run workflow contract tests and verify workflows are absent**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node --test infra/demo/test/server-deployment-contract.test.mjs`

Expected: FAIL because workflows and deployment script do not exist.

- [ ] **Step 3: Implement CI and image publication**

Use `actions/checkout`, `actions/setup-node`, `pnpm/action-setup`, `docker/setup-buildx-action`, `docker/login-action`, and `docker/build-push-action` pinned to stable major releases. Remote DeepSeek evaluation and media capture remain `workflow_dispatch` jobs and never run in pull requests.

- [ ] **Step 4: Implement an isolation-validating server deployment script**

The script refuses target directories other than `/opt/supplysentry-demo`, refuses port 3001, writes only `/opt/supplysentry-demo/.env`, sets `READYWORK_DEMO_BIND_ADDRESS=0.0.0.0` and port 3002, starts Compose with `--project-name supplysentry-demo`, and proves rendered mounts exclude `/opt/readywork/shared` before startup.

- [ ] **Step 5: Implement external acceptance verification**

`scripts/demo/verify-public-demo.mjs --base-url http://47.102.116.148:3002` must enter the public session, read generation, mutate one seeded PO through its real API, verify projection/audit/notification changes, invoke a simulated action, assert `receiptKind=simulated_demo`, reset internally, and verify the original seed state is restored. It must also assert credential/configuration/upload/webhook endpoints are denied.

- [ ] **Step 6: Run local contract and clean-stack acceptance**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node --test infra/demo/test/*.test.mjs`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node scripts/demo/verify-public-demo.mjs --base-url http://127.0.0.1:3002`

Expected: all checks PASS and no request reaches a real connector.

- [ ] **Step 7: Deploy and verify on the server**

Run: `./scripts/demo/deploy-server.sh admin@47.102.116.148`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node scripts/demo/verify-public-demo.mjs --base-url http://47.102.116.148:3002`

Expected: the remote stack is healthy and isolated. If TCP 3002 is blocked, open only TCP 3002 in the host firewall and Alibaba Cloud security group, then rerun the same verifier.

- [ ] **Step 8: Commit CI and deployment automation**

```bash
git add .github/workflows/ci.yml .github/workflows/demo-image.yml scripts/demo/deploy-server.sh scripts/demo/verify-public-demo.mjs infra/demo/README.md infra/demo/test/server-deployment-contract.test.mjs
git commit -m "ci: publish and verify the isolated demo"
```

### Task 8: Runtime acceptance and security evidence

**Files:**
- Create: `reports/demo/public-demo-acceptance.md`
- Modify: `infra/demo/README.md`

**Interfaces:**
- Consumes: local and remote verifier JSON output, Docker Compose rendered configuration, test output, and GitHub image metadata.
- Produces: a redacted acceptance record with timestamps, commit SHA, seed version, generation, endpoint outcomes, and isolation assertions.

- [ ] **Step 1: Run the full Node 24 validation suite**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm typecheck`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm test`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm test:localization && PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm test:deploy:contracts`

Expected: every command exits 0.

- [ ] **Step 2: Record redacted local and remote evidence**

Include exact commit SHA, image digest, Compose project, published port, dedicated volume names, seed version, verifier results, and assertion that external adapters recorded zero calls. Exclude environment values, cookies, headers, message bodies, and container environment dumps.

- [ ] **Step 3: Scan public-demo files and history for secrets**

Run: `git grep -nE '(sk-[A-Za-z0-9]{16,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|password[[:space:]]*=[[:space:]]*[^$<{])' -- . ':!pnpm-lock.yaml'`

Run: `git log -p --all -- .github infra/demo scripts/demo reports/demo | rg -n '(sk-[A-Za-z0-9]{16,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)'`

Expected: both searches return no secret findings; documented variable names and generated-at-runtime placeholders are acceptable only when they contain no value.

- [ ] **Step 4: Commit acceptance evidence**

```bash
git add reports/demo/public-demo-acceptance.md infra/demo/README.md
git commit -m "docs: record public demo acceptance evidence"
```
