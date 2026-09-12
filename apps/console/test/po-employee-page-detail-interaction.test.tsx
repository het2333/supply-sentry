import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { Root } from 'react-dom/client';

const firstPo = {
  id: 'po:page:first', sourceSystem: 'readywork', externalId: 'PO-PAGE-001', status: 'confirmed', version: 2,
  supplierId: 'supplier:first', supplierName: 'First Supplier', currency: 'USD', orderedAt: '2026-08-20T00:00:00.000Z',
  requiredInHouseAt: '2026-09-12T00:00:00.000Z', materialType: 'direct', stage: 'supplier_commitment',
  stageLabel: 'Supplier Commitment', risk: 'high', updatedAt: '2026-08-22T00:00:00.000Z',
  amountTotal: 880, overdueDays: 0, route: 'local', nextAction: 'Review drafted follow-up',
  riskFactors: [{ code: 'supplier_no_response', label: 'Missing Commitment Risk', score: 82, evidence: 'No valid supplier confirmation' }],
};

const secondPo = {
  id: 'po:page:second', sourceSystem: 'readywork', externalId: 'PO-PAGE-002', status: 'confirmed', version: 4,
  supplierId: 'supplier:second', supplierName: 'Second Supplier', currency: 'USD', orderedAt: '2026-08-19T00:00:00.000Z',
  requiredInHouseAt: '2026-09-18T00:00:00.000Z', materialType: 'direct', stage: 'supplier_commitment',
  stageLabel: 'Supplier Commitment', risk: 'medium', updatedAt: '2026-08-21T00:00:00.000Z',
  createdAt: '2026-08-18T00:00:00.000Z', sentAt: '2026-08-19T00:00:00.000Z', amountTotal: 1234.5,
  overdueDays: 4, route: 'local', nextAction: 'Review drafted follow-up', incotermName: 'FOB', paymentTerms: 'Net 30',
  riskFactors: [{ code: 'supplier_no_response', label: 'Missing Commitment Risk', score: 82, evidence: '96 hours without a valid reply' }],
};

const workbench = {
  documents: { purchaseOrders: { items: [firstPo, secondPo] } }, tasks: { items: [] }, approvals: { items: [] },
  executionApprovals: { items: [] }, exceptions: { items: [] }, portfolio: { items: [firstPo, secondPo] },
  permissions: { operate: true, approve: true },
};

function contextFor(po: typeof firstPo | typeof secondPo) {
  return {
    requestedId: po.id, objectId: po.id, purchaseOrders: [po],
    suppliers: [{ id: po.supplierId, name: po.supplierName, contacts: [{ id: `contact:${po.id}`, name: 'Alex Chen', email: 'alex@example.test', primary: true }] }],
    linesByDocument: { [po.id]: [{ id: `line:${po.id}`, itemId: 'ITEM-1', description: 'Control valve', uom: 'EA', orderedQty: 2, unitPrice: 10, currency: po.currency, requestedAt: po.requiredInHouseAt }] },
    stageTimeline: [
      { id: 'po_sent', label: 'PO Sent', description: 'Purchase order was sent.', state: 'completed' },
      { id: 'supplier_commitment', label: 'Supplier Commitment', description: 'Waiting for supplier confirmation.', state: 'active' },
      { id: 'fulfilment_production', label: 'Fulfilment / Production', description: 'Production has not started.', state: 'pending' },
      { id: 'dispatch_transit', label: 'Dispatch / Transit', description: 'Shipment has not started.', state: 'pending' },
      { id: 'delivery_grn', label: 'Delivery / GRN', description: 'Receipt has not started.', state: 'pending' },
    ], shipments: [], receipts: [], invoices: [], quantityProjections: [],
    attachments: [{ id: `attachment:${po.id}`, fileName: 'purchase-order.pdf', contentType: 'application/pdf', sizeBytes: 2048, sourceDocumentId: po.id, securityStatus: 'clean', processingStatus: 'parsed', url: `/api/procurement/attachments/${encodeURIComponent(po.id)}` }],
    actionReadiness: { queue_followup: { ready: true, code: 'ready', message: 'Ready' }, duplicate_po: { ready: true, code: 'ready', message: 'Ready' } },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('a PO deep link renders a full page with source return and adjacent PO navigation', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/?section=orders&poId=po%3Apage%3Asecond&returnTo=local-procurement' });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = value;
  }
  Object.defineProperty(dom.window, 'requestAnimationFrame', { configurable: true, value: globals.requestAnimationFrame });
  Object.defineProperty(dom.window, 'cancelAnimationFrame', { configurable: true, value: globals.cancelAnimationFrame });
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => undefined });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollBy', { configurable: true, value: () => undefined });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.startsWith('/api/procurement/tenant-preferences')) return response({ item: null, effective: { timeZone: 'Asia/Shanghai', dateFormat: 'YYYY-MM-DD', locale: 'en-US' }, inheritedDefault: true, permissions: { read: true, configure: false }, events: [] });
    if (path.startsWith('/api/procurement/workbench/context/')) return response(path.includes(encodeURIComponent(secondPo.id)) ? contextFor(secondPo) : contextFor(firstPo));
    if (path.startsWith('/api/procurement/workbench')) return response(workbench);
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  let root: Root | undefined;
  try {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ProcurementPoEmployee } = await import('../features/procurement/po-employee.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    const returns: string[] = [];
    const navigation: Array<[string, string]> = [];
    await act(async () => {
      root = createRoot(document.querySelector<HTMLDivElement>('#root')!);
      root.render(<ProcurementTenantPreferencesProvider><ProcurementPoEmployee
        initialPurchaseOrderId={secondPo.id}
        initialDetailTab="overview"
        returnLabel="Local Procurement"
        onReturn={() => returns.push('return')}
        onPurchaseOrderNavigationChange={(purchaseOrderId, tab) => navigation.push([purchaseOrderId, tab])}
      /></ProcurementTenantPreferencesProvider>);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    assert.equal(document.querySelector('[aria-label="任务详情"]') === null, true, 'page mode must not render the narrow task-detail aside');
    assert.equal(document.querySelector('[aria-label="搜索 PO 任务"]') === null, true, 'page mode must not render the queue search');
    assert.doesNotMatch(document.body.textContent ?? '', /采购订单任务队列/);
    const pageHeading = document.querySelector<HTMLElement>('h1');
    assert.match(pageHeading?.textContent ?? '', /采购订单 #PO-PAGE-002/);
    assert.equal(pageHeading?.classList.contains('text-[24px]'), true, 'page heading should use the reference 24px title scale');
    assert.match(document.querySelector('[aria-label="面包屑导航"]')?.textContent ?? '', /总览\s*本地采购\s*PO-PAGE-002/);

    const compactHeader = document.querySelector<HTMLElement>('[data-po-page-header]');
    assert.ok(compactHeader, 'page mode should render one compact reference-style header');
    assert.ok(compactHeader.querySelector('h1'));
    assert.ok(compactHeader.querySelector('[aria-label="面包屑导航"]'));
    assert.ok([...compactHeader.querySelectorAll('button')].some((button) => button.textContent?.trim() === '操作'));
    assert.ok([...compactHeader.querySelectorAll('button')].some((button) => button.textContent?.trim() === '上一张订单'));
    assert.ok([...compactHeader.querySelectorAll('button')].some((button) => button.textContent?.trim() === '下一张订单'));

    const metrics = document.querySelector<HTMLElement>('[aria-label="采购订单指标"]');
    assert.ok(metrics);
    assert.equal([...metrics.querySelectorAll<HTMLElement>('[data-po-kpi]')].every((metric) => metric.classList.contains('rounded-[24px]')), true, 'metric cards should use the reference 24px radius');
    const metricText = [...metrics.querySelectorAll<HTMLElement>('[data-po-kpi]')].map((metric) => metric.textContent?.replace(/\s+/g, ' ').trim());
    assert.equal(metricText.length, 4);
    assert.match(metricText[0] ?? '', /订单金额.*\$1,234\.50.*订单总金额/);
    assert.match(metricText[1] ?? '', /行项目总数.*1.*以 USD 计价/);
    assert.match(metricText[2] ?? '', /要求到厂日期.*2026.*已逾期 4 天/);
    assert.match(metricText[3] ?? '', /风险等级.*中.*Missing Commitment Risk/);

    for (const heading of ['采购订单详情', '时间线', '备注', '附件（1）', '订单摘要', '风险与详情']) {
      assert.ok([...document.querySelectorAll('h3')].some((node) => node.textContent?.trim() === heading), `missing ${heading}`);
    }
    const detailsCard = [...document.querySelectorAll<HTMLElement>('section')].find((section) => section.querySelector('h3')?.textContent?.trim() === '采购订单详情');
    const summaryCard = [...document.querySelectorAll<HTMLElement>('section')].find((section) => section.querySelector('h3')?.textContent?.trim() === '订单摘要');
    assert.equal(detailsCard?.classList.contains('rounded-[24px]'), true, 'overview cards should use the reference radius');
    assert.equal(summaryCard?.classList.contains('h-[264px]'), true, 'order summary should preserve the reference card height');
    const overviewText = document.querySelector('[role="tabpanel"]')?.textContent ?? '';
    assert.match(overviewText, /订单编号\s*PO-PAGE-002/);
    assert.match(overviewText, /供应商\s*Second Supplier/);
    assert.match(overviewText, /联系人\s*Alex Chen/);
    assert.match(overviewText, /国际贸易术语\s*FOB/);
    assert.match(overviewText, /付款条款\s*Net 30/);
    assert.match(overviewText, /订单进度\s*20%/);
    assert.match(overviewText, /已完成 1 \/ 5 个阶段/);
    assert.match(overviewText, /分析结果\s*Missing Commitment Risk/);
    assert.match(overviewText, /下一步操作\s*Review drafted follow-up/);
    assert.doesNotMatch(overviewText, /AI 判断|AI 建议/);

    const sendReminder = document.querySelector<HTMLButtonElement>('#po-ai-action-followup-confirm');
    assert.ok(sendReminder, 'reference-style reminder action should be available from the persisted follow-up action');
    await act(async () => { sendReminder.click(); });
    assert.ok(document.querySelector('#confirm-action-title'), 'reminder must open the existing real action confirmation flow');
    const closeConfirmation = document.querySelector<HTMLButtonElement>('[aria-label="关闭操作确认"]');
    assert.ok(closeConfirmation);
    await act(async () => { closeConfirmation.click(); });

    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    assert.deepEqual(tabs.map((button) => button.textContent?.trim()), ['概览', '行项目', '供应商', '文档', '历史记录', '沟通']);

    const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '返回本地采购');
    assert.ok(back);
    await act(async () => { back.click(); });
    assert.deepEqual(returns, ['return']);

    const previousPo = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '上一张订单');
    const nextPo = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '下一张订单');
    assert.ok(previousPo);
    assert.ok(nextPo);
    assert.equal(previousPo.disabled, false);
    assert.equal(nextPo.disabled, true);
    await act(async () => {
      previousPo.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.match(document.querySelector('h1')?.textContent ?? '', /采购订单 #PO-PAGE-001/);
    assert.deepEqual(navigation.at(-1), [firstPo.id, 'overview']);
  } finally {
    if (root) {
      const { act } = await import('react');
      await act(async () => root?.unmount());
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  }
});
