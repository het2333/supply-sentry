import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/' });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => { const id = setTimeout(() => callback(Date.now()), 0); return Number(id); },
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    PointerEvent: dom.window.MouseEvent,
  };
  for (const [key, value] of Object.entries(globals)) { previous.set(key, (globalThis as Record<string, unknown>)[key]); (globalThis as Record<string, unknown>)[key] = value; }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: globals.requestAnimationFrame });
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: globals.cancelAnimationFrame });
  return { host: dom.window.document.querySelector<HTMLDivElement>('#root')!, restore: () => {
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  } };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function changeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function capabilityDraft() {
  return {
    id: 'message-draft:capability', purchaseOrderId: 'po:capability', purchaseOrderNumber: 'PO-CAP-001', supplierId: 'supplier:capability', supplierName: 'Source Supplier',
    channel: 'email', recipient: 'source@example.com', subject: 'Source subject', body: 'Source body', category: 'acknowledgement_followup',
    triggerEvidence: {}, status: 'draft', version: 3, outboxId: null, delivery: null, providerDelivery: null,
    amountTotal: 1200, currency: 'USD', promisedAt: '2026-09-12T00:00:00.000Z', createdBy: 'agent:sla', reviewedBy: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', reviewedAt: null, sentAt: null,
    senderIdentity: { displayName: 'Procurement Assistant', title: 'Buyer', organizationName: 'Readywork' },
    decisionContext: { source: 'sla_policy', label: 'Source label', summary: 'Source summary', ruleId: 'sla:1', dueAt: '2026-09-01T00:00:00.000Z', missingFields: [], sourceCommunication: null },
  };
}

test('Drafted Emails Edit replaces the detail card and persists the complete audited patch', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const patches: Record<string, unknown>[] = [];
  const approvals: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  const draft = {
    id: 'message-draft:1', purchaseOrderId: 'po:1', purchaseOrderNumber: '430092', supplierId: 'supplier:1', supplierName: 'Acme Apparel',
    channel: 'email', recipient: 'supplier@example.com', subject: 'Original subject', body: 'Original body', category: 'acknowledgement_followup',
    triggerEvidence: {}, status: 'draft', version: 3, outboxId: null, delivery: null, providerDelivery: null,
    amountTotal: 1200, currency: 'USD', promisedAt: '2026-09-12T00:00:00.000Z', createdBy: 'agent:sla', reviewedBy: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', reviewedAt: null, sentAt: null,
    senderIdentity: { displayName: 'Procurement Assistant', title: 'Buyer', organizationName: 'Readywork' },
    decisionContext: { source: 'sla_policy', label: 'Acknowledgement', summary: 'Supplier acknowledgement is overdue.', ruleId: 'sla:1', dueAt: '2026-09-01T00:00:00.000Z', missingFields: [], sourceCommunication: null },
  };
  const statusDrafts = [
    { ...draft, id: 'message-draft:queued', subject: 'Queued subject', status: 'approved_queued', version: 4, delivery: { status: 'pending', error: null, attempts: 0, dispatchedAt: null, failedAt: null, updatedAt: draft.updatedAt } },
    { ...draft, id: 'message-draft:processing', subject: 'Processing subject', status: 'approved_queued', version: 4, delivery: { status: 'processing', error: null, attempts: 1, dispatchedAt: null, failedAt: null, updatedAt: draft.updatedAt } },
    { ...draft, id: 'message-draft:failed', subject: 'Failed subject', status: 'approved_queued', version: 4, delivery: { status: 'failed', error: 'Provider timeout', attempts: 2, dispatchedAt: null, failedAt: draft.updatedAt, updatedAt: draft.updatedAt } },
    { ...draft, id: 'message-draft:blocked', subject: 'Blocked subject', status: 'approved_queued', version: 4, delivery: { status: 'blocked', error: 'Missing connector', attempts: 0, dispatchedAt: null, failedAt: null, updatedAt: draft.updatedAt } },
    { ...draft, id: 'message-draft:sent', subject: 'Sent subject', status: 'sent', version: 5, delivery: { status: 'dispatched', error: null, attempts: 1, dispatchedAt: draft.updatedAt, failedAt: null, updatedAt: draft.updatedAt } },
    { ...draft, id: 'message-draft:discarded', subject: 'Discarded subject', status: 'discarded', version: 5, delivery: null },
  ];
  const events = [{ id: 'event:1', actorId: 'agent:sla', action: 'generated_by_sla', detail: {}, createdAt: draft.createdAt }];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); const method = init?.method ?? 'GET';
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/message-drafts?status=all') return response({ items: [draft, ...statusDrafts], counts: { draft: 1, approved_queued: 4, sent: 1, discarded: 1 }, generationReadiness: { status: 'ready', publishedPolicyId: 'sla:1', publishedPolicyVersion: 2, communicationIdentityVersion: 1 }, capabilities: { edit: true, discard: true, approve: true } });
    if (path === '/api/procurement/inbound-mail') return response({ configured: false, connected: false, provider: null, mailbox: null, lastStartedAt: null, lastCompletedAt: null, lastStatus: null, lastHandledCount: null, lastError: null, unresolvedRejectedCount: 0, updatedAt: null, runs: [] });
    if (path === '/api/procurement/message-drafts/message-draft%3A1' && method === 'GET') return response({ item: draft, events, capabilities: { edit: true, discard: true, approve: true } });
    if (path === '/api/procurement/message-drafts/message-draft%3A1' && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; patches.push(body);
      Object.assign(draft, { recipient: body.recipient, subject: body.subject, body: body.body, version: 4, updatedAt: '2026-09-03T00:00:00.000Z' });
      return response({ item: draft, events: [...events, { id: 'event:2', actorId: 'human:buyer', action: 'edited', detail: {}, createdAt: '2026-09-03T00:00:00.000Z' }] });
    }
    if (path === '/api/procurement/message-drafts/message-draft%3A1/approve' && method === 'POST') {
      const headers = new Headers(init?.headers);
      approvals.push({ body: JSON.parse(String(init?.body)), key: headers.get('idempotency-key') });
      Object.assign(draft, { status: 'approved_queued', version: 5, outboxId: 'outbox:1', delivery: { status: 'pending', error: null, attempts: 0, dispatchedAt: null, failedAt: null, updatedAt: '2026-09-03T00:00:00.000Z' } });
      return response({ item: draft, outbox: { status: 'pending' } });
    }
    throw new Error(`unexpected fetch: ${path} ${method}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementMessageDrafts } = await import('../features/procurement/message-drafts.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementMessageDrafts /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const page = host.firstElementChild as HTMLElement;
    const title = page.querySelector('h1')!;
    assert.equal(title.textContent, '邮件草稿');
    assert.match(page.textContent ?? '', /智能体起草的跟进与升级邮件，可在发送前审核和编辑/);
    assert.equal([...page.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.startsWith('待处理')), true);
    const allFilter = [...page.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '全部')!;
    assert.ok(allFilter);
    assert.ok(page.classList.contains('-mx-7') && page.classList.contains('-mt-6') && page.classList.contains('w-auto'), 'integrated page owns the reference header and content canvas');
    assert.ok(title.classList.contains('leading-[1.5]'), '26px title renders at the reference 39px line height');
    assert.match(document.body.textContent ?? '', /选择一封邮件草稿进行审核/);
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === '编辑'), false, 'initial load does not auto-select a draft');
    const draftRow = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Original subject'))!;
    assert.match(draftRow.textContent ?? '', /收件人：supplier@example\.com · .*前/);
    assert.match(draftRow.textContent ?? '', /Original subject/);
    assert.match(document.querySelector('.draft-list')?.textContent ?? '', /草稿/);
    assert.match(document.querySelector('.draft-list')?.textContent ?? '', /已排队/);
    assert.match(document.querySelector('.draft-list')?.textContent ?? '', /等待连接器回执/);
    assert.match(document.querySelector('.draft-list')?.textContent ?? '', /发送失败/);
    assert.match(document.querySelector('.draft-list')?.textContent ?? '', /需要处理/);
    await act(async () => allFilter.click());
    assert.match(document.querySelector('.draft-list')?.textContent ?? '', /Sent subject已发送/);
    assert.match(document.querySelector('.draft-list')?.textContent ?? '', /Discarded subject已丢弃/);
    const pendingFilter = [...page.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith('待处理'))!;
    await act(async () => pendingFilter.click());
    assert.ok(draftRow.className.includes('focus-visible:ring-2'), 'draft rows expose a visible keyboard focus state');
    await act(async () => { draftRow.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.match(document.body.textContent ?? '', /Original body/);
    assert.match(document.body.textContent ?? '', /Acknowledgement/, 'persisted decision label keeps its original language');
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === '批准并加入发送队列'), true);
    assert.equal([...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === '丢弃'), true);
    const edit = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '编辑')!;
    edit.focus();
    await act(async () => { edit.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false, 'Edit should stay inside the right-hand card');
    assert.match(document.body.textContent ?? '', /编辑邮件草稿/);
    assert.equal(document.activeElement === document.body, true, 'replacing the focused detail action should leave focus on the page');

    const firstEditor = document.querySelector<HTMLInputElement>('[aria-label="收件人"]')!.closest('form')!;
    const firstTo = firstEditor.querySelector<HTMLInputElement>('[aria-label="收件人"]')!;
    firstTo.focus();
    await act(async () => { firstTo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.match(document.body.textContent ?? '', /编辑邮件草稿/, 'Escape should not exit the inline editor');
    const cancel = [...firstEditor.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '取消')!;
    await act(async () => { cancel.click(); });
    assert.doesNotMatch(document.body.textContent ?? '', /编辑邮件草稿/);
    assert.equal(document.activeElement === document.body, true);

    const reopenedEdit = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '编辑')!;
    await act(async () => { reopenedEdit.click(); });
    const editor = document.querySelector<HTMLInputElement>('[aria-label="收件人"]')!.closest('form')!;
    const to = editor.querySelector<HTMLInputElement>('[aria-label="收件人"]')!;
    const subject = editor.querySelector<HTMLInputElement>('[aria-label="主题"]')!;
    const messageBody = editor.querySelector<HTMLTextAreaElement>('[aria-label="正文"]')!;
    const reason = editor.querySelector<HTMLTextAreaElement>('[aria-label="编辑原因"]')!;
    await act(async () => {
      changeValue(to, 'updated@example.com'); changeValue(subject, 'Updated subject'); changeValue(messageBody, 'Updated body'); changeValue(reason, '根据采购经理复核更新');
    });
    const save = [...editor.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '保存修改')!;
    assert.equal(save.disabled, false);
    await act(async () => { save.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(patches, [{ expectedVersion: 3, recipient: 'updated@example.com', subject: 'Updated subject', body: 'Updated body', reason: '根据采购经理复核更新' }]);
    assert.doesNotMatch(document.body.textContent ?? '', /编辑邮件草稿/);
    assert.equal(document.activeElement === document.body, true);
    assert.match(document.body.textContent ?? '', /Updated subject/);
    assert.match(document.body.textContent ?? '', /修改已保存，并已记录到审计轨迹/);
    const approve = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '批准并加入发送队列')!;
    await act(async () => { approve.click(); await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(approvals.map((entry) => entry.body), [{ expectedVersion: 4 }]);
    assert.ok(approvals[0]?.key, 'approval keeps a concrete idempotency key');
    assert.match(document.body.textContent ?? '', /已排队，正在等待连接器回执/);
    assert.match(document.body.textContent ?? '', /已排队/);
    assert.doesNotMatch(document.body.textContent ?? '', /已发送/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('Drafted Emails capabilities gate manager, buyer, auditor and undeployed-backend controls independently', async (t) => {
  const cases = [
    { name: 'manager', capabilities: { edit: true, discard: true, approve: true }, expected: { edit: true, discard: true, approve: true } },
    { name: 'buyer', capabilities: { edit: true, discard: true, approve: false }, expected: { edit: true, discard: true, approve: false } },
    { name: 'auditor', capabilities: { edit: false, discard: false, approve: false }, expected: { edit: false, discard: false, approve: false } },
    { name: 'missing capabilities', capabilities: undefined, expected: { edit: false, discard: false, approve: false } },
  ] as const;

  for (const currentCase of cases) {
    await t.test(currentCase.name, async () => {
      const { host, restore } = installDom();
      const originalFetch = globalThis.fetch;
      let root: { unmount: () => void } | undefined;
      let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
      const draft = capabilityDraft();
      const listCapabilities = currentCase.name === 'missing capabilities' ? { edit: true, discard: true, approve: true } : currentCase.capabilities;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input); const method = init?.method ?? 'GET';
        if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
        if (path === '/api/procurement/message-drafts?status=all') return response({
          items: [draft], counts: { draft: 1 }, generationReadiness: { status: 'ready', publishedPolicyId: 'sla:1', publishedPolicyVersion: 2, communicationIdentityVersion: 1 },
          ...(listCapabilities ? { capabilities: listCapabilities } : {}),
        });
        if (path === '/api/procurement/message-drafts/message-draft%3Acapability' && method === 'GET') return response({
          item: draft, events: [], ...(currentCase.capabilities ? { capabilities: currentCase.capabilities } : {}),
        });
        throw new Error(`unexpected fetch: ${path} ${method}`);
      }) as typeof fetch;
      (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
      try {
        const { act } = await import('react'); runAct = act;
        const { createRoot } = await import('react-dom/client');
        const { ProcurementMessageDrafts } = await import('../features/procurement/message-drafts.js');
        const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
        await act(async () => {
          const rendered = createRoot(host); root = rendered;
          rendered.render(<ProcurementTenantPreferencesProvider><ProcurementMessageDrafts /></ProcurementTenantPreferencesProvider>);
          await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const row = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Source subject'))!;
        await act(async () => { row.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
        assert.match(document.body.textContent ?? '', /Source body/, 'every readable role can select and inspect the source draft');
        const labels = [...document.querySelectorAll<HTMLButtonElement>('button')].map((button) => button.textContent?.trim());
        assert.equal(labels.includes('编辑'), currentCase.expected.edit);
        assert.equal(labels.includes('丢弃'), currentCase.expected.discard);
        assert.equal(labels.includes('批准并加入发送队列'), currentCase.expected.approve);
      } finally {
        if (runAct) await runAct(async () => root?.unmount());
        globalThis.fetch = originalFetch;
        restore();
      }
    });
  }
});

test('Drafted Emails permission revocation preserves the draft and never fabricates queued or sent success', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let approvalAttempts = 0;
  const draft = capabilityDraft();
  const capabilities = { edit: true, discard: true, approve: true };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); const method = init?.method ?? 'GET';
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/message-drafts?status=all') return response({ items: [draft], counts: { draft: 1 }, generationReadiness: { status: 'ready', publishedPolicyId: 'sla:1', publishedPolicyVersion: 2, communicationIdentityVersion: 1 }, capabilities });
    if (path === '/api/procurement/message-drafts/message-draft%3Acapability' && method === 'GET') return response({ item: draft, events: [], capabilities });
    if (path === '/api/procurement/message-drafts/message-draft%3Acapability/approve' && method === 'POST') {
      approvalAttempts += 1;
      return response({ error: '当前角色无邮件审批权限', code: 'FORBIDDEN' }, 403);
    }
    throw new Error(`unexpected fetch: ${path} ${method}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementMessageDrafts } = await import('../features/procurement/message-drafts.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementMessageDrafts /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const row = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Source subject'))!;
    await act(async () => { row.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const approve = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '批准并加入发送队列')!;
    await act(async () => { approve.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(approvalAttempts, 1);
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /当前角色无邮件审批权限/);
    assert.match(document.querySelector('.draft-list')?.textContent ?? '', /Source subject草稿/);
    assert.match(document.body.textContent ?? '', /Source body/);
    assert.doesNotMatch(document.body.textContent ?? '', /已排队，正在等待连接器回执|已发送/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('Drafted Emails empty SLA state stays actionable in Chinese without inventing drafts', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let openedSla = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/message-drafts?status=all') return response({ items: [], counts: {}, generationReadiness: { status: 'sla_policy_missing', publishedPolicyId: null, publishedPolicyVersion: null } });
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementMessageDrafts } = await import('../features/procurement/message-drafts.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementMessageDrafts onOpenSla={() => { openedSla += 1; }} /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(document.body.textContent ?? '', /暂无需要审核的邮件草稿/);
    assert.match(document.body.textContent ?? '', /当前没有已发布的 SLA 策略/);
    const configure = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '配置 SLA')!;
    assert.ok(configure);
    await act(async () => configure.click());
    assert.equal(openedSla, 1);
    assert.equal(document.querySelectorAll('.draft-list button').length, 0);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});

test('Drafted Emails exposes an authoritative load error without fabricating success', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: true }, events: [] });
    if (path === '/api/procurement/message-drafts?status=all') return response({ error: '草稿列表暂时不可用' }, 503);
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementMessageDrafts } = await import('../features/procurement/message-drafts.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      const rendered = createRoot(host); root = rendered;
      rendered.render(<ProcurementTenantPreferencesProvider><ProcurementMessageDrafts /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0)); await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /草稿列表暂时不可用/);
    assert.doesNotMatch(document.body.textContent ?? '', /修改已保存|已排队|已发送/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});
