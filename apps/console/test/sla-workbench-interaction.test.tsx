import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

function installDom(url = 'http://readywork.test/'): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter, Element: dom.window.Element, PointerEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = value;
  }
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) });
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: (id: number) => clearTimeout(id) });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });
  return { host: dom.window.document.querySelector<HTMLDivElement>('#root')!, restore: () => {
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  } };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function field(dialog: Element, label: string): HTMLInputElement | HTMLSelectElement {
  const wrapper = [...dialog.querySelectorAll('label')].find((item) => item.querySelector('span')?.textContent?.trim() === label);
  const control = wrapper?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
  assert.ok(control, `missing field ${label}`);
  return control;
}

function changeControl(control: HTMLInputElement | HTMLSelectElement, value: string): void {
  const view = control.ownerDocument.defaultView!;
  const prototype = control instanceof view.HTMLSelectElement ? view.HTMLSelectElement.prototype : view.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

test('SLA directory renders and behaves like the reference while preserving versioned draft writes', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const mutations: Array<{ path: string; body: Record<string, unknown> }> = [];
  const rule = {
    id: 'commitment-default', name: 'Pending', description: 'Supplier', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72,
    followupIntervalHours: 24, maxFollowups: 3, escalationRole: 'Procurement Manager',
    messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const secondRule = {
    ...rule,
    id: 'production-default',
    name: 'In Production',
    description: 'Production start after commitment',
    stage: 'fulfilment_production',
    messageCategory: 'production_progress_followup',
  };
  const draft = {
    id: 'policy:ui', name: 'Procurement SLA', description: 'Versioned draft', status: 'draft', version: 7,
    rules: [rule, secondRule], createdBy: 'manager', updatedBy: 'manager', publishedBy: null,
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z', publishedAt: null,
  };
  const payload = {
    policies: [draft], publishedPolicy: null, draftPolicies: [draft], policyImpacts: [],
    evaluations: { items: [], total: 0, counts: { on_track: 0, due_soon: 0, in_grace: 0, breached: 0, escalated: 0, blocked_missing_evidence: 0, unmatched: 0 } },
    evaluationEvents: [], events: [],
    tenantCalendar: { mode: 'tenant_working_days', timeZone: 'Asia/Shanghai', workingDays: [1, 2, 3, 4, 5], preferenceVersion: 1, inheritedDefault: false },
    permissions: { operate: true, approve: true, configure: true },
  };
  let currentVersion = draft.version;
  const automation = {
    policy: null, status: 'waiting_for_policy', enabled: false, intervalSeconds: null, nextRunAt: null,
    leaseExpiresAt: null, lastStartedAt: null, lastCompletedAt: null, lastStatus: null, lastResult: null,
    lastError: null, consecutiveFailures: 0, runs: [],
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/sla') {
      const currentDraft = { ...draft, version: currentVersion };
      return response({ ...payload, policies: [currentDraft], draftPolicies: [currentDraft] });
    }
    if (path === '/api/procurement/sla/automation') return response(automation);
    if (path === `/api/procurement/sla/policies/${encodeURIComponent(draft.id)}` && init?.method === 'PATCH') {
      mutations.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      if (mutations.length === 1) {
        currentVersion = 8;
        return response({ error: 'SLA 策略版本已变更', code: 'SLA_VERSION_CONFLICT', currentVersion }, 409);
      }
      currentVersion += 1;
      return response({ item: { ...draft, version: currentVersion } });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    const { ChineseUiLocalization } = await import('../features/localization/chinese-ui-localization.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<><ChineseUiLocalization /><ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider></>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual([...document.querySelectorAll('table')[0]!.querySelectorAll('thead th')].map((cell) => cell.textContent?.trim()), ['流程 / 阶段', '描述', 'SLA 目标', '宽限期', '升级时间', '适用范围', '状态', '']);
    const firstRow = document.querySelector<HTMLTableRowElement>('table tbody tr')!;
    assert.equal(firstRow.cells[0]?.textContent?.trim(), 'Pending');
    assert.equal(firstRow.cells[1]?.textContent?.trim(), 'Supplier');
    assert.match(document.querySelector('table')!.textContent ?? '', /2 天/);
    assert.match(document.querySelector('table')!.textContent ?? '', /所有供应商/);
    assert.match(document.querySelector('table')!.textContent ?? '', /启用/);
    assert.equal(document.querySelector('button[aria-label="刷新 SLA 规则"]'), null);
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.includes('策略治理与运行')), false);

    const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加新规则')!;
    add.focus();
    await act(async () => {
      add.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    let dialog = document.querySelector('[role="dialog"]')!;
    assert.ok(dialog);
    assert.equal(dialog.querySelector('h2')?.textContent?.trim(), '添加 SLA 规则');
    assert.match(dialog.textContent ?? '', /为采购阶段定义服务级别目标。/);
    assert.deepEqual(['流程 / 阶段 *', '描述 *', 'SLA 目标（天） *', '宽限期（天） *', '升级时间（天） *', '适用范围 *', '状态 *'].map((label) => Boolean(field(dialog, label))), [true, true, true, true, true, true, true]);
    assert.equal(field(dialog, '流程 / 阶段 *').value, '');
    assert.equal(field(dialog, '流程 / 阶段 *').getAttribute('placeholder'), '例如：采购订单发出 → 供应商响应');
    assert.equal(field(dialog, '描述 *').value, '');
    assert.equal(field(dialog, '描述 *').getAttribute('placeholder'), '例如：供应商确认采购订单');
    assert.deepEqual(['SLA 目标（天） *', '宽限期（天） *', '升级时间（天） *'].map((label) => field(dialog, label).value), ['2', '1', '3']);
    assert.equal(field(dialog, '状态 *').value, 'active');
    const advanced = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '高级选项');
    assert.ok(advanced, '基础 SLA 规则应提供已批准的渐进式高级合同');
    assert.equal(advanced.getAttribute('aria-expanded'), 'false');
    assert.equal([...dialog.querySelectorAll('label')].some((label) => label.textContent?.includes('触发阶段')), false);
    await act(async () => { advanced.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(advanced.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(
      ['触发阶段 *', '风险范围 *', '截止基准 *', '日历模式 *', '提前预警（小时） *', '跟进间隔（小时） *', '最多跟进次数 *', '升级角色 *', '消息类别 *', '沟通渠道 *']
        .map((label) => Boolean(field(dialog, label))),
      [true, true, true, true, true, true, true, true, true, true],
    );
    assert.equal(field(dialog, '触发阶段 *').value, 'po_sent', '新规则默认选择未占用的触发阶段');
    await act(async () => {
      changeControl(field(dialog, '流程 / 阶段 *'), '新增流程');
      changeControl(field(dialog, '描述 *'), '新增规则的真实描述');
    });
    const saveRule = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '保存规则')!;
    assert.equal(saveRule.disabled, false, '未占用的默认匹配应可保存');
    await act(async () => {
      changeControl(field(dialog, '触发阶段 *'), 'supplier_commitment');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(dialog.textContent ?? '', /已存在同一适用范围、触发阶段和风险范围的启用规则/);
    assert.equal(saveRule.disabled, true, '重复的启用匹配不得发出 PATCH');
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '取消')!.click(); });
    assert.equal(mutations.length, 0, '只打开和取消规则对话框不应产生写请求');
    assert.equal(document.activeElement === add, true);

    await act(async () => { add.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(document.activeElement === add, true);

    const more = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === '更多操作')!;
    more.focus();
    await act(async () => { more.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => item.textContent?.trim()), ['编辑规则', '复制', '删除']);
    assert.equal(document.activeElement === items[0], true);
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    assert.equal(document.activeElement === items[2], true);
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    assert.equal(document.activeElement === items[0], true);
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.activeElement === more, true);

    await act(async () => { more.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    dialog = document.querySelector('[role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /编辑 SLA 规则/);
    await act(async () => { changeControl(field(dialog, '描述 *'), 'Pending'); });
    await act(async () => {
      const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存更改')!;
      save.click(); save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0]!.body['expectedVersion'], 7);
    assert.equal(((mutations[0]!.body['rules'] as Array<Record<string, unknown>>)[0])!['description'], 'Pending');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /已被其他人更新/);
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(field(document.querySelector('[role="dialog"]')!, '描述 *').value, 'Pending');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /当前版本\s*v8/);
    const reload = [...document.querySelector('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '重新读取最新版本')!;
    assert.ok(reload, '保留输入的编辑弹窗内必须有可点击的权威重读入口');
    await act(async () => {
      [...document.querySelector('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === '保存更改')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(mutations.length, 1, '重新读取前不得用旧版本再次写入');
    await act(async () => { reload.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(field(document.querySelector('[role="dialog"]')!, '描述 *').value, 'Pending');

    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await act(async () => { more.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => {
      const duplicate = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!;
      duplicate.click(); duplicate.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(mutations.length, 2);
    assert.equal(mutations[1]!.body['expectedVersion'], 8);

    await act(async () => { more.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[2]!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    let deleteDialog = document.querySelector('[role="dialog"]')!;
    assert.equal(deleteDialog.querySelector('h2')?.textContent?.trim(), '删除“Pending”？');
    assert.deepEqual([...deleteDialog.querySelectorAll<HTMLButtonElement>('button')].map((button) => button.textContent?.trim()).filter(Boolean), ['取消', '删除']);
    assert.equal(deleteDialog.contains(document.activeElement), true);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement === more, true);
    await act(async () => { more.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[2]!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    deleteDialog = document.querySelector('[role="dialog"]')!;
    await act(async () => {
      const remove = [...deleteDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '删除')!;
      remove.click(); remove.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(mutations.length, 3);
    assert.equal(mutations[2]!.body['expectedVersion'], 9);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA directory reports forbidden reads honestly without rendering fabricated data', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const mutations: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') mutations.push(`${method} ${path}`);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla' || path === '/api/procurement/sla/automation') return response({ error: 'Forbidden' }, 403);
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    const { ChineseUiLocalization } = await import('../features/localization/chinese-ui-localization.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<><ChineseUiLocalization /><ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider></>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /没有查看 SLA 配置的权限/);
    assert.equal(document.querySelector('h1')?.textContent?.trim(), '服务等级');
    assert.ok(document.querySelector('table'));
    assert.match(document.querySelector('table tbody')?.textContent ?? '', /尚未成功读取/);
    assert.doesNotMatch(document.querySelector('table tbody')?.textContent ?? '', /暂无 SLA 规则/);
    assert.match(document.querySelector('section')?.textContent ?? '', /等待权威 SLA 策略/);
    assert.doesNotMatch(host.textContent ?? '', /\b0\b/);
    assert.deepEqual(mutations, []);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA required read translates authentication and service failures without fabricating an empty directory', async () => {
  const scenarios = [
    { status: 401, raw: 'Unauthorized', expected: '登录已过期，请重新登录后再读取 SLA 配置。' },
    { status: 503, raw: 'Service unavailable', expected: 'SLA 配置暂时不可用，请稍后重试。' },
  ];
  for (const scenario of scenarios) {
    const { host, restore } = installDom();
    const originalFetch = globalThis.fetch;
    let root: { unmount: () => void } | undefined;
    let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = String(input);
      if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
      if (path === '/api/procurement/sla') return response({ error: scenario.raw }, scenario.status);
      if (path === '/api/procurement/sla/automation') return response(waitingAutomation());
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    try {
      const { act } = await import('react'); runAct = act;
      const { createRoot } = await import('react-dom/client');
      const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
      const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
      await act(async () => {
        const rendered = createRoot(host); root = rendered;
        rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
        await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const alert = document.querySelector('[role="alert"]')?.textContent ?? '';
      assert.match(alert, new RegExp(scenario.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(alert, new RegExp(scenario.raw, 'i'));
      assert.ok(document.querySelector('table'));
      assert.match(document.querySelector('table tbody')?.textContent ?? '', /尚未成功读取/);
      assert.doesNotMatch(document.querySelector('table tbody')?.textContent ?? '', /暂无 SLA 规则/);
      assert.match(document.querySelector('section')?.textContent ?? '', /等待权威 SLA 策略/);
    } finally {
      if (runAct) await runAct(async () => { root?.unmount(); });
      await new Promise((resolve) => setTimeout(resolve, 20));
      globalThis.fetch = originalFetch; restore();
    }
  }
});

function emptySlaPayload(permissions = { operate: false, approve: false, configure: false }) {
  return {
    policies: [], publishedPolicy: null, draftPolicies: [], policyImpacts: [],
    evaluations: { items: [], total: 0, counts: { on_track: 0, due_soon: 0, in_grace: 0, breached: 0, escalated: 0, blocked_missing_evidence: 0, unmatched: 0 } },
    evaluationEvents: [], events: [],
    tenantCalendar: { mode: 'tenant_working_days', timeZone: 'Asia/Shanghai', workingDays: [1, 2, 3, 4, 5], preferenceVersion: 1, inheritedDefault: false },
    permissions,
  };
}

function waitingAutomation() {
  return {
    policy: null, status: 'waiting_for_policy', enabled: false, intervalSeconds: null, nextRunAt: null,
    leaseExpiresAt: null, lastStartedAt: null, lastCompletedAt: null, lastStatus: null, lastResult: null,
    lastError: null, consecutiveFailures: 0, runs: [],
  };
}

test('SLA stable shell remains owned while the required policy read is pending', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let finishSla: ((value: Response) => void) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla') return new Promise<Response>((resolve) => { finishSla = resolve; });
    if (path === '/api/procurement/sla/automation') return response(waitingAutomation());
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelector('h1')?.textContent?.trim(), 'SLA');
    assert.ok(document.querySelector('table'));
    assert.match(document.querySelector('table tbody')?.textContent ?? '', /正在读取版本化 SLA 策略/);
    assert.doesNotMatch(document.querySelector('table tbody')?.textContent ?? '', /暂无 SLA 规则/);
    assert.doesNotMatch(document.body.textContent ?? '', /活跃采购单\s*0|已发布 SLA 规则\s*0/);
    await act(async () => { finishSla!(response(emptySlaPayload())); await new Promise((resolve) => setTimeout(resolve, 0)); });
  } finally {
    finishSla?.(response(emptySlaPayload()));
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA automation source failure does not erase the authoritative base directory', async () => {
  const { host, restore } = installDom('http://readywork.test/?slaGovernance=1');
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla') return response(emptySlaPayload());
    if (path === '/api/procurement/sla/automation') return response({ error: 'automation offline' }, 503);
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelector('h1')?.textContent?.trim(), 'SLA');
    assert.ok(document.querySelector('table'));
    assert.match(document.querySelector('table tbody')?.textContent ?? '', /暂无 SLA 规则/);
    const governance = document.querySelector('[data-sla-governance]');
    assert.ok(governance);
    assert.match(governance.textContent ?? '', /策略治理与运行/);
    assert.doesNotMatch(governance.textContent ?? '', /Policy Governance & Runtime/);
    assert.match(governance.querySelector('[role="alert"]')?.textContent ?? '', /自动 SLA 检查状态暂时不可用/);
    assert.doesNotMatch(document.body.textContent ?? '', /automation offline/);
    await act(async () => {
      governance.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(governance.textContent ?? '', /自动化状态尚未成功读取/);
    assert.doesNotMatch(governance.textContent ?? '', /连续失败\s*0 次|暂无持久化运行记录/);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA retired-only state keeps the active directory empty while exposing immutable policy history', async () => {
  const { host, restore } = installDom('http://readywork.test/?slaGovernance=1');
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const retiredRule = {
    id: 'retired-rule', name: 'Historical business rule', description: 'Retired business description', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72, followupIntervalHours: 24, maxFollowups: 3,
    escalationRole: 'Procurement Manager', messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const retired = { id: 'policy:retired-only', name: 'Historical SLA policy', description: 'Immutable retired policy', status: 'retired', version: 4, rules: [retiredRule], createdBy: 'manager', updatedBy: 'manager', publishedBy: 'manager', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: '2026-08-02T00:00:00.000Z' };
  const payload = {
    ...emptySlaPayload({ configure: true, approve: true, operate: true }),
    policies: [retired],
    events: [{ policyId: retired.id, actorId: 'human:manager', action: 'retired', detail: { previousVersion: 3 }, createdAt: retired.updatedAt }],
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla') return response(payload);
    if (path === '/api/procurement/sla/automation') return response(waitingAutomation());
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(document.querySelector('table tbody')?.textContent ?? '', /暂无 SLA 规则/);
    assert.doesNotMatch(document.querySelector('table tbody')?.textContent ?? '', /Historical business rule/);
    assert.match(host.textContent ?? '', /暂无已发布策略/);
    assert.doesNotMatch(host.textContent ?? '', /尚未创建 SLA 策略/);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-sla-governance] button[aria-expanded="false"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const history = [...document.querySelectorAll<HTMLElement>('section')]
      .find((section) => section.querySelector('h2')?.textContent?.trim() === '历史策略');
    assert.ok(history, 'retired policies remain inspectable');
    assert.match(history.textContent ?? '', /Historical SLA policy/);
    assert.match(history.textContent ?? '', /v4/);
    assert.match(history.textContent ?? '', /已退役/);
    assert.match(history.textContent ?? '', /human:manager/);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA rule editor traps keyboard focus and dismisses from the idle overlay with trigger focus restored', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla') return response(emptySlaPayload({ configure: true, approve: true, operate: true }));
    if (path === '/api/procurement/sla/automation') return response(waitingAutomation());
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const add = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '添加新规则')!;
    add.focus();
    await act(async () => {
      add.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const initialField = dialog.querySelector<HTMLInputElement>('input')!;
    assert.equal(document.activeElement === initialField, true, 'editor initially focuses the first enabled field');
    first.focus();
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })); });
    assert.equal(document.activeElement === last, true, 'Shift+Tab wraps to the final enabled control');
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); });
    assert.equal(document.activeElement === first, true, 'Tab wraps to the first enabled control');
    const overlay = dialog.parentElement!;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const dismissed = document.querySelector('[role="dialog"]') === null;
    if (!dismissed) {
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="关闭"]')!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    assert.equal(dismissed, true, 'idle overlay pointerdown dismisses the editor');
    assert.equal(document.activeElement === add, true);
  } finally {
    if (runAct && document.querySelector('[role="dialog"]')) {
      await runAct(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA read-only directory exposes no rule mutation controls', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const writes: string[] = [];
  const rule = {
    id: 'read-only-rule', name: 'Supplier', description: 'Pending', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72, followupIntervalHours: 24, maxFollowups: 3,
    escalationRole: 'Procurement Manager', messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const policy = { id: 'policy:read-only', name: 'Read only', description: 'Published', status: 'published', version: 3, rules: [rule], createdBy: 'manager', updatedBy: 'manager', publishedBy: 'manager', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: '2026-09-01T00:00:00.000Z' };
  const payload = { ...emptySlaPayload(), policies: [policy], publishedPolicy: policy };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? 'GET') !== 'GET') writes.push(`${init?.method} ${path}`);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla') return response(payload);
    if (path === '/api/procurement/sla/automation') return response(waitingAutomation());
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(document.querySelector('table tbody')?.textContent ?? '', /Supplier/);
    assert.equal(document.querySelector('button[aria-label="编辑规则"]'), null);
    assert.equal(document.querySelector('button[aria-label="更多操作"]'), null);
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === '添加新规则'), false);
    assert.deepEqual(writes, []);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA capability matrix exposes only the writes granted by the authoritative payload', async () => {
  const rule = {
    id: 'capability-rule', name: 'Capability rule', description: 'Authoritative rule', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72, followupIntervalHours: 24, maxFollowups: 3,
    escalationRole: 'Procurement Manager', messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const published = { id: 'policy:published', name: 'Published policy', description: 'Published', status: 'published', version: 3, rules: [rule], createdBy: 'manager', updatedBy: 'manager', publishedBy: 'manager', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: '2026-09-01T00:00:00.000Z' };
  const draft = { ...published, id: 'policy:draft', name: 'Draft policy', description: 'Draft', status: 'draft', version: 4, publishedBy: null, publishedAt: null };
  const scenarios = [
    { name: 'read-only', permissions: { configure: false, approve: false, operate: false }, configure: false, approve: false, operate: false },
    { name: 'configure-only', permissions: { configure: true, approve: false, operate: false }, configure: true, approve: false, operate: false },
    { name: 'operate-only', permissions: { configure: false, approve: false, operate: true }, configure: false, approve: false, operate: true },
    { name: 'full-governance', permissions: { configure: true, approve: true, operate: true }, configure: true, approve: true, operate: true },
  ];
  for (const scenario of scenarios) {
    const { host, restore } = installDom('http://readywork.test/?slaGovernance=1');
    const originalFetch = globalThis.fetch;
    let root: { unmount: () => void } | undefined;
    let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
    const payload = {
      ...emptySlaPayload(scenario.permissions), policies: [published, draft], publishedPolicy: published,
      draftPolicies: [draft],
    };
    const automation = {
      ...waitingAutomation(), policy: { id: published.id, version: published.version, name: published.name },
      status: 'scheduled', enabled: true, intervalSeconds: 300,
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = String(input);
      if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
      if (path === '/api/procurement/sla') return response(payload);
      if (path === '/api/procurement/sla/automation') return response(automation);
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    try {
      const { act } = await import('react'); runAct = act;
      const { createRoot } = await import('react-dom/client');
      const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
      const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
      await act(async () => {
        const rendered = createRoot(host); root = rendered;
        rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
        await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const governance = document.querySelector<HTMLElement>('[data-sla-governance]')!;
      await act(async () => {
        governance.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const hasButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
        .some((button) => button.textContent?.trim() === label);
      assert.equal(hasButton('添加新规则'), scenario.configure, `${scenario.name}: directory add`);
      assert.equal(Boolean(document.querySelector('button[aria-label="编辑规则"]')), scenario.configure, `${scenario.name}: directory edit`);
      assert.equal(Boolean(document.querySelector('button[aria-label="更多操作"]')), scenario.configure, `${scenario.name}: directory more`);
      assert.equal(hasButton('添加规则'), scenario.configure, `${scenario.name}: draft add`);
      assert.equal(hasButton('草稿已保存'), scenario.configure, `${scenario.name}: draft save`);
      assert.equal(hasButton('发布策略'), scenario.configure && scenario.approve, `${scenario.name}: publish`);
      assert.equal(hasButton('退役当前策略'), scenario.configure && scenario.approve, `${scenario.name}: retire`);
      assert.equal(hasButton('立即评估活跃 PO'), scenario.operate, `${scenario.name}: evaluate`);
      assert.equal(hasButton('立即运行自动检查'), scenario.operate, `${scenario.name}: automation`);
      const draftSection = [...document.querySelectorAll<HTMLElement>('section')]
        .find((section) => section.querySelector('h2')?.textContent?.trim() === '策略草稿')!;
      assert.ok(draftSection, `${scenario.name}: draft remains inspectable`);
      if (!scenario.configure) {
        assert.equal([...draftSection.querySelectorAll<HTMLInputElement>('input')]
          .every((control) => control.matches(':disabled')), true, `${scenario.name}: draft fields are read-only`);
        assert.equal([...draftSection.querySelectorAll<HTMLSelectElement>('table select')]
          .every((control) => control.matches(':disabled')), true, `${scenario.name}: draft rule choices are read-only`);
      }
    } finally {
      if (runAct) await runAct(async () => { root?.unmount(); });
      await new Promise((resolve) => setTimeout(resolve, 20));
      globalThis.fetch = originalFetch; restore();
    }
  }
});

test('SLA create draft is single-flight before React can commit pending state', async () => {
  const { host, restore } = installDom('http://readywork.test/?slaGovernance=1');
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const pending: Array<(value: Response) => void> = [];
  const payload = emptySlaPayload({ configure: true, approve: true, operate: true });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla' && (init?.method ?? 'GET') === 'GET') return response(payload);
    if (path === '/api/procurement/sla/automation') return response(waitingAutomation());
    if (path === '/api/procurement/sla/policies' && init?.method === 'POST') {
      return new Promise<Response>((resolve) => pending.push(resolve));
    }
    throw new Error(`unexpected fetch: ${init?.method ?? 'GET'} ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-sla-governance] button[aria-expanded="false"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const create = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '创建 V1 建议草稿')!;
    await act(async () => { create.click(); create.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(pending.length, 1);
    assert.equal(create.getAttribute('aria-busy'), 'true');
    await act(async () => {
      pending[0]!(response({ item: { id: 'policy:new' } }));
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
  } finally {
    for (const resolve of pending) resolve(response({ item: { id: 'policy:new' } }));
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA confirmation dialog traps focus, restores its trigger, and locks dismissal while publishing', async () => {
  const { host, restore } = installDom('http://readywork.test/?slaGovernance=1');
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const rule = {
    id: 'confirm-rule', name: 'Confirm rule', description: 'Confirmation behavior', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72, followupIntervalHours: 24, maxFollowups: 3,
    escalationRole: 'Procurement Manager', messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const published = { id: 'policy:confirm-published', name: 'Published policy', description: 'Published', status: 'published', version: 3, rules: [rule], createdBy: 'manager', updatedBy: 'manager', publishedBy: 'manager', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: '2026-09-01T00:00:00.000Z' };
  const draft = { ...published, id: 'policy:confirm-draft', name: 'Draft policy', description: 'Draft', status: 'draft', version: 4, publishedBy: null, publishedAt: null };
  const payload = { ...emptySlaPayload({ configure: true, approve: true, operate: true }), policies: [published, draft], publishedPolicy: published, draftPolicies: [draft] };
  let finishPublish: ((value: Response) => void) | undefined;
  let publishWrites = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla' && method === 'GET') return response(payload);
    if (path === '/api/procurement/sla/automation') return response(waitingAutomation());
    if (path === `/api/procurement/sla/policies/${encodeURIComponent(draft.id)}/publish` && method === 'POST') {
      publishWrites += 1;
      return new Promise<Response>((resolve) => { finishPublish = resolve; });
    }
    throw new Error(`unexpected fetch: ${method} ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-sla-governance] button[aria-expanded="false"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const publishTrigger = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '发布策略')!;
    publishTrigger.focus();
    await act(async () => {
      publishTrigger.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    let dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const focusable = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    first.focus();
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })); });
    assert.equal(document.activeElement === last, true);
    last.focus();
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); });
    assert.equal(document.activeElement === first, true);
    await act(async () => {
      dialog.parentElement!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement === publishTrigger, true);

    await act(async () => { publishTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      [...dialog.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === '确认发布')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(publishWrites, 1);
    assert.equal(dialog.getAttribute('aria-busy'), 'true');
    const cancel = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '取消')!;
    assert.equal(cancel.disabled, true);
    await act(async () => {
      dialog.parentElement!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      cancel.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(document.querySelector('[role="dialog"]'), 'pending publish cannot be dismissed');
    await act(async () => {
      finishPublish!(response({ item: { ...draft, status: 'published', version: 5 } }));
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement === publishTrigger, true);
  } finally {
    if (runAct) {
      await runAct(async () => {
        finishPublish?.(response({ item: { ...draft, status: 'published', version: 5 } }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        root?.unmount();
      });
    } else {
      finishPublish?.(response({ item: { ...draft, status: 'published', version: 5 } }));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA cached refresh failure retains authoritative data and blocks stale writes until an explicit reread', async () => {
  const { host, restore } = installDom('http://readywork.test/?slaGovernance=1');
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const rule = {
    id: 'cached-rule', name: 'Cached rule', description: 'Cached authoritative description', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72, followupIntervalHours: 24, maxFollowups: 3,
    escalationRole: 'Procurement Manager', messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const draft = { id: 'policy:cached', name: 'Cached draft', description: 'Cached description', status: 'draft', version: 4, rules: [rule], createdBy: 'manager', updatedBy: 'manager', publishedBy: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: null };
  const initialPayload = { ...emptySlaPayload({ configure: true, approve: true, operate: true }), policies: [draft], draftPolicies: [draft] };
  const updatedDraft = { ...draft, name: 'Edited while cached', version: 5 };
  const updatedPayload = { ...initialPayload, policies: [updatedDraft], draftPolicies: [updatedDraft] };
  let slaReads = 0;
  let writes = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla' && method === 'GET') {
      slaReads += 1;
      if (slaReads === 1) return response(initialPayload);
      if (slaReads === 2) return response({ error: 'Service unavailable' }, 503);
      return response(updatedPayload);
    }
    if (path === '/api/procurement/sla/automation') return response(waitingAutomation());
    if (path === `/api/procurement/sla/policies/${encodeURIComponent(draft.id)}` && method === 'PATCH') {
      writes += 1;
      return response({ item: updatedDraft });
    }
    throw new Error(`unexpected fetch: ${method} ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-sla-governance] button[aria-expanded="false"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const nameInput = [...document.querySelectorAll<HTMLInputElement>('input')].find((input) => input.value === draft.name)!;
    await act(async () => { changeControl(nameInput, updatedDraft.name); });
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存草稿')!;
    await act(async () => {
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(writes, 1);
    assert.match(document.querySelector('table tbody')?.textContent ?? '', /Cached rule/);
    assert.match(host.textContent ?? '', /刷新失败，以下保留上次成功读取的 SLA 策略/);
    assert.doesNotMatch(document.querySelector('[role="status"]')?.textContent ?? '', /SLA 草稿已保存/);
    const reread = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '重新读取最新版本');
    assert.ok(reread, 'failed post-write refresh must expose an authoritative reread');
    await act(async () => {
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(writes, 1, 'cached pre-write version must not be submitted again');
    await act(async () => {
      reread.click();
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(slaReads, 3);
    assert.match(host.textContent ?? '', /草稿 v5/);
    assert.doesNotMatch(host.textContent ?? '', /刷新失败/);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA rule editor preserves input across 422 and transport-unknown outcomes before a versioned retry', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const rule = {
    id: 'validation-rule', name: 'Validation rule', description: 'Original description', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72, followupIntervalHours: 24, maxFollowups: 3,
    escalationRole: 'Procurement Manager', messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const draft = { id: 'policy:validation', name: 'Validation draft', description: 'Draft description', status: 'draft', version: 7, rules: [rule], createdBy: 'manager', updatedBy: 'manager', publishedBy: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: null };
  const editedDescription = 'Input retained after failures';
  const updatedRule = { ...rule, description: editedDescription };
  const updatedDraft = { ...draft, version: 8, rules: [updatedRule] };
  let authoritativeDraft = draft;
  const writes: Array<Record<string, unknown>> = [];
  let slaReads = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla' && method === 'GET') {
      slaReads += 1;
      return response({ ...emptySlaPayload({ configure: true, approve: true, operate: true }), policies: [authoritativeDraft], draftPolicies: [authoritativeDraft] });
    }
    if (path === '/api/procurement/sla/automation') return response(waitingAutomation());
    if (path === `/api/procurement/sla/policies/${encodeURIComponent(draft.id)}` && method === 'PATCH') {
      writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (writes.length === 1) return response({ error: 'Invalid SLA rule', code: 'VALIDATION_FAILED' }, 422);
      if (writes.length === 2) throw new TypeError('socket closed');
      authoritativeDraft = updatedDraft;
      return response({ item: updatedDraft });
    }
    throw new Error(`unexpected fetch: ${method} ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="编辑规则"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    let dialog = document.querySelector('[role="dialog"]')!;
    await act(async () => { changeControl(field(dialog, '描述 *'), editedDescription); });
    const save = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => { save().click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes.length, 1);
    assert.match(host.textContent ?? '', /SLA 规则未通过校验，请检查输入后重试/);
    assert.doesNotMatch(host.textContent ?? '', /Invalid SLA rule/);
    assert.equal(field(document.querySelector('[role="dialog"]')!, '描述 *').value, editedDescription);

    await act(async () => { save().click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes.length, 2);
    assert.match(host.textContent ?? '', /网络连接失败，请检查服务状态/);
    assert.match(host.textContent ?? '', /上次写入结果未知，重试前必须重新读取/);
    assert.equal(field(document.querySelector('[role="dialog"]')!, '描述 *').value, editedDescription);
    await act(async () => { save().click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes.length, 2, 'unknown result must block a blind retry');

    const reread = [...document.querySelector('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '重新读取最新版本')!;
    assert.ok(reread, '未知写入结果必须在当前弹窗内提供权威重读');
    await act(async () => {
      reread.click();
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(slaReads, 2);
    dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(field(dialog, '描述 *').value, editedDescription);
    await act(async () => {
      save().click();
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(writes.length, 3);
    assert.equal(writes[2]!['expectedVersion'], 7);
    assert.equal(((writes[2]!['rules'] as Array<Record<string, unknown>>)[0])!['description'], editedDescription);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /SLA 规则已保存到版本化草稿/);
    assert.match(host.textContent ?? '', /草稿 v8/);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA mutation permission revocation fails closed without losing the open editor input', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const rule = {
    id: 'revoked-rule', name: 'Revoked rule', description: 'Original value', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72, followupIntervalHours: 24, maxFollowups: 3,
    escalationRole: 'Procurement Manager', messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const draft = { id: 'policy:revoked', name: 'Revoked draft', description: 'Draft description', status: 'draft', version: 2, rules: [rule], createdBy: 'manager', updatedBy: 'manager', publishedBy: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: null };
  const payload = { ...emptySlaPayload({ configure: true, approve: true, operate: true }), policies: [draft], draftPolicies: [draft] };
  let writes = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla' && method === 'GET') return response(payload);
    if (path === '/api/procurement/sla/automation') return response(waitingAutomation());
    if (path === `/api/procurement/sla/policies/${encodeURIComponent(draft.id)}` && method === 'PATCH') {
      writes += 1;
      return response({ error: 'Forbidden' }, 403);
    }
    throw new Error(`unexpected fetch: ${method} ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="编辑规则"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const editedDescription = 'Retain this value after revocation';
    await act(async () => { changeControl(field(document.querySelector('[role="dialog"]')!, '描述 *'), editedDescription); });
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes, 1);
    assert.match(host.textContent ?? '', /当前账号没有修改 SLA 配置的权限/);
    assert.doesNotMatch(host.textContent ?? '', /当前账号没有查看 SLA 配置的权限/);
    const dialog = document.querySelector('[role="dialog"]')!;
    const inputRetained = field(dialog, '描述 *').value === editedDescription;
    const editorControlsDisabled = [...dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')]
      .every((control) => control.matches(':disabled'));
    const saveDisabled = save.disabled;
    const directoryWritesHidden = document.querySelector('button[aria-label="编辑规则"]') === null
      && document.querySelector('button[aria-label="更多操作"]') === null
      && ![...document.querySelectorAll<HTMLButtonElement>('button')]
        .some((button) => button.textContent?.trim() === '添加新规则');
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const duplicateBlocked = writes === 1;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(inputRetained, true);
    assert.equal(editorControlsDisabled, true, 'revoked editor becomes inspect-only');
    assert.equal(saveDisabled, true, 'revoked save action is disabled');
    assert.equal(directoryWritesHidden, true, 'revoked directory exposes no write controls');
    assert.equal(duplicateBlocked, true, 'revoked action cannot be submitted again');
  } finally {
    if (runAct && document.querySelector('[role="dialog"]')) {
      await runAct(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA governance lifecycle mutations are single-flight in the same event turn', async () => {
  const { host, restore } = installDom('http://readywork.test/?slaGovernance=1');
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const rule = {
    id: 'lifecycle-rule', name: 'Lifecycle rule', description: 'Lifecycle description', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72, followupIntervalHours: 24, maxFollowups: 3,
    escalationRole: 'Procurement Manager', messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const published = { id: 'policy:lifecycle-published', name: 'Published policy', description: 'Published', status: 'published', version: 3, rules: [rule], createdBy: 'manager', updatedBy: 'manager', publishedBy: 'manager', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: '2026-09-01T00:00:00.000Z' };
  const draft = { ...published, id: 'policy:lifecycle-draft', name: 'Draft policy', description: 'Draft', status: 'draft', version: 4, publishedBy: null, publishedAt: null };
  const payload = { ...emptySlaPayload({ configure: true, approve: true, operate: true }), policies: [published, draft], publishedPolicy: published, draftPolicies: [draft] };
  const automation = { ...waitingAutomation(), policy: { id: published.id, version: published.version, name: published.name }, status: 'scheduled', enabled: true, intervalSeconds: 300 };
  const writes: Array<{ path: string; resolve: (value: Response) => void }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (method === 'GET' && path === '/api/procurement/sla') return response(payload);
    if (method === 'GET' && path === '/api/procurement/sla/automation') return response(automation);
    return new Promise<Response>((resolve) => writes.push({ path, resolve }));
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const resolveLatest = async (act: (callback: () => void | Promise<void>) => Promise<void>, body: unknown) => {
    await act(async () => {
      writes.at(-1)!.resolve(response(body));
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === label)!;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementSlaWorkbench } = await import('../features/procurement/sla-workbench.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementSlaWorkbench /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-sla-governance] button[aria-expanded="false"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { changeControl([...document.querySelectorAll<HTMLInputElement>('input')].find((input) => input.value === draft.name)!, 'Draft policy changed'); });
    await act(async () => { const save = button('保存草稿'); save.click(); save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes.length, 1, 'save draft');
    assert.equal(button('保存草稿').getAttribute('aria-busy'), 'true');
    await resolveLatest(act, { item: draft });

    const publishTrigger = button('发布策略');
    publishTrigger.focus();
    await act(async () => { publishTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('[role="dialog"]')?.contains(document.activeElement), true, 'publish initial focus');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('[role="dialog"]'), null, 'publish closes on Escape before dispatch');
    assert.equal(document.activeElement === publishTrigger, true, 'publish restores trigger focus');
    await act(async () => { publishTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { const publish = button('确认发布'); publish.click(); publish.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes.length, 2, 'publish');
    assert.equal(button('确认发布').getAttribute('aria-busy'), 'true');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); button('取消').click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(document.querySelector('[role="dialog"]'), 'publish remains open while pending');
    await resolveLatest(act, { item: published });
    assert.equal(document.activeElement === publishTrigger, true, 'publish restores focus after success');

    await act(async () => { const evaluate = button('立即评估活跃 PO'); evaluate.click(); evaluate.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes.length, 3, 'evaluate');
    assert.equal(button('立即评估活跃 PO').getAttribute('aria-busy'), 'true');
    await resolveLatest(act, { evaluated: 1, changed: 1 });

    await act(async () => { const automate = button('立即运行自动检查'); automate.click(); automate.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes.length, 4, 'run automation');
    assert.equal(button('立即运行自动检查').getAttribute('aria-busy'), 'true');
    await resolveLatest(act, { result: { status: 'completed', result: { examined: 1, created: 0, skippedWithoutRecipient: 0 } }, automation });

    const retireTrigger = button('退役当前策略');
    retireTrigger.focus();
    await act(async () => { retireTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('[role="dialog"]')?.contains(document.activeElement), true, 'retire initial focus');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('[role="dialog"]'), null, 'retire closes on Escape before dispatch');
    assert.equal(document.activeElement === retireTrigger, true, 'retire restores trigger focus');
    await act(async () => { retireTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { const retire = button('确认退役'); retire.click(); retire.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes.length, 5, 'retire');
    assert.equal(button('确认退役').getAttribute('aria-busy'), 'true');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); button('取消').click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(document.querySelector('[role="dialog"]'), 'retire remains open while pending');
    await resolveLatest(act, { clearedEvaluations: 1 });
    assert.equal(document.activeElement === retireTrigger, true, 'retire restores focus after success');
  } finally {
    if (runAct) {
      await runAct(async () => {
        for (const write of writes) write.resolve(response({}));
        await new Promise((resolve) => setTimeout(resolve, 0));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        root?.unmount();
      });
    } else {
      for (const write of writes) write.resolve(response({}));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});
