import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://readywork.test/?lang=en" });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    FormData: dom.window.FormData,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = value;
  }
  return {
    host: dom.window.document.querySelector<HTMLDivElement>("#root")!,
    restore: () => {
      for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
      dom.window.close();
    },
  };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 0));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("public demo enters without credentials and keeps a synthetic-data banner visible", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let sessionChecks = 0;
  let entryWrites = 0;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/auth/me") {
      sessionChecks += 1;
      return sessionChecks === 1
        ? json({ error: "Unauthenticated" }, 401)
        : json({ ok: true, account: { username: "public-demo", name: "Demo Procurement Manager", role: "Procurement Manager", humanId: "h:public-demo-manager" }, expiresAt: "2026-09-13T12:00:00.000Z", demoMode: true });
    }
    if (path === "/api/auth/config") return json({ mode: "public_demo", passwordLogin: false, demoMode: true });
    if (path === "/api/auth/public-demo" && init?.method === "POST") {
      entryWrites += 1;
      return json({ ok: true, account: { username: "public-demo", name: "Demo Procurement Manager", role: "Procurement Manager", humanId: "h:public-demo-manager" }, expiresAt: "2026-09-13T12:00:00.000Z", demoMode: true });
    }
    if (path === "/api/public-demo/status") return json({ demoMode: true, tenantId: "t:public-demo", seedVersion: "public-demo-v1", generation: 7, resetAt: "2026-09-13T04:00:00.000Z", status: "healthy" });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { AuthGate } = await import("../features/auth/auth-gate.js");
    const { UiLanguageProvider } = await import("../features/localization/ui-language.js");
    const { PublicDemoProvider } = await import("../features/public-demo/public-demo-context.js");
    const { PublicDemoFrame } = await import("../features/public-demo/public-demo-banner.js");
    await act(async () => {
      root = createRoot(host);
      root.render(<PathnameContext.Provider value="/"><UiLanguageProvider><PublicDemoProvider><PublicDemoFrame><AuthGate><div data-testid="workspace">workspace</div></AuthGate></PublicDemoFrame></PublicDemoProvider></UiLanguageProvider></PathnameContext.Provider>);
      await wait();
      await wait();
    });
    const enter = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Enter public demo");
    assert.ok(enter, host.textContent ?? "public demo entry not rendered");
    await act(async () => { enter.click(); await wait(); await wait(); });
    assert.equal(entryWrites, 1);
    assert.equal(host.querySelector('[data-testid="workspace"]')?.textContent, "workspace");
    assert.match(host.textContent ?? "", /Public demo · synthetic data · external delivery disabled/);
    assert.match(host.textContent ?? "", /Generation 7/);
  } finally {
    if (root) await import("react").then(({ act }) => act(async () => root!.unmount()));
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("public demo settings never mount connector, credential, or upload controls", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  globalThis.fetch = (async () => json({
    item: null,
    effective: { countryCode: "CN", workingDays: [1, 2, 3, 4, 5], timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", slaEscalationsEnabled: true, excludeWeekends: true, excludePublicHolidays: true, autoCalculateLeadTime: true },
    inheritedDefault: true,
    permissions: { read: true, configure: false },
    events: [],
  })) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ProcurementConfigurationWorkbench } = await import("../features/procurement/configuration-workbench.js");
    const { UiLanguageProvider } = await import("../features/localization/ui-language.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    await act(async () => {
      root = createRoot(host);
      root.render(<UiLanguageProvider><ProcurementTenantPreferencesProvider><ProcurementConfigurationWorkbench
        mode="settings"
        publicDemo
        governanceMode
        connections={[]}
        autoSend={null}
        connectionsManageable
        loading={false}
        onOpenConnector={() => { throw new Error("connector control must stay unreachable"); }}
        onDisconnectConnector={() => { throw new Error("connector control must stay unreachable"); }}
        onNavigate={() => { throw new Error("configuration mutation must stay unreachable"); }}
      ><button type="button" data-testid="credential-control">Add credential</button></ProcurementConfigurationWorkbench></ProcurementTenantPreferencesProvider></UiLanguageProvider>);
      await wait();
    });
    assert.equal(host.querySelector('[data-testid="credential-control"]'), null);
    assert.match(host.textContent ?? "", /Public demo safety boundary/);
    assert.match(host.textContent ?? "", /Connector and credential configuration is unavailable/);
    assert.equal(host.querySelector('button[type="submit"]'), null);
  } finally {
    if (root) await import("react").then(({ act }) => act(async () => root!.unmount()));
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("public demo mutations carry the in-memory generation and refresh after a reset conflict", async () => {
  const { restore } = installDom();
  const originalFetch = globalThis.fetch;
  let generation = 4;
  let conflictRefreshes = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "/api/procurement/notifications/read-all");
    assert.equal(new Headers(init?.headers).get("x-readywork-demo-generation"), "4");
    return json({ error: "公开演示数据已重置，请刷新页面后重试", code: "DEMO_GENERATION_CONFLICT", currentGeneration: 5 }, 409);
  }) as typeof fetch;
  try {
    const { apiRequest, configurePublicDemoApiRuntime, ReadyworkApiError } = await import("../features/shared/api-client.js");
    const dispose = configurePublicDemoApiRuntime({
      getGeneration: () => generation,
      onGeneration: (next) => { generation = next; },
      onGenerationConflict: async () => { conflictRefreshes += 1; generation = 5; },
    });
    await assert.rejects(
      () => apiRequest("/api/procurement/notifications/read-all", { method: "POST" }),
      (error: unknown) => error instanceof ReadyworkApiError
        && error.status === 409
        && (error.payload as { code?: string }).code === "DEMO_GENERATION_CONFLICT",
    );
    assert.equal(conflictRefreshes, 1);
    assert.equal(generation, 5);
    dispose();
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("public demo banner shows that a reset conflict refreshed the current view", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let statusReads = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path === "/api/public-demo/status") {
      statusReads += 1;
      return json({ demoMode: true, tenantId: "t:public-demo", seedVersion: "public-demo-v1", generation: 8, resetAt: "2026-09-13T05:00:00.000Z", status: "healthy" });
    }
    if (path === "/api/procurement/notifications/read-all") {
      return json({ error: "reset", code: "DEMO_GENERATION_CONFLICT", currentGeneration: 8 }, 409);
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { apiRequest } = await import("../features/shared/api-client.js");
    const { UiLanguageProvider } = await import("../features/localization/ui-language.js");
    const { PublicDemoProvider } = await import("../features/public-demo/public-demo-context.js");
    const { PublicDemoFrame } = await import("../features/public-demo/public-demo-banner.js");
    await act(async () => {
      root = createRoot(host);
      root.render(<PathnameContext.Provider value="/"><UiLanguageProvider><PublicDemoProvider><PublicDemoFrame><div>workspace</div></PublicDemoFrame></PublicDemoProvider></UiLanguageProvider></PathnameContext.Provider>);
      await wait();
    });
    await act(async () => {
      await apiRequest("/api/public-demo/status");
      await assert.rejects(() => apiRequest("/api/procurement/notifications/read-all", { method: "POST" }));
      await wait();
    });
    assert.equal(statusReads, 2, "the conflict handler must re-read authoritative demo status");
    assert.match(host.textContent ?? "", /Public demo data was reset; this view has been refreshed/);
    assert.match(host.textContent ?? "", /Generation 8/);
  } finally {
    if (root) await import("react").then(({ act }) => act(async () => root!.unmount()));
    globalThis.fetch = originalFetch;
    restore();
  }
});
