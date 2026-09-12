import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonResponse, poPageFixture, withPoPage } from './helpers/po-page-harness.js';

function fixtureFor(actionId: string) {
  const stage = ['record-production-progress', 'record-shipment'].includes(actionId) ? 'fulfilment_production'
    : ['record-transport-event', 'record-receipt'].includes(actionId) ? 'dispatch_transit' : 'supplier_commitment';
  const fixture = poPageFixture(['send-po', 'sync-odoo-draft'].includes(actionId) ? 'draft' : 'sent', stage);
  if (actionId.endsWith('-runtime')) {
    const task = { id: 'task:page', businessObjectId: fixture.po.id, status: 'waiting_approval' };
    const approval = { id: 'approval:runtime', taskId: task.id, status: 'pending', message: '等待核验后继续执行' };
    fixture.context.tasks.push(task); fixture.workbench.tasks.items.push(task);
    fixture.context.approvals.push(approval); fixture.workbench.approvals.items.push(approval);
  }
  if (actionId === 'sync-odoo-draft') fixture.context.suppliers[0]!.sourceSystem = 'odoo';
  if (actionId === 'record-confirmation') fixture.context.communications.push({ id: 'message:page', businessObjectType: 'purchase_order', businessObjectId: fixture.po.id, channel: 'email', direction: 'inbound', status: 'received', from: 'supplier@example.test', subject: '确认订单', body: '200 件，127 元，2026-09-20 交货', receivedAt: '2026-09-06T00:00:00.000Z' });
  if (['record-transport-event', 'record-receipt'].includes(actionId)) {
    fixture.po.status = 'shipped';
    fixture.context.shipments.push({ id: 'shipment:page', externalId: 'ASN-PAGE', poId: fixture.po.id });
    fixture.context.quantityProjections.push({ poLineId: fixture.line.id, orderedQty: 200, confirmedQty: 200, shippedQty: 100, receivedQty: 0 });
  }
  return fixture;
}

test('normal PO overview keeps reference metrics first and places workflow controls in the existing side column', async () => {
  await withPoPage({}, async () => {
    const panel = document.querySelector('[role="tabpanel"]')!;
    const overview = panel.querySelector('section')!;
    assert.equal(overview.getAttribute('aria-label'), '采购订单指标');
    const actions = document.querySelector('#po-ai-actions');
    assert.ok(actions?.closest('aside'), 'workflow access must not replace the reference metrics-first layout');
  });
});

// Each row catches a real state-to-action branch stranded by page presentation.
for (const [actionId, label] of [
  ['approve-runtime', '批准并让员工继续'], ['reject-runtime', '驳回当前建议'],
  ['send-po', '发送 PO 给供应商'], ['sync-odoo-draft', '创建 Odoo 采购订单草稿'],
  ['record-confirmation', '从供应商回复登记确认'], ['record-production-progress', '核验生产 / 备货进度'],
  ['record-shipment', '核验并记录发运 / ASN'], ['record-transport-event', '核验并记录运输节点'],
  ['record-receipt', '核验并记录到货 / GRN'], ['partial-delivery', '要求分批交付'],
  ['expedite', '要求加急'], ['keep-date', '不接受新交期'],
] as const) {
  test(`page exposes ${actionId} and opens its review without sending a mutation`, async () => {
    await withPoPage({ fixture: fixtureFor(actionId) }, async ({ act, requests, button }) => {
      const entry = button(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      assert.equal(entry.id, `po-ai-action-${actionId}`, 'chat suggestions need a stable action target');
      await act(async () => entry.click());
      assert.equal(requests.length, 0, 'the entry must require explicit confirmation');
      assert.equal(document.querySelector('#confirm-action-title')?.textContent, label);
    });
  });
}

for (const [actionId, label, path, body, key] of [
  ['approve-runtime', '批准并让员工继续', '/api/tasks/task%3Apage/approve', { approvalId: 'approval:runtime' }, null],
  ['reject-runtime', '驳回当前建议', '/api/tasks/task%3Apage/reject', { approvalId: 'approval:runtime' }, null],
  ['send-po', '发送 PO 给供应商', '/api/procurement/execution/send_po', { aggregateId: 'po:page', expectedVersion: 4, connectorId: 'email' }, 'web-po:send-po:po:page:v4'],
  ['sync-odoo-draft', '创建 Odoo 采购订单草稿', '/api/procurement/execution/create_odoo_po_draft', { aggregateId: 'po:page', expectedVersion: 4, connectorId: 'erp' }, 'web-po:sync-odoo-draft:po:page:v4'],
  ['partial-delivery', '要求分批交付', '/api/procurement/execution/queue_followup', { aggregateId: 'po:page', expectedVersion: 4, connectorId: 'email', reason: '请提供可行的分批交付方案，明确每批数量和发货日期' }, 'web-po:partial-delivery:po:page:v4'],
  ['expedite', '要求加急', '/api/procurement/execution/queue_followup', { aggregateId: 'po:page', expectedVersion: 4, connectorId: 'email', reason: '请加急当前采购订单，并回复最早可行发货日期' }, 'web-po:expedite:po:page:v4'],
  ['keep-date', '不接受新交期', '/api/procurement/execution/queue_followup', { aggregateId: 'po:page', expectedVersion: 4, connectorId: 'email', reason: '当前不接受新交期，请维持采购订单原定交付计划并确认' }, 'web-po:keep-date:po:page:v4'],
] as const) {
  test(`${actionId} confirmation retains endpoint, version and idempotency contracts`, async () => {
    await withPoPage({ fixture: fixtureFor(actionId), fetch(requestPath, init) {
      if (requestPath === path && init?.method === 'POST') return jsonResponse({ aggregate: { id: 'po:page', version: 5 }, outbox: { id: 'outbox:page', status: 'pending' } });
    } }, async ({ act, requests, reads, button }) => {
      await act(async () => button(new RegExp(`^${label}$`)).click());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="confirm-action-title"]')!;
      const readsBefore = reads.length;
      await act(async () => button(/确认并继续|确认事实并保存/, dialog).click());
      assert.deepEqual(requests, [{ path, body, key }]);
      assert.equal(document.querySelector('#confirm-action-title'), null);
      assert.ok(reads.length > readsBefore, 'accepted mutation must refetch persisted context');
      if (actionId === 'send-po') {
        assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /已进入发送队列/);
        assert.doesNotMatch(document.querySelector('[role="status"]')?.textContent ?? '', /已送达/);
      }
    });
  });
}

test('runtime approval stays visible to a read-only user without granting approval actions', async () => {
  const fixture = fixtureFor('approve-runtime');
  fixture.workbench.permissions.approve = false;
  fixture.workbench.permissions.operate = false;
  await withPoPage({ fixture }, async ({ requests }) => {
    const section = document.querySelector('section[aria-label="运行审批"]');
    assert.ok(section);
    assert.match(section.textContent ?? '', /没有审批权限/);
    assert.equal(document.querySelector('#po-ai-action-approve-runtime'), null);
    assert.equal(requests.length, 0);
  });
});

test('pending runtime approval with missing task context cannot fall through to normal execution actions', async () => {
  const fixture = fixtureFor('approve-runtime');
  fixture.context.tasks = [];
  await withPoPage({ fixture }, async ({ requests }) => {
    assert.ok(document.querySelector('section[aria-label="运行审批"]'));
    assert.equal(document.querySelectorAll('button[id^="po-ai-action-"]').length, 0, 'incomplete approval context must fail closed');
    assert.match(document.body.textContent ?? '', /审批关联任务尚未读回/);
    assert.equal(requests.length, 0);
  });
});

for (const intent of ['edit-rihd', 'mark-at-risk'] as const) {
  test(`read-only deep link ${intent} shows permission denial instead of opening a write dialog`, async () => {
    const fixture = fixtureFor('send-po');
    fixture.workbench.permissions.operate = false;
    fixture.workbench.permissions.approve = false;
    await withPoPage({ fixture, intent }, async ({ requests }) => {
      assert.ok(document.querySelector('[role="dialog"]') === null, 'a URL intent cannot bypass the disabled Actions menu');
      assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /没有.*操作权限/);
      assert.equal(requests.length, 0);
    });
  });

  test(`${intent} cannot submit after refreshed permissions revoke operation access`, async () => {
    const fixture = fixtureFor('send-po');
    fixture.po.actionReadiness = { mark_at_risk: { ready: true, code: 'ready', message: '可登记人工风险' } };
    await withPoPage({ fixture, intent, fetch(_path, init) {
      if (init?.method === 'POST') return jsonResponse({ error: '服务器权限门禁' }, 403);
    } }, async ({ act, realtime, requests }) => {
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      assert.ok(dialog);
      await act(async () => {
        const reason = dialog.querySelector(intent === 'edit-rihd' ? 'input[minlength="4"]' : 'textarea')!;
        const prototype = intent === 'edit-rihd' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(reason, '已核验供应商原始证据');
        reason.dispatchEvent(new Event('input', { bubbles: true }));
        reason.dispatchEvent(new Event('change', { bubbles: true }));
        if (intent === 'edit-rihd') {
          const date = dialog.querySelector('input[type="date"]')!;
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(date, '2026-09-21');
          date.dispatchEvent(new Event('input', { bubbles: true }));
          date.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      fixture.workbench.permissions.operate = false;
      await realtime();
      await act(async () => dialog.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      assert.equal(requests.length, 0, 'revoked access must block even a previously opened form');
      assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? '', /没有.*操作权限/);
    });
  });
}

test('blocked send exposes its reason but cannot open a confirmation or submit', async () => {
  const fixture = fixtureFor('send-po');
  fixture.context.actionReadiness.send_po = { ready: false, code: 'connector_unready', message: '发信邮箱尚未连接' };
  await withPoPage({ fixture }, async ({ act, button, requests }) => {
    const entry = button(/^发送 PO 给供应商$/);
    assert.equal(entry.disabled, true);
    assert.match(document.body.textContent ?? '', /发信邮箱尚未连接/);
    await act(async () => entry.click());
    assert.equal(document.querySelector('#confirm-action-title'), null);
    assert.equal(requests.length, 0);
  });
});

for (const actionId of ['send-po', 'approve-runtime', 'followup-confirm'] as const) {
  test(`chat suggestion ${actionId} navigates to and focuses the real overview action without executing it`, async () => {
    await withPoPage({ fixture: fixtureFor(actionId), tab: 'communication', fetch(path) {
      if (path.startsWith('/api/po/chat?')) return jsonResponse({ conversation: null, messages: [], contextSummary: { purchaseOrderId: 'po:page', displayNumber: 'PO-PAGE', status: 'sent', supplierId: 'supplier:page' }, model: { configured: true, route: 'fast', name: 'test', maxTokens: 1024 }, suggestedActions: [{ id: 'suggestion:page', actionId, label: '打开待核对操作', description: '仅定位，不执行', requiresConfirmation: true, targetTab: 'overview' }] });
    } }, async ({ act, button, requests }) => {
      await act(async () => { button(/^打开待核对操作/).click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent, '概览');
      assert.equal(document.activeElement?.id, `po-ai-action-${actionId}`);
      assert.equal(requests.length, 0);
      assert.equal(document.querySelector('#confirm-action-title'), null);
      await act(async () => (document.activeElement as HTMLButtonElement).click());
      assert.ok(document.querySelector('#confirm-action-title'));
    });
  });
}

for (const [actionId, label, permission] of [
  ['approve-runtime', '批准并让员工继续', 'approve'],
  ['send-po', '发送 PO 给供应商', 'operate'],
  ['expedite', '要求加急', 'operate'],
] as const) {
  test(`open ${actionId} confirmation cannot bypass a refreshed ${permission} permission denial`, async () => {
    const fixture = fixtureFor(actionId);
    await withPoPage({ fixture, fetch(_path, init) {
      if (init?.method === 'POST') return jsonResponse({ error: '服务器权限门禁' }, 403);
    } }, async ({ act, button, realtime, requests }) => {
      await act(async () => button(new RegExp(`^${label}$`)).click());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="confirm-action-title"]')!;
      fixture.workbench.permissions[permission] = false;
      await realtime();
      await act(async () => button(/确认并继续|确认事实并保存/, dialog).click());
      assert.equal(requests.length, 0, 'a previously captured ActionPlan must not retain revoked authority');
      assert.match(dialog.textContent ?? '', /权限.*变化|没有.*权限/);
    });
  });
}
