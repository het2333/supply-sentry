import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { MemoryAttachmentObjectStorage } from '../src/attachment-object-storage.js';
import { resolveSession, type Session } from '../src/auth.js';
import { ProcurementDocumentWorker } from '../src/procurement-document-worker.js';
import { handleRequisitionRequest } from '../src/requisitions.js';

const SESSION_SECRET = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
}

test('object storage integration: upload, worker parsing and authenticated download share one integrity gate', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:object-integration' });
  const objectStorage = new MemoryAttachmentObjectStorage();
  const session: Session = {
    username: 'buyer', tenantId: store.tenantId, humanId: 'human:buyer', name: '李采购', role: '采购专员', expiresAt: Date.now() + 60_000,
  };
  const token = signSession(session);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers['authorization'];
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleRequisitionRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db,
      session: resolveSession(bearer),
      attachmentObjectStorage: objectStorage,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, body?: Record<string, unknown>) => fetch(`${baseUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  try {
    const createdResponse = await request('/api/procurement/requisitions', {
      idempotencyKey: 'object-requisition', source: 'manual', title: '对象存储验收', requestingDepartment: '生产部', requesterName: '张工',
      currency: 'CNY', targetDeliveryDate: '2026-09-30', lines: [{ itemCode: 'PV-30', itemName: '气动阀', quantity: 40, unit: '件' }],
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as Record<string, any>;
    const content = Buffer.from('采购物料 PV-30\n数量 40 件', 'utf8');
    const uploadedResponse = await request(`/api/procurement/requisitions/${encodeURIComponent(String(created['id']))}/attachments`, {
      idempotencyKey: 'object-upload', fileName: '需求.txt', contentType: 'text/plain', sizeBytes: content.length,
      dataBase64: content.toString('base64'), requisitionLineId: created['lines'][0]['id'],
    });
    assert.equal(uploadedResponse.status, 201);
    const uploaded = await uploadedResponse.json() as Record<string, any>;
    assert.equal(uploaded['attachment']['storageBackend'], 's3');
    const attachmentId = String(uploaded['attachment']['id']);
    const stored = store.db.prepare(`SELECT storage_backend,object_key,length(content) AS content_bytes FROM procurement_attachments WHERE tenant_id=? AND id=?`)
      .get(store.tenantId, attachmentId) as Record<string, unknown>;
    assert.equal(stored['storage_backend'], 's3');
    assert.equal(stored['content_bytes'], 0);
    assert.match(String(stored['object_key']), /^tenants\//);

    const worker = new ProcurementDocumentWorker(store.db, {
      objectStorage,
      malwareScanner: async () => ({ status: 'clean', engine: 'clamav', detail: 'clean' }),
    });
    assert.deepEqual(await worker.runTenant(store.tenantId), { claimed: 1, completed: 1, failed: 0, pendingMalwareScan: 0 });
    const parsed = store.db.prepare(`SELECT processing_status,security_status,extracted_text_preview FROM procurement_attachments WHERE tenant_id=? AND id=?`)
      .get(store.tenantId, attachmentId) as Record<string, unknown>;
    assert.equal(parsed['processing_status'], 'parsed');
    assert.equal(parsed['security_status'], 'clean');
    assert.match(String(parsed['extracted_text_preview']), /PV-30/);

    const downloaded = await request(String(uploaded['attachment']['url']));
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), content);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
});
