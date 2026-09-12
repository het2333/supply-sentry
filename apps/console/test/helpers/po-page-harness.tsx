import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Root } from 'react-dom/client';

export type Row = Record<string, unknown>;

export function poPageFixture(status = 'sent', stage = 'supplier_commitment') {
  const po: Row = { id: 'po:page', externalId: 'PO-PAGE', sourceSystem: 'readywork', status, stage, version: 4, supplierId: 'supplier:page', supplierName: '页面测试供应商', currency: 'CNY', updatedAt: '2026-09-06T00:00:00.000Z', requiredInHouseAt: '2026-09-20T00:00:00.000Z' };
  const line: Row = { id: 'line:page', poId: po.id, itemId: 'VALVE', description: '测试阀门', orderedQty: 200, unitPrice: 127, uom: '件', currency: 'CNY', requestedAt: po.requiredInHouseAt };
  const workbench = { documents: { purchaseOrders: { items: [po] } }, portfolio: { items: [po] }, tasks: { items: [] as Row[] }, approvals: { items: [] as Row[] }, executionApprovals: { items: [] as Row[] }, exceptions: { items: [] as Row[] }, permissions: { operate: true, approve: true } };
  const context = {
    requestedId: po.id, objectId: po.id, purchaseOrders: [po], suppliers: [{ id: po.supplierId, name: po.supplierName, contacts: [], sourceSystem: 'readywork' }],
    linesByDocument: { [String(po.id)]: [line] }, quantityProjections: [] as Row[], stageTimeline: [{ id: stage, label: '当前阶段', state: 'active', description: '来自已核验事实' }],
    executionApprovals: [] as Row[], confirmations: [] as Row[], shipments: [] as Row[], receipts: [] as Row[], invoices: [] as Row[], attachments: [] as Row[], communications: [] as Row[], tasks: [] as Row[], approvals: [] as Row[], documents: [] as Row[], history: [] as Row[],
    actionReadiness: { send_po: { ready: true, code: 'ready', message: '发送条件已就绪' }, queue_followup: { ready: true, code: 'ready', message: '可创建跟进草稿' }, duplicate_po: { ready: true, code: 'ready', message: '可复制订单' } },
    poDetail: { documents: { rows: [] as Row[], requirements: [] as Row[], kpis: { total: 0, verified: 0, pending: 0, missing: 0 } }, history: { events: [] as Row[] } },
  };
  return { po, line, workbench, context };
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function deferredResponse(signal?: AbortSignal | null) {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((accept, reject) => {
    resolve = accept;
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  return { promise, resolve };
}

export async function withPoPage(options: {
  fixture?: ReturnType<typeof poPageFixture>;
  initialId?: string;
  intent?: 'edit-rihd' | 'mark-at-risk';
  tab?: string;
  fetch?: (path: string, init?: RequestInit) => Promise<Response> | Response | undefined;
}, check: (page: {
  act: typeof import('react').act;
  button: (pattern: RegExp, scope?: ParentNode) => HTMLButtonElement;
  realtime: () => Promise<void>;
  fixture: ReturnType<typeof poPageFixture>;
  requests: Array<{ path: string; body: Row; key: string | null }>;
  reads: string[];
}) => Promise<void>) {
  const fixture = options.fixture ?? poPageFixture();
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/?section=orders' });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, PointerEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
  Object.assign(globalThis, globals);
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: globals.requestAnimationFrame });
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: globals.cancelAnimationFrame });
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  for (const method of ['scrollTo', 'scrollBy', 'scrollIntoView']) Object.defineProperty(dom.window.HTMLElement.prototype, method, { configurable: true, value: () => undefined });
  const requests: Array<{ path: string; body: Row; key: string | null }> = [];
  const reads: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (init?.method && init.method !== 'GET') requests.push({ path, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('Idempotency-Key') });
    else reads.push(path);
    const custom = options.fetch?.(path, init);
    if (custom !== undefined) return custom;
    if (path.startsWith('/api/procurement/tenant-preferences')) return jsonResponse({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path.startsWith('/api/procurement/workbench/context/')) return jsonResponse(fixture.context);
    if (path.startsWith('/api/procurement/workbench')) return jsonResponse(fixture.workbench);
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  let root: Root | undefined;
  const { act, useState } = await import('react');
  try {
    const { createRoot } = await import('react-dom/client');
    const { ProcurementPoEmployee } = await import('../../features/procurement/po-employee.js');
    const { ProcurementTenantPreferencesProvider } = await import('../../features/procurement/tenant-preferences-context.js');
    function Harness() {
      const [initialId, setInitialId] = useState<string | null>(options.initialId ?? String(fixture.po.id));
      const [intent, setIntent] = useState(options.intent);
      return <ProcurementTenantPreferencesProvider><ProcurementPoEmployee initialPurchaseOrderId={initialId} initialPurchaseOrderIntent={intent} initialDetailTab={options.tab ?? 'overview'} onInitialPurchaseOrderConsumed={() => { setInitialId(null); setIntent(undefined); }} detailPresentation="page" /></ProcurementTenantPreferencesProvider>;
    }
    await act(async () => {
      root = createRoot(document.querySelector('#root')!);
      root.render(<Harness />);
    });
    const button = (pattern: RegExp, scope: ParentNode = document) => {
      const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((entry) => pattern.test(entry.textContent ?? ''));
      assert.ok(found, `missing button ${pattern}`);
      return found;
    };
    const realtime = async () => {
      await act(async () => {
        window.dispatchEvent(new CustomEvent('readywork:procurement-realtime', { detail: { family: 'pos', id: 'event:test' } }));
        // Wait for the production hook's 250 ms debounce, not a simulated refresh.
        await new Promise((resolve) => setTimeout(resolve, 275));
      });
    };
    await check({ act, requests, reads, button, realtime, fixture });
  } finally {
    await act(async () => root?.unmount());
    // Radix restores modal focus on its deferred unmount task. Keep the same
    // DOM constructors alive until that task has completed.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  }
}
