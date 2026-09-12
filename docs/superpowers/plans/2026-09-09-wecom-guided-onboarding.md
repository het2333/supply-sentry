# 企业微信引导式接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员能在 Readywork 内完成企业微信应用的安全引导配置，并准确区分本地适配器状态与企业微信公网回调验收。

**Architecture:** API 从明确的部署环境变量派生公网回调就绪状态，并继续复用现有 Hermes 动态目录、配置与测试端点保存真实凭据。控制台为 `wecom_callback` 添加专用三步向导；随机回调材料只保存在浏览器组件内存直到一次性提交。

**Tech Stack:** TypeScript、node:http、SQLite 既有 Hermes 审计仓储、React 19、Next.js、Hermes Gateway Docker Compose。

**Spec:** `docs/superpowers/specs/2026-09-09-wecom-guided-onboarding-design.md`

## Global Constraints

- 仅管理员能提交企业微信配置；普通读取用户不得看到或生成密钥材料。
- `READYWORK_HERMES_WECOM_CALLBACK_PUBLIC_URL` 必须是公网 HTTPS 基地址；回调路径固定为 `/wecom/callback`。
- 不记录、不回填、不在响应或通知中输出 Secret、Token、AESKey 或企业 ID。
- `wecom_callback` 的“已连接”仅代表 Hermes 适配器已连接；公网回调仍须显示独立待验证状态。
- 当前工作目录没有 Git 元数据；每个任务以测试通过作为检查点，不能创建提交。

---

### Task 1: 企业微信公网回调就绪状态 API

**Files:**
- Create: `apps/api/src/messaging/wecom-setup-readiness.ts`
- Modify: `apps/api/src/messaging/hermes-routes.ts`
- Modify: `apps/api/test/hermes-routes.test.ts`

**Interfaces:**
- Produces: `resolveWecomSetupReadiness(publicUrl?: string): { callbackUrl: string | null; ready: boolean; reason: string | null }`.
- Produces: `GET /api/messaging/wecom/setup-readiness` using the same login/read permission as the Hermes catalogue.

- [ ] **Step 1: Write failing API tests**

```ts
assert.deepEqual(resolveWecomSetupReadiness(undefined), {
  callbackUrl: null, ready: false, reason: '尚未配置企业微信公网 HTTPS 回调地址',
});
assert.deepEqual(resolveWecomSetupReadiness('https://readywork.example.com'), {
  callbackUrl: 'https://readywork.example.com/wecom/callback', ready: true, reason: null,
});
assert.equal((await request('/api/messaging/wecom/setup-readiness', { role: 'none' })).status, 401);
```

- [ ] **Step 2: Run the route test to verify the missing readiness implementation fails**

Run: `pnpm exec tsx --test apps/api/test/hermes-routes.test.ts`

Expected: FAIL because `resolveWecomSetupReadiness` and the route do not exist.

- [ ] **Step 3: Implement URL validation and the read-only route**

```ts
const CALLBACK_PATH = '/wecom/callback';
const PRIVATE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function resolveWecomSetupReadiness(value?: string) {
  if (!value?.trim()) return { callbackUrl: null, ready: false, reason: '尚未配置企业微信公网 HTTPS 回调地址' };
  const url = new URL(value);
  if (url.protocol !== 'https:' || PRIVATE_HOSTS.has(url.hostname)) {
    return { callbackUrl: null, ready: false, reason: '企业微信回调地址必须是公网 HTTPS 地址' };
  }
  return { callbackUrl: new URL(CALLBACK_PATH, `${url.toString().replace(/\/$/u, '')}/`).toString(), ready: true, reason: null };
}
```

Inject `wecomCallbackPublicUrl` into `HermesMessagingRequestContext`, use it for the GET route, and keep all mutation endpoints unchanged.

- [ ] **Step 4: Run the route test to verify it passes**

Run: `pnpm exec tsx --test apps/api/test/hermes-routes.test.ts`

Expected: PASS, including unauthenticated and secret-redaction assertions.

### Task 2: Wire the deployment setting and private callback port

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `infra/hermes/compose.yml`
- Modify: `infra/hermes/README.md`
- Test: `apps/api/test/hermes-routes.test.ts`

**Interfaces:**
- Consumes: `HermesMessagingRequestContext.weixinCallbackPublicUrl` from Task 1.
- Produces: `READYWORK_HERMES_WECOM_CALLBACK_PUBLIC_URL` as the sole source of the callback base URL.

- [ ] **Step 1: Extend the failing route fixture**

```ts
const ready = await request('/api/messaging/wecom/setup-readiness');
assert.deepEqual(ready.body, {
  callbackUrl: 'https://readywork.example.com/wecom/callback', ready: true, reason: null,
});
```

Instantiate the test handler with `wecomCallbackPublicUrl: 'https://readywork.example.com'` and assert that a private/HTTP URL never yields a callback URL.

- [ ] **Step 2: Run the test to verify injection has not yet been wired**

Run: `pnpm exec tsx --test apps/api/test/hermes-routes.test.ts`

Expected: FAIL because production request context omits the value or the validation test is absent.

- [ ] **Step 3: Wire the environment and Docker binding**

Pass `process.env.READYWORK_HERMES_WECOM_CALLBACK_PUBLIC_URL` into the Hermes route context in `apps/api/src/index.ts`. Add `127.0.0.1:8645:8645` to the Hermes gateway service; document that a TLS reverse proxy must route the configured public URL to that loopback port.

- [ ] **Step 4: Run focused API and Compose configuration checks**

Run: `pnpm exec tsx --test apps/api/test/hermes-routes.test.ts && docker compose --env-file infra/hermes/.env -f infra/hermes/compose.yml config >/dev/null`

Expected: PASS and valid Compose syntax.

### Task 3: 企业微信应用三步向导

**Files:**
- Modify: `apps/console/features/procurement/hermes-platforms-panel.tsx`
- Modify: `apps/console/test/messaging-gateway-panel-interaction.test.tsx`

**Interfaces:**
- Consumes: `GET /api/messaging/wecom/setup-readiness` and the existing platform catalogue/configure/test APIs.
- Produces: a specialized `wecom_callback` dialog using one final `PUT /api/messaging/platforms/wecom_callback` request with `WECOM_CALLBACK_CORP_ID`, `WECOM_CALLBACK_CORP_SECRET`, `WECOM_CALLBACK_AGENT_ID`, `WECOM_CALLBACK_TOKEN`, and `WECOM_CALLBACK_ENCODING_AES_KEY`.

- [ ] **Step 1: Write the failing interaction test**

```tsx
await act(async () => { document.querySelector<HTMLButtonElement>("button[aria-label='配置企业微信应用']")!.click(); await wait(); });
assert.match(document.querySelector('[role=dialog]')?.textContent ?? '', /企业微信应用接入/);
assert.match(document.querySelector('[role=dialog]')?.textContent ?? '', /公网 HTTPS 回调地址/);
assert.ok(document.querySelector<HTMLInputElement>("input[aria-label='企业微信应用：回调 Token']")?.value);
assert.ok(document.querySelector<HTMLInputElement>("input[aria-label='企业微信应用：AESKey']")?.value);
```

Stub the readiness endpoint first as not ready and prove Save is blocked, then as ready. Fill only the three administrator values; assert that the final PUT contains all five required keys and no generated secret appears in the rendered text after completion.

- [ ] **Step 2: Run the interaction test to verify the specialized flow fails**

Run: `pnpm --dir apps/console exec tsx --test test/messaging-gateway-panel-interaction.test.tsx`

Expected: FAIL because the current generic dialog has neither readiness request nor generated callback materials.

- [ ] **Step 3: Implement the narrow specialized dialog branch**

Add a `WecomSetupReadiness` state loaded only when `wecom_callback` is selected. Generate Token and 43-character AESKey with `crypto.getRandomValues`, retain them in component state, and render copyable values as `readOnly` fields. Require readiness plus the three administrator-entered fields before calling the existing config endpoint, then call the existing test endpoint. Keep generated values out of notices and erase component state when the dialog closes.

- [ ] **Step 4: Run the interaction test to verify it passes**

Run: `pnpm --dir apps/console exec tsx --test test/messaging-gateway-panel-interaction.test.tsx`

Expected: PASS, including generic platform, Telegram, and personal-WeChat onboarding regressions.

### Task 4: Complete verification and visible local-state check

**Files:**
- Modify only if verification uncovers an in-scope defect.

**Interfaces:**
- Consumes all completed API and console contracts.
- Produces verified local behavior that says the callback is not production-ready until a public HTTPS address is configured.

- [ ] **Step 1: Run affected package tests**

Run: `pnpm exec tsx --test apps/api/test/hermes-routes.test.ts && pnpm --dir apps/console exec tsx --test test/messaging-gateway-panel-interaction.test.tsx && pnpm --dir apps/console exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 2: Run repository typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Exercise the running local API and browser**

Call the authenticated readiness endpoint against `127.0.0.1:4173` and open Readywork settings in the in-app browser. Verify that current local deployment displays the public-HTTPS blocker and that it does not mark enterprise WeChat connected.

- [ ] **Step 4: Record external limitation**

Report that actual enterprise-WeChat callback acceptance requires a corporate administrator, a public HTTPS reverse proxy, and official console verification; do not claim this from local adapter health alone.

## Self-review

- Spec coverage: Tasks 1–2 implement truthful deployment readiness and no-secret API behavior; Task 3 supplies the product flow; Task 4 verifies frontend, backend and local external-state boundary.
- Placeholder scan: no TODO/TBD or delegated implementation instructions remain.
- Type consistency: `WecomSetupReadiness` is the only new read contract; final configuration stays on the existing Hermes `PUT` contract.
