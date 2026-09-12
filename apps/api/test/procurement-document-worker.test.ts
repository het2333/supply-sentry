import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createProcurementRepository, openPersistence } from '@readywork/persistence';
import { ProcurementDocumentWorker } from '../src/procurement-document-worker.js';

function attachment(store: ReturnType<typeof openPersistence>, id: string, name: string, type: string, content: Buffer): void {
  store.db.prepare(`INSERT INTO procurement_attachments
    (tenant_id,id,requisition_id,requisition_line_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,
     extraction_status,extracted_text_preview,content,status,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    store.tenantId, id, 'requisition:worker', null, name, type, content.length,
    createHash('sha256').update(content).digest('hex'), 1, null, 'ready_for_document_agent', null,
    content, 'active', 'human:test', '2026-08-22T00:00:00.000Z',
  );
}

function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test('document worker persists text extraction while unavailable malware scanning keeps external send blocked', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:documents' });
  const content = Buffer.from('采购物料 PV-30\n数量 40 件', 'utf8');
  attachment(store, 'attachment:text', '需求.txt', 'text/plain', content);
  createProcurementRepository(store.db, store.tenantId).enqueueDocumentJob({ attachmentId: 'attachment:text' });
  const worker = new ProcurementDocumentWorker(store.db, {
    malwareScanner: async () => ({ status: 'unavailable', engine: 'clamav', detail: '未安装 ClamAV' }),
  });
  const result = await worker.runTenant(store.tenantId);
  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0, pendingMalwareScan: 1 });
  const row = store.db.prepare(`SELECT security_status,processing_status,detected_content_type,extracted_text_preview,scan_error
    FROM procurement_attachments WHERE tenant_id=? AND id=?`).get(store.tenantId, 'attachment:text') as Record<string, unknown>;
  assert.equal(row['security_status'], 'pending_scan');
  assert.equal(row['processing_status'], 'parsed');
  assert.equal(row['detected_content_type'], 'text/plain');
  assert.match(String(row['extracted_text_preview']), /PV-30/);
  assert.match(String(row['scan_error']), /阻止附件外发/);
  store.close();
});

test('document worker quarantines spoofed executable before parser runs', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:quarantine' });
  attachment(store, 'attachment:exe', '图纸.pdf', 'application/pdf', Buffer.from([0x4d, 0x5a, 0x90]));
  createProcurementRepository(store.db, store.tenantId).enqueueDocumentJob({ attachmentId: 'attachment:exe' });
  let scanCalls = 0;
  const worker = new ProcurementDocumentWorker(store.db, {
    malwareScanner: async () => { scanCalls += 1; return { status: 'clean', engine: 'clamav', detail: 'ok' }; },
  });
  const result = await worker.runTenant(store.tenantId);
  assert.deepEqual(result, { claimed: 1, completed: 0, failed: 1, pendingMalwareScan: 0 });
  assert.equal(scanCalls, 0);
  const row = store.db.prepare(`SELECT security_status,processing_status FROM procurement_attachments WHERE tenant_id=? AND id=?`)
    .get(store.tenantId, 'attachment:exe') as Record<string, unknown>;
  assert.equal(row['security_status'], 'quarantined');
  assert.equal(row['processing_status'], 'parse_failed');
  store.close();
});

test('document worker persists real OCR-shaped image output with confidence and dimensions', async () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:ocr' });
  attachment(store, 'attachment:image', '报价.png', 'image/png', pngHeader(640, 480));
  createProcurementRepository(store.db, store.tenantId).enqueueDocumentJob({ attachmentId: 'attachment:image' });
  const worker = new ProcurementDocumentWorker(store.db, {
    malwareScanner: async () => ({ status: 'clean', engine: 'clamav', detail: 'ok' }),
    ocrAdapter: { recognize: async () => ({ text: 'PV-30 单价 128.50', confidence: 91.2 }) },
    ocrLanguage: 'eng+chi_sim',
  });
  const result = await worker.runTenant(store.tenantId);
  assert.deepEqual(result, { claimed: 1, completed: 1, failed: 0, pendingMalwareScan: 0 });
  const row = store.db.prepare(`SELECT processing_status,extracted_text_preview FROM procurement_attachments WHERE tenant_id=? AND id=?`)
    .get(store.tenantId, 'attachment:image') as Record<string, unknown>;
  assert.equal(row['processing_status'], 'parsed');
  assert.match(String(row['extracted_text_preview']), /PV-30/);
  const job = store.db.prepare(`SELECT result_json FROM procurement_document_jobs WHERE tenant_id=? AND attachment_id=?`)
    .get(store.tenantId, 'attachment:image') as { result_json: string };
  const parsed = JSON.parse(job.result_json) as { parser: string; structuredData: Record<string, unknown> };
  assert.equal(parsed.parser, 'tesseract.js');
  assert.equal(parsed.structuredData['confidence'], 91.2);
  assert.equal(parsed.structuredData['width'], 640);
  assert.equal(parsed.structuredData['height'], 480);
  store.close();
});
