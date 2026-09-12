import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { ReactNode } from "react";

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://readywork.test/" });
  const previous = new Map<string, unknown>();
  let frameId = 0;
  const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const requestFrame = (callback: FrameRequestCallback) => {
    const id = ++frameId;
    const timer = setTimeout(() => { frameTimers.delete(id); callback(Date.now()); }, 0);
    frameTimers.set(id, timer);
    return id;
  };
  const cancelFrame = (id: number) => {
    const timer = frameTimers.get(id);
    if (timer) clearTimeout(timer);
    frameTimers.delete(id);
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
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    PointerEvent: dom.window.MouseEvent,
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = value;
  }
  Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: requestFrame });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: cancelFrame });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  return {
    host: dom.window.document.querySelector<HTMLDivElement>("#root")!,
    restore: () => {
      for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
      dom.window.close();
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function changeInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeTextArea(textarea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function changeSelect(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

const readiness = {
  queue_followup: { ready: true, code: "ready", message: "Ready" },
  update_rihd: { ready: true, code: "ready", message: "Ready" },
  mark_at_risk: { ready: true, code: "ready", message: "Ready" },
};

function order(overrides: Record<string, unknown>) {
  return {
    id: "po:focus",
    version: 2,
    number: "PO-FOCUS",
    supplierId: "supplier:focus",
    supplierName: "Focus Supplier",
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
    riskFactors: [],
    nextAction: "Follow up",
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

const localOrder = order({});
const unclassifiedOrder = order({
  id: "po:unclassified",
  number: "PO-UNCLASSIFIED",
  route: "unclassified",
  routeSource: "unclassified",
  routeAssignmentVersion: 0,
});
const portfolio = {
  generatedAt: "2026-09-06T00:00:00.000Z",
  metrics: { unclassifiedRoute: 1 },
  routes: {
    local: { total: 1, high: 1, awaitingSupplier: 1, deliveryRisk: 0, onTrack: 0 },
    import: { total: 0, high: 0, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 0 },
    unclassified: { total: 1, high: 1, awaitingSupplier: 1, deliveryRisk: 0, onTrack: 0 },
  },
  items: [localOrder, unclassifiedOrder],
};
const emptyChat = {
  conversation: null,
  messages: [],
  suggestedQuestions: [],
  permissions: { operate: true },
  capabilities: { attachments: { supported: false, reason: "Text only", field: "file", accept: [".pdf"], maxBytes: 8_388_608, multipart: false } },
  model: { configured: true, route: "fast", name: "test-model", maxTokens: 512 },
};

test("Follow-up, RIHD, Risk and Route Confirmation trap focus, close with Escape and restore their stable trigger", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const followupResolvers: Array<(value: Response) => void> = [];
  const assignmentResolvers: Array<(value: Response) => void> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith("/api/procurement/tenant-preferences")) return json({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100") return json({ portfolio, permissions: { operate: true, approve: true, configure: true } });
    if (path === "/api/procurement/route-chat?route=local") return json(emptyChat);
    if (path === "/api/procurement/routes/po%3Aunclassified/evidence-documents") return json({ purchaseOrderId: "po:unclassified", clamAvConfigured: true, documents: [], availableAttachments: [], events: [], permissions: { operate: true, configure: true } });
    if (path === "/api/procurement/execution/queue_followup" && init?.method === "POST") return new Promise<Response>((resolve) => { followupResolvers.push(resolve); });
    if (path === "/api/procurement/routes/po%3Aunclassified/assign" && init?.method === "POST") return new Promise<Response>((resolve) => { assignmentResolvers.push(resolve); });
    throw new Error(`unexpected fetch: ${path}`);
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
      await tick();
      await tick();
    });

    const actionTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="PO-FOCUS 操作"]')!;
    const assertDialogCycle = async (menuLabel: string, title: string) => {
      await act(async () => { actionTrigger.focus(); actionTrigger.click(); await tick(); });
      const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === menuLabel)!;
      await act(async () => { menuItem.focus(); menuItem.click(); await tick(); });
      const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((entry) => entry.textContent?.includes(title))!;
      assert.ok(dialog, `${title} dialog must open`);
      assert.ok(dialog.contains(document.activeElement), `${title} must receive focus`);
      const labelledBy = dialog.getAttribute("aria-labelledby");
      assert.equal(document.getElementById(labelledBy ?? "")?.textContent?.trim(), title);
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
      await act(async () => {
        controls.at(-1)!.focus();
        controls.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      });
      assert.equal(document.activeElement, controls[0], `${title} Tab must wrap to first control`);
      await act(async () => controls[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
      assert.equal(document.activeElement, controls.at(-1), `${title} Shift+Tab must wrap to last control`);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      await act(async () => { await tick(); });
      assert.equal([...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some((entry) => entry.textContent?.includes(title)), false);
      assert.equal(document.activeElement, actionTrigger, `${title} must restore the row action trigger`);
    };

    await assertDialogCycle("发送跟进", "发送跟进");
    await assertDialogCycle("修改 RIHD", "修改 RIHD");
    await assertDialogCycle("标记风险", "标记风险");

    await act(async () => { actionTrigger.focus(); actionTrigger.click(); await tick(); });
    await act(async () => {
      const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === "发送跟进")!;
      menuItem.click();
      await tick();
    });
    const pendingDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((entry) => entry.textContent?.includes("发送跟进"))!;
    const submit = [...pendingDialog.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "生成跟进草稿")!;
    await act(async () => {
      submit.click();
      submit.click();
      await tick();
      assert.equal(followupResolvers.length, 1, "the pending dialog must synchronously reject a second submit");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await tick();
      assert.ok(document.querySelector("#followup-dialog-title"), "a pending mutation must lock Escape dismissal");
      for (const resolve of followupResolvers) resolve(json({ error: "版本冲突，保留当前输入", code: "VERSION_CONFLICT" }, 409));
      await tick();
    });
    assert.ok((pendingDialog.querySelector("textarea") as HTMLTextAreaElement).value.length >= 4);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => { await tick(); });
    assert.equal(document.activeElement, actionTrigger);

    const routeTrigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "确认路线")!;
    await act(async () => { routeTrigger.focus(); routeTrigger.click(); await tick(); await tick(); });
    const routeDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((entry) => entry.textContent?.includes("确认采购路线"))!;
    assert.ok(routeDialog.contains(document.activeElement));
    assert.equal(document.getElementById(routeDialog.getAttribute("aria-labelledby") ?? "")?.textContent?.trim(), "确认采购路线");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => { await tick(); });
    assert.equal(document.querySelector("#route-dialog-title"), null);
    assert.equal(document.activeElement, routeTrigger);

    await act(async () => { routeTrigger.click(); await tick(); await tick(); });
    const pendingRouteDialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="route-dialog-title"]')!;
    await act(async () => { changeSelect(pendingRouteDialog.querySelector<HTMLSelectElement>("select")!, "manual_review"); await tick(); });
    await act(async () => { changeInput(pendingRouteDialog.querySelector<HTMLInputElement>('input[placeholder="核验记录号 / 审批记录号"]')!, "MANUAL-REVIEW-001"); await tick(); });
    const saveRoute = [...pendingRouteDialog.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "保存并记录审计")!;
    await act(async () => {
      saveRoute.click();
      saveRoute.click();
      await tick();
      assert.equal(assignmentResolvers.length, 1, "route confirmation must synchronously emit one request");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await tick();
      assert.ok(document.querySelector("#route-dialog-title"), "route confirmation must lock Escape while unresolved");
      for (const resolve of assignmentResolvers) resolve(json({ error: "路线版本冲突，保留审阅证据", code: "VERSION_CONFLICT", currentVersion: 2 }, 409));
      await tick();
    });
    assert.match(
      pendingRouteDialog.querySelector<HTMLElement>('[role="alert"]')?.textContent ?? "",
      /路线版本冲突，保留审阅证据/u,
      "路线确认失败必须在当前模态弹窗内可见且可被辅助技术读取",
    );
    assert.equal(pendingRouteDialog.querySelector<HTMLInputElement>('input[placeholder="核验记录号 / 审批记录号"]')!.value, "MANUAL-REVIEW-001");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => { await tick(); });
    assert.equal(document.activeElement, routeTrigger);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    await tick();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Follow-up, RIHD, Risk and Odoo sync are synchronously single-flight and preserve reviewed state on authoritative errors", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const posts: Array<{ path: string; key: string | null; body: Record<string, unknown> }> = [];
  const pending = new Map<string, Array<(value: Response) => void>>();
  const defer = (path: string) => new Promise<Response>((resolve) => {
    const queue = pending.get(path) ?? [];
    queue.push(resolve);
    pending.set(path, queue);
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/procurement/tenant-preferences")) return json({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100") return json({ portfolio: { ...portfolio, metrics: { unclassifiedRoute: 0 }, items: [localOrder] }, permissions: { operate: true, approve: true, configure: true } });
    if (path === "/api/procurement/route-chat?route=local") return json(emptyChat);
    if (method === "POST" && [
      "/api/procurement/execution/queue_followup",
      "/api/procurement/execution/update_rihd",
      "/api/procurement/execution/mark_at_risk",
      "/api/procurement/suppliers/sync",
    ].includes(path)) {
      posts.push({ path, key: new Headers(init?.headers).get("Idempotency-Key"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return defer(path);
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
      await tick();
      await tick();
    });

    const actionTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="PO-FOCUS 操作"]')!;
    const openAction = async (label: string) => {
      await act(async () => { actionTrigger.click(); await tick(); });
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === label)!;
      await act(async () => { item.click(); await tick(); });
    };
    const submitTwiceAndReject = async (dialog: HTMLElement, label: string, path: string, error: string, status: number) => {
      const before = posts.filter((request) => request.path === path).length;
      const submit = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label)!;
      await act(async () => {
        submit.click();
        submit.click();
        await tick();
        const requests = posts.filter((request) => request.path === path);
        assert.equal(requests.length, before + 1, `${label} must synchronously emit one request`);
        assert.match(requests.at(-1)!.key ?? "", /^route-/u);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await tick();
        assert.ok(dialog.isConnected, `${label} must lock Escape dismissal while its write is unresolved`);
        const resolvers = pending.get(path) ?? [];
        for (const resolve of resolvers.splice(0)) resolve(json({ error, code: status === 403 ? "FORBIDDEN" : status === 409 ? "VERSION_CONFLICT" : "VALIDATION_ERROR", currentVersion: 3 }, status));
        await tick();
      });
      assert.match(document.body.textContent ?? "", new RegExp(error));
      assert.match(
        dialog.querySelector<HTMLElement>('[role="alert"]')?.textContent ?? "",
        new RegExp(error),
        `${label} 失败必须在当前模态弹窗内可见且可被辅助技术读取`,
      );
      assert.doesNotMatch(document.body.textContent ?? "", /PO-FOCUS 的跟进草稿已持久化|PO-FOCUS 已写入人工风险事实/);
      return posts.filter((request) => request.path === path).at(-1)!;
    };

    await openAction("发送跟进");
    let dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="followup-dialog-title"]')!;
    const followupReason = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { changeTextArea(followupReason, "请保留这份跟进审阅内容"); await tick(); });
    const followupAuthoritative = await submitTwiceAndReject(dialog, "生成跟进草稿", "/api/procurement/execution/queue_followup", "跟进版本冲突", 409);
    assert.equal(followupReason.value, "请保留这份跟进审阅内容");
    const followupUncertain = await submitTwiceAndReject(dialog, "生成跟进草稿", "/api/procurement/execution/queue_followup", "跟进结果尚未确定", 503);
    assert.notEqual(followupUncertain.key, followupAuthoritative.key, "409 must retire the follow-up key");
    const followupReplay = await submitTwiceAndReject(dialog, "生成跟进草稿", "/api/procurement/execution/queue_followup", "跟进版本仍冲突", 409);
    assert.equal(followupReplay.key, followupUncertain.key, "503 must retain the follow-up key");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => { await tick(); });

    await openAction("修改 RIHD");
    dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="rihd-dialog-title"]')!;
    const rihdDate = dialog.querySelector<HTMLInputElement>('input[type="date"]')!;
    const rihdReason = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { changeInput(rihdDate, "2026-09-18"); changeTextArea(rihdReason, "项目要求调整到货日"); await tick(); });
    const rihdAuthoritative = await submitTwiceAndReject(dialog, "提交并等待 Odoo 回执", "/api/procurement/execution/update_rihd", "RIHD 输入无效", 422);
    assert.equal(rihdDate.value, "2026-09-18");
    assert.equal(rihdReason.value, "项目要求调整到货日");
    const rihdUncertain = await submitTwiceAndReject(dialog, "提交并等待 Odoo 回执", "/api/procurement/execution/update_rihd", "RIHD 结果尚未确定", 503);
    assert.notEqual(rihdUncertain.key, rihdAuthoritative.key, "422 must retire the RIHD key");
    const rihdReplay = await submitTwiceAndReject(dialog, "提交并等待 Odoo 回执", "/api/procurement/execution/update_rihd", "RIHD 输入仍无效", 422);
    assert.equal(rihdReplay.key, rihdUncertain.key, "503 must retain the RIHD key");
    const renderedRow = [...document.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((row) => row.textContent?.includes("PO-FOCUS"))!;
    assert.match(renderedRow.cells[4]?.textContent ?? "", /2026-09-08/);
    assert.doesNotMatch(renderedRow.cells[4]?.textContent ?? "", /2026-09-18/);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => { await tick(); });

    await openAction("标记风险");
    dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="risk-dialog-title"]')!;
    const selects = dialog.querySelectorAll<HTMLSelectElement>("select");
    const textareas = dialog.querySelectorAll<HTMLTextAreaElement>("textarea");
    await act(async () => {
      changeSelect(selects[0]!, "critical");
      changeSelect(selects[1]!, "quality");
      changeTextArea(textareas[0]!, "发现批次质量风险，需要保留输入");
      changeTextArea(textareas[1]!, "要求供应商提供完整纠正计划");
      await tick();
    });
    const riskAuthoritative = await submitTwiceAndReject(dialog, "标记为风险", "/api/procurement/execution/mark_at_risk", "当前角色无权标记风险", 403);
    assert.equal(selects[0]!.value, "critical");
    assert.equal(selects[1]!.value, "quality");
    assert.equal(textareas[0]!.value, "发现批次质量风险，需要保留输入");
    assert.equal(textareas[1]!.value, "要求供应商提供完整纠正计划");
    const riskUncertain = await submitTwiceAndReject(dialog, "标记为风险", "/api/procurement/execution/mark_at_risk", "风险结果尚未确定", 503);
    assert.notEqual(riskUncertain.key, riskAuthoritative.key, "403 must retire the risk key");
    const riskReplay = await submitTwiceAndReject(dialog, "标记为风险", "/api/procurement/execution/mark_at_risk", "风险版本冲突", 409);
    assert.equal(riskReplay.key, riskUncertain.key, "503 must retain the risk key");
    assert.match(renderedRow.cells[6]?.textContent ?? "", /高/);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await act(async () => { await tick(); });

    const sync = [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "同步 Odoo")!;
    await act(async () => {
      sync.click();
      sync.click();
      await tick();
      const requests = posts.filter((request) => request.path === "/api/procurement/suppliers/sync");
      assert.equal(requests.length, 1, "Odoo sync must synchronously emit one request");
      for (const resolve of pending.get("/api/procurement/suppliers/sync") ?? []) resolve(json({ error: "Odoo 同步结果尚未确定", code: "SERVICE_UNAVAILABLE" }, 503));
      await tick();
    });
    assert.match(document.body.textContent ?? "", /Odoo 同步结果尚未确定/);
    const firstSyncKey = posts.filter((request) => request.path === "/api/procurement/suppliers/sync")[0]!.key;
    await act(async () => {
      sync.click();
      await tick();
      const requests = posts.filter((request) => request.path === "/api/procurement/suppliers/sync");
      assert.equal(requests[1]!.key, firstSyncKey, "503 must retain the Odoo sync key");
      for (const resolve of pending.get("/api/procurement/suppliers/sync") ?? []) resolve(json({ error: "当前角色无权同步", code: "FORBIDDEN" }, 403));
      pending.set("/api/procurement/suppliers/sync", []);
      await tick();
    });
    await act(async () => {
      sync.click();
      await tick();
      const requests = posts.filter((request) => request.path === "/api/procurement/suppliers/sync");
      assert.notEqual(requests[2]!.key, firstSyncKey, "403 must retire the Odoo sync key");
      for (const resolve of pending.get("/api/procurement/suppliers/sync") ?? []) resolve(json({ error: "同步结果再次未知", code: "SERVICE_UNAVAILABLE" }, 503));
      await tick();
    });
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    await tick();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("route evidence upload, bind and revoke are single-flight and preserve file references after 403/409/422", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const documentCandidate = {
    id: "candidate:contract",
    type: "route_document",
    evidenceType: "contract",
    eligible: true,
    reference: "route-document:contract:1",
    label: "合同 CONTRACT-001",
    summary: "境内合同",
    sourceSystem: "readywork",
    sourceEntity: "route_document",
    purchaseOrderId: "po:unclassified",
    purchaseOrderVersion: 2,
    observedAt: "2026-09-06T00:00:00.000Z",
    fields: {
      documentId: "route-document:1",
      businessReference: "CONTRACT-001",
      documentVersion: 1,
      attachmentId: "attachment:bound",
      attachmentVersion: 1,
      sha256: "a".repeat(64),
      fileName: "bound-contract.pdf",
      sizeBytes: 128,
      securityStatus: "clean",
      processingStatus: "parsed",
      detectedContentType: "application/pdf",
    },
  };
  const evidenceOrder = order({
    ...unclassifiedOrder,
    routeEvidenceCandidates: [documentCandidate],
  });
  const evidencePortfolio = { ...portfolio, items: [localOrder, evidenceOrder] };
  const evidencePayload = {
    purchaseOrderId: "po:unclassified",
    clamAvConfigured: true,
    documents: [{
      id: "route-document:1",
      evidenceType: "contract",
      businessReference: "CONTRACT-001",
      status: "active",
      version: 1,
      attachmentId: "attachment:bound",
      fileName: "bound-contract.pdf",
      attachmentVersion: 1,
      sha256: "a".repeat(64),
    }],
    availableAttachments: [{
      id: "attachment:available",
      fileName: "available-contract.pdf",
      sizeBytes: 256,
      sha256: "b".repeat(64),
      version: 4,
      securityStatus: "clean",
      processingStatus: "parsed",
      eligible: true,
    }],
    events: [],
    permissions: { operate: true, configure: true },
  };
  const requests: Array<{ path: string; method: string; key: string | null }> = [];
  const pending = new Map<string, Array<(value: Response) => void>>();
  const promptDefaults: Array<string | undefined> = [];
  let promptResult: string | null = "撤销原因必须保留";
  window.prompt = ((_message?: string, defaultValue?: string) => {
    promptDefaults.push(defaultValue);
    return promptResult;
  }) as typeof window.prompt;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/procurement/tenant-preferences")) return json({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100") return json({ portfolio: evidencePortfolio, permissions: { operate: true, approve: true, configure: true } });
    if (path === "/api/procurement/route-chat?route=local") return json(emptyChat);
    if (path === "/api/procurement/routes/po%3Aunclassified/evidence-documents" && method === "GET") return json(evidencePayload);
    const mutation = method === "POST" || method === "DELETE";
    if (mutation && path.startsWith("/api/procurement/routes/po%3Aunclassified/evidence-documents")) {
      requests.push({ path, method, key: new Headers(init?.headers).get("Idempotency-Key") });
      return new Promise<Response>((resolve) => {
        const queue = pending.get(`${method} ${path}`) ?? [];
        queue.push(resolve);
        pending.set(`${method} ${path}`, queue);
      });
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
      await tick();
      await tick();
    });
    const routeTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="确认路线 PO-UNCLASSIFIED"]')!;
    await act(async () => { routeTrigger.click(); await tick(); await tick(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="route-dialog-title"]')!;

    const businessReference = dialog.querySelector<HTMLInputElement>('input[placeholder="合同号"]')!;
    const fileInput = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    const uploadBytes = new TextEncoder().encode("verified evidence");
    const uploadFile = {
      name: "new-contract.pdf",
      type: "application/pdf",
      size: uploadBytes.byteLength,
      arrayBuffer: async () => uploadBytes.buffer,
    } as unknown as File;
    await act(async () => {
      changeInput(businessReference, "CONTRACT-NEW-001");
      Object.defineProperty(fileInput, "files", { configurable: true, value: [uploadFile] });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await tick();
    });
    const upload = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "上传并进入扫描")!;
    await act(async () => {
      upload.click();
      upload.click();
      await tick();
      const matches = requests.filter((request) => request.method === "POST" && request.path.endsWith("/evidence-documents"));
      assert.equal(matches.length, 1, "evidence upload must synchronously emit one request");
      assert.match(matches[0]!.key ?? "", /^route-evidence:/u);
      for (const resolve of pending.get("POST /api/procurement/routes/po%3Aunclassified/evidence-documents") ?? []) resolve(json({ error: "证据文件校验失败", code: "VALIDATION_ERROR" }, 422));
      await tick();
    });
    assert.equal(businessReference.value, "CONTRACT-NEW-001");
    assert.match(dialog.textContent ?? "", /new-contract\.pdf/);
    assert.match(dialog.querySelector<HTMLElement>('[role="alert"]')?.textContent ?? "", /证据文件校验失败/);

    const attachmentSelect = dialog.querySelector<HTMLSelectElement>('select[aria-label="现有 PO 附件"]')!;
    const bindReference = dialog.querySelector<HTMLInputElement>('input[placeholder="填写合同号"]')!;
    await act(async () => {
      changeSelect(attachmentSelect, "attachment:available");
      changeInput(bindReference, "CONTRACT-BIND-001");
      await tick();
    });
    const bind = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "绑定为证据")!;
    await act(async () => {
      bind.click();
      bind.click();
      await tick();
      const path = "/api/procurement/routes/po%3Aunclassified/evidence-documents/bind";
      const matches = requests.filter((request) => request.path === path);
      assert.equal(matches.length, 1, "evidence bind must synchronously emit one request");
      for (const resolve of pending.get(`POST ${path}`) ?? []) resolve(json({ error: "证据绑定版本冲突", code: "VERSION_CONFLICT", currentVersion: 5 }, 409));
      await tick();
    });
    assert.equal(attachmentSelect.value, "attachment:available");
    assert.equal(bindReference.value, "CONTRACT-BIND-001");
    assert.match(dialog.querySelector<HTMLElement>('[role="alert"]')?.textContent ?? "", /证据绑定版本冲突/);

    const revoke = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "撤销")!;
    await act(async () => {
      revoke.click();
      revoke.click();
      await tick();
      const path = "/api/procurement/routes/po%3Aunclassified/evidence-documents/route-document%3A1";
      const matches = requests.filter((request) => request.path === path && request.method === "DELETE");
      assert.equal(matches.length, 1, "evidence revoke must synchronously emit one request and one prompt");
      assert.equal(promptDefaults.length, 1);
      for (const resolve of pending.get(`DELETE ${path}`) ?? []) resolve(json({ error: "当前角色无权撤销证据", code: "FORBIDDEN" }, 403));
      await tick();
    });
    assert.match(dialog.querySelector<HTMLElement>('[role="alert"]')?.textContent ?? "", /当前角色无权撤销证据/);
    assert.match(dialog.textContent ?? "", /CONTRACT-001/);
    promptResult = null;
    await act(async () => { revoke.click(); await tick(); });
    assert.equal(promptDefaults.at(-1), "撤销原因必须保留", "failed revoke must retain the reviewed reason for the next attempt");
    assert.equal(requests.filter((request) => request.method === "DELETE").length, 1);
    assert.ok(document.querySelector('[aria-label="确认路线 PO-UNCLASSIFIED"]'), "route must remain unclassified after failed evidence mutations");
    assert.doesNotMatch(document.body.textContent ?? "", /证据文件已持久化并进入 ClamAV|路线已降级/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    await tick();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("RouteChat message send and attachment retry are single-flight with authoritative versus uncertain key lifecycles", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const blockedAttachment = {
    id: "attachment:failed",
    fileName: "failed-evidence.pdf",
    contentType: "application/pdf",
    sizeBytes: 512,
    sha256: "c".repeat(64),
    securityStatus: "clean",
    processingStatus: "parse_failed",
    detectedContentType: "application/pdf",
    createdAt: "2026-09-06T00:00:00.000Z",
    readableByModel: false,
  };
  const chatPayload = {
    conversation: { id: "route-chat:one", route: "local", status: "active", version: 4, lastSequence: 1, createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" },
    messages: [{ id: "message:one", sequence: 1, role: "assistant", content: "解析失败，请保留证据", status: "completed", model: "test-model", modelRoute: "fast", usage: null, attachment: blockedAttachment, createdAt: "2026-09-06T00:00:00.000Z" }],
    suggestedQuestions: [],
    permissions: { operate: true },
    capabilities: { attachments: { supported: true, reason: null, field: "file", accept: [".pdf"], maxBytes: 8_388_608, multipart: true } },
    model: { configured: true, route: "fast", name: "test-model", maxTokens: 512 },
  };
  const messageRequests: Array<{ key: string | null }> = [];
  const retryRequests: Array<{ key: string | null }> = [];
  const firstMessageResolvers: Array<(value: Response) => void> = [];
  const firstRetryResolvers: Array<(value: Response) => void> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/procurement/tenant-preferences")) return json({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/route-chat?route=local" && method === "GET") return json(chatPayload);
    if (path === "/api/procurement/route-chat" && method === "POST") {
      messageRequests.push({ key: new Headers(init?.headers).get("Idempotency-Key") });
      if (messageRequests.length === 1) return new Promise<Response>((resolve) => { firstMessageResolvers.push(resolve); });
      if (messageRequests.length === 2) return json({ error: "AI 请求结果尚未确定", code: "REQUEST_TIMEOUT" }, 408);
      if (messageRequests.length === 3) return json({ ...chatPayload, conversation: { ...chatPayload.conversation, version: 5, lastSequence: 3 }, messages: [
        ...chatPayload.messages,
        { id: "message:user", sequence: 2, role: "user", content: "保留这条采购问题", status: "completed", model: null, modelRoute: null, usage: null, attachment: null, createdAt: "2026-09-06T00:00:01.000Z" },
        { id: "message:assistant", sequence: 3, role: "assistant", content: "权威回答", status: "completed", model: "test-model", modelRoute: "fast", usage: null, attachment: null, createdAt: "2026-09-06T00:00:02.000Z" },
      ] });
      throw new Error("unexpected extra message send");
    }
    if (path === "/api/procurement/attachments/attachment%3Afailed/retry" && method === "POST") {
      retryRequests.push({ key: new Headers(init?.headers).get("Idempotency-Key") });
      if (retryRequests.length === 1) return new Promise<Response>((resolve) => { firstRetryResolvers.push(resolve); });
      if (retryRequests.length === 2) return json({ error: "附件重试结果尚未确定", code: "SERVICE_UNAVAILABLE" }, 503);
      if (retryRequests.length === 3) return json({ accepted: true });
      throw new Error("unexpected extra attachment retry");
    }
    throw new Error(`unexpected fetch: ${path} ${method}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react");
    runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { RouteChat } = await import("../features/procurement/route-chat.js");
    const { ProcurementTenantPreferencesProvider } = await import("../features/procurement/tenant-preferences-context.js");
    await act(async () => {
      root = createRoot(host);
      root.render(<ProcurementTenantPreferencesProvider><RouteChat route="local" mode="normal" onToggleExpand={() => undefined} onClose={() => undefined} /></ProcurementTenantPreferencesProvider>);
      await tick();
      await tick();
    });

    const input = host.querySelector<HTMLInputElement>('input[placeholder="询问关于本地采购订单的问题…"]')!;
    await act(async () => { changeInput(input, "保留这条采购问题"); await tick(); });
    const send = host.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!;
    await act(async () => {
      send.click();
      send.click();
      await tick();
      assert.equal(messageRequests.length, 1, "message send must synchronously emit one request");
      for (const resolve of firstMessageResolvers) resolve(json({ error: "消息输入校验失败", code: "VALIDATION_ERROR" }, 422));
      await tick();
    });
    const authoritativeMessageKey = messageRequests[0]!.key;
    assert.equal(input.value, "保留这条采购问题");
    assert.match(host.textContent ?? "", /消息输入校验失败/);

    await act(async () => { send.click(); await tick(); await tick(); });
    const uncertainMessageKey = messageRequests[1]!.key;
    assert.notEqual(uncertainMessageKey, authoritativeMessageKey, "422 must retire the prior message key");
    assert.equal(input.value, "保留这条采购问题");
    await act(async () => { send.click(); await tick(); });
    assert.equal(messageRequests[2]!.key, uncertainMessageKey, "408 must retain the message key for retry");
    assert.equal(input.value, "");
    assert.match(host.textContent ?? "", /权威回答/);

    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "重试解析")!;
    await act(async () => {
      retry.click();
      retry.click();
      await tick();
      assert.equal(retryRequests.length, 1, "attachment retry must synchronously emit one request");
      for (const resolve of firstRetryResolvers) resolve(json({ error: "附件版本冲突", code: "VERSION_CONFLICT", currentVersion: 2 }, 409));
      await tick();
    });
    const authoritativeRetryKey = retryRequests[0]!.key;
    assert.match(host.textContent ?? "", /附件版本冲突/);
    assert.match(host.textContent ?? "", /failed-evidence\.pdf/);

    await act(async () => { retry.click(); await tick(); });
    const uncertainRetryKey = retryRequests[1]!.key;
    assert.notEqual(uncertainRetryKey, authoritativeRetryKey, "409 must retire the prior retry key");
    assert.match(host.textContent ?? "", /failed-evidence\.pdf/);
    await act(async () => { retry.click(); await tick(); await tick(); });
    assert.equal(retryRequests[2]!.key, uncertainRetryKey, "503 must retain the attachment retry key");
    assert.match(host.textContent ?? "", /附件已重新排入解析队列/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    await tick();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("RIHD keeps blocked, failed, result-unknown and unverified dispatched states distinct from authoritative readback", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let workbenchReads = 0;
  const posts: Array<{ key: string | null; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/procurement/tenant-preferences")) return json({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100" && method === "GET") {
      workbenchReads += 1;
      return json({ portfolio: { ...portfolio, metrics: { unclassifiedRoute: 0 }, items: [localOrder] }, permissions: { operate: true, approve: true, configure: true } });
    }
    if (path === "/api/procurement/route-chat?route=local") return json(emptyChat);
    if (path === "/api/procurement/execution/update_rihd" && method === "POST") {
      posts.push({ key: new Headers(init?.headers).get("Idempotency-Key"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (posts.length === 1) return json({ outbox: { id: "outbox:blocked", status: "blocked" } });
      if (posts.length === 2) return json({ outbox: { id: "outbox:failed", status: "failed", error: "Odoo 明确拒绝该日期" } });
      if (posts.length === 3) return json({ error: "RIHD 写入结果尚未确定", code: "SERVICE_UNAVAILABLE" }, 503);
      if (posts.length === 4) return json({ outbox: { id: "outbox:dispatched", status: "dispatched" } });
      throw new Error("unexpected extra RIHD write");
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
      await tick();
      await tick();
    });
    const actionTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="PO-FOCUS 操作"]')!;
    const openRihd = async () => {
      await act(async () => { actionTrigger.click(); await tick(); });
      const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === "修改 RIHD")!;
      await act(async () => { menuItem.click(); await tick(); });
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="rihd-dialog-title"]')!;
      await act(async () => {
        changeInput(dialog.querySelector<HTMLInputElement>('input[type="date"]')!, "2026-09-18");
        changeTextArea(dialog.querySelector<HTMLTextAreaElement>("textarea")!, "项目日期调整，等待真实回读");
        await tick();
      });
      return dialog;
    };
    const submitRihd = async (dialog: HTMLElement) => {
      const submit = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "提交并等待 Odoo 回执")!;
      await act(async () => { submit.click(); await tick(); await tick(); });
    };
    const closeDialog = async () => {
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      await act(async () => { await tick(); });
    };

    let dialog = await openRihd();
    await submitRihd(dialog);
    assert.match(dialog.textContent ?? "", /等待 Odoo 连接器就绪/);
    assert.doesNotMatch(dialog.textContent ?? "", /RIHD 已生效/);
    await closeDialog();

    dialog = await openRihd();
    await submitRihd(dialog);
    assert.match(dialog.textContent ?? "", /Odoo 回写未能确认/);
    assert.match(dialog.textContent ?? "", /Odoo 明确拒绝该日期/);
    assert.doesNotMatch(dialog.textContent ?? "", /RIHD 已生效/);
    await closeDialog();

    dialog = await openRihd();
    const date = dialog.querySelector<HTMLInputElement>('input[type="date"]')!;
    const reason = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
    await submitRihd(dialog);
    assert.match(dialog.textContent ?? "", /RIHD 写入结果尚未确定/);
    assert.equal(date.value, "2026-09-18");
    assert.equal(reason.value, "项目日期调整，等待真实回读");
    const uncertainKey = posts[2]!.key;
    const readsBeforeDispatched = workbenchReads;
    await submitRihd(dialog);
    assert.equal(posts[3]!.key, uncertainKey, "503 retry must reuse the unchanged RIHD key");
    assert.ok(workbenchReads > readsBeforeDispatched, "a dispatched receipt must trigger an authoritative workbench readback");
    assert.doesNotMatch(dialog.textContent ?? "", /RIHD 已生效为 2026-09-18/);
    assert.match(dialog.textContent ?? "", /回读尚未确认/);
    const renderedRow = [...document.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((row) => row.textContent?.includes("PO-FOCUS"))!;
    assert.match(renderedRow.cells[4]?.textContent ?? "", /2026-09-08/);
    assert.doesNotMatch(renderedRow.cells[4]?.textContent ?? "", /2026-09-18/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    await tick();
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("RIHD pending and processing remain non-success until dispatched is verified by matching workbench readback", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  const originalWindowSetTimeout = window.setTimeout.bind(window);
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let currentRihd = "2026-09-08T00:00:00.000Z";
  const outboxResolvers: Array<(value: Response) => void> = [];
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => originalWindowSetTimeout(handler, timeout === 1_500 ? 0 : timeout, ...args)) as typeof window.setTimeout;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/procurement/tenant-preferences")) return json({ item: null, effective: { timeZone: "Asia/Shanghai", dateFormat: "YYYY-MM-DD", locale: "zh-CN" }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === "/api/procurement/workbench?limit=100") return json({ portfolio: { ...portfolio, metrics: { unclassifiedRoute: 0 }, items: [{ ...localOrder, requiredInHouseAt: currentRihd }] }, permissions: { operate: true, approve: true, configure: true } });
    if (path === "/api/procurement/route-chat?route=local") return json(emptyChat);
    if (path === "/api/procurement/execution/update_rihd" && method === "POST") return json({ outbox: { id: "outbox:sequence", status: "pending" } });
    if (path === "/api/procurement/execution/outbox" && method === "GET") return new Promise<Response>((resolve) => { outboxResolvers.push(resolve); });
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
      await tick();
      await tick();
    });
    const actionTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="PO-FOCUS 操作"]')!;
    await act(async () => { actionTrigger.click(); await tick(); });
    const menuItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent?.trim() === "修改 RIHD")!;
    await act(async () => { menuItem.click(); await tick(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="rihd-dialog-title"]')!;
    await act(async () => {
      changeInput(dialog.querySelector<HTMLInputElement>('input[type="date"]')!, "2026-09-18");
      changeTextArea(dialog.querySelector<HTMLTextAreaElement>("textarea")!, "按项目要求调整并等待回读");
      await tick();
    });
    const submit = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === "提交并等待 Odoo 回执")!;
    await act(async () => { submit.click(); await tick(); });
    assert.equal(outboxResolvers.length, 1);
    assert.match(dialog.textContent ?? "", /正在等待 Odoo 真实回执/);
    assert.match(dialog.textContent ?? "", /待处理/);
    assert.doesNotMatch(dialog.textContent ?? "", /RIHD 已生效/);

    await act(async () => {
      outboxResolvers[0]!(json({ items: [{ id: "outbox:sequence", status: "processing" }] }));
      await tick();
      await tick();
    });
    assert.match(dialog.textContent ?? "", /处理中/);
    assert.doesNotMatch(dialog.textContent ?? "", /RIHD 已生效/);
    assert.equal(outboxResolvers.length, 2);

    currentRihd = "2026-09-18T00:00:00.000Z";
    await act(async () => {
      outboxResolvers[1]!(json({ items: [{ id: "outbox:sequence", status: "dispatched" }] }));
      await tick();
      await tick();
    });
    assert.match(dialog.textContent ?? "", /Odoo 写入与回读核验已完成/);
    assert.match(dialog.textContent ?? "", /RIHD 已生效为 2026-09-18/);
    const renderedRow = [...document.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((row) => row.textContent?.includes("PO-FOCUS"))!;
    assert.match(renderedRow.cells[4]?.textContent ?? "", /2026-09-18/);
  } finally {
    window.setTimeout = originalWindowSetTimeout as typeof window.setTimeout;
    if (runAct) await runAct(async () => root?.unmount());
    await tick();
    globalThis.fetch = originalFetch;
    restore();
  }
});
