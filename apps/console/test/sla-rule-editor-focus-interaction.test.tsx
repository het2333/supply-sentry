import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/' });
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

function changeInput(control: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(control.ownerDocument.defaultView!.HTMLInputElement.prototype, 'value')!.set!.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

test('SLA direct rule editor restores the direct trigger after a 404 and authoritative reread', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const rule = {
    id: 'focus-rule', name: 'Focus rule', description: 'Authoritative description', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72, followupIntervalHours: 24, maxFollowups: 3,
    escalationRole: 'Procurement Manager', messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const draft = { id: 'policy:focus', name: 'Focus draft', description: 'Draft description', status: 'draft', version: 7, rules: [rule], createdBy: 'manager', updatedBy: 'manager', publishedBy: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: null };
  const payload = {
    policies: [draft], publishedPolicy: null, draftPolicies: [draft], policyImpacts: [],
    evaluations: { items: [], total: 0, counts: { on_track: 0, due_soon: 0, in_grace: 0, breached: 0, escalated: 0, blocked_missing_evidence: 0, unmatched: 0 } },
    evaluationEvents: [], events: [],
    tenantCalendar: { mode: 'tenant_working_days', timeZone: 'Asia/Shanghai', workingDays: [1, 2, 3, 4, 5], preferenceVersion: 1, inheritedDefault: false },
    permissions: { configure: true, approve: true, operate: true },
  };
  const automation = {
    policy: null, status: 'waiting_for_policy', enabled: false, intervalSeconds: null, nextRunAt: null,
    leaseExpiresAt: null, lastStartedAt: null, lastCompletedAt: null, lastStatus: null, lastResult: null,
    lastError: null, consecutiveFailures: 0, runs: [],
  };
  let slaReads = 0;
  let writes = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla' && method === 'GET') {
      slaReads += 1;
      return response(payload);
    }
    if (path === '/api/procurement/sla/automation') return response(automation);
    if (path === `/api/procurement/sla/policies/${encodeURIComponent(draft.id)}` && method === 'PATCH') {
      writes += 1;
      return response({ error: 'SLA policy no longer exists', code: 'SLA_POLICY_NOT_FOUND' }, 404);
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
    const directEdit = document.querySelector<HTMLButtonElement>('button[aria-label="编辑规则"]')!;
    const more = document.querySelector<HTMLButtonElement>('button[aria-label="更多操作"]')!;
    directEdit.focus();
    await act(async () => { directEdit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes, 1);
    assert.match(host.textContent ?? '', /服务端状态已变更/);
    const reread = [...document.querySelector('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '重新读取最新版本')!;
    await act(async () => {
      reread.click();
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(slaReads, 2);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement === directEdit, true, 'direct editor must return focus to its direct trigger');
    assert.equal(document.activeElement === more, false, 'direct editor must not return focus to the More trigger');
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});

test('SLA authoritative reread recognizes a rule edit that committed before transport failure', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const rule = {
    id: 'unknown-rule', name: 'Unknown result rule', description: 'Original description', enabled: true,
    route: 'all', stage: 'supplier_commitment', risk: 'all', deadlineBasis: 'stage_entry', calendarMode: 'elapsed_hours',
    targetOffsetHours: 48, warningHours: 4, graceHours: 24, escalationAfterHours: 72, followupIntervalHours: 24, maxFollowups: 3,
    escalationRole: 'Procurement Manager', messageCategory: 'acknowledgement_followup', communicationChannel: 'email',
  };
  const draft = { id: 'policy:unknown', name: 'Unknown result draft', description: 'Draft description', status: 'draft', version: 7, rules: [rule], createdBy: 'manager', updatedBy: 'manager', publishedBy: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', publishedAt: null };
  const reviewed = 'Committed before the connection failed';
  let authoritativeDraft = draft;
  let writes = 0;
  const payload = () => ({
    policies: [authoritativeDraft], publishedPolicy: null, draftPolicies: [authoritativeDraft], policyImpacts: [],
    evaluations: { items: [], total: 0, counts: { on_track: 0, due_soon: 0, in_grace: 0, breached: 0, escalated: 0, blocked_missing_evidence: 0, unmatched: 0 } },
    evaluationEvents: [], events: [],
    tenantCalendar: { mode: 'tenant_working_days', timeZone: 'Asia/Shanghai', workingDays: [1, 2, 3, 4, 5], preferenceVersion: 1, inheritedDefault: false },
    permissions: { configure: true, approve: true, operate: true },
  });
  const automation = {
    policy: null, status: 'waiting_for_policy', enabled: false, intervalSeconds: null, nextRunAt: null,
    leaseExpiresAt: null, lastStartedAt: null, lastCompletedAt: null, lastStatus: null, lastResult: null,
    lastError: null, consecutiveFailures: 0, runs: [],
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path === '/api/procurement/sla' && method === 'GET') return response(payload());
    if (path === '/api/procurement/sla/automation') return response(automation);
    if (path === `/api/procurement/sla/policies/${encodeURIComponent(draft.id)}` && method === 'PATCH') {
      writes += 1;
      authoritativeDraft = { ...draft, version: 8, rules: [{ ...rule, description: reviewed }] };
      throw new TypeError('connection closed after commit');
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
    let dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const description = [...dialog.querySelectorAll('label')]
      .find((label) => label.querySelector('span')?.textContent?.trim() === '描述 *')!
      .querySelector<HTMLInputElement>('input')!;
    await act(async () => { changeInput(description, reviewed); });
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '保存更改')!;
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(writes, 1);
    assert.match(dialog.textContent ?? '', /上次写入结果未知/);
    const reread = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === '重新读取最新版本')!;
    await act(async () => {
      reread.click();
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(description.value, reviewed, 'reviewed editor input remains available');
    assert.match(host.textContent ?? '', /草稿 v8 · 已保存/);
    assert.doesNotMatch(host.textContent ?? '', /草稿 v8 · 有未保存更改/);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch; restore();
  }
});
