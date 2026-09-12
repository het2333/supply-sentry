import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { Root } from 'react-dom/client';

function fixture(approve = true, pending = true) {
  const po = { id: 'po:approval-ui', externalId: 'PO-APPROVAL-001', sourceSystem: 'readywork', status: 'awaiting_confirmation', version: 4, supplierId: 'supplier:approval-ui', supplierName: '测试供应商', currency: 'CNY', orderedAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z' };
  const line = { id: 'line:approval-ui', poId: po.id, itemId: 'PV-30', description: '气动阀', orderedQty: 200, unitPrice: 127, uom: '件', currency: 'CNY', requestedAt: '2026-09-20T00:00:00.000Z' };
  const confirmation = { id: 'confirmation:approval-ui', poId: po.id, supplierId: po.supplierId, status: pending ? 'pending_approval' : 'accepted', version: 1 };
  const confirmedLine = { id: 'confirmation-line:approval-ui', confirmationId: confirmation.id, poLineId: line.id, confirmedQty: 199, confirmedUnitPrice: 122, promisedAt: '2026-09-20T00:00:00.000Z', quantityVariance: -1, unitPriceVariance: -5, promisedAtVarianceDays: 0, requiresApproval: true };
  const approval = { id: 'approval:approval-ui', poId: po.id, objectId: confirmation.id, kind: 'supplier_confirmation', status: pending ? 'pending' : 'approved', requestedBy: 'ai:supplier-reply', reason: '供应商确认存在数量、价格或交期差异' };
  const workbench = { documents: { purchaseOrders: { items: [po] } }, portfolio: { items: [po] }, tasks: { items: [] }, approvals: { items: [] }, executionApprovals: { items: [approval] }, exceptions: { items: [] }, permissions: { operate: true, approve } };
  const context = { requestedId: po.id, objectId: po.id, purchaseOrders: [po], suppliers: [{ id: po.supplierId, name: po.supplierName, contacts: [] }], executionApprovals: [approval], confirmations: [confirmation], linesByDocument: { [po.id]: [line], [confirmation.id]: [confirmedLine] }, quantityProjections: [], stageTimeline: [], shipments: [], receipts: [], invoices: [], attachments: [], communications: [], tasks: [], approvals: [] };
  return { po, approval, confirmation, workbench, context };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function withPage(options: { approve?: boolean; pending?: boolean; rejectRequest?: boolean }, check: (page: {
  act: typeof import('react').act;
  requests: Array<{ body: Record<string, unknown>; key: string | null }>;
  button: (pattern: RegExp, scope?: ParentNode) => HTMLButtonElement;
}) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/?section=orders&poId=po%3Aapproval-ui' });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
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
  const data = fixture(options.approve, options.pending);
  const requests: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'zh-CN' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path.startsWith('/api/procurement/workbench/context/')) return response(data.context);
    if (path.startsWith('/api/procurement/workbench')) return response(data.workbench);
    if (path === '/api/procurement/execution/decide_confirmation' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      requests.push({ body, key: new Headers(init.headers).get('Idempotency-Key') });
      if (options.rejectRequest) return response({ error: '审批服务暂不可用' }, 503);
      data.approval.status = body.decision;
      data.confirmation.status = body.decision === 'approved' ? 'accepted' : 'rejected';
      data.po.status = body.decision === 'approved' ? 'confirmed' : 'supplier_rejected';
      data.po.version = 5;
      return response({ aggregate: data.po, approval: data.approval }, 201);
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  let root: Root | undefined;
  const { act } = await import('react');
  try {
    const { createRoot } = await import('react-dom/client');
    const { ProcurementPoEmployee } = await import('../features/procurement/po-employee.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    await act(async () => {
      root = createRoot(document.querySelector('#root')!);
      root.render(<ProcurementTenantPreferencesProvider><ProcurementPoEmployee initialPurchaseOrderId={data.po.id} initialDetailTab="overview" detailPresentation="page" /></ProcurementTenantPreferencesProvider>);
    });
    const button = (pattern: RegExp, scope: ParentNode = document) => {
      const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((entry) => pattern.test(entry.textContent ?? ''));
      assert.ok(found, `missing button ${pattern}`);
      return found;
    };
    await check({ act, requests, button });
  } finally {
    await act(async () => root?.unmount());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  }
}

// Catches the page-only rendering omission and accidental approval on the first click.
test('page overview exposes pending confirmation facts and requires a reason before approving shortfall', async () => {
  await withPage({}, async ({ act, requests, button }) => {
    const card = document.querySelector<HTMLElement>('section[aria-label="待审批"]');
    assert.ok(card, 'the independent overview must expose its pending approval');
    assert.match(card.textContent ?? '', /200\s*件.*199\s*件/);
    assert.match(card.textContent ?? '', /127\.00.*122\.00/);
    assert.match(card.textContent ?? '', /2026-09-20/);
    assert.match(card.textContent ?? '', /永久关闭/);
    await act(async () => button(/批准短交并关闭剩余 1 件/, card).click());
    assert.equal(requests.length, 0, 'entry button must only open the review dialog');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="confirm-action-title"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /剩余量将永久关闭/);
    await act(async () => button(/批准短交并关闭剩余 1 件/, dialog).click());
    assert.equal(requests.length, 0, 'blank reason must prevent the destructive decision');
    assert.match(document.body.textContent ?? '', /必须填写关闭剩余量的原因/);
    const reason = dialog.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(reason, '需求调整，接受短交并关闭剩余 1 件');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      reason.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => button(/批准短交并关闭剩余 1 件/, dialog).click());
    assert.deepEqual(requests, [{ key: 'web-po:approve-confirmation:approval:approval-ui:v4', body: { aggregateId: 'approval:approval-ui', expectedVersion: 4, decision: 'approved', shortfallDisposition: 'cancel_remainder', reason: '需求调整，接受短交并关闭剩余 1 件' } }]);
    assert.equal(document.querySelector('section[aria-label="待审批"]'), null, 'refetched resolved approval must leave the pending section');
    assert.match(document.body.textContent ?? '', /短交已批准/);
  });
});

test('page rejection uses the existing decision endpoint and preserves pending state on backend error', async () => {
  await withPage({ rejectRequest: true }, async ({ act, requests, button }) => {
    await act(async () => button(/^拒绝差异$/).click());
    assert.equal(requests.length, 0);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="confirm-action-title"]');
    assert.ok(dialog);
    await act(async () => button(/确认事实并保存|确认并继续/, dialog).click());
    assert.deepEqual(requests, [{ key: 'web-po:reject-confirmation:approval:approval-ui:v4', body: { aggregateId: 'approval:approval-ui', expectedVersion: 4, decision: 'rejected' } }]);
    assert.ok(document.querySelector('section[aria-label="待审批"]'));
    assert.ok(document.querySelector('#confirm-action-title'), 'failed decision must retain the review dialog');
    assert.match(document.body.textContent ?? '', /审批服务暂不可用/);
    assert.doesNotMatch(document.body.textContent ?? '', /供应商确认差异已拒绝，审计记录已保存/);
  });
});

test('page pending approval is visible but not actionable without approve permission', async () => {
  await withPage({ approve: false }, async ({ requests }) => {
    const card = document.querySelector<HTMLElement>('section[aria-label="待审批"]');
    assert.ok(card);
    assert.match(card.textContent ?? '', /当前账号没有审批权限/);
    assert.equal(card.querySelectorAll('button').length, 0);
    assert.equal(requests.length, 0);
  });
});

test('page does not offer approval for an already decided confirmation', async () => {
  await withPage({ pending: false }, async () => {
    assert.ok(document.querySelector('[role="tabpanel"]'));
    assert.equal(document.querySelector('section[aria-label="待审批"]'), null);
    assert.equal([...document.querySelectorAll('button')].some((entry) => /批准短交|拒绝差异/.test(entry.textContent ?? '')), false);
  });
});
