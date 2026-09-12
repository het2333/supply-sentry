import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { literalNineDomainV2Draft } from '../features/procurement/advanced-sla-test-fixtures.js';

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://readywork.test/' });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLAnchorElement: dom.window.HTMLAnchorElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter, Element: dom.window.Element,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) { previous.set(key, (globalThis as Record<string, unknown>)[key]); (globalThis as Record<string, unknown>)[key] = value; }
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined });
  return { host: dom.window.document.querySelector<HTMLDivElement>('#root')!, restore: () => { for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value; dom.window.close(); } };
}

function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

async function withReadonlyFixture(run: () => Promise<void>, localize = false, configureDraft?: (draft: typeof literalNineDomainV2Draft) => void, configure = true) {
  const { host, restore } = installDom(); const originalFetch = globalThis.fetch;
  const draft = structuredClone(literalNineDomainV2Draft);
  const first = draft.sections[0]!.rules[0]!;
  first.ruleId = 'Pending'; first.name = 'Supplier'; first.companyCode = 'Pending'; first.notes = 'Supplier';
  Object.assign(first.parameters, { supplierName: 'Supplier', itemCategory: 'Pending', milestoneName: 'Supplier', standardDuration: 48 });
  configureDraft?.(draft);
  const mutations: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') mutations.push(`${init.method} ${String(input)}`);
    return json({ domains: draft.sections.map(section => ({ id: section.domain })), profiles: [draft], draftProfiles: [draft], publishedProfile: null, runtimeControl: null, importHistory: [], recentEvents: [], permissions: { read: true, configure, approve: true }, readiness: { baseSlaPublished: false, communicationIdentityActive: false, emailConnected: false, whatsappConnected: false }, impactPreview: { candidateType: 'profile', candidateId: draft.id, candidateVersion: 4, profileId: draft.id, profileVersion: 4, activePurchaseOrders: 0, matchedPurchaseOrders: 0 } });
  }) as typeof fetch;
  const { act } = await import('react'); const { createRoot } = await import('react-dom/client');
  const { ProcurementAdvancedSlaWorkbench } = await import('../features/procurement/advanced-sla-workbench.js');
  const { ChineseUiLocalization } = await import('../features/localization/chinese-ui-localization.js');
  const root = createRoot(host); (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => { root.render(<>{localize && <ChineseUiLocalization />}<ProcurementAdvancedSlaWorkbench /></>); await wait(); await wait(); });
    await run(); assert.deepEqual(mutations, [], 'opening, reading and cancelling rules must not write');
  } finally { await act(async () => root.unmount()); await wait(); globalThis.fetch = originalFetch; restore(); }
}

test('all nine Advanced SLA rule editors render source-Chinese fields while retaining canonical option values', async () => {
  const { act } = await import('react');
  await withReadonlyFixture(async () => {
    const sections = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="服务等级规则域"] button')];
    assert.deepEqual(sections.map(x => x.textContent?.trim()), ['生产／服务里程碑', '沟通与升级规则', '付款条款规则', '物流规划规则', '物流交接要求', '在途监控规则', '监管与进口审批规则', '清关规则', '质量检验与收货规则']);
    const samples = ['里程碑名称 *', '首次响应时限 *', '付款条款 *', '国际贸易术语 *', '文件／信息名称 *', '标准运输时长 *', '目的国家／地区 *', '目的国家／地区 *', '检验类型'];
    for (let i = 0; i < sections.length; i++) {
      await act(async () => { sections[i]!.click(); await wait(); });
      const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent?.trim() === '添加规则')!;
      add.focus();
      await act(async () => { add.click(); await wait(); });
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      assert.ok(dialog.querySelector(`[aria-label="${samples[i]}"]`), `domain ${i} translated label`);
      assert.ok(dialog.querySelector('[aria-label="规则 ID *"]'));
      if (i === 2) { const select = dialog.querySelector<HTMLSelectElement>('[aria-label="付款条款 *"]')!; assert.equal([...select.options].find(x=>x.value==='Letter of Credit (LC)')?.textContent, '信用证（LC）'); }
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(); });
      assert.equal(document.activeElement === add, true, `domain ${i} returns focus to Add Rule`);
    }
  });
});

test('Advanced SLA legacy durations keep their hour units and never use update cadence as transit duration', async () => {
  const { act } = await import('react');
  await withReadonlyFixture(async () => {
    const sections = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="服务等级规则域"] button')];
    for (const [domain, column, expected] of [[2, 2, '24 小时'], [3, 4, '72 小时'], [5, 3, '—'], [6, 4, '48 小时'], [7, 1, '48 小时'], [8, 2, '24 小时'], [8, 4, '8 小时']] as const) {
      await act(async () => { sections[domain]!.click(); await wait(); });
      assert.equal(document.querySelector<HTMLTableRowElement>('tbody tr')!.cells[column]!.textContent, expected, `domain ${domain}, column ${column}`);
    }
  });
});

test('Advanced SLA table localizes typed enums and explicit duration units without translating free text', async () => {
  const { act } = await import('react');
  await withReadonlyFixture(async () => {
    const sections = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="服务等级规则域"] button')];
    const cells = () => [...document.querySelector<HTMLTableRowElement>('tbody tr')!.cells].map(x=>x.textContent);
    assert.deepEqual(cells().slice(0, 5), ['Supplier', 'Pending', 'Supplier', '是', '48 工作日']);
    await act(async () => { sections[1]!.click(); await wait(); });
    assert.deepEqual(cells().slice(1, 6), ['文件待处理', '2', '天', '邮件', '高']);
    await act(async () => { sections[2]!.click(); await wait(); });
    assert.deepEqual(cells().slice(0, 3), ['30 天账期', 'GRN', '0 小时']);
    await act(async () => { sections[3]!.click(); await wait(); });
    assert.deepEqual(cells().slice(1, 5), ['海运', '供应商', 'Pending', '3']);
    await act(async () => { sections[5]!.click(); await wait(); });
    assert.equal(cells()[3], '6 天');
  }, true, draft => {
    const params = (i: number) => draft.sections[i]!.rules[0]!.parameters;
    Object.assign(params(0), { blockingMilestone: 'Yes', durationType: 'Working Days' });
    Object.assign(params(1), { eventType: 'Document Pending', initialResponseSla: 2, slaUnit: 'Days', communicationChannel: 'Email', riskAtEscalation: 'High' });
    Object.assign(params(2), { preparationLeadTime: 0, leadTimeUnit: 'Hours' });
    Object.assign(params(3), { transportMode: 'Sea', freightBookingOwner: 'Supplier', responsibleFunction: 'Pending', freightPlanningLeadTime: 3 });
    Object.assign(params(5), { standardTransitTime: 6, transitTimeUnit: 'Days' });
  });
});

test('Advanced SLA read-only users can inspect details but cannot edit, deactivate or delete rules', async () => {
  const { act } = await import('react');
  await withReadonlyFixture(async () => {
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="编辑规则"]')!.disabled, true);
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click(); await wait(); });
    const menu = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    assert.deepEqual(menu.map(x=>[x.textContent, x.disabled]), [['查看详情', false], ['编辑规则', true], ['停用', true], ['删除', true]]);
    await act(async () => { for (const item of menu.slice(1)) item.click(); await wait(); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => { menu[0]!.click(); await wait(); });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].filter(x=>['编辑','停用','删除'].includes(x.textContent ?? ''));
    assert.deepEqual(buttons.map(x=>[x.textContent, x.disabled]), [['删除', true], ['停用', true], ['编辑', true]]);
    await act(async () => { for (const button of buttons) button.click(); await wait(); });
    assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, 'Pending');
  }, false, undefined, false);
});

test('Advanced SLA More menu supports keyboard navigation and restores focus after Escape or details', async () => {
  const { act } = await import('react');
  await withReadonlyFixture(async () => {
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!; trigger.focus();
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(); });
    assert.equal(document.activeElement?.textContent, '查看详情');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); await wait(); });
    assert.equal(document.activeElement?.textContent, '删除');
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(); });
    assert.equal(document.activeElement?.textContent, '查看详情');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(); });
    assert.equal(document.querySelector('[role="menu"]'), null); assert.equal(document.activeElement === trigger, true);
    await act(async () => { trigger.click(); await wait(); });
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); await wait(); });
    assert.ok(document.querySelector('[role="dialog"]'));
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(); });
    assert.equal(document.activeElement === trigger, true);
  });
});

test('Advanced SLA prevents duplicate saves and dialog dismissal while pending, then retains input after 409', async () => {
  const { act } = await import('react');
  await withReadonlyFixture(async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<Record<string, unknown>> = [];
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') { requests.push(JSON.parse(String(init.body))); return pending; }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="编辑规则"]')!.click(); await wait(); });
      const input = document.querySelector<HTMLInputElement>('[aria-label="规则 ID *"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Pending-edited');
        input.dispatchEvent(new Event('input', { bubbles: true })); await wait();
      });
      const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(x=>x.textContent==='保存规则')!;
      assert.equal(save.disabled, false);
      await act(async () => { save.click(); save.click(); await wait(); });
      assert.equal(requests.length, 1, 'same-tick double click issues one PATCH');
      assert.equal(save.disabled, true); assert.equal(input.disabled, true);
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="关闭"]')!.click(); await wait(); });
      assert.ok(document.querySelector('[role="dialog"]'), 'pending save cannot be dismissed');
      await act(async () => { release(json({ error: '版本冲突', currentVersion: 5 }, 409)); await wait(); await wait(); });
      assert.ok(document.querySelector('[role="dialog"]'));
      assert.equal(input.value, 'Pending-edited'); assert.equal(input.disabled, false);
      assert.match(document.body.textContent ?? '', /版本冲突/);
      assert.equal(requests[0]!.expectedVersion, 4);
      assert.equal((requests[0]!.sections as Array<{rules: Array<{ruleId: string}>}>)[0]!.rules[0]!.ruleId, 'Pending-edited');
    } finally { release(json({error:'版本冲突'},409)); await act(async()=>{await wait();}); globalThis.fetch = originalFetch; }
  }, false, draft => { for (const section of draft.sections) for (const rule of section.rules) rule.status = 'active'; });
});

test('Advanced SLA business table cells and rule detail facts survive the installed global translator', async () => {
  const { act } = await import('react');
  await withReadonlyFixture(async () => {
    const row = document.querySelector<HTMLTableRowElement>('tbody tr')!;
    assert.equal(row.cells[0]!.textContent, 'Supplier'); assert.equal(row.cells[1]!.textContent, 'Pending');
    assert.equal(row.cells[5]!.textContent, 'Pending'); assert.equal(row.cells[6]!.textContent, '草稿');
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!.click(); await wait(); });
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(x=>x.textContent==='查看详情')!.click(); await wait(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(dialog.querySelector('h2')?.textContent, 'Pending');
    const fact = (label: string) => [...dialog.querySelectorAll('dt')].find(x=>x.textContent===label)?.nextElementSibling?.textContent;
    assert.equal(fact('公司代码'), 'Pending'); assert.equal(fact('备注'), 'Supplier'); assert.equal(fact('物料类别'), 'Pending');
  }, true);
});

test('Advanced SLA v2 workbench aligns click, keyboard, focus, CSV validation, apply and refresh behavior', async () => {
  const { host, restore } = installDom(); const originalFetch = globalThis.fetch; const originalCreate = URL.createObjectURL; const originalRevoke = URL.revokeObjectURL;
  let root: { unmount: () => void } | undefined; let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let draft = structuredClone(literalNineDomainV2Draft) as any; let importHistory: any[] = []; const mutations: Array<{ path: string; body: Record<string, unknown> }> = []; let downloaded = '';
  const hash = 'a'.repeat(64);
  const impact = { candidateType: 'import', candidateId: 'advanced-sla-import:ui', candidateVersion: 1, profileId: draft.id, profileVersion: 4, activePurchaseOrders: 4, matchedPurchaseOrders: 2 };
  const preview = { id: 'advanced-sla-import:ui', profileId: draft.id, profileVersion: 4, version: 1, sourceName: 'planning.csv', status: 'previewed', schemaVersion: 2, templateVersion: 2, domain: 'logistics_planning', sourceSha256: hash, candidateHash: hash, totalCount: 2, validCount: 1, invalidCount: 1, warningCount: 0, validationResults: [{ rowNumber: 3, normalizedRuleId: 'bad-row', severity: 'error', field: 'priority', code: 'INVALID_TOO_SMALL', message: 'priority must be at least 1' }], validatedAt: '2026-09-03T04:00:00.000Z', createdAt: '2026-09-03T04:00:00.000Z', updatedAt: '2026-09-03T04:00:00.000Z', appliedAt: null, appliedBy: null, createdBy: 'human:manager', summary: { totalRows: 2, validRows: 1, invalidRows: 1, warnings: 0 }, error: null, impactPreview: impact };
  const dashboard = () => ({ domains: draft.sections.map((section: any) => ({ id: section.domain })), profiles: [draft], draftProfiles: [draft], publishedProfile: null, runtimeControl: null, importHistory, permissions: { read: true, configure: true, approve: true }, readiness: { baseSlaPublished: false, communicationIdentityActive: false, emailConnected: false, whatsappConnected: false }, impactPreview: { candidateType: 'profile', candidateId: draft.id, candidateVersion: draft.version, profileId: draft.id, profileVersion: draft.version, activePurchaseOrders: 4, matchedPurchaseOrders: 1 }, recentEvents: [] });
  URL.createObjectURL = () => 'blob:advanced-sla'; URL.revokeObjectURL = () => undefined;
  const anchorClick = window.HTMLAnchorElement.prototype.click; window.HTMLAnchorElement.prototype.click = function click() { downloaded = this.download; };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/procurement/advanced-sla' && (!init?.method || init.method === 'GET')) return json(dashboard());
    if (path === '/api/procurement/advanced-sla/templates/logistics_planning') return new Response('# schema_version=2\nschema_version,rule_id\n', { headers: { 'content-type': 'text/csv' } });
    if (path === '/api/procurement/advanced-sla/imports/preview' && init?.method === 'POST') { const body = JSON.parse(String(init.body)); mutations.push({ path, body }); return json({ item: preview }, 201); }
    if (path === `/api/procurement/advanced-sla/profiles/${encodeURIComponent(draft.id)}` && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)); mutations.push({ path, body }); draft = { ...draft, ...body, version: draft.version + 1 }; return json({ item: draft });
    }
    if (path === `/api/procurement/advanced-sla/imports/${encodeURIComponent(preview.id)}/apply` && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); mutations.push({ path, body }); draft = { ...draft, version: 5 }; const batch = { ...preview, version: 2, status: 'applied', appliedBy: 'human:manager', appliedAt: '2026-09-03T04:01:00.000Z', updatedAt: '2026-09-03T04:01:00.000Z' }; importHistory = [batch]; return json({ item: draft, batch, impactPreview: impact, replayed: false });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import('react'); runAct = act; const { createRoot } = await import('react-dom/client'); const { ProcurementAdvancedSlaWorkbench } = await import('../features/procurement/advanced-sla-workbench.js');
    await act(async () => { const rendered = createRoot(host); root = rendered; rendered.render(<ProcurementAdvancedSlaWorkbench />); await wait(); await wait(); });
    assert.match(document.body.textContent ?? '', /高级服务等级设置/); assert.equal(document.querySelectorAll('[aria-label="服务等级规则域"] button').length, 9);
    assert.deepEqual(['刷新', '保存草稿', '发布'].map((label) => [...document.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent?.trim() === label)), [false, false, false]);

    const planning = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="服务等级规则域"] button')].find((button) => button.textContent?.includes('物流规划规则'))!;
    await act(async () => { planning.click(); await wait(); }); assert.match(document.querySelector('h2')?.textContent ?? '', /物流规划规则/);
    const template = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '模板')!;
    await act(async () => { template.click(); await wait(); }); assert.equal(downloaded, 'logistics_planning-advanced-sla-v2.csv');

    const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加规则')!; add.focus();
    await act(async () => { add.click(); await wait(); }); let dialog = document.querySelector<HTMLElement>('[role="dialog"]')!; assert.ok(dialog); assert.match(dialog.textContent ?? '', /公司代码/); assert.match(dialog.textContent ?? '', /业务单元/); assert.match(dialog.textContent ?? '', /生效日期/); assert.ok(dialog.querySelector('[aria-label="规则 ID *"]')); assert.equal(document.activeElement, dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]'));
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(); }); assert.equal(document.activeElement, add);

    const payment = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="服务等级规则域"] button')].find((button) => button.textContent?.includes('付款条款规则'))!;
    await act(async () => { payment.click(); await wait(); });
    const addPayment = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '添加规则')!; addPayment.focus();
    await act(async () => { addPayment.click(); await wait(); }); dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(dialog.querySelector<HTMLSelectElement>('[aria-label="付款条款 *"]')); assert.equal(dialog.querySelector('[aria-label="信用证类型"]'), null);
    const paymentTerm = dialog.querySelector<HTMLSelectElement>('[aria-label="付款条款 *"]')!;
    await act(async () => { paymentTerm.value = 'Letter of Credit (LC)'; paymentTerm.dispatchEvent(new Event('change', { bubbles: true })); await wait(); });
    assert.ok(document.querySelector('[aria-label="信用证类型"]')); assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /信用证明细/);
    const editableRuleId = document.querySelector<HTMLInputElement>('[aria-label="规则 ID *"]')!; assert.equal(editableRuleId.disabled, false);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(); }); assert.equal(document.activeElement, addPayment);
    await act(async () => { planning.click(); await wait(); });

    const upload = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '上传 CSV')!; upload.focus();
    await act(async () => { upload.click(); await wait(); }); dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const fileInput = dialog.querySelector<HTMLInputElement>('input[type=file]')!; const file = { name: 'planning.csv', text: async () => 'schema_version,rule_id\n2,ok' };
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
    await act(async () => { fileInput.dispatchEvent(new Event('change', { bubbles: true })); await wait(); await wait(); });
    assert.match(dialog.textContent ?? '', /2总行数/); assert.match(dialog.textContent ?? '', /1无效行数/);
    const openValidation = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '打开验证结果')!;
    await act(async () => { openValidation.click(); await wait(); }); assert.equal(document.querySelector('[role="dialog"]'), null); assert.match(document.body.textContent ?? '', /INVALID_TOO_SMALL/);

    await act(async () => { upload.click(); await wait(); }); dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const inputAgain = dialog.querySelector<HTMLInputElement>('input[type=file]')!; Object.defineProperty(inputAgain, 'files', { configurable: true, value: [file] });
    await act(async () => { inputAgain.dispatchEvent(new Event('change', { bubbles: true })); await wait(); await wait(); });
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '导入 1 条有效行')!.click(); await wait(); await wait(); });
    assert.deepEqual(mutations[0]!.body, { domain: 'logistics_planning', sourceName: 'planning.csv', profileId: literalNineDomainV2Draft.id, expectedVersion: 4, csv: 'schema_version,rule_id\n2,ok' });
    assert.deepEqual(mutations.at(-1)!.body, { expectedBatchVersion: 1, expectedProfileVersion: 4, expectedCandidateHash: hash });
    assert.equal(document.querySelector('[role="dialog"]'), null); assert.match(document.body.textContent ?? '', /CSV 应用已持久化/);
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.trim().startsWith('规则'))!.click(); await wait(); });

    let more = document.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!;
    await act(async () => { more.click(); await wait(); });
    let menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    assert.deepEqual([...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim()), ['查看详情', '编辑规则', '停用', '删除']);
    const viewDetails = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === '查看详情')!;
    await act(async () => { viewDetails.click(); await wait(); }); dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /rule-4/); assert.deepEqual([...dialog.querySelectorAll<HTMLButtonElement>('button')].filter((button) => ['删除', '停用', '编辑'].includes(button.textContent?.trim() ?? '')).map((button) => button.textContent?.trim()), ['删除', '停用', '编辑']);
    const detail删除 = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '删除')!;
    await act(async () => { detail删除.click(); await wait(); });
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1); assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /删除规则？/);
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === '取消')!.click(); await wait(); });
    assert.equal(document.querySelector('[role="dialog"]'), null); assert.match(document.body.textContent ?? '', /rule-4/);

    more = document.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!; await act(async () => { more.click(); await wait(); }); menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const mutationsBefore停用 = mutations.length;
    await act(async () => { [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === '停用')!.click(); await wait(); await wait(); });
    assert.equal(mutations.length, mutationsBefore停用 + 1); assert.equal(mutations.at(-1)!.body['expectedVersion'], 5);
    assert.match(document.body.textContent ?? '', /停用/); assert.doesNotMatch(document.body.textContent ?? '', /有未保存的本地修改/);
    more = document.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!; await act(async () => { more.click(); await wait(); }); menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    await act(async () => { [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.trim() === '删除')!.click(); await wait(); });
    const mutationsBefore删除 = mutations.length;
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === '删除')!.click(); await wait(); await wait(); });
    assert.equal(mutations.length, mutationsBefore删除 + 1); assert.equal(mutations.at(-1)!.body['expectedVersion'], 6);
    assert.doesNotMatch(document.body.textContent ?? '', /rule-4/);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); }); await wait(); globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; window.HTMLAnchorElement.prototype.click = anchorClick; restore();
  }
});

test('Advanced SLA keeps a pending CSV apply modal open, prevents duplicate writes, and retains the candidate after 409', async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  const draft = structuredClone(literalNineDomainV2Draft);
  const hash = 'b'.repeat(64);
  const preview = {
    id: 'advanced-sla-import:pending-ui',
    profileId: draft.id,
    profileVersion: draft.version,
    version: 1,
    status: 'previewed',
    schemaVersion: 2,
    templateVersion: 2,
    domain: 'production_service_milestones',
    sourceName: 'pending.csv',
    sourceSha256: hash,
    candidateHash: hash,
    totalCount: 1,
    validCount: 1,
    invalidCount: 0,
    warningCount: 0,
    validationResults: [],
    validatedAt: '2026-09-06T06:00:00.000Z',
    createdAt: '2026-09-06T06:00:00.000Z',
    summary: { totalRows: 1, validRows: 1, invalidRows: 0, warnings: 0 },
    impactPreview: {
      candidateType: 'import',
      candidateId: 'advanced-sla-import:pending-ui',
      candidateVersion: 1,
      profileId: draft.id,
      profileVersion: draft.version,
      activePurchaseOrders: 3,
      matchedPurchaseOrders: 1,
    },
  };
  const dashboard = {
    domains: draft.sections.map((section) => ({ id: section.domain })),
    profiles: [draft],
    draftProfiles: [draft],
    publishedProfile: null,
    runtimeControl: null,
    importHistory: [],
    recentEvents: [],
    permissions: { read: true, configure: true, approve: true },
    readiness: { baseSlaPublished: false, communicationIdentityActive: false, emailConnected: false, whatsappConnected: false },
    impactPreview: { candidateType: 'profile', candidateId: draft.id, candidateVersion: draft.version, profileId: draft.id, profileVersion: draft.version, activePurchaseOrders: 3, matchedPurchaseOrders: 1 },
  };
  let releaseApply!: (response: Response) => void;
  const pendingApply = new Promise<Response>((resolve) => { releaseApply = resolve; });
  let applyRequests = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/procurement/advanced-sla' && (!init?.method || init.method === 'GET')) return json(dashboard);
    if (path === '/api/procurement/advanced-sla/imports/preview' && init?.method === 'POST') return json({ item: preview }, 201);
    if (path === `/api/procurement/advanced-sla/imports/${encodeURIComponent(preview.id)}/apply` && init?.method === 'POST') {
      applyRequests += 1;
      return pendingApply;
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  try {
    const { act } = await import('react');
    runAct = act;
    const { createRoot } = await import('react-dom/client');
    const { ProcurementAdvancedSlaWorkbench } = await import('../features/procurement/advanced-sla-workbench.js');
    await act(async () => { root = createRoot(host); root.render(<ProcurementAdvancedSlaWorkbench />); await wait(); await wait(); });
    const upload = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '上传 CSV')!;
    await act(async () => { upload.click(); await wait(); });
    let dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [{ name: 'pending.csv', text: async () => 'schema_version,rule_id\n2,PENDING-1' }] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await wait(); await wait(); });
    const apply = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === '导入 1 条有效行')!;
    await act(async () => { apply.click(); apply.click(); await wait(); });
    assert.equal(applyRequests, 1);
    assert.equal(apply.disabled, true);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(); });
    dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(dialog, 'pending CSV apply must not close on Escape');
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click(); await wait(); });
    assert.ok(document.querySelector('[role="dialog"]'), 'pending CSV apply must not close from the close button');
    await act(async () => { releaseApply(json({ error: '服务器版本已变化', code: 'VERSION_CONFLICT', currentVersion: draft.version + 1 }, 409)); await wait(); await wait(); });
    dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /pending\.csv/);
    assert.match(document.body.textContent ?? '', /服务器版本已变化/);
  } finally {
    releaseApply(json({ error: '服务器版本已变化' }, 409));
    if (runAct) await runAct(async () => root?.unmount());
    await wait();
    globalThis.fetch = originalFetch;
    restore();
  }
});
