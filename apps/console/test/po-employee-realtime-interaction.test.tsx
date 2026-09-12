import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deferredResponse, jsonResponse, poPageFixture, withPoPage } from './helpers/po-page-harness.js';

test('realtime superseding the initial workbench read settles loading and opens the requested PO, not the first row', async () => {
  const fixture = poPageFixture();
  const other = { ...fixture.po, id: 'po:first', externalId: 'PO-FIRST', updatedAt: '2026-09-07T00:00:00.000Z' };
  fixture.workbench.documents.purchaseOrders.items.unshift(other);
  fixture.workbench.portfolio.items.unshift(other);
  let count = 0;
  let signal: AbortSignal | null | undefined;
  await withPoPage({ fixture, fetch(path, init) {
    if (path.startsWith('/api/procurement/workbench?') && ++count === 1) {
      signal = init?.signal;
      return deferredResponse(signal).promise;
    }
    if (path.endsWith('po%3Afirst')) return jsonResponse({ ...fixture.context, requestedId: other.id, objectId: other.id, purchaseOrders: [other] });
  } }, async ({ realtime }) => {
    assert.match(document.body.textContent ?? '', /读取真实采购订单/);
    await realtime();
    assert.equal(signal?.aborted, true, 'this reproduces a replacement of the pending initial request');
    assert.match(document.querySelector('h1')?.textContent ?? '', /PO-PAGE/);
    assert.doesNotMatch(document.body.textContent ?? '', /读取真实采购订单/);
  });
});

test('failed quiet detail replacement exits initial loading and offers a working retry', async () => {
  let count = 0;
  await withPoPage({ fetch(path, init) {
    if (!path.startsWith('/api/procurement/workbench/context/')) return;
    count++;
    if (count === 1) return deferredResponse(init?.signal).promise;
    if (count === 2) return jsonResponse({ error: '订单详情读取失败' }, 500);
  } }, async ({ realtime, button, act }) => {
    await realtime();
    assert.ok(document.querySelector('[role="alert"]'), 'failed replacement must display error rather than retain spinner');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /订单详情读取失败/);
    await act(async () => button(/重新读取/).click());
    assert.ok(document.querySelector('[data-po-kpi]'), 'retry must render authoritative detail');
    assert.equal(document.querySelector('[role="alert"]'), null);
  });
});

test('page preserves known PO details but warns when background workbench refresh fails, and retry clears the warning', async () => {
  let count = 0;
  await withPoPage({ fetch(path) {
    if (path.startsWith('/api/procurement/workbench?') && ++count === 2) return jsonResponse({ error: '订单工作集刷新失败' }, 503);
  } }, async ({ realtime, act, button }) => {
    assert.ok(document.querySelector('[data-po-kpi]'));
    await realtime();
    assert.ok(document.querySelector('[data-po-kpi]'), 'a background error must not erase usable detail');
    const warning = document.querySelector<HTMLElement>('[role="alert"]');
    assert.ok(warning, 'stale workbench/permission information must not be silent');
    assert.match(warning.textContent ?? '', /订单工作集刷新失败/);
    await act(async () => button(/重新获取|重试/, warning).click());
    assert.equal(document.querySelector('[role="alert"]'), null);
  });
});
