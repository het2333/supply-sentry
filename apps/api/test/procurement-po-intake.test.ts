import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Supplier } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { ProcurementDocumentWorker } from '../src/procurement-document-worker.js';
import { handleProcurementPoIntakeRequest, persistInboundEmailAttachments } from '../src/procurement-po-intake.js';

const secret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
function token(tenantId: string, role: string): string {
  const session: Session = { username: role, tenantId, humanId: `human:${role}`, name: role, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

test('邮箱 PO Intake: 真实附件、ClamAV 门禁、人工核验、单事务生成 PO 与重启恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-po-intake-')); const dbPath = join(dir, 'intake.db'); const tenantId = 'tenant:po-intake';
  const store = openPersistence(dbPath, { tenantId }); const repository = createProcurementRepository(store.db, tenantId);
  const at = '2026-08-28T08:00:00.000Z';
  const supplier: Supplier = { id: 'supplier:intake', tenantId, sourceSystem: 'odoo', externalId: 'SUP-INTAKE', status: 'active', createdAt: at, updatedAt: at, name: '真实测试供应商', currency: 'CNY', contacts: [] };
  repository.saveDocument('supplier', supplier);
  const email = { id: 'uid-9001', from: 'buyer@customer.example', subject: '已批准 PO-2026-0828', body: '请核验附件', receivedAt: at, messageId: '<po-2026-0828@customer.example>', attachments: [{ filename: 'PO-2026-0828.txt', contentType: 'text/plain', content: Buffer.from('PO: PO-2026-0828\nITEM: VALVE-01\nQTY: 25 EA\nUNIT PRICE: 88.50 CNY\n') }] } as const;
  const first = persistInboundEmailAttachments({ db: store.db, tenantId, provider: 'imap', mailbox: 'INBOX', email, ownerType: 'po_intake' });
  assert.equal(first.candidateIds.length, 1); assert.equal(first.replayed, false);
  const replay = persistInboundEmailAttachments({ db: store.db, tenantId, provider: 'imap', mailbox: 'INBOX', email, ownerType: 'po_intake' });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.candidateIds, first.candidateIds);
  assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_attachments WHERE tenant_id=?`).get(tenantId) as { count: number }).count, 1);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1'); const authorization = req.headers['authorization']; const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleProcurementPoIntakeRequest(req, res, url.pathname, req.method ?? 'GET', { db: store.db, session: resolveSession(bearer), now: () => new Date('2026-08-28T09:00:00.000Z') })
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error: unknown) => res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const manager = token(tenantId, '采购经理'); const buyer = token(tenantId, '采购专员');
  async function request(path: string, options: { method?: string; token?: string; body?: Record<string, unknown> } = {}) { const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}) }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) }); return { status: response.status, body: await response.json() as Record<string, any> }; }

  try {
    assert.equal((await request('/api/procurement/po-intake')).status, 401);
    const before = await request('/api/procurement/po-intake', { token: manager }); assert.equal(before.status, 200); assert.equal(before.body['items'][0]['status'], 'scanning');
    const blocked = await request(`/api/procurement/po-intake/${encodeURIComponent(first.candidateIds[0]!)}/accept`, { method: 'POST', token: manager, body: { expectedVersion: before.body['items'][0]['version'], purchaseOrderNumber: 'PO-2026-0828', supplierId: supplier.id, currency: 'CNY', orderedAt: at, lines: [{ itemId: 'VALVE-01', orderedQty: 25, uom: 'EA', unitPrice: 88.5 }] } });
    assert.equal(blocked.status, 422); assert.equal(blocked.body['code'], 'PO_INTAKE_NOT_READY');

    store.db.prepare(`UPDATE procurement_document_jobs SET available_at='1970-01-01T00:00:00.000Z' WHERE tenant_id=?`).run(tenantId);
    const worker = new ProcurementDocumentWorker(store.db, { malwareScanner: async () => ({ status: 'clean', engine: 'clamav', detail: 'stream: OK' }) });
    const processed = await worker.runTenant(tenantId); assert.equal(processed.completed, 1);
    const ready = await request('/api/procurement/po-intake', { token: manager }); const candidate = ready.body['items'][0];
    assert.equal(candidate['status'], 'needs_review'); assert.equal(candidate['attachment']['securityStatus'], 'clean'); assert.equal(candidate['attachment']['processingStatus'], 'parsed');
    const missingRihd = await request(`/api/procurement/po-intake/${encodeURIComponent(candidate['id'])}/accept`, { method: 'POST', token: manager, body: { expectedVersion: candidate['version'], purchaseOrderNumber: 'PO-2026-0828', supplierId: supplier.id, currency: 'CNY', orderedAt: at, lines: [{ lineNumber: '10', itemId: 'VALVE-01', orderedQty: 25, uom: 'EA', unitPrice: 88.5 }] } });
    assert.equal(missingRihd.status, 422); assert.equal(missingRihd.body['code'], 'INVALID_PO_INTAKE'); assert.match(String(missingRihd.body['error']), /requestedAt/);
    const body = { expectedVersion: candidate['version'], purchaseOrderNumber: 'PO-2026-0828', supplierId: supplier.id, currency: 'CNY', orderedAt: at, lines: [{ lineNumber: '10', itemId: 'VALVE-01', description: '控制阀', orderedQty: 25, uom: 'EA', unitPrice: 88.5, requestedAt: '2026-09-15' }] };
    assert.equal((await request(`/api/procurement/po-intake/${encodeURIComponent(candidate['id'])}/accept`, { method: 'POST', token: buyer, body })).status, 403);
    const accepted = await request(`/api/procurement/po-intake/${encodeURIComponent(candidate['id'])}/accept`, { method: 'POST', token: manager, body });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body)); assert.equal(accepted.body['purchaseOrder']['status'], 'draft'); assert.equal(accepted.body['lines'].length, 1);
    const poId = accepted.body['purchaseOrder']['id'];
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=? AND aggregate_id=?`).get(tenantId, poId) as { count: number }).count, 0, '接受 Intake 不得发邮件或创建 Outbox');
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND event_type='email_intake_accepted'`).get(tenantId, poId) as { count: number }).count, 1);
    const acceptedReplay = await request(`/api/procurement/po-intake/${encodeURIComponent(candidate['id'])}/accept`, { method: 'POST', token: manager, body });
    assert.equal(acceptedReplay.status, 200); assert.equal(acceptedReplay.body['replayed'], true); assert.equal(acceptedReplay.body['purchaseOrder']['id'], poId);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); store.close(); }

  const reopened = openPersistence(dbPath, { tenantId });
  try {
    const candidate = reopened.db.prepare(`SELECT status,accepted_po_id FROM procurement_po_intake_candidates WHERE tenant_id=?`).get(tenantId) as { status: string; accepted_po_id: string };
    assert.equal(candidate.status, 'accepted');
    const po = reopened.db.prepare(`SELECT status,json FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, candidate.accepted_po_id) as { status: string; json: string };
    assert.equal(po.status, 'draft'); assert.equal(JSON.parse(po.json)['sourceSystem'], 'email-intake');
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('邮箱 PO Intake 对伪装可执行文件立即隔离，不创建文档任务', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:quarantine' });
  try {
    const result = persistInboundEmailAttachments({ db: store.db, tenantId: 'tenant:quarantine', provider: 'imap', mailbox: 'INBOX', ownerType: 'po_intake', email: { id: 'danger-1', from: 'x@example.com', subject: 'PO', body: '', receivedAt: new Date().toISOString(), attachments: [{ filename: 'po.pdf', contentType: 'application/pdf', content: Buffer.from('MZ executable') }] } });
    const row = store.db.prepare(`SELECT status,rejection_reason FROM procurement_po_intake_candidates WHERE tenant_id=? AND id=?`).get('tenant:quarantine', result.candidateIds[0]!) as { status: string; rejection_reason: string };
    assert.equal(row.status, 'rejected'); assert.match(row.rejection_reason, /可执行文件/);
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_document_jobs WHERE tenant_id=?`).get('tenant:quarantine') as { count: number }).count, 0);
  } finally { store.close(); }
});
