import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { ChannelConnectionSummary, ConfigurationAutoSendSummary } from "../features/procurement/channel-connections-view-model.js";
import type { ProcurementTenantPreferencesResponse } from "../features/procurement/tenant-preferences-context.js";

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://readywork.test/" });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = value;
  }
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: globals.requestAnimationFrame });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: globals.cancelAnimationFrame });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  return {
    host: dom.window.document.querySelector<HTMLDivElement>("#root")!,
    restore: () => {
      for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
      dom.window.close();
    },
  };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 0));
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const connections: ChannelConnectionSummary[] = [
  { id: "email", connectionType: "Supplier", status: "installed", runtimeHealthy: true, credentialReady: true, externalVerified: true, credentialCount: 1, lastTestedAt: "2026-09-03T08:00:00.000Z", healthMessage: "Pending" },
  { id: "whatsapp", connectionType: "Meta WhatsApp Cloud API", status: "installed", runtimeHealthy: true, credentialReady: true, externalVerified: false, credentialCount: 1, lastTestedAt: null, healthMessage: "Awaiting external test" },
  { id: "wechat", connectionType: "Not available", status: "unavailable", runtimeHealthy: false, credentialReady: false, externalVerified: false, credentialCount: 0, lastTestedAt: null, healthMessage: "Not available / Not configured" },
  { id: "deepseek", connectionType: "DeepSeek 官方 API", status: "installed", runtimeHealthy: true, credentialReady: false, externalVerified: false, credentialCount: 1, lastTestedAt: "2026-09-03T08:05:00.000Z", healthMessage: "DeepSeek API 密钥无效" },
  { id: "erp", connectionType: "Odoo ERP", status: "failed", runtimeHealthy: false, credentialReady: true, externalVerified: false, credentialCount: 1, lastTestedAt: "2026-09-03T08:10:00.000Z", healthMessage: "Odoo authentication failed" },
];

function autoSend(ready: boolean): ConfigurationAutoSendSummary {
  const ids = ["permission", "published_profile", "communication_identity", "allowlists", "supplier_target", "connector", "kill_switch"] as const;
  const gates = ids.map((id) => ({ id, label: id, status: ready ? "ready" as const : "blocked" as const, detail: ready ? "Ready" : `Blocked: ${id}` }));
  return {
    enabled: ready,
    ready,
    profileId: ready ? "advanced-sla:published" : null,
    profileVersion: ready ? 3 : null,
    stageAllowlist: ready ? ["supplier_commitment"] : [],
    channelAllowlist: ready ? ["email"] : [],
    riskAllowlist: ready ? ["high"] : [],
    gates,
    blockers: ready ? [] : gates,
  };
}

test("自动跟单设置首屏先给结论和下一步，把业务偏好、全渠道和系统诊断渐进展开", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const navigated: string[] = [];
  const readyConnections = connections.map((item) => item.id === "deepseek"
    ? { ...item, credentialReady: true, externalVerified: true, healthMessage: "真实适配器已加载" }
    : item);

  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/api/procurement/tenant-preferences") return json({
      item: null,
      effective: { countryCode: "CN", workingDays: [1, 2, 3, 4, 5], timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", slaEscalationsEnabled: true, excludeWeekends: true, excludePublicHolidays: true, autoCalculateLeadTime: true },
      inheritedDefault: true,
      permissions: { read: true, configure: true },
      events: [],
    });
    if (path === "/api/messaging/platforms") return json({
      stale: false,
      capturedAt: "2026-09-09T10:00:00.000Z",
      permissions: { manage: true },
      platforms: [{ id: "telegram", name: "Telegram", enabled: false, configured: false, gatewayRunning: false, state: "not_configured", errorCode: null, errorMessage: null, updatedAt: null, docsUrl: "https://example.test/telegram", envVars: [], onboarding: "telegram" }],
    });
    if (path === "/api/messaging/hermes/health") return json({ status: "running", sidecar: { ok: true }, bridge: { ok: true }, inboxOutbox: { inboxPending: 0, outboxPending: 0, unknownDeliveries: 0 } });
    if (path === "/api/messaging/gateway") return json({
      status: "running",
      checkedAt: "2026-09-09T10:00:00.000Z",
      permissions: { manage: false },
      adapters: [{ id: "email", channel: "email", provider: "smtp", status: "running", capabilities: ["send", "receive"], version: 7, consecutiveFailures: 0, lastHealthAt: "2026-09-09T10:00:00.000Z", lastError: null, pauseReason: null, pendingInbound: 0, pendingDeliveries: 0, exceptionalDeliveries: 0 }],
    });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  try {
    const React = await import("react");
    const { act } = React;
    runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementConfigurationWorkbench } = await import("../features/procurement/configuration-workbench.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    await act(async () => {
      root = createRoot(host);
      root.render(<ProcurementTenantPreferencesProvider><ProcurementConfigurationWorkbench
        mode="settings"
        connections={readyConnections}
        autoSend={autoSend(false)}
        connectionsManageable={true}
        loading={false}
        onOpenConnector={() => undefined}
        onDisconnectConnector={() => undefined}
        onNavigate={(target) => navigated.push(target)}
      ><div data-testid="admin-control-plane">Admin control plane</div></ProcurementConfigurationWorkbench></ProcurementTenantPreferencesProvider>);
      await wait();
    });

    assert.equal(document.querySelector("h1")?.textContent, "自动跟单设置");
    assert.match(document.body.textContent ?? "", /系统已可开始处理供应商邮件/);
    assert.match(document.body.textContent ?? "", /邮箱和 AI 解析已就绪/);
    assert.equal(document.querySelector("#tenant-preferences"), null, "常规设置不应在首屏挂载");
    assert.doesNotMatch(document.body.textContent ?? "", /电报/);
    assert.equal(document.querySelector('[aria-label="消息网关运行状态"]'), null);

    const start = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "查看待核验邮件")!;
    await act(async () => { start.click(); await wait(); });
    assert.deepEqual(navigated, ["po-intake"]);

    const preferences = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("调整工作日和时区"))!;
    await act(async () => { preferences.click(); await wait(); await wait(); });
    assert.ok(document.querySelector("#tenant-preferences"));

    const moreChannels = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("个人微信和其他消息渠道"))!;
    await act(async () => { moreChannels.click(); await wait(); await wait(); });
    assert.match(document.body.textContent ?? "", /电报/);

    const diagnostics = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("查看系统诊断"))!;
    await act(async () => { diagnostics.click(); await wait(); await wait(); });
    assert.ok(document.querySelector('[aria-label="消息网关运行状态"]'));
    assert.match(document.body.textContent ?? "", /邮件适配器/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("取消微信扫码会话失败时保留弹窗并明示错误", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let deleteCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/messaging/platforms") return json({
      stale: false,
      capturedAt: "2026-09-09T10:00:00.000Z",
      permissions: { manage: true },
      platforms: [{
        id: "weixin", name: "Weixin", enabled: false, configured: false, gatewayRunning: true,
        state: "not_configured", errorCode: null, errorMessage: null, updatedAt: null,
        docsUrl: "https://example.test/weixin", onboarding: "weixin",
        envVars: [],
      }],
    });
    if (path === "/api/messaging/hermes/health") return json({
      status: "running", sidecar: { ok: true }, bridge: { ok: true },
      inboxOutbox: { inboxPending: 0, outboxPending: 0, unknownDeliveries: 0 },
    });
    if (path === "/api/messaging/onboarding/weixin/start" && init?.method === "POST") return json({
      pairing_id: "weixin-pairing-001", status: "waiting",
      qr_payload: "https://weixin.example/qr", expires_at: "2026-09-09T10:08:00.000Z",
    });
    if (path === "/api/messaging/onboarding/weixin/weixin-pairing-001" && init?.method === "DELETE") {
      deleteCalls += 1;
      return new Response(JSON.stringify({ error: "无法取消微信扫码会话" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  try {
    const React = await import("react");
    const { act } = React;
    const { createRoot } = await import("react-dom/client");
    const { HermesPlatformsPanel } = await import("../features/procurement/hermes-platforms-panel.js");
    await act(async () => {
      const rendered = createRoot(host);
      root = rendered;
      rendered.render(<HermesPlatformsPanel />);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const configure = document.querySelector<HTMLButtonElement>('[aria-label="配置微信"]');
    assert.ok(configure, document.body.textContent ?? "未渲染消息渠道");
    await act(async () => { configure.click(); await wait(); });
    const generate = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "生成微信二维码")!;
    await act(async () => { generate.click(); await wait(); });
    const cancel = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "取消")!;
    await act(async () => { cancel.click(); await wait(); await wait(); });

    assert.equal(deleteCalls, 1);
    assert.match(document.body.textContent ?? "", /无法取消微信扫码会话/u);
    assert.match(document.body.textContent ?? "", /配置微信/u);
  } finally {
    await import("react").then(async ({ act }) => { if (root) await act(async () => root!.unmount()); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Configuration aligns manager/admin clicks, WeChat boundary, auto-send switch, Escape and focus", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const opened: string[] = [];
  const disconnected: string[] = [];
  const navigated: string[] = [];
  const preferenceWrites: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/procurement/tenant-preferences" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      preferenceWrites.push(body);
      return json({
        item: { ...body, version: 1, createdBy: "admin", updatedBy: "admin", createdAt: "2026-09-03T08:00:00.000Z", updatedAt: "2026-09-03T08:00:00.000Z" },
        effective: body,
        inheritedDefault: false,
        permissions: { read: true, configure: true },
        events: [],
      });
    }
    if (path === "/api/procurement/tenant-preferences") return json({
      item: null,
      effective: { countryCode: "CN", workingDays: [1, 2, 3, 4, 5], timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", slaEscalationsEnabled: true, excludeWeekends: true, excludePublicHolidays: true, autoCalculateLeadTime: true },
      inheritedDefault: true,
      permissions: { read: true, configure: true },
      events: [],
    });
    if (path === "/api/procurement/communication-identity") return json({ item: null, readiness: "missing", suggested: {}, permissions: { read: true, configure: false }, legacyDrafts: { withoutIdentity: 0, eligibleForRebind: 0, requiresManualReview: 0, reboundInThisWrite: 0 }, events: [] });
    if (path === "/api/procurement/deployment-profile") return json({ item: null, effectiveMode: "email_only", inheritedDefault: true, evidence: { acceptedEmailPurchaseOrders: 0, odooPurchaseOrders: 0 }, permissions: { read: true, configure: false }, events: [] });
    if (path === "/api/operations/v1-readiness") return json({ status: "blocked", checkedAt: "2026-09-03T08:00:00.000Z", deploymentMode: "email_only", readyGates: 0, totalGates: 0, gates: [], portfolio: { totalPurchaseOrders: 0, activePurchaseOrders: 0, local: 0, import: 0, unclassified: 0, byStage: {}, fiveStageClosedLoop: 0 } });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  try {
    const React = await import("react");
    const { act } = React;
    runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementConfigurationWorkbench } = await import("../features/procurement/configuration-workbench.js");
    const { ChineseUiLocalization } = await import("../features/localization/chinese-ui-localization.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    const render = (manageable: boolean, readiness: ConfigurationAutoSendSummary, governanceMode = false, localize = false, error?: string) => (<>
      {localize && <ChineseUiLocalization />}
      <ProcurementTenantPreferencesProvider>
        <ProcurementConfigurationWorkbench
          mode="settings"
          governanceMode={governanceMode}
          connections={connections}
          autoSend={readiness}
          connectionsManageable={manageable}
          loading={false}
          error={error}
          onOpenConnector={(id) => opened.push(id)}
          onDisconnectConnector={(id) => disconnected.push(id)}
          onNavigate={(target) => navigated.push(target)}
        >
          <div data-testid="admin-control-plane">Admin control plane</div>
        </ProcurementConfigurationWorkbench>
      </ProcurementTenantPreferencesProvider>
    </>);

    await act(async () => {
      const rendered = createRoot(host);
      root = rendered;
      rendered.render(render(false, autoSend(false)));
      await wait();
      await wait();
    });
    assert.equal(document.querySelector("h1")?.textContent, "自动跟单设置");
    assert.match(document.body.textContent ?? "", /先完成邮箱和 AI 解析连接/);
    assert.equal(document.querySelector("#tenant-preferences"), null, "业务日历应默认折叠");
    assert.equal([...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.trim() === "保存更改"), false);
    assert.match(document.body.textContent ?? "", /邮件智能体/);
    assert.match(document.body.textContent ?? "", /WhatsApp 智能体/);
    assert.equal(document.querySelector('[aria-label="微信智能体连接"]'), null, "旧企业微信占位卡不得与真实个人微信扫码入口并存");
    assert.match(document.body.textContent ?? "", /个人微信和其他消息渠道/);
    assert.match(document.body.textContent ?? "", /个人微信可直接扫码接入/);
    assert.match(document.body.textContent ?? "", /AI 回复解析/);
    assert.match(document.body.textContent ?? "", /DeepSeek AI/);
    assert.match(document.querySelector<HTMLElement>('[data-connection-id="deepseek"]')?.textContent ?? "", /DeepSeek API 密钥无效/);
    const communicationSwitches = document.querySelectorAll<HTMLButtonElement>('[data-connection-id] button[role="switch"]');
    assert.equal(communicationSwitches.length, 2);
    assert.equal(communicationSwitches[0]?.getAttribute("role"), "switch");
    assert.equal(communicationSwitches[1]?.getAttribute("role"), "switch");
    const preferencesDisclosure = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("调整工作日和时区"))!;
    await act(async () => { preferencesDisclosure.click(); await wait(); await wait(); });
    assert.ok([...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.trim() === "保存更改"));
    assert.match(document.body.textContent ?? "", /国家/);
    assert.match(document.body.textContent ?? "", /工作日/);
    assert.match(document.body.textContent ?? "", /周一/);
    assert.match(document.body.textContent ?? "", /启用 SLA 升级/);
    assert.match(document.body.textContent ?? "", /排除周末/);
    assert.match(document.body.textContent ?? "", /排除公共节假日/);
    assert.match(document.body.textContent ?? "", /自动计算交期/);
    assert.match(document.body.textContent ?? "", /默认时区/);
    assert.match(document.body.textContent ?? "", /日期格式/);
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="启用邮件智能体"]')?.getAttribute("role"), "switch");
    const emailFacts = document.querySelector<HTMLElement>('[data-connection-id="email"]')!;
    assert.match(emailFacts.textContent ?? "", /运行状态/);
    assert.match(emailFacts.textContent ?? "", /凭据/);
    assert.match(emailFacts.textContent ?? "", /外部验证/);
    assert.match(emailFacts.textContent ?? "", /最近测试/);
    assert.match(emailFacts.textContent ?? "", /健康状况/);
    assert.doesNotMatch(document.body.textContent ?? "", /业务系统|自动发送跟进|高级治理/);
    const country = document.querySelector<HTMLSelectElement>("#tenant-preferences select")!;
    country.value = "SG";
    await act(async () => { country.dispatchEvent(new Event("change", { bubbles: true })); await wait(); });
    const saveChanges = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "保存更改")!;
    await act(async () => { saveChanges.click(); await wait(); await wait(); });
    assert.equal(preferenceWrites.length, 1);
    assert.equal(preferenceWrites[0]?.countryCode, "SG");
    assert.equal(preferenceWrites[0]?.expectedVersion, 0);
    await act(async () => { root!.render(render(true, autoSend(false))); await wait(); await wait(); });
    const normalWhatsAppSwitch = document.querySelector<HTMLButtonElement>('[data-connection-id="whatsapp"] button[role="switch"]')!;
    await act(async () => { normalWhatsAppSwitch.click(); await wait(); await wait(); });
    assert.deepEqual(opened, ["whatsapp"]);
    assert.ok(document.querySelector("#advanced-governance-content"));
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await wait(); });
    assert.equal(document.querySelector("#advanced-governance-content"), null);
    await act(async () => { root!.render(render(false, autoSend(false))); await wait(); await wait(); });
    assert.equal(document.querySelector('[data-testid="admin-control-plane"]'), null);
    for (const article of document.querySelectorAll<HTMLElement>("[data-connection-id]")) {
      assert.equal(article.querySelectorAll<HTMLButtonElement>("button:not(:disabled)").length, 0);
    }
    await act(async () => { root!.render(render(false, autoSend(false), true)); await wait(); await wait(); });
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="打开服务器自动发送策略"]')?.disabled, true);
    const advanced = document.querySelector<HTMLButtonElement>('[aria-controls="advanced-governance-content"]')!;
    advanced.focus();
    await act(async () => { advanced.click(); await wait(); await wait(); });
    assert.ok(document.querySelector("#advanced-governance-content"));
    assert.equal(document.querySelector('[data-testid="admin-control-plane"]'), null);
    assert.match(document.body.textContent ?? "", /管理员治理控制面/);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await wait(); });
    assert.equal(document.querySelector("#advanced-governance-content"), null);
    assert.equal(document.activeElement, advanced);

    const collisionReadiness = autoSend(false);
    collisionReadiness.gates = collisionReadiness.gates.map((gate, index) => index === 0 ? { ...gate, label: "Supplier", detail: "Pending" } : gate);
    collisionReadiness.blockers = collisionReadiness.gates;
    await act(async () => { root!.render(render(false, collisionReadiness, true, true, "Supplier")); await wait(); await wait(); });
    const collisionAdvanced = document.querySelector<HTMLButtonElement>('[aria-controls="advanced-governance-content"]')!;
    await act(async () => { collisionAdvanced.click(); await wait(); await wait(); });
    const permissionGate = document.querySelector<HTMLElement>('[data-auto-send-gate="permission"]')!;
    assert.match(permissionGate.textContent ?? "", /Supplier/);
    assert.match(permissionGate.textContent ?? "", /Pending/);
    assert.doesNotMatch(permissionGate.textContent ?? "", /供应商|待处理/);
    const governanceError = document.querySelector<HTMLElement>('[aria-label="管理员治理边界"] [data-preserve-language]')!;
    assert.equal(governanceError.textContent, "Supplier");
    const localizedEmail = document.querySelector<HTMLElement>('[data-connection-id="email"]')!;
    assert.match(localizedEmail.textContent ?? "", /Supplier/);
    assert.match(localizedEmail.textContent ?? "", /Pending/);
    assert.doesNotMatch(localizedEmail.textContent ?? "", /供应商|待处理/);
    const channelError = document.querySelector<HTMLElement>('[aria-label="通信连接"] [role="alert"]')!;
    assert.match(channelError.textContent ?? "", /Supplier/);
    assert.doesNotMatch(channelError.textContent ?? "", /供应商/);

    await act(async () => { root!.render(render(true, autoSend(true), true)); await wait(); await wait(); });
    const email = document.querySelector<HTMLElement>('[data-connection-id="email"]')!;
    const emailDetails = [...email.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "详情")!;
    await act(async () => { emailDetails.click(); await wait(); await wait(); });
    assert.deepEqual(opened, ["whatsapp", "email"]);
    assert.ok(document.querySelector('[data-testid="admin-control-plane"]'));
    const whatsapp = document.querySelector<HTMLElement>('[data-connection-id="whatsapp"]')!;
    await act(async () => { whatsapp.querySelector<HTMLButtonElement>("button:not(:disabled)")!.click(); await wait(); await wait(); });
    const erp = document.querySelector<HTMLElement>('[data-connection-id="erp"]')!;
    await act(async () => { erp.querySelector<HTMLButtonElement>("button:not(:disabled)")!.click(); await wait(); await wait(); });
    const deepseek = document.querySelector<HTMLElement>('[data-connection-id="deepseek"]')!;
    await act(async () => { deepseek.querySelector<HTMLButtonElement>("button:not(:disabled)")!.click(); await wait(); await wait(); });
    assert.deepEqual(opened, ["whatsapp", "email", "whatsapp", "erp", "deepseek"]);
    assert.deepEqual(disconnected, []);

    const policySwitch = document.querySelector<HTMLButtonElement>('[aria-label="打开服务器自动发送策略"]')!;
    assert.equal(policySwitch.disabled, false);
    assert.equal(policySwitch.getAttribute("aria-checked"), "true");
    await act(async () => { policySwitch.click(); await wait(); });
    assert.deepEqual(navigated, ["sla"]);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await wait();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Configuration connection read ordering keeps the newest authoritative snapshot rendered", async () => {
  const viewModel = await import("../features/procurement/channel-connections-view-model.js");
  type Payload = { connections: ChannelConnectionSummary[]; permissions: { manage: boolean }; autoSend: ConfigurationAutoSendSummary };
  type Factory = (
    request: () => Promise<Payload>,
    handlers: { onStart: () => void; onSuccess: (payload: Payload) => void; onError: (error: unknown) => void },
  ) => () => Promise<void>;
  const createLoader = (viewModel as unknown as Record<string, unknown>)["createLatestConfigurationConnectionsLoader"] as Factory | undefined;
  assert.equal(typeof createLoader, "function", "connection reads need a reusable latest-request-wins coordinator");

  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const pending: Array<(payload: Payload) => void> = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === "/api/procurement/tenant-preferences") return json(preferenceResponse());
    throw new Error(`unexpected fetch: ${String(input)}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react");
    const { act, useRef, useState } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementConfigurationWorkbench } = await import("../features/procurement/configuration-workbench.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    const read = () => new Promise<Payload>((resolve) => pending.push(resolve));
    function Harness() {
      const [state, setState] = useState<{ connections: ChannelConnectionSummary[]; autoSend: ConfigurationAutoSendSummary | null; manageable: boolean; loading: boolean; error: string | null; loaded: boolean }>({ connections: [], autoSend: null, manageable: false, loading: false, error: null, loaded: false });
      const loader = useRef<(() => Promise<void>) | null>(null);
      if (!loader.current) loader.current = createLoader!(read, {
        onStart: () => setState((current) => ({ ...current, loading: true, error: null, manageable: false })),
        onSuccess: (payload) => setState({ connections: payload.connections, autoSend: payload.autoSend, manageable: payload.permissions.manage, loading: false, error: null, loaded: true }),
        onError: (error) => setState((current) => ({ ...current, manageable: false, loading: false, error: error instanceof Error ? error.message : String(error) })),
      });
      return <>
        <button type="button" data-load-connections onClick={() => void loader.current?.()}>刷新连接</button>
        <ProcurementConfigurationWorkbench
          mode="settings" connections={state.connections} autoSend={state.autoSend} connectionsManageable={state.manageable}
          loading={state.loading} error={state.error} {...({ connectionSourceLoaded: state.loaded } as Record<string, unknown>)}
          onOpenConnector={() => assert.fail("must not operate connectors")} onDisconnectConnector={() => assert.fail("must not disconnect")} onNavigate={() => undefined}
        >{null}</ProcurementConfigurationWorkbench>
      </>;
    }
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><Harness /></ProcurementTenantPreferencesProvider>);
      await wait(); await wait();
    });
    const refresh = document.querySelector<HTMLButtonElement>("[data-load-connections]")!;
    await act(async () => { refresh.click(); refresh.click(); await wait(); });
    assert.equal(pending.length, 2);
    const newer = connections.map((item) => item.id === "email" ? { ...item, healthMessage: "NEWEST-SNAPSHOT" } : item);
    await act(async () => { pending[1]!({ connections: newer, permissions: { manage: false }, autoSend: autoSend(true) }); await wait(); });
    assert.match(document.body.textContent ?? "", /NEWEST-SNAPSHOT/);
    const older = connections.map((item) => item.id === "email" ? { ...item, healthMessage: "OLDER-SNAPSHOT" } : item);
    await act(async () => { pending[0]!({ connections: older, permissions: { manage: false }, autoSend: autoSend(false) }); await wait(); });
    assert.match(document.body.textContent ?? "", /NEWEST-SNAPSHOT/);
    assert.doesNotMatch(document.body.textContent ?? "", /OLDER-SNAPSHOT/);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await wait(); globalThis.fetch = originalFetch; restore();
  }
});

test("Configuration connection failure never fabricates first-load facts and preserves cached summaries as stale", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/api/procurement/tenant-preferences") return json(preferenceResponse());
    if (path === "/api/procurement/communication-identity") return json({ item: null, readiness: "missing", suggested: {}, permissions: { read: true, configure: false }, legacyDrafts: { withoutIdentity: 0, eligibleForRebind: 0, requiresManualReview: 0, reboundInThisWrite: 0 }, events: [] });
    if (path === "/api/procurement/deployment-profile") return json({ item: null, effectiveMode: "email_only", inheritedDefault: true, evidence: { acceptedEmailPurchaseOrders: 0, odooPurchaseOrders: 0 }, permissions: { read: true, configure: false }, events: [] });
    if (path === "/api/operations/v1-readiness") return json({ status: "blocked", checkedAt: "2026-09-03T08:00:00.000Z", deploymentMode: "email_only", readyGates: 0, totalGates: 0, gates: [], portfolio: { totalPurchaseOrders: 0, activePurchaseOrders: 0, local: 0, import: 0, unclassified: 0, byStage: {}, fiveStageClosedLoop: 0 } });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react"); const { act } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementConfigurationWorkbench } = await import("../features/procurement/configuration-workbench.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    const render = (sourceLoaded: boolean, items: ChannelConnectionSummary[], readiness: ConfigurationAutoSendSummary | null, loading: boolean, error: string | null) => <ProcurementTenantPreferencesProvider><ProcurementConfigurationWorkbench
      mode="settings" governanceMode connections={items} autoSend={readiness} connectionsManageable={false} loading={loading} error={error}
      {...({ connectionSourceLoaded: sourceLoaded } as Record<string, unknown>)}
      onOpenConnector={() => assert.fail("source failure must not manage connectors")} onDisconnectConnector={() => assert.fail("source failure must not disconnect connectors")} onNavigate={() => undefined}
    >{null}</ProcurementConfigurationWorkbench></ProcurementTenantPreferencesProvider>;
    const connectionStateText = () => [
      document.querySelector<HTMLElement>('[aria-label="通信连接"]'),
      document.querySelector<HTMLElement>('[aria-label="AI 解析服务连接"]'),
      document.querySelector<HTMLElement>('[aria-label="业务系统连接"]'),
      document.querySelector<HTMLElement>("#auto-send-follow-ups"),
    ].map((element) => element?.textContent ?? "").join(" ");
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(render(false, [], null, true, null)); await wait(); await wait();
    });
    assert.equal(document.querySelectorAll("[data-connection-id]").length, 0);
    assert.doesNotMatch(connectionStateText(), /7 项阻塞|0\/3|凭据状态记录/);
    for (const message of ["会话已过期", "当前角色无读取权限", "连接摘要服务暂时不可用"]) {
      await act(async () => { root!.render(render(false, [], null, false, message)); await wait(); await wait(); });
      assert.equal(document.querySelectorAll("[data-connection-id]").length, 0);
      assert.doesNotMatch(connectionStateText(), /未配置|7 项阻塞|0\/3|凭据状态记录/);
      assert.match(connectionStateText(), new RegExp(message));
    }
    await act(async () => { root!.render(render(true, connections, autoSend(false), false, null)); await wait(); await wait(); });
    assert.equal(document.querySelectorAll("[data-connection-id]").length, 4);
    await act(async () => { root!.render(render(true, connections, autoSend(false), false, "source unavailable")); await wait(); await wait(); });
    assert.equal(document.querySelectorAll("[data-connection-id]").length, 4);
    assert.match(document.body.textContent ?? "", /上次成功读取/);
    assert.match(document.querySelector<HTMLElement>('[data-connection-id="email"]')?.textContent ?? "", /Pending/);
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-connection-id] button")) assert.equal(button.disabled, true);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await wait(); globalThis.fetch = originalFetch; restore();
  }
});

test("Configuration role connector and auto-send matrices stay capability-bound and fail closed", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const opened: string[] = [];
  const disconnected: string[] = [];
  const navigated: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/api/procurement/tenant-preferences") return json(preferenceResponse());
    if (path === "/api/procurement/communication-identity") return json({ item: null, readiness: "missing", suggested: {}, permissions: { read: true, configure: false }, legacyDrafts: { withoutIdentity: 0, eligibleForRebind: 0, requiresManualReview: 0, reboundInThisWrite: 0 }, events: [] });
    if (path === "/api/procurement/deployment-profile") return json({ item: null, effectiveMode: "email_only", inheritedDefault: true, evidence: { acceptedEmailPurchaseOrders: 0, odooPurchaseOrders: 0 }, permissions: { read: true, configure: false }, events: [] });
    if (path === "/api/operations/v1-readiness") return json({ status: "blocked", checkedAt: "2026-09-03T08:00:00.000Z", deploymentMode: "email_only", readyGates: 0, totalGates: 0, gates: [], portfolio: { totalPurchaseOrders: 0, activePurchaseOrders: 0, local: 0, import: 0, unclassified: 0, byStage: {}, fiveStageClosedLoop: 0 } });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react"); const { act } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementConfigurationWorkbench } = await import("../features/procurement/configuration-workbench.js");
    const { buildChannelConnectionViews } = await import("../features/procurement/channel-connections-view-model.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    const render = (items: ChannelConnectionSummary[], manageable: boolean, readiness: ConfigurationAutoSendSummary, error: string | null = null) => <ProcurementTenantPreferencesProvider><ProcurementConfigurationWorkbench
      mode="settings" governanceMode connections={items} autoSend={readiness} connectionsManageable={manageable} loading={false} error={error} connectionSourceLoaded
      onOpenConnector={(id) => opened.push(id)} onDisconnectConnector={(id) => disconnected.push(id)} onNavigate={(target) => navigated.push(target)}
    >{manageable ? <div data-testid="admin-connector-control-plane">管理员连接器控制面</div> : null}</ProcurementConfigurationWorkbench></ProcurementTenantPreferencesProvider>;
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(render(connections, false, autoSend(false))); await wait(); await wait();
    });

    for (const role of ["buyer", "manager"] as const) {
      await act(async () => { root!.render(render(connections, false, autoSend(false))); await wait(); });
      assert.equal(document.querySelectorAll('[aria-label="通信连接"] [data-connection-id]').length, 2, `${role} sees two primary communication summaries; Weixin is managed by Hermes`);
      assert.equal(document.querySelectorAll('[aria-label="AI 解析服务连接"] [data-connection-id]').length, 1, `${role} sees DeepSeek separately`);
      assert.equal(document.querySelectorAll('[aria-label="业务系统连接"] [data-connection-id]').length, 1, `${role} sees ERP separately`);
      for (const button of document.querySelectorAll<HTMLButtonElement>("[data-connection-id] button")) assert.equal(button.disabled, true, `${role} cannot manage connectors`);
      const advanced = document.querySelector<HTMLButtonElement>('[aria-controls="advanced-governance-content"]')!;
      await act(async () => { advanced.click(); await wait(); });
      assert.equal(document.querySelector('[data-testid="admin-connector-control-plane"]'), null, `${role} never mounts the admin control plane`);
      await act(async () => { advanced.click(); await wait(); });
    }

    await act(async () => { root!.render(render(connections, true, autoSend(false))); await wait(); });
    assert.equal(document.querySelector('[data-connection-id="wechat"]'), null);
    for (const id of ["email", "whatsapp", "deepseek", "erp"] as const) {
      assert.ok(document.querySelector<HTMLButtonElement>(`[data-connection-id="${id}"] button:not(:disabled)`), `admin can manage ${id}`);
    }
    const whatsappText = document.querySelector<HTMLElement>('[data-connection-id="whatsapp"]')?.textContent ?? "";
    assert.match(whatsappText, /Meta WhatsApp Cloud API/);
    assert.doesNotMatch(whatsappText, /\bQR\b|pairing|Linked Devices/i);

    const baseEmail = connections.find((item) => item.id === "email")!;
    const variants: Array<{ label: string; value: ChannelConnectionSummary; state: string; action: RegExp }> = [
      { label: "available", value: { ...baseEmail, status: "available", runtimeHealthy: false, credentialReady: false, externalVerified: false, credentialCount: 0, healthMessage: "Available for installation" }, state: "setup_required", action: /配置并验证/ },
      { label: "installed-unverified", value: { ...baseEmail, status: "installed", runtimeHealthy: true, credentialReady: true, externalVerified: false, credentialCount: 1, healthMessage: "Awaiting external test" }, state: "test_required", action: /去测试连接/ },
      { label: "installed-verified", value: { ...baseEmail, status: "installed", runtimeHealthy: true, credentialReady: true, externalVerified: true, credentialCount: 1, healthMessage: "Verified" }, state: "connected", action: /查看连接/ },
      { label: "disabled", value: { ...baseEmail, status: "disabled", runtimeHealthy: false, credentialReady: false, externalVerified: false, credentialCount: 1, healthMessage: "Disabled by administrator" }, state: "disabled", action: /去启用/ },
      { label: "failed", value: { ...baseEmail, status: "failed", runtimeHealthy: false, credentialReady: false, externalVerified: false, credentialCount: 1, healthMessage: "Runtime failed" }, state: "attention", action: /修复连接/ },
      { label: "runtime-unhealthy", value: { ...baseEmail, status: "installed", runtimeHealthy: false, credentialReady: true, externalVerified: true, credentialCount: 1, healthMessage: "Runtime unhealthy" }, state: "attention", action: /修复连接/ },
      { label: "credential-revoked", value: { ...baseEmail, status: "installed", runtimeHealthy: true, credentialReady: false, externalVerified: false, credentialCount: 1, healthMessage: "Credential revoked" }, state: "attention", action: /修复连接/ },
    ];
    for (const variant of variants) {
      const items = connections.map((item) => item.id === "email" ? variant.value : item);
      const email = buildChannelConnectionViews(items).find((item) => item.id === "email")!;
      assert.equal(email.state, variant.state, `${variant.label} state`);
      assert.match(email.actionLabel, variant.action, `${variant.label} action`);
      assert.equal(email.detail, variant.value.healthMessage, `${variant.label} keeps source health text`);
    }
    const revokedItems = connections.map((item) => item.id === "email" ? variants.at(-1)!.value : item);
    await act(async () => { root!.render(render(revokedItems, true, autoSend(false))); await wait(); });
    assert.match(document.querySelector<HTMLElement>('[data-connection-id="email"]')?.textContent ?? "", /Credential revoked|凭据已撤销/);
    assert.match(document.querySelector<HTMLElement>('[data-connection-id="email"]')?.textContent ?? "", /修复连接/);

    const gateIds = ["permission", "published_profile", "communication_identity", "allowlists", "supplier_target", "connector", "kill_switch"] as const;
    for (const blockedId of gateIds) {
      const ready = autoSend(true);
      ready.enabled = false;
      ready.ready = false;
      ready.gates = ready.gates.map((gate) => gate.id === blockedId ? { ...gate, status: "blocked", detail: `Blocked: ${blockedId}` } : gate);
      ready.blockers = ready.gates.filter((gate) => gate.status === "blocked");
      await act(async () => { root!.render(render(connections, false, ready)); await wait(); });
      assert.match(document.querySelector("#auto-send-follow-ups")?.textContent ?? "", /1 项阻塞/);
      assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="打开服务器自动发送策略"]')?.disabled, true, `${blockedId} blocks auto-send`);
      assert.match(document.querySelector<HTMLElement>(`[data-auto-send-gate="${blockedId}"]`)?.textContent ?? "", new RegExp(`Blocked: ${blockedId}`));
    }

    await act(async () => { root!.render(render(connections, false, autoSend(true))); await wait(); });
    const policySwitch = document.querySelector<HTMLButtonElement>('[aria-label="打开服务器自动发送策略"]')!;
    assert.equal(policySwitch.disabled, false);
    await act(async () => { policySwitch.click(); await wait(); });
    assert.deepEqual(navigated, ["sla"]);

    await act(async () => { root!.render(render(connections, true, autoSend(true), "cached source unavailable")); await wait(); });
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="打开服务器自动发送策略"]')?.disabled, true, "stale readiness cannot remain actionable");
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-connection-id] button")) assert.equal(button.disabled, true, "stale connection actions are disabled");
    assert.deepEqual(opened, []);
    assert.deepEqual(disconnected, []);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await wait(); globalThis.fetch = originalFetch; restore();
  }
});

function preferenceResponse(version = 1, countryCode = "CN", configure = true): ProcurementTenantPreferencesResponse {
  const effective = { countryCode, workingDays: [1, 2, 3, 4, 5], timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD" as const, slaEscalationsEnabled: true, excludeWeekends: true, excludePublicHolidays: true, autoCalculateLeadTime: true };
  return { item: { ...effective, version, createdBy: "Supplier", updatedBy: "Pending", createdAt: "2026-09-06T08:00:00.000Z", updatedAt: "2026-09-06T08:00:00.000Z" }, effective, inheritedDefault: false, permissions: { read: true, configure }, events: [] };
}

function failure(status: number, error: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ error, ...extra }), { status, headers: { "content-type": "application/json" } });
}

async function mountPreferences(boundary: (init?: RequestInit) => Response | Promise<Response>) {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  const previousAct = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "/api/procurement/tenant-preferences");
    return boundary(init);
  }) as typeof fetch;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ProcurementConfigurationWorkbench } = await import("../features/procurement/configuration-workbench.js");
  const { ProcurementTenantPreferencesProvider, useProcurementTenantPreferences } = await import("../features/procurement/tenant-preferences-context.js");
  let context: ReturnType<typeof useProcurementTenantPreferences>;
  function CapturePreferences() { context = useProcurementTenantPreferences(); return null; }
  const root = createRoot(host);
  await act(async () => {
    root.render(<ProcurementTenantPreferencesProvider><CapturePreferences /><ProcurementConfigurationWorkbench mode="settings" connections={[]} autoSend={null} connectionsManageable={false} loading={false} onOpenConnector={() => assert.fail("must not operate connectors")} onDisconnectConnector={() => assert.fail("must not disconnect")} onNavigate={() => undefined}>{null}</ProcurementConfigurationWorkbench></ProcurementTenantPreferencesProvider>);
    await wait();
  });
  await act(async () => {
    const disclosure = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("调整工作日和时区"));
    assert.ok(disclosure, "preferences disclosure must remain available");
    disclosure.click();
    await wait();
  });
  return {
    act,
    context: () => context!,
    country: () => document.querySelector<HTMLSelectElement>("#tenant-preferences select")!,
    saveButton: () => document.querySelector<HTMLButtonElement>('button[form="tenant-preferences-form"]')!,
    selectCountry: async (value: string) => { await act(async () => { const select = document.querySelector<HTMLSelectElement>("#tenant-preferences select")!; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); },
    submit: async (count = 1) => { await act(async () => { for (let index = 0; index < count; index++) document.querySelector("#tenant-preferences-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await wait(); }); },
    reload: async () => { await act(async () => { document.querySelector<HTMLButtonElement>('#tenant-preferences [role="alert"] button')!.click(); await wait(); }); },
    close: async () => { await act(async () => root.unmount()); await wait(); globalThis.fetch = originalFetch; (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = previousAct; restore(); },
  };
}

test("Configuration save prevents same-tick duplicates and preserves input/version on 409 until explicit reload", async () => {
  let current = preferenceResponse();
  let reads = 0;
  const writes: Array<Record<string, unknown>> = [];
  let finish!: (response: Response) => void;
  const h = await mountPreferences((init) => {
    if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return new Promise<Response>((resolve) => { finish = resolve; }); }
    reads++; return json(current);
  });
  try {
    assert.equal(h.saveButton().disabled, true, "unchanged preferences are not actionable");
    await h.selectCountry("SG");
    assert.equal(h.saveButton().disabled, false);
    await h.submit(2);
    assert.equal(writes.length, 1, "same-tick form submits make one PUT");
    assert.equal(h.country().disabled, true);
    assert.equal(h.saveButton().disabled, true);
    assert.match(h.saveButton().textContent ?? "", /保存中/);
    current = preferenceResponse(2, "JP");
    await h.act(async () => { finish(failure(409, "version conflict", { currentVersion: 2 })); await wait(); });
    assert.equal(reads, 1, "conflict must not silently load and discard edits");
    assert.equal(h.country().value, "SG");
    assert.match(document.querySelector('#tenant-preferences [role="alert"]')?.textContent ?? "", /保留.*v2/);
    assert.equal(h.saveButton().disabled, true, "reload/review required before another stale write");
    await h.submit(); assert.equal(writes.length, 1);
    await h.reload();
    assert.equal(reads, 2);
    assert.equal(h.country().value, "JP");
    assert.equal(document.querySelector('#tenant-preferences [role="alert"]'), null);
    await h.selectCountry("GB");
    await h.submit(); assert.equal(writes[1]?.expectedVersion, 2);
    await h.act(async () => { finish(json(preferenceResponse(3, "GB"))); await wait(); });
    assert.match(document.querySelector('#tenant-preferences [role="status"]')?.textContent ?? "", /已保存/);
  } finally { await h.close(); }
});

test("Configuration 422 keeps edits and allows correction; uncertain transport outcome requires a read before retry", async () => {
  let writeStatus = 422;
  let writes = 0;
  const h = await mountPreferences((init) => {
    if (init?.method !== "PUT") return json(preferenceResponse());
    writes++;
    if (writeStatus === 0) throw new Error("transport lost after dispatch");
    return failure(writeStatus, "Pending");
  });
  try {
    await h.selectCountry("SG"); await h.submit();
    assert.equal(h.country().value, "SG");
    assert.match(document.querySelector('#tenant-preferences [role="alert"]')?.textContent ?? "", /Pending/);
    assert.equal(h.saveButton().disabled, false);
    writeStatus = 0; await h.selectCountry("JP"); await h.submit();
    assert.equal(writes, 2); assert.equal(h.country().value, "JP");
    assert.match(document.querySelector('#tenant-preferences [role="alert"]')?.textContent ?? "", /结果尚未确认/);
    assert.equal(h.saveButton().disabled, true);
    await h.submit(); assert.equal(writes, 2);
    await h.reload(); assert.equal(h.country().value, "CN");
  } finally { await h.close(); }
});

test("Configuration 403 is not a default form; read-only and revoked permissions cannot submit", async () => {
  let readable = false;
  let current = preferenceResponse(3, "SG", false);
  let writes = 0;
  const h = await mountPreferences((init) => {
    if (init?.method === "PUT") { writes++; return failure(403, "forbidden"); }
    return readable ? json(current) : failure(403, "forbidden");
  });
  try {
    assert.equal(h.country(), null);
    assert.equal(h.saveButton().disabled, true);
    assert.match(document.querySelector('#tenant-preferences [role="alert"]')?.textContent ?? "", /读取.*权限.*管理员/);
    await h.submit(); assert.equal(writes, 0);
    readable = true; await h.reload();
    assert.equal(h.country().value, "SG"); assert.equal(h.country().disabled, true);
    await h.submit(); assert.equal(writes, 0);
    current = preferenceResponse(3, "SG", true);
    await h.act(async () => { await h.context().refresh(); });
    await h.selectCountry("JP"); await h.submit();
    assert.equal(writes, 1); assert.equal(h.country().value, "JP");
    assert.equal(h.saveButton().disabled, true);
    await h.submit(); assert.equal(writes, 1);
  } finally { await h.close(); }
});

test("Configuration preserves cached edits on failed refresh and ignores older reads after an accepted write", async () => {
  let nextRead: () => Response | Promise<Response> = () => json(preferenceResponse());
  const h = await mountPreferences(() => nextRead());
  try {
    await h.selectCountry("SG");
    nextRead = () => failure(500, "source unavailable");
    await h.act(async () => { await h.context().refresh(); });
    assert.equal(h.country().value, "SG");
    assert.match(document.querySelector('#tenant-preferences [role="alert"]')?.textContent ?? "", /上次成功读取/);
    assert.equal(h.saveButton().disabled, true);
    let finish!: (response: Response) => void;
    nextRead = () => new Promise<Response>((resolve) => { finish = resolve; });
    let pending!: Promise<void>;
    await h.act(async () => { pending = h.context().refresh(); });
    await h.act(async () => { h.context().acceptResponse(preferenceResponse(3, "JP")); });
    assert.equal(h.context().loading, false);
    await h.act(async () => { finish(json(preferenceResponse(2, "GB"))); await pending; });
    assert.equal(h.country().value, "JP");
    assert.equal(h.context().response?.item?.version, 3);
  } finally { await h.close(); }
});

test("Configuration 将凭据连接卡留在主流程，并按需显示真实消息网关运行事实", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/api/procurement/tenant-preferences") return json(preferenceResponse());
    if (path === "/api/messaging/gateway") return json({ status: "degraded", checkedAt: "2026-09-08T08:00:00.000Z", permissions: { manage: false }, adapters: [{ id: "email", channel: "email", provider: "smtp", status: "degraded", capabilities: ["send"], version: 7, consecutiveFailures: 2, lastHealthAt: null, lastError: "SMTP 连接超时", pauseReason: null, pendingInbound: 0, pendingDeliveries: 1, exceptionalDeliveries: 1 }] });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react"); const { act } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementConfigurationWorkbench } = await import("../features/procurement/configuration-workbench.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    await act(async () => {
      root = createRoot(host);
      root.render(<ProcurementTenantPreferencesProvider><ProcurementConfigurationWorkbench mode="settings" connections={connections} autoSend={autoSend(false)} connectionsManageable={false} loading={false} onOpenConnector={() => undefined} onDisconnectConnector={() => undefined} onNavigate={() => undefined}>{null}</ProcurementConfigurationWorkbench></ProcurementTenantPreferencesProvider>);
      await wait(); await wait();
    });
    assert.match(document.querySelector<HTMLElement>("[data-connection-id=email]")?.textContent ?? "", /凭据/);
    assert.equal(document.querySelector("[aria-label=消息网关运行状态]"), null, "网关诊断不应抢占首屏");
    const diagnostics = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("查看系统诊断"))!;
    await act(async () => { diagnostics.click(); await wait(); await wait(); });
    const gateway = document.querySelector<HTMLElement>("[aria-label=消息网关运行状态]")!;
    assert.match(gateway.textContent ?? "", /性能下降/);
    assert.match(gateway.textContent ?? "", /SMTP 连接超时/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch; restore();
  }
});
