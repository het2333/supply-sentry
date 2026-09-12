import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const at = '2026-09-06T08:00:00.000Z';
const published = {
  purchaseOrderId: 'po:published', number: 'PO-原始-01', supplierId: 'supplier:1', supplierName: 'Supplier',
  materialType: 'Pending', route: 'import', risk: 'high', riskScore: 85, overdueDays: 10,
  currency: 'USD', amountTotal: 1000, requiredInHouseAt: '2026-08-27', nextAction: 'Approve original wording',
  riskFactors: [{ code: 'custom', label: 'Original risk driver', score: 85, evidence: 'Supplier original evidence' }],
  riskPublicationState: 'published', riskModel: { modelVersion: 'risk-model-v2', evidenceCoverage: 1, totalScore: 85, provisionalScore: null, provisionalBand: null },
  missingRiskComponents: [],
};
const snapshot = {
  id: 'snapshot:1', asOf: at, sourceWatermark: 'watermark:1', modelVersion: 'risk-model-v2',
  metrics: { total: 3, high: 1, medium: 0, low: 0, provisional: 1, unpublished: 1, highRiskPercent: 33.3, atRiskValueByCurrency: { USD: 1000, EUR: 200 }, averageRiskScore: 85 },
  riskDistribution: [{ risk: 'high', count: 1 }, { risk: 'medium', count: 0 }, { risk: 'low', count: 0 }],
  riskBreakdown: [{ code: 'delivery_delay', label: 'Delivery Delay', score: 80, weight: 0.25, evidenceCoverage: 1, affectedPurchaseOrders: 2 }],
  suppliers: [
    { supplierId: 'supplier:1', supplierName: 'Supplier', purchaseOrders: 1, riskScore: 85, atRiskValueByCurrency: { USD: 1000 } },
    { supplierId: 'supplier:2', supplierName: 'Original provisional', purchaseOrders: 1, riskScore: 65, atRiskValueByCurrency: {} },
    { supplierId: 'supplier:3', supplierName: 'Original unpublished', purchaseOrders: 1, riskScore: 0, atRiskValueByCurrency: {} },
  ],
  aging: [{ code: '8_14', label: '8 - 14 Days', purchaseOrders: 2, atRiskValueByCurrency: { USD: 1000 } }],
  products: [{ materialType: 'Pending', delayedPurchaseOrders: 2, averageRiskScore: 85, atRiskValueByCurrency: { USD: 1000, EUR: 200 } }],
  items: [published,
    { ...published, purchaseOrderId: 'po:provisional', supplierId: 'supplier:2', supplierName: 'Original provisional', risk: 'medium', riskScore: 65, riskPublicationState: 'provisional', riskModel: { modelVersion: 'risk-model-v2', evidenceCoverage: 0.75, totalScore: null, provisionalScore: 65, provisionalBand: 'medium' }, missingRiskComponents: ['productCriticality', 'complianceApproval'] },
    { ...published, purchaseOrderId: 'po:unpublished', supplierId: 'supplier:3', supplierName: 'Original unpublished', overdueDays: 0, risk: 'low', riskScore: 0, riskPublicationState: 'not_published', riskModel: { modelVersion: 'risk-model-v2', evidenceCoverage: 0.55, totalScore: null, provisionalScore: null, provisionalBand: null }, missingRiskComponents: ['deliveryDelay', 'custom original'] },
  ],
};
function dashboard() {
  return structuredClone({
    range: { from: '2026-08-08', to: '2026-09-06' }, latest: snapshot, previous: null, trend: [], snapshotCount: 1,
    capabilities: { refresh: true },
    appliedFilters: { risk: null, route: null, supplierId: null, materialType: null },
    filterOptions: { risks: ['high', 'medium', 'low'], routes: ['local', 'import', 'unclassified'], suppliers: [{ id: 'supplier:1', name: 'Supplier' }], materialTypes: ['Pending'] },
    unfilteredItemCount: 3, filteredItemCount: 3,
    freshness: { state: 'current', reason: null, evaluatedAt: at, currentSourceWatermark: 'watermark:1', latestSnapshotSourceWatermark: 'watermark:1', latestSnapshotAt: at, liveMetrics: { total: 3, high: 1, medium: 0, low: 0, overdue: 2, highRiskPercent: 33.3 } },
  });
}
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
type Boundary = (path: string, init?: RequestInit) => Response | Promise<Response>;
async function mount(initial: Boundary = () => json(dashboard()), localize = false) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/' });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
  Object.assign(globalThis, globals);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { value: () => undefined });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; method: string }> = [];
  let boundary = initial;
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return json({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    assert.ok(path.startsWith('/api/procurement/risk-dashboard'), path);
    requests.push({ path, method: init?.method ?? 'GET' });
    return boundary(path, init);
  }) as typeof fetch;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ProcurementRiskDashboard } = await import('../features/procurement/risk-dashboard.js');
  const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
  const { ChineseUiLocalization } = await import('../features/localization/chinese-ui-localization.js');
  const root = createRoot(document.querySelector('#root')!);
  const navigation: string[] = [];
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  await act(async () => { root.render(<ProcurementTenantPreferencesProvider>{localize && <ChineseUiLocalization />}<ProcurementRiskDashboard onOpenPurchaseOrder={(id) => navigation.push(id)} onViewAllSuppliers={() => navigation.push('suppliers')} onViewAllHighRiskPurchaseOrders={() => navigation.push('high-risk')} /></ProcurementTenantPreferencesProvider>); await settle(); });
  await act(async () => { await settle(); });
  return {
    requests, navigation, act, settle, setBoundary: (next: Boundary) => { boundary = next; },
    click: async (element: HTMLElement) => { assert.ok(element); await act(async () => { element.click(); await settle(); }); },
    close: async () => { await act(async () => root.unmount()); await act(async () => { await settle(); }); globalThis.fetch = originalFetch; for (const [key, value] of saved) (globalThis as Record<string, unknown>)[key] = value; dom.window.close(); },
  };
}
function button(text: string) { const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim() === text); assert.ok(result, `button: ${text}`); return result; }

test('risk dashboard renders Chinese source UI, three-column product table and immutable PO drilldowns', async () => {
  const h = await mount();
  try {
    assert.equal(document.querySelector('h1')?.textContent, '风险看板');
    assert.deepEqual([...document.querySelectorAll('h2')].map((node) => node.textContent), ['风险评分分布', '风险构成', '供应商风险（前 10）', '逾期未结订单账龄分布', '受延期订单影响的产品（前 10）', '风险趋势（平均风险评分）', '高风险采购订单']);
    const tables = document.querySelectorAll('table');
    assert.equal(tables.length, 3);
    assert.deepEqual([...tables[1]!.querySelectorAll('th')].map((node) => node.textContent), ['产品', '延期订单数', '风险金额']);
    const row = tables[1]!.querySelector('tbody tr')!;
    assert.equal(row.querySelectorAll('td').length, 3);
    assert.equal(row.querySelector('[data-preserve-language]')?.textContent, 'Pending');
    assert.match(row.textContent ?? '', /2.*1,000.*200/);
    await h.click(row.querySelector('button')!);
    await h.click(tables[2]!.querySelector('tbody button')!);
    await h.click(button('查看全部供应商'));
    await h.click(button('查看全部高风险订单'));
    assert.deepEqual(h.navigation, ['po:published', 'po:published', 'suppliers', 'high-risk']);
    assert.match(tables[0]!.textContent ?? '', /暂定评分 · 证据覆盖率 75%/);
    assert.match(tables[0]!.textContent ?? '', /未发布 · 证据覆盖率 55%/);
    assert.equal(tables[2]!.querySelectorAll('tbody tr').length, 1, 'provisional and unpublished must not enter formal high-risk list');
    assert.match(tables[2]!.textContent ?? '', /Original risk driver.*Approve original wording/);
    assert.equal(tables[2]!.querySelector('[data-preserve-language][title="Approve original wording"]')?.textContent, 'Approve original wording');
    assert.ok(h.requests.every((request) => request.method === 'GET'));
  } finally { await h.close(); }
});

test('risk filters preserve business option labels, send stable values and restore focus on Escape', async () => {
  const h = await mount();
  try {
    const trigger = button('筛选'); trigger.focus(); await h.click(trigger);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="风险快照筛选"]')!;
    assert.ok(dialog);
    const select = [...dialog.querySelectorAll('select')];
    assert.deepEqual([...select[1]!.options].map((option) => option.text), ['全部路线', '本地', '进口', '未分类']);
    assert.equal(select[2]!.options[1]!.text, 'Supplier');
    assert.equal(select[3]!.options[1]!.text, 'Pending');
    await h.act(async () => { for (const [index, value] of [[0, 'high'], [1, 'import'], [2, 'supplier:1'], [3, 'Pending']] as const) { select[index]!.value = value; select[index]!.dispatchEvent(new Event('change', { bubbles: true })); } });
    await h.click(button('应用筛选'));
    const query = new URL(h.requests.at(-1)!.path, 'http://readywork.test').searchParams;
    assert.deepEqual(['risk', 'route', 'supplierId', 'materialType'].map((key) => query.get(key)), ['high', 'import', 'supplier:1', 'Pending']);
    await h.click(trigger);
    await h.act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await h.settle(); });
    assert.equal(document.querySelector('[role="dialog"][aria-label="风险快照筛选"]'), null);
    // Radix schedules unmount auto-focus after the React cleanup commit. A tick
    // awaited inside the closing act() can run before that timer is installed.
    const focusDeadline = Date.now() + 1000;
    while (document.activeElement !== trigger && Date.now() < focusDeadline) {
      await h.act(async () => { await h.settle(); });
    }
    assert.equal(document.activeElement === trigger, true, `filter Escape restores focus to its trigger; actual=${document.activeElement?.tagName}:${document.activeElement?.getAttribute('aria-label') ?? ''}`);
    assert.ok(h.requests.every((request) => request.method === 'GET'));
  } finally { await h.close(); }
});

test('risk read failure is not an empty snapshot and retry remains a read-only action', async () => {
  const h = await mount(() => json({ error: 'Forbidden original detail', requestId: 'request:403' }, 403));
  try {
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Forbidden original detail/);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /request:403/);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /请联系管理员/);
    assert.doesNotMatch(document.body.textContent ?? '', /Create First Snapshot|创建首个快照|所选日期范围内没有风险快照/);
    h.setBoundary(() => json(dashboard()));
    await h.click(button('重试读取'));
    assert.equal(document.querySelectorAll('table').length, 3);
    assert.ok(h.requests.every((request) => request.method === 'GET'));
  } finally { await h.close(); }
});

test('risk reload failure identifies last successful snapshot and keeps immutable rows', async () => {
  const h = await mount();
  try {
    h.setBoundary(() => json({ error: 'Version source unavailable' }, 500));
    await h.click(button('筛选')); await h.click(button('应用筛选'));
    assert.match(document.body.textContent ?? '', /显示的是上次成功读取的快照/);
    assert.doesNotMatch(document.body.textContent ?? '', /与当前采购数据一致/);
    assert.equal(document.querySelectorAll('table').length, 3);
    assert.match(document.body.textContent ?? '', /PO-原始-01/);
    assert.equal(button('导出').disabled, true, 'a failed new query must not export a different dataset from the retained table');
    assert.ok(h.requests.every((request) => request.method === 'GET'));
  } finally { await h.close(); }
});

test('supplier risk uses the frozen supplier average instead of its highest PO and does not average missing evidence as zero', async () => {
  const data = dashboard();
  data.latest.items = [published, { ...published, purchaseOrderId: 'po:second', risk: 'low', riskScore: 15, riskModel: { ...published.riskModel, totalScore: 15 } }];
  data.latest.suppliers = [{ ...snapshot.suppliers[0]!, purchaseOrders: 2, riskScore: 50 }];
  const h = await mount(() => json(data));
  try {
    const row = document.querySelector('table tbody tr')!;
    assert.match(row.textContent ?? '', /50\/100/);
    assert.doesNotMatch(row.textContent ?? '', /85\/100/);
    assert.match(row.textContent ?? '', /已发布均分 · 2 张订单/);
    assert.equal(row.querySelector<HTMLElement>('[data-risk-score-bar]')?.style.width, '50%');
    data.latest.items[1] = { ...data.latest.items[1]!, riskScore: 0, riskPublicationState: 'not_published', riskModel: { modelVersion: 'risk-model-v2', evidenceCoverage: 0.55, totalScore: null, provisionalScore: null, provisionalBand: null }, missingRiskComponents: ['deliveryDelay'] };
    data.latest.suppliers[0]!.riskScore = 43;
    await h.click(button('筛选')); await h.click(button('应用筛选'));
    const incomplete = document.querySelector('table tbody tr')!;
    assert.doesNotMatch(incomplete.textContent ?? '', /43\/100|85\/100/);
    assert.match(incomplete.textContent ?? '', /均分未发布/);
    assert.match(incomplete.textContent ?? '', /1 张订单评分未发布/);
    assert.equal(incomplete.querySelector('[data-risk-score-bar]'), null);
  } finally { await h.close(); }
});

test('legacy dashboard metric explanations do not claim published V2 scores', async () => {
  const data = dashboard();
  data.latest.modelVersion = 'legacy-risk-v1';
  data.latest.riskBreakdown = [];
  const legacy = { ...data, latest: { ...data.latest, items: [{ ...published, riskPublicationState: 'legacy', riskModel: { modelVersion: 'legacy-risk-v1', evidenceCoverage: null, totalScore: null, provisionalScore: null, provisionalBand: null } }] } };
  const reactErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { reactErrors.push(args); };
  let h: Awaited<ReturnType<typeof mount>> | null = null;
  try {
    h = await mount(() => json(legacy));
    const helpLabels = [...document.querySelectorAll('button[aria-label]')].map((button) => button.getAttribute('aria-label')).join('\n');
    assert.doesNotMatch(helpLabels, /已发布/);
    assert.match(helpLabels, /旧模型/);
    assert.match(document.body.textContent ?? '', /旧模型风险快照 · 只读/);
    assert.doesNotMatch(document.body.textContent ?? '', /RiskModelV2 使用冻结在快照中的真实订单证据/);
    assert.match(document.body.textContent ?? '', /旧模型风险快照仅按冻结的历史算法结果展示；不使用 V2 回填/);
    assert.equal(reactErrors.some((args) => String(args[0]).includes('same key')), false, 'empty legacy radar grids must have stable unique React keys');
  } finally {
    if (h) await h.close();
    console.error = originalConsoleError;
  }
});

test('multi-order provisional supplier averages disclose the exact provisional PO coverage and missing components', async () => {
  const data = dashboard();
  data.latest.items = [published, { ...snapshot.items[1]!, supplierId: 'supplier:1', number: 'PO-PROVISIONAL-02' }];
  data.latest.suppliers = [{ ...snapshot.suppliers[0]!, purchaseOrders: 2, riskScore: 75 }];
  const h = await mount(() => json(data));
  try {
    const row = document.querySelector('table tbody tr')!;
    assert.match(row.textContent ?? '', /75\/100/);
    assert.match(row.textContent ?? '', /PO-PROVISIONAL-02.*65\/100.*证据覆盖率 75%/);
    assert.match(row.textContent ?? '', /产品关键程度、合规与审批/);
    assert.equal(row.querySelector('[data-risk-provisional-evidence] [data-preserve-language]')?.textContent, 'PO-PROVISIONAL-02');
  } finally { await h.close(); }
});

test('risk original PO identifiers and custom component labels survive the installed global localizer', async () => {
  const data = dashboard();
  data.latest.items[0]!.number = 'Pending';
  data.latest.riskBreakdown = [{ code: 'custom', label: 'Supplier', score: 80, weight: 0.25, evidenceCoverage: 1, affectedPurchaseOrders: 2 }];
  const h = await mount(() => json(data), true);
  try {
    assert.equal(document.querySelectorAll('table')[2]!.querySelector('tbody button')?.textContent, 'Pending');
    const chart = document.querySelector('[aria-label="风险构成雷达图"]')!;
    assert.equal([...chart.querySelectorAll('text')].some((node) => node.textContent === 'Supplier'), true);
    assert.equal(document.querySelectorAll('table')[1]!.querySelector('tbody button')?.textContent, 'Pending');
  } finally { await h.close(); }
});

test('risk initial loading and true empty snapshot stay distinct and never auto-create a snapshot', async () => {
  let resolve!: (response: Response) => void;
  const h = await mount(() => new Promise<Response>((done) => { resolve = done; }));
  try {
    assert.equal(document.querySelector('h1')?.textContent, '风险看板');
    assert.ok(document.querySelector('[aria-label="选择风险快照日期范围"]'));
    assert.ok(button('筛选'));
    assert.ok(button('导出'));
    assert.match(document.body.textContent ?? '', /正在读取已保存的风险快照/);
    const loading = document.querySelector('[aria-label="风险看板加载中"][aria-busy="true"]');
    assert.ok(loading);
    assert.equal(loading.querySelectorAll('[data-risk-loading-kpi]').length, 5);
    assert.equal(loading.querySelectorAll('[data-risk-loading-panel]').length, 3);
    assert.equal(document.querySelector('table'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /所选日期范围内没有风险快照/);
    const empty = { ...dashboard(), latest: null, snapshotCount: 0, freshness: { ...dashboard().freshness, state: 'missing' } };
    await h.act(async () => { resolve(json(empty)); await h.settle(); });
    assert.match(document.body.textContent ?? '', /所选日期范围内没有风险快照/);
    assert.equal(button('导出').disabled, true);
    assert.ok(button('创建首个快照'));
    assert.ok(h.requests.every((request) => request.method === 'GET'));
  } finally { await h.close(); }
});

test('risk read-only empty and current states never expose snapshot mutation controls', async () => {
  const empty = { ...dashboard(), capabilities: { refresh: false }, latest: null, snapshotCount: 0, freshness: { ...dashboard().freshness, state: 'missing' } };
  const h = await mount(() => json(empty));
  try {
    assert.match(document.body.textContent ?? '', /所选日期范围内没有风险快照/);
    assert.match(document.body.textContent ?? '', /需要具备操作权限的用户创建风险快照/);
    assert.equal([...document.querySelectorAll('button')].some((element) => element.textContent?.trim() === '创建首个快照'), false);

    h.setBoundary(() => json({ ...dashboard(), capabilities: { refresh: false } }));
    await h.click(button('筛选'));
    await h.click(button('应用筛选'));
    assert.equal(document.querySelectorAll('table').length, 3);
    assert.equal([...document.querySelectorAll('button')].some((element) => element.textContent?.trim() === '更新快照'), false);
    assert.ok(h.requests.every((request) => request.method === 'GET'));
  } finally { await h.close(); }
});

test('risk refresh permission revocation keeps the immutable snapshot and never reports success', async () => {
  const h = await mount((_path, init) => init?.method === 'POST'
    ? json({ error: '无生成采购风险快照权限', code: 'FORBIDDEN' }, 403)
    : json(dashboard()));
  try {
    assert.equal(document.querySelectorAll('table').length, 3);
    await h.click(button('更新快照'));
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /无生成采购风险快照权限/);
    assert.equal(document.querySelectorAll('table').length, 3);
    assert.match(document.body.textContent ?? '', /PO-原始-01/);
    assert.doesNotMatch(document.body.textContent ?? '', /已更新|更新成功/);
    assert.equal(h.requests.filter((request) => request.method === 'POST').length, 1);
  } finally { await h.close(); }
});

test('risk date calendar exposes Chinese month and navigation labels without changing the date contract', async () => {
  const h = await mount();
  try {
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="选择风险快照日期范围"]')!;
    await h.click(trigger);
    const calendar = document.querySelector('[aria-label="风险快照日期范围日历"]')!;
    assert.ok(calendar);
    assert.match(calendar.textContent ?? '', /月/);
    assert.ok(calendar.querySelector('[aria-label="上个月"]'));
    assert.ok(calendar.querySelector('[aria-label="下个月"]'));
    await h.click(button('应用日期'));
    const query = new URL(h.requests.at(-1)!.path, 'http://readywork.test').searchParams;
    assert.match(query.get('from') ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.match(query.get('to') ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(h.requests.every((request) => request.method === 'GET'));
  } finally { await h.close(); }
});
