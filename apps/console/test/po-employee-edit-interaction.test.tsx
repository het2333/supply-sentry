import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const at = '2026-08-21T00:00:00.000Z';

function installDom(): { dom: JSDOM; host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/' });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
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

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView!.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('Actions is a keyboard-accessible menu that closes and returns focus from Edit PO', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: unknown) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const editRequests: Array<Record<string, unknown>> = [];
  let resolveDocumentRequest: ((value: Response) => void) | undefined;
  let failDocumentRequest = false;
  let immediateDocumentResponse = false;
  let documentPostRequests = 0;
  let openerWindowFocusCalls = 0;
  const nullPopupUrls: string[] = [];
  const openedWindows: Array<{ opener: Window | null; location: { href: string }; close: () => void; closed: boolean; blur: () => void; blurred: boolean }> = [];
  const po = {
    id: 'po:ui:edit', sourceSystem: 'readywork', externalId: 'PO-UI-EDIT', status: 'draft', version: 3, supplierId: 'supplier:ui',
    supplierName: 'UI Supplier', currency: 'CNY', orderedAt: at, requiredInHouseAt: '2026-09-10T00:00:00.000Z', materialType: 'direct', updatedAt: at,
  };
  const workbench = { documents: { purchaseOrders: { items: [po] } }, tasks: { items: [] }, approvals: { items: [] }, executionApprovals: { items: [] }, exceptions: { items: [] }, portfolio: { items: [] }, permissions: { operate: true, approve: false } };
  const context = { requestedId: po.id, objectId: po.id, purchaseOrders: [po], suppliers: [{ id: 'supplier:ui', name: 'UI Supplier', contacts: [{ id: 'contact:ui', name: '采购联系人', email: 'buyer@example.test', primary: true }] }], linesByDocument: { [po.id]: [{ id: 'line:ui', lineNumber: '10', itemId: 'VALVE-UI', description: '阀门', uom: 'EA', orderedQty: 2, unitPrice: 10, taxRate: 0.13, currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z' }] }, stageTimeline: [] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path.startsWith('/api/procurement/workbench/context/')) return response(context);
    if (path.startsWith('/api/procurement/workbench')) return response(workbench);
    if (path === '/api/procurement/execution/edit_po') {
      editRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({ error: '订单已被其他操作更新', currentVersion: 7 }, 409);
    }
    if (path.startsWith(`/api/procurement/purchase-orders/${encodeURIComponent(po.id)}/document-snapshots`)) {
      documentPostRequests += 1;
      if (failDocumentRequest) return response({ error: '文档服务暂时不可用' }, 500);
      if (immediateDocumentResponse) return response({ pdfUrl: '/api/procurement/purchase-order-document-snapshots/snapshot:null/pdf', printUrl: '/api/procurement/purchase-order-document-snapshots/snapshot:null/print' });
      return new Promise<Response>((resolve) => { resolveDocumentRequest = resolve; });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    Object.defineProperty(window, 'open', { configurable: true, value: () => {
      const popup = { opener: window, location: { href: '' }, closed: false, blurred: false, close() { this.closed = true; }, blur() { this.blurred = true; } };
      openedWindows.push(popup);
      return popup;
    } });
    Object.defineProperty(window, 'focus', { configurable: true, value: () => { openerWindowFocusCalls += 1; } });
    Object.defineProperty(window, 'alert', { configurable: true, value: () => undefined });
    const { act } = await import('react');
    runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementPoEmployee } = await import('../features/procurement/po-employee.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const renderedRoot = createRoot(host);
      root = renderedRoot as unknown as { render: (node: unknown) => void; unmount: () => void };
      renderedRoot.render(<ProcurementTenantPreferencesProvider><ProcurementPoEmployee /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const actionMenu = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '操作');
    assert.ok(actionMenu, 'Actions trigger should render');
    assert.equal(actionMenu.getAttribute('aria-haspopup'), 'menu');
    assert.equal(actionMenu.getAttribute('aria-expanded'), 'false');
    await act(async () => { actionMenu.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(actionMenu.getAttribute('aria-expanded'), 'true');
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    assert.ok(menu, 'Actions menu should render');
    const menuItems = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    assert.deepEqual(menuItems.map((button) => button.textContent?.trim()), ['编辑采购订单', '复制订单', '下载 PDF', '打印', '取消采购订单']);
    assert.equal(menuItems[0]?.disabled, false);
    assert.equal(menuItems[1]?.disabled, true);
    assert.equal(menuItems[2]?.disabled, false);
    assert.equal(menuItems[3]?.disabled, false);
    assert.equal(menuItems[4]?.disabled, true);
    assert.equal(document.activeElement === menuItems[0], true, 'opening the menu focuses its first enabled item');
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    assert.equal(document.activeElement === menuItems[2], true, 'ArrowDown skips disabled menu items');
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    assert.equal(document.activeElement === menuItems[0], true, 'ArrowUp focuses the previous enabled menu item');
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    assert.equal(document.activeElement === menuItems[3], true, 'End focuses the last enabled item');
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    assert.equal(document.activeElement === menuItems[0], true, 'Home focuses the first enabled item');
    await act(async () => { menuItems[2]!.focus(); menuItems[2]!.click(); });
    assert.equal(actionMenu.getAttribute('aria-expanded'), 'true', 'loading keeps the menu visible');
    assert.match(menu.textContent ?? '', /正在生成 PDF…/);
    assert.equal(menuItems[2]?.disabled, true);
    assert.equal(menuItems[3]?.disabled, true);
    assert.equal(openedWindows[0]?.opener === null, true, 'the opened document window is detached from Console');
    assert.equal(openedWindows[0]?.blurred, true, 'the reserved window yields focus during generation');
    assert.ok(openerWindowFocusCalls > 0, 'generation asks the opener window to retain focus');
    assert.equal(document.activeElement === menuItems[2], true, 'the opener menu item remains focused while generation is pending');
    await act(async () => { resolveDocumentRequest!(response({ pdfUrl: '/api/procurement/purchase-order-document-snapshots/snapshot:ui/pdf', printUrl: '/api/procurement/purchase-order-document-snapshots/snapshot:ui/print' })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(actionMenu.getAttribute('aria-expanded'), 'false');
    assert.equal(openedWindows[0]?.location.href, '/api/procurement/purchase-order-document-snapshots/snapshot:ui/pdf');
    assert.equal(document.activeElement === actionMenu, true, 'successful generation closes the menu and restores Actions focus');
    await act(async () => { actionMenu.click(); });
    failDocumentRequest = true;
    const printDocument = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === '打印')!;
    await act(async () => { printDocument.focus(); printDocument.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(actionMenu.getAttribute('aria-expanded'), 'true', 'failure leaves the menu visible');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /文档服务暂时不可用/);
    assert.equal(openedWindows[1]?.closed, true, 'failure closes the blank popup rather than showing a false success');
    assert.equal(document.activeElement === printDocument, true, 'failure keeps focus in the visible menu for recovery');
    failDocumentRequest = false;
    immediateDocumentResponse = true;
    Object.defineProperty(window, 'open', { configurable: true, value: () => null });
    Object.defineProperty(window.HTMLAnchorElement.prototype, 'click', { configurable: true, value: function(this: HTMLAnchorElement) { nullPopupUrls.push(this.href); } });
    const { openPoDocumentSnapshot } = await import('../features/procurement/po-print-view.js');
    const postsBeforeBlockedPopup = documentPostRequests;
    await assert.rejects(() => openPoDocumentSnapshot({ purchaseOrderId: po.id, expectedVersion: po.version, purpose: 'download' }), /浏览器阻止/u);
    assert.equal(documentPostRequests, postsBeforeBlockedPopup, 'popup blocking must abort before POST');
    assert.deepEqual(nullPopupUrls, [], 'popup blocking is visible failure, never a false success');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(actionMenu.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement === actionMenu, true, 'Escape restores focus to Actions');
    await act(async () => { actionMenu.click(); await new Promise((resolve) => setTimeout(resolve, 0)); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    assert.equal(actionMenu.getAttribute('aria-expanded'), 'false');
    await act(async () => { actionMenu.click(); });
    const editButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '编辑采购订单')!;
    await act(async () => { editButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '取消')!;
    await act(async () => { cancel.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(document.activeElement === actionMenu, true, 'closing Edit PO restores focus to Actions');
    await act(async () => { actionMenu.click(); });
    const reopenedEdit = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '编辑采购订单')!;
    await act(async () => { reopenedEdit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(document.activeElement === actionMenu, true, 'escaping Edit PO restores focus to Actions');
    await act(async () => { actionMenu.click(); });
    const closeableEdit = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '编辑采购订单')!;
    await act(async () => { closeableEdit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭编辑采购订单"]')!;
    await act(async () => { close.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(document.activeElement === actionMenu, true, 'closing Edit PO with its close button restores focus to Actions');
    await act(async () => { actionMenu.click(); });
    const finalEdit = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '编辑采购订单')!;
    await act(async () => { finalEdit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dateInput = document.querySelector<HTMLInputElement>('input[type="date"]')!;
    const reasonInput = document.querySelector<HTMLInputElement>('input[minlength="4"]')!;
    assert.ok(dateInput, 'Edit PO date input should render');
    assert.ok(reasonInput, 'Edit PO reason input should render');
    await act(async () => { changeInput(dateInput, '2026-09-30'); changeInput(reasonInput, '已批准交期调整'); });
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('保存修改'))!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(editRequests, [{ aggregateId: po.id, expectedVersion: 3, reason: '已批准交期调整', patch: { requiredInHouseAt: '2026-09-30' } }]);
    assert.equal(document.querySelector<HTMLInputElement>('input[type="date"]')?.value, '2026-09-30', 'operator input survives the conflict reload');
    assert.equal(document.querySelector<HTMLInputElement>('input[minlength="4"]')?.value, '已批准交期调整', 'reason survives the conflict reload');
    assert.match(document.body.textContent ?? '', /服务器当前版本为 7/);
    assert.match(document.body.textContent ?? '', /订单版本或状态已变化/);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch;
    restore();
  }
});
