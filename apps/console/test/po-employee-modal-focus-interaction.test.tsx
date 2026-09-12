import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deferredResponse, jsonResponse, poPageFixture, withPoPage } from './helpers/po-page-harness.js';

test('action confirmation contains keyboard focus, wraps Tab in both directions, and restores its initiating action', async () => {
  await withPoPage({}, async ({ act, button, requests }) => {
    const entry = button(/^要求加急$/);
    await act(async () => { entry.focus(); entry.click(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="confirm-action-title"]')!;
    assert.ok(dialog.contains(document.activeElement), 'opening a confirmation must move focus into the modal');
    const controls = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    await act(async () => {
      controls.at(-1)!.focus();
      controls.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    assert.ok(document.activeElement === controls[0], 'Tab wraps to the first modal control');
    await act(async () => controls[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    assert.ok(document.activeElement === controls.at(-1), 'Shift+Tab wraps to the last modal control');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('#confirm-action-title'), null);
    assert.ok(document.activeElement === entry, 'focus returns to the initiating action');
    assert.equal(requests.length, 0);
  });
});

test('duplicate modal traps keyboard focus and returns to Actions after its menu item unmounts', async () => {
  await withPoPage({}, async ({ act, button, requests }) => {
    const trigger = button(/^操作$/);
    await act(async () => { trigger.focus(); trigger.click(); });
    await act(async () => { const duplicate = button(/^复制订单$/); duplicate.focus(); duplicate.click(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="duplicate-po-title"]')!;
    assert.ok(dialog.contains(document.activeElement));
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')];
    await act(async () => {
      controls.at(-1)!.focus();
      controls.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    assert.ok(document.activeElement === controls[0], 'Tab cannot escape to the page behind the modal');
    await act(async () => controls[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    assert.ok(document.activeElement === controls.at(-1), 'Shift+Tab wraps to the last modal control');
    await act(async () => button(/^取消$/, dialog).click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(document.querySelector('#duplicate-po-title'), null);
    assert.ok(document.activeElement === trigger, 'focus returns to Actions');
    assert.equal(requests.length, 0);
  });
});

test('duplicate success opens the persisted new order and leaves focus on its Actions trigger', async () => {
  const fixture = poPageFixture();
  const copied = { ...fixture.po, id: 'po:copy', externalId: 'PO-PAGE-COPY', status: 'draft' };
  await withPoPage({ fixture, fetch(path, init) {
    if (path === '/api/procurement/execution/duplicate_po' && init?.method === 'POST') {
      fixture.workbench.documents.purchaseOrders.items.push(copied);
      fixture.workbench.portfolio.items.push(copied);
      return jsonResponse({ createdDocuments: [copied] });
    }
    if (path.endsWith('po%3Acopy')) return jsonResponse({ ...fixture.context, requestedId: copied.id, objectId: copied.id, purchaseOrders: [copied], linesByDocument: { [copied.id]: [{ ...fixture.line, id: 'line:copy', poId: copied.id }] } });
  } }, async ({ act, button, requests }) => {
    await act(async () => button(/^操作$/).click());
    await act(async () => button(/^复制订单$/).click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="duplicate-po-title"]')!;
    await act(async () => {
      const reason = dialog.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(reason, '新项目需求，创建独立订单');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
      reason.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => button(/^创建采购订单草稿$/, dialog).click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(requests.length, 1);
    assert.match(document.querySelector('h1')?.textContent ?? '', /PO-PAGE-COPY/);
    assert.match(document.body.textContent ?? '', /采购订单草稿 .* 已保存，已打开新采购订单/);
    assert.ok(document.querySelector('#duplicate-po-title') === null);
    assert.ok(document.activeElement === document.querySelector('[data-po-actions-trigger]'), 'focus must remain on the visible new order');
    const adjacent = document.querySelector<HTMLButtonElement>('button[aria-label="上一张订单"]:not(:disabled),button[aria-label="下一张订单"]:not(:disabled)');
    assert.ok(adjacent);
    await act(async () => adjacent.click());
    assert.doesNotMatch(document.body.textContent ?? '', /已保存，已打开新采购订单/);
  });
});

test('an in-flight confirmation cannot be dismissed with Escape or submitted twice', async () => {
  let pending: ReturnType<typeof deferredResponse> | undefined;
  await withPoPage({ fetch(path, init) {
    if (path === '/api/procurement/execution/queue_followup' && init?.method === 'POST') { pending = deferredResponse(init.signal); return pending.promise; }
  } }, async ({ act, button, requests }) => {
    await act(async () => button(/^要求加急$/).click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="confirm-action-title"]')!;
    await act(async () => button(/确认并继续/, dialog).click());
    assert.equal(requests.length, 1);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    assert.ok(document.querySelector('#confirm-action-title'));
    await act(async () => button(/等待后端确认/, dialog).click());
    assert.equal(requests.length, 1);
    await act(async () => pending!.resolve(jsonResponse({ aggregate: { id: 'po:page', version: 5 } })));
    assert.ok(document.querySelector('#confirm-action-title') === null);
  });
});

for (const [menu, permission] of [['复制订单', 'operate'], ['取消采购订单', 'operate'], ['取消采购订单', 'approve']] as const) {
  test(`${menu} submit respects ${permission} revocation after opening its dialog`, async () => {
    const fixture = poPageFixture();
    await withPoPage({ fixture, fetch(_path, init) {
      if (init?.method === 'POST') return jsonResponse({ error: '服务器权限门禁' }, 403);
    } }, async ({ act, button, realtime, requests }) => {
      await act(async () => button(/^操作$/).click());
      await act(async () => button(new RegExp(`^${menu}$`)).click());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      await act(async () => {
        const reason = dialog.querySelector('textarea')!;
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(reason, '核对订单并保留完整审批依据');
        reason.dispatchEvent(new Event('input', { bubbles: true }));
        reason.dispatchEvent(new Event('change', { bubbles: true }));
      });
      fixture.workbench.permissions[permission] = false;
      await realtime();
      await act(async () => button(menu === '复制订单' ? /^创建采购订单草稿$/ : /^取消采购订单$/, dialog).click());
      assert.equal(requests.length, 0, 'revoked permission must be rechecked at submission');
      assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? '', /没有.*权限/);
    });
  });
}
