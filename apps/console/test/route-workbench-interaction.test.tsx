import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { ReactNode } from "react";

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://readywork.test/" });
  const previous = new Map<string, unknown>();
  let animationFrameId = 0;
  const requestTestFrame = (callback: FrameRequestCallback) => {
    animationFrameId += 1;
    if (animationFrameId <= 500) setTimeout(() => callback(Date.now()), 0);
    return animationFrameId;
  };
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    DOMRect: dom.window.DOMRect,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: requestTestFrame,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    PointerEvent: dom.window.MouseEvent,
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = value;
  }
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: requestTestFrame });
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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function changeInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeSelect(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeTextArea(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function pointerClick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  element.click();
}

function selectMenuItem(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
  element.click();
}

async function interactWithPortal(action: () => void): Promise<void> {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
  try {
    action();
    await wait();
    await wait();
  } finally {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  }
}

const readiness = {
  queue_followup: { ready: true, code: "ready", message: "Ready" },
  update_rihd: { ready: true, code: "ready", message: "Ready" },
  mark_at_risk: { ready: true, code: "ready", message: "Ready" },
};

function portfolioItem(overrides: Record<string, unknown>) {
  return {
    id: "po:alpha",
    version: 2,
    number: "PO-LOCAL-001",
    supplierId: "supplier:alpha",
    supplierName: "Alpha Textiles",
    route: "local",
    routeSource: "manual",
    routeAssignmentVersion: 1,
    routeEvidence: {},
    routeEvidenceCandidates: [],
    routeRiskBucket: "high_risk",
    materialType: "Direct",
    status: "sent",
    stage: "supplier_commitment",
    stageLabel: "Supplier Commitment",
    requiredInHouseAt: "2026-09-08T00:00:00.000Z",
    overdueDays: 0,
    risk: "high",
    riskScore: 85,
    riskFactors: [
      { code: "supplier_no_response", label: "供应商未确认", score: 82, evidence: "72 小时无有效回复" },
    ],
    nextAction: "Follow up for a committed delivery date.",
    currency: "USD",
    amountTotal: 19800,
    active: true,
    actionReadiness: readiness,
    shipmentCount: 0,
    receiptCount: 0,
    transportEventCount: 0,
    latestShipment: null,
    latestTransportEvent: null,
    customsStatus: null,
    latestReceipt: null,
    importDocumentEvaluation: null,
    ...overrides,
  };
}

const portfolio = {
  generatedAt: "2026-09-03T00:00:00.000Z",
  metrics: { unclassifiedRoute: 0 },
  routes: {
    local: { total: 2, high: 1, awaitingSupplier: 1, deliveryRisk: 0, onTrack: 1 },
    import: { total: 1, high: 0, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 1 },
    unclassified: { total: 0, high: 0, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 0 },
  },
  items: [
    portfolioItem({}),
    portfolioItem({
      id: "po:beta",
      number: "PO-LOCAL-002",
      supplierId: "supplier:beta",
      supplierName: "Beta Mills",
      stage: "po_sent",
      stageLabel: "PO Sent",
      risk: "medium",
      riskScore: 55,
      requiredInHouseAt: "2026-09-20T00:00:00.000Z",
      amountTotal: 12750,
    }),
    portfolioItem({
      id: "po:import",
      number: "PO-IMPORT-001",
      supplierId: "supplier:import",
      supplierName: "Supplier",
      route: "import",
      materialType: "Custom Blend",
      stage: "custom_stage",
      stageLabel: "Vendor Custom Gate",
      risk: "low",
      riskScore: 10,
      riskFactors: [{ code: "custom_vendor_hold", label: "Pending", score: 76, evidence: "Supplier" }],
      nextAction: "Supplier",
    }),
  ],
};

const emptyChat = {
  conversation: null,
  messages: [],
  suggestedQuestions: [],
  permissions: { operate: true },
  capabilities: { attachments: { supported: false, reason: "Text only", field: "file", accept: [".pdf"], maxBytes: 8388608, multipart: false } },
  model: { configured: true, route: "fast", name: "test-model", maxTokens: 512 },
};

const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const visibleRows = () => [...document.querySelectorAll<HTMLTableRowElement>("table tbody tr")].map((row) => row.textContent ?? "");

test("Unclassified orders remain visible and openable on both routes and refresh after supplier events", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const opened: string[] = [];
  const pending = Array.from({ length: 8 }, (_, index) => portfolioItem({
    id: `po:pending-${index}`, number: `PO-PENDING-${index}`, route: "unclassified", routeSource: "unclassified",
    routeAssignmentVersion: 0, materialType: "气动阀 PV-30", stage: "custom_pending", stageLabel: "等待供应商确认",
  }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith("/api/procurement/tenant-preferences")) return response({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100") return response({ portfolio: { ...portfolio, items: [...portfolio.items, ...pending] }, permissions: { operate: true, configure: true } });
    if (path.startsWith("/api/procurement/route-chat?")) return response(emptyChat);
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react"); runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementRouteWorkbench } = await import("../features/procurement/route-workbench.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    const { ChineseUiLocalization } = await import("../features/localization/chinese-ui-localization.js");
    root = createRoot(host);
    for (const route of ["import", "local"] as const) {
      await act(async () => { root!.render(<><ChineseUiLocalization /><ProcurementTenantPreferencesProvider><ProcurementRouteWorkbench key={route} route={route} onOpenOrder={(id) => opened.push(id)} /></ProcurementTenantPreferencesProvider></>); await wait(); });
      await act(async () => { await wait(); });
      assert.equal(document.querySelector("h1")?.textContent?.trim(), route === "local" ? "本地采购" : "进口采购");
      assert.equal(document.querySelectorAll("table thead th").length, 10);
      assert.deepEqual([...document.querySelectorAll("table thead th")].map((cell) => cell.textContent?.trim() || cell.getAttribute("aria-label")), ["采购订单号", "供应商", "物料类型", "当前阶段", "要求到货日期（RIHD）", "距 RIHD 天数", "风险", "下一步操作", "总金额", "行操作"]);
      assert.ok(button("全部采购订单"));
      assert.ok(button(route === "local" ? "发运" : "在途跟踪"));
      if (route === "local") {
        assert.match(document.querySelector("table tbody")?.textContent ?? "", /直接物料/);
        assert.match(document.querySelector("table tbody")?.textContent ?? "", /供应商承诺/);
        assert.match(document.querySelector("table tbody")?.textContent ?? "", /Follow up for a committed delivery date\./);
      } else {
        assert.match(document.querySelector("table tbody")?.textContent ?? "", /Custom Blend/);
        assert.match(document.querySelector("table tbody")?.textContent ?? "", /Vendor Custom Gate/);
        assert.match(document.querySelector("table tbody")?.textContent ?? "", /Pending/);
        assert.match(document.querySelector("table tbody")?.textContent ?? "", /Supplier/);
        const supplierTrigger = button("供应商");
        await interactWithPortal(() => pointerClick(supplierTrigger));
        const supplierOption = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Supplier");
        assert.ok(supplierOption, "全局翻译观察器不得改写供应商选项");
        await interactWithPortal(() => selectMenuItem(supplierOption));
        assert.ok(button("Supplier"), "选中后的供应商名称必须保持原文");
      }
      const queue = host.querySelector<HTMLElement>('[aria-label="待分类采购订单"]');
      assert.ok(queue, "unclassified orders need an immediately visible entry, not only a collapsed footer");
      assert.equal(queue.closest("details"), null);
      const primaryWorkbench = host.querySelector<HTMLElement>(`[aria-label="${route === "local" ? "本地采购" : "进口采购"}路线助理"]`)?.parentElement;
      assert.ok(primaryWorkbench);
      assert.ok(
        Boolean(primaryWorkbench.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING),
        "the truthful unclassified panel follows the reference primary route workbench instead of displacing it",
      );
      const lastOrder = queue.querySelector<HTMLButtonElement>('[aria-label="查看订单 PO-PENDING-7"]');
      assert.ok(lastOrder, "orders after the first six must also be accessible");
      await act(async () => { lastOrder.click(); });
    }
    assert.deepEqual(opened, ["po:pending-7", "po:pending-7"]);
    pending[7]!.stageLabel = "供应商已确认";
    await act(async () => {
      window.dispatchEvent(new CustomEvent("readywork:procurement-realtime", { detail: { family: "messages", objectId: "po:pending-7" } }));
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    assert.match(host.querySelector('[aria-label="待分类采购订单"]')?.textContent ?? "", /供应商已确认/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch; restore();
  }
});

test("本地采购控件保持参考交互、焦点与真实 API 行为", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const chatPosts: Record<string, unknown>[] = [];
  const exportPosts: Array<{ path: string; body: Record<string, unknown>; idempotencyKey: string | null }> = [];
  const openedOrders: string[] = [];
  const controlsPortfolio = {
    ...portfolio,
    items: portfolio.items.map((item) => item.route === "local"
      ? { ...item, requiredInHouseAt: item.id === "po:alpha" ? "2000-09-08T00:00:00.000Z" : "2000-09-20T00:00:00.000Z" }
      : item),
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/procurement/tenant-preferences")) return response({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100") return response({ portfolio: controlsPortfolio, permissions: { operate: true, approve: true, configure: true } });
    if (path === "/api/procurement/route-chat?route=local") return response(emptyChat);
    if (path === "/api/procurement/route-chat" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      chatPosts.push(body);
      return response({
        ...emptyChat,
        conversation: { id: "route-chat:1", route: "local", status: "active", version: 1, lastSequence: 2, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:01.000Z" },
        suggestedQuestions: ["Pending"],
        messages: [
          { id: "message:1", sequence: 1, role: "user", content: body.message, status: "completed", model: null, modelRoute: null, usage: null, attachment: null, createdAt: "2026-09-03T00:00:00.000Z" },
          { id: "message:2", sequence: 2, role: "assistant", content: "Supplier", status: "completed", model: "test-model", modelRoute: "fast", usage: null, attachment: { id: "attachment:business", fileName: "Pending", contentType: "application/pdf", sizeBytes: 12, sha256: "b".repeat(64), securityStatus: "clean", processingStatus: "parsed", detectedContentType: "Supplier", createdAt: "2026-09-03T00:00:01.000Z", readableByModel: true }, createdAt: "2026-09-03T00:00:01.000Z" },
        ],
      });
    }
    if (path === "/api/procurement/routes/local/exports" && method === "POST") {
      exportPosts.push({ path, body: JSON.parse(String(init?.body)), idempotencyKey: new Headers(init?.headers).get("Idempotency-Key") });
      return response({ id: "export:1", route: "local", sourceWatermark: "wm:1", rowCount: 2, contentSha256: "a".repeat(64), state: "ready", createdAt: "2026-09-03T00:00:00.000Z", expiresAt: "2026-09-04T00:00:00.000Z", downloadUrl: "#export", replayed: false });
    }
    throw new Error(`unexpected fetch: ${path} ${method}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react");
    runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementRouteWorkbench } = await import("../features/procurement/route-workbench.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    const { ChineseUiLocalization } = await import("../features/localization/chinese-ui-localization.js");
    await act(async () => {
      root = createRoot(host);
      root.render(<><ChineseUiLocalization /><ProcurementTenantPreferencesProvider><ProcurementRouteWorkbench route="local" onOpenOrder={(id) => openedOrders.push(id)} /></ProcurementTenantPreferencesProvider></>);
      await wait();
      await wait();
    });

    assert.equal(document.querySelector("h1")?.textContent?.trim(), "本地采购");
    assert.equal(visibleRows().length, 2);

    const poSent = button("采购订单已发送");
    poSent.focus();
    await act(async () => { poSent.click(); await wait(); });
    assert.deepEqual(visibleRows().map((row) => row.includes("PO-LOCAL-002")), [true]);
    assert.equal(document.activeElement === poSent, true);
    await act(async () => { button("全部采购订单").click(); await wait(); });

    const search = document.querySelector<HTMLInputElement>('input[placeholder="搜索采购订单号、供应商…"]')!;
    await act(async () => { changeInput(search, "Beta Mills"); await wait(); });
    assert.deepEqual(visibleRows().map((row) => row.includes("PO-LOCAL-002")), [true]);
    await act(async () => { button("筛选").click(); await wait(); });
    assert.equal(search.value, "");
    assert.equal(visibleRows().length, 2);

    const riskTrigger = button("风险");
    riskTrigger.focus();
    await interactWithPortal(() => riskTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const keyboardRiskMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="风险"]')!;
    assert.ok(keyboardRiskMenu);
    assert.equal(document.activeElement?.textContent?.trim(), "高");
    await interactWithPortal(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(Boolean(document.querySelector('[role="menu"][aria-label="风险"]')), false);
    assert.equal(document.activeElement, riskTrigger);

    await interactWithPortal(() => riskTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.equal(document.activeElement?.textContent?.trim(), "高");
    await interactWithPortal(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.activeElement, riskTrigger);

    await interactWithPortal(() => riskTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    assert.equal(document.activeElement?.textContent?.trim(), "低");
    await interactWithPortal(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.activeElement, riskTrigger);

    await interactWithPortal(() => pointerClick(riskTrigger));
    const riskMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="风险"]')!;
    assert.ok(riskMenu);
    assert.equal(document.activeElement === riskMenu, true);
    assert.deepEqual([...riskMenu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()), ["高", "中", "低"]);
    await interactWithPortal(() => selectMenuItem([...riskMenu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "高")!));
    assert.equal(visibleRows().length, 1);
    assert.match(visibleRows()[0]!, /PO-LOCAL-001/);
    const highTrigger = button("高");
    await interactWithPortal(() => pointerClick(highTrigger));
    await interactWithPortal(() => selectMenuItem([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "高")!));
    assert.ok(button("风险"));
    assert.equal(visibleRows().length, 2);

    const supplierTrigger = button("供应商");
    await interactWithPortal(() => pointerClick(supplierTrigger));
    const supplierMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="供应商"]')!;
    assert.ok(supplierMenu);
    assert.equal(document.activeElement === supplierMenu, true);
    assert.deepEqual([...supplierMenu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()), ["Alpha Textiles", "Beta Mills"]);
    await interactWithPortal(() => selectMenuItem([...supplierMenu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Beta Mills")!));
    assert.equal(visibleRows().length, 1);
    await interactWithPortal(() => pointerClick(button("Beta Mills")));
    await interactWithPortal(() => selectMenuItem([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "Beta Mills")!));
    assert.equal(visibleRows().length, 2);

    const dateTrigger = button("日期范围");
    await interactWithPortal(() => dateTrigger.click());
    const dateDialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="日期范围"]')!;
    assert.ok(dateDialog);
    assert.ok(dateDialog.querySelector('nav[aria-label="导航栏"]'));
    assert.ok(dateDialog.querySelector('button[aria-label="前往上个月"]'));
    assert.ok(dateDialog.querySelector('button[aria-label="前往下个月"]'));
    assert.ok([...dateDialog.querySelectorAll<HTMLElement>('[aria-label]')].some((item) => item.getAttribute("aria-label")?.includes("今天")));
    assert.equal(document.activeElement?.textContent?.trim(), "今天");
    assert.deepEqual([...dateDialog.querySelectorAll<HTMLButtonElement>("button")].map((item) => item.textContent?.trim()).filter(Boolean).slice(0, 5), ["今天", "最近 7 天", "最近 30 天", "本季度", "年初至今"]);
    const apply = [...dateDialog.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "应用")!;
    assert.equal(apply.disabled, true);
    await interactWithPortal(() => [...dateDialog.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "最近 7 天")!.click());
    assert.equal(apply.disabled, false);
    assert.ok([...dateDialog.querySelectorAll<HTMLElement>('[aria-label]')].some((item) => item.getAttribute("aria-label")?.includes("已选择")));
    await interactWithPortal(() => [...dateDialog.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "取消")!.click());
    assert.equal(Boolean(document.querySelector('[role="dialog"][aria-label="日期范围"]')), false);
    assert.equal(document.activeElement === dateTrigger, true);
    await interactWithPortal(() => dateTrigger.click());
    await interactWithPortal(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(Boolean(document.querySelector('[role="dialog"][aria-label="日期范围"]')), false);
    assert.equal(document.activeElement === dateTrigger, true);
    await interactWithPortal(() => dateTrigger.click());
    const applyDialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="日期范围"]')!;
    await interactWithPortal(() => [...applyDialog.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "最近 7 天")!.click());
    await interactWithPortal(() => [...applyDialog.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "应用")!.click());
    assert.match(dateTrigger.textContent?.trim() ?? "", /\d{4} 年 \d{1,2} 月 \d{1,2} 日 – \d{4} 年 \d{1,2} 月 \d{1,2} 日/);
    assert.equal(visibleRows().length, 0);
    assert.match(document.body.textContent ?? "", /没有符合当前筛选条件的采购订单/);
    await act(async () => { button("筛选").click(); await wait(); });
    assert.equal(dateTrigger.textContent?.trim(), "日期范围");
    assert.equal(visibleRows().length, 2);

    const firstRow = [...document.querySelectorAll<HTMLTableRowElement>("table tbody tr")].find((row) => row.textContent?.includes("PO-LOCAL-001"))!;
    assert.match(firstRow.cells[6]?.textContent ?? "", /高\s*未获承诺/);
    assert.doesNotMatch(firstRow.cells[6]?.textContent ?? "", /Score 85/);
    const rowMenuTrigger = firstRow.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    rowMenuTrigger.focus();
    await interactWithPortal(() => rowMenuTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const keyboardRowMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="PO-LOCAL-001 操作"]')!;
    assert.ok(keyboardRowMenu);
    assert.equal(document.activeElement?.textContent?.trim(), "查看详情");
    await interactWithPortal(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(Boolean(document.querySelector('[role="menu"][aria-label="PO-LOCAL-001 操作"]')), false);
    assert.equal(document.activeElement, rowMenuTrigger);

    await interactWithPortal(() => rowMenuTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    assert.equal(document.activeElement?.textContent?.trim(), "标记风险");
    await interactWithPortal(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.activeElement, rowMenuTrigger);

    await interactWithPortal(() => pointerClick(rowMenuTrigger));
    const rowMenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="PO-LOCAL-001 操作"]')!;
    assert.ok(rowMenu);
    assert.equal(document.activeElement === rowMenu, true);
    assert.deepEqual([...rowMenu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()), ["查看详情", "发送跟进", "修改 RIHD", "标记风险"]);
    await interactWithPortal(() => rowMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    assert.equal(document.activeElement?.textContent?.trim(), "标记风险");
    await interactWithPortal(() => rowMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    assert.equal(document.activeElement?.textContent?.trim(), "查看详情");
    await interactWithPortal(() => rowMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(Boolean(document.querySelector('[role="menu"][aria-label="PO-LOCAL-001 操作"]')), false);
    assert.equal(document.activeElement === rowMenuTrigger, true);

    const quickQuestion = button("高风险采购订单");
    assert.deepEqual(chatPosts, [], "挂载和浏览不得自动发送快捷问题");
    quickQuestion.focus();
    await act(async () => { quickQuestion.click(); await wait(); await wait(); });
    assert.deepEqual(chatPosts, [{ route: "local", message: "高风险采购订单", startNew: false, expectedVersion: 0, history: [] }]);
    assert.ok([...document.querySelectorAll("article")].some((item) => item.textContent?.includes("Supplier")), "历史助手正文必须保留原文");
    assert.ok([...document.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Pending"), "服务端建议问题必须保留原文");
    assert.ok([...document.querySelectorAll("article div")].some((item) => item.textContent?.trim() === "Pending"), "附件文件名必须保留原文");
    assert.ok([...document.querySelectorAll("article div")].some((item) => item.textContent?.includes("12 B · Supplier")), "附件内容类型必须保留原文");
    assert.equal(document.querySelector<HTMLInputElement>('input[placeholder="询问关于本地采购订单的问题…"]')?.value, "");

    const expand = document.querySelector<HTMLButtonElement>('button[aria-label="展开面板"]')!;
    await act(async () => { expand.click(); await wait(); });
    assert.ok(document.querySelector('button[aria-label="收起面板"]'));
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="收起面板"]')!.click(); await wait(); });
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="关闭助理"]')!;
    close.focus();
    await act(async () => { close.click(); await wait(); });
    assert.equal(Boolean(document.querySelector('[aria-label="本地采购订单 Readywork 助理"]')), false);
    assert.equal(document.activeElement, document.body);
    const reopen = button("Readywork 助理");
    await act(async () => { reopen.click(); await wait(); });
    assert.ok(document.querySelector('[aria-label="本地采购订单 Readywork 助理"]'));

    await interactWithPortal(() => pointerClick(rowMenuTrigger));
    const detailItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "查看详情")!;
    await interactWithPortal(() => selectMenuItem(detailItem));
    assert.deepEqual(openedOrders, ["po:alpha"]);

    await act(async () => { button("导出").click(); await wait(); });
    assert.equal(exportPosts.length, 1);
    assert.deepEqual(exportPosts[0]!.body, { query: "", stages: [], risks: [], supplierIds: [], rihdFrom: null, rihdTo: null, sort: "risk_desc" });
    assert.match(exportPosts[0]!.idempotencyKey ?? "", /^route-export:local:/);
    assert.match(document.body.textContent ?? "", /已生成 2 条权威导出/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    await wait();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("route export is single-flight, retry-safe, filter-stable and activates only authoritative downloads", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let rejectFirstExport!: (reason: unknown) => void;
  const firstExport = new Promise<Response>((_resolve, reject) => { rejectFirstExport = reject; });
  const exportPosts: Array<{ key: string | null; body: Record<string, unknown> }> = [];
  const activatedDownloads: string[] = [];
  const successfulExport = (id: string, downloadUrl: string) => response({
    id,
    route: "local",
    sourceWatermark: "wm:1",
    rowCount: 1,
    contentSha256: "a".repeat(64),
    state: "ready",
    createdAt: "2026-09-03T00:00:00.000Z",
    expiresAt: "2026-09-04T00:00:00.000Z",
    downloadUrl,
    replayed: false,
  });
  const exportBehaviors: Array<() => Promise<Response> | Response> = [
    () => firstExport,
    () => response({ error: "导出结果尚未确定，请使用原请求重试", code: "REQUEST_TIMEOUT" }, 408),
    () => response({ error: "导出存储暂不可用，请使用原请求重试", code: "ROUTE_EXPORT_STORAGE_UNAVAILABLE" }, 503),
    () => successfulExport("export:one", "/api/procurement/route-exports/export%3Aone/download"),
    () => successfulExport("export:two", "/api/procurement/route-exports/export%3Atwo/download"),
    () => response({ error: "当前角色无权导出", code: "FORBIDDEN" }, 403),
    () => response({ error: "导出幂等键与筛选条件冲突", code: "ROUTE_EXPORT_IDEMPOTENCY_CONFLICT" }, 409),
    () => response({ error: "导出筛选条件无效", code: "VALIDATION_ERROR" }, 422),
  ];
  const captureDownload = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "A") {
      event.preventDefault();
      activatedDownloads.push(target.getAttribute("href") ?? "");
    }
  };
  document.addEventListener("click", captureDownload, true);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/procurement/tenant-preferences")) return response({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100") return response({ portfolio, permissions: { operate: true, approve: true, configure: true } });
    if (path === "/api/procurement/route-chat?route=local") return response(emptyChat);
    if (path === "/api/procurement/routes/local/exports" && method === "POST") {
      exportPosts.push({ key: new Headers(init?.headers).get("Idempotency-Key"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const behavior = exportBehaviors[exportPosts.length - 1];
      if (!behavior) throw new Error("unexpected extra route export");
      return behavior();
    }
    throw new Error(`unexpected fetch: ${path} ${method}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react");
    runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementRouteWorkbench } = await import("../features/procurement/route-workbench.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    await act(async () => {
      root = createRoot(host);
      root.render(<ProcurementTenantPreferencesProvider><ProcurementRouteWorkbench route="local" onOpenOrder={() => undefined} /></ProcurementTenantPreferencesProvider>);
      await wait();
      await wait();
    });

    const search = document.querySelector<HTMLInputElement>('input[placeholder="搜索采购订单号、供应商…"]')!;
    await act(async () => { changeInput(search, "Beta Mills"); await wait(); });
    const exportButton = button("导出");
    await act(async () => {
      exportButton.click();
      exportButton.click();
      await wait();
      rejectFirstExport(new TypeError("network disconnected after request write"));
      await wait();
    });
    assert.equal(exportPosts.length, 1, "同一事件周期的双击必须被同步 single-flight 门闩拦截");
    assert.equal(search.value, "Beta Mills");
    assert.match(document.body.textContent ?? "", /网络连接失败，请检查服务状态/);

    const uncertainKey = exportPosts[0]!.key;
    assert.match(uncertainKey ?? "", /^route-export:local:/);
    for (const expectedError of ["导出结果尚未确定，请使用原请求重试", "导出存储暂不可用，请使用原请求重试"]) {
      await act(async () => { button("导出").click(); await wait(); });
      assert.equal(exportPosts.at(-1)!.key, uncertainKey, "0/408/503 必须按未变化筛选复用原幂等键");
      assert.equal(search.value, "Beta Mills");
      assert.match(document.body.textContent ?? "", new RegExp(expectedError));
      assert.deepEqual(activatedDownloads, []);
    }

    await act(async () => { button("导出").click(); await wait(); });
    assert.equal(exportPosts.at(-1)!.key, uncertainKey);
    assert.deepEqual(activatedDownloads, ["/api/procurement/route-exports/export%3Aone/download"]);
    assert.match(document.body.textContent ?? "", /已生成 1 条权威导出/);

    await act(async () => { changeInput(search, "Alpha Textiles"); await wait(); });
    await act(async () => { button("导出").click(); await wait(); });
    assert.notEqual(exportPosts.at(-1)!.key, uncertainKey, "筛选变化后必须生成新幂等键");
    assert.deepEqual(exportPosts.at(-1)!.body, { query: "Alpha Textiles", stages: [], risks: [], supplierIds: [], rihdFrom: null, rihdTo: null, sort: "risk_desc" });
    assert.deepEqual(activatedDownloads, [
      "/api/procurement/route-exports/export%3Aone/download",
      "/api/procurement/route-exports/export%3Atwo/download",
    ]);

    for (const expectedError of ["当前角色无权导出", "导出幂等键与筛选条件冲突", "导出筛选条件无效"]) {
      await act(async () => { button("导出").click(); await wait(); });
      assert.equal(search.value, "Alpha Textiles", "权威错误不能清空当前筛选");
      assert.match(document.body.textContent ?? "", new RegExp(expectedError));
      assert.deepEqual(activatedDownloads, [
        "/api/procurement/route-exports/export%3Aone/download",
        "/api/procurement/route-exports/export%3Atwo/download",
      ], "403/409/422 不能触发下载");
    }
  } finally {
    document.removeEventListener("click", captureDownload, true);
    if (runAct) await runAct(async () => root?.unmount());
    await wait();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("路线确认在同一事件周期只提交一次，并按未变更候选复用幂等键", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let firstResolved = false;
  let resolveFirstAssignment!: (value: Response) => void;
  const firstAssignment = new Promise<Response>((resolve) => { resolveFirstAssignment = resolve; });
  const assignmentPosts: Array<{ key: string | null; body: Record<string, unknown> }> = [];
  const routeCandidate = {
    id: "route-candidate:contract", type: "route_document", evidenceType: "contract", eligible: true,
    reference: "route-document:contract:1", label: "合同 CONTRACT-ROUTE-001", summary: "境内交付合同",
    sourceSystem: "readywork", sourceEntity: "route_document", purchaseOrderId: "po:route-ui", purchaseOrderVersion: 2,
    observedAt: "2026-09-06T00:00:00.000Z", fields: {
      documentId: "route-document:1", businessReference: "CONTRACT-ROUTE-001", documentVersion: 1,
      attachmentId: "attachment:route-1", attachmentVersion: 1, sha256: "a".repeat(64), fileName: "合同原件.pdf",
      sizeBytes: 128, securityStatus: "clean", processingStatus: "parsed", detectedContentType: "application/pdf",
    },
  };
  const unclassifiedItem = portfolioItem({
    id: "po:route-ui", number: "PO-ROUTE-UI", route: "unclassified", routeSource: "unclassified",
    routeAssignmentVersion: 0, routeEvidenceCandidates: [routeCandidate],
  });
  const assignmentPortfolio = {
    ...portfolio,
    metrics: { unclassifiedRoute: 1 },
    routes: { ...portfolio.routes, local: { total: 0, high: 0, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 0 }, unclassified: { total: 1, high: 1, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 0 } },
    items: [unclassifiedItem],
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/procurement/tenant-preferences")) return response({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100") return response({ portfolio: assignmentPortfolio, permissions: { operate: true, approve: true, configure: true } });
    if (path === "/api/procurement/route-chat?route=local") return response(emptyChat);
    if (path === "/api/procurement/routes/po%3Aroute-ui/evidence-documents") return response({
      purchaseOrderId: "po:route-ui", clamAvConfigured: true, documents: [], availableAttachments: [], events: [],
      permissions: { operate: true, configure: true },
    });
    if (path === "/api/procurement/routes/po%3Aroute-ui/assign" && method === "POST") {
      assignmentPosts.push({ key: new Headers(init?.headers).get("Idempotency-Key"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (assignmentPosts.length === 1) return firstAssignment;
      if (assignmentPosts.length === 3) return response({ error: "路线版本冲突", code: "VERSION_CONFLICT", currentVersion: 2 }, 409);
      return response({ error: "路线确认结果尚未确定，请使用原请求重试", code: "REQUEST_TIMEOUT" }, 408);
    }
    throw new Error(`unexpected fetch: ${path} ${method}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react"); runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementRouteWorkbench } = await import("../features/procurement/route-workbench.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    root = createRoot(host);
    await act(async () => {
      root!.render(<ProcurementTenantPreferencesProvider><ProcurementRouteWorkbench route="local" onOpenOrder={() => undefined} /></ProcurementTenantPreferencesProvider>);
      await wait(); await wait();
    });

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="确认路线 PO-ROUTE-UI"]')!.click();
      await wait(); await wait();
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="route-dialog-title"]')!;
    assert.ok(dialog);
    const evidenceType = dialog.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { changeSelect(evidenceType, "manual_review"); await wait(); });
    const reference = dialog.querySelector<HTMLInputElement>('input[placeholder="核验记录号 / 审批记录号"]')!;
    const notes = dialog.querySelector<HTMLTextAreaElement>('textarea[placeholder^="说明为何依据"]')!;
    await act(async () => { changeInput(reference, "REVIEW-ROUTE-UI-001"); await wait(); });

    const save = button("保存并记录审计");
    await act(async () => { save.click(); save.click(); await Promise.resolve(); });
    assert.equal(assignmentPosts.length, 1, "同一事件周期的两次点击只能发出一个路线确认请求");
    assert.match(assignmentPosts[0]!.key ?? "", /^route-assignment:po:route-ui:/);
    await act(async () => {
      firstResolved = true;
      resolveFirstAssignment(response({ error: "路线确认结果尚未确定，请使用原请求重试", code: "REQUEST_TIMEOUT" }, 408));
      await wait(); await wait();
    });
    assert.ok(document.querySelector('[role="dialog"][aria-labelledby="route-dialog-title"]'));
    assert.equal(reference.value, "REVIEW-ROUTE-UI-001");

    await act(async () => { button("保存并记录审计").click(); await wait(); await wait(); });
    assert.equal(assignmentPosts.length, 2);
    assert.equal(assignmentPosts[1]!.key, assignmentPosts[0]!.key, "不确定结果后原候选重试必须复用同一幂等键");

    await act(async () => { button("进口采购").click(); await wait(); button("保存并记录审计").click(); await wait(); await wait(); });
    assert.notEqual(assignmentPosts[2]!.key, assignmentPosts[1]!.key, "路线变化必须生成新键");
    await act(async () => { button("保存并记录审计").click(); await wait(); await wait(); });
    assert.notEqual(assignmentPosts[3]!.key, assignmentPosts[2]!.key, "权威 409 后同载荷重试必须换新键");

    await act(async () => { changeInput(reference, "REVIEW-ROUTE-UI-002"); await wait(); button("保存并记录审计").click(); await wait(); await wait(); });
    assert.notEqual(assignmentPosts[4]!.key, assignmentPosts[3]!.key, "证据引用变化必须生成新键");

    await act(async () => { changeTextArea(notes, "改用新的人工复核记录确认进口路线"); await wait(); button("保存并记录审计").click(); await wait(); await wait(); });
    assert.notEqual(assignmentPosts[5]!.key, assignmentPosts[4]!.key, "证据说明变化必须生成新键");

    await act(async () => { changeSelect(evidenceType, "contract"); await wait(); button("保存并记录审计").click(); await wait(); await wait(); });
    assert.notEqual(assignmentPosts[6]!.key, assignmentPosts[5]!.key, "证据类型变化必须生成新键");
    assert.equal((assignmentPosts[6]!.body["evidence"] as Record<string, unknown>)["reference"], "route-document:contract:1");
  } finally {
    if (!firstResolved) resolveFirstAssignment(response({ error: "测试结束", code: "REQUEST_TIMEOUT" }, 408));
    if (runAct) await runAct(async () => root?.unmount());
    await wait(); globalThis.fetch = originalFetch; restore();
  }
});

test("Local/Import stable shell 保留页面结构并明确缓存读取失败水位", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let resolveLocalWorkbench: ((value: Response) => void) | undefined;
  let resolveImportWorkbench: ((value: Response) => void) | undefined;
  let workbenchCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith("/api/procurement/tenant-preferences")) return response({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100") {
      workbenchCalls += 1;
      if (workbenchCalls === 1) return new Promise<Response>((resolve) => { resolveLocalWorkbench = resolve; });
      if (workbenchCalls === 2) return new Promise<Response>((resolve) => { resolveImportWorkbench = resolve; });
      return response({ error: "刷新服务暂时不可用", code: "SERVICE_UNAVAILABLE" }, 503);
    }
    if (path === "/api/procurement/route-chat?route=local" || path === "/api/procurement/route-chat?route=import") return response(emptyChat);
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react"); runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementRouteWorkbench } = await import("../features/procurement/route-workbench.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    const renderRoute = async (route: "local" | "import") => act(async () => {
      root ??= createRoot(host);
      root.render(<ProcurementTenantPreferencesProvider><ProcurementRouteWorkbench key={route} route={route} onOpenOrder={() => undefined} /></ProcurementTenantPreferencesProvider>);
      await Promise.resolve();
    });
    const assertStableShell = (title: "本地采购" | "进口采购") => {
      assert.equal(document.querySelector("h1")?.textContent?.trim(), title);
      assert.match(host.textContent ?? "", title === "本地采购" ? /管理并跟踪所有本地采购订单/ : /管理并跟踪所有进口采购订单/);
      assert.ok(host.querySelector(`[aria-label="${title}加载中"][aria-busy="true"]`));
      assert.ok(button("全部采购订单"));
      assert.ok(host.querySelector(`[aria-label="${title}路线助理"]`));
      assert.ok(host.querySelector('input[placeholder="搜索采购订单号、供应商…"]'));
      assert.equal(host.querySelectorAll("table thead th").length, 10);
      assert.ok(host.querySelector('tbody[data-loading="true"]'));
      assert.doesNotMatch(host.textContent ?? "", /尚无已确认|当前没有已确认|PO-LOCAL-001|PO-IMPORT-001/);
    };

    await renderRoute("local");
    assertStableShell("本地采购");
    await act(async () => {
      resolveLocalWorkbench?.(response({ error: "上游服务不可用", code: "SERVICE_UNAVAILABLE" }, 503));
      await wait(); await wait();
    });
    assert.equal(document.querySelector("h1")?.textContent?.trim(), "本地采购");
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /采购路线读取失败/);
    assert.doesNotMatch(host.textContent ?? "", /尚无已确认|当前没有已确认/);

    await renderRoute("import");
    assertStableShell("进口采购");
    await act(async () => {
      resolveImportWorkbench?.(response({ portfolio, permissions: { operate: true, approve: true, configure: true } }));
      await wait(); await wait();
    });
    assert.match(host.textContent ?? "", /PO-IMPORT-001/);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("readywork:procurement-realtime", { detail: { family: "pos", objectId: "po:import" } }));
      await new Promise((resolve) => setTimeout(resolve, 350));
      await wait();
    });
    assert.match(host.textContent ?? "", /PO-IMPORT-001/);
    const staleAlert = host.querySelector<HTMLElement>('[role="alert"][data-watermark]');
    assert.ok(staleAlert);
    assert.match(staleAlert.textContent ?? "", /显示的是上次成功数据/);
    assert.equal(staleAlert.dataset.watermark, portfolio.generatedAt);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("本地与进口采购按权威权限隐藏写入口，缺失权限默认只读", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let activePermissions: Record<string, boolean> | undefined;
  let mutationCount = 0;
  const unclassified = portfolioItem({
    id: "po:role-unclassified", number: "PO-ROLE-UNCLASSIFIED", route: "unclassified", routeSource: "unclassified", routeAssignmentVersion: 0,
  });
  const rolePortfolio = { ...portfolio, metrics: { unclassifiedRoute: 1 }, items: [portfolio.items[0]!, unclassified] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") { mutationCount += 1; throw new Error(`unexpected mutation: ${path}`); }
    if (path.startsWith("/api/procurement/tenant-preferences")) return response({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100") return response({ portfolio: rolePortfolio, ...(activePermissions ? { permissions: activePermissions } : {}) });
    if (path === "/api/procurement/route-chat?route=local") return response({ ...emptyChat, permissions: { operate: activePermissions?.["operate"] === true } });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react"); runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { ProcurementRouteWorkbench } = await import("../features/procurement/route-workbench.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    root = createRoot(host);
    const cases = [
      { name: "manager", permissions: { operate: true, approve: true, configure: true }, menu: ["查看详情", "发送跟进", "修改 RIHD", "标记风险"], export: true, configure: true },
      { name: "buyer", permissions: { operate: true, approve: false, configure: false }, menu: ["查看详情", "发送跟进", "标记风险"], export: true, configure: false },
      { name: "auditor", permissions: { operate: false, approve: false, configure: false }, menu: ["查看详情"], export: false, configure: false },
      { name: "missing", permissions: undefined, menu: ["查看详情"], export: false, configure: false },
    ];
    for (const roleCase of cases) {
      activePermissions = roleCase.permissions;
      await act(async () => {
        root!.render(<ProcurementTenantPreferencesProvider><ProcurementRouteWorkbench key={roleCase.name} route="local" onOpenOrder={() => undefined} /></ProcurementTenantPreferencesProvider>);
        await wait(); await wait();
      });
      const row = [...host.querySelectorAll<HTMLTableRowElement>("table tbody tr")].find((item) => item.textContent?.includes("PO-LOCAL-001"))!;
      const trigger = row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
      await interactWithPortal(() => pointerClick(trigger));
      const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="PO-LOCAL-001 操作"]')!;
      assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()), roleCase.menu, roleCase.name);
      await interactWithPortal(() => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      assert.equal([...host.querySelectorAll("button")].some((item) => item.textContent?.trim() === "导出"), roleCase.export, `${roleCase.name} export`);
      assert.equal(Boolean(host.querySelector('button[aria-label="确认路线 PO-ROLE-UNCLASSIFIED"]')), roleCase.configure, `${roleCase.name} route assignment`);
      assert.equal([...host.querySelectorAll("button")].some((item) => item.textContent?.trim() === "同步 Odoo"), roleCase.configure, `${roleCase.name} Odoo sync`);
    }
    assert.equal(mutationCount, 0);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    await wait(); globalThis.fetch = originalFetch; restore();
  }
});

test("只读路线助理保留历史与导航，但不呈现任何写控件", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let mutationCount = 0;
  const readOnlyChat = {
    ...emptyChat,
    conversation: { id: "route-chat:readonly", route: "local", status: "active", version: 3, lastSequence: 1, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:01.000Z" },
    permissions: { operate: false }, suggestedQuestions: ["Persisted Question"],
    messages: [{
      id: "message:readonly", sequence: 1, role: "assistant", content: "Supplier persisted history", status: "completed",
      model: "test-model", modelRoute: "fast", usage: null, createdAt: "2026-09-03T00:00:01.000Z",
      attachment: { id: "attachment:readonly", fileName: "Pending Original.pdf", contentType: "application/pdf", sizeBytes: 128, sha256: "b".repeat(64), securityStatus: "clean", processingStatus: "parse_failed", detectedContentType: "application/pdf", createdAt: "2026-09-03T00:00:01.000Z", readableByModel: false },
    }],
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? "GET") !== "GET") { mutationCount += 1; throw new Error(`unexpected mutation: ${path}`); }
    if (path.startsWith("/api/procurement/tenant-preferences")) return response({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === "/api/procurement/route-chat?route=local") return response(readOnlyChat);
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react"); runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { RouteChat } = await import("../features/procurement/route-chat.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    await act(async () => {
      root = createRoot(host);
      root.render(<ProcurementTenantPreferencesProvider><RouteChat route="local" mode="normal" onToggleExpand={() => undefined} onClose={() => undefined} /></ProcurementTenantPreferencesProvider>);
      await wait(); await wait();
    });
    assert.match(host.textContent ?? "", /您好/);
    assert.doesNotMatch(host.textContent ?? "", /管理员，您好/);
    assert.match(host.textContent ?? "", /Supplier persisted history/);
    assert.match(host.textContent ?? "", /Pending Original\.pdf/);
    assert.match(host.textContent ?? "", /当前身份只有读取权限/);
    assert.ok(host.querySelector('button[aria-label="展开面板"]'));
    assert.ok(host.querySelector('button[aria-label="关闭助理"]'));
    assert.equal(Boolean(host.querySelector('button[aria-label="新建对话"]')), false);
    assert.equal([...host.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Persisted Question"), false);
    assert.equal(Boolean(host.querySelector("form")), false);
    assert.equal(Boolean(host.querySelector('button[aria-label="添加附件"]')), false);
    assert.equal(Boolean(host.querySelector('button[aria-label="发送"]')), false);
    assert.equal([...host.querySelectorAll("button")].some((item) => item.textContent?.includes("重试解析")), false);
    assert.equal(mutationCount, 0);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    await wait(); globalThis.fetch = originalFetch; restore();
  }
});

test("路线助理在无全局翻译器时以中文显示加载、无权错误与 ARIA", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let resolveChat: ((value: Response) => void) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith("/api/procurement/tenant-preferences")) return response({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/route-chat?route=import") return new Promise<Response>((resolve) => { resolveChat = resolve; });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react"); runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { RouteChat } = await import("../features/procurement/route-chat.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    await act(async () => {
      root = createRoot(host);
      root.render(<ProcurementTenantPreferencesProvider><RouteChat route="import" mode="normal" onToggleExpand={() => undefined} onClose={() => undefined} /></ProcurementTenantPreferencesProvider>);
    });
    assert.match(host.textContent ?? "", /读取持久化路线会话…/);
    assert.ok(host.querySelector('[aria-label="进口采购订单 Readywork 助理"]'));
    assert.ok(host.querySelector('button[aria-label="展开面板"]'));
    assert.equal(Boolean(host.querySelector('button[aria-label="新建对话"]')), false, "权限尚未读取时写入口必须 fail closed");
    assert.ok(host.querySelector('button[aria-label="关闭助理"]'));
    await act(async () => {
      resolveChat?.(response({ code: "FORBIDDEN" }, 403));
      await wait();
      await wait();
    });
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /当前身份没有使用路线助手的权限/);
    assert.equal(Boolean(host.querySelector('button[aria-label="新建对话"]')), false);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});
