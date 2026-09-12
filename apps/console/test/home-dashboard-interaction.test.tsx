import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/' });
  const previous = new Map<string, unknown>();
  let frameId = 0;
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frameId += 1; setTimeout(() => callback(Date.now()), 0); return frameId; },
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    PointerEvent: dom.window.MouseEvent,
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = value;
  }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: globals.requestAnimationFrame });
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: globals.cancelAnimationFrame });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });
  return {
    host: dom.window.document.querySelector<HTMLDivElement>('#root')!,
    restore: () => {
      for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
      dom.window.close();
    },
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const localItem = {
  id: 'po:local', number: '430092', supplierId: 'supplier:local', supplierName: 'Acme Apparel', route: 'local',
  materialType: 'Direct', status: 'active', stage: 'supplier_commitment', stageLabel: '供应商承诺',
  requiredInHouseAt: '2026-09-12T00:00:00.000Z', overdueDays: 0, risk: 'medium', riskScore: 45,
  riskFactors: [], nextAction: '等待供应商回复', currency: 'CNY', amountTotal: 1200, supplierPerformanceScore: 80, active: true,
  routeRiskBucket: 'awaiting_supplier',
};
const importItem = {
  ...localItem, id: 'po:import', number: '430090', supplierId: 'supplier:import', supplierName: 'Global Fabrics',
  route: 'import', risk: 'high', riskScore: 91, nextAction: '跟踪发运',
  routeRiskBucket: 'high_risk',
};
const portfolio = {
  generatedAt: '2026-09-03T00:00:00.000Z',
  metrics: { highRisk: 1, overdue: 0, requireAttention: 2, activePurchaseOrders: 2, localProcurement: 1, importProcurement: 1, unclassifiedRoute: 0, atRiskValueByCurrency: {} },
  riskDistribution: { high: 1, medium: 1, low: 0 },
  routes: {
    local: { total: 1, high: 0, awaitingSupplier: 1, deliveryRisk: 0, onTrack: 0 },
    import: { total: 1, high: 1, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 0 },
    unclassified: { total: 0, high: 0, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 0 },
  },
  highlights: [], items: [localItem, importItem],
};

test('Overview initial loading preserves its shell and first-load failure never fabricates zero metrics', async () => {
  const installed = installDom();
  const originalFetch = globalThis.fetch;
  let rejectWorkbench!: (reason?: unknown) => void;
  const pendingWorkbench = new Promise<Response>((_resolve, reject) => { rejectWorkbench = reject; });
  const pendingRisk = new Promise<Response>(() => undefined);
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path.startsWith('/api/procurement/workbench')) return pendingWorkbench;
    if (path.startsWith('/api/procurement/risk-dashboard')) return pendingRisk;
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementHomeDashboard } = await import('../features/procurement/home-dashboard.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(installed.host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementHomeDashboard onNavigate={() => undefined} /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(document.querySelector('h1')?.textContent?.trim(), '总览');
    const dateTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="选择总览趋势日期范围"]');
    assert.ok(dateTrigger);
    assert.equal(dateTrigger.disabled, true);
    assert.equal(document.querySelector('[aria-label="总览加载中"]')?.getAttribute('aria-busy'), 'true');
    assert.equal(document.querySelectorAll('[data-overview-loading-kpi]').length, 6);
    assert.equal(document.querySelectorAll('[data-overview-loading-panel]').length, 2);
    assert.equal(document.querySelector('tbody'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /暂无采购订单|高风险\s*0/);

    await act(async () => {
      rejectWorkbench(new Error('总览数据暂时不可用'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /无法加载采购订单组合，请重试/);
    assert.equal(document.querySelector('h1')?.textContent?.trim(), '总览');
    assert.equal(document.querySelectorAll('[data-overview-loading-kpi]').length, 6);
    assert.equal(document.querySelectorAll('[data-overview-loading-panel]').length, 2);
    assert.doesNotMatch(document.body.textContent ?? '', /暂无采购订单|高风险\s*0/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    installed.restore();
  }
});

async function renderDashboard(portfolioFixture = portfolio) {
  const installed = installDom();
  const originalFetch = globalThis.fetch;
  const riskRequests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path.startsWith('/api/procurement/workbench')) return response({ portfolio: portfolioFixture });
    if (path.startsWith('/api/procurement/risk-dashboard')) {
      riskRequests.push(path);
      return response({ range: { from: '2026-08-05', to: '2026-09-03' }, trend: [], snapshotCount: 0, freshness: { evaluatedAt: null, latestPurchaseOrderUpdatedAt: null, stale: false } });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ProcurementHomeDashboard } = await import('../features/procurement/home-dashboard.js');
  const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
  const navigations: Array<{ section: string; poId?: string; intent?: string }> = [];
  const root = createRoot(installed.host);
  await act(async () => {
    root.render(<ProcurementTenantPreferencesProvider><ProcurementHomeDashboard onNavigate={(section, poId, intent) => navigations.push({ section, ...(poId ? { poId } : {}), ...(intent ? { intent } : {}) })} /></ProcurementTenantPreferencesProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { ...installed, originalFetch, riskRequests, navigations, root, act };
}

test('Overview pagination exposes reference-style page buttons and pages through real rows', async () => {
  const items = Array.from({ length: 12 }, (_, index) => ({
    ...(index % 2 === 0 ? localItem : importItem),
    id: `po:${index + 1}`,
    number: `4300${String(index + 1).padStart(2, '0')}`,
  }));
  const harness = await renderDashboard({ ...portfolio, items });
  try {
    const pageButtons = () => [...document.querySelectorAll<HTMLButtonElement>('button[data-overview-page]')];
    assert.deepEqual(pageButtons().map((button) => button.textContent?.trim()), ['1', '2', '3']);
    assert.equal(document.querySelectorAll('tbody tr').length, 5);
    assert.match(document.querySelector('tbody')?.textContent ?? '', /430001/);
    await harness.act(async () => { pageButtons()[1]!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.doesNotMatch(document.querySelector('tbody')?.textContent ?? '', /430001/);
    assert.match(document.querySelector('tbody')?.textContent ?? '', /430006/);
    const next = document.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')!;
    await harness.act(async () => { next.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelectorAll('tbody tr').length, 2);
    assert.match(document.querySelector('tbody')?.textContent ?? '', /430011/);
  } finally {
    await harness.act(async () => harness.root.unmount());
    globalThis.fetch = harness.originalFetch;
    harness.restore();
  }
});

test('Overview renders the reference Chinese information architecture over real portfolio data', async () => {
  const harness = await renderDashboard();
  try {
    assert.equal(document.querySelector('h1')?.textContent?.trim(), '总览');
    assert.match(document.body.textContent ?? '', /跟踪和管理所有采购路线中的采购订单。/);
    assert.deepEqual(
      [...document.querySelectorAll<HTMLElement>('article')]
        .map((article) => article.querySelector<HTMLElement>('.mt-2.text-\\[13px\\]')?.textContent?.trim()),
      ['高风险', '逾期采购订单', '需要关注', '活跃采购订单', '本地采购', '进口采购'],
    );
    assert.deepEqual(
      [...document.querySelectorAll('thead th')].map((cell) => cell.textContent?.trim()),
      ['PO 编号', '供应商', '路线', '物料类型', '当前阶段', '要求到货日期（RIHD）', '风险', '下一步操作', '操作'],
    );
    assert.match(document.body.textContent ?? '', /AI 采购摘要/);
    assert.match(document.body.textContent ?? '', /今日重点/);
    assert.match(document.body.textContent ?? '', /本地采购— 风险概览/);
    assert.match(document.body.textContent ?? '', /进口采购— 风险概览/);
  } finally {
    await harness.act(async () => harness.root.unmount());
    globalThis.fetch = harness.originalFetch;
    harness.restore();
  }
});

test('Overview filter controls match the reference button-menu interaction and filter real rows', async () => {
  const harness = await renderDashboard();
  try {
    assert.equal(document.querySelectorAll('select').length, 0, 'reference filters are menu buttons, not native selects');
    const routeTrigger = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '路线')!;
    assert.equal(routeTrigger.getAttribute('aria-haspopup'), 'menu');
    routeTrigger.focus();
    await harness.act(async () => { routeTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="路线"]')!;
    assert.ok(menu);
    assert.equal(document.activeElement?.getAttribute('role'), 'menuitem');
    assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()), ['本地', '进口', '未分类']);
    await harness.act(async () => { menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(routeTrigger.textContent?.includes('本地'), true);
    assert.deepEqual([...document.querySelectorAll('tbody tr')].map((row) => row.textContent).filter(Boolean).map((text) => text!.includes('430092')), [true]);
    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '清除')!;
    assert.ok(clear);
    await harness.act(async () => { clear.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelectorAll('tbody tr').length, 2);

    await harness.act(async () => { routeTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await harness.act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('[role="menu"][aria-label="路线"]'), null);
    assert.equal(document.activeElement, routeTrigger);
  } finally {
    await harness.act(async () => harness.root.unmount());
    globalThis.fetch = harness.originalFetch;
    harness.restore();
  }
});

test('Overview date control exposes quick ranges and a month calendar, then restores focus on Escape', async () => {
  const harness = await renderDashboard();
  try {
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="选择总览趋势日期范围"]')!;
    trigger.focus();
    await harness.act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="总览趋势日期范围"]')!;
    assert.ok(dialog);
    assert.deepEqual([...dialog.querySelectorAll<HTMLButtonElement>('[data-quick-range]')].map((button) => button.textContent?.trim()), ['今天', '最近 7 天', '最近 30 天', '本季度', '今年至今']);
    assert.ok(dialog.querySelector('[role="grid"][aria-label="月历"]'));
    assert.equal(document.activeElement, dialog.querySelector('[data-quick-range]'));
    await harness.act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('[role="dialog"][aria-label="总览趋势日期范围"]'), null);
    assert.equal(document.activeElement, trigger);
  } finally {
    await harness.act(async () => harness.root.unmount());
    globalThis.fetch = harness.originalFetch;
    harness.restore();
  }
});

test('Overview PO rows expose a reference-style action menu and 查看详情 opens the persisted order', async () => {
  const harness = await renderDashboard();
  try {
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="430092 操作"]')!;
    assert.ok(trigger);
    trigger.focus();
    await harness.act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="430092 操作"]')!;
    assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()), ['查看详情', '发送跟进', '编辑 RIHD', '标记为风险']);
    await harness.act(async () => { menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await harness.act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await harness.act(async () => { document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await harness.act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await harness.act(async () => { document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[2]!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await harness.act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await harness.act(async () => { document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[3]!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(harness.navigations, [
      { section: 'orders', poId: 'po:local', intent: 'view' },
      { section: 'message-drafts', poId: 'po:local' },
      { section: 'orders', poId: 'po:local', intent: 'edit-rihd' },
      { section: 'orders', poId: 'po:local', intent: 'mark-at-risk' },
    ]);
  } finally {
    await harness.act(async () => harness.root.unmount());
    globalThis.fetch = harness.originalFetch;
    harness.restore();
  }
});

test('Overview KPI cards match the reference as non-interactive summaries', async () => {
  const harness = await renderDashboard();
  try {
    const cards = [...document.querySelectorAll<HTMLElement>('article')];
    assert.equal(cards.length, 6);
    assert.ok(cards.every((card) => !card.classList.contains('h-[236px]') && !card.classList.contains('min-h-[255.5px]')), 'KPI cards keep the reference natural height across desktop widths');
    assert.ok(cards.every((card) => card.querySelector('.text-\\[30px\\]')), 'KPI values keep the measured 30px reference scale');
    const filterToolbar = document.querySelector<HTMLInputElement>('input[placeholder="搜索 PO 编号、供应商…"]')?.parentElement?.parentElement;
    assert.ok(filterToolbar?.classList.contains('flex-wrap'), 'the six filters wrap naturally at the measured 1280px and 1440px desktop widths');
    assert.equal(filterToolbar?.classList.contains('xl:w-[734px]'), false, 'the filter toolbar must use intrinsic width so it can match every accepted desktop viewport');
    assert.equal(filterToolbar?.classList.contains('xl:flex-nowrap'), false, 'the filter toolbar must preserve the reference responsive wrapping');
    const summary = [...document.querySelectorAll('h2')].find((heading) => heading.textContent?.trim() === 'AI 采购摘要')?.closest('aside');
    assert.ok(summary?.classList.contains('h-full'), 'the summary stretches to the natural purchase-order card height');
    assert.equal(summary?.classList.contains('min-h-[520px]'), false, 'the summary must not force a taller main row than the reference');
    const metricLabels = ['高风险', '逾期采购订单', '需要关注', '活跃采购订单', '本地采购', '进口采购'];
    for (const label of metricLabels) {
      const metricLabel = [...document.querySelectorAll<HTMLElement>('article div')].find((element) => element.textContent?.trim() === label);
      assert.ok(metricLabel, `${label} KPI should render inside a summary article`);
      assert.equal(metricLabel.closest('button'), null, `${label} KPI must not be a button`);
    }
    assert.deepEqual(harness.navigations, []);
  } finally {
    await harness.act(async () => harness.root.unmount());
    globalThis.fetch = harness.originalFetch;
    harness.restore();
  }
});

test('Overview route-risk legends are buttons that filter the real PO table', async () => {
  const harness = await renderDashboard();
  try {
    const localAwaiting = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === '本地采购：等待供应商');
    assert.ok(localAwaiting, 'reference route-risk legends are buttons');
    await harness.act(async () => { localAwaiting.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const rows = [...document.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '');
    assert.deepEqual(rows.map((text) => text.includes('430092')), [true]);
    assert.equal(document.querySelector('[aria-label="采购订单筛选结果"]'), document.activeElement);
    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '清除')!;
    await harness.act(async () => { clear.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelectorAll('tbody tr').length, 2, '清除必须同时重置图例风险分组与路线筛选');
  } finally {
    await harness.act(async () => harness.root.unmount());
    globalThis.fetch = harness.originalFetch;
    harness.restore();
  }
});
