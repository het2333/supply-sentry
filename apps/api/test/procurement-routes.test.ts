import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Communication, PurchaseOrder, Supplier } from '@readywork/core';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { ProcurementDocumentWorker } from '../src/procurement-document-worker.js';
import { handleProcurementRouteRequest, recordSupplierEmailRouteAssignment } from '../src/procurement-routes.js';
import { handleProcurementWorkbenchRequest } from '../src/procurement-workbench.js';

const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
function token(tenantId: string, role: string, humanId: string): string {
  const session: Session = { username: humanId, tenantId, humanId, name: humanId, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}
function evidence(type: 'contract' | 'incoterm' | 'erp_field' | 'manual_review', reference: string, reason?: string): Record<string, unknown> {
  return { type, reference, ...(reason ? { reason } : {}) };
}
function textFile(value: string): string { return Buffer.from(value, 'utf8').toString('base64'); }

test('供应商邮件路线: 明确原文可幂等写入，冲突与跨 PO 证据不会覆写', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:email-route' });
  const tenantId = store.tenantId;
  const at = '2026-09-08T08:00:00.000Z';
  const supplier: Supplier = {
    id: 'supplier:email-route', tenantId, sourceSystem: 'odoo', externalId: 'SUP-EMAIL-ROUTE', status: 'active',
    createdAt: at, updatedAt: at, name: '邮件路线供应商', currency: 'CNY', contacts: [],
  };
  const po: PurchaseOrder = {
    id: 'po:email-route', tenantId, sourceSystem: 'odoo', externalId: 'PO-EMAIL-ROUTE', status: 'confirmed',
    createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at,
  };
  const otherPo: PurchaseOrder = { ...po, id: 'po:email-route:other', externalId: 'PO-EMAIL-ROUTE-OTHER' };
  const communication = (id: string, body: string): Communication => ({
    id, tenantId, sourceSystem: 'imap:test', externalId: `uid:${id}`, status: 'received', createdAt: at, updatedAt: at,
    businessObjectId: po.id, businessObjectType: 'purchase_order', supplierId: supplier.id,
    channel: 'email', direction: 'inbound', provider: 'imap:test', mailbox: 'INBOX', uid: `uid:${id}`,
    messageId: `<${id}@example.com>`, from: 'supplier@example.com', subject: `Re: ${po.externalId}`, body,
    attachmentIds: [], occurredAt: at, receivedAt: at,
  });
  store.procurement.saveDocument('supplier', supplier);
  store.procurement.saveDocument('purchase_order', po);
  store.procurement.saveDocument('purchase_order', otherPo);
  const localMail = communication('communication:email-route:local', '本订单为境内采购，由国内仓库发货。');
  const importMail = communication('communication:email-route:import', '本订单为进口采购，需要清关。');
  store.procurement.saveDocument('communication', localMail);
  store.procurement.saveDocument('communication', importMail);
  try {
    const applied = recordSupplierEmailRouteAssignment({
      db: store.db, tenantId, poId: po.id, communicationId: localMail.id, route: 'local',
      quote: '本订单为境内采购', model: 'deepseek-v4-flash', occurredAt: at,
    });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.assignment.route, 'local');
    assert.equal(applied.assignment.source, 'supplier_email_ai');
    assert.equal(applied.assignment.version, 1);
    assert.deepEqual(applied.assignment.evidence, {
      sourceType: 'supplier_email_ai', communicationId: localMail.id, quote: '本订单为境内采购',
      model: 'deepseek-v4-flash', purchaseOrderVersion: 1,
    });
    const replay = recordSupplierEmailRouteAssignment({
      db: store.db, tenantId, poId: po.id, communicationId: localMail.id, route: 'local',
      quote: '本订单为境内采购', model: 'deepseek-v4-flash', occurredAt: '2026-09-08T09:00:00.000Z',
    });
    assert.equal(replay.status, 'replayed');
    assert.equal(replay.assignment.version, 1);
    const conflict = recordSupplierEmailRouteAssignment({
      db: store.db, tenantId, poId: po.id, communicationId: importMail.id, route: 'import',
      quote: '本订单为进口采购', model: 'deepseek-v4-flash', occurredAt: at,
    });
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.assignment.route, 'local');
    assert.equal(store.db.prepare('SELECT route,version FROM procurement_route_assignments WHERE tenant_id=? AND po_id=?').get(tenantId, po.id)?.['version'], 1);
    assert.throws(() => recordSupplierEmailRouteAssignment({
      db: store.db, tenantId, poId: otherPo.id, communicationId: localMail.id, route: 'local',
      quote: '本订单为境内采购', model: 'deepseek-v4-flash', occurredAt: at,
    }), /邮件证据与采购订单或供应商不一致/);
  } finally { store.close(); }
});

test('采购路线: 有证据的人工分类、权限、版本冲突、租户隔离、审计和组合读模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-procurement-routes-'));
  const dbPath = join(dir, 'routes.db');
  const store = openPersistence(dbPath, { tenantId: 'tenant:routes' });
  const repository = createProcurementRepository(store.db, 'tenant:routes');
  const at = '2026-08-27T00:00:00.000Z';
  const supplier: Supplier = {
    id: 'supplier:routes', tenantId: 'tenant:routes', sourceSystem: 'odoo', externalId: 'SUP-ROUTES', status: 'active',
    createdAt: at, updatedAt: at, name: '路线验收供应商', currency: 'CNY', contacts: [],
    countryCode: 'CN', countryName: '中国', city: '上海', street: '浦东新区采购路 8 号', postalCode: '200120',
  };
  const po: PurchaseOrder = {
    id: 'po:routes', tenantId: 'tenant:routes', sourceSystem: 'odoo', externalId: 'PO-ROUTES', status: 'confirmed',
    createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at,
  };
  const unclassifiedPo: PurchaseOrder = { ...po, id: 'po:unclassified', externalId: 'PO-UNCLASSIFIED' };
  const reusableAttachmentPo: PurchaseOrder = { ...po, id: 'po:existing-attachment', externalId: 'PO-EXISTING-ATTACHMENT' };
  repository.saveDocument('supplier', supplier); repository.saveDocument('purchase_order', po); repository.saveDocument('purchase_order', unclassifiedPo); repository.saveDocument('purchase_order', reusableAttachmentPo);
  const reusableBytes = Buffer.from('Existing scanned PO contract attachment\nIncoterm: DDP Shanghai', 'utf8');
  const reusableAttachmentId = 'attachment:existing-route-evidence';
  const reusableSha256 = createHash('sha256').update(reusableBytes).digest('hex');
  store.db.prepare(`INSERT INTO procurement_attachments
    (tenant_id,id,requisition_id,requisition_line_id,owner_type,owner_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,
     extraction_status,extracted_text_preview,content,status,security_status,processing_status,detected_content_type,scan_error,parse_error,parsed_at,
     storage_backend,created_by,created_at)
    VALUES (?,?,?,NULL,'purchase_order',?,?,?,?,?,1,NULL,'extracted',?,?,'active','clean','parsed','text/plain',NULL,NULL,?,'sqlite',?,?)`)
    .run('tenant:routes', reusableAttachmentId, reusableAttachmentPo.id, reusableAttachmentPo.id, 'existing-contract.txt', 'text/plain',
      reusableBytes.length, reusableSha256, 'Existing scanned PO contract attachment', reusableBytes, at, 'human:buyer', at);
  const now = new Date('2026-08-27T12:00:00.000Z');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers['authorization']; const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const session = resolveSession(bearer); const method = req.method ?? 'GET';
    void handleProcurementRouteRequest(req, res, url.pathname, method, { db: store.db, session, now: () => now, clamAvConfigured: true })
      .then(async (handled) => handled || await handleProcurementWorkbenchRequest(req, res, url.pathname, method, { db: store.db, session }))
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error: unknown) => res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manager = token('tenant:routes', '采购经理', 'human:manager');
  const buyer = token('tenant:routes', '采购专员', 'human:buyer');
  async function request(path: string, options: { method?: string; token?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {}) {
    const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers,
    }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  let assignmentKeySequence = 0;
  function assign(purchaseOrderId: string, sessionToken: string, body: Record<string, unknown>, key = `route-assign:test:${++assignmentKeySequence}`) {
    return request(`/api/procurement/routes/${encodeURIComponent(purchaseOrderId)}/assign`, {
      method: 'POST', token: sessionToken, headers: { 'Idempotency-Key': key }, body,
    });
  }

  try {
    assert.equal((await request('/api/procurement/routes/assignments')).status, 401);
    assert.equal((await assign(po.id, buyer, { route: 'local', evidence: evidence('contract', 'CONTRACT-001', '采购合同约定境内交付'), expectedVersion: 0 })).status, 403);
    assert.equal((await assign(po.id, token('tenant:other', '采购经理', 'human:other'), { route: 'local', evidence: evidence('contract', 'CONTRACT-OTHER', '其他租户尝试'), expectedVersion: 0 })).status, 404);

    const invalidEvidence = await assign(po.id, manager, { route: 'local', evidence: { type: 'guess', reference: '' }, expectedVersion: 0 });
    assert.equal(invalidEvidence.status, 422); assert.equal(invalidEvidence.body['code'], 'INVALID_ROUTE_INPUT');
    const forgedErpEvidence = await assign(unclassifiedPo.id, manager, { route: 'local', evidence: evidence('erp_field', 'countryCode=CN'), expectedVersion: 0 });
    assert.equal(forgedErpEvidence.status, 422); assert.match(String(forgedErpEvidence.body['error']), /ERP 证据不存在/);

    const existingEvidencePath = `/api/procurement/routes/${encodeURIComponent(reusableAttachmentPo.id)}/evidence-documents`;
    assert.equal((await request(existingEvidencePath)).status, 401);
    const availableEvidence = await request(existingEvidencePath, { token: buyer });
    assert.equal(availableEvidence.status, 200, JSON.stringify(availableEvidence.body));
    assert.equal(availableEvidence.body['documents'].length, 0); assert.equal(availableEvidence.body['availableAttachments'].length, 1);
    const availableAttachment = availableEvidence.body['availableAttachments'][0];
    assert.equal(availableAttachment['id'], reusableAttachmentId); assert.equal(availableAttachment['eligible'], true);
    assert.equal(availableAttachment['version'], 1); assert.equal(availableAttachment['sha256'], reusableSha256);
    assert.match(String(availableAttachment['contentUrl']), /\/content$/);
    const bindPath = `${existingEvidencePath}/bind`;
    const bindBody = { evidenceType: 'contract', businessReference: 'EXISTING-CONTRACT-001', attachmentId: reusableAttachmentId,
      expectedAttachmentVersion: 1, expectedSha256: reusableSha256 };
    assert.equal((await request(bindPath, { method: 'POST', token: token('tenant:routes', '访客', 'human:viewer'), headers: { 'Idempotency-Key': 'bind-viewer' }, body: bindBody })).status, 403);
    assert.equal((await request(bindPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'bind-stale-version' }, body: { ...bindBody, expectedAttachmentVersion: 2 } })).status, 422);
    assert.equal((await request(`/api/procurement/routes/${encodeURIComponent('po:missing')}/evidence-documents/bind`, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'bind-missing-po' }, body: bindBody })).status, 404);
    const bound = await request(bindPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'bind-existing-attachment' }, body: bindBody });
    assert.equal(bound.status, 201, JSON.stringify(bound.body)); assert.equal(bound.body['item']['attachmentId'], reusableAttachmentId); assert.equal(bound.body['item']['status'], 'active');
    const boundReplay = await request(bindPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'bind-existing-attachment' }, body: bindBody });
    assert.equal(boundReplay.status, 200); assert.equal(boundReplay.body['replayed'], true); assert.equal(boundReplay.body['item']['id'], bound.body['item']['id']);
    const boundConflict = await request(bindPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'bind-existing-attachment' }, body: { ...bindBody, businessReference: 'DIFFERENT-CONTRACT' } });
    assert.equal(boundConflict.status, 409); assert.equal(boundConflict.body['code'], 'ROUTE_EVIDENCE_IDEMPOTENCY_CONFLICT');
    const duplicateBinding = await request(bindPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'bind-existing-attachment-again' }, body: bindBody });
    assert.equal(duplicateBinding.status, 409); assert.equal(duplicateBinding.body['code'], 'ROUTE_EVIDENCE_VERSION_CONFLICT');

    const afterBinding = await request(existingEvidencePath, { token: buyer });
    assert.equal(afterBinding.body['availableAttachments'].length, 0); assert.equal(afterBinding.body['documents'].length, 1);
    assert.equal(afterBinding.body['events'][0]['action'], 'existing_attachment_bound');
    const reuseWorkbench = await request('/api/procurement/workbench?limit=100', { token: buyer });
    const reuseItem = (reuseWorkbench.body['portfolio']['items'] as Array<Record<string, any>>).find((candidate) => candidate['id'] === reusableAttachmentPo.id)!;
    const reuseCandidate = (reuseItem['routeEvidenceCandidates'] as Array<Record<string, any>>).find((candidate) => candidate['fields']['documentId'] === bound.body['item']['id'])!;
    assert.equal(reuseCandidate['eligible'], true); assert.equal(reuseCandidate['fields']['documentVersion'], 1);
    const reuseAssigned = await assign(reusableAttachmentPo.id, manager,
      { route: 'local', evidence: evidence('contract', String(reuseCandidate['reference']), '采购经理核验已有合同附件'), expectedVersion: 0 });
    assert.equal(reuseAssigned.status, 201, JSON.stringify(reuseAssigned.body));
    const revokePath = `${existingEvidencePath}/${encodeURIComponent(String(bound.body['item']['id']))}`;
    const revokeBody = { expectedVersion: 1, reason: '合同附件被确认不是当前交易的有效路线依据' };
    assert.equal((await request(revokePath, { method: 'DELETE', token: buyer, headers: { 'Idempotency-Key': 'revoke-buyer' }, body: revokeBody })).status, 403);
    const staleRevoke = await request(revokePath, { method: 'DELETE', token: manager, headers: { 'Idempotency-Key': 'revoke-stale' }, body: { ...revokeBody, expectedVersion: 2 } });
    assert.equal(staleRevoke.status, 409); assert.equal(staleRevoke.body['currentVersion'], 1);
    const revoked = await request(revokePath, { method: 'DELETE', token: manager, headers: { 'Idempotency-Key': 'revoke-existing-attachment' }, body: revokeBody });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body)); assert.equal(revoked.body['item']['status'], 'revoked'); assert.equal(revoked.body['item']['version'], 2); assert.equal(revoked.body['routeUnclassified'], true);
    const revokeReplay = await request(revokePath, { method: 'DELETE', token: manager, headers: { 'Idempotency-Key': 'revoke-existing-attachment' }, body: revokeBody });
    assert.equal(revokeReplay.status, 200); assert.equal(revokeReplay.body['replayed'], true);
    const assignmentCount = store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_assignments WHERE tenant_id=? AND po_id=?`)
      .get('tenant:routes', reusableAttachmentPo.id) as { count: number };
    assert.equal(assignmentCount.count, 0);
    const reuseRouteEvents = store.db.prepare(`SELECT action FROM procurement_route_events WHERE tenant_id=? AND po_id=? ORDER BY created_at,rowid`).all('tenant:routes', reusableAttachmentPo.id) as Array<{ action: string }>;
    assert.deepEqual(reuseRouteEvents.map((event) => event.action), ['route_assigned', 'route_unclassified_due_to_evidence_revocation']);

    const forgedContract = await assign(po.id, manager, { route: 'local', evidence: evidence('contract', 'CONTRACT-001', '只有合同号，没有受控文件'), expectedVersion: 0 });
    assert.equal(forgedContract.status, 422); assert.match(String(forgedContract.body['error']), /有效文件/);
    const uploadPath = `/api/procurement/routes/${encodeURIComponent(po.id)}/evidence-documents`;
    const contractBody = { evidenceType: 'contract', businessReference: 'CONTRACT-001', fileName: 'route-contract.txt', contentType: 'text/plain', contentBase64: textFile('Readywork route contract V1\nDelivery country: China') };
    assert.equal((await request(uploadPath, { method: 'POST', body: contractBody })).status, 401);
    assert.equal((await request(uploadPath, { method: 'POST', token: token('tenant:routes', '访客', 'human:viewer'), headers: { 'Idempotency-Key': 'route-upload-viewer' }, body: contractBody })).status, 403);
    assert.equal((await request(uploadPath, { method: 'POST', token: token('tenant:other', '采购专员', 'human:other'), headers: { 'Idempotency-Key': 'route-upload-other' }, body: contractBody })).status, 404);
    const oversized = await request(uploadPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'route-upload-oversized' }, body: { ...contractBody, fileName: 'oversized.txt', contentBase64: Buffer.alloc(8 * 1024 * 1024 + 1, 65).toString('base64') } });
    assert.equal(oversized.status, 422); assert.match(String(oversized.body['error']), /8 MB/);

    const unsafe = await request(uploadPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'route-upload-unsafe' }, body: { ...contractBody, fileName: 'contract-malware.pdf', contentType: 'application/pdf', contentBase64: Buffer.from([0x4d, 0x5a, 0x90, 0x00]).toString('base64') } });
    assert.equal(unsafe.status, 201, JSON.stringify(unsafe.body)); assert.equal(unsafe.body['item']['securityStatus'], 'quarantined'); assert.equal(unsafe.body['item']['processingStatus'], 'parse_failed');

    const uploaded = await request(uploadPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'route-upload-contract-v1' }, body: contractBody });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body)); assert.equal(uploaded.body['item']['securityStatus'], 'pending_scan'); assert.equal(uploaded.body['item']['processingStatus'], 'queued'); assert.equal(uploaded.body['clamAvConfigured'], true);
    const replay = await request(uploadPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'route-upload-contract-v1' }, body: contractBody });
    assert.equal(replay.status, 200); assert.equal(replay.body['replayed'], true); assert.equal(replay.body['item']['id'], uploaded.body['item']['id']);
    const conflictingReplay = await request(uploadPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'route-upload-contract-v1' }, body: { ...contractBody, contentBase64: textFile('different contract') } });
    assert.equal(conflictingReplay.status, 409); assert.equal(conflictingReplay.body['code'], 'ROUTE_EVIDENCE_IDEMPOTENCY_CONFLICT');

    let documentWorkbench = await request('/api/procurement/workbench?limit=100', { token: buyer });
    let documentItem = (documentWorkbench.body['portfolio']['items'] as Array<Record<string, any>>).find((candidate) => candidate['id'] === po.id)!;
    let documentCandidate = (documentItem['routeEvidenceCandidates'] as Array<Record<string, any>>).find((candidate) => candidate['fields']['fileName'] === 'route-contract.txt')!;
    assert.equal(documentCandidate['type'], 'route_document'); assert.equal(documentCandidate['evidenceType'], 'contract'); assert.equal(documentCandidate['eligible'], false);
    const pendingAssignment = await assign(po.id, manager, { route: 'local', evidence: evidence('contract', String(documentCandidate['reference']), '扫描尚未完成'), expectedVersion: 0 });
    assert.equal(pendingAssignment.status, 422); assert.match(String(pendingAssignment.body['error']), /ClamAV/);

    const worker = new ProcurementDocumentWorker(store.db, { malwareScanner: async () => ({ status: 'clean', engine: 'clamav', detail: 'clean test document' }) });
    const firstWorkerRun = await worker.runTenant('tenant:routes', 10);
    assert.equal(firstWorkerRun.completed, 1); assert.equal(firstWorkerRun.failed, 0);
    documentWorkbench = await request('/api/procurement/workbench?limit=100', { token: buyer });
    documentItem = (documentWorkbench.body['portfolio']['items'] as Array<Record<string, any>>).find((candidate) => candidate['id'] === po.id)!;
    documentCandidate = (documentItem['routeEvidenceCandidates'] as Array<Record<string, any>>).find((candidate) => candidate['fields']['fileName'] === 'route-contract.txt')!;
    assert.equal(documentCandidate['eligible'], true); assert.equal(documentCandidate['fields']['securityStatus'], 'clean'); assert.equal(documentCandidate['fields']['processingStatus'], 'parsed');
    const staleDocumentReference = String(documentCandidate['reference']);

    const replacementBody = { ...contractBody, contentBase64: textFile('Readywork route contract V2\nDelivery country: China') };
    const replaced = await request(uploadPath, { method: 'POST', token: buyer, headers: { 'Idempotency-Key': 'route-upload-contract-v2' }, body: replacementBody });
    assert.equal(replaced.status, 201); assert.equal(replaced.body['item']['attachmentVersion'], 2);
    const staleDocument = await assign(po.id, manager, { route: 'local', evidence: evidence('contract', staleDocumentReference, '尝试使用旧版本合同'), expectedVersion: 0 });
    assert.equal(staleDocument.status, 422);
    const secondWorkerRun = await worker.runTenant('tenant:routes', 10); assert.equal(secondWorkerRun.completed, 1);
    documentWorkbench = await request('/api/procurement/workbench?limit=100', { token: buyer });
    documentItem = (documentWorkbench.body['portfolio']['items'] as Array<Record<string, any>>).find((candidate) => candidate['id'] === po.id)!;
    documentCandidate = (documentItem['routeEvidenceCandidates'] as Array<Record<string, any>>).find((candidate) => candidate['fields']['fileName'] === 'route-contract.txt')!;
    assert.equal(documentCandidate['eligible'], true); assert.equal(documentCandidate['fields']['attachmentVersion'], 2);
    const typeMismatch = await assign(po.id, manager, { route: 'import', evidence: evidence('incoterm', String(documentCandidate['reference']), '合同不能冒充 Incoterm'), expectedVersion: 0 });
    assert.equal(typeMismatch.status, 422);

    const created = await assign(po.id, manager, { route: 'local', evidence: evidence('contract', String(documentCandidate['reference']), '采购合同约定境内交付'), expectedVersion: 0 });
    assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body['item']['route'], 'local'); assert.equal(created.body['item']['version'], 1);
    assert.equal(created.body['item']['evidence']['documentEvidence']['fields']['attachmentVersion'], 2);
    assert.equal(created.body['item']['evidence']['documentEvidence']['fields']['sha256'], replaced.body['item']['sha256']);
    assert.equal(created.body['item']['evidence']['documentEvidence']['purchaseOrderVersion'], 1);
    const duplicate = await assign(po.id, manager, { route: 'local', evidence: evidence('contract', String(documentCandidate['reference']), '重复旧版本'), expectedVersion: 0 });
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body['currentVersion'], 1);

    const forgedIncoterm = await assign(po.id, manager, { route: 'import', evidence: evidence('incoterm', 'INCOTERM-FOB-001', '只有贸易条款文本'), expectedVersion: 1 });
    assert.equal(forgedIncoterm.status, 422);
    const updated = await assign(po.id, manager, { route: 'import', evidence: evidence('manual_review', 'REVIEW-IMPORT-001', '人工复核贸易与交付事实后确认为跨境进口'), expectedVersion: 1 });
    assert.equal(updated.status, 200); assert.equal(updated.body['item']['route'], 'import'); assert.equal(updated.body['item']['version'], 2);
    assert.deepEqual((updated.body['events'] as Array<Record<string, unknown>>).map((event) => event['action']), ['route_assigned', 'route_reassigned']);

    store.db.prepare(`INSERT INTO procurement_import_document_policies
      (tenant_id,id,name,description,status,version,requirements_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
      VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?)`).run('tenant:routes', 'policy:import-gate', '进口单证门禁', '已发布的测试门禁', 'published', '[]', 'human:manager', 'human:manager', 'human:manager', at, at, at);
    const blockedDowngrade = await assign(po.id, manager, { route: 'local', evidence: evidence('manual_review', 'REVIEW-001', '尝试降级路线'), expectedVersion: 2 });
    assert.equal(blockedDowngrade.status, 409); assert.equal(blockedDowngrade.body['code'], 'IMPORT_ROUTE_DOWNGRADE_BLOCKED');

    const list = await request('/api/procurement/routes/assignments', { token: buyer });
    assert.equal(list.status, 200); assert.equal(list.body['items'].length, 1); assert.equal(list.body['items'][0]['purchaseOrderId'], po.id);
    const workbench = await request('/api/procurement/workbench?limit=100', { token: buyer });
    assert.equal(workbench.status, 200, JSON.stringify(workbench.body));
    const item = (workbench.body['portfolio']['items'] as Array<Record<string, any>>).find((candidate) => candidate['id'] === po.id)!;
    assert.equal(item['route'], 'import'); assert.equal(item['routeSource'], 'manual'); assert.equal(item['routeAssignmentVersion'], 2);
    assert.equal(workbench.body['portfolio']['metrics']['importProcurement'], 1); assert.equal(workbench.body['portfolio']['metrics']['unclassifiedRoute'], 2);
    const unclassifiedItem = (workbench.body['portfolio']['items'] as Array<Record<string, any>>).find((candidate) => candidate['id'] === unclassifiedPo.id)!;
    const erpCandidate = unclassifiedItem['routeEvidenceCandidates'][0] as Record<string, any>;
    assert.equal(erpCandidate['type'], 'erp_field');
    assert.deepEqual(erpCandidate['fields'], { countryCode: 'CN', countryName: '中国', city: '上海', street: '浦东新区采购路 8 号', postalCode: '200120' });
    assert.equal(erpCandidate['supplierVersion'], 1); assert.equal(erpCandidate['purchaseOrderVersion'], 1);
    const summary = workbench.body['portfolio']['routes']['import'];
    assert.equal(summary['high'] + summary['awaitingSupplier'] + summary['deliveryRisk'] + summary['onTrack'], summary['total'], '风险圆环必须使用互斥分桶');

    const classifiedFromErp = await assign(unclassifiedPo.id, manager, { route: 'local', evidence: evidence('erp_field', String(erpCandidate['reference']), '采购经理依据 Odoo 供应商地址确认境内路线'), expectedVersion: 0 });
    assert.equal(classifiedFromErp.status, 201, JSON.stringify(classifiedFromErp.body));
    assert.equal(classifiedFromErp.body['item']['evidence']['erpEvidence']['supplierVersion'], 1);
    assert.equal(classifiedFromErp.body['item']['evidence']['erpEvidence']['purchaseOrderVersion'], 1);
    assert.equal(classifiedFromErp.body['item']['evidence']['erpEvidence']['fields']['countryCode'], 'CN');

    const incotermPo: PurchaseOrder & { incotermId: number; incotermName: string; incotermLocation: string } = {
      ...po, id: 'po:incoterm', externalId: 'PO-INCOTERM', updatedAt: '2026-08-27T01:00:00.000Z',
      incotermId: 5, incotermName: 'FOB', incotermLocation: 'Shanghai Port',
    };
    repository.saveDocument('purchase_order', incotermPo);
    let incotermWorkbench = await request('/api/procurement/workbench?limit=100', { token: buyer });
    const incotermItem = (incotermWorkbench.body['portfolio']['items'] as Array<Record<string, any>>)
      .find((candidate) => candidate['id'] === incotermPo.id)!;
    const incotermCandidates = incotermItem['routeEvidenceCandidates'] as Array<Record<string, any>>;
    assert.equal(incotermCandidates[0]?.['sourceEntity'], 'purchase_order');
    assert.equal(incotermCandidates[0]?.['label'], 'Odoo PO Incoterm');
    assert.deepEqual(incotermCandidates[0]?.['fields'], { incotermId: 5, incotermName: 'FOB', incotermLocation: 'Shanghai Port' });
    assert.equal(incotermCandidates[0]?.['purchaseOrderVersion'], 1);
    assert.equal(incotermCandidates[1]?.['sourceEntity'], 'supplier', 'PO Incoterm 必须优先于供应商地址候选');

    repository.saveDocument('purchase_order', { ...incotermPo, updatedAt: '2026-08-27T02:00:00.000Z', incotermLocation: 'Ningbo Port' }, 1);
    const staleIncoterm = await assign(incotermPo.id, manager,
      { route: 'import', evidence: evidence('erp_field', String(incotermCandidates[0]?.['reference']), '依据 Odoo PO Incoterm 确认'), expectedVersion: 0 });
    assert.equal(staleIncoterm.status, 422); assert.match(String(staleIncoterm.body['error']), /版本已变更/);

    incotermWorkbench = await request('/api/procurement/workbench?limit=100', { token: buyer });
    const refreshedIncotermItem = (incotermWorkbench.body['portfolio']['items'] as Array<Record<string, any>>)
      .find((candidate) => candidate['id'] === incotermPo.id)!;
    const refreshedIncoterm = refreshedIncotermItem['routeEvidenceCandidates'][0] as Record<string, any>;
    assert.equal(refreshedIncoterm['purchaseOrderVersion'], 2);
    assert.equal(refreshedIncoterm['fields']['incotermLocation'], 'Ningbo Port');
    const classifiedFromIncoterm = await assign(incotermPo.id, manager,
      { route: 'import', evidence: evidence('erp_field', String(refreshedIncoterm['reference']), '依据 Odoo PO Incoterm 确认'), expectedVersion: 0 });
    assert.equal(classifiedFromIncoterm.status, 201, JSON.stringify(classifiedFromIncoterm.body));
    assert.deepEqual(classifiedFromIncoterm.body['item']['evidence']['erpEvidence']['fields'], { incotermId: 5, incotermName: 'FOB', incotermLocation: 'Ningbo Port' });
    assert.equal(classifiedFromIncoterm.body['item']['evidence']['erpEvidence']['purchaseOrderVersion'], 2);
    assert.equal(classifiedFromIncoterm.body['item']['evidence']['erpEvidence']['supplierVersion'], undefined);

    const eventCount = store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_events WHERE tenant_id=? AND po_id=?`).get('tenant:routes', po.id) as { count: number };
    assert.equal(Number(eventCount.count), 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); store.close();
  }

  const reopened = openPersistence(dbPath, { tenantId: 'tenant:routes' });
  try {
    const persisted = reopened.db.prepare(`SELECT route,version,updated_by FROM procurement_route_assignments WHERE tenant_id=? AND po_id=?`).get('tenant:routes', po.id) as { route: string; version: number; updated_by: string } | undefined;
    assert.equal(persisted?.route, 'import'); assert.equal(persisted?.version, 2); assert.equal(persisted?.updated_by, 'human:manager');
    const evidenceDocuments = reopened.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_evidence_documents WHERE tenant_id=? AND po_id=?`).get('tenant:routes', po.id) as { count: number };
    assert.equal(Number(evidenceDocuments.count), 3, '隔离文件与两个合同版本都必须在重启后保留审计事实');
    const activeEvidence = reopened.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_evidence_documents WHERE tenant_id=? AND po_id=? AND status='active'`).get('tenant:routes', po.id) as { count: number };
    assert.equal(Number(activeEvidence.count), 2, '被替换的同名文件绑定必须失效，隔离文件仍保留但不可选');
  } finally { reopened.close(); }
});

test('采购路线确认: 幂等键按租户持久重放、冲突并与业务事实同事务回滚', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-procurement-route-assignment-idempotency-'));
  const dbPath = join(dir, 'routes.db');
  const store = openPersistence(dbPath, { tenantId: 'tenant:route-idempotency-a' });
  const at = '2026-09-06T00:00:00.000Z';
  const basePo: PurchaseOrder = {
    id: 'po:route-idempotency', tenantId: 'tenant:route-idempotency-a', sourceSystem: 'odoo',
    externalId: 'PO-ROUTE-IDEMPOTENCY', status: 'confirmed', createdAt: at, updatedAt: at,
    supplierId: 'supplier:route-idempotency', currency: 'CNY', orderedAt: at,
  };
  const rollbackPo: PurchaseOrder = { ...basePo, id: 'po:route-idempotency-rollback', externalId: 'PO-ROUTE-ROLLBACK' };
  createProcurementRepository(store.db, 'tenant:route-idempotency-a').saveDocument('purchase_order', basePo);
  createProcurementRepository(store.db, 'tenant:route-idempotency-a').saveDocument('purchase_order', rollbackPo);
  createProcurementRepository(store.db, 'tenant:route-idempotency-b').saveDocument('purchase_order', {
    ...basePo, tenantId: 'tenant:route-idempotency-b',
  });
  const now = new Date('2026-09-06T10:00:00.000Z');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers['authorization'];
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    void handleProcurementRouteRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db, session: resolveSession(bearer), now: () => now,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error: unknown) => res.writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const managerA = token('tenant:route-idempotency-a', '采购经理', 'human:manager-a');
  const managerB = token('tenant:route-idempotency-b', '采购经理', 'human:manager-b');
  const body = {
    route: 'local', evidence: evidence('manual_review', 'REVIEW-IDEMPOTENCY-001', '采购经理已复核采购路线'), expectedVersion: 0,
  };
  async function assign(sessionToken: string, purchaseOrderId: string, assignmentBody: Record<string, unknown>, key?: string) {
    const response = await fetch(`${base}/api/procurement/routes/${encodeURIComponent(purchaseOrderId)}/assign`, {
      method: 'POST', headers: {
        authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}),
      }, body: JSON.stringify(assignmentBody),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  try {
    const missingKey = await assign(managerA, basePo.id, body);
    assert.equal(missingKey.status, 422); assert.equal(missingKey.body['code'], 'INVALID_ROUTE_INPUT');

    const created = await assign(managerA, basePo.id, body, 'route-assign:one');
    assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body['replayed'], false);
    const replayed = await assign(managerA, basePo.id, body, 'route-assign:one');
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body)); assert.equal(replayed.body['replayed'], true);
    assert.deepEqual(replayed.body['item'], created.body['item']);
    assert.deepEqual(replayed.body['events'], created.body['events']);
    const eventCount = store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_events WHERE tenant_id=? AND po_id=?`)
      .get('tenant:route-idempotency-a', basePo.id) as { count: number };
    assert.equal(eventCount.count, 1);

    const conflict = await assign(managerA, basePo.id, { ...body, route: 'import' }, 'route-assign:one');
    assert.equal(conflict.status, 409); assert.equal(conflict.body['code'], 'ROUTE_ASSIGNMENT_IDEMPOTENCY_CONFLICT');
    const otherTenant = await assign(managerB, basePo.id, body, 'route-assign:one');
    assert.equal(otherTenant.status, 201, JSON.stringify(otherTenant.body)); assert.equal(otherTenant.body['replayed'], false);

    store.db.exec(`CREATE TRIGGER fail_route_assignment_receipt BEFORE INSERT ON procurement_route_assignment_idempotency
      WHEN NEW.idempotency_key='route-assign:rollback' BEGIN SELECT RAISE(ABORT, 'forced route assignment receipt failure'); END`);
    const rolledBack = await assign(managerA, rollbackPo.id, {
      route: 'local', evidence: evidence('manual_review', 'REVIEW-ROLLBACK-001', '验证事务整体回滚'), expectedVersion: 0,
    }, 'route-assign:rollback');
    assert.equal(rolledBack.status, 500);
    store.db.exec('DROP TRIGGER fail_route_assignment_receipt');
    for (const table of ['procurement_route_assignments', 'procurement_route_events', 'procurement_route_assignment_idempotency']) {
      const column = table === 'procurement_route_assignment_idempotency' ? 'idempotency_key' : 'po_id';
      const value = table === 'procurement_route_assignment_idempotency' ? 'route-assign:rollback' : rollbackPo.id;
      const row = store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id=? AND ${column}=?`)
        .get('tenant:route-idempotency-a', value) as { count: number };
      assert.equal(row.count, 0, `${table} 必须随失败事务回滚`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }

  const reopened = openPersistence(dbPath, { tenantId: 'tenant:route-idempotency-a' });
  try {
    const assignments = reopened.db.prepare(`SELECT tenant_id,route,version FROM procurement_route_assignments
      WHERE po_id=? ORDER BY tenant_id`).all(basePo.id) as Array<{ tenant_id: string; route: string; version: number }>;
    assert.deepEqual(assignments.map((row) => ({ ...row })), [
      { tenant_id: 'tenant:route-idempotency-a', route: 'local', version: 1 },
      { tenant_id: 'tenant:route-idempotency-b', route: 'local', version: 1 },
    ]);
    const receipts = reopened.db.prepare(`SELECT tenant_id,idempotency_key FROM procurement_route_assignment_idempotency
      WHERE idempotency_key=? ORDER BY tenant_id`).all('route-assign:one') as Array<{ tenant_id: string; idempotency_key: string }>;
    assert.deepEqual(receipts.map((row) => ({ ...row })), [
      { tenant_id: 'tenant:route-idempotency-a', idempotency_key: 'route-assign:one' },
      { tenant_id: 'tenant:route-idempotency-b', idempotency_key: 'route-assign:one' },
    ]);
  } finally { reopened.close(); }
});
