import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/' });
  const nativeMatches = dom.window.Element.prototype.matches;
  Object.defineProperty(dom.window.Element.prototype, 'matches', {
    configurable: true,
    value(this: Element, selector: string) {
      if (selector === ':modal' || selector === ':fullscreen') return false;
      return nativeMatches.call(this, selector);
    },
  });
  const previous = new Map<string, unknown>();
  let animationFrameId = 0;
  const animationFrames = new Map<number, ReturnType<typeof setTimeout>>();
  const requestTestFrame = (callback: FrameRequestCallback) => {
    animationFrameId += 1;
    const frameId = animationFrameId;
    animationFrames.set(frameId, setTimeout(() => { animationFrames.delete(frameId); callback(Date.now()); }, 0));
    return frameId;
  };
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node, DOMRect: dom.window.DOMRect,
    NodeFilter: dom.window.NodeFilter, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: requestTestFrame,
    cancelAnimationFrame: (id: number) => { const timer = animationFrames.get(id); if (timer) clearTimeout(timer); animationFrames.delete(id); }, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) { previous.set(key, (globalThis as Record<string, unknown>)[key]); (globalThis as Record<string, unknown>)[key] = value; }
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: requestTestFrame });
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: globals.cancelAnimationFrame });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });
  return { host: dom.window.document.querySelector<HTMLDivElement>('#root')!, restore: () => {
    for (const timer of animationFrames.values()) clearTimeout(timer);
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  } };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const view = control.ownerDocument.defaultView!;
  const prototype = control instanceof view.HTMLTextAreaElement
    ? view.HTMLTextAreaElement.prototype
    : control instanceof view.HTMLSelectElement
      ? view.HTMLSelectElement.prototype
      : view.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
  control.dispatchEvent(new Event(control instanceof view.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

function selectMenuItem(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
  element.click();
}

async function interactWithPortal(action: () => void): Promise<void> {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
  try {
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  }
}

async function dismissIdleOverlays(): Promise<void> {
  if (!document.querySelector('[role="dialog"], [role="menu"]')) return;
  await interactWithPortal(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

test('Supplier workbench matches the reference directory, editor fields, and focus behavior', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const mutations: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  let rejectNextEdit = true;
  const supplier = {
    id: 'supplier:profile-ui', externalId: 'SUP-UI-001', name: '华东阀门制造', currency: 'CNY', status: 'active', operatingStatus: 'active',
    sourceSystem: 'manual', version: 1, contacts: [{ id: 'contact:ui', name: '陈经理', email: 'chen@example.test', phone: '+86 138 0000 0000', primary: true }],
    countryCode: 'CN', countryName: '中国', updatedAt: '2026-09-03T00:00:00.000Z',
    profile: {
      supplierId: 'supplier:profile-ui', countryCode: 'CN', route: 'local', supplierType: 'manufacturer', industry: '工业自动化', address: null,
      primaryMaterialCode: 'VALVE-01', primaryMaterialName: '真空阀', defaultLeadTimeDays: 21, productCriticality: 'high', paymentTerms: 'Net 30',
      contractStartsOn: null, contractEndsOn: null, status: 'active', version: 1,
    },
  };
  const customSupplier = {
    ...supplier,
    id: 'supplier:custom-values', externalId: 'SUP-CUSTOM-002', name: 'Pending',
    contacts: [{ id: 'contact:custom', name: 'Supplier', email: 'pending@example.test', phone: '+86 137 0000 0000', primary: true }],
    profile: { ...supplier.profile, supplierId: 'supplier:custom-values', route: 'Pending', supplierType: 'Supplier', industry: 'Pending', primaryMaterialCode: null, primaryMaterialName: 'Supplier' },
  };
  const performanceItem = {
    supplierId: supplier.id, supplierName: supplier.name, status: 'active', currency: 'CNY', contacts: supplier.contacts,
    purchaseOrders: 1, activePurchaseOrders: 1, completedPurchaseOrders: 0, score: 40, grade: 'at_risk', confidence: 'high', evidenceCoverage: 100,
    dimensions: [], actualResponseSamples: 0, averageResponseHours: null, slaBreaches: 0, overduePurchaseOrders: 0, averageRiskScore: 10,
    highRiskPurchaseOrders: 0, deliveryEvidence: [{ onTime: true }, { onTime: false }], lastActivityAt: null,
    purchaseOrderItems: [{ id: 'po:profile-ui', number: 'PO-UI-001', status: 'draft', orderedAt: '2026-09-01T00:00:00.000Z', requiredInHouseAt: null, currency: 'CNY', amountTotal: 1000, risk: 'low', riskScore: 10, riskFactors: [], updatedAt: '2026-09-01T00:00:00.000Z' }],
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/suppliers' && (!init?.method || init.method === 'GET')) return response({ items: [supplier, customSupplier], permissions: { read: true, configure: true } });
    if (path === '/api/procurement/suppliers' && init?.method === 'POST') {
      mutations.push({ path, method: 'POST', body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return response({ supplier }, 201);
    }
    if (path.startsWith('/api/procurement/supplier-performance')) return response({ latest: { id: 'performance:ui', asOf: '2026-09-03T00:00:00.000Z', ruleVersion: 'v1', items: [performanceItem] } });
    if (path.startsWith('/api/po/lead-times')) return response({ items: [], suppliers: [{ id: supplier.id, name: supplier.name, status: 'active', version: 1 }], permissions: { read: true, configure: true }, events: [] });
    if (path === `/api/procurement/suppliers/${encodeURIComponent(supplier.id)}` && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      mutations.push({ path, method: 'PATCH', body });
      if (rejectNextEdit) {
        rejectNextEdit = false;
        supplier.version = 2;
        supplier.profile.version = 2;
        return response({ error: '版本冲突', currentVersion: 2 }, 409);
      }
      supplier.version = 3; supplier.profile.version = 3; supplier.profile.route = (body['operatingProfile'] as { route: 'local' | 'import' }).route;
      return response({ supplier, version: 3, profile: supplier.profile });
    }
    if (path === `/api/procurement/suppliers/${encodeURIComponent(supplier.id)}/deactivate` && init?.method === 'POST') {
      mutations.push({ path, method: 'POST', body: JSON.parse(String(init.body)) as Record<string, unknown> });
      supplier.operatingStatus = 'inactive'; supplier.profile.status = 'inactive'; supplier.profile.version = 3;
      return response({ supplier, version: 2, profile: supplier.profile });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSuppliersWorkbench } = await import('../features/procurement/suppliers-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    const { ChineseUiLocalization } = await import('../features/localization/chinese-ui-localization.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<><ChineseUiLocalization /><ProcurementTenantPreferencesProvider><ProcurementSuppliersWorkbench /></ProcurementTenantPreferencesProvider></>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual([...document.querySelectorAll('table')[0]!.querySelectorAll('thead th')].map((cell) => cell.textContent?.trim()), ['供应商编码', '供应商名称', '国家/地区', '采购路线', '类型', '准时交付率', '状态', '']);
    assert.doesNotMatch(document.body.textContent ?? '', /Sync ERP|Refresh performance/);
    assert.match(document.querySelector('table tbody tr')?.textContent ?? '', /50%/);
    assert.match(document.querySelector('table tbody tr')?.textContent ?? '', /存在风险/);
    assert.match(document.querySelector('table tbody tr')?.textContent ?? '', /华东阀门制造/);
    assert.match(document.querySelector('table tbody tr')?.textContent ?? '', /中国/);
    assert.match(document.querySelector('table tbody tr')?.textContent ?? '', /本地/);
    assert.match(document.querySelector('table tbody tr')?.textContent ?? '', /直接/);
    const customRow = [...document.querySelectorAll<HTMLTableRowElement>('table:first-of-type tbody tr')].find((row) => row.textContent?.includes('SUP-CUSTOM-002'))!;
    assert.equal(customRow.cells[3]?.textContent?.trim(), 'Pending');
    assert.equal(customRow.cells[4]?.textContent?.trim(), 'Supplier');
    const customMore = document.querySelector<HTMLButtonElement>('button[aria-label="更多供应商操作：Pending"]')!;
    customMore.focus();
    await interactWithPortal(() => customMore.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const customMenu = document.getElementById('supplier-actions-supplier-custom-values')!;
    const customDetails = [...customMenu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === '查看详情')!;
    await interactWithPortal(() => selectMenuItem(customDetails));
    const customDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(customDialog.querySelector('h2')?.textContent?.trim(), 'Pending');
    const businessFact = (label: string) => [...customDialog.querySelectorAll<HTMLElement>('div')].find((element) => element.textContent?.trim() === label && element.nextElementSibling)?.nextElementSibling as HTMLElement | undefined;
    assert.equal(businessFact('联系人')?.textContent?.trim(), 'Supplier');
    assert.equal(businessFact('行业')?.textContent?.trim(), 'Pending');
    assert.equal(businessFact('物料')?.textContent?.trim(), 'Supplier');
    assert.equal(businessFact('联系人')?.hasAttribute('data-preserve-language'), true);
    assert.equal(businessFact('行业')?.hasAttribute('data-preserve-language'), true);
    assert.equal(businessFact('物料')?.hasAttribute('data-preserve-language'), true);
    await interactWithPortal(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.ok(document.querySelector('table tbody [role="progressbar"][aria-valuenow="50"]'));
    assert.equal(document.querySelector('h1')?.textContent?.trim(), '供应商');
    assert.match(document.body.textContent ?? '', /管理和维护采购流程中使用的所有供应商主数据。/);
    assert.equal(document.querySelector<HTMLInputElement>('input[placeholder="按供应商名称、编码或国家/地区搜索…"]')?.value, '');
    assert.ok(document.querySelector('select[aria-label="供应商状态"]'));
    const edit = document.querySelector<HTMLButtonElement>(`button[aria-label="编辑供应商 ${supplier.name}"]`)!;
    assert.ok(edit);
    await act(async () => { edit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const editDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(editDialog.querySelector('h2')?.textContent?.trim(), '编辑供应商');
    assert.match(editDialog.textContent ?? '', /更新该供应商的主数据记录。/);
    assert.deepEqual([...editDialog.querySelectorAll('h3')].map((heading) => heading.textContent?.trim()), ['供应商信息', '联系人信息']);
    assert.deepEqual([...editDialog.querySelectorAll('label')].map((label) => label.firstElementChild?.textContent?.trim()), ['供应商编码 *', '供应商名称 *', '国家/地区 *', '采购路线 *', '类型 *', '联系人 *', '邮箱 *', '电话 *']);
    assert.equal(editDialog.querySelector<HTMLInputElement>('input[aria-label="联系人 *"]')?.value, '陈经理');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(document.activeElement === edit, '编辑对话框关闭后应将焦点还给原编辑按钮');
    const more = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === `更多供应商操作：${supplier.name}`)!;
    assert.ok(more);
    assert.equal(more.getAttribute('aria-haspopup'), 'menu');
    more.focus();
    await interactWithPortal(() => more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const menu = document.getElementById('supplier-actions-supplier-profile-ui')!;
    assert.ok(menu);
    assert.equal(menu.getAttribute('aria-label'), `供应商操作：${supplier.name}`);
    assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()), ['查看详情', '编辑供应商', '管理交期', '查看采购订单', '停用']);
    await interactWithPortal(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    assert.equal(document.activeElement?.textContent?.trim(), '停用');
    await interactWithPortal(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    assert.equal(document.activeElement?.textContent?.trim(), '查看详情');
    await interactWithPortal(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加供应商')!;
    add.focus();
    await act(async () => { add.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(dialog);
    assert.equal(dialog.querySelector('h2')?.textContent?.trim(), '添加新供应商');
    assert.match(dialog.textContent ?? '', /创建新的供应商主数据记录。/);
    assert.deepEqual([...dialog.querySelectorAll('h3')].map((heading) => heading.textContent?.trim()), ['供应商信息', '联系人信息']);
    assert.deepEqual([...dialog.querySelectorAll('label')].map((label) => label.firstElementChild?.textContent?.trim()), ['供应商编码 *', '供应商名称 *', '国家/地区 *', '采购路线 *', '类型 *', '联系人 *', '邮箱 *', '电话 *']);
    assert.equal(dialog.querySelector<HTMLInputElement>('input[aria-label="供应商编码 *"]')?.placeholder, '输入供应商编码');
    assert.equal(dialog.querySelector<HTMLInputElement>('input[aria-label="供应商名称 *"]')?.placeholder, '输入供应商名称');
    assert.equal(dialog.querySelector<HTMLInputElement>('input[aria-label="电话 *"]')?.placeholder, '输入电话号码');
    assert.match(dialog.textContent ?? '', /如果您通过 WhatsApp 联系该供应商，请填写 WhatsApp 号码。/);
    assert.doesNotMatch(dialog.textContent ?? '', /Currency|Industry|Material code|Lead Time \(days\)|Criticality|Payment terms|Operating profile/);
    assert.ok(dialog.contains(document.activeElement));
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    const createFocusDeadline = Date.now() + 1000;
    while (document.activeElement !== add && Date.now() < createFocusDeadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    }
    assert.ok(document.activeElement === add, '新增对话框关闭后应将焦点还给原新增按钮');

    await act(async () => { add.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const createDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="供应商编码 *"]')!, 'SUP-NEW-002');
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="供应商名称 *"]')!, '南方泵业');
      setControlValue(createDialog.querySelector<HTMLSelectElement>('select[aria-label="采购路线 *"]')!, 'local');
      setControlValue(createDialog.querySelector<HTMLSelectElement>('select[aria-label="类型 *"]')!, 'manufacturer');
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="联系人 *"]')!, '林工');
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="邮箱 *"]')!, 'lin@example.test');
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="电话 *"]')!, '+86 139 0000 0000');
    });
    const country = createDialog.querySelector<HTMLButtonElement>('button[aria-label="国家/地区 *"]')!;
    await interactWithPortal(() => country.click());
    const china = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '中国')!;
    assert.ok(china, '国家/地区选择器应使用中文国名');
    await interactWithPortal(() => china.click());
    const createSave = [...createDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存供应商')!;
    assert.equal(createSave.disabled, false);
    await act(async () => { createSave.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const createMutation = mutations.find((mutation) => mutation.path === '/api/procurement/suppliers' && mutation.method === 'POST')!;
    assert.equal(typeof createMutation.body['idempotencyKey'], 'string');
    assert.ok(String(createMutation.body['idempotencyKey']).length > 0);
    assert.deepEqual({ ...createMutation.body, idempotencyKey: '<dynamic>' }, {
      idempotencyKey: '<dynamic>', externalId: 'SUP-NEW-002', name: '南方泵业', currency: 'CNY',
      primaryContact: { name: '林工', email: 'lin@example.test', phone: '+86 139 0000 0000' },
      operatingProfile: { countryCode: 'CN', route: 'local', supplierType: 'manufacturer', industry: null, address: null, primaryMaterialCode: null, primaryMaterialName: null, defaultLeadTimeDays: null, productCriticality: 'unclassified', paymentTerms: null, contractStartsOn: null, contractEndsOn: null },
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);

    await act(async () => { edit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const conflictDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const route = conflictDialog.querySelector<HTMLSelectElement>('select[aria-label="采购路线 *"]')!;
    await act(async () => { setControlValue(route, 'import'); });
    const save = [...conflictDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(document.querySelector('[role="dialog"]'), '版本冲突时编辑对话框必须保持打开');
    assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="采购路线 *"]')?.value, 'import');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /供应商已被其他人更新/);
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(mutations.filter((mutation) => mutation.method === 'PATCH').length, 1, '冲突后未重新读取不得盲目重试');
    const reread = [...conflictDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('重新读取'))!;
    assert.ok(reread, '冲突后必须在当前对话框内提供显式重新读取路径');
    await act(async () => { reread.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="采购路线 *"]')?.value, 'import', '重新读取不得覆盖已审核输入');
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const patchMutations = mutations.filter((mutation) => mutation.method === 'PATCH');
    assert.equal(patchMutations.length, 2);
    assert.deepEqual(patchMutations[1]!.body, {
      expectedVersion: 2,
      expectedProfileVersion: 2,
      reason: '通过供应商编辑器更新。',
      name: '华东阀门制造',
      currency: 'CNY',
      primaryContact: { name: '陈经理', email: 'chen@example.test', phone: '+86 138 0000 0000' },
      operatingProfile: { countryCode: 'CN', route: 'import', supplierType: 'manufacturer', industry: '工业自动化', address: null, primaryMaterialCode: 'VALVE-01', primaryMaterialName: '真空阀', defaultLeadTimeDays: 21, productCriticality: 'high', paymentTerms: 'Net 30', contractStartsOn: null, contractEndsOn: null },
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.querySelector('table tbody tr')?.textContent ?? '', /进口/);

    const updatedMore = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === `更多供应商操作：${supplier.name}`)!;
    updatedMore.focus();
    await interactWithPortal(() => updatedMore.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const updatedMenu = document.getElementById('supplier-actions-supplier-profile-ui')!;
    const purchaseOrders = [...updatedMenu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === '查看采购订单')!;
    await interactWithPortal(() => selectMenuItem(purchaseOrders));
    const purchaseOrderDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(purchaseOrderDialog.querySelector('h2')?.textContent?.trim(), '采购订单');
    assert.match(purchaseOrderDialog.textContent ?? '', /PO-UI-001/);
    assert.match(purchaseOrderDialog.textContent ?? '', /草稿/);
    await interactWithPortal(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    const statusMore = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === `更多供应商操作：${supplier.name}`)!;
    statusMore.focus();
    await interactWithPortal(() => statusMore.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const statusMenu = document.getElementById('supplier-actions-supplier-profile-ui')!;
    const deactivate = [...statusMenu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === '停用')!;
    await interactWithPortal(() => selectMenuItem(deactivate));
    const statusDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(statusDialog.querySelector('h2')?.textContent?.trim(), '停用供应商');
    const statusReason = statusDialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="供应商状态变更原因"]')!;
    await act(async () => { setControlValue(statusReason, '供应协议到期，暂停后续采购'); });
    const confirmDeactivate = [...statusDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '确认停用')!;
    await act(async () => { confirmDeactivate.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const statusMutation = mutations.find((mutation) => mutation.path.endsWith('/deactivate'))!;
    assert.deepEqual(statusMutation.body, { expectedVersion: 3, reason: '供应协议到期，暂停后续采购' });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.querySelector('table tbody tr')?.textContent ?? '', /停用/);
  } finally {
    await dismissIdleOverlays();
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Supplier required and optional sources stay distinct and directory permissions fail closed', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const writes: string[] = [];
  const supplier = {
    id: 'supplier:read-only', externalId: 'SUP-RO-001', name: 'Supplier', currency: 'CNY', status: 'active', operatingStatus: 'active',
    sourceSystem: 'manual', version: 1, contacts: [{ id: 'contact:ro', name: 'Pending', email: 'readonly@example.test', phone: '+86 138 0000 0001', primary: true }],
    countryCode: 'CN', countryName: '中国',
    profile: {
      supplierId: 'supplier:read-only', countryCode: 'CN', route: 'local', supplierType: 'manufacturer', industry: 'Pending', address: null,
      primaryMaterialCode: 'RO-01', primaryMaterialName: 'Supplier', defaultLeadTimeDays: 18, productCriticality: 'medium', paymentTerms: null,
      contractStartsOn: null, contractEndsOn: null, status: 'active', version: 1,
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/suppliers') return response({ items: [supplier], permissions: { read: true, configure: false } });
    if (path.startsWith('/api/procurement/supplier-performance')) return response({ error: 'performance unavailable' }, 503);
    if (path.startsWith('/api/po/lead-times')) return response({ error: 'lead times unavailable' }, 503);
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSuppliersWorkbench } = await import('../features/procurement/suppliers-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSuppliersWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.match(document.body.textContent ?? '', /绩效快照、物料交期暂时读取失败/);
    assert.match(document.querySelector('table tbody tr')?.textContent ?? '', /Supplier/);
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === '添加供应商'), false);
    assert.equal(document.querySelector('button[aria-label^="编辑供应商"]'), null);
    const more = document.querySelector<HTMLButtonElement>('button[aria-label="更多供应商操作：Supplier"]')!;
    assert.ok(more);
    await interactWithPortal(() => more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    assert.deepEqual(
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim()),
      ['查看详情', '查看采购订单'],
    );
    assert.deepEqual(writes, []);
  } finally {
    await dismissIdleOverlays();
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Supplier first required-read failure keeps the owned shell without a fabricated empty result', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/suppliers') return response({ error: 'source unavailable' }, 503);
    if (path.startsWith('/api/procurement/supplier-performance')) return response({ latest: null });
    if (path.startsWith('/api/po/lead-times')) return response({ items: [], suppliers: [], permissions: { read: true, configure: false }, events: [] });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSuppliersWorkbench } = await import('../features/procurement/suppliers-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSuppliersWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelector('h1')?.textContent?.trim(), '供应商');
    assert.ok(document.querySelector('table'));
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /source unavailable/);
    assert.doesNotMatch(document.querySelector('table tbody')?.textContent ?? '', /没有符合搜索条件的供应商/);
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === '添加供应商'), false);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Supplier mutation is synchronously single-flight and keeps reviewed edit input on 422', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let patchWrites = 0;
  const supplier = {
    id: 'supplier:single-flight', externalId: 'SUP-SF-001', name: 'Supplier', currency: 'CNY', status: 'active', operatingStatus: 'active',
    sourceSystem: 'manual', version: 1, contacts: [{ id: 'contact:sf', name: 'Pending', email: 'single@example.test', phone: '+86 138 0000 0002', primary: true }],
    countryCode: 'CN', countryName: '中国',
    profile: {
      supplierId: 'supplier:single-flight', countryCode: 'CN', route: 'local', supplierType: 'manufacturer', industry: null, address: null,
      primaryMaterialCode: null, primaryMaterialName: null, defaultLeadTimeDays: null, productCriticality: 'unclassified', paymentTerms: null,
      contractStartsOn: null, contractEndsOn: null, status: 'active', version: 1,
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/suppliers' && (!init?.method || init.method === 'GET')) return response({ items: [supplier], permissions: { read: true, configure: true } });
    if (path.startsWith('/api/procurement/supplier-performance')) return response({ latest: null });
    if (path.startsWith('/api/po/lead-times')) return response({ items: [], suppliers: [{ id: supplier.id, name: supplier.name, status: 'active', version: 1 }], permissions: { read: true, configure: true }, events: [] });
    if (path === `/api/procurement/suppliers/${encodeURIComponent(supplier.id)}` && init?.method === 'PATCH') {
      patchWrites += 1;
      return response({ error: '联系人资料不符合当前供应商合同', code: 'INVALID_PROCUREMENT_INPUT' }, 422);
    }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSuppliersWorkbench } = await import('../features/procurement/suppliers-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSuppliersWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const edit = document.querySelector<HTMLButtonElement>('button[aria-label="编辑供应商 Supplier"]')!;
    await act(async () => { edit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const name = dialog.querySelector<HTMLInputElement>('input[aria-label="供应商名称 *"]')!;
    await act(async () => { setControlValue(name, 'Supplier Reviewed'); });
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => {
      save.click();
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(patchWrites, 1, 'same-turn submits must emit one PATCH');
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="供应商名称 *"]')?.value, 'Supplier Reviewed');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /联系人资料不符合当前供应商合同/);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Supplier create and status writes stay single-flight, lock dismissal, and require an authoritative refresh', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let createWrites = 0;
  let statusWrites = 0;
  let directoryReads = 0;
  let releaseCreate!: (value: Response) => void;
  let releaseStatus!: (value: Response) => void;
  let createReleased = false;
  let statusReleased = false;
  const pendingCreate = new Promise<Response>((resolve) => { releaseCreate = resolve; });
  const pendingStatus = new Promise<Response>((resolve) => { releaseStatus = resolve; });
  const supplier = {
    id: 'supplier:pending-ui', externalId: 'SUP-PENDING-001', name: 'Supplier', currency: 'CNY', status: 'active', operatingStatus: 'active',
    sourceSystem: 'manual', version: 1, contacts: [{ id: 'contact:pending', name: 'Pending', email: 'pending@example.test', phone: '+86 138 0000 0003', primary: true }],
    countryCode: 'CN', countryName: '中国',
    profile: {
      supplierId: 'supplier:pending-ui', countryCode: 'CN', route: 'local', supplierType: 'manufacturer', industry: null, address: null,
      primaryMaterialCode: null, primaryMaterialName: null, defaultLeadTimeDays: null, productCriticality: 'unclassified', paymentTerms: null,
      contractStartsOn: null, contractEndsOn: null, status: 'active', version: 1,
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/suppliers' && (!init?.method || init.method === 'GET')) {
      directoryReads += 1;
      if (directoryReads === 2) return response({ error: 'directory refresh unavailable' }, 503);
      return response({ items: [supplier], permissions: { read: true, configure: true } });
    }
    if (path.startsWith('/api/procurement/supplier-performance')) return response({ latest: null });
    if (path.startsWith('/api/po/lead-times')) return response({ items: [], suppliers: [{ id: supplier.id, name: supplier.name, status: 'active', version: 1 }], permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/suppliers' && init?.method === 'POST') {
      createWrites += 1;
      return pendingCreate;
    }
    if (path === `/api/procurement/suppliers/${encodeURIComponent(supplier.id)}/deactivate` && init?.method === 'POST') {
      statusWrites += 1;
      return pendingStatus;
    }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSuppliersWorkbench } = await import('../features/procurement/suppliers-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSuppliersWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加供应商')!;
    add.focus();
    await act(async () => { add.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const createDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="供应商编码 *"]')!, 'SUP-NEW-PENDING');
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="供应商名称 *"]')!, '待验证供应商');
      setControlValue(createDialog.querySelector<HTMLSelectElement>('select[aria-label="采购路线 *"]')!, 'local');
      setControlValue(createDialog.querySelector<HTMLSelectElement>('select[aria-label="类型 *"]')!, 'manufacturer');
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="联系人 *"]')!, '林经理');
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="邮箱 *"]')!, 'lin.pending@example.test');
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="电话 *"]')!, '+86 139 0000 0003');
    });
    await interactWithPortal(() => createDialog.querySelector<HTMLButtonElement>('button[aria-label="国家/地区 *"]')!.click());
    await interactWithPortal(() => [...document.querySelectorAll<HTMLButtonElement>('[data-country-option]')].find((button) => button.textContent?.trim() === '中国')!.click());
    const saveCreate = [...createDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存供应商')!;
    await act(async () => { saveCreate.click(); saveCreate.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(createWrites, 1, '创建同轮双击只能发送一次');
    assert.equal(saveCreate.getAttribute('aria-busy'), 'true');
    const closeCreate = createDialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!;
    const cancelCreate = [...createDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '取消')!;
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); closeCreate.click(); cancelCreate.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(document.querySelector('[role="dialog"]'), 'pending 创建不得通过 Escape、关闭或取消退出');

    createReleased = true;
    await act(async () => { releaseCreate(response({ supplier, version: 1 }, 201)); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(document.querySelector('[role="dialog"]'), '写入后刷新 503 时应保留创建对话框');
    assert.doesNotMatch(document.querySelector('[role="status"]')?.textContent ?? '', /已在同一事务中保存/);
    assert.equal(saveCreate.disabled, true, '权威读回前不得重复创建');
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="供应商名称 *"]')?.value, '待验证供应商');
    const reread = [...createDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '重新读取')!;
    assert.ok(reread);
    await act(async () => { reread.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    const refreshedAdd = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加供应商')!;
    assert.ok(document.activeElement === refreshedAdd, '权威读回关闭对话框后应将焦点还给刷新后的新增按钮');
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /已从服务端确认保存/);

    const more = document.querySelector<HTMLButtonElement>('button[aria-label="更多供应商操作：Supplier"]')!;
    await interactWithPortal(() => more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const deactivate = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === '停用')!;
    await interactWithPortal(() => selectMenuItem(deactivate));
    const statusDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => { setControlValue(statusDialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="供应商状态变更原因"]')!, '供应商合同到期需暂停后续采购'); });
    const confirm = [...statusDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '确认停用')!;
    await act(async () => { confirm.click(); confirm.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(statusWrites, 1, '停用同轮双击只能发送一次');
    assert.equal(confirm.getAttribute('aria-busy'), 'true');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); statusDialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(document.querySelector('[role="dialog"]'), 'pending 停用不得被关闭');
    supplier.operatingStatus = 'inactive'; supplier.profile.status = 'inactive'; supplier.profile.version = 2;
    statusReleased = true;
    await act(async () => { releaseStatus(response({ supplier, version: 2, profile: supplier.profile })); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.querySelector('table tbody tr')?.textContent ?? '', /停用/);
  } finally {
    if (!createReleased) releaseCreate(response({ error: 'test cleanup' }, 500));
    if (!statusReleased) releaseStatus(response({ error: 'test cleanup' }, 500));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await dismissIdleOverlays();
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Supplier create transport-unknown requires an authoritative reread and reuses the unchanged idempotency key', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let directoryReads = 0;
  const createBodies: Array<Record<string, unknown>> = [];
  const supplier = {
    id: 'supplier:uncertain-ui', externalId: 'SUP-UNCERTAIN-001', name: '待确认供应商', currency: 'CNY', status: 'active', operatingStatus: 'active',
    sourceSystem: 'manual', version: 1, contacts: [{ id: 'contact:uncertain', name: '林经理', email: 'lin.uncertain@example.test', phone: '+86 139 0000 0005', primary: true }],
    countryCode: 'CN', countryName: '中国',
    profile: {
      supplierId: 'supplier:uncertain-ui', countryCode: 'CN', route: 'local', supplierType: 'manufacturer', industry: null, address: null,
      primaryMaterialCode: null, primaryMaterialName: null, defaultLeadTimeDays: null, productCriticality: 'unclassified', paymentTerms: null,
      contractStartsOn: null, contractEndsOn: null, status: 'active', version: 1,
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/suppliers' && (!init?.method || init.method === 'GET')) {
      directoryReads += 1;
      return response({ items: directoryReads >= 3 ? [supplier] : [], permissions: { read: true, configure: true } });
    }
    if (path === '/api/procurement/suppliers' && init?.method === 'POST') {
      createBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (createBodies.length === 1) throw new TypeError('socket closed after dispatch');
      return response({ supplier, version: 1 }, 201);
    }
    if (path.startsWith('/api/procurement/supplier-performance')) return response({ latest: null });
    if (path.startsWith('/api/po/lead-times')) return response({ items: [], suppliers: [], permissions: { read: true, configure: true }, events: [] });
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSuppliersWorkbench } = await import('../features/procurement/suppliers-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSuppliersWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加供应商')!;
    await act(async () => { add.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      setControlValue(dialog.querySelector<HTMLInputElement>('input[aria-label="供应商编码 *"]')!, supplier.externalId);
      setControlValue(dialog.querySelector<HTMLInputElement>('input[aria-label="供应商名称 *"]')!, supplier.name);
      setControlValue(dialog.querySelector<HTMLSelectElement>('select[aria-label="采购路线 *"]')!, 'local');
      setControlValue(dialog.querySelector<HTMLSelectElement>('select[aria-label="类型 *"]')!, 'manufacturer');
      setControlValue(dialog.querySelector<HTMLInputElement>('input[aria-label="联系人 *"]')!, '林经理');
      setControlValue(dialog.querySelector<HTMLInputElement>('input[aria-label="邮箱 *"]')!, 'lin.uncertain@example.test');
      setControlValue(dialog.querySelector<HTMLInputElement>('input[aria-label="电话 *"]')!, '+86 139 0000 0005');
    });
    await interactWithPortal(() => dialog.querySelector<HTMLButtonElement>('button[aria-label="国家/地区 *"]')!.click());
    await interactWithPortal(() => [...document.querySelectorAll<HTMLButtonElement>('[data-country-option]')].find((button) => button.textContent?.trim() === '中国')!.click());
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存供应商')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(createBodies.length, 1);
    assert.equal(dialog.querySelector<HTMLInputElement>('input[aria-label="供应商名称 *"]')?.value, supplier.name);
    assert.equal(save.disabled, true, '网络结果未知时必须禁止立即重复提交');
    assert.match(dialog.textContent ?? '', /上次请求结果未知/);
    assert.doesNotMatch(document.querySelector('[role="status"]')?.textContent ?? '', /已保存/);
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(createBodies.length, 1);
    const reread = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '重新读取')!;
    await act(async () => { reread.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(dialog.querySelector<HTMLInputElement>('input[aria-label="供应商名称 *"]')?.value, supplier.name);
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(createBodies.length, 2);
    assert.equal(createBodies[1]?.['idempotencyKey'], createBodies[0]?.['idempotencyKey'], '候选内容未变化时必须复用未知结果请求的幂等键');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /已在同一事务中保存/);
  } finally {
    await dismissIdleOverlays();
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Supplier uncertain status closes after reread proves the original change was accepted', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let statusWrites = 0;
  const initialSupplier = {
    id: 'supplier:status-uncertain', externalId: 'SUP-STATUS-UNCERTAIN', name: 'Supplier', currency: 'CNY', status: 'active', operatingStatus: 'active',
    sourceSystem: 'manual', version: 1, contacts: [{ id: 'contact:status-uncertain', name: '林经理', email: 'status.uncertain@example.test', phone: '+86 139 0000 0006', primary: true }],
    countryCode: 'CN', countryName: '中国',
    profile: {
      supplierId: 'supplier:status-uncertain', countryCode: 'CN', route: 'local', supplierType: 'manufacturer', industry: null, address: null,
      primaryMaterialCode: null, primaryMaterialName: null, defaultLeadTimeDays: null, productCriticality: 'unclassified', paymentTerms: null,
      contractStartsOn: null, contractEndsOn: null, status: 'active', version: 1,
    },
  };
  let authoritativeSupplier = initialSupplier;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/suppliers' && (!init?.method || init.method === 'GET')) return response({ items: [authoritativeSupplier], permissions: { read: true, configure: true } });
    if (path.startsWith('/api/procurement/supplier-performance')) return response({ latest: null });
    if (path.startsWith('/api/po/lead-times')) return response({ items: [], suppliers: [{ id: initialSupplier.id, name: initialSupplier.name, status: authoritativeSupplier.profile.status, version: authoritativeSupplier.profile.version }], permissions: { read: true, configure: true }, events: [] });
    if (path === `/api/procurement/suppliers/${encodeURIComponent(initialSupplier.id)}/deactivate` && init?.method === 'POST') {
      statusWrites += 1;
      authoritativeSupplier = {
        ...authoritativeSupplier,
        operatingStatus: 'inactive',
        version: 2,
        profile: { ...authoritativeSupplier.profile, status: 'inactive', version: 2 },
      };
      throw new TypeError('socket closed after the server committed');
    }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSuppliersWorkbench } = await import('../features/procurement/suppliers-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSuppliersWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const more = document.querySelector<HTMLButtonElement>('button[aria-label="更多供应商操作：Supplier"]')!;
    await interactWithPortal(() => more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    const deactivate = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === '停用')!;
    await interactWithPortal(() => selectMenuItem(deactivate));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => { setControlValue(dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="供应商状态变更原因"]')!, '供应商合同到期需暂停后续采购'); });
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '确认停用')!;
    await act(async () => { confirm.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(statusWrites, 1);
    assert.match(dialog.textContent ?? '', /上次请求结果未知/);
    await act(async () => { confirm.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(statusWrites, 1, '结果未知且未重读时不得重复状态写入');
    const reread = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '重新读取')!;
    await act(async () => { reread.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.querySelector('[role="dialog"]'), null, '权威重读确认停用后不得把原意图翻转成重新启用');
    assert.equal(statusWrites, 1);
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /已从服务端确认更新/);
  } finally {
    await dismissIdleOverlays();
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Supplier mutation 403 fails closed while preserving the reviewed editor input', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let patchWrites = 0;
  const supplier = {
    id: 'supplier:revoked-ui', externalId: 'SUP-REVOKED-001', name: 'Supplier', currency: 'CNY', status: 'active', operatingStatus: 'active',
    sourceSystem: 'manual', version: 1, contacts: [{ id: 'contact:revoked', name: 'Pending', email: 'revoked@example.test', phone: '+86 138 0000 0004', primary: true }],
    countryCode: 'CN', countryName: '中国',
    profile: {
      supplierId: 'supplier:revoked-ui', countryCode: 'CN', route: 'local', supplierType: 'manufacturer', industry: null, address: null,
      primaryMaterialCode: null, primaryMaterialName: null, defaultLeadTimeDays: null, productCriticality: 'unclassified', paymentTerms: null,
      contractStartsOn: null, contractEndsOn: null, status: 'active', version: 1,
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/suppliers' && (!init?.method || init.method === 'GET')) return response({ items: [supplier], permissions: { read: true, configure: true } });
    if (path.startsWith('/api/procurement/supplier-performance')) return response({ latest: null });
    if (path.startsWith('/api/po/lead-times')) return response({ items: [], suppliers: [supplier], permissions: { read: true, configure: true }, events: [] });
    if (path === `/api/procurement/suppliers/${encodeURIComponent(supplier.id)}` && init?.method === 'PATCH') {
      patchWrites += 1;
      return response({ error: '配置权限已被管理员撤销' }, 403);
    }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSuppliersWorkbench } = await import('../features/procurement/suppliers-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSuppliersWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const edit = document.querySelector<HTMLButtonElement>('button[aria-label="编辑供应商 Supplier"]')!;
    await act(async () => { edit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const name = dialog.querySelector<HTMLInputElement>('input[aria-label="供应商名称 *"]')!;
    await act(async () => { setControlValue(name, 'Supplier Reviewed'); });
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(patchWrites, 1);
    assert.equal(name.value, 'Supplier Reviewed');
    assert.equal(name.disabled, true, '权限撤销后已打开编辑器必须变为只读');
    assert.equal(save.disabled, true);
    assert.match(dialog.textContent ?? '', /当前账号没有执行此供应商操作的权限/);
    assert.equal(document.querySelector('button[aria-label^="编辑供应商"]'), null);
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === '添加供应商'), false);
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(patchWrites, 1);
  } finally {
    await dismissIdleOverlays();
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});
