import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const at = '2026-08-21T00:00:00.000Z';

function installDom(): { dom: JSDOM; host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/' });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) { previous.set(key, (globalThis as Record<string, unknown>)[key]); (globalThis as Record<string, unknown>)[key] = value; }
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  dom.window.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  dom.window.cancelAnimationFrame = (id: number) => clearTimeout(id);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => undefined });
  return { dom, host: dom.window.document.querySelector<HTMLDivElement>('#root')!, restore: () => {
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  } };
}

function changeTextarea(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView!.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function waitForCondition(condition: () => boolean, description: string, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('Cancel PO uses a Radix danger dialog and reconciles pending/unknown with one request identity', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const cancelRequests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const po = {
    id: 'po:ui:cancel', sourceSystem: 'odoo', externalId: 'purchase.order:401', number: 'P00401', status: 'confirmed', version: 3,
    supplierId: 'supplier:ui', supplierName: 'UI Supplier', currency: 'CNY', orderedAt: at, updatedAt: at,
  };
  const workbench = { documents: { purchaseOrders: { items: [po] } }, tasks: { items: [] }, approvals: { items: [] }, executionApprovals: { items: [] }, exceptions: { items: [] }, portfolio: { items: [] }, permissions: { operate: true, approve: true } };
  const context = { requestedId: po.id, objectId: po.id, purchaseOrders: [po], suppliers: [{ id: 'supplier:ui', name: 'UI Supplier', contacts: [] }], shipments: [], receipts: [], invoices: [], quantityProjections: [], linesByDocument: { [po.id]: [{ id: 'line:ui:cancel', lineNumber: '10', itemId: 'VALVE', description: '阀门', uom: 'EA', orderedQty: 2, unitPrice: 10, currency: 'CNY' }] }, stageTimeline: [], purchaseOrderCancellation: null as null | { requestId: string; state: string; sourcePoVersion: number; outboxId: string | null; idempotencyKey: string; reason: string } };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path.startsWith('/api/procurement/workbench/context/')) return response(context);
    if (path.startsWith('/api/procurement/workbench')) return response(workbench);
    if (path === '/api/procurement/execution/cancel_po') {
      cancelRequests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return response(cancelRequests.length === 1
        ? { requestId: 'purchase-order-cancellation:401', status: 'pending_external', purchaseOrderVersion: 3, outboxId: 'outbox:401' }
        : { requestId: 'purchase-order-cancellation:401', status: 'unknown', purchaseOrderVersion: 3, outboxId: 'outbox:401' }, cancelRequests.length === 1 ? 201 : 200);
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementPoEmployee } = await import('../features/procurement/po-employee.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementPoEmployee /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const actions = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '操作')!;
    await act(async () => { actions.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === '取消采购订单')!;
    assert.equal(cancel.disabled, false);
    await act(async () => { cancel.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(document.body.textContent ?? '', /取消采购订单/);
    assert.match(document.body.textContent ?? '', /不会删除 PO、行项目、文档或历史/);
    assert.match(document.body.textContent ?? '', /尚未发现发运、收货 GRN 或发票阻断/);
    const reason = document.querySelector<HTMLTextAreaElement>('[aria-label="取消原因"]')!;
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('取消采购订单'))!;
    assert.equal(confirm.disabled, true);
    await act(async () => { changeTextarea(reason, '项目取消，已完成内部审批'); });
    assert.equal(confirm.disabled, false);
    await act(async () => { confirm.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(cancelRequests.length, 1);
    assert.deepEqual(cancelRequests[0]!.body, { aggregateId: po.id, expectedVersion: 3, reason: '项目取消，已完成内部审批' });
    assert.match(cancelRequests[0]!.headers.get('Idempotency-Key') ?? '', /^web-po:cancel:/);
    assert.match(document.body.textContent ?? '', /等待外部回执/);
    const reconcile = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('核对状态'))!;
    await act(async () => { reconcile.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(cancelRequests.length, 2);
    assert.equal(cancelRequests[1]!.headers.get('Idempotency-Key'), cancelRequests[0]!.headers.get('Idempotency-Key'));
    assert.deepEqual(cancelRequests[1]!.body, cancelRequests[0]!.body);
    assert.match(document.body.textContent ?? '', /需要处理/);
    assert.match(document.body.textContent ?? '', /不要使用新请求编号重复取消/);
    const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭取消采购订单"]')!;
    await act(async () => { close.click(); });
    await waitForCondition(() => document.activeElement === actions, 'cancellation dialog focus restoration');
    assert.equal(document.activeElement === actions, true, 'closing the cancellation dialog returns focus to Actions');
    context.purchaseOrderCancellation = {
      requestId: 'purchase-order-cancellation:401', state: 'unknown', sourcePoVersion: 3,
      outboxId: 'outbox:401', idempotencyKey: cancelRequests[0]!.headers.get('Idempotency-Key')!, reason: '项目取消，已完成内部审批',
    };
    await act(async () => {
      root?.unmount();
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementPoEmployee /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const restoredActions = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '操作')!;
    await act(async () => { restoredActions.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const restoredCancel = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === '取消采购订单')!;
    await act(async () => { restoredCancel.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(document.body.textContent ?? '', /需要处理/);
    assert.match(document.body.textContent ?? '', new RegExp(cancelRequests[0]!.headers.get('Idempotency-Key')!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});
