import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProcurementRequisition, PurchaseOrder, RequisitionLine, Supplier } from '@readywork/core';
import type { OdooSupplierMasterResult } from '@readywork/connectors';
import {
  createProcurementRepository,
  getProcurementSupplierOperatingProfile,
  listProcurementSupplierOperatingProfileEvents,
  openPersistence,
} from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementRfqRequest } from '../src/procurement-rfqs.js';

const at = '2026-08-21T00:00:00.000Z';
const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

function seedTenant(db: Parameters<typeof createProcurementRepository>[0], tenantId: string): void {
  const repository = createProcurementRepository(db, tenantId);
  const requisition: ProcurementRequisition = {
    id: 'requisition:rfq-api', tenantId, sourceSystem: 'manual', externalId: 'REQ-RFQ-API', status: 'submitted',
    createdAt: at, updatedAt: at, source: 'manual', requesterId: 'human:requester', requestedAt: at,
    currency: 'CNY', title: 'M6 紧固件需求', requestingDepartment: '生产部', requesterName: '张工',
  };
  const line: RequisitionLine = {
    id: 'requisition-line:rfq-api', requisitionId: requisition.id, lineNumber: '10', itemId: 'item:M6',
    itemCode: 'M6', itemName: 'M6 不锈钢螺栓', description: 'M6 不锈钢螺栓', uom: '件', requestedQty: 100,
    requiredAt: '2027-02-01T00:00:00.000Z', technicalRequirements: '304 不锈钢', attachmentIds: [],
  };
  repository.saveDocument('requisition', requisition);
  repository.saveLine('requisition_line', requisition.id, line);
  const attachmentId = `attachment:${tenantId}:rfq-spec`;
  const attachmentContent = Buffer.from(`${tenantId} M6 紧固件规格 Rev.A`, 'utf8');
  const attachmentSha256 = createHash('sha256').update(attachmentContent).digest('hex');
  db.prepare(`INSERT INTO procurement_attachments
    (tenant_id,id,requisition_id,requisition_line_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,
      extraction_status,extracted_text_preview,content,status,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId, attachmentId, requisition.id, line.id, 'M6-规格.txt', 'text/plain', attachmentContent.length,
      attachmentSha256, 1, null, 'text_extracted', 'M6 紧固件规格 Rev.A', attachmentContent, 'active', 'human:requester', at,
    );
  db.prepare(`UPDATE procurement_attachments SET security_status='clean' WHERE tenant_id=? AND id=?`).run(tenantId, attachmentId);
  const awardRequisition: ProcurementRequisition = {
    ...requisition, id: 'requisition:award-api', externalId: 'REQ-AWARD-API', title: '多行定标需求',
  };
  repository.saveDocument('requisition', awardRequisition);
  for (const [id, lineNumber, itemId, itemCode, itemName] of [
    ['requisition-line:award-a', '10', 'item:award-a', 'A-ITEM', '定标物料 A'],
    ['requisition-line:award-b', '20', 'item:award-b', 'B-ITEM', '定标物料 B'],
  ] as const) {
    repository.saveLine('requisition_line', awardRequisition.id, {
      ...line, id, requisitionId: awardRequisition.id, lineNumber, itemId, itemCode, itemName, description: itemName,
    });
  }
  for (const [id, name, currency] of [['supplier:a', '供应商 A', 'CNY'], ['supplier:b', '供应商 B', 'USD']] as const) {
    const supplier: Supplier = {
      id, tenantId, sourceSystem: 'erp', externalId: id.toUpperCase(), status: 'active', createdAt: at, updatedAt: at,
      name, currency, performanceScore: id === 'supplier:a' ? 95 : 85,
      contacts: [{ id: `${id}:contact`, name: '报价联系人', email: `${id.slice(-1)}@example.com`, primary: true }],
    };
    repository.saveDocument('supplier', supplier);
  }
}

function rfqBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: 'rfq-create-key', requisitionId: 'requisition:rfq-api', title: 'M6 紧固件询价',
    deadline: '2027-01-15', currency: 'CNY', supplierIds: ['supplier:a', 'supplier:b'],
    attachmentIds: ['attachment:t:acme:rfq-spec'],
    externalId: 'RFQ-EXT-1',
    lines: [{ itemCode: 'FORGED', itemName: '不能信任的客户端行', quantity: 999, unit: '箱' }],
    ...overrides,
  };
}

function quoteBody(rfqLineId: string, supplierId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: `quote-${supplierId}`, supplierId, receivedAt: '2026-08-20', validUntil: '2027-01-01', currency: supplierId === 'supplier:b' ? 'USD' : 'CNY',
    evidence: { communicationId: `communication:${supplierId}`, messageId: `message:${supplierId}`, attachmentIds: [`attachment:${supplierId}`], sourceChannel: 'email' },
    lines: [{
      rfqLineId, unitPrice: supplierId === 'supplier:b' ? 1.2 : 10, priceBasisQuantity: 1,
      quotedQuantity: 100, uom: '件', taxIncluded: false, taxRate: 0.13, moq: 10,
      leadTimeDays: supplierId === 'supplier:b' ? 8 : 10, oneTimeCharges: [], freight: 0,
      paymentTerms: supplierId === 'supplier:b' ? 'Net 60' : 'Net 30', performanceScore: supplierId === 'supplier:b' ? 85 : 95,
    }],
    ...overrides,
  };
}

function inboundEmailBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'imap',
    mailbox: 'purchasing@example.com/INBOX',
    uid: '4815',
    messageId: '<rfq-reply-4815@example.com>',
    from: '供应商 A <A@EXAMPLE.COM>',
    subject: 'Re: M6 紧固件询价',
    body: '报价正文 token=inbound-body-secret',
    receivedAt: '2026-08-20T08:30:00.000Z',
    channel: 'email',
    supplierId: 'supplier:a',
    ...overrides,
  };
}

function awardRfqBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rfqBody({ idempotencyKey: 'award-rfq-create', requisitionId: 'requisition:award-api', title: '多供应商定标 RFQ', externalId: 'RFQ-AWARD-1', attachmentIds: [], ...overrides });
}

function manualSupplierBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: 'manual-supplier-create',
    name: '手工登记供应商',
    currency: 'CNY',
    primaryContact: { name: '陈联系人', email: 'contact@example.com', phone: '13800000000' },
    ...overrides,
  };
}

function operatingProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    countryCode: 'CN',
    route: 'local',
    supplierType: 'manufacturer',
    industry: '工业自动化',
    address: { line1: '采购路 18 号', line2: null, city: '苏州', region: '江苏', postalCode: '215000', countryCode: 'CN' },
    primaryMaterialCode: 'VALVE-01',
    primaryMaterialName: '真空阀',
    defaultLeadTimeDays: 21,
    productCriticality: 'high',
    paymentTerms: 'Net 30',
    contractStartsOn: '2026-01-01',
    contractEndsOn: '2027-12-31',
    ...overrides,
  };
}

test('RFQ/Quote 业务 API: 真实头行、幂等、租户隔离与逐行比价', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-rfq-api-'));
  const dbPath = join(dir, 'test.db');
  const store = openPersistence(dbPath, { tenantId: 'tenant:bootstrap' });
  seedTenant(store.db, 't:acme');
  seedTenant(store.db, 'tenant:b');
  let supplierProvider: (() => Promise<OdooSupplierMasterResult>) | undefined;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    void handleProcurementRfqRequest(req, res, url.pathname, req.method ?? 'GET', { db: store.db, session: resolveSession(token), supplierMasterProvider: supplierProvider })
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error: unknown) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); });
  });
  let serverClosed = false;
  let storeClosed = false;
  let lifecycleSupplierId = '';
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = { token: signSession({ username: 'buyer', tenantId: 't:acme', humanId: 'h:buyer-1', name: '李采购', role: '采购专员', expiresAt: Date.now() + 60_000 }) };
  const manager = { token: signSession({ username: 'manager', tenantId: 't:acme', humanId: 'h:procurement-manager', name: '王经理', role: '采购经理', expiresAt: Date.now() + 60_000 }) };
  const auditor = { token: signSession({ username: 'auditor', tenantId: 't:acme', humanId: 'h:auditor-1', name: '审计员', role: '审计员', expiresAt: Date.now() + 60_000 }) };
  const denied = { token: signSession({ username: 'denied', tenantId: 't:acme', humanId: 'h:denied-1', name: '无权限', role: '未知角色', expiresAt: Date.now() + 60_000 }) };
  const tenantBToken = signSession({ username: 'buyer-b', tenantId: 'tenant:b', humanId: 'human:b', name: 'B', role: '采购专员', expiresAt: Date.now() + 60_000 });
  const tenantBManagerToken = signSession({ username: 'manager-b', tenantId: 'tenant:b', humanId: 'human:manager-b', name: 'B 经理', role: '采购经理', expiresAt: Date.now() + 60_000 });

  async function request(method: string, path: string, options: { token?: string; body?: Record<string, unknown>; key?: string } = {}): Promise<{ status: number; body: Record<string, any> }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.key ? { 'idempotency-key': options.key } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  let rfqId = '';
  let rfqLineId = '';
  let rfqVersion = 0;
  try {
    await t.test('GET/POST 均要求身份，供应商列表按租户返回平铺字段与权威权限', async () => {
      assert.equal((await request('GET', '/api/procurement/suppliers')).status, 401);
      assert.equal((await request('POST', '/api/procurement/rfqs', { body: rfqBody() })).status, 401);
      const suppliers = await request('GET', '/api/procurement/suppliers', { token: buyer.token });
      assert.equal(suppliers.status, 200);
      assert.equal(suppliers.body['items'].length, 2);
      assert.ok(suppliers.body['items'].some((item: Record<string, unknown>) => item['email'] === 'a@example.com'));
      assert.deepEqual(suppliers.body['permissions'], { read: true, configure: false });

      const managerSuppliers = await request('GET', '/api/procurement/suppliers', { token: manager.token });
      assert.equal(managerSuppliers.status, 200);
      assert.deepEqual(managerSuppliers.body['permissions'], { read: true, configure: true });
      assert.deepEqual(
        managerSuppliers.body['items'].map((item: Record<string, unknown>) => item['id']),
        suppliers.body['items'].map((item: Record<string, unknown>) => item['id']),
      );

      const auditorSuppliers = await request('GET', '/api/procurement/suppliers', { token: auditor.token });
      assert.equal(auditorSuppliers.status, 200);
      assert.deepEqual(auditorSuppliers.body['permissions'], { read: true, configure: false });
      assert.equal((await request('GET', '/api/procurement/suppliers', { token: denied.token })).status, 403);

      const tenantBSuppliers = await request('GET', '/api/procurement/suppliers', { token: tenantBToken });
      assert.equal(tenantBSuppliers.status, 200);
      assert.deepEqual(tenantBSuppliers.body['permissions'], { read: true, configure: false });
      assert.equal(tenantBSuppliers.body['items'].length, 2);
      assert.equal(tenantBSuppliers.body['items'].some((item: Record<string, unknown>) => item['email'] === 'a@example.com'), true);
      assert.equal(
        tenantBSuppliers.body['items'].some((item: Record<string, unknown>) => item['tenantId'] === 't:acme'),
        false,
      );
    });

    await t.test('同步 Odoo 供应商具备原子幂等、稳定重放、租户隔离与错误脱敏', async () => {
      const masters: OdooSupplierMasterResult = { items: [{ externalId: 'odoo-partner-88', name: 'ERP 供应商', currency: 'CNY', contacts: [{ name: '主联系人', email: 'erp@example.com', phone: '' }], countryCode: 'CN', countryName: '中国', city: '苏州', street: '工业园区采购路 18 号', postalCode: '215000', status: 'active', sourceSystem: 'odoo' }], issues: [] };
      const forbidden = await request('POST', '/api/procurement/suppliers/sync', { token: buyer.token, body: { idempotencyKey: 'sync-1' } });
      assert.equal(forbidden.status, 403);

      let providerCalls = 0;
      supplierProvider = async () => {
        providerCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return masters;
      };
      const [first, concurrent] = await Promise.all([
        request('POST', '/api/procurement/suppliers/sync', { token: manager.token, body: { idempotencyKey: 'sync-atomic' } }),
        request('POST', '/api/procurement/suppliers/sync', { token: manager.token, body: { idempotencyKey: 'sync-atomic' } }),
      ]);
      assert.equal(first.status, 200);
      assert.deepEqual(concurrent, first);
      assert.equal(first.body['created'], 1);
      // Depending on event-loop scheduling, the second request may either
      // enter the provider before the first commit or replay the committed
      // idempotency snapshot. Both are correct; duplicate persistence is not.
      assert.ok(providerCalls >= 1 && providerCalls <= 2, `并发同步连接器读取次数应为 1–2，实际 ${providerCalls}`);
      assert.equal(first.body['items'][0].id, 'supplier:odoo:88');
      assert.equal(first.body['items'][0].version, 1);
      assert.equal(first.body['items'][0].countryCode, 'CN');
      assert.equal(first.body['items'][0].city, '苏州');
      const storedSupplier = store.db.prepare("SELECT version FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?").get('t:acme', 'supplier:odoo:88') as { version: number };
      assert.equal(storedSupplier.version, 1, '并发重放不得新增供应商版本');
      const storedIdempotency = store.db.prepare('SELECT payload_hash FROM supplier_sync_idempotency WHERE tenant_id=? AND idempotency_key=?').get('t:acme', 'sync-atomic') as { payload_hash: string };
      assert.match(storedIdempotency.payload_hash, /^[a-f0-9]{64}$/);

      supplierProvider = async () => { throw new Error('apiKey=must-not-be-called'); };
      const replay = await request('POST', '/api/procurement/suppliers/sync', { token: manager.token, body: { idempotencyKey: 'sync-atomic' } });
      assert.deepEqual(replay, first, '重放应返回首次响应快照且不调用连接器');
      const payloadConflict = await request('POST', '/api/procurement/suppliers/sync', { token: manager.token, body: { idempotencyKey: 'sync-atomic', mode: 'changed' } });
      assert.equal(payloadConflict.status, 409);
      assert.equal(payloadConflict.body['code'], 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(JSON.stringify(payloadConflict.body).includes('must-not-be-called'), false);

      supplierProvider = async () => masters;
      const second = await request('POST', '/api/procurement/suppliers/sync', { token: manager.token, body: { idempotencyKey: 'sync-2' } });
      assert.equal(second.body['unchanged'], 1); assert.equal(second.body['updated'], 0);
      masters.items[0] = { externalId: 'odoo-partner-88', name: 'ERP 供应商（更新）', currency: 'CNY', contacts: [{ name: '主联系人', email: 'erp@example.com', phone: '' }], countryCode: 'CN', countryName: '中国', city: '苏州', street: '工业园区采购路 18 号', postalCode: '215000', status: 'active', sourceSystem: 'odoo' };
      const third = await request('POST', '/api/procurement/suppliers/sync', { token: manager.token, body: { idempotencyKey: 'sync-3' } });
      assert.equal(third.body['updated'], 1);
      assert.equal(third.body['items'][0].version, 2);

      const crossTenant = await request('POST', '/api/procurement/suppliers/sync', { token: tenantBManagerToken, body: { idempotencyKey: 'sync-atomic' } });
      assert.equal(crossTenant.status, 200);
      assert.equal(crossTenant.body['created'], 1);
      assert.equal(store.db.prepare("SELECT version FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?").get('tenant:b', 'supplier:odoo:88') !== undefined, true);

      supplierProvider = async () => ({
        items: [
          { ...masters.items[0]!, externalId: '' },
          { ...masters.items[0]!, externalId: 'odoo-partner-0' },
          { ...masters.items[0]!, externalId: 'token=invalid-external-id-secret' },
          { ...masters.items[0]!, externalId: 'odoo-partner-99', name: '有效供应商' },
        ],
        issues: [],
      });
      const invalidIds = await request('POST', '/api/procurement/suppliers/sync', { token: manager.token, body: { idempotencyKey: 'sync-invalid-ids' } });
      assert.equal(invalidIds.status, 200);
      assert.equal(invalidIds.body['created'], 1);
      assert.equal(invalidIds.body['issues'].filter((issue: Record<string, unknown>) => issue['reason'] === 'invalid_external_id').length, 3);
      assert.equal(JSON.stringify(invalidIds.body).includes('invalid-external-id-secret'), false);
      assert.equal(store.db.prepare("SELECT 1 FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND external_id='' ").get('t:acme'), undefined);

      supplierProvider = async () => { throw new Error('authorization=Bearer integration-secret password=hunter2'); };
      const integrationFailure = await request('POST', '/api/procurement/suppliers/sync', { token: manager.token, body: { idempotencyKey: 'sync-provider-error' } });
      assert.equal(integrationFailure.status, 502);
      assert.equal(integrationFailure.body['code'], 'ODOO_SYNC_FAILED');
      assert.equal(JSON.stringify(integrationFailure.body).includes('integration-secret'), false);
      assert.equal(JSON.stringify(integrationFailure.body).includes('hunter2'), false);

      supplierProvider = undefined;
      const replayWithoutProvider = await request('POST', '/api/procurement/suppliers/sync', { token: manager.token, body: { idempotencyKey: 'sync-atomic' } });
      assert.deepEqual(replayWithoutProvider, first);
      const versionAfterReplay = store.db.prepare("SELECT version FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?").get('t:acme', 'supplier:odoo:88') as { version: number };
      assert.equal(versionAfterReplay.version, 2, '旧响应重放不得在当前供应商上新增版本');
      const unconfigured = await request('POST', '/api/procurement/suppliers/sync', { token: manager.token, body: { idempotencyKey: 'sync-4' } });
      assert.equal(unconfigured.status, 409);
    });

    await t.test('手工登记供应商要求 configure 权限、校验必要字段并使用原子幂等', async () => {
      const forbidden = await request('POST', '/api/procurement/suppliers', { token: buyer.token, body: manualSupplierBody() });
      assert.equal(forbidden.status, 403);
      assert.equal((await request('POST', '/api/procurement/suppliers', { token: manager.token, body: {} })).status, 400);
      assert.equal((await request('POST', '/api/procurement/suppliers', { token: manager.token, body: manualSupplierBody({ name: ' ' }) })).status, 422);
      assert.equal((await request('POST', '/api/procurement/suppliers', { token: manager.token, body: manualSupplierBody({ currency: 'CNY1' }) })).status, 422);
      assert.equal((await request('POST', '/api/procurement/suppliers', { token: manager.token, body: manualSupplierBody({ primaryContact: { name: '联系人', email: 'invalid-email' } }) })).status, 422);

      const concurrentBody = manualSupplierBody({ idempotencyKey: 'manual-supplier-concurrent', externalId: 'manual-acme-1' });
      const [first, second] = await Promise.all([
        request('POST', '/api/procurement/suppliers', { token: manager.token, body: concurrentBody }),
        request('POST', '/api/procurement/suppliers', { token: manager.token, body: concurrentBody }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [200, 201]);
      assert.equal(first.body['supplier']['id'], second.body['supplier']['id']);
      assert.equal(first.body['supplier']['status'], 'active');
      assert.equal(first.body['supplier']['currency'], 'CNY');
      assert.equal(first.body['supplier']['email'], 'contact@example.com');
      assert.equal(first.body['version'], 1);
      assert.equal(second.body['version'], 1);
      assert.equal([first.body['replayed'], second.body['replayed']].filter(Boolean).length, 1);

      const replay = await request('POST', '/api/procurement/suppliers', { token: manager.token, body: concurrentBody });
      assert.equal(replay.status, 200);
      assert.equal(replay.body['replayed'], true);
      assert.equal(replay.body['supplier']['id'], first.body['supplier']['id']);
      const conflict = await request('POST', '/api/procurement/suppliers', { token: manager.token, body: manualSupplierBody({ idempotencyKey: 'manual-supplier-concurrent', name: '不同载荷' }) });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body['code'], 'IDEMPOTENCY_KEY_REUSED');

      const sameExternalUpdate = await request('POST', '/api/procurement/suppliers', {
        token: manager.token,
        body: manualSupplierBody({ idempotencyKey: 'manual-supplier-update', externalId: 'manual-acme-1', name: '手工登记供应商（更正）', primaryContact: { name: '新联系人', email: 'updated@example.com' } }),
      });
      assert.equal(sameExternalUpdate.status, 201);
      assert.equal(sameExternalUpdate.body['supplier']['id'], first.body['supplier']['id']);
      assert.equal(sameExternalUpdate.body['supplier']['name'], '手工登记供应商（更正）');
      assert.equal(sameExternalUpdate.body['supplier']['email'], 'updated@example.com');
      assert.equal(sameExternalUpdate.body['version'], 2, '同一 manual externalId 采用更新语义');

      const crossTenant = await request('POST', '/api/procurement/suppliers', {
        token: tenantBManagerToken,
        body: manualSupplierBody({ idempotencyKey: 'manual-supplier-concurrent', externalId: 'manual-acme-1', name: 'B 租户供应商' }),
      });
      assert.equal(crossTenant.status, 201);
      assert.notEqual(crossTenant.body['supplier']['id'], first.body['supplier']['id']);
      const tenantBSuppliers = await request('GET', '/api/procurement/suppliers', { token: tenantBToken });
      assert.equal(tenantBSuppliers.body['items'].some((item: Record<string, unknown>) => item['name'] === 'B 租户供应商'), true);
      const tenantBSupplier = tenantBSuppliers.body['items'].find((item: Record<string, unknown>) => item['name'] === 'B 租户供应商');
      assert.equal(tenantBSupplier['sourceSystem'], 'manual');
      assert.equal(tenantBSupplier['externalId'], 'manual-acme-1');

      const safe = await request('POST', '/api/procurement/suppliers', {
        token: manager.token,
        body: manualSupplierBody({ idempotencyKey: 'manual-supplier-redacted', externalId: 'manual-acme-redacted', apiKey: 'must-not-leak', primaryContact: { name: '安全联系人', email: 'safe@example.com', token: 'must-not-leak-too' } }),
      });
      assert.equal(safe.status, 201);
      assert.equal(JSON.stringify(safe.body).includes('must-not-leak'), false);
      assert.equal(safe.body['supplier']['contacts'][0]['token'], undefined);
    });

    await t.test('添加供应商时主数据与 Operating Profile 在同一事务中提交或回滚', async () => {
      const body = manualSupplierBody({
        idempotencyKey: 'supplier-profile-create',
        externalId: 'SUP-PROFILE-001',
        name: '华东阀门制造',
        operatingProfile: operatingProfile(),
      });
      const created = await request('POST', '/api/procurement/suppliers', { token: manager.token, body });
      assert.equal(created.status, 201);
      assert.equal(created.body['supplier']['externalId'], 'SUP-PROFILE-001');
      assert.equal(created.body['profile']['supplierId'], created.body['supplier']['id']);
      assert.equal(created.body['profile']['route'], 'local');
      assert.equal(created.body['profile']['version'], 1);
      const supplierId = String(created.body['supplier']['id']);
      assert.deepEqual(getProcurementSupplierOperatingProfile(store.db, 't:acme', supplierId), created.body['profile']);
      assert.equal(listProcurementSupplierOperatingProfileEvents(store.db, 't:acme', supplierId).length, 1);

      store.db.exec(`CREATE TRIGGER fail_supplier_profile_create BEFORE INSERT ON procurement_supplier_operating_profiles
        WHEN NEW.primary_material_code='ROLLBACK-ME' BEGIN SELECT RAISE(ABORT, 'forced profile failure'); END`);
      try {
        const failed = await request('POST', '/api/procurement/suppliers', {
          token: manager.token,
          body: manualSupplierBody({
            idempotencyKey: 'supplier-profile-rollback',
            externalId: 'SUP-PROFILE-ROLLBACK',
            operatingProfile: operatingProfile({ primaryMaterialCode: 'ROLLBACK-ME' }),
          }),
        });
        assert.equal(failed.status, 500);
        assert.equal(store.db.prepare("SELECT 1 FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND external_id=?").get('t:acme', 'SUP-PROFILE-ROLLBACK'), undefined);
        assert.equal(store.db.prepare('SELECT 1 FROM supplier_sync_idempotency WHERE tenant_id=? AND idempotency_key=?').get('t:acme', 'supplier-profile-rollback'), undefined);
      } finally {
        store.db.exec('DROP TRIGGER fail_supplier_profile_create');
      }
    });

    await t.test('Operating Profile 严格校验国家、路线、类型、物料、交期和关键度', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['country', { countryCode: 'CHN' }],
        ['route', { route: 'overseas' }],
        ['type', { supplierType: 'broker' }],
        ['material', { primaryMaterialName: ' ' }],
        ['lead-time', { defaultLeadTimeDays: -1 }],
        ['criticality', { productCriticality: 'urgent' }],
      ];
      for (const [label, invalid] of cases) {
        const response = await request('POST', '/api/procurement/suppliers', {
          token: manager.token,
          body: manualSupplierBody({
            idempotencyKey: `supplier-profile-invalid-${label}`,
            externalId: `SUP-INVALID-${label}`,
            operatingProfile: operatingProfile(invalid),
          }),
        });
        assert.equal(response.status, 422, label);
        assert.equal(response.body['code'], 'INVALID_SUPPLIER_PROFILE', label);
        assert.equal(store.db.prepare("SELECT 1 FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND external_id=?").get('t:acme', `SUP-INVALID-${label}`), undefined, label);
      }
    });

    await t.test('编辑使用主数据与 Profile 双版本并保护 Odoo 权威字段', async () => {
      const created = await request('POST', '/api/procurement/suppliers', {
        token: manager.token,
        body: manualSupplierBody({ idempotencyKey: 'supplier-edit-create', externalId: 'SUP-EDIT-001', operatingProfile: operatingProfile() }),
      });
      const supplierId = String(created.body['supplier']['id']);
      const edited = await request('PATCH', `/api/procurement/suppliers/${encodeURIComponent(supplierId)}`, {
        token: manager.token,
        body: {
          expectedVersion: 1,
          expectedProfileVersion: 1,
          reason: '采购经理核验供应商经营资料后更新',
          name: '手工登记供应商（档案更新）',
          currency: 'USD',
          primaryContact: { name: '新联系人', email: 'new-contact@example.com', phone: '13900000000' },
          operatingProfile: operatingProfile({ route: 'unclassified', defaultLeadTimeDays: 28, productCriticality: 'medium' }),
        },
      });
      assert.equal(edited.status, 200);
      assert.equal(edited.body['version'], 2);
      assert.equal(edited.body['profile']['version'], 2);
      assert.equal(edited.body['profile']['route'], 'unclassified');
      assert.equal(edited.body['supplier']['name'], '手工登记供应商（档案更新）');

      const stale = await request('PATCH', `/api/procurement/suppliers/${encodeURIComponent(supplierId)}`, {
        token: manager.token,
        body: { expectedVersion: 1, expectedProfileVersion: 1, reason: '使用过期版本尝试覆盖供应商经营资料', operatingProfile: { route: 'import' } },
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.body['code'], 'SUPPLIER_VERSION_CONFLICT');
      assert.equal(stale.body['currentVersion'], 2);
      assert.equal(stale.body['currentProfileVersion'], 2);

      const protectedMaster = await request('PATCH', '/api/procurement/suppliers/supplier%3Aodoo%3A88', {
        token: manager.token,
        body: { expectedVersion: 2, expectedProfileVersion: 0, reason: '不得绕过 Odoo 同步修改权威字段', name: '本地覆盖 ERP 名称', operatingProfile: operatingProfile({ route: 'import' }) },
      });
      assert.equal(protectedMaster.status, 409);
      assert.equal(protectedMaster.body['code'], 'ODOO_AUTHORITATIVE_FIELD');
      assert.equal(getProcurementSupplierOperatingProfile(store.db, 't:acme', 'supplier:odoo:88'), null);

      const odooProfile = await request('PATCH', '/api/procurement/suppliers/supplier%3Aodoo%3A88', {
        token: manager.token,
        body: { expectedVersion: 2, expectedProfileVersion: 0, reason: '仅补充 Readywork 经营属性作为风险证据', operatingProfile: operatingProfile({ route: 'import' }) },
      });
      assert.equal(odooProfile.status, 200);
      assert.equal(odooProfile.body['version'], 2, 'Operating Profile 更新不得伪造 Odoo 主数据新版本');
      assert.equal(odooProfile.body['profile']['route'], 'import');
    });

    await t.test('停用与重新启用是版本化加法事件，并保持租户隔离', async () => {
      const created = await request('POST', '/api/procurement/suppliers', {
        token: manager.token,
        body: manualSupplierBody({ idempotencyKey: 'supplier-status-create', externalId: 'SUP-STATUS-001', operatingProfile: operatingProfile() }),
      });
      const supplierId = String(created.body['supplier']['id']);
      lifecycleSupplierId = supplierId;
      const deactivatePath = `/api/procurement/suppliers/${encodeURIComponent(supplierId)}/deactivate`;
      const reactivatePath = `/api/procurement/suppliers/${encodeURIComponent(supplierId)}/reactivate`;
      assert.equal((await request('POST', deactivatePath, { token: buyer.token, body: { expectedVersion: 1, reason: '未经授权的停用请求必须被拒绝' } })).status, 403);
      const deactivated = await request('POST', deactivatePath, { token: manager.token, body: { expectedVersion: 1, reason: '年度供应商复审未通过，暂停新增采购' } });
      assert.equal(deactivated.status, 200);
      assert.equal(deactivated.body['profile']['status'], 'inactive');
      assert.equal(deactivated.body['profile']['version'], 2);
      assert.equal((await request('POST', reactivatePath, { token: manager.token, body: { expectedVersion: 1, reason: '使用旧版本不得重新启用供应商' } })).status, 409);
      assert.equal((await request('POST', deactivatePath, { token: tenantBManagerToken, body: { expectedVersion: 2, reason: '其他租户不得操作当前供应商资料' } })).status, 404);
      const reactivated = await request('POST', reactivatePath, { token: manager.token, body: { expectedVersion: 2, reason: '整改证据已复核，恢复供应商采购资格' } });
      assert.equal(reactivated.status, 200);
      assert.equal(reactivated.body['profile']['status'], 'active');
      assert.equal(reactivated.body['profile']['version'], 3);
      assert.deepEqual(listProcurementSupplierOperatingProfileEvents(store.db, 't:acme', supplierId).map((event) => event.version), [1, 2, 3]);
    });

    await t.test('供应商详情关联采购订单只使用不可变 supplierId，不按同名供应商猜测', async () => {
      const repository = createProcurementRepository(store.db, 't:acme');
      const twin: Supplier = {
        id: 'supplier:twin-name', tenantId: 't:acme', sourceSystem: 'manual', externalId: 'SUP-TWIN', status: 'active',
        createdAt: at, updatedAt: at, name: '供应商 A', currency: 'CNY', contacts: [],
      };
      repository.saveDocument('supplier', twin);
      const exactPo: PurchaseOrder = {
        id: 'po:supplier-a-exact', tenantId: 't:acme', sourceSystem: 'readywork', externalId: 'PO-SUPPLIER-A', status: 'draft',
        createdAt: at, updatedAt: at, supplierId: 'supplier:a', currency: 'CNY', orderedAt: at,
      };
      const twinPo: PurchaseOrder = { ...exactPo, id: 'po:twin-name', externalId: 'PO-TWIN', supplierId: twin.id };
      repository.saveDocument('purchase_order', exactPo);
      repository.saveDocument('purchase_order', twinPo);
      const detail = await request('GET', '/api/procurement/suppliers/supplier%3Aa', { token: buyer.token });
      assert.equal(detail.status, 200);
      assert.deepEqual(detail.body['purchaseOrders'].map((po: Record<string, unknown>) => po['id']), ['po:supplier-a-exact']);
      assert.equal((await request('GET', '/api/procurement/suppliers/supplier%3Atwin-name', { token: tenantBToken })).status, 404);
    });

    await t.test('空值、过期截止日、缺失采购申请或供应商给出清晰错误', async () => {
      assert.equal((await request('POST', '/api/procurement/rfqs', { token: buyer.token, body: {} })).status, 400);
      assert.equal((await request('POST', '/api/procurement/rfqs', { token: buyer.token, body: rfqBody({ idempotencyKey: 'past', deadline: '2020-01-01' }) })).status, 422);
      assert.equal((await request('POST', '/api/procurement/rfqs', { token: buyer.token, body: rfqBody({ idempotencyKey: 'missing-req', requisitionId: 'requisition:missing' }) })).status, 404);
      assert.equal((await request('POST', '/api/procurement/rfqs', { token: buyer.token, body: rfqBody({ idempotencyKey: 'missing-supplier', supplierIds: ['supplier:missing'] }) })).status, 404);
      const missingAttachment = await request('POST', '/api/procurement/rfqs', { token: buyer.token, body: rfqBody({ idempotencyKey: 'missing-attachment', attachmentIds: ['attachment:missing'] }) });
      assert.equal(missingAttachment.status, 422);
      assert.equal(missingAttachment.body['code'], 'RFQ_ATTACHMENT_MISMATCH');
      const crossTenantAttachment = await request('POST', '/api/procurement/rfqs', { token: buyer.token, body: rfqBody({ idempotencyKey: 'cross-tenant-attachment', attachmentIds: ['attachment:tenant:b:rfq-spec'] }) });
      assert.equal(crossTenantAttachment.status, 422);
      assert.equal(crossTenantAttachment.body['code'], 'RFQ_ATTACHMENT_MISMATCH');
    });

    await t.test('RFQ 与附件选择审计在同一事务中提交', async () => {
      store.db.exec(`CREATE TRIGGER fail_selected_attachment_audit BEFORE INSERT ON procurement_attachment_audit
        WHEN NEW.action='selected_for_rfq' BEGIN SELECT RAISE(ABORT, 'forced attachment audit failure'); END`);
      try {
        const failed = await request('POST', '/api/procurement/rfqs', {
          token: buyer.token,
          body: rfqBody({ idempotencyKey: 'rfq-atomic-audit-failure', externalId: 'RFQ-ATOMIC-AUDIT-FAIL' }),
        });
        assert.equal(failed.status, 500);
        const orphan = store.db.prepare("SELECT 1 FROM procurement_documents WHERE tenant_id=? AND kind='rfq' AND external_id=?")
          .get('t:acme', 'RFQ-ATOMIC-AUDIT-FAIL');
        assert.equal(orphan, undefined, '审计写入失败时 RFQ 和行也必须回滚');
        const idempotency = store.db.prepare("SELECT 1 FROM procurement_create_idempotency WHERE tenant_id=? AND kind='rfq' AND idempotency_key=?")
          .get('t:acme', 'rfq-atomic-audit-failure');
        assert.equal(idempotency, undefined);
      } finally {
        store.db.exec('DROP TRIGGER fail_selected_attachment_audit');
      }
    });

    await t.test('并发 RFQ 创建只生成一次，deadline 别名生效且行只从 Requisition 克隆', async () => {
      const [first, second] = await Promise.all([
        request('POST', '/api/procurement/rfqs', { token: buyer.token, body: rfqBody() }),
        request('POST', '/api/procurement/rfqs', { token: buyer.token, body: rfqBody() }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [200, 201]);
      const created = first.status === 201 ? first.body : second.body;
      rfqId = created['id'];
      rfqLineId = created['lines'][0].id;
      rfqVersion = created['version'];
      assert.ok(rfqId && rfqLineId);
      assert.equal(created['status'], 'draft');
      assert.equal(created['deadline'], '2027-01-15T00:00:00.000Z');
      assert.equal(created['lines'][0].requisitionLineId, 'requisition-line:rfq-api');
      assert.equal(created['lines'][0].itemCode, 'M6');
      assert.equal(created['lines'][0].itemName, 'M6 不锈钢螺栓');
      assert.equal(created['lines'][0].quantity, 100);
      assert.equal(created['lines'][0].unit, '件');
      assert.notEqual(created['lines'][0].itemCode, 'FORGED');
      assert.deepEqual(created['attachmentIds'], ['attachment:t:acme:rfq-spec']);
      assert.equal(created['attachments'].length, 1);
      assert.equal(created['attachments'][0].version, 1);
      assert.match(created['attachments'][0].sha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(created['lines'][0].attachmentIds, ['attachment:t:acme:rfq-spec']);
      assert.equal(created['lines'][0].attachments[0].sha256, created['attachments'][0].sha256);
      const selectedAudit = store.db.prepare(`SELECT action,detail_json FROM procurement_attachment_audit
        WHERE tenant_id=? AND attachment_id=? AND action='selected_for_rfq'`).all('t:acme', 'attachment:t:acme:rfq-spec') as Array<{ action: string; detail_json: string }>;
      assert.equal(selectedAudit.length, 1, '并发幂等重放不得重复写入附件选择审计');
      assert.equal(JSON.parse(selectedAudit[0]!.detail_json).rfqId, rfqId);
      const list = await request('GET', '/api/procurement/rfqs', { token: buyer.token });
      assert.equal(list.body['items'].filter((item: Record<string, unknown>) => item['id'] === rfqId).length, 1);
      const detail = await request('GET', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}`, { token: buyer.token });
      assert.equal(detail.status, 200);
      assert.equal(detail.body['id'], rfqId);
      assert.equal(detail.body['lines'][0].targetDate, '2027-02-01T00:00:00.000Z');
    });

    await t.test('入站邮件证据按邮件自然标识幂等落库，严格租户/供应商关联且不创建 Quote', async () => {
      const path = `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/communications/inbound-email`;
      const quoteCountBefore = Number((store.db.prepare("SELECT COUNT(*) AS count FROM procurement_documents WHERE tenant_id='t:acme' AND kind='quote'").get() as { count: number }).count);
      const first = await request('POST', path, { token: buyer.token, body: inboundEmailBody() });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body['replayed'], false);
      assert.equal(first.body['rfqId'], rfqId);
      assert.equal(first.body['supplierId'], 'supplier:a');
      assert.equal(first.body['messageId'], '<rfq-reply-4815@example.com>');
      assert.equal(first.body['receivedAt'], '2026-08-20T08:30:00.000Z');
      assert.equal(first.body['from'], '供应商 A <A@EXAMPLE.COM>');
      assert.equal(first.body['channel'], 'email');
      assert.equal('body' in first.body, false, '入站证据响应不得回显正文');

      const stored = store.db.prepare("SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='communication' AND id=?")
        .get('t:acme', first.body['id']) as { json: string };
      const persisted = JSON.parse(stored.json) as Record<string, unknown>;
      assert.equal(persisted['body'], '报价正文 token=inbound-body-secret');
      assert.equal(persisted['businessObjectId'], rfqId);
      assert.equal(persisted['businessObjectType'], 'rfq');
      assert.equal(persisted['direction'], 'inbound');

      const replay = await request('POST', path, { token: buyer.token, body: inboundEmailBody() });
      assert.equal(replay.status, 200);
      assert.equal(replay.body['replayed'], true);
      assert.equal(replay.body['id'], first.body['id']);
      assert.equal(Number((store.db.prepare("SELECT COUNT(*) AS count FROM procurement_documents WHERE tenant_id='t:acme' AND kind='communication'").get() as { count: number }).count), 1);

      const sameMessageOtherMailbox = await request('POST', path, {
        token: buyer.token,
        body: inboundEmailBody({ mailbox: 'archive@example.com/All Mail', uid: '9911' }),
      });
      assert.equal(sameMessageOtherMailbox.status, 200);
      assert.equal(sameMessageOtherMailbox.body['id'], first.body['id'], '同一 Message-ID 在其他邮箱/UID 出现不得重复建证据');

      const changedEvidence = await request('POST', path, { token: buyer.token, body: inboundEmailBody({ body: '同一 UID 的不同正文' }) });
      assert.equal(changedEvidence.status, 409);
      assert.equal(changedEvidence.body['code'], 'INBOUND_COMMUNICATION_IDENTITY_CONFLICT');

      const messageOnly = inboundEmailBody({ provider: undefined, mailbox: undefined, uid: undefined, messageId: '<message-only@example.com>' });
      const messageCreated = await request('POST', path, { token: buyer.token, body: messageOnly });
      assert.equal(messageCreated.status, 201);
      const messageReplay = await request('POST', path, { token: buyer.token, body: messageOnly });
      assert.equal(messageReplay.status, 200);
      assert.equal(messageReplay.body['id'], messageCreated.body['id']);

      const unknownField = await request('POST', path, { token: buyer.token, body: inboundEmailBody({ uid: 'unknown-field', apiKey: 'must-not-persist-or-echo' }) });
      assert.equal(unknownField.status, 422);
      assert.equal(JSON.stringify(unknownField.body).includes('must-not-persist-or-echo'), false);
      assert.equal(store.db.prepare("SELECT 1 FROM procurement_documents WHERE tenant_id=? AND kind='communication' AND json_extract(json,'$.uid')=?").get('t:acme', 'unknown-field'), undefined);

      const forgedSender = await request('POST', path, {
        token: buyer.token,
        body: inboundEmailBody({ uid: 'forged-sender', messageId: '<forged-sender@example.com>', from: '供应商 A <attacker@example.net>' }),
      });
      assert.equal(forgedSender.status, 422);
      assert.equal(forgedSender.body['code'], 'SUPPLIER_EMAIL_MISMATCH');
      assert.equal(store.db.prepare("SELECT 1 FROM procurement_documents WHERE tenant_id=? AND kind='communication' AND json_extract(json,'$.uid')=?").get('t:acme', 'forged-sender'), undefined);

      const malformedSender = await request('POST', path, {
        token: buyer.token,
        body: inboundEmailBody({ uid: 'malformed-sender', messageId: '<malformed-sender@example.com>', from: '不是邮箱地址' }),
      });
      assert.equal(malformedSender.status, 422);
      assert.equal(malformedSender.body['code'], 'SUPPLIER_EMAIL_MISMATCH');

      const outsider: Supplier = {
        id: 'supplier:outsider', tenantId: 't:acme', sourceSystem: 'erp', externalId: 'SUPPLIER-OUTSIDER', status: 'active',
        createdAt: at, updatedAt: at, name: '非 RFQ 候选供应商', currency: 'CNY', contacts: [],
      };
      createProcurementRepository(store.db, 't:acme').saveDocument('supplier', outsider);
      const mismatch = await request('POST', path, { token: buyer.token, body: inboundEmailBody({ uid: 'supplier-mismatch', messageId: '<supplier-mismatch@example.com>', supplierId: outsider.id }) });
      assert.equal(mismatch.status, 422);
      assert.equal(mismatch.body['code'], 'SUPPLIER_NOT_CANDIDATE');

      const tenantOnlySupplier: Supplier = {
        ...outsider, id: 'supplier:tenant-b-only', tenantId: 'tenant:b', externalId: 'SUPPLIER-TENANT-B-ONLY', name: 'B 租户供应商',
      };
      createProcurementRepository(store.db, 'tenant:b').saveDocument('supplier', tenantOnlySupplier);
      const crossSupplier = await request('POST', path, { token: buyer.token, body: inboundEmailBody({ uid: 'cross-supplier', messageId: '<cross-supplier@example.com>', supplierId: tenantOnlySupplier.id }) });
      assert.equal(crossSupplier.status, 404);
      assert.equal(crossSupplier.body['code'], 'SUPPLIER_NOT_FOUND');
      const crossRfq = await request('POST', path, { token: tenantBToken, body: inboundEmailBody({ uid: 'cross-rfq', messageId: '<cross-rfq@example.com>' }) });
      assert.equal(crossRfq.status, 404);
      assert.equal(crossRfq.body['code'], 'RFQ_NOT_FOUND');

      const quoteCountAfter = Number((store.db.prepare("SELECT COUNT(*) AS count FROM procurement_documents WHERE tenant_id='t:acme' AND kind='quote'").get() as { count: number }).count);
      assert.equal(quoteCountAfter, quoteCountBefore, '入站邮件只保存 communication，不创建 Quote');
    });

    await t.test('同键异载荷和外部 ID 重复均返回 409', async () => {
      const keyConflict = await request('POST', '/api/procurement/rfqs', { token: buyer.token, body: rfqBody({ title: '不同标题' }) });
      assert.equal(keyConflict.status, 409);
      assert.equal(keyConflict.body['code'], 'IDEMPOTENCY_KEY_REUSED');
      const externalConflict = await request('POST', '/api/procurement/rfqs', { token: buyer.token, body: rfqBody({ idempotencyKey: 'rfq-other-key', title: '另一张 RFQ' }) });
      assert.equal(externalConflict.status, 409);
      assert.equal(externalConflict.body['code'], 'EXTERNAL_ID_CONFLICT');
    });

    await t.test('Quote 校验候选供应商、RFQ 行和结构化字段', async () => {
      const notCandidate = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token, body: quoteBody(rfqLineId, 'supplier:missing') });
      assert.equal(notCandidate.status, 422);
      const badLine = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token, body: quoteBody('rfq-line:missing', 'supplier:a', { idempotencyKey: 'bad-line' }) });
      assert.equal(badLine.status, 404);
      const invalid = quoteBody(rfqLineId, 'supplier:a', { idempotencyKey: 'bad-quote' });
      (invalid['lines'] as Array<Record<string, unknown>>)[0]!['priceBasisQuantity'] = 0;
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token, body: invalid })).status, 422);
      const secretEvidence = quoteBody(rfqLineId, 'supplier:a', { idempotencyKey: 'secret-evidence', evidence: { communicationId: 'communication:1', apiKey: 'must-not-persist' } });
      const rejectedEvidence = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token, body: secretEvidence });
      assert.equal(rejectedEvidence.status, 422);
      assert.equal(JSON.stringify(rejectedEvidence.body).includes('must-not-persist'), false);
      const futureReceived = quoteBody(rfqLineId, 'supplier:a', { idempotencyKey: 'future-received', receivedAt: '2099-01-01' });
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token, body: futureReceived })).status, 422);
    });

    await t.test('Quote 并发幂等、证据脱敏、同键异载荷冲突', async () => {
      const quoteA = quoteBody(rfqLineId, 'supplier:a');
      (quoteA['lines'] as Array<Record<string, unknown>>)[0]!['promisedAt'] = '2027-04-22';
      const [first, second] = await Promise.all([
        request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token, body: quoteA }),
        request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token, body: quoteA }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [200, 201]);
      const created = first.status === 201 ? first.body : second.body;
      assert.equal(created['supplierName'], '供应商 A');
      assert.equal(created['evidence']['communicationId'], 'communication:supplier:a');
      assert.equal(created['lines'][0]['promisedAt'], '2027-04-22T00:00:00.000Z');
      assert.equal(created['lines'][0]['leadTimeDays'], 10);
      const changed = quoteBody(rfqLineId, 'supplier:a');
      (changed['lines'] as Array<Record<string, unknown>>)[0]!['unitPrice'] = 11;
      const conflict = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token, body: changed });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body['code'], 'IDEMPOTENCY_KEY_REUSED');
    });

    await t.test('逐行比较报告缺汇率错误，并清晰标记过期报价', async () => {
      const unknownTax = quoteBody(rfqLineId, 'supplier:b', {
        idempotencyKey: 'quote-tax-unknown', externalId: 'quote-tax-unknown',
      });
      delete (unknownTax['lines'] as Array<Record<string, unknown>>)[0]!['taxIncluded'];
      const unknownCreated = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token, body: unknownTax });
      assert.equal(unknownCreated.status, 201);
      assert.equal(unknownCreated.body['lines'][0]['taxIncluded'], undefined);
      assert.equal(unknownCreated.body['lines'][0]['taxStatus'], 'unknown');
      const quoteB = quoteBody(rfqLineId, 'supplier:b', { validUntil: '2026-09-15' });
      (quoteB['lines'] as Array<Record<string, unknown>>)[0]!['performanceScore'] = 100;
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token, body: quoteB })).status, 201);
      const baseComparison = {
        idempotencyKey: 'compare-rfq-1', expectedRfqVersion: rfqVersion,
        asOf: '2026-10-01', comparisonCurrency: 'CNY',
        rateSnapshot: { version: 'fx:token=must-not-leak', rates: {} },
        weights: { price: 0.5, leadTime: 0.2, paymentTerms: 0.1, performance: 0.2 }, ruleVersion: 'quote-v1',
      };
      const missingRate = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/compare`, { token: buyer.token, body: baseComparison });
      assert.equal(missingRate.status, 422);
      assert.equal(missingRate.body['code'], 'QUOTE_COMPARISON_FAILED');
      assert.equal(JSON.stringify(missingRate.body).includes('must-not-leak'), false);

      const compared = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/compare`, {
        token: buyer.token, body: { ...baseComparison, rateSnapshot: { version: 'fx-1', rates: { 'USD/CNY': 7.2 } } },
      });
      assert.equal(compared.status, 201, JSON.stringify(compared.body));
      assert.equal(compared.body['replayed'], false);
      assert.equal(compared.body['rfq']['status'], 'pending_award');
      rfqVersion = compared.body['rfq']['version'];
      assert.equal(compared.body['comparisonSnapshot']['lineComparisons'].length, 1);
      const result = compared.body['comparisonSnapshot']['lineComparisons'][0];
      assert.equal(result.recommendedSupplierId, 'supplier:a');
      const expired = result.quotes.find((quote: Record<string, unknown>) => quote['supplierId'] === 'supplier:b' && quote['eligibility'] === 'expired');
      assert.equal(expired.eligibility, 'expired');
      assert.match(expired.reason, /已过期/);
      const supplierA = result.quotes.find((quote: Record<string, unknown>) => quote['supplierId'] === 'supplier:a');
      assert.equal(supplierA.performanceScore, 95);
      assert.ok(supplierA.quoteId && supplierA.quoteLineId && supplierA.quoteVersion === 1, '快照必须冻结报价/报价行/version');
      assert.equal(expired.performanceScore, 85, '供应商伪造的 100 分不得进入比较');
      const taxReview = result.quotes.find((quote: Record<string, unknown>) => quote['taxStatus'] === 'unknown');
      assert.equal(taxReview.taxReviewRequired, true);
      assert.equal(taxReview.eligibility, 'tax_review_required');
      assert.equal(taxReview.totalCost, null);
      assert.notEqual(result.recommendedSupplierId, taxReview.supplierId);
      const replay = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/compare`, {
        token: buyer.token, body: { ...baseComparison, rateSnapshot: { version: 'fx-1', rates: { 'USD/CNY': 7.2 } } },
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body['replayed'], true);
      const detail = await request('GET', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}`, { token: buyer.token });
      assert.equal(detail.body['comparisonSnapshot']['id'], compared.body['comparisonSnapshot']['id'], '刷新详情应恢复不可变快照');
      const changed = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/compare`, {
        token: buyer.token, body: { ...baseComparison, ruleVersion: 'changed', rateSnapshot: { version: 'fx-1', rates: { 'USD/CNY': 7.2 } } },
      });
      assert.equal(changed.status, 409);
      assert.equal(changed.body['code'], 'IDEMPOTENCY_KEY_REUSED');
    });

    await t.test('定标只允许经理审批、严格接收冻结报价行并原子重放', async () => {
      const detail = await request('GET', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}`, { token: manager.token });
      const snapshot = detail.body['comparisonSnapshot'];
      const line = snapshot['lineComparisons'][0];
      const winner = line['quotes'].find((quote: Record<string, unknown>) => quote['supplierId'] === 'supplier:a');
      const expired = line['quotes'].find((quote: Record<string, unknown>) => quote['supplierId'] === 'supplier:b');
      const baseAward = {
        expectedRfqVersion: rfqVersion,
        comparisonSnapshotId: snapshot['id'],
        reason: '综合成本与交期最优',
        lines: [{ rfqLineId: line['rfqLineId'], quoteLineId: winner['quoteLineId'], awardedQuantity: 100 }],
      };
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: buyer.token, body: { ...baseAward, idempotencyKey: 'award-buyer' } })).status, 403);
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: manager.token, body: { ...baseAward, idempotencyKey: 'award-empty', lines: [] } })).status, 422);
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: manager.token, body: { ...baseAward, idempotencyKey: 'award-no-reason', reason: undefined } })).status, 422);
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: manager.token, body: { ...baseAward, idempotencyKey: 'award-forged', approvedBy: 'h:forged' } })).status, 422);
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: manager.token, body: { ...baseAward, idempotencyKey: 'award-price', price: 0 } })).status, 422);
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: manager.token, body: { ...baseAward, idempotencyKey: 'award-expired', lines: [{ rfqLineId: line['rfqLineId'], quoteLineId: expired['quoteLineId'], awardedQuantity: 100 }] } })).status, 422);
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: tenantBManagerToken, body: { ...baseAward, idempotencyKey: 'award-tenant-b' } })).status, 404);

      const [first, second] = await Promise.all([
        request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: manager.token, body: { ...baseAward, idempotencyKey: 'award-atomic-a' } }),
        request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: manager.token, body: { ...baseAward, idempotencyKey: 'award-atomic-b' } }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [201, 409]);
      const created = first.status === 201 ? first : second;
      const createdKey = first.status === 201 ? 'award-atomic-a' : 'award-atomic-b';
      assert.equal(created.body['award']['approvedBy'], 'h:procurement-manager');
      assert.equal(created.body['rfq']['status'], 'awarded');
      assert.equal(created.body['purchaseOrders'].length, 1);
      const replay = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: manager.token, body: { ...baseAward, idempotencyKey: createdKey } });
      assert.equal(replay.status, 200);
      assert.equal(replay.body['replayed'], true);
      const conflict = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/award`, { token: manager.token, body: { ...baseAward, idempotencyKey: createdKey, reason: '不同理由' } });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body['code'], 'IDEMPOTENCY_KEY_REUSED');
    });

    await t.test('多行定标拒绝部分行，并按供应商拆分草稿 PO', async () => {
      const createdRfq = await request('POST', '/api/procurement/rfqs', { token: buyer.token, body: awardRfqBody() });
      assert.equal(createdRfq.status, 201);
      const awardRfqId = createdRfq.body['id'];
      const [firstLine, secondLine] = createdRfq.body['lines'];
      const quoteA = quoteBody(firstLine['id'], 'supplier:a', { idempotencyKey: 'award-quote-a' });
      const quoteB = quoteBody(secondLine['id'], 'supplier:b', { idempotencyKey: 'award-quote-b', currency: 'USD' });
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(awardRfqId)}/quotes`, { token: buyer.token, body: quoteA })).status, 201);
      assert.equal((await request('POST', `/api/procurement/rfqs/${encodeURIComponent(awardRfqId)}/quotes`, { token: buyer.token, body: quoteB })).status, 201);
      const compared = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(awardRfqId)}/compare`, {
        token: buyer.token,
        body: { idempotencyKey: 'award-compare', expectedRfqVersion: createdRfq.body['version'], asOf: '2026-08-21', comparisonCurrency: 'CNY', rateSnapshot: { version: 'fx-award', rates: { 'USD/CNY': 7.2 } }, weights: { price: 1, leadTime: 0, paymentTerms: 0, performance: 0 }, ruleVersion: 'award-v1' },
      });
      assert.equal(compared.status, 201, JSON.stringify(compared.body));
      const snapshot = compared.body['comparisonSnapshot'];
      const selected = snapshot['lineComparisons'].map((line: Record<string, unknown>) => {
        const quote = (line['quotes'] as Array<Record<string, unknown>>).find((item) => item['eligibility'] === 'eligible')!;
        return { rfqLineId: line['rfqLineId'], quoteLineId: quote['quoteLineId'], awardedQuantity: 100 };
      });
      const partial = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(awardRfqId)}/award`, {
        token: manager.token,
        body: { idempotencyKey: 'award-partial', expectedRfqVersion: compared.body['rfq']['version'], comparisonSnapshotId: snapshot['id'], reason: '人工逐行定标', lines: [selected[0]] },
      });
      assert.equal(partial.status, 422);
      assert.equal(partial.body['code'], 'AWARD_LINE_SET_MISMATCH');
      const wrongRelation = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(awardRfqId)}/award`, {
        token: manager.token,
        body: { idempotencyKey: 'award-wrong-relation', expectedRfqVersion: compared.body['rfq']['version'], comparisonSnapshotId: snapshot['id'], reason: '人工逐行定标', lines: [{ ...selected[0], quoteLineId: selected[1]!.quoteLineId }, { ...selected[1], quoteLineId: selected[0]!.quoteLineId }] },
      });
      assert.equal(wrongRelation.status, 422);
      assert.equal(wrongRelation.body['code'], 'QUOTE_NOT_ELIGIBLE');
      const awarded = await request('POST', `/api/procurement/rfqs/${encodeURIComponent(awardRfqId)}/award`, {
        token: manager.token,
        body: { idempotencyKey: 'award-split', expectedRfqVersion: compared.body['rfq']['version'], comparisonSnapshotId: snapshot['id'], reason: '两行按各自最优合格报价定标', lines: selected },
      });
      assert.equal(awarded.status, 201, JSON.stringify(awarded.body));
      assert.equal(awarded.body['purchaseOrders'].length, 2);
      assert.deepEqual(awarded.body['purchaseOrders'].map((po: Record<string, unknown>) => po['supplierId']).sort(), ['supplier:a', 'supplier:b']);
      assert.ok(awarded.body['purchaseOrders'].every((po: Record<string, unknown>) => po['status'] === 'draft'));
      assert.ok(awarded.body['purchaseOrders'].every((po: Record<string, unknown>) => typeof po['supplierName'] === 'string' && typeof po['total'] === 'number'));
    });

    await t.test('Quote 列表平铺，跨租户 RFQ/Quote/compare 全部隐藏为 404', async () => {
      const quotes = await request('GET', `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`, { token: buyer.token });
      assert.equal(quotes.status, 200);
      assert.equal(quotes.body['items'].length, 3);
      for (const path of [
        `/api/procurement/rfqs/${encodeURIComponent(rfqId)}`,
        `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/quotes`,
        `/api/procurement/rfqs/${encodeURIComponent(rfqId)}/compare`,
      ]) {
        const response = await request(path.endsWith('/compare') ? 'POST' : 'GET', path, {
          token: tenantBToken,
          ...(path.endsWith('/compare') ? { body: { asOf: '2026-10-01', comparisonCurrency: 'CNY', rateSnapshot: { version: 'fx', rates: {} }, weights: { price: 1, leadTime: 0, paymentTerms: 0, performance: 0 }, ruleVersion: 'v1' } } : {}),
        });
        assert.equal(response.status, 404);
      }
    });

    await t.test('供应商完整生命周期关闭并重开临时 SQLite 后仍保持精确版本、状态、事件与租户隔离', async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      serverClosed = true;
      store.close();
      storeClosed = true;
      const reopened = openPersistence(dbPath, { tenantId: 'tenant:bootstrap' });
      try {
        const masterRow = reopened.db.prepare("SELECT version,json FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?")
          .get('t:acme', lifecycleSupplierId) as { version: number; json: string };
        const master = JSON.parse(masterRow.json) as Supplier;
        assert.equal(masterRow.version, 3);
        assert.equal(master.status, 'active');
        const profile = getProcurementSupplierOperatingProfile(reopened.db, 't:acme', lifecycleSupplierId);
        assert.equal(profile?.version, 3);
        assert.equal(profile?.status, 'active');
        assert.deepEqual(listProcurementSupplierOperatingProfileEvents(reopened.db, 't:acme', lifecycleSupplierId).map((event) => event.version), [1, 2, 3]);
        assert.equal(getProcurementSupplierOperatingProfile(reopened.db, 'tenant:b', lifecycleSupplierId), null);
        assert.equal(reopened.db.prepare("SELECT 1 FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?")
          .get('tenant:b', lifecycleSupplierId), undefined);
      } finally {
        reopened.close();
      }
    });
  } finally {
    if (!serverClosed) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (!storeClosed) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
