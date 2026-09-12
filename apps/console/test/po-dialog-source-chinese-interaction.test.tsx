import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deferredResponse, jsonResponse, poPageFixture, withPoPage } from './helpers/po-page-harness.js';

function field(scope: ParentNode, label: string) {
  const wrapper = [...scope.querySelectorAll('label')].find((node) => node.firstElementChild?.textContent === label);
  const control = wrapper?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea');
  assert.ok(control, `missing Chinese field: ${label}`);
  return control;
}

function change(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')!.set!.call(control, value);
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

test('Chinese Edit PO controls preserve API enum values, input and conflict feedback without the localization observer', async () => {
  const fixture = poPageFixture('draft', 'po_sent');
  fixture.context.stageTimeline[0]!.label = 'PO Sent';
  fixture.context.suppliers[0]!.name = 'Draft';
  Object.assign(fixture.context.suppliers[0]!, { contacts: [{ id: 'contact:page', name: 'Pending', email: 'buyer@example.test', primary: true }] });
  const pending = deferredResponse();
  await withPoPage({ fixture, fetch(path) {
    if (path === '/api/procurement/execution/edit_po') return pending.promise;
  } }, async ({ act, button, requests }) => {
    await act(async () => button(/^操作$/).click());
    await act(async () => button(/^编辑采购订单$/).click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(dialog.querySelector('h2')?.textContent, '编辑采购订单');
    assert.equal(field(dialog, '供应商名称').value, 'supplier:page');
    assert.equal(field(dialog, '供应商邮箱').value, 'buyer@example.test');
    assert.match(field(dialog, '联系人').textContent ?? '', /未选择联系人Pending/);
    assert.equal(field(dialog, '阶段（只读）').value, '采购订单发送');
    assert.equal(field(dialog, '状态（只读）').value, 'PO 草稿');
    assert.deepEqual([...field(dialog, '物料类型').querySelectorAll('option')].map((node) => [node.value, node.textContent]), [['direct', '直接物料'], ['indirect', '间接物料']]);
    assert.equal(button(/^保存修改$/, dialog).disabled, true);
    await act(async () => {
      change(field(dialog, '要求到货日'), '2026-09-25');
      change(field(dialog, '物料类型'), 'indirect');
      change(field(dialog, '修改原因'), 'Keep this reason in English');
    });
    await act(async () => button(/^保存修改$/, dialog).click());
    assert.equal(button(/^正在保存…$/, dialog).disabled, true);
    assert.deepEqual(requests[0]?.body, { aggregateId: 'po:page', expectedVersion: 4, reason: 'Keep this reason in English', patch: { requiredInHouseAt: '2026-09-25', materialType: 'indirect' } });
    assert.match(requests[0]?.key ?? '', /^web-po:edit:/);
    await act(async () => pending.resolve(jsonResponse({ error: '版本冲突', currentVersion: 7 }, 409)));
    assert.match(dialog.querySelector('[role="status"]')?.textContent ?? '', /服务器当前版本为 7/);
    assert.equal(field(dialog, '要求到货日').value, '2026-09-25');
    assert.equal(field(dialog, '修改原因').value, 'Keep this reason in English');
    assert.equal(field(dialog, '物料类型').value, 'indirect');
    assert.ok(dialog.querySelector('[aria-label="关闭编辑采购订单"]'));
    assert.equal(requests.length, 1);
  });
});

test('Chinese manual risk fields use the unchanged severity/category contract and show a persisted result', async () => {
  const fixture = poPageFixture('draft', 'supplier_commitment');
  fixture.po.risk = 'medium';
  fixture.po.actionReadiness = { mark_at_risk: { ready: true, code: 'ready', message: '可以创建人工风险事实' } };
  await withPoPage({ fixture, intent: 'mark-at-risk', fetch(path) {
    if (path === '/api/procurement/execution/mark_at_risk') return jsonResponse({ exception: { id: 'exception:chinese', status: 'open', version: 1 } });
  } }, async ({ act, button, requests }) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(dialog.querySelector('h2')?.textContent, '标记风险');
    assert.match(dialog.textContent ?? '', /当前风险中风险阶段供应商承诺/);
    assert.deepEqual([...field(dialog, '风险程度').querySelectorAll('option')].map((node) => [node.value, node.textContent]), [['medium', '中'], ['high', '高'], ['critical', '严重']]);
    await act(async () => {
      change(field(dialog, '风险程度'), 'critical');
      change(field(dialog, '风险类别'), 'quality');
      change(field(dialog, '风险原因'), 'Original quality evidence');
      change(field(dialog, '处置建议（可选）'), 'Inspect the first batch');
    });
    await act(async () => button(/^标记风险$/, dialog).click());
    assert.deepEqual(requests[0]?.body, { aggregateId: 'po:page', expectedVersion: 4, riskSeverity: 'critical', riskCategory: 'quality', reason: 'Original quality evidence', recommendedAction: 'Inspect the first batch' });
    assert.match(dialog.querySelector('[role="status"]')?.textContent ?? '', /人工风险事实已保存.*exception:chinese/);
    assert.equal(field(dialog, '风险原因').value, 'Original quality evidence');
    assert.equal(requests.length, 1);
  });
});

test('Chinese cancellation remains a dangerous explicit action and preserves external pending/unknown truth', async () => {
  const fixture = poPageFixture('confirmed');
  fixture.po.sourceSystem = 'odoo';
  let count = 0;
  await withPoPage({ fixture, fetch(path) {
    if (path === '/api/procurement/execution/cancel_po') return jsonResponse({ requestId: 'cancel:chinese', status: count++ === 0 ? 'pending_external' : 'unknown', outboxId: 'outbox:chinese', purchaseOrderVersion: 4 });
  } }, async ({ act, button, requests }) => {
    await act(async () => button(/^操作$/).click());
    await act(async () => button(/^取消采购订单$/).click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.equal(dialog.querySelector('h2')?.textContent, '取消采购订单');
    assert.match(dialog.textContent ?? '', /危险操作/);
    assert.equal(button(/^取消采购订单$/, dialog).disabled, true);
    const reason = dialog.querySelector<HTMLTextAreaElement>('[aria-label="取消原因"]')!;
    assert.ok(reason);
    await act(async () => change(reason, 'Original approved cancellation reason'));
    await act(async () => button(/^取消采购订单$/, dialog).click());
    assert.match(dialog.querySelector('[role="status"]')?.textContent ?? '', /等待外部回执/);
    assert.match(document.body.textContent ?? '', /Odoo 取消请求已排队，等待权威读回/);
    await act(async () => button(/^核对状态$/, dialog).click());
    assert.match(dialog.querySelector('[role="status"]')?.textContent ?? '', /需要处理/);
    assert.match(document.body.textContent ?? '', /外部结果尚不明确，请使用同一请求编号核对状态/);
    assert.match(dialog.textContent ?? '', /不要使用新请求编号重复取消/);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(reason.value, 'Original approved cancellation reason');
    assert.equal(fixture.po.status, 'confirmed');
  });
});

for (const external of [false, true]) {
  test(`Edit PO ${external ? 'queued amendment' : 'saved draft'} publishes Chinese outcome feedback`, async () => {
    const fixture = poPageFixture('draft', 'po_sent');
    if (external) fixture.po.sourceSystem = 'odoo';
    await withPoPage({ fixture, fetch(path) {
      if (path === '/api/procurement/execution/edit_po') {
        if (!external) Object.assign(fixture.po, { requiredInHouseAt: '2026-09-25', version: 5 });
        return jsonResponse(external ? { amendment: { id: 'amendment:1', status: 'pending_external' } } : { aggregate: { id: fixture.po.id, version: 5 } });
      }
    } }, async ({ act, button, requests }) => {
      await act(async () => button(/^操作$/).click());
      await act(async () => button(/^编辑采购订单$/).click());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      await act(async () => { change(field(dialog, '要求到货日'), '2026-09-25'); change(field(dialog, '修改原因'), '批准的交期调整'); });
      await act(async () => button(/^保存修改$/, dialog).click());
      assert.equal(document.querySelector('[role="dialog"]'), null);
      assert.match(document.body.textContent ?? '', external ? /Odoo 变更请求已排队，等待权威读回/ : /采购订单修改已保存/);
      if (external) assert.doesNotMatch(document.body.textContent ?? '', /采购订单修改已保存/);
      assert.equal(requests.length, 1);
    });
  });
}

for (const status of ['cancelled', 'failed'] as const) {
  test(`cancellation ${status} publishes a Chinese outcome without conflating rejection and success`, async () => {
    const fixture = poPageFixture('confirmed');
    await withPoPage({ fixture, fetch(path) {
      if (path === '/api/procurement/execution/cancel_po') {
        if (status === 'cancelled') Object.assign(fixture.po, { status, version: 5 });
        return jsonResponse({ requestId: 'cancel:outcome', status, outboxId: null, purchaseOrderVersion: status === 'cancelled' ? 5 : 4 });
      }
    } }, async ({ act, button, requests }) => {
      await act(async () => button(/^操作$/).click());
      await act(async () => button(/^取消采购订单$/).click());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      await act(async () => change(dialog.querySelector('textarea')!, '订单取消审批依据'));
      await act(async () => button(/^取消采购订单$/, dialog).click());
      const body = document.body.textContent ?? '';
      assert.match(body, status === 'cancelled' ? /采购订单 PO-PAGE 已取消；行项目、文档和历史均已保留/ : /Odoo 已明确拒绝取消，当前采购订单未标记为已取消/);
      assert.equal(fixture.po.status, status === 'cancelled' ? 'cancelled' : 'confirmed');
      if (status === 'failed') {
        assert.match(dialog.querySelector('[role="status"]')?.textContent ?? '', /取消失败/);
        assert.doesNotMatch(body, /采购订单 PO-PAGE 已取消/);
      }
      assert.equal(requests.length, 1);
    });
  });
}

test('Chinese duplicate dialog distinguishes an independent unsent draft and never creates one on open', async () => {
  await withPoPage({}, async ({ act, button, requests }) => {
    await act(async () => button(/^操作$/).click());
    await act(async () => button(/^复制订单$/).click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    assert.match(dialog.textContent ?? '', /独立、未发送的 Readywork 采购订单草稿/);
    assert.doesNotMatch(dialog.textContent ?? '', /PO Draft|PO Actions/);
    assert.equal(button(/^创建采购订单草稿$/, dialog).disabled, true);
    assert.equal(requests.length, 0);
  });
});
