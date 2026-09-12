import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/' });
  const previous = new Map<string, unknown>();
  let animationFrameId = 0;
  const requestTestFrame = (callback: FrameRequestCallback) => {
    animationFrameId += 1;
    setTimeout(() => callback(Date.now()), 0);
    return animationFrameId;
  };
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: requestTestFrame,
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) { previous.set(key, (globalThis as Record<string, unknown>)[key]); (globalThis as Record<string, unknown>)[key] = value; }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: globals.requestAnimationFrame });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });
  return { host: dom.window.document.querySelector<HTMLDivElement>('#root')!, restore: () => {
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  } };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = control instanceof HTMLTextAreaElement
    ? control.ownerDocument.defaultView!.HTMLTextAreaElement.prototype
    : control.ownerDocument.defaultView!.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
}

test('Material Lead Times renders Chinese system labels and submits the selected backend enum from an accessible dialog', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let focusReturnedToAdd = false;
  const mutations: Array<{ method: string; body: Record<string, unknown> }> = [];
  const supplier = { id: 'supplier:criticality-ui', name: 'Pending', status: 'active', version: 1 };
  const item = {
    id: 'lead-time:criticality-ui', supplier_id: supplier.id, supplier_name: supplier.name, material: 'Supplier', item_code: 'PV-30',
    material_type: 'Pending', procurement_route: 'local', standard_lead_time_days: 15, criticality: 'high', remarks: 'Pending',
    status: 'active', version: 1, updated_by: 'human:manager', updated_at: '2026-09-03T00:00:00.000Z',
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path.startsWith('/api/po/lead-times') && (!init?.method || init.method === 'GET')) return response({ items: [item], suppliers: [supplier], permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/po/lead-times' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      mutations.push({ method: 'POST', body });
      return response({ item: { ...item, criticality: body['criticality'] } }, 201);
    }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementMaterialLeadTimesPanel } = await import('../features/procurement/material-lead-times-panel.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    const { ChineseUiLocalization } = await import('../features/localization/chinese-ui-localization.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<><ChineseUiLocalization /><ProcurementTenantPreferencesProvider><ProcurementMaterialLeadTimesPanel /></ProcurementTenantPreferencesProvider></>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.deepEqual([...document.querySelectorAll('thead th')].map((cell) => cell.textContent?.trim()), ['供应商', '物料', '物料编码', '采购路线', '交期', '关键程度', '备注', '操作']);
    assert.doesNotMatch(document.body.textContent ?? '', /家已配置|条有效规则|匹配顺序|显示已退役|最近审计|刷新/);
    assert.equal([...document.querySelectorAll('button')].filter((button) => button.textContent?.trim() === '添加交期').length, 1);
    const criticalityCell = [...document.querySelectorAll('tbody td')].find((cell) => cell.textContent?.trim() === '高');
    assert.ok(criticalityCell);
    assert.equal(criticalityCell.querySelector('[aria-hidden="true"]')?.getAttribute('data-criticality'), 'high');
    const firstRow = document.querySelector<HTMLTableRowElement>('tbody tr')!;
    assert.doesNotMatch(firstRow.textContent ?? '', /supplier:criticality-ui|工业阀门|v1|2026/);
    assert.equal(firstRow.cells[0]?.textContent?.trim(), 'Pending');
    assert.equal(firstRow.cells[1]?.textContent?.trim(), 'Supplier');
    assert.equal(firstRow.cells[3]?.textContent?.trim(), '本地');
    assert.equal(firstRow.cells[5]?.textContent?.trim(), '高');
    assert.equal(firstRow.cells[6]?.textContent?.trim(), 'Pending');
    assert.ok(firstRow.querySelector('button[aria-label="编辑交期"]'));
    assert.ok(firstRow.querySelector('button[aria-label="退役交期"]'));

    const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加交期')!;
    assert.ok(add);
    add.focus();
    await act(async () => { add.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(dialog);
    assert.ok(dialog.contains(document.activeElement));
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    focusReturnedToAdd = document.activeElement === add;
    await act(async () => { add.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const reopenedDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const high = reopenedDialog.querySelector<HTMLButtonElement>('button[aria-label="关键程度：高"]')!;
    assert.equal(high.getAttribute('aria-pressed'), 'false');
    await act(async () => { high.click(); });
    assert.equal(high.getAttribute('aria-pressed'), 'true');

    const leadTime = reopenedDialog.querySelector<HTMLInputElement>('input[aria-label="交期（天）"]')!;
    const reason = reopenedDialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="配置依据"]')!;
    await act(async () => {
      setControlValue(leadTime, '20');
      setControlValue(reason, '依据供应商正式交期协议新增规则');
    });
    const save = [...reopenedDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加交期')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0]!.body['criticality'], 'high');
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
  assert.equal(focusReturnedToAdd, true, 'closing the dialog must return focus to the Add Lead Time button');
});

test('Material Lead Time edit is single-flight and keeps reviewed fields on a version conflict', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let patchWrites = 0;
  let rejectNextPatch = true;
  const patchBodies: Array<Record<string, unknown>> = [];
  const supplier = { id: 'supplier:lead-time-conflict', name: 'Supplier', status: 'active', version: 1 };
  const item = {
    id: 'lead-time:conflict', supplier_id: supplier.id, supplier_name: supplier.name, material: 'Supplier', item_code: 'PV-30',
    material_type: 'Pending', procurement_route: 'local', standard_lead_time_days: 15, criticality: 'high', remarks: 'Pending',
    status: 'active', version: 1, updated_by: 'human:manager', updated_at: '2026-09-03T00:00:00.000Z',
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/po/lead-times' && (!init?.method || init.method === 'GET')) return response({ items: [item], suppliers: [supplier], permissions: { read: true, configure: true }, events: [] });
    if (path === `/api/po/lead-times/${encodeURIComponent(item.id)}` && init?.method === 'PATCH') {
      patchWrites += 1;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patchBodies.push(body);
      if (rejectNextPatch) {
        rejectNextPatch = false;
        item.version = 2;
        return response({ error: 'version conflict', code: 'VERSION_CONFLICT', current_version: 2 }, 409);
      }
      item.version = 3;
      item.standard_lead_time_days = Number(body['standard_lead_time_days']);
      return response({ item });
    }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementMaterialLeadTimesPanel } = await import('../features/procurement/material-lead-times-panel.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementMaterialLeadTimesPanel />);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const edit = document.querySelector<HTMLButtonElement>('button[aria-label="编辑交期"]')!;
    await act(async () => { edit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const days = dialog.querySelector<HTMLInputElement>('input[aria-label="交期（天）"]')!;
    const reason = dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="变更依据"]')!;
    await act(async () => {
      setControlValue(days, '20');
      setControlValue(reason, '供应商正式书面确认新的制造交期');
    });
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => {
      save.click();
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(patchWrites, 1, 'same-turn submits must emit one PATCH');
    assert.ok(document.querySelector('[role="dialog"]'), '409 must keep the editor open');
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="交期（天）"]')?.value, '20');
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="变更依据"]')?.value, '供应商正式书面确认新的制造交期');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /已保留当前输入/);
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(patchWrites, 1, '版本冲突后未重新读取不得盲目重试');
    const reread = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === '重新读取')!;
    assert.ok(reread, '编辑对话框内必须提供显式重新读取路径');
    await act(async () => { reread.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="交期（天）"]')?.value, '20');
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(patchWrites, 2);
    assert.equal(patchBodies[1]?.['expected_version'], 2);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Material Lead Time create and retire stay single-flight, lock pending dialogs, and restore focus', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let createWrites = 0;
  let retireWrites = 0;
  let releaseCreate!: (value: Response) => void;
  let releaseRetire!: (value: Response) => void;
  let createReleased = false;
  let retireReleased = false;
  const pendingCreate = new Promise<Response>((resolve) => { releaseCreate = resolve; });
  const pendingRetire = new Promise<Response>((resolve) => { releaseRetire = resolve; });
  const supplier = { id: 'supplier:lead-time-pending', name: 'Supplier', status: 'active', version: 1 };
  const item = {
    id: 'lead-time:pending', supplier_id: supplier.id, supplier_name: supplier.name, material: 'Supplier', item_code: 'PV-30',
    material_type: 'Pending', procurement_route: 'local' as const, standard_lead_time_days: 15, criticality: 'high' as const, remarks: 'Pending',
    status: 'active' as 'active' | 'retired', version: 1, updated_by: 'human:manager', updated_at: '2026-09-03T00:00:00.000Z',
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/po/lead-times' && (!init?.method || init.method === 'GET')) return response({ items: [item], suppliers: [supplier], permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/po/lead-times' && init?.method === 'POST') { createWrites += 1; return pendingCreate; }
    if (path === `/api/po/lead-times/${encodeURIComponent(item.id)}` && init?.method === 'DELETE') { retireWrites += 1; return pendingRetire; }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementMaterialLeadTimesPanel } = await import('../features/procurement/material-lead-times-panel.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementMaterialLeadTimesPanel />);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加交期')!;
    add.focus();
    await act(async () => { add.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const createDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      setControlValue(createDialog.querySelector<HTMLInputElement>('input[aria-label="交期（天）"]')!, '30');
      setControlValue(createDialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="配置依据"]')!, '依据供应商正式书面协议新增交期');
    });
    const create = [...createDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加交期')!;
    await act(async () => { create.click(); create.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(createWrites, 1);
    assert.equal(create.getAttribute('aria-busy'), 'true');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      createDialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click();
      [...createDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '取消')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(document.querySelector('[role="dialog"]'));
    createReleased = true;
    await act(async () => { releaseCreate(response({ item: { ...item, id: 'lead-time:created', version: 1 } }, 201)); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, add);

    const retireTrigger = document.querySelector<HTMLButtonElement>('button[aria-label="退役交期"]')!;
    retireTrigger.focus();
    await act(async () => { retireTrigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const retireDialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const reason = retireDialog.querySelector<HTMLTextAreaElement>('textarea[placeholder^="说明退役原因"]')!;
    await act(async () => { setControlValue(reason, '供应商已终止该物料的供应协议'); });
    const retire = [...retireDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '确认退役')!;
    await act(async () => { retire.click(); retire.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(retireWrites, 1);
    assert.equal(retire.getAttribute('aria-busy'), 'true');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); retireDialog.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.ok(document.querySelector('[role="dialog"]'));
    item.status = 'retired'; item.version = 2;
    retireReleased = true;
    await act(async () => { releaseRetire(response({ item })); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, document.querySelector('[data-lead-time-add]'));
  } finally {
    if (!createReleased) releaseCreate(response({ error: 'test cleanup' }, 500));
    if (!retireReleased) releaseRetire(response({ error: 'test cleanup' }, 500));
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Material Lead Time uncertain edit closes after reread proves the original write was accepted', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let patchWrites = 0;
  const supplier = { id: 'supplier:lead-time-uncertain-accepted', name: 'Supplier', status: 'active', version: 1 };
  const initialItem = {
    id: 'lead-time:uncertain-accepted', supplier_id: supplier.id, supplier_name: supplier.name, material: 'Supplier', item_code: 'PV-30',
    material_type: 'Pending', procurement_route: 'local' as const, standard_lead_time_days: 15, criticality: 'high' as const, remarks: 'Pending',
    status: 'active' as const, version: 1, updated_by: 'human:manager', updated_at: '2026-09-03T00:00:00.000Z',
  };
  let authoritativeItem = initialItem;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/po/lead-times' && (!init?.method || init.method === 'GET')) return response({ items: [authoritativeItem], suppliers: [supplier], permissions: { read: true, configure: true }, events: [] });
    if (path === `/api/po/lead-times/${encodeURIComponent(initialItem.id)}` && init?.method === 'PATCH') {
      patchWrites += 1;
      authoritativeItem = { ...authoritativeItem, standard_lead_time_days: 20, version: 2 };
      throw new TypeError('socket closed after the server committed');
    }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementMaterialLeadTimesPanel } = await import('../features/procurement/material-lead-times-panel.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementMaterialLeadTimesPanel />);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const edit = document.querySelector<HTMLButtonElement>('button[aria-label="编辑交期"]')!;
    await act(async () => { edit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => {
      setControlValue(dialog.querySelector<HTMLInputElement>('input[aria-label="交期（天）"]')!, '20');
      setControlValue(dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="变更依据"]')!, '供应商正式书面确认新的制造交期');
    });
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(patchWrites, 1);
    assert.match(dialog.textContent ?? '', /上次请求结果未知/);
    const reread = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '重新读取')!;
    await act(async () => { reread.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(document.querySelector('[role="dialog"]'), null, '权威重读已证明原写入落库时不得再次提交');
    assert.equal(patchWrites, 1);
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /已从服务端确认保存/);
  } finally {
    const openDialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const cancel = openDialog && [...openDialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '取消');
    if (cancel && runAct) await runAct(async () => { cancel.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Material Lead Time uncertain edit rereads before safely retrying an unapplied write', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const patchBodies: Array<Record<string, unknown>> = [];
  const supplier = { id: 'supplier:lead-time-uncertain-retry', name: 'Supplier', status: 'active', version: 1 };
  const initialItem = {
    id: 'lead-time:uncertain-retry', supplier_id: supplier.id, supplier_name: supplier.name, material: 'Supplier', item_code: 'PV-30',
    material_type: 'Pending', procurement_route: 'local' as const, standard_lead_time_days: 15, criticality: 'high' as const, remarks: 'Pending',
    status: 'active' as const, version: 1, updated_by: 'human:manager', updated_at: '2026-09-03T00:00:00.000Z',
  };
  let authoritativeItem = initialItem;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/po/lead-times' && (!init?.method || init.method === 'GET')) return response({ items: [authoritativeItem], suppliers: [supplier], permissions: { read: true, configure: true }, events: [] });
    if (path === `/api/po/lead-times/${encodeURIComponent(initialItem.id)}` && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patchBodies.push(body);
      if (patchBodies.length === 1) throw new TypeError('network unavailable before commit');
      authoritativeItem = { ...authoritativeItem, standard_lead_time_days: Number(body['standard_lead_time_days']), version: 2 };
      return response({ item: authoritativeItem });
    }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementMaterialLeadTimesPanel } = await import('../features/procurement/material-lead-times-panel.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementMaterialLeadTimesPanel />);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="编辑交期"]')!.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const days = dialog.querySelector<HTMLInputElement>('input[aria-label="交期（天）"]')!;
    const reason = dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="变更依据"]')!;
    await act(async () => {
      setControlValue(days, '20');
      setControlValue(reason, '供应商正式书面确认新的制造交期');
    });
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(patchBodies.length, 1);
    assert.equal(save.disabled, true);
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(patchBodies.length, 1, '结果未知且未重读时不得重复 PATCH');
    const reread = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '重新读取')!;
    await act(async () => { reread.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(days.value, '20');
    assert.equal(reason.value, '供应商正式书面确认新的制造交期');
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /原请求未落库/);
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(patchBodies.length, 2);
    assert.equal(patchBodies[1]?.['expected_version'], 1);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /制造交期已更新/);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('Material Lead Time mutation 403 fails closed while preserving the reviewed editor input', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let patchWrites = 0;
  const supplier = { id: 'supplier:lead-time-revoked', name: 'Supplier', status: 'active', version: 1 };
  const item = {
    id: 'lead-time:revoked', supplier_id: supplier.id, supplier_name: supplier.name, material: 'Supplier', item_code: 'PV-30',
    material_type: 'Pending', procurement_route: 'local' as const, standard_lead_time_days: 15, criticality: 'high' as const, remarks: 'Pending',
    status: 'active' as const, version: 1, updated_by: 'human:manager', updated_at: '2026-09-03T00:00:00.000Z',
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/po/lead-times' && (!init?.method || init.method === 'GET')) return response({ items: [item], suppliers: [supplier], permissions: { read: true, configure: true }, events: [] });
    if (path === `/api/po/lead-times/${encodeURIComponent(item.id)}` && init?.method === 'PATCH') {
      patchWrites += 1;
      return response({ error: '配置权限已被管理员撤销' }, 403);
    }
    throw new Error(`unexpected fetch: ${path} ${init?.method ?? 'GET'}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementMaterialLeadTimesPanel } = await import('../features/procurement/material-lead-times-panel.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementMaterialLeadTimesPanel />);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const edit = document.querySelector<HTMLButtonElement>('button[aria-label="编辑交期"]')!;
    await act(async () => { edit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const days = dialog.querySelector<HTMLInputElement>('input[aria-label="交期（天）"]')!;
    const reason = dialog.querySelector<HTMLTextAreaElement>('textarea[aria-label="变更依据"]')!;
    const high = dialog.querySelector<HTMLButtonElement>('button[aria-label="关键程度：高"]')!;
    await act(async () => {
      setControlValue(days, '20');
      setControlValue(reason, '供应商正式书面确认新的制造交期');
    });
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(patchWrites, 1);
    assert.equal(days.value, '20');
    assert.equal(reason.value, '供应商正式书面确认新的制造交期');
    assert.equal(days.disabled, true, '权限撤销后已打开交期编辑器必须变为只读');
    assert.equal(reason.disabled, true);
    assert.equal(high.disabled, true);
    assert.equal(save.disabled, true);
    assert.match(dialog.textContent ?? '', /当前账号没有配置制造交期的权限/);
    assert.equal(document.querySelector('button[aria-label="编辑交期"]'), null);
    assert.equal(document.querySelector('button[aria-label="退役交期"]'), null);
    assert.equal(document.querySelector('[data-lead-time-add]'), null);
    assert.doesNotMatch(document.querySelector('table tbody tr')?.textContent ?? '', /已停用/, '权限撤销不能伪造交期业务状态');
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(patchWrites, 1);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});
