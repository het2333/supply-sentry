import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/' });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = setTimeout(() => callback(Date.now()), 0); return Number(id); },
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) { previous.set(key, (globalThis as Record<string, unknown>)[key]); (globalThis as Record<string, unknown>)[key] = value; }
  return { host: dom.window.document.querySelector<HTMLDivElement>('#root')!, restore: () => {
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  } };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('Notifications preserves the exact unread count and uses real read/filter/navigation actions', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; method: string }> = [];
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const navigations: Array<{ destination: string; objectId?: string | null }> = [];
  const item = {
    id: 'notification:110', type: 'po_escalated', severity: 'high', title: 'PO 430092 已升级', message: '供应商未响应，需要处理。', tag: 'PO ESCALATED',
    objectType: 'purchase_order', objectId: 'po:430092', evidence: {}, status: 'unread', version: 1, readBy: null, readAt: null,
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z', targetSection: 'orders',
  };
  let serverUnread = 110;
  let readAllFails = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); const method = init?.method ?? 'GET'; requests.push({ path, method });
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { countryCode: 'CN', workingDays: [1, 2, 3, 4, 5], timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', slaEscalationsEnabled: true, excludeWeekends: true, excludePublicHolidays: true, autoCalculateLeadTime: true }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/notifications?filter=all') return response({ items: serverUnread ? [item] : [], counts: { all: 110, unread: serverUnread, read: 110 - serverUnread }, generatedAt: item.createdAt, capabilities: { markRead: true } });
    if (path === '/api/procurement/notifications?filter=unread') return response({ items: serverUnread ? [item] : [], counts: { all: 110, unread: serverUnread, read: 110 - serverUnread }, generatedAt: item.createdAt, capabilities: { markRead: true } });
    if (path === '/api/procurement/notifications/notification%3A110/read' && method === 'POST') { serverUnread = 109; return response({ item: { ...item, status: 'read', version: 2, readBy: 'human:manager', readAt: item.createdAt } }); }
    if (path === '/api/procurement/notifications/read-all' && method === 'POST') {
      if (readAllFails) return response({ error: '通知批量更新失败' }, 500);
      const updated = serverUnread; serverUnread = 0;
      return response({ items: [], counts: { all: 110, unread: 0, read: 110 }, generatedAt: item.createdAt, updated, capabilities: { markRead: true } });
    }
    throw new Error(`unexpected fetch: ${path} ${method}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementNotifications } = await import('../features/procurement/notifications.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementNotifications onNavigate={(destination, objectId) => navigations.push({ destination, objectId })} /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const page = host.firstElementChild as HTMLElement;
    const title = page.querySelector('h1')!;
    const breadcrumb = page.querySelector('nav')!;
    const list = page.querySelector('section')!;
    const firstNotification = list.querySelector<HTMLButtonElement>('button')!;
    assert.equal(title.textContent, '通知');
    assert.equal(breadcrumb.getAttribute('aria-label'), '面包屑导航');
    assert.equal(breadcrumb.textContent?.replace(/\s/g, ''), '收件箱/通知');
    assert.match(page.textContent ?? '', /升级事项、采购订单事件、SLA 提醒和系统消息/);
    assert.ok(page.classList.contains('-mx-7') && page.classList.contains('-mt-6') && page.classList.contains('w-auto'), 'integrated page owns the full-width reference header and content canvas');
    assert.ok(title.closest('header')?.classList.contains('h-[124.25px]'), 'reference header keeps the 124.25px desktop boundary');
    assert.ok(title.classList.contains('leading-[1.5]'), '26px title renders at the reference 39px line height');
    assert.ok(list.classList.contains('rounded-3xl') && list.classList.contains('notifications-list'), 'notification list uses the reference card and sibling-top row separators');
    assert.ok(firstNotification.classList.contains('gap-3.5') && firstNotification.classList.contains('px-5') && firstNotification.classList.contains('py-4'), 'notification rows keep the reference 14px gap and 16px vertical padding');
    assert.ok(firstNotification.className.includes('focus-visible:ring-2'), 'notification rows expose a visible keyboard focus state');
    assert.match(firstNotification.textContent ?? '', /PO 430092 已升级/);
    assert.match(firstNotification.textContent ?? '', /供应商未响应，需要处理。/);
    assert.match(firstNotification.textContent ?? '', /PO ESCALATED/);
    const unread = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith('未读'))!;
    assert.equal(unread.textContent?.replace(/\s/g, ''), '未读110');
    await act(async () => { unread.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(requests.some((request) => request.path.endsWith('filter=unread')));
    const notification = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('PO 430092 已升级'))!;
    assert.match(notification.textContent ?? '', /前|刚刚/);
    await act(async () => { notification.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(requests.some((request) => request.path.endsWith('/notification%3A110/read') && request.method === 'POST'));
    assert.deepEqual(navigations, [{ destination: 'orders', objectId: 'po:430092' }]);
    assert.match(list.textContent ?? '', /所有通知均已处理/);
    assert.match(list.textContent ?? '', /所有采购活动通知都已查看/);

    const markAll = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('全部标为已读'))!;
    await act(async () => { markAll.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(requests.some((request) => request.path.endsWith('/notifications/read-all') && request.method === 'POST'));
    assert.equal(markAll.disabled, true, 'authoritative zero unread count disables Mark all read');
    assert.equal(unread.textContent?.replace(/\s/g, ''), '未读');
    const all = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '全部')!;
    await act(async () => { all.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(list.textContent ?? '', /暂无采购通知/);

    serverUnread = 3; readAllFails = true;
    await act(async () => { all.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(markAll.disabled, false);
    await act(async () => { markAll.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /通知批量更新失败/);
    assert.equal(unread.textContent?.replace(/\s/g, ''), '未读3', 'failure preserves the last authoritative unread count');
    assert.equal(markAll.disabled, false, 'failure remains retryable and never claims success');
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('Notifications read-only users navigate without a write attempt and retain unread truth', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; method: string }> = [];
  const navigations: Array<{ destination: string; objectId?: string | null }> = [];
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const item = {
    id: 'notification:auditor', type: 'po_escalated', severity: 'high', title: 'PO READONLY', message: 'Original supplier message', tag: 'Source Tag',
    objectType: 'purchase_order', objectId: 'po:readonly', evidence: {}, status: 'unread', version: 4, readBy: null, readAt: null,
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z', targetSection: 'orders',
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); const method = init?.method ?? 'GET'; requests.push({ path, method });
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/notifications?filter=all') return response({ items: [item], counts: { all: 1, unread: 1, read: 0 }, generatedAt: item.createdAt, capabilities: { markRead: false } });
    if (path.endsWith('/read') && method === 'POST') return response({ error: '无更新通知权限', code: 'FORBIDDEN' }, 403);
    throw new Error(`unexpected fetch: ${path} ${method}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementNotifications } = await import('../features/procurement/notifications.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementNotifications onNavigate={(destination, objectId) => navigations.push({ destination, objectId })} /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('全部标为已读')), false);
    const row = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('PO READONLY'))!;
    await act(async () => { row.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(requests.some((request) => request.method === 'POST'), false);
    assert.deepEqual(navigations, [{ destination: 'orders', objectId: 'po:readonly' }]);
    assert.match(document.body.textContent ?? '', /PO READONLY/);
    assert.equal(document.querySelectorAll('[aria-label="未读"]').length, 1);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('Notifications permission revocation preserves the authoritative unread item and reports failure', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  const navigations: Array<{ destination: string; objectId?: string | null }> = [];
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const item = {
    id: 'notification:revoked', type: 'po_escalated', severity: 'high', title: 'PO REVOKED', message: 'Permission changes after read', tag: 'Source Tag',
    objectType: 'purchase_order', objectId: 'po:revoked', evidence: {}, status: 'unread', version: 7, readBy: null, readAt: null,
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z', targetSection: 'orders',
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); const method = init?.method ?? 'GET';
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/notifications?filter=all') return response({ items: [item], counts: { all: 1, unread: 1, read: 0 }, generatedAt: item.createdAt, capabilities: { markRead: true } });
    if (path === '/api/procurement/notifications/notification%3Arevoked/read' && method === 'POST') return response({ error: '无更新通知权限', code: 'FORBIDDEN' }, 403);
    throw new Error(`unexpected fetch: ${path} ${method}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementNotifications } = await import('../features/procurement/notifications.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementNotifications onNavigate={(destination, objectId) => navigations.push({ destination, objectId })} /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const row = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('PO REVOKED'))!;
    await act(async () => { row.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /无更新通知权限/);
    assert.match(document.body.textContent ?? '', /PO REVOKED/);
    assert.equal(document.querySelectorAll('[aria-label="未读"]').length, 1);
    assert.deepEqual(navigations, []);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});
