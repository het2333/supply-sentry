import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Communication, Item, PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementGlobalSearchRequest, searchProcurement } from '../src/procurement-global-search.js';

const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
function token(tenantId: string, role = '采购专员'): string {
  const session: Session = { username: 'buyer', tenantId, humanId: 'human:buyer', name: '李采购', role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

test('采购全局搜索: 搜索真实业务对象、隔离租户并转义通配符', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rw-procurement-search-'));
  const store = openPersistence(join(directory, 'search.db'), { tenantId: 'tenant:search' });
  const repository = createProcurementRepository(store.db, 'tenant:search');
  const at = '2026-08-28T02:00:00.000Z';
  const supplier: Supplier = {
    id: 'supplier:shanghai', tenantId: 'tenant:search', sourceSystem: 'odoo', externalId: 'SUP-001', status: 'active',
    createdAt: at, updatedAt: at, name: '上海卓越阀门', currency: 'CNY',
    contacts: [{ id: 'contact:1', name: '张工', email: 'vendor@example.cn', primary: true }],
  };
  const item: Item = {
    id: 'item:cv420', tenantId: 'tenant:search', sourceSystem: 'odoo', externalId: 'CV-420', status: 'active',
    createdAt: at, updatedAt: at, sku: 'CV-420', name: '控制阀 100%_proof', uom: 'EA', category: '阀门',
  };
  const po: PurchaseOrder = {
    id: 'po:p00001', tenantId: 'tenant:search', sourceSystem: 'odoo', externalId: 'P00001', status: 'sent',
    createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at,
  };
  const line: PurchaseOrderLine = {
    id: 'po-line:p00001:10', poId: po.id, lineNumber: '10', itemId: item.id, description: '控制阀 CV-420',
    uom: 'EA', orderedQty: 12, unitPrice: 860, currency: 'CNY',
  };
  const communication: Communication = {
    id: 'communication:reply', tenantId: 'tenant:search', sourceSystem: 'email', externalId: 'mail:reply:1', status: 'recorded',
    createdAt: at, updatedAt: at, businessObjectId: po.id, businessObjectType: 'purchase_order', supplierId: supplier.id,
    channel: 'email', direction: 'inbound', messageId: '<reply@example.cn>', subject: 'P00001 供应商承诺回复', body: '确认交期',
    attachmentIds: [], occurredAt: at,
  };
  repository.saveDocument('supplier', supplier);
  repository.saveDocument('item', item);
  repository.saveDocument('purchase_order', po);
  repository.saveLine('purchase_order_line', po.id, line);
  repository.saveDocument('communication', communication);
  store.db.prepare(`INSERT INTO procurement_message_drafts
    (tenant_id,id,purchase_order_id,supplier_id,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'tenant:search', 'draft:delivery', po.id, supplier.id, 'vendor@example.cn', '请确认 P00001 交期', '请确认',
      'acknowledgement_followup', 'search-test', '{}', 'draft', 1, 'ai:procurement', at, at,
    );
  store.db.prepare(`INSERT INTO procurement_notifications
    (tenant_id,id,fingerprint,type,severity,title,message,tag,object_type,object_id,evidence_json,status,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(
      'tenant:search', 'notification:overdue', 'search-overdue', 'rihd_at_risk', 'high', 'P00001 到货风险',
      '要求到货日临近', '到货风险', 'purchase_order', po.id, '{}', 'unread', at, at,
    );

  const otherRepository = createProcurementRepository(store.db, 'tenant:other');
  otherRepository.saveDocument('supplier', { ...supplier, id: 'supplier:other', tenantId: 'tenant:other', externalId: 'SUP-OTHER', name: '上海卓越阀门机密租户' });

  try {
    assert.ok(searchProcurement(store.db, 'tenant:search', 'P00001').some((result) => result.kind === 'purchase_order' && result.objectId === po.id));
    assert.ok(searchProcurement(store.db, 'tenant:search', '上海卓越').some((result) => result.kind === 'supplier' && result.objectId === supplier.id));
    assert.ok(searchProcurement(store.db, 'tenant:search', 'CV-420').some((result) => result.kind === 'item' && result.objectId === item.id));
    assert.ok(searchProcurement(store.db, 'tenant:search', '请确认').some((result) => result.kind === 'message_draft'));
    assert.ok(searchProcurement(store.db, 'tenant:search', '到货风险').some((result) => result.kind === 'notification'));
    assert.ok(searchProcurement(store.db, 'tenant:search', '供应商承诺').some((result) => result.kind === 'communication'));
    assert.ok(searchProcurement(store.db, 'tenant:search', '%_').some((result) => result.kind === 'item'), 'LIKE 通配符必须按字面量搜索');
    assert.equal(searchProcurement(store.db, 'tenant:search', '机密租户').length, 0, '不得返回其他租户数据');

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const authorization = req.headers.authorization;
      const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      void handleProcurementGlobalSearchRequest(req, res, url.pathname, req.method ?? 'GET', { db: store.db, session: resolveSession(bearer) })
        .then((handled) => { if (!handled) res.writeHead(404).end(); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const unauthorized = await fetch(`${base}/api/procurement/search?q=P00001`);
    assert.equal(unauthorized.status, 401);
    const short = await fetch(`${base}/api/procurement/search?q=P`, { headers: { authorization: `Bearer ${token('tenant:search')}` } });
    assert.deepEqual((await short.json() as { items: unknown[] }).items, []);
    const response = await fetch(`${base}/api/procurement/search?q=${encodeURIComponent('上海卓越')}`, { headers: { authorization: `Bearer ${token('tenant:search')}` } });
    assert.equal(response.status, 200);
    assert.ok((await response.json() as { items: unknown[] }).items.length > 0);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } finally {
    store.close();
  }
});
