import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { Root } from 'react-dom/client';

const po = {
  id: 'po:intent', sourceSystem: 'readywork', externalId: 'PO-INTENT', number: '430092', status: 'draft', version: 3,
  supplierId: 'supplier:intent', supplierName: 'Intent Supplier', currency: 'CNY', orderedAt: '2026-08-21T00:00:00.000Z',
  requiredInHouseAt: '2026-09-10T00:00:00.000Z', materialType: 'direct', stage: 'supplier_commitment',
  stageLabel: '供应商承诺', risk: 'medium', updatedAt: '2026-08-21T00:00:00.000Z',
  actionReadiness: { mark_at_risk: { ready: true, code: 'ready', message: '可以创建人工风险事实', exceptionId: null } },
};
const workbench = {
  documents: { purchaseOrders: { items: [po] } }, tasks: { items: [] }, approvals: { items: [] },
  executionApprovals: { items: [] }, exceptions: { items: [] }, portfolio: { items: [po] },
  permissions: { operate: true, approve: true },
};
const context = {
  requestedId: po.id, objectId: po.id, purchaseOrders: [po],
  suppliers: [{ id: po.supplierId, name: po.supplierName, contacts: [{ id: 'contact:intent', name: '采购联系人', email: 'buyer@example.test', primary: true }] }],
  linesByDocument: { [po.id]: [{ id: 'line:intent', itemId: 'ITEM-1', description: '阀门', uom: 'EA', orderedQty: 2, unitPrice: 10, requestedAt: po.requiredInHouseAt }] },
  stageTimeline: [],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('PO navigation intents open the real RIHD and versioned Mark at risk dialogs', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/?section=orders&poId=po%3Aintent' });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), PointerEvent: dom.window.MouseEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) { previous.set(key, (globalThis as Record<string, unknown>)[key]); (globalThis as Record<string, unknown>)[key] = value; }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: globals.requestAnimationFrame });
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: globals.cancelAnimationFrame });
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => undefined });
  const originalFetch = globalThis.fetch;
  const polling = new Map<number, () => void>();
  let timerId = 0;
  dom.window.setInterval = ((callback: () => void) => { polling.set(++timerId, callback); return timerId; }) as typeof dom.window.setInterval;
  dom.window.clearInterval = (id) => { if (id !== undefined) polling.delete(id); };
  let contextReads = 0;
  const riskPosts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path.startsWith('/api/procurement/workbench/context/')) { contextReads++; return response(context); }
    if (path.startsWith('/api/procurement/workbench')) return response(workbench);
    if (path === '/api/procurement/execution/mark_at_risk' && init?.method === 'POST') {
      riskPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return response({ exception: { id: 'exception:intent', status: 'open', version: 1 } });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | undefined;
  try {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ProcurementPoEmployee } = await import('../features/procurement/po-employee.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    const consumed: string[] = [];
    const rendered = createRoot(document.querySelector<HTMLDivElement>('#root')!); root = rendered;
    const render = (intent: 'edit-rihd' | 'mark-at-risk') => rendered.render(<ProcurementTenantPreferencesProvider><ProcurementPoEmployee initialPurchaseOrderId={po.id} initialPurchaseOrderIntent={intent} onInitialPurchaseOrderConsumed={() => consumed.push(intent)} /></ProcurementTenantPreferencesProvider>);
    await act(async () => { render('edit-rihd'); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 20)); });
    const readsBeforePoll = contextReads;
    await act(async () => { for (const callback of [...polling.values()]) callback(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.ok(contextReads > readsBeforePoll, '没有进行中任务时也刷新当前 PO，避免 SSE 中断后回信结果永久陈旧');
    assert.ok([...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.textContent?.includes('修改要求到货日')));
    assert.equal(document.querySelectorAll<HTMLInputElement>('input[type="date"]').length, 1, 'RIHD intent exposes only the RIHD date field');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(document.activeElement?.textContent?.trim(), '操作', 'Escape from an RIHD intent returns focus to the PO Actions trigger');
    await act(async () => { render('mark-at-risk'); await new Promise((resolve) => setTimeout(resolve, 20)); });
    const riskDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) => dialog.textContent?.includes('标记风险'))!;
    assert.ok(riskDialog);
    const reason = riskDialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="风险原因"]')!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(reason, '供应商确认关键物料短缺'); reason.dispatchEvent(new Event('input', { bubbles: true })); reason.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { [...riskDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('标记风险'))!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.deepEqual(riskPosts, [{ aggregateId: po.id, expectedVersion: 3, riskSeverity: 'high', riskCategory: 'supplier_response', reason: '供应商确认关键物料短缺' }]);
    assert.match(riskDialog.textContent ?? '', /exception:intent/);
    assert.deepEqual(consumed, ['edit-rihd', 'mark-at-risk']);
    await act(async () => { [...riskDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '关闭')!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(document.activeElement?.textContent?.trim(), '操作', 'closing a risk intent returns focus to the PO Actions trigger');
    await act(async () => root?.unmount());
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  }
});
