import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonResponse, poPageFixture, withPoPage } from './helpers/po-page-harness.js';

const panel = () => document.querySelector<HTMLElement>('[role="tabpanel"]')!;
const text = () => panel().textContent ?? '';

test('PO header, overview counts and tab labels render Chinese directly while business text remains original', async () => {
  const fixture = poPageFixture();
  fixture.po.supplierName = 'Pending Supplies';
  fixture.context.suppliers[0]!.name = 'Pending Supplies';
  fixture.po.notes = 'No notes yet. Keep this original supplier wording.';
  fixture.po.overdueDays = 3;
  fixture.po.orderedAt = '2026-09-01T00:00:00.000Z';
  fixture.po.route = 'import';
  await withPoPage({ fixture }, async ({ act, button, requests }) => {
    assert.equal(document.querySelector('h1')?.textContent, '采购订单 #PO-PAGE');
    assert.deepEqual([...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent), ['概览', '行项目', '供应商', '文档', '历史记录', '沟通']);
    assert.match(document.querySelector('[data-po-page-header]')?.textContent ?? '', /创建于.*进口采购/);
    assert.match(document.querySelector('[data-po-page-header]')?.textContent ?? '', /已逾期 3 天/);
    assert.match(text(), /附件（0）/);
    assert.match(text(), /暂无文档/);
    assert.match(text(), /已完成 0 \/ 1 个阶段/);
    assert.match(text(), /Pending Supplies/);
    assert.match(text(), /No notes yet\. Keep this original supplier wording\./);
    await act(async () => button(/^操作$/).click());
    assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent), ['编辑采购订单', '复制订单', '下载 PDF', '打印', '取消采购订单']);
    assert.equal(requests.length, 0);
  });
});

function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

test('optional missing documents do not become mandatory warnings', async () => {
  const fixture = poPageFixture();
  fixture.context.poDetail.documents.requirements.push({ id: 'invoice', label: 'Invoice', required: false, state: 'missing' });
  await withPoPage({ fixture, tab: 'documents' }, async () => {
    assert.ok(panel().querySelector('[role="alert"]') === null);
    assert.doesNotMatch(text(), /缺少必需文档/);
  });
});

test('known stage labels render Chinese before the localization observer runs', async () => {
  const fixture = poPageFixture();
  fixture.context.stageTimeline[0]!.label = 'Supplier Commitment';
  await withPoPage({ fixture, tab: 'history' }, async () => {
    assert.doesNotMatch(text(), /Supplier Commitment|In progress|Timeline/);
    assert.match(text(), /供应商承诺/);
    assert.match(text(), /进行中/);
    assert.equal(document.querySelector('main')?.getAttribute('aria-label'), '采购订单详情');
  });
});

test('the legacy localization observer cannot rewrite persisted risk, next-action or audit values', async () => {
  const fixture = poPageFixture();
  fixture.po.riskFactors = [{ code: 'custom_evidence', label: 'Draft', score: 50 }];
  fixture.po.nextAction = 'Supplier';
  fixture.context.poDetail.history.events = [{ id: 'event:wording', label: 'Pending', actor: 'Draft', type: 'custom', at: '2026-09-06T00:00:00Z' }];
  await withPoPage({ fixture }, async ({ act }) => {
    const { createRoot } = await import('react-dom/client');
    const { ChineseUiLocalization } = await import('../features/localization/chinese-ui-localization.js');
    const container = document.createElement('div');
    document.body.append(container);
    const localization = createRoot(container);
    try {
      await act(async () => localization.render(<ChineseUiLocalization />));
      assert.match(text(), /分析结果Draft/);
      assert.match(text(), /下一步操作Supplier/);
      await act(async () => document.querySelector<HTMLButtonElement>('#po-detail-tab-history')!.click());
      assert.match(text(), /Pending/);
      assert.match(text(), /Draft · custom/);
    } finally {
      await act(async () => localization.unmount());
      container.remove();
    }
  });
});

test('an empty Items projection shows the reference empty card, not an empty table or a filter miss', async () => {
  const fixture = poPageFixture();
  fixture.po.amountTotal = 0;
  fixture.context.linesByDocument['po:page'] = [];
  await withPoPage({ fixture, tab: 'items' }, async ({ requests }) => {
    assert.equal(panel().querySelectorAll('table').length, 0, 'empty line items must not render table headers');
    assert.match(text(), /暂无行项目/);
    assert.doesNotMatch(text(), /没有符合当前筛选/);
    assert.equal(panel().querySelectorAll('[data-po-kpi]').length, 4, 'Items retains the shared order metrics');
    assert.match(panel().querySelector('[data-po-kpi]')?.textContent ?? '', /订单金额—/, '参考空态不把汇总出的 0 冒充有效订单金额');
    assert.equal(panel().querySelector<HTMLInputElement>('input')?.disabled, true);
    assert.equal(requests.length, 0);
  });
});

test('Items search keeps the non-empty reference table shell and can recover without a fetch', async () => {
  await withPoPage({ tab: 'items' }, async ({ act, reads, requests }) => {
    const before = reads.length;
    assert.equal(panel().querySelectorAll('tbody tr').length, 1);
    await act(async () => setInput(panel().querySelector('input')!, 'nonexistent material'));
    assert.equal(panel().querySelectorAll('tbody tr').length, 0);
    assert.equal(panel().querySelectorAll('table').length, 1, '搜索无结果时参考页保留非空订单的表格结构');
    assert.match(text(), /显示 0 至 0，共 0 项/);
    assert.doesNotMatch(text(), /暂无行项目/);
    assert.doesNotMatch(text(), /清除筛选/);
    await act(async () => setInput(panel().querySelector('input')!, ''));
    assert.equal(panel().querySelectorAll('tbody tr').length, 1);
    assert.match(text(), /测试阀门/);
    assert.equal(reads.length, before);
    assert.equal(requests.length, 0);
  });
});

test('Items non-empty source contract paginates five rows and keeps ordinary Filter and Group by controls inert', async () => {
  const fixture = poPageFixture();
  fixture.context.linesByDocument['po:page'] = Array.from({ length: 7 }, (_, index) => ({
    id: `line:${index + 1}`,
    lineNumber: String((index + 1) * 10),
    itemId: `SKU-${index + 1}`,
    description: `原始物料 ${index + 1}`,
    category: index < 4 ? 'Category A' : 'Category B',
    orderedQty: index + 1,
    uom: 'EA',
    unitPrice: 10,
    taxRate: 0.13,
    status: index < 5 ? 'confirmed' : 'pending',
    currency: 'CNY',
    requestedAt: `2026-09-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`,
  }));
  await withPoPage({ fixture, tab: 'items' }, async ({ act, button, reads, requests }) => {
    assert.deepEqual([...panel().querySelectorAll('th')].map((node) => node.textContent), [
      '物料', 'SKU', '分类', '单位', '数量', '单价 (CNY)', '税率 (%)', '总额 (CNY)', '要求日期', '状态', '',
    ]);
    assert.equal(panel().querySelectorAll('tbody tr').length, 5);
    assert.match(text(), /显示 1 至 5，共 7 项/);
    assert.match(text(), /总数量：28/);
    assert.match(text(), /总金额（CNY）/);
    assert.equal(panel().querySelectorAll('select').length, 0, '普通行项目不应显示自创的分类下拉框');
    assert.ok(button(/^筛选$/, panel()));
    assert.ok(button(/^按分类分组$/, panel()));
    assert.ok(panel().querySelector('button[aria-label="更多行项目操作"]'));
    assert.match(text(), /分类汇总/);
    assert.match(text(), /按状态统计/);
    assert.match(text(), /Category A4 项[\s\S]*57\.1%/);
    assert.match(text(), /已确认5 项[\s\S]*71\.4%/);

    const beforeRows = [...panel().querySelectorAll('tbody tr')].map((row) => row.textContent);
    await act(async () => button(/^筛选$/, panel()).click());
    await act(async () => button(/^按分类分组$/, panel()).click());
    assert.deepEqual([...panel().querySelectorAll('tbody tr')].map((row) => row.textContent), beforeRows);

    await act(async () => button(/^下一页$/, panel()).click());
    assert.equal(panel().querySelectorAll('tbody tr').length, 2);
    assert.match(text(), /显示 6 至 7，共 7 项/);
    assert.match(panel().querySelector('tbody')?.textContent ?? '', /SKU-7/);
    await act(async () => setInput(panel().querySelector('input')!, 'Category A'));
    assert.equal(panel().querySelectorAll('tbody tr').length, 4, '搜索后回到第一页');
    assert.match(text(), /显示 1 至 4，共 4 项/);
    assert.equal(reads.filter((path) => path.includes('/api/procurement/workbench')).length, 2, '只保留初始工作台与详情读取');
    assert.equal(requests.length, 0);
  });
});

test('Items replaces Filter with the reference delayed/on-track segmented control only for explicit delayed quantities', async () => {
  const fixture = poPageFixture();
  fixture.context.linesByDocument['po:page'] = [
    { id: 'line:delayed', lineNumber: '10', itemId: 'LATE-1', description: '延期阀门', category: 'Valves', orderedQty: 10, uom: 'EA', unitPrice: 20, status: 'in_production' },
    { id: 'line:ontrack', lineNumber: '20', itemId: 'OK-1', description: '按计划阀门', category: 'Valves', orderedQty: 20, uom: 'EA', unitPrice: 30, status: 'confirmed' },
  ];
  fixture.context.quantityProjections = [
    { poLineId: 'line:delayed', orderedQty: 10, delayedQuantity: 4 },
    { poLineId: 'line:ontrack', orderedQty: 20, delayedQuantity: 0 },
  ];
  await withPoPage({ fixture, tab: 'items' }, async ({ act, button, requests }) => {
    assert.equal(button(/^全部$/, panel()).getAttribute('aria-pressed'), 'true');
    assert.ok(button(/^延期$/, panel()));
    assert.ok(button(/^按计划$/, panel()));
    assert.doesNotMatch(text(), /^筛选$/m);
    await act(async () => button(/^延期$/, panel()).click());
    assert.equal(panel().querySelectorAll('tbody tr').length, 1);
    assert.match(panel().querySelector('tbody')?.textContent ?? '', /延期阀门[\s\S]*延期 4/);
    assert.doesNotMatch(panel().querySelector('tbody')?.textContent ?? '', /按计划阀门/);
    assert.equal(button(/^延期$/, panel()).getAttribute('aria-pressed'), 'true');
    await act(async () => button(/^按计划$/, panel()).click());
    assert.equal(panel().querySelectorAll('tbody tr').length, 1);
    assert.match(panel().querySelector('tbody')?.textContent ?? '', /按计划阀门/);
    assert.equal(requests.length, 0);
  });
});

test('a missing supplier yields one Supplier Information empty card without invented profile/contact fields', async () => {
  const fixture = poPageFixture();
  fixture.context.suppliers = [];
  await withPoPage({ fixture, tab: 'supplier' }, async ({ requests }) => {
    assert.deepEqual([...panel().querySelectorAll('h3')].map((node) => node.textContent), ['供应商信息']);
    assert.match(text(), /暂无供应商详细信息/);
    assert.doesNotMatch(text(), /经营档案|Operating Profile|联系人数|状态未记录|尚未形成供应商结构化确认/);
    assert.equal(requests.length, 0);
  });
});

test('supplier profile system enums render Chinese while unknown and business values stay original', async () => {
  const fixture = poPageFixture();
  const profile = { route: 'local', supplierType: 'manufacturer', productCriticality: 'high', industry: 'Pending', primaryMaterialName: 'Draft', paymentTerms: 'Net 30' };
  Object.assign(fixture.context.poDetail, { supplierProfile: profile });
  await withPoPage({ fixture, tab: 'supplier' }, async ({ realtime, requests }) => {
    for (const [route, supplierType, productCriticality, expected] of [
      ['local', 'manufacturer', 'high', ['本地采购', '制造商', '高']],
      ['import', 'distributor', 'medium', ['进口采购', '分销商', '中']],
      ['unclassified', 'service', 'low', ['未分类', '服务商', '低']],
      ['unclassified', 'other', 'unclassified', ['未分类', '其他', '未分类']],
      ['custom-route', 'custom-type', 'custom-criticality', ['custom-route', 'custom-type', 'custom-criticality']],
    ] as const) {
      Object.assign(profile, { route, supplierType, productCriticality });
      await realtime();
      for (const [index, label] of ['采购路线', '供应商类型', '物料关键程度'].entries()) {
        const field = [...panel().querySelectorAll('div')].find((node) => node.textContent === label);
        assert.equal(field?.nextElementSibling?.textContent, expected[index]);
      }
      assert.match(text(), /行业Pending/);
      assert.match(text(), /主要物料Draft/);
      assert.match(text(), /付款条款Net 30/);
    }
    assert.equal(requests.length, 0);
  });
});

test('empty Documents shows its complete metrics and empty card while required-document gaps stay visible', async () => {
  const fixture = poPageFixture();
  fixture.context.poDetail.documents.requirements.push({ id: 'purchase_order', label: 'Purchase Order', state: 'missing', required: true });
  fixture.context.poDetail.documents.kpis.missing = 1;
  await withPoPage({ fixture, tab: 'documents' }, async ({ requests }) => {
    assert.equal(panel().querySelectorAll('table').length, 0);
    assert.match(text(), /此订单暂无文档/);
    assert.match(text(), /文档总数/);
    assert.match(text(), /已核验文档/);
    assert.match(text(), /待审核/);
    assert.match(text(), /缺失文档/);
    assert.match(panel().querySelector('[role="alert"]')?.textContent ?? '', /缺少必需文档/);
    assert.doesNotMatch(text(), /尚未收到关联发票|尚无经核验的供应商生产|暂无可预览的真实附件/);
    assert.equal(requests.length, 0);
  });
});

test('Documents search composes name and category while unsafe links remain unavailable', async () => {
  const fixture = poPageFixture();
  fixture.context.poDetail.documents.rows.push(
    { id: 'doc:1', name: 'Pending Contract.pdf', category: 'contract', status: 'verified', sizeBytes: 100, url: '/api/documents/1' },
    { id: 'doc:2', name: 'Invoice.pdf', category: 'invoice', status: 'pending', sizeBytes: 200, url: '//untrusted.example/file' },
  );
  fixture.context.poDetail.documents.kpis = { total: 2, verified: 1, pending: 1, missing: 0 };
  await withPoPage({ fixture, tab: 'documents' }, async ({ act, requests }) => {
    const search = panel().querySelector<HTMLInputElement>('input[aria-label="搜索文档"]')!;
    await act(async () => setInput(search, 'contract'));
    assert.equal(panel().querySelectorAll('tbody tr').length, 1);
    assert.match(panel().querySelector('tbody')?.textContent ?? '', /Pending Contract.pdf/);
    await act(async () => setInput(search, 'Invoice'));
    assert.equal(panel().querySelectorAll('tbody tr').length, 1);
    assert.match(panel().querySelector('tbody')?.textContent ?? '', /Invoice.pdf/);
    await act(async () => setInput(search, ''));
    assert.equal(panel().querySelectorAll('tbody tr').length, 2);
    assert.equal(panel().querySelectorAll('tbody a').length, 1, 'protocol-relative URL must never become an authenticated file link');
    assert.equal(panel().querySelector('tbody a')?.getAttribute('href'), '/api/documents/1');
    assert.equal(requests.length, 0);
  });
});

test('Documents non-empty state follows the reference seven-column table, inert controls, search and row detail interaction', async () => {
  const fixture = poPageFixture();
  fixture.context.poDetail.documents.rows.push(
    {
      id: 'doc:contract', name: 'Purchase Contract.pdf', category: 'contract', status: 'verified', verified: true,
      createdBy: 'Buyer Zhang', createdAt: '2026-09-05T01:02:03Z', sizeBytes: 1024,
      contentType: 'application/pdf', url: '/api/documents/contract',
    },
    {
      id: 'doc:invoice', name: 'Commercial Invoice.xlsx', category: 'invoice', status: 'pending', verified: false,
      createdBy: 'Finance Li', createdAt: '2026-09-06T02:03:04Z', sizeBytes: 2048,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  );
  fixture.context.poDetail.documents.kpis = { total: 2, verified: 1, pending: 1, missing: 0 };
  await withPoPage({ fixture, tab: 'documents' }, async ({ act, button, requests }) => {
    assert.deepEqual([...panel().querySelectorAll('th')].map((node) => node.textContent), [
      '文档名称', '分类', '上传人', '上传时间', '状态', '文件大小', '操作',
    ]);
    assert.equal(panel().querySelectorAll('select').length, 0, 'reference Documents controls are enabled inert buttons, not invented filters');
    assert.ok(button(/^筛选$/, panel()));
    assert.ok(button(/^分类$/, panel()));
    const before = [...panel().querySelectorAll('tbody tr')].map((node) => node.textContent);
    await act(async () => button(/^筛选$/, panel()).click());
    await act(async () => button(/^分类$/, panel()).click());
    assert.deepEqual([...panel().querySelectorAll('tbody tr')].map((node) => node.textContent), before);

    const search = panel().querySelector<HTMLInputElement>('input[aria-label="搜索文档"]')!;
    assert.equal(search.disabled, false);
    await act(async () => setInput(search, 'Buyer Zhang'));
    assert.equal(panel().querySelectorAll('tbody tr').length, 1, 'search includes the persisted uploader field');
    assert.match(panel().querySelector('tbody')?.textContent ?? '', /Purchase Contract\.pdf/);
    await act(async () => setInput(search, 'No matching document'));
    assert.equal(panel().querySelectorAll('table').length, 1, 'a non-empty document set keeps the reference table shell when search has no matches');
    assert.equal(panel().querySelectorAll('tbody tr').length, 0);
    assert.match(text(), /显示 1 至 0，共 2 份文档/);

    await act(async () => setInput(search, ''));
    const contractRow = [...panel().querySelectorAll<HTMLTableRowElement>('tbody tr')].find((row) => row.textContent?.includes('Purchase Contract.pdf'))!;
    await act(async () => contractRow.click());
    const detail = panel().querySelector<HTMLElement>('[data-document-detail]');
    assert.ok(detail, 'clicking a row opens the reference document detail column');
    assert.match(detail.textContent ?? '', /Purchase Contract\.pdf/);
    assert.match(detail.textContent ?? '', /分类合同/);
    assert.match(detail.textContent ?? '', /上传人Buyer Zhang/);
    assert.match(detail.textContent ?? '', /文件类型application\/pdf/);
    assert.match(detail.textContent ?? '', /文件大小1\.0 KB/);
    assert.match(detail.textContent ?? '', /状态已核验/);
    assert.equal(detail.querySelector('a')?.getAttribute('href'), '/api/documents/contract');
    await act(async () => detail.querySelector<HTMLButtonElement>('button[aria-label="关闭文档详情"]')!.click());
    assert.equal(panel().querySelector('[data-document-detail]'), null);
    assert.equal(requests.length, 0);
  });
});

test('Documents open links reject browser-normalized cross-origin slash and backslash URLs', async () => {
  const fixture = poPageFixture();
  fixture.context.poDetail.documents.rows.push(
    { id: 'safe', name: 'Safe.txt', url: '/api/documents/safe' },
    { id: 'slash', name: 'Protocol relative.txt', url: '//untrusted.example/file' },
    { id: 'backslash', name: 'Browser normalized.txt', url: '/\\untrusted.example/file' },
    { id: 'absolute', name: 'Absolute.txt', url: 'https://untrusted.example/file' },
  );
  await withPoPage({ fixture, tab: 'documents' }, async () => {
    assert.deepEqual([...panel().querySelectorAll('tbody a')].map((node) => node.getAttribute('href')), ['/api/documents/safe']);
  });
});

test('Documents preserves immutable snapshots and source metadata through the reference table and detail column', async () => {
  const fixture = poPageFixture();
  fixture.context.poDetail.documents.rows.push(
    { id: 'doc:upload', name: 'Pending Original.pdf', category: 'attachment', source: 'stored_attachment', version: 3, securityStatus: 'clean', processingStatus: 'queued', verified: false, status: 'pending', createdBy: 'Draft', updatedAt: '2026-09-06T01:02:03Z', sizeBytes: 1024, url: '/api/documents/upload' },
    { id: 'doc:snapshot', snapshotId: 'snapshot:1', name: 'PO-v2.pdf', category: 'purchase_order', source: 'generated_snapshot', version: 2, templateVersion: 1, securityStatus: null, processingStatus: 'generated', verified: true, status: 'verified', updatedAt: '2026-09-06T01:02:03Z', sizeBytes: 2048, url: '/api/documents/snapshot1' },
    { id: 'doc:snapshot', snapshotId: 'snapshot:2', name: 'PO-v3.pdf', category: 'purchase_order', source: 'generated_snapshot', version: 3, templateVersion: 1, securityStatus: null, processingStatus: 'generated', verified: true, status: 'verified', updatedAt: '2026-09-06T02:02:03Z', sizeBytes: 2048, url: '/api/documents/snapshot2' },
    { id: 'doc:legacy', name: 'Supplier Original.txt', category: 'Custom Category', source: 'attachment_reference', securityStatus: null, processingStatus: null, verified: false, status: 'pending' },
  );
  await withPoPage({ fixture, tab: 'documents' }, async ({ act, requests }) => {
    assert.deepEqual([...panel().querySelectorAll('th')].map((node) => node.textContent), ['文档名称', '分类', '上传人', '上传时间', '状态', '文件大小', '操作']);
    const rows = [...panel().querySelectorAll('tbody tr')];
    assert.equal(rows.length, 4, '同一逻辑文档的不可变快照分别呈现');
    const cells = (row: Element) => [...row.querySelectorAll('td')].map((node) => node.textContent);
    assert.match(cells(rows[0]!)[0]!, /Pending Original.pdf/);
    assert.equal(cells(rows[0]!)[2], 'Draft');
    assert.equal(cells(rows[0]!)[4], '待审核');
    assert.equal(cells(rows[0]!)[5], '1.0 KB');
    assert.equal(cells(rows[1]!)[4], '已核验');
    assert.equal(rows[2]!.querySelector('a')?.getAttribute('href'), '/api/documents/snapshot2');
    assert.equal(cells(rows[3]!)[1], 'Custom Category');
    assert.equal(cells(rows[3]!)[2], '—');
    assert.equal(cells(rows[3]!)[3], '—');
    assert.equal(cells(rows[3]!)[5], '大小未提供');
    await act(async () => rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const detail = panel().querySelector('[data-document-detail]')!;
    assert.match(detail.textContent ?? '', /Pending Original.pdf/);
    assert.match(detail.textContent ?? '', /上传人Draft/);
    assert.match(detail.textContent ?? '', /状态待审核/);
    assert.equal(requests.length, 0);
  });
});

test('History places events in the main column and authoritative PO details/stages in the aside', async () => {
  await withPoPage({ tab: 'history' }, async () => {
    const aside = panel().querySelector('aside');
    assert.ok(aside, 'the stage timeline must not precede the main history feed');
    assert.match(aside.textContent ?? '', /采购订单详情/);
    assert.match(aside.textContent ?? '', /PO-PAGE/);
    assert.match(aside.textContent ?? '', /当前阶段/);
    assert.match(text(), /暂无历史记录/);
    assert.ok(panel().querySelector('h3')?.textContent === '历史时间线');
  });
});

test('Documents leaves an unsupported verified claim unknown and does not infer verification from parser labels', async () => {
  const fixture = poPageFixture();
  const row = { id: 'legacy:verified', name: 'Legacy Original.pdf', status: 'verified', securityStatus: 'clean', processingStatus: 'parse_failed' };
  fixture.context.poDetail.documents.rows.push(row);
  await withPoPage({ fixture, tab: 'documents' }, async ({ realtime }) => {
    assert.equal(panel().querySelector('tbody tr')?.querySelectorAll('td')[4]?.textContent, '—', 'legacy status cannot prove current verification facts');
    for (const state of ['parse_failed', 'needs_ocr', 'needs_specialist', 'custom-parser']) {
      row.processingStatus = state!;
      await realtime();
      assert.equal(panel().querySelector('tbody tr')?.querySelectorAll('td')[4]?.textContent, '—');
    }
  });
});

test('legacy History keeps every event when actor or summary resembles an amendment code', async () => {
  const fixture = poPageFixture();
  Object.assign(fixture.context, { activities: [
    { id: 'real:amendment', action: 'purchase_order_amendment_applied', actor: null, summary: 'Actual amendment record', at: '2026-09-06T03:00:00Z' },
    { id: 'other:review', action: 'po.reviewed', actor: 'purchase_order_amendment_fake_actor', summary: 'Review only', at: '2026-09-06T02:00:00Z' },
  ] });
  let hasSelect = false;
  let rendered = '';
  await withPoPage({ fixture, tab: 'history' }, async () => {
    hasSelect = panel().querySelector('select') !== null;
    rendered = text();
  });
  assert.equal(hasSelect, false);
  assert.match(rendered, /Actual amendment record/);
  assert.match(rendered, /Review only|purchase_order_amendment_fake_actor/);
});

test('History renders Chinese event types and original summaries while reference buttons remain inert', async () => {
  const fixture = poPageFixture();
  fixture.context.poDetail.history.events = [
    { id: 'amendment:applied', type: 'purchase_order_amendment_applied', typeLabel: '采购订单修改', label: '采购订单修改（已应用）', source: 'amendment', state: 'applied', actor: 'Draft', summary: 'Pending supplier wording', at: '2026-09-06T03:00:00Z' },
    { id: 'outbox:pending', type: 'purchase_order_followup', typeLabel: '采购订单跟进', label: '采购订单跟进（待处理）', source: 'outbox', state: 'pending', actor: null, summary: null, at: '2026-09-06T02:00:00Z' },
    { id: 'custom:event', type: 'custom', typeLabel: 'custom', label: 'custom', source: 'activity', state: null, actor: 'Supplier', summary: 'amendment is just supplier text', at: '2026-09-06T01:00:00Z' },
  ];
  let hasSelect = false;
  let controlNames: string[] = [];
  await withPoPage({ fixture, tab: 'history' }, async ({ act, requests }) => {
    assert.match(text(), /采购订单修改（已应用）/);
    assert.match(text(), /Draft · 采购订单修改/);
    assert.match(text(), /Pending supplier wording/);
    assert.match(text(), /采购订单跟进（待处理）/);
    assert.match(text(), /— · 采购订单跟进/, 'an unrecorded actor must not be invented as the system');
    assert.doesNotMatch(text(), /purchase_order_amendment|purchase_order_followup/);
    assert.match(text(), /amendment is just supplier text/);
    hasSelect = panel().querySelector('select') !== null;
    const controls = [...panel().querySelectorAll<HTMLButtonElement>('button')]
      .filter((entry) => ['筛选', '全部活动'].includes(entry.textContent?.trim() ?? ''));
    controlNames = controls.map((entry) => entry.textContent?.trim() ?? '');
    for (const control of controls) await act(async () => control.click());
    assert.match(text(), /Pending supplier wording/);
    assert.match(text(), /采购订单跟进（待处理）|amendment is just supplier text/);
    assert.match(text(), /amendment is just supplier text/);
    assert.equal(requests.length, 0);
  });
  assert.equal(hasSelect, false);
  assert.deepEqual(controlNames, ['筛选', '全部活动']);
});

test('History keys equal raw event ids by source so every persisted event remains visible', async () => {
  const fixture = poPageFixture();
  fixture.context.poDetail.history.events = [
    { id: 'shared:event', type: 'supplier_difference_received', typeLabel: '收到供应商差异', label: '阶段事件原文', source: 'stage', state: 'blocked', actor: 'connector:email', summary: 'Stage source note', at: '2026-09-06T03:00:00Z' },
    { id: 'shared:event', type: 'route_assigned', typeLabel: '采购路径分配', label: '路径事件原文', source: 'route', state: null, actor: 'human:buyer', summary: 'Route source note', at: '2026-09-06T02:00:00Z' },
  ];
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(' ')); };
  try {
    await withPoPage({ fixture, tab: 'history' }, async () => {
      assert.match(text(), /阶段事件原文/);
      assert.match(text(), /路径事件原文/);
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.some((message) => /same key|unique "key"/i.test(message)), false, errors.join('\n'));
});

test('Communication starts with persisted channel metrics, keeps the conversation and details columns, and threads remain navigable', async () => {
  const fixture = poPageFixture();
  Object.assign(fixture.context.poDetail, { communication: {
    kpis: { total: 2, outbound: 1, inbound: 1, pendingDrafts: 0 },
    messages: [
      { id: 'mail:1', direction: 'outbound', channel: 'email', subject: 'Pending supplier reply', body: 'Original English business content', messageId: 'thread:a', createdAt: '2026-09-06T00:00:00Z' },
      { id: 'mail:2', direction: 'inbound', channel: 'wechat', subject: 'Received response', body: '第二段业务正文', messageId: 'thread:b', receivedAt: '2026-09-06T01:00:00Z' },
    ],
    relatedThreads: [{ id: 'thread:a', subject: 'Pending supplier reply', messageCount: 1 }, { id: 'thread:b', subject: 'Received response', messageCount: 1 }],
  } });
  await withPoPage({ fixture, tab: 'communication', fetch(path) {
    if (path.startsWith('/api/po/chat?')) return jsonResponse({ conversation: null, messages: [], permissions: { operate: true } });
  } }, async ({ act, button, requests }) => {
    assert.equal(panel().firstElementChild?.firstElementChild?.getAttribute('aria-label'), '沟通统计');
    assert.match(panel().querySelector('aside')?.textContent ?? '', /沟通详情/);
    assert.match(panel().querySelector('aside')?.textContent ?? '', /消息总数2/);
    assert.equal(panel().querySelectorAll('[data-po-message]').length, 2);
    await act(async () => button(/Pending supplier reply/, panel().querySelector('[aria-label="相关线程"]')!).click());
    assert.equal(panel().querySelectorAll('[data-po-message]').length, 1);
    assert.match(panel().querySelector('[data-po-message]')?.textContent ?? '', /Original English business content/);
    await act(async () => button(/^全部消息$/, panel()).click());
    assert.equal(panel().querySelectorAll('[data-po-message]').length, 2);
    assert.equal(requests.length, 0);
  });
});
