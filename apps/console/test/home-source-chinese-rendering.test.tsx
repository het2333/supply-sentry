import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

type PortfolioFixture = ReturnType<typeof portfolioFixture>;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function portfolioFixture() {
  const local = {
    id: "po:source-zh", number: "PO-SOURCE-ZH", supplierId: "supplier:local", supplierName: "Local", route: "local",
    materialType: "Direct", status: "active", stage: "supplier_commitment", stageLabel: "Supplier supplied stage prose",
    requiredInHouseAt: "2026-09-12T00:00:00.000Z", overdueDays: 0, risk: "medium", riskScore: 45,
    riskFactors: [{ code: "supplier_no_response", label: "Supplier evidence label", score: 45, evidence: "Original evidence prose" }],
    nextAction: "Keep original supplier wording", currency: "CNY", amountTotal: 1200, supplierPerformanceScore: 80, active: true,
    routeRiskBucket: "awaiting_supplier",
  };
  const unclassified = {
    ...local, id: "po:unclassified", number: "PO-UNCLASSIFIED", supplierId: "supplier:draft", supplierName: "Draft",
    route: "unclassified", materialType: "Imported Fabric", risk: "high", riskScore: 91, routeRiskBucket: "high_risk",
  };
  return {
    generatedAt: "2026-09-06T00:00:00.000Z",
    metrics: { highRisk: 1, overdue: 0, requireAttention: 1, activePurchaseOrders: 2, localProcurement: 1, importProcurement: 0, unclassifiedRoute: 1, atRiskValueByCurrency: {} },
    riskDistribution: { high: 1, medium: 1, low: 0 },
    routes: {
      local: { total: 1, high: 0, awaitingSupplier: 1, deliveryRisk: 0, onTrack: 0 },
      import: { total: 0, high: 0, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 0 },
      unclassified: { total: 1, high: 1, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 0 },
    },
    highlights: [{ code: "supplier_no_response", count: 1, severity: "medium", message: "Backend highlight prose remains data" }],
    items: [local, unclassified],
  } as const;
}

async function withDashboard(options: { portfolio?: PortfolioFixture; forbidden?: boolean } = {}, check: (helpers: {
  act: typeof import("react").act;
  button: (text: string | RegExp, scope?: ParentNode) => HTMLButtonElement;
}) => Promise<void>) {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://readywork.test/" });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter, PointerEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
  Object.assign(globalThis, globals);
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: globals.requestAnimationFrame });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: globals.cancelAnimationFrame });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  const originalFetch = globalThis.fetch;
  const fixture = options.portfolio ?? portfolioFixture();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith("/api/procurement/tenant-preferences")) return response({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path.startsWith("/api/procurement/workbench")) return options.forbidden ? response({ error: "forbidden" }, 403) : response({ portfolio: fixture });
    if (path.startsWith("/api/procurement/risk-dashboard")) return response({
      range: { from: "2026-08-08", to: "2026-09-06" }, trend: [], snapshotCount: 0,
      freshness: { state: "missing", reason: null, evaluatedAt: "", currentSourceWatermark: "watermark:current", latestSnapshotSourceWatermark: null, latestSnapshotAt: null },
    });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ProcurementHomeDashboard } = await import("../features/procurement/home-dashboard.js");
  const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
  const root = createRoot(document.querySelector("#root")!);
  try {
    await act(async () => {
      root.render(<ProcurementTenantPreferencesProvider><ProcurementHomeDashboard onNavigate={() => undefined} /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = (text: string | RegExp, scope: ParentNode = document) => {
      const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((entry) => typeof text === "string" ? entry.textContent?.trim() === text : text.test(entry.textContent ?? ""));
      assert.ok(found, `missing button ${String(text)}`);
      return found;
    };
    await check({ act, button });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  }
}

test("Home renders system UI in source Chinese while preserving business data", async () => {
  await withDashboard({}, async ({ act, button }) => {
    assert.equal(document.querySelector("h1")?.textContent?.trim(), "总览");
    assert.deepEqual([...document.querySelectorAll("thead th")].map((cell) => cell.textContent?.trim()), ["PO 编号", "供应商", "路线", "物料类型", "当前阶段", "要求到货日期（RIHD）", "风险", "下一步操作", "操作"]);
    assert.match(document.body.textContent ?? "", /显示第 1 至 2 条，共 2 条记录/);
    assert.match(document.body.textContent ?? "", /1 张采购订单仍在等待供应商确认/);
    assert.match(document.body.textContent ?? "", /1 张活跃采购订单缺少已持久化的路线证据/);
    assert.match(document.body.textContent ?? "", /AI 采购摘要/);
    assert.match(document.body.textContent ?? "", /今日重点/);

    const preserved = [...document.querySelectorAll<HTMLElement>("[data-preserve-language]")].map((element) => element.textContent?.trim());
    for (const value of ["Local", "Draft", "Direct", "Imported Fabric", "Keep original supplier wording"]) assert.ok(preserved.includes(value), `business value changed: ${value}`);
    assert.match(document.body.textContent ?? "", /PO-SOURCE-ZH/);

    assert.equal(document.querySelector("svg[aria-label]")?.getAttribute("aria-label"), "已持久化采购组合快照趋势");
    assert.ok(document.querySelector('[aria-label="本地采购：等待供应商"]'));
    assert.match(document.body.textContent ?? "", /本地采购\s*— 风险概览/);

    const dateTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="选择总览趋势日期范围"]');
    assert.ok(dateTrigger);
    await act(async () => { dateTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dateDialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="总览趋势日期范围"]');
    assert.ok(dateDialog);
    assert.deepEqual([...dateDialog.querySelectorAll<HTMLElement>("[data-quick-range]")].map((entry) => entry.textContent?.trim()), ["今天", "最近 7 天", "最近 30 天", "本季度", "今年至今"]);
    assert.ok(dateDialog.querySelector('[role="grid"][aria-label="月历"]'));
    assert.deepEqual([...dateDialog.querySelectorAll<HTMLElement>("[data-calendar-weekday]")].map((entry) => entry.textContent), ["日", "一", "二", "三", "四", "五", "六"]);
    assert.match(dateDialog.textContent ?? "", /0 个已保存快照/);

    await act(async () => button("取消", dateDialog).click());
    await act(async () => button("路线").click());
    const routeMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="路线"]');
    assert.deepEqual([...routeMenu!.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent?.trim()), ["本地", "进口", "未分类"]);
    await act(async () => routeMenu!.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());

    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="PO-SOURCE-ZH 操作"]')!.click());
    const actions = document.querySelector<HTMLElement>('[role="menu"][aria-label="PO-SOURCE-ZH 操作"]');
    assert.deepEqual([...actions!.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent?.trim()), ["查看详情", "发送跟进", "编辑 RIHD", "标记为风险"]);

    const systemEnglish = /Track and manage|High Risk|Overdue POs|Require Attention|Purchase Orders|Quick ranges|Saved snapshots|Review High-Risk|Risk Overview|Showing .* entries|View details|Send follow-up|Mark at risk/;
    assert.doesNotMatch(document.body.textContent ?? "", systemEnglish);
  });
});

test("Home renders its permission error in source Chinese", async () => {
  await withDashboard({ forbidden: true }, async () => {
    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.equal(alert.textContent?.trim(), "当前会话没有读取采购订单组合的权限。");
  });
});
