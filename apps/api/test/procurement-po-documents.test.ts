import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { Document, Page, Text, renderToBuffer } from '@react-pdf/renderer';
import type { PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import {
  MemoryAttachmentObjectStorage,
  type AttachmentObjectIntegrity,
  type PutAttachmentObjectInput,
} from '../src/attachment-object-storage.js';
import { parseProcurementDocument } from '../src/procurement-document-parser.js';
import { handleProcurementPoDocumentRequest } from '../src/procurement-po-documents.js';
import { handleProcurementWorkbenchRequest } from '../src/procurement-workbench.js';

const secret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
const fixedNow = new Date('2026-09-02T12:00:00.000Z');
const createdAt = '2026-09-01T10:00:00.000Z';
const tenantId = 'tenant:po-document';
const purchaseOrderId = 'purchase-order:document-test';
const projectionSubjectPrefix = 'readywork-po-projection-v1:';

type PdfProjection = {
  purchaseOrderId: string;
  number: string;
  sourcePoVersion: number;
  supplierName: string;
  supplierEmail: string;
  currency: string;
  orderedAt: string | null;
  requiredInHouseAt: string | null;
  route: string;
  status: string;
  lines: Array<{
    lineNumber: string;
    itemId: string;
    description: string;
    uom: string;
    orderedQty: number;
    unitPrice: number;
    taxRate: number;
    taxIncluded: boolean;
    total: number;
  }>;
  contextWatermark: string;
  generatedAt: string;
};

async function projectionFromPdf(pdfBytes: Uint8Array): Promise<PdfProjection> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: false });
  try {
    const pdf = await loadingTask.promise;
    const metadata = await pdf.getMetadata();
    const subject = (metadata.info as Record<string, unknown>)['Subject'];
    if (typeof subject !== 'string') assert.fail('PDF must carry the frozen projection in its Subject metadata');
    assert.ok(subject.startsWith(projectionSubjectPrefix), 'PDF Subject must use the versioned Readywork projection prefix');
    return JSON.parse(Buffer.from(subject.slice(projectionSubjectPrefix.length), 'base64url').toString('utf8')) as PdfProjection;
  } finally {
    await loadingTask.destroy();
  }
}

async function pdfPageTexts(pdfBytes: Uint8Array): Promise<string[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: false });
  try {
    const pdf = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item: any) => typeof item.str === 'string' ? item.str : '').join(' '));
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

function decodedHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/gu, '')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function htmlTagTexts(html: string, tag: 'th' | 'td'): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'giu'))]
    .map((match) => decodedHtmlText(match[1] ?? ''));
}

function token(scopeTenantId: string, role: string, humanId: string): string {
  const session: Session = {
    username: humanId,
    tenantId: scopeTenantId,
    humanId,
    name: humanId,
    role,
    expiresAt: Date.now() + 60_000,
  };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function seed(store: ReturnType<typeof openPersistence>): void {
  const supplier: Supplier = {
    id: 'supplier:po-document', tenantId, sourceSystem: 'odoo', externalId: 'SUP-DOC', status: 'active',
    createdAt, updatedAt: createdAt, name: '上海精密阀门有限公司', currency: 'CNY',
    contacts: [{ id: 'contact:po-document', name: '王琪', email: 'wangqi@example.com', primary: true }],
  };
  const po: PurchaseOrder & {
    number: string;
    requiredInHouseAt: string;
    materialType: string;
    route: string;
    contactId: string;
  } = {
    id: purchaseOrderId, tenantId, sourceSystem: 'odoo', externalId: 'purchase.order:501', number: 'P00501',
    status: 'awaiting_confirmation', createdAt, updatedAt: createdAt, supplierId: supplier.id, currency: 'CNY', orderedAt: createdAt,
    requiredInHouseAt: '2026-09-18T00:00:00.000Z', materialType: 'direct', route: 'local', contactId: supplier.contacts[0]!.id,
  };
  const lines: PurchaseOrderLine[] = [
    { id: 'po-line:document-test:10', poId: po.id, lineNumber: '10', itemId: 'VALVE-PV30', description: '气动调节阀 PV-30', uom: 'EA', orderedQty: 8, unitPrice: 1250, taxRate: 0.13, taxIncluded: false, currency: 'CNY', requestedAt: po.requiredInHouseAt } as PurchaseOrderLine,
    { id: 'po-line:document-test:20', poId: po.id, lineNumber: '20', itemId: 'NUT-BJ', description: '北京航空螺母', uom: 'SET', orderedQty: 2, unitPrice: 180, taxRate: 0.13, taxIncluded: true, currency: 'CNY', requestedAt: po.requiredInHouseAt } as PurchaseOrderLine,
  ];
  store.procurement.saveDocument('supplier', supplier);
  store.procurement.saveDocument('purchase_order', po);
  for (const line of lines) store.procurement.saveLine('purchase_order_line', po.id, line);
}

class TrackingStorage extends MemoryAttachmentObjectStorage {
  puts = 0;
  deletes = 0;
  failPut = false;
  failPutAfterWrite = false;
  tamperMetadata = false;
  beforePut: ((input: PutAttachmentObjectInput) => Promise<void>) | undefined;
  activePuts = 0;
  maxConcurrentPuts = 0;

  override async put(input: PutAttachmentObjectInput) {
    this.puts += 1;
    this.activePuts += 1;
    this.maxConcurrentPuts = Math.max(this.maxConcurrentPuts, this.activePuts);
    try {
      if (this.beforePut) await this.beforePut(input);
      if (this.failPut) throw new Error('isolated object store unavailable');
      const object = await super.put(input);
      if (this.failPutAfterWrite) throw new Error('isolated PUT acknowledgement lost after durable write');
      return object;
    } finally {
      this.activePuts -= 1;
    }
  }

  override async delete(input: { tenantId: string; attachmentId: string; version: number }) {
    this.deletes += 1;
    return super.delete(input);
  }

  override async get(input: AttachmentObjectIntegrity) {
    const object = await super.get(input);
    return this.tamperMetadata
      ? { ...object, metadata: { ...object.metadata, sizeBytes: object.metadata.sizeBytes + 1 } }
      : object;
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function withFixture(run: (fixture: {
  base: string;
  store: ReturnType<typeof openPersistence>;
  storage: TrackingStorage;
  buyer: string;
  auditor: string;
  outsider: string;
  post: (body: Record<string, unknown>, key: string, bearer?: string) => Promise<{ status: number; body: Record<string, any> }>;
}) => Promise<void>): Promise<void> {
  const store = openPersistence(':memory:', { tenantId });
  seed(store);
  const storage = new TrackingStorage({ now: () => fixedNow });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const session = resolveSession(bearer);
    void handleProcurementPoDocumentRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db,
      session,
      attachmentObjectStorage: storage,
      now: () => fixedNow,
    }).then(async (handled) => handled || await handleProcurementWorkbenchRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db,
      session,
      now: () => fixedNow,
    })).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyer = token(tenantId, '采购专员', 'human:buyer');
  const auditor = token(tenantId, '审计员', 'human:auditor');
  const outsider = token('tenant:other', '采购专员', 'human:outsider');
  const post = async (body: Record<string, unknown>, key: string, bearer = buyer) => {
    const response = await fetch(`${base}/api/procurement/purchase-orders/${encodeURIComponent(purchaseOrderId)}/document-snapshots`, {
      method: 'POST',
      headers: { authorization: bearer ? `Bearer ${bearer}` : '', 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  try {
    await run({ base, store, storage, buyer, auditor, outsider, post });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  }
}

test('PO document snapshot is deterministic, immutable, idempotent, tenant-scoped and shared by PDF/Print', async () => {
  await withFixture(async ({ base, store, storage, buyer, auditor, outsider, post }) => {
    assert.equal((await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:unauthorized', '')).status, 401);
    assert.equal((await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:reader', auditor)).status, 403);
    assert.equal((await post({ expectedVersion: 2, purpose: 'download' }, 'po-doc:stale')).status, 409);
    assert.equal((await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:other', outsider)).status, 404);
    assert.equal((await post({ expectedVersion: 1, purpose: 'preview' }, 'po-doc:bad-purpose')).status, 422);

    const first = await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:first');
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.replayed, false);
    assert.deepEqual(Object.keys(first.body.item).sort(), [
      'contentSha256', 'contextWatermark', 'documentId', 'generatedAt', 'id', 'purchaseOrderId', 'sourcePoVersion', 'templateVersion',
    ]);
    assert.equal(first.body.item.purchaseOrderId, purchaseOrderId);
    assert.equal(first.body.item.sourcePoVersion, 1);
    assert.equal(first.body.item.templateVersion, 'po-document-v1');
    assert.equal(first.body.item.generatedAt, fixedNow.toISOString());
    assert.match(first.body.item.contextWatermark, /^po-context-v1:[a-f0-9]{64}$/u);
    assert.match(first.body.item.contentSha256, /^[a-f0-9]{64}$/u);
    assert.match(first.body.pdfUrl, /^\/api\/procurement\/purchase-order-document-snapshots\/[^/]+\/pdf$/u);
    assert.match(first.body.printUrl, /^\/api\/procurement\/purchase-order-document-snapshots\/[^/]+\/print$/u);
    assert.equal(storage.puts, 1);

    const replay = await post({ expectedVersion: 1, purpose: 'print' }, 'po-doc:first');
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.item.id, first.body.item.id);
    assert.equal(storage.puts, 1, 'same idempotency key must not rewrite object storage');

    const second = await post({ expectedVersion: 1, purpose: 'print' }, 'po-doc:second');
    assert.equal(second.status, 201);
    assert.notEqual(second.body.item.id, first.body.item.id);
    assert.equal(second.body.item.contextWatermark, first.body.item.contextWatermark);
    assert.equal(second.body.item.contentSha256, first.body.item.contentSha256, 'same frozen input and fixed generation time render deterministically');
    assert.equal(storage.puts, 2);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_purchase_order_document_snapshots WHERE tenant_id=? AND po_id=?').get(tenantId, purchaseOrderId) as { count: number }).count, 2);

    const currentPo = store.procurement.getDocument<PurchaseOrder & { number: string }>('purchase_order', purchaseOrderId)!;
    store.procurement.saveDocument('purchase_order', {
      ...currentPo.document,
      number: 'P00501-MUTATED-AFTER-SNAPSHOT',
      updatedAt: '2026-09-02T12:05:00.000Z',
    }, currentPo.version);
    const replayAfterMutation = await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:first');
    assert.equal(replayAfterMutation.status, 200, 'same key replays its immutable result even after the source PO advances');
    assert.equal(replayAfterMutation.body.item.id, first.body.item.id);
    assert.equal(storage.puts, 2);

    const pdfResponse = await fetch(`${base}${first.body.pdfUrl}`, { headers: { authorization: `Bearer ${auditor}` } });
    const pdf = Buffer.from(await pdfResponse.arrayBuffer());
    assert.equal(pdfResponse.status, 200);
    assert.equal(pdfResponse.headers.get('content-type'), 'application/pdf');
    assert.match(pdfResponse.headers.get('content-disposition') ?? '', /^attachment; filename="P00501-v1-[a-f0-9]{8}\.pdf"$/u);
    assert.equal(pdfResponse.headers.get('x-content-sha256'), first.body.item.contentSha256);
    assert.equal(pdfResponse.headers.get('x-po-context-watermark'), first.body.item.contextWatermark);
    assert.equal(pdfResponse.headers.get('x-po-template-version'), 'po-document-v1');
    assert.equal(createHash('sha256').update(pdf).digest('hex'), first.body.item.contentSha256);
    const projection = await projectionFromPdf(pdf);
    assert.equal(projection.purchaseOrderId, purchaseOrderId);
    assert.equal(projection.number, 'P00501');
    assert.equal(projection.sourcePoVersion, 1);
    assert.equal(projection.supplierName, '上海精密阀门有限公司');
    assert.equal(projection.supplierEmail, 'wangqi@example.com');
    assert.equal(projection.route, 'local');
    assert.equal(projection.status, 'awaiting_confirmation');
    assert.equal(projection.currency, 'CNY');
    assert.equal(projection.contextWatermark, first.body.item.contextWatermark);
    assert.equal(projection.generatedAt, fixedNow.toISOString());
    assert.deepEqual(projection.lines, [
      { lineNumber: '10', itemId: 'VALVE-PV30', description: '气动调节阀 PV-30', uom: 'EA', orderedQty: 8, unitPrice: 1250, taxRate: 0.13, taxIncluded: false, total: 11300 },
      { lineNumber: '20', itemId: 'NUT-BJ', description: '北京航空螺母', uom: 'SET', orderedQty: 2, unitPrice: 180, taxRate: 0.13, taxIncluded: true, total: 360 },
    ]);
    const parsedPdf = await parseProcurementDocument({ fileName: 'snapshot.pdf', contentType: 'application/pdf', content: pdf });
    assert.equal(parsedPdf.status, 'parsed');
    const compactPdfText = parsedPdf.text.replace(/\s+/gu, '');
    assert.match(compactPdfText, /P00501/u);
    assert.match(compactPdfText, /VALVE-PV30/u);
    assert.match(compactPdfText, /北京航空螺母/u, 'the full local font must survive PDF generation and extraction');
    assert.match(compactPdfText, /system-generatedsnapshot/iu);
    assert.match(compactPdfText, /11660\.00/u, 'PDF total is hand-derived: 8×1250×1.13 + 2×180 = 11660.00');
    assert.match(compactPdfText, /11300\.00\+360\.00=11660\.00CNY/u, 'PDF exposes the literal line-to-grand-total audit');
    assert.doesNotMatch(compactPdfText, /signedoriginal/iu);

    const printResponse = await fetch(`${base}${first.body.printUrl}`, { headers: { authorization: `Bearer ${auditor}` } });
    const html = await printResponse.text();
    assert.equal(printResponse.status, 200);
    assert.equal(printResponse.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(printResponse.headers.get('x-content-sha256'), first.body.item.contentSha256);
    assert.equal(printResponse.headers.get('x-po-context-watermark'), first.body.item.contextWatermark);
    assert.equal(printResponse.headers.get('x-po-template-version'), 'po-document-v1');
    assert.match(html, /<!doctype html>/iu);
    assert.match(html, /P00501/u);
    assert.doesNotMatch(html, /P00501-MUTATED-AFTER-SNAPSHOT/u, 'print must remain frozen after the source PO changes');
    assert.match(html, /system-generated snapshot/iu);
    assert.match(html, /window\.print\(\)/u);
    assert.match(html, new RegExp(first.body.item.contentSha256, 'u'));
    assert.doesNotMatch(html, /signed original/iu);
    assert.doesNotMatch(html, /<pre\b/iu, 'Print must render semantic rows and cells, never extracted PDF text');
    assert.ok(html.indexOf('ORDER DETAILS') < html.indexOf('LINE ITEMS'));
    assert.ok(html.indexOf('LINE ITEMS') < html.indexOf('DOCUMENTS'));
    assert.deepEqual(htmlTagTexts(html, 'th'), ['#', 'CODE', 'DESCRIPTION', 'QTY', 'UOM', 'UNIT PRICE', 'AMOUNT', 'CCY']);
    assert.deepEqual(htmlTagTexts(html, 'td'), [
      '10', 'VALVE-PV30', '气动调节阀 PV-30', '8', 'EA', '1250.00 Tax excluded · 13%', '11300.00', 'CNY',
      '20', 'NUT-BJ', '北京航空螺母', '2', 'SET', '180.00 Tax included · 13%', '360.00', 'CNY',
    ]);
    assert.match(html, /Grand total\s*<[^>]+>11660\.00<\/[^>]+>\s*CNY/iu);
    assert.match(html, /11300\.00 \+ 360\.00 = 11660\.00 CNY/u, 'Print exposes the same literal amount audit as PDF');
    assert.match(html, /@page\{size:A4;margin:12\.7mm\}/u);
    assert.match(html, /@font-face\{font-family:"Readywork Noto Sans SC";src:url\("\/api\/procurement\/purchase-order-document-assets\/noto-sans-sc\.ttf"\)/u);
    assert.doesNotMatch(html, /src:url\(["']?https?:/iu, 'Print cannot make a remote font request');

    const fontResponse = await fetch(`${base}/api/procurement/purchase-order-document-assets/noto-sans-sc.ttf`, { headers: { authorization: `Bearer ${auditor}` } });
    const fontBytes = Buffer.from(await fontResponse.arrayBuffer());
    assert.equal(fontResponse.status, 200);
    assert.equal(fontResponse.headers.get('content-type'), 'font/ttf');
    assert.equal(fontBytes.byteLength, 17_772_300);
    assert.equal(createHash('sha256').update(fontBytes).digest('hex'), 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da');

    assert.equal((await fetch(`${base}${first.body.pdfUrl}`, { headers: { authorization: `Bearer ${outsider}` } })).status, 404);
    assert.equal((await fetch(`${base}${first.body.printUrl}`, { headers: { authorization: `Bearer ${outsider}` } })).status, 404);
    assert.equal((await fetch(`${base}${first.body.pdfUrl}`)).status, 401);
  });
});

test('workbench returns the logical document id plus a tenant-scoped snapshot URL that reopens the immutable PDF', async () => {
  await withFixture(async ({ base, store, buyer, auditor, outsider, post }) => {
    const created = await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:workbench-reopen');
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const originalResponse = await fetch(`${base}${created.body.pdfUrl}`, { headers: { authorization: `Bearer ${auditor}` } });
    assert.equal(originalResponse.status, 200);
    const originalPdf = Buffer.from(await originalResponse.arrayBuffer());

    const currentPo = store.procurement.getDocument<PurchaseOrder & { number: string }>('purchase_order', purchaseOrderId)!;
    store.procurement.saveDocument('purchase_order', {
      ...currentPo.document,
      number: 'P00501-MUTATED-AFTER-WORKBENCH-SNAPSHOT',
      updatedAt: '2026-09-02T12:10:00.000Z',
    }, currentPo.version);

    const contextPath = `/api/procurement/workbench/context/${encodeURIComponent(purchaseOrderId)}`;
    assert.equal((await fetch(`${base}${contextPath}`)).status, 401);
    assert.equal((await fetch(`${base}${contextPath}`, {
      headers: { authorization: `Bearer ${token(tenantId, '访客', 'human:visitor')}` },
    })).status, 403);
    assert.equal((await fetch(`${base}${contextPath}`, { headers: { authorization: `Bearer ${outsider}` } })).status, 404);

    const contextResponse = await fetch(`${base}${contextPath}`, { headers: { authorization: `Bearer ${auditor}` } });
    assert.equal(contextResponse.status, 200);
    const context = await contextResponse.json() as Record<string, any>;
    const row = (context['poDetail']['documents']['rows'] as Array<Record<string, unknown>>)
      .find((candidate) => candidate['snapshotId'] === created.body.item.id);
    assert.ok(row, JSON.stringify(context['poDetail']['documents']['rows']));
    assert.equal(row['id'], created.body.item.documentId, 'id remains the logical procurement document id');
    assert.equal(row['snapshotId'], created.body.item.id, 'snapshotId addresses the immutable stored snapshot');
    assert.equal(row['url'], created.body.pdfUrl);

    assert.equal((await fetch(`${base}${row['url']}`)).status, 401);
    assert.equal((await fetch(`${base}${row['url']}`, {
      headers: { authorization: `Bearer ${token(tenantId, '访客', 'human:visitor')}` },
    })).status, 403);
    assert.equal((await fetch(`${base}${row['url']}`, { headers: { authorization: `Bearer ${outsider}` } })).status, 404);

    const reopenedResponse = await fetch(`${base}${row['url']}`, { headers: { authorization: `Bearer ${buyer}` } });
    assert.equal(reopenedResponse.status, 200);
    assert.equal(reopenedResponse.headers.get('x-content-sha256'), created.body.item.contentSha256);
    const reopenedPdf = Buffer.from(await reopenedResponse.arrayBuffer());
    assert.deepEqual(reopenedPdf, originalPdf, 'workbench URL must reopen the exact immutable bytes created before the PO changed');
  });
});

test('a multipage PO PDF repeats all eight line-item headings on every page', async () => {
  await withFixture(async ({ base, store, auditor, post }) => {
    for (let index = 0; index < 64; index += 1) {
      const lineNumber = String(30 + index * 10);
      store.procurement.saveLine('purchase_order_line', purchaseOrderId, {
        id: `po-line:multipage:${lineNumber}`, poId: purchaseOrderId, lineNumber,
        itemId: `PART-${lineNumber}`, description: `航空级精密紧固件批次 ${lineNumber}`, uom: 'EA',
        orderedQty: index + 1, unitPrice: 12.5, taxRate: 0.13, taxIncluded: false,
        currency: 'CNY', requestedAt: '2026-09-18T00:00:00.000Z',
      } as PurchaseOrderLine);
    }
    const created = await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:multipage-header');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const response = await fetch(`${base}${created.body.pdfUrl}`, { headers: { authorization: `Bearer ${auditor}` } });
    assert.equal(response.status, 200);
    const pages = await pdfPageTexts(new Uint8Array(await response.arrayBuffer()));
    assert.ok(pages.length >= 3, `expected at least three PDF pages, received ${pages.length}`);
    const repeated = pages.map((text) => ['#', 'CODE', 'DESCRIPTION', 'QTY', 'UOM', 'UNIT PRICE', 'AMOUNT', 'CCY']
      .every((heading) => text.includes(heading)));
    assert.deepEqual(repeated, new Array(pages.length).fill(true), `table headings by page: ${JSON.stringify(repeated)}`);
  });
});

test('PO document snapshot leaves no metadata on object failure and reuses an exact object after metadata failure', async () => {
  await withFixture(async ({ store, storage, post }) => {
    storage.failPut = true;
    const failedObject = await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:object-failure');
    assert.equal(failedObject.status, 500);
    assert.equal(failedObject.body.code, 'PO_DOCUMENT_STORAGE_FAILED');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_purchase_order_document_snapshots').get() as { count: number }).count, 0);

    storage.failPut = false;
    store.db.exec(`CREATE TEMP TRIGGER reject_po_document_snapshot_insert
      BEFORE INSERT ON procurement_purchase_order_document_snapshots
      BEGIN SELECT RAISE(ABORT, 'isolated metadata failure'); END`);
    const failedMetadata = await post({ expectedVersion: 1, purpose: 'print' }, 'po-doc:metadata-failure');
    assert.equal(failedMetadata.status, 500);
    assert.equal(failedMetadata.body.code, 'PO_DOCUMENT_SNAPSHOT_FAILED');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_purchase_order_document_snapshots').get() as { count: number }).count, 0);
    const putsBeforeRecovery = storage.puts;
    store.db.exec('DROP TRIGGER reject_po_document_snapshot_insert');
    const recovered = await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:metadata-failure');
    assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
    assert.equal(storage.puts, putsBeforeRecovery, 'a retry adopts the exact durable object instead of rewriting it');
    assert.equal(storage.deletes, 0, 'uncertain or unowned snapshot objects are never deleted in the request path');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_purchase_order_document_snapshots').get() as { count: number }).count, 1);
  });
});

test('PO document snapshot reconciles a durable PUT whose acknowledgement is lost', async () => {
  await withFixture(async ({ store, storage, post }) => {
    storage.failPutAfterWrite = true;
    const result = await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:lost-put-ack');
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_purchase_order_document_snapshots
      WHERE tenant_id=? AND id=?`).get(tenantId, result.body.item.id) as { count: number }).count, 1);
    assert.equal(storage.puts, 1);
    assert.equal(storage.deletes, 0, 'a durably written matching object must never be deleted after an uncertain response');
  });
});

test('snapshot failure cannot roll back a concurrent PO save on the shared DatabaseSync', async () => {
  await withFixture(async ({ store, storage, post }) => {
    const putEntered = deferred();
    const releasePut = deferred();
    storage.beforePut = async () => { putEntered.resolve(); await releasePut.promise; };
    storage.failPut = true;
    const snapshot = post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:shared-connection-save');
    await putEntered.promise;

    const current = store.procurement.getDocument<PurchaseOrder>('purchase_order', purchaseOrderId)!;
    const saved = store.procurement.saveDocument('purchase_order', {
      ...current.document, updatedAt: '2026-09-02T12:15:00.000Z',
    }, current.version);
    assert.equal(saved.version, 2, 'the concurrent PO save is visible before the snapshot fails');
    releasePut.resolve();
    assert.equal((await snapshot).status, 500);
    assert.equal(store.procurement.getDocument<PurchaseOrder>('purchase_order', purchaseOrderId)?.version, 2,
      'snapshot rollback must not erase an unrelated committed PO save');
  });
});

test('different snapshot keys in one process perform independent object work and commits', async () => {
  await withFixture(async ({ store, storage, post }) => {
    const firstPutEntered = deferred();
    const releasePuts = deferred();
    let arrivals = 0;
    storage.beforePut = async () => {
      arrivals += 1;
      if (arrivals === 1) firstPutEntered.resolve();
      await releasePuts.promise;
    };
    const first = post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:different-key:first');
    await firstPutEntered.promise;
    const second = post({ expectedVersion: 1, purpose: 'print' }, 'po-doc:different-key:second');
    await new Promise((resolve) => setTimeout(resolve, 100));
    releasePuts.resolve();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.status), [201, 201]);
    assert.equal(storage.maxConcurrentPuts, 2, 'different keys must reach storage without sharing a database transaction');
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_purchase_order_document_snapshots
      WHERE tenant_id=? AND po_id=?`).get(tenantId, purchaseOrderId) as { count: number }).count, 2);
  });
});

test('PO document snapshot refuses missing or invalid amount inputs instead of silently coercing them', async () => {
  await withFixture(async ({ store, storage, post }) => {
    const row = store.db.prepare(`SELECT id,json FROM procurement_lines
      WHERE tenant_id=? AND kind='purchase_order_line' AND document_id=? ORDER BY line_number,id LIMIT 1`)
      .get(tenantId, purchaseOrderId) as { id: string; json: string };
    const original = JSON.parse(row.json) as Record<string, unknown>;
    const cases: Array<{ name: string; mutate: (line: Record<string, unknown>) => void }> = [
      { name: 'missing-quantity', mutate: (line) => { delete line['orderedQty']; } },
      { name: 'invalid-quantity', mutate: (line) => { line['orderedQty'] = 0; } },
      { name: 'missing-price', mutate: (line) => { delete line['unitPrice']; } },
      { name: 'invalid-price', mutate: (line) => { line['unitPrice'] = -0.01; } },
      { name: 'missing-rate', mutate: (line) => { delete line['taxRate']; } },
      { name: 'invalid-rate', mutate: (line) => { line['taxRate'] = 1.01; } },
      { name: 'missing-tax-included', mutate: (line) => { delete line['taxIncluded']; } },
      { name: 'invalid-tax-included', mutate: (line) => { line['taxIncluded'] = 'false'; } },
    ];

    for (const scenario of cases) {
      const changed = structuredClone(original);
      scenario.mutate(changed);
      store.db.prepare(`UPDATE procurement_lines SET json=? WHERE tenant_id=? AND id=?`)
        .run(JSON.stringify(changed), tenantId, row.id);
      const result = await post({ expectedVersion: 1, purpose: 'download' }, `po-doc:${scenario.name}`);
      assert.equal(result.status, 422, `${scenario.name}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.code, 'INVALID_PO_DOCUMENT_INPUT');
    }

    store.db.prepare(`UPDATE procurement_lines SET json=? WHERE tenant_id=? AND id=?`)
      .run(JSON.stringify(original), tenantId, row.id);
    assert.equal(storage.puts, 0, 'invalid business numbers must fail before object storage');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_purchase_order_document_snapshots').get() as { count: number }).count, 0);
  });
});

test('PDF and Print reject object metadata tampering and malformed or mismatched embedded projections', async () => {
  await withFixture(async ({ base, store, storage, auditor, post }) => {
    const created = await post({ expectedVersion: 1, purpose: 'download' }, 'po-doc:strict-read');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const snapshotId = String(created.body.item.id);
    const snapshot = store.db.prepare(`SELECT content_sha256,size_bytes FROM procurement_purchase_order_document_snapshots
      WHERE tenant_id=? AND id=?`).get(tenantId, snapshotId) as { content_sha256: string; size_bytes: number };
    const validObject = await storage.get({
      tenantId, attachmentId: snapshotId, version: 1, sha256: snapshot.content_sha256, sizeBytes: snapshot.size_bytes,
    });
    const validProjection = await projectionFromPdf(validObject.body);
    const authorizedGet = async (kind: 'pdf' | 'print') => fetch(
      `${base}/api/procurement/purchase-order-document-snapshots/${encodeURIComponent(snapshotId)}/${kind}`,
      { headers: { authorization: `Bearer ${auditor}` } },
    );

    storage.tamperMetadata = true;
    const metadataMismatch = await authorizedGet('pdf');
    assert.equal(metadataMismatch.status, 500);
    assert.equal((await metadataMismatch.json() as { code: string }).code, 'PO_DOCUMENT_SNAPSHOT_FAILED');
    storage.tamperMetadata = false;

    // Simulate at-rest corruption in this isolated database. Production keeps
    // this trigger; dropping it here is the only way to make the forged object
    // and forged metadata mutually consistent enough to reach projection validation.
    store.db.exec('DROP TRIGGER trg_procurement_purchase_order_document_snapshots_no_update');

    const installPdf = async (subject: string) => {
      const bytes = await renderSubjectOnlyPdf(subject);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const object = await storage.put({
        tenantId, attachmentId: snapshotId, version: 1, sha256, sizeBytes: bytes.byteLength,
        body: bytes, contentType: 'application/pdf',
      });
      store.db.prepare(`UPDATE procurement_purchase_order_document_snapshots
        SET content_sha256=?,size_bytes=?,object_key=? WHERE tenant_id=? AND id=?`)
        .run(sha256, bytes.byteLength, object.key, tenantId, snapshotId);
    };

    await installPdf(projectionSubject({ ...validProjection, unexpected: true }));
    for (const kind of ['pdf', 'print'] as const) {
      const malformed = await authorizedGet(kind);
      assert.equal(malformed.status, 500, `${kind} accepted an extra projection key`);
      assert.equal((await malformed.json() as { code: string }).code, 'PO_DOCUMENT_SNAPSHOT_FAILED');
    }

    await installPdf(projectionSubject({ ...validProjection, sourcePoVersion: validProjection.sourcePoVersion + 1 }));
    const mismatched = await authorizedGet('print');
    assert.equal(mismatched.status, 500, 'Print accepted a projection version that disagrees with snapshot metadata');
    assert.equal((await mismatched.json() as { code: string }).code, 'PO_DOCUMENT_SNAPSHOT_FAILED');
  });
});

async function renderSubjectOnlyPdf(subject: string): Promise<Uint8Array> {
  const document = React.createElement(
    Document,
    { subject },
    React.createElement(Page, { size: 'A4' }, React.createElement(Text, null, 'integrity fixture')),
  );
  return new Uint8Array(await renderToBuffer(document));
}

function projectionSubject(value: unknown): string {
  return `${projectionSubjectPrefix}${Buffer.from(canonicalJson(value), 'utf8').toString('base64url')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('unsupported canonical JSON fixture value');
  return encoded;
}

type ControllerResponse = {
  status: number;
  headers: Record<string, string>;
  sizeBytes: number;
  bodySha256: string;
  body?: Record<string, any>;
  text?: string;
};

type ControllerBarrier = {
  directory: string;
  tag: string;
  releaseFile: string;
  expectedArrivals?: number;
  timeoutMs: number;
};

class PoDocumentController {
  readonly child: ChildProcess;
  readonly stderr: string[] = [];
  #sequence = 0;
  #ready: Promise<void>;
  #resolveReady!: () => void;
  #pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(child: ChildProcess) {
    this.child = child;
    this.#ready = new Promise((resolve) => { this.#resolveReady = resolve; });
    child.stderr?.on('data', (chunk) => this.stderr.push(String(chunk)));
    child.on('message', (value: any) => {
      if (value?.type === 'ready') { this.#resolveReady(); return; }
      const pending = typeof value?.id === 'string' ? this.#pending.get(value.id) : undefined;
      if (!pending) return;
      this.#pending.delete(value.id);
      if (value.error) pending.reject(new Error(`${value.error}\n${this.stderr.join('')}`));
      else pending.resolve(value.result);
    });
    child.on('exit', (code, signal) => {
      const error = new Error(`PO document child exited (${String(code)}/${String(signal)}): ${this.stderr.join('')}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  async ready(): Promise<void> { await this.#ready; }

  request(input: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    putBarrier?: ControllerBarrier;
    afterReservationBarrier?: ControllerBarrier;
    reservationLeaseMs?: number;
    beforeFinalizeBarrier?: ControllerBarrier;
    failSnapshotInsert?: boolean;
  }): Promise<ControllerResponse> {
    return this.command({ type: 'request', ...input });
  }

  mutate(markerFile: string): Promise<{ mutated: true }> {
    return this.command({ type: 'mutate', markerFile, purchaseOrderId });
  }

  async close(): Promise<void> {
    if (!this.child.connected) return;
    await this.command({ type: 'close' });
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) resolve();
      else this.child.once('exit', () => resolve());
    });
  }

  private command<T>(value: Record<string, unknown>): Promise<T> {
    const id = `${process.pid}:${++this.#sequence}`;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.child.send({ id, ...value }, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }
}

async function startPoDocumentController(input: {
  databasePath: string;
  bucketDirectory: string;
  eventLogPath: string;
}): Promise<PoDocumentController> {
  const child = fork(
    fileURLToPath(new URL('./fixtures/procurement-po-document-controller.ts', import.meta.url)),
    [],
    {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      execPath: process.execPath,
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        READYWORK_TEST_PO_DOCUMENT_DB: input.databasePath,
        READYWORK_TEST_PO_DOCUMENT_BUCKET: input.bucketDirectory,
        READYWORK_TEST_PO_DOCUMENT_EVENTS: input.eventLogPath,
        READYWORK_TEST_PO_DOCUMENT_TENANT: tenantId,
        READYWORK_TEST_PO_DOCUMENT_NOW: fixedNow.toISOString(),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  const controller = new PoDocumentController(child);
  await controller.ready();
  return controller;
}

async function waitForFileMatch(directory: string, predicate: (entry: string) => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let entries: string[] = [];
    try { entries = await readdir(directory); } catch { /* directory not created yet */ }
    if (entries.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for barrier entry in ${directory}`);
}

async function objectEvents(eventLogPath: string): Promise<Array<{ operation: 'put' | 'delete'; attachmentId: string; pid: number }>> {
  const source = await readFile(eventLogPath, 'utf8');
  return source.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { operation: 'put' | 'delete'; attachmentId: string; pid: number });
}

test('two child-process controllers converge same-key creation, recover failed reservations, and read one frozen object', { timeout: 60_000 }, async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'readywork-po-doc-process-'));
  assert.match(fixtureDirectory, /readywork-po-doc-process-/u);
  const databasePath = join(fixtureDirectory, 'shared.sqlite');
  const bucketDirectory = join(fixtureDirectory, 'bucket');
  const eventLogPath = join(fixtureDirectory, 'object-events.jsonl');
  const barrierDirectory = join(fixtureDirectory, 'barriers');
  await writeFile(eventLogPath, '');
  const setup = openPersistence(databasePath, { tenantId });
  seed(setup);
  setup.close();
  let first: PoDocumentController | undefined;
  let second: PoDocumentController | undefined;
  try {
    first = await startPoDocumentController({ databasePath, bucketDirectory, eventLogPath });
    second = await startPoDocumentController({ databasePath, bucketDirectory, eventLogPath });

    // Warm both independent renderers so the reservation/PUT barrier exercises
    // cross-process ownership rather than one-time font startup latency.
    assert.equal((await first.request({
      method: 'POST', path: createPath(), body: { expectedVersion: 1, purpose: 'download' }, idempotencyKey: 'process:warm:first',
    })).status, 201);
    assert.equal((await second.request({
      method: 'POST', path: createPath(), body: { expectedVersion: 1, purpose: 'download' }, idempotencyKey: 'process:warm:second',
    })).status, 201);

    const sameKeyBarrier: ControllerBarrier = {
      directory: barrierDirectory,
      tag: 'same-key-put',
      releaseFile: 'same-key.release',
      timeoutMs: 15_000,
    };
    const firstCall = first.request({
      method: 'POST', path: createPath(), body: { expectedVersion: 1, purpose: 'download' },
      idempotencyKey: 'process:same-key', putBarrier: sameKeyBarrier,
    });
    await waitForFileMatch(barrierDirectory, (entry) => entry.startsWith('same-key-put-'));
    const secondCall = second.request({
      method: 'POST', path: createPath(), body: { expectedVersion: 1, purpose: 'print' },
      idempotencyKey: 'process:same-key', putBarrier: sameKeyBarrier,
    });
    await new Promise((resolve) => setTimeout(resolve, 6_500));
    await writeFile(join(barrierDirectory, sameKeyBarrier.releaseFile), 'release');
    const converged = await Promise.all([firstCall, secondCall]);
    assert.deepEqual(converged.map((value) => value.status).sort(), [200, 201]);
    const winner = converged.find((value) => value.status === 201)!;
    const replay = converged.find((value) => value.status === 200)!;
    assert.equal(winner.body?.item.id, replay.body?.item.id);
    assert.equal(winner.body?.item.contentSha256, replay.body?.item.contentSha256);
    const sameKeyId = String(winner.body?.item.id);
    const sameKeyEvents = (await objectEvents(eventLogPath)).filter((event) => event.attachmentId === sameKeyId);
    assert.equal(sameKeyEvents.filter((event) => event.operation === 'put').length, 1, 'the durable reservation must prevent a second process from reaching PUT');
    assert.equal(new Set(sameKeyEvents.map((event) => event.pid)).size, 1);

    const pdfRead = await first.request({ method: 'GET', path: snapshotPath(sameKeyId, 'pdf') });
    const printRead = await second.request({ method: 'GET', path: snapshotPath(sameKeyId, 'print') });
    assert.equal(pdfRead.status, 200);
    assert.equal(pdfRead.bodySha256, winner.body?.item.contentSha256);
    assert.equal(printRead.status, 200);
    assert.equal(printRead.headers['x-content-sha256'], winner.body?.item.contentSha256);
    assert.match(printRead.text ?? '', /北京航空螺母/u);

    const failedAttempt = await first.request({
      method: 'POST', path: createPath(), body: { expectedVersion: 1, purpose: 'download' },
      idempotencyKey: 'process:failed-reservation', failSnapshotInsert: true,
    });
    assert.equal(failedAttempt.status, 500);
    assert.equal(failedAttempt.body?.code, 'PO_DOCUMENT_SNAPSHOT_FAILED');
    const recoveredWinner = await second.request({
      method: 'POST', path: createPath(), body: { expectedVersion: 1, purpose: 'print' }, idempotencyKey: 'process:failed-reservation',
    });
    assert.equal(recoveredWinner.status, 201, JSON.stringify(recoveredWinner.body));
    const recoveredId = String(recoveredWinner.body?.item.id);
    const recoveryEvents = (await objectEvents(eventLogPath)).filter((event) => event.attachmentId === recoveredId);
    assert.equal(recoveryEvents.filter((event) => event.operation === 'put').length, 1, 'the new owner adopts the exact object left by the failed metadata commit');
    assert.equal(recoveryEvents.filter((event) => event.operation === 'delete').length, 0, 'failed reservation recovery never deletes the durable object');
    const winnerPdf = await first.request({ method: 'GET', path: snapshotPath(recoveredId, 'pdf') });
    const winnerPrint = await second.request({ method: 'GET', path: snapshotPath(recoveredId, 'print') });
    assert.equal(winnerPdf.status, 200);
    assert.equal(winnerPdf.bodySha256, recoveredWinner.body?.item.contentSha256);
    assert.equal(winnerPrint.status, 200);
    assert.equal(winnerPrint.headers['x-content-sha256'], recoveredWinner.body?.item.contentSha256);

    const reservationBarrier: ControllerBarrier = {
      directory: barrierDirectory,
      tag: 'projection-reserved',
      releaseFile: 'projection.release',
      timeoutMs: 15_000,
    };
    const atomicCreate = first.request({
      method: 'POST', path: createPath(), body: { expectedVersion: 1, purpose: 'print' },
      idempotencyKey: 'process:atomic-context', afterReservationBarrier: reservationBarrier,
    });
    await waitForFileMatch(barrierDirectory, (entry) => entry.startsWith('projection-reserved-'));
    const mutationMarker = join(barrierDirectory, 'mutation.started');
    const mutation = second.mutate(mutationMarker);
    await waitForFileMatch(barrierDirectory, (entry) => entry === 'mutation.started');
    await writeFile(join(barrierDirectory, reservationBarrier.releaseFile), 'release');
    const atomicSnapshot = await atomicCreate;
    assert.equal(atomicSnapshot.status, 201, JSON.stringify(atomicSnapshot.body));
    assert.deepEqual(await mutation, { mutated: true });
    const atomicId = String(atomicSnapshot.body?.item.id);
    const frozenPrint = await first.request({ method: 'GET', path: snapshotPath(atomicId, 'print') });
    assert.equal(frozenPrint.status, 200);
    assert.match(frozenPrint.text ?? '', /P00501/u);
    assert.match(frozenPrint.text ?? '', /气动调节阀 PV-30/u);
    assert.doesNotMatch(frozenPrint.text ?? '', /P00501-ATOMIC-MUTATION|MUTATED BETWEEN HEADER AND LINE READ/u);
  } finally {
    await Promise.allSettled([first?.close(), second?.close()].filter((value): value is Promise<void> => value !== undefined));
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test('a stale reservation lease is taken over while its old owner is fenced to replay', { timeout: 30_000 }, async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'readywork-po-doc-stale-lease-'));
  const databasePath = join(fixtureDirectory, 'shared.sqlite');
  const bucketDirectory = join(fixtureDirectory, 'bucket');
  const eventLogPath = join(fixtureDirectory, 'object-events.jsonl');
  const barrierDirectory = join(fixtureDirectory, 'barriers');
  await writeFile(eventLogPath, '');
  const setup = openPersistence(databasePath, { tenantId });
  seed(setup);
  setup.close();
  let first: PoDocumentController | undefined;
  let second: PoDocumentController | undefined;
  try {
    first = await startPoDocumentController({ databasePath, bucketDirectory, eventLogPath });
    second = await startPoDocumentController({ databasePath, bucketDirectory, eventLogPath });
    const staleOwnerBarrier: ControllerBarrier = {
      directory: barrierDirectory, tag: 'stale-owner-after-reservation', releaseFile: 'stale-owner.release', timeoutMs: 15_000,
    };
    const staleOwner = first.request({
      method: 'POST', path: createPath(), body: { expectedVersion: 1, purpose: 'download' },
      idempotencyKey: 'process:stale-lease', afterReservationBarrier: staleOwnerBarrier, reservationLeaseMs: 200,
    });
    await waitForFileMatch(barrierDirectory, (entry) => entry.startsWith('stale-owner-after-reservation-'), 2_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const takeover = await second.request({
      method: 'POST', path: createPath(), body: { expectedVersion: 1, purpose: 'print' },
      idempotencyKey: 'process:stale-lease', reservationLeaseMs: 2_000,
    });
    assert.equal(takeover.status, 201, JSON.stringify(takeover.body));
    await writeFile(join(barrierDirectory, staleOwnerBarrier.releaseFile), 'release');
    const fenced = await staleOwner;
    assert.equal(fenced.status, 200, JSON.stringify(fenced.body));
    assert.equal(fenced.body?.item.id, takeover.body?.item.id);
    const audit = openPersistence(databasePath, { tenantId });
    try {
      assert.equal((audit.db.prepare(`SELECT COUNT(*) AS count FROM procurement_purchase_order_document_snapshots
        WHERE tenant_id=? AND id=?`).get(tenantId, takeover.body?.item.id) as { count: number }).count, 1);
    } finally { audit.close(); }
    const events = (await objectEvents(eventLogPath)).filter((event) => event.attachmentId === takeover.body?.item.id);
    assert.equal(events.filter((event) => event.operation === 'delete').length, 0);
  } finally {
    await Promise.allSettled([first?.close(), second?.close()].filter((value): value is Promise<void> => value !== undefined));
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

function createPath(): string {
  return `/api/procurement/purchase-orders/${encodeURIComponent(purchaseOrderId)}/document-snapshots`;
}

function snapshotPath(id: string, kind: 'pdf' | 'print'): string {
  return `/api/procurement/purchase-order-document-snapshots/${encodeURIComponent(id)}/${kind}`;
}
