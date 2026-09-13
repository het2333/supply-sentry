import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonResponse, poPageFixture, withPoPage } from './helpers/po-page-harness.js';

// Exercise the real order page and DOM localizer together: removing a data
// boundary must not translate supplier/material content, while preserving a
// static stage or document status must not leave that UI in Chinese.
async function inEnglish(act: typeof import('react').act, check: () => Promise<void>) {
  const { createRoot } = await import('react-dom/client');
  const { ChineseUiLocalization } = await import('../features/localization/chinese-ui-localization.js');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ChineseUiLocalization language="en" />));
    await check();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

test('known PO stages localize while custom stage labels and supplier names remain original', async () => {
  const fixture = poPageFixture();
  fixture.po.supplierName = '设置';
  fixture.context.suppliers[0]!.name = '设置';
  fixture.context.stageTimeline.push({ id: 'custom-stage', label: '设置', state: 'pending', description: '设置' });
  await withPoPage({ fixture, tab: 'history' }, async ({ act }) => {
    await inEnglish(act, async () => {
      const timeline = document.querySelector('[data-testid="po-stage-timeline"]')!;
      assert.match(timeline.querySelector('[data-stage-id="supplier_commitment"]')!.textContent ?? '', /Supplier Commitment/);
      assert.match(timeline.querySelector('[data-stage-id="custom-stage"]')!.textContent ?? '', /设置/);
      assert.doesNotMatch(timeline.querySelector('[data-stage-id="custom-stage"]')!.textContent ?? '', /Settings/);
      assert.match(document.querySelector('#po-context-title')!.parentElement!.parentElement!.textContent ?? '', /设置/);
    });
  });
});

test('line-item risk uses English while business units remain unchanged', async () => {
  const fixture = poPageFixture();
  fixture.po.risk = 'low';
  fixture.line.uom = '天';
  await withPoPage({ fixture, tab: 'items' }, async ({ act }) => {
    await inEnglish(act, async () => {
      const panel = document.querySelector('[role="tabpanel"]')!;
      const risk = [...panel.querySelectorAll('[data-po-kpi]')].find((node) => /Risk/i.test(node.textContent ?? ''))!;
      assert.match(risk.textContent ?? '', /Low/);
      assert.doesNotMatch(risk.textContent ?? '', /低/);
      assert.equal(panel.querySelector('tbody tr')!.querySelectorAll('td')[3]!.textContent, '天');
      assert.match(panel.textContent ?? '', /Total quantity/i);
      assert.match(panel.textContent ?? '', /Total (amount|value)/i);
      assert.match(panel.querySelector('h3')!.textContent ?? '', /Line items \(1\)/i);
    });
  });
});

test('missing line-item status localizes without translating an actual custom status', async () => {
  const fixture = poPageFixture();
  fixture.context.linesByDocument[String(fixture.po.id)]!.push(
    { ...fixture.line, id: 'line:custom-status', status: '未分类' },
    { ...fixture.line, id: 'line:custom-category', status: 'Uncategorized' },
  );
  await withPoPage({ fixture, tab: 'items' }, async ({ act }) => {
    await inEnglish(act, async () => {
      const panel = document.querySelector('[role="tabpanel"]')!;
      const summary = [...panel.querySelectorAll('section')].find((node) => /By status/i.test(node.querySelector('h3')?.textContent ?? ''))!;
      const labels = [...summary.querySelectorAll('span.font-medium')].map((node) => node.textContent);
      assert.deepEqual(labels.sort(), ['Unclassified', 'Uncategorized', '未分类'].sort());
      const statusCells = [...panel.querySelectorAll('tbody tr')].map((row) => row.querySelectorAll('td')[9]!.textContent);
      assert.deepEqual(statusCells, ['—', '未分类', 'Uncategorized']);
    });
  });
});

test('document category and verification state localize without translating the filename', async () => {
  const fixture = poPageFixture();
  fixture.context.poDetail.documents.rows.push({ id: 'document:language', name: '设置', category: 'packing_list', status: 'missing' });
  await withPoPage({ fixture, tab: 'documents' }, async ({ act }) => {
    await inEnglish(act, async () => {
      const row = document.querySelector('tbody tr')!;
      assert.equal(row.querySelectorAll('td')[0]!.textContent, '设置');
      assert.match(row.querySelectorAll('td')[1]!.textContent ?? '', /Packing list/i);
      await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      const panel = document.querySelector('[data-document-detail]')!;
      assert.equal(panel.querySelector('h3')!.textContent, '设置');
      assert.match(panel.textContent ?? '', /Packing list/i);
      assert.match(panel.textContent ?? '', /Missing/);
      assert.doesNotMatch(panel.textContent ?? '', /缺失|装箱单/);
    });
  });
});

test('supplier contact and confirmation material text remain original beside localized profile enums', async () => {
  const fixture = poPageFixture();
  Object.assign(fixture.context.suppliers[0]!, { name: '设置', contacts: [{ id: 'contact:language', name: '设置', role: '通知', primary: true }] });
  Object.assign(fixture.context.poDetail, { supplierProfile: { route: 'local', supplierType: '设置', defaultLeadTimeDays: 7 } });
  fixture.context.confirmations.push({ id: 'confirmation:language', status: 'confirmed', lines: [{ id: 'confirmation-line:language', description: '设置' }] });
  await withPoPage({ fixture, tab: 'supplier' }, async ({ act }) => {
    await inEnglish(act, async () => {
      const panel = document.querySelector('[role="tabpanel"]')!;
      assert.doesNotMatch(panel.textContent ?? '', /Settings|Notifications/);
      assert.match(panel.textContent ?? '', /设置/);
      assert.match(panel.textContent ?? '', /Primary contact/i);
      assert.match(panel.textContent ?? '', /Local Procurement/);
      assert.match(panel.textContent ?? '', /7 days/);
    });
  });
});

test('RFQ candidate names matching interface labels remain original in English', async () => {
  await withPoPage({ fetch(path) {
    if (path === '/api/procurement/suppliers') return jsonResponse({ items: [{ id: 'supplier:language', name: '设置', email: 'supplier@example.test' }] });
    if (path === '/api/procurement/rfqs' || path === '/api/procurement/requisitions') return jsonResponse({ items: [] });
  } }, async ({ act, button }) => {
    const { createRoot } = await import('react-dom/client');
    const { ProcurementRfqs } = await import('../features/procurement/rfqs.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<ProcurementTenantPreferencesProvider><ProcurementRfqs /></ProcurementTenantPreferencesProvider>));
      await act(async () => button(/从已登记需求开始/, host).click());
      await inEnglish(act, async () => {
        const supplier = [...host.querySelectorAll('label')].find((element) => element.textContent?.includes('supplier@example.test'));
        assert.ok(supplier, 'the actual RFQ candidate selector is rendered');
        assert.match(supplier.textContent ?? '', /设置/);
        assert.doesNotMatch(supplier.textContent ?? '', /Settings/);
        assert.match(host.textContent ?? '', /Create an RFQ from a registered purchase requisition/);
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

for (const scenario of [
  { name: 'known labels', status: 'sent', stage: 'supplier_commitment', stageLabel: 'Supplier Commitment', expectedStage: 'Supplier Commitment', expectedStatus: 'Sent' },
  { name: 'custom labels', status: '设置', stage: 'custom-stage', stageLabel: '设置', expectedStage: '设置', expectedStatus: '设置' },
]) test(`read-only edit ${scenario.name} use their provenance without altering form business values`, async () => {
  const fixture = poPageFixture(scenario.status, scenario.stage);
  fixture.context.stageTimeline[0]!.label = scenario.stageLabel;
  fixture.line.description = '设置';
  await withPoPage({ fixture }, async ({ act, button }) => {
    const { createRoot } = await import('react-dom/client');
    const { UiLanguageProvider } = await import('../features/localization/ui-language.js');
    const { ProcurementPoEmployee } = await import('../features/procurement/po-employee.js');
    const { ProcurementTenantPreferencesProvider } = await import('../features/procurement/tenant-preferences-context.js');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      window.history.replaceState({}, '', '?lang=en');
      await act(async () => root.render(<UiLanguageProvider><ProcurementTenantPreferencesProvider><ProcurementPoEmployee initialPurchaseOrderId="po:page" detailPresentation="page" /></ProcurementTenantPreferencesProvider></UiLanguageProvider>));
      const menu = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
      assert.ok(menu, 'the order action menu is available');
      await act(async () => menu.click());
      await act(async () => button(/^Edit/i).click());
      const dialog = document.querySelector('[role="dialog"]')!;
      const field = (label: RegExp) => [...dialog.querySelectorAll('label')].find((node) => label.test(node.textContent ?? ''))!.querySelector('input')!;
      assert.equal(field(/Stage \(read-only\)/).value, scenario.expectedStage);
      assert.equal(field(/Status \(read-only\)/).value, scenario.expectedStatus);
      assert.ok([...dialog.querySelectorAll('input')].some((input) => input.value === '设置'), 'the editable material value stays original');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
