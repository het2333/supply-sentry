import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonResponse, poPageFixture, withPoPage } from './helpers/po-page-harness.js';

test('new PDF snapshot immediately refreshes the Documents tab and reopens the stored version without regenerating it', async () => {
  const fixture = poPageFixture();
  const pdfUrl = '/api/procurement/purchase-order-document-snapshots/snapshot%3Apage/pdf';
  await withPoPage({ fixture, tab: 'documents', fetch(path, init) {
    if (path === '/api/procurement/purchase-orders/po%3Apage/document-snapshots' && init?.method === 'POST') {
      fixture.context.poDetail.documents.rows.push({ id: 'document:page', snapshotId: 'snapshot:page', name: 'PO-PAGE.pdf', category: 'purchase_order', status: 'verified', sizeBytes: 1234, createdAt: '2026-09-06T00:00:00.000Z', createdBy: 'human:test', url: pdfUrl });
      fixture.context.poDetail.documents.kpis = { total: 1, verified: 1, pending: 0, missing: 0 };
      fixture.context.poDetail.documents.requirements.push({ id: 'purchase_order', label: 'Purchase Order', required: true, state: 'present' });
      return jsonResponse({ pdfUrl, printUrl: '/api/procurement/purchase-order-document-snapshots/snapshot%3Apage/print' });
    }
  } }, async ({ act, reads, button, requests }) => {
    const windows: Array<{ url: string; target: { location: { href: string }; opener: unknown; blur: () => void; close: () => void } }> = [];
    Object.defineProperty(window, 'open', { configurable: true, value: (url: string) => {
      const target = { location: { href: url }, opener: null as unknown, blur() {}, close() {} };
      windows.push({ url, target }); return target;
    } });
    Object.defineProperty(window, 'focus', { configurable: true, value: () => undefined });
    const before = reads.filter((path) => path.startsWith('/api/procurement/workbench/context/')).length;
    await act(async () => button(/^操作$/).click());
    await act(async () => button(/^下载 PDF$/).click());
    assert.equal(windows[0]?.target.location.href, pdfUrl);
    assert.ok(reads.filter((path) => path.startsWith('/api/procurement/workbench/context/')).length > before, 'generating a file must immediately invalidate its detail projection');
    const row = [...document.querySelectorAll('tbody tr')].find((entry) => entry.textContent?.includes('PO-PAGE.pdf'));
    assert.ok(row, 'new snapshot appears without waiting for polling');
    const open = row.querySelector('a');
    assert.equal(open?.getAttribute('aria-label'), '下载 PO-PAGE.pdf');
    assert.equal(open?.getAttribute('href'), pdfUrl);
    assert.equal(open?.target, '_blank');
    assert.equal(requests.length, 1, 'the reopen link addresses the existing snapshot, not another mutation');
    assert.deepEqual(requests[0]?.body, { expectedVersion: 4, purpose: 'download' });
  });
});

test('History reference controls stay stateless and preserve the complete authoritative event feed', async () => {
  const fixture = poPageFixture();
  fixture.context.poDetail.history.events = [
    { id: 'event:failed', at: '2026-09-06T00:00:00.000Z', label: '发送明确失败', type: 'outbox.result', actor: 'system', state: 'failed' },
    { id: 'event:blocked', at: '2026-09-06T00:01:00.000Z', label: '连接器安全阻断', type: 'outbox.result', actor: 'system', state: 'blocked' },
    { id: 'event:completed', at: '2026-09-06T00:02:00.000Z', label: '发送回执已确认', type: 'outbox.result', actor: 'system', state: 'completed' },
  ];
  let hasSelect = false;
  let controlNames: string[] = [];
  let attributes = { filterExpanded: false, activityPressed: false };
  let renderedAfter = '';
  let requestCount = -1;
  await withPoPage({ fixture, tab: 'history' }, async ({ act, requests }) => {
    const panel = document.querySelector('[role="tabpanel"]')!;
    hasSelect = panel.querySelector('select') !== null;
    const controls = [...panel.querySelectorAll<HTMLButtonElement>('button')]
      .filter((entry) => ['筛选', '全部活动'].includes(entry.textContent?.trim() ?? ''));
    controlNames = controls.map((entry) => entry.textContent?.trim() ?? '');
    assert.match(panel.textContent ?? '', /发送明确失败/);
    assert.match(panel.textContent ?? '', /连接器安全阻断/);
    assert.match(panel.textContent ?? '', /发送回执已确认/);
    if (controls[0]) await act(async () => controls[0]!.click());
    if (controls[1]) {
      await act(async () => controls[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      await act(async () => controls[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    }
    attributes = { filterExpanded: controls[0]?.hasAttribute('aria-expanded') ?? false, activityPressed: controls[1]?.hasAttribute('aria-pressed') ?? false };
    renderedAfter = panel.textContent ?? '';
    requestCount = requests.length;
  });
  assert.equal(hasSelect, false);
  assert.deepEqual(controlNames, ['筛选', '全部活动']);
  assert.deepEqual(attributes, { filterExpanded: false, activityPressed: false });
  assert.match(renderedAfter, /发送明确失败/);
  assert.match(renderedAfter, /连接器安全阻断/);
  assert.match(renderedAfter, /发送回执已确认/);
  assert.equal(requestCount, 0);
});
