import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import {
  createProcurementPurchaseOrderDocumentRequest,
  createProcurementPurchaseOrderDocumentSnapshot,
  getProcurementPurchaseOrderDocumentRequest,
  getProcurementPurchaseOrderDocumentSnapshot,
  markProcurementPurchaseOrderDocumentRequestFailed,
  markProcurementPurchaseOrderDocumentRequestReady,
  takeoverProcurementPurchaseOrderDocumentRequest,
  type ProcurementPurchaseOrderDocumentRequest,
  type ProcurementPurchaseOrderDocumentSnapshot,
} from '@readywork/persistence';
import { can, type Session } from './auth.js';
import {
  attachmentObjectKey,
  type AttachmentObjectIntegrity,
  type AttachmentObjectMetadata,
  type AttachmentObjectStorage,
  type AttachmentObjectValue,
} from './attachment-object-storage.js';

const TEMPLATE_VERSION = 'po-document-v1' as const;
const TEMPLATE_VERSION_STORAGE = 1;
const PROJECTION_SUBJECT_PREFIX = 'readywork-po-projection-v1:';
const FONT_PATH = fileURLToPath(new URL('../assets/fonts/NotoSansSC-Full.ttf', import.meta.url));
const FONT_ROUTE = '/api/procurement/purchase-order-document-assets/noto-sans-sc.ttf';
const FONT_SIZE_BYTES = 17_772_300;
const FONT_SHA256 = 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da';
const PAGE_MARGIN_MM = 12.7;
const DEFAULT_RESERVATION_LEASE_MS = 30_000;
const RESERVATION_LEASE_GRACE_MS = 5_000;
const RESERVATION_POLL_INTERVAL_MS = 50;
let fontBytesPromise: Promise<Uint8Array> | undefined;

Font.register({ family: 'ReadyworkNotoSansSC', src: FONT_PATH });

export type CreatePoDocumentSnapshotInput = { expectedVersion: number; purpose: 'download' | 'print' };
export type PoDocumentSnapshot = {
  id: string;
  purchaseOrderId: string;
  sourcePoVersion: number;
  contextWatermark: string;
  templateVersion: typeof TEMPLATE_VERSION;
  contentSha256: string;
  documentId: string;
  generatedAt: string;
};

export interface ProcurementPoDocumentContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly attachmentObjectStorage?: AttachmentObjectStorage;
  readonly now?: () => Date;
  /** Test-only hook after the durable reservation transaction commits. */
  readonly afterReservationCommit?: () => Promise<void>;
  /** Test-only hook immediately before the fenced finalize transaction starts. */
  readonly beforeSnapshotFinalize?: () => Promise<void>;
  /** Test-only lease duration override; production derives this from storage timeout. */
  readonly reservationLeaseMs?: number;
}

type ProjectionLine = {
  lineNumber: string;
  itemId: string;
  description: string;
  uom: string;
  orderedQty: number;
  unitPrice: number;
  taxRate: number;
  taxIncluded: boolean;
  total: number;
};

type Projection = {
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
  lines: ProjectionLine[];
  contextWatermark: string;
  generatedAt: string;
};

type FrozenProjection = Omit<Projection, 'contextWatermark' | 'generatedAt'>;

type ColumnDefinition = {
  readonly heading: string;
  readonly width: string;
  readonly align?: 'right';
};

const LINE_COLUMNS: readonly ColumnDefinition[] = [
  { heading: '#', width: '6%' },
  { heading: 'CODE', width: '13%' },
  { heading: 'DESCRIPTION', width: '25%' },
  { heading: 'QTY', width: '7%', align: 'right' },
  { heading: 'UOM', width: '7%' },
  { heading: 'UNIT PRICE', width: '22%', align: 'right' },
  { heading: 'AMOUNT', width: '12%', align: 'right' },
  { heading: 'CCY', width: '8%' },
];

const pdfStyles = StyleSheet.create({
  page: { padding: 36, fontFamily: 'ReadyworkNotoSansSC', fontSize: 8, color: '#172033' },
  title: { fontSize: 20, marginBottom: 4 },
  subtitle: { fontSize: 8, color: '#7c2d12', marginBottom: 13 },
  sectionHeading: { fontSize: 8, color: '#475569', marginTop: 10, marginBottom: 5 },
  details: { borderTopWidth: 0.5, borderTopColor: '#d9e1ec', paddingTop: 5 },
  detailLine: { marginBottom: 3 },
  row: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#d9e1ec', paddingVertical: 5 },
  headerRow: { flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: '#94a3b8', borderBottomWidth: 0.75, borderBottomColor: '#94a3b8', paddingVertical: 5 },
  cell: { paddingHorizontal: 2 },
  right: { textAlign: 'right' },
  head: { fontSize: 7, color: '#475569' },
  total: { marginTop: 10, textAlign: 'right', fontSize: 10 },
  documentLine: { color: '#475569', marginBottom: 3 },
});

export async function handleProcurementPoDocumentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementPoDocumentContext,
): Promise<boolean> {
  const createMatch = path.match(/^\/api\/procurement\/purchase-orders\/([^/]+)\/document-snapshots$/u);
  const readMatch = path.match(/^\/api\/procurement\/purchase-order-document-snapshots\/([^/]+)\/(pdf|print)$/u);
  const fontMatch = path === FONT_ROUTE;
  if (!createMatch && !readMatch && !fontMatch) return false;
  if (!context.session) return sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  try {
    if (fontMatch) return await readFont(res, method, context);
    if (createMatch) return await createSnapshot(req, res, decode(createMatch[1]!), method, context);
    return await readSnapshot(res, decode(readMatch![1]!), readMatch![2]! as 'pdf' | 'print', method, context);
  } catch (error) {
    return sendError(res, error);
  }
}

async function readFont(res: ServerResponse, method: string, context: ProcurementPoDocumentContext): Promise<true> {
  if (method !== 'GET') return sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
  if (!can(context.session, 'read')) return sendJson(res, 403, { error: '无读取采购订单文档资源的权限', code: 'FORBIDDEN' });
  const bytes = await fullFontBytes();
  res.writeHead(200, {
    'content-type': 'font/ttf',
    'content-length': String(bytes.byteLength),
    'cache-control': 'private, max-age=31536000, immutable',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-sha256': FONT_SHA256,
  });
  res.end(bytes);
  return true;
}

async function createSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  purchaseOrderId: string,
  method: string,
  context: ProcurementPoDocumentContext,
): Promise<true> {
  if (method !== 'POST') return sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
  if (!can(context.session, 'operate')) return sendJson(res, 403, { error: '无生成采购订单文档快照的权限', code: 'FORBIDDEN' });
  const storage = context.attachmentObjectStorage;
  if (!storage) throw new StorageUnavailableError();
  const input = normalizeInput(await readJson(req));
  const key = idempotencyKey(req);
  const tenantId = context.session!.tenantId;
  const id = `po-document:${digest(`${tenantId}\u0000${key}`).slice(0, 32)}`;
  const payloadFingerprint = digest(stableJson({
    expectedVersion: input.expectedVersion,
    purchaseOrderId,
    templateVersion: TEMPLATE_VERSION,
  }));
  const ownerToken = randomUUID();
  const leaseDurationMs = reservationLeaseDurationMs(context, storage);

  while (true) {
    const claim = claimSnapshotRequest({
      context, tenantId, snapshotId: id, purchaseOrderId, expectedVersion: input.expectedVersion,
      payloadFingerprint, ownerToken, leaseDurationMs,
    });
    if (claim.kind === 'replay') {
      return sendJson(res, 200, {
        item: present(claim.snapshot), replayed: true,
        pdfUrl: pdfUrl(claim.snapshot.id), printUrl: printUrl(claim.snapshot.id),
      });
    }
    if (claim.kind === 'wait') {
      await waitForReservation(claim.leaseExpiresAt);
      continue;
    }

    try {
      if (context.afterReservationCommit) await context.afterReservationCommit();
      const projection = projectionFromRequest(claim.request);
      const pdf = await renderPdf(projection);
      const contentSha256 = digest(pdf);
      const integrity: AttachmentObjectIntegrity = {
        tenantId, attachmentId: id, version: 1, sha256: contentSha256, sizeBytes: pdf.byteLength,
      };
      const object = await ensureSnapshotObject(storage, integrity, pdf);
      const record: Omit<ProcurementPurchaseOrderDocumentSnapshot, 'tenantId'> = {
        id,
        poId: projection.purchaseOrderId,
        documentId: `po-document-pdf:${id}`,
        snapshotKind: 'purchase_order',
        sourcePoVersion: projection.sourcePoVersion,
        contextWatermark: projection.contextWatermark,
        templateVersion: TEMPLATE_VERSION_STORAGE,
        contentSha256,
        objectKey: object.key,
        sizeBytes: pdf.byteLength,
        generatedBy: claim.request.generatedBy,
        generatedAt: projection.generatedAt,
      };
      if (context.beforeSnapshotFinalize) await context.beforeSnapshotFinalize();
      const finalized = finalizeSnapshotRequest(context.db, tenantId, claim.request, record);
      if (finalized.kind === 'lost') continue;
      const replayed = finalized.kind === 'replay';
      return sendJson(res, replayed ? 200 : 201, {
        item: present(finalized.snapshot), replayed,
        pdfUrl: pdfUrl(finalized.snapshot.id), printUrl: printUrl(finalized.snapshot.id),
      });
    } catch (error) {
      const failure = error instanceof StorageFailedError || error instanceof SnapshotFailedError
        ? error
        : new SnapshotFailedError(error);
      let released: boolean;
      try {
        released = failSnapshotRequest(context.db, tenantId, claim.request, failure);
      } catch (releaseError) {
        throw new SnapshotFailedError(releaseError);
      }
      if (!released) continue;
      throw failure;
    }
  }
}

type SnapshotRequestClaim =
  | { kind: 'owner'; request: ProcurementPurchaseOrderDocumentRequest }
  | { kind: 'wait'; leaseExpiresAt: number }
  | { kind: 'replay'; snapshot: ProcurementPurchaseOrderDocumentSnapshot };

function claimSnapshotRequest(input: {
  context: ProcurementPoDocumentContext;
  tenantId: string;
  snapshotId: string;
  purchaseOrderId: string;
  expectedVersion: number;
  payloadFingerprint: string;
  ownerToken: string;
  leaseDurationMs: number;
}): SnapshotRequestClaim {
  const { context, tenantId, snapshotId, purchaseOrderId, expectedVersion, payloadFingerprint, ownerToken, leaseDurationMs } = input;
  let transactionOpen = false;
  try {
    context.db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const snapshot = getProcurementPurchaseOrderDocumentSnapshot(context.db, tenantId, snapshotId);
    if (snapshot) {
      assertReplayMatches(snapshot, purchaseOrderId, expectedVersion);
      context.db.exec('COMMIT');
      transactionOpen = false;
      return { kind: 'replay', snapshot };
    }

    const nowEpochMs = Date.now();
    const updatedAt = new Date(nowEpochMs).toISOString();
    const existing = getProcurementPurchaseOrderDocumentRequest(context.db, tenantId, snapshotId);
    if (existing) {
      assertRequestMatches(existing, purchaseOrderId, expectedVersion, payloadFingerprint);
      if (existing.state === 'ready') throw new Error('ready PO document request has no snapshot');
      if (existing.state === 'failed' || existing.leaseExpiresAt <= nowEpochMs) {
        const taken = takeoverProcurementPurchaseOrderDocumentRequest(context.db, tenantId, {
          snapshotId,
          expectedLeaseVersion: existing.leaseVersion,
          ownerToken,
          leaseExpiresAt: nowEpochMs + leaseDurationMs,
          nowEpochMs,
          updatedAt,
        });
        if (taken) {
          context.db.exec('COMMIT');
          transactionOpen = false;
          return { kind: 'owner', request: taken };
        }
      }
      context.db.exec('COMMIT');
      transactionOpen = false;
      return { kind: 'wait', leaseExpiresAt: existing.leaseExpiresAt };
    }

    const projection = loadProjection(context.db, tenantId, purchaseOrderId, context.now?.() ?? new Date());
    if (projection.sourcePoVersion !== expectedVersion) throw new VersionConflictError(projection.sourcePoVersion);
    const request = createProcurementPurchaseOrderDocumentRequest(context.db, tenantId, {
      snapshotId,
      poId: purchaseOrderId,
      sourcePoVersion: expectedVersion,
      payloadFingerprint,
      projectionJson: stableJson(projection),
      generatedBy: context.session!.humanId,
      generatedAt: projection.generatedAt,
      state: 'generating',
      ownerToken,
      leaseVersion: 1,
      leaseExpiresAt: nowEpochMs + leaseDurationMs,
      lastError: null,
      createdAt: updatedAt,
      updatedAt,
    });
    context.db.exec('COMMIT');
    transactionOpen = false;
    return { kind: 'owner', request };
  } catch (error) {
    if (transactionOpen) rollback(context.db);
    throw error;
  }
}

function finalizeSnapshotRequest(
  db: DatabaseSync,
  tenantId: string,
  request: ProcurementPurchaseOrderDocumentRequest,
  record: Omit<ProcurementPurchaseOrderDocumentSnapshot, 'tenantId'>,
): { kind: 'created' | 'replay'; snapshot: ProcurementPurchaseOrderDocumentSnapshot } | { kind: 'lost' } {
  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const existing = getProcurementPurchaseOrderDocumentSnapshot(db, tenantId, request.snapshotId);
    if (existing) {
      assertReplayMatches(existing, request.poId, request.sourcePoVersion);
      db.exec('COMMIT');
      transactionOpen = false;
      return { kind: 'replay', snapshot: existing };
    }
    const current = getProcurementPurchaseOrderDocumentRequest(db, tenantId, request.snapshotId);
    if (!current) throw new Error('PO document request disappeared before finalize');
    assertSameRequest(current, request);
    if (current.state !== 'generating' || current.ownerToken !== request.ownerToken
      || current.leaseVersion !== request.leaseVersion) {
      db.exec('COMMIT');
      transactionOpen = false;
      return { kind: 'lost' };
    }
    const snapshot = createProcurementPurchaseOrderDocumentSnapshot(db, tenantId, record);
    const ready = markProcurementPurchaseOrderDocumentRequestReady(db, tenantId, {
      snapshotId: request.snapshotId,
      ownerToken: request.ownerToken,
      leaseVersion: request.leaseVersion,
      updatedAt: new Date().toISOString(),
    });
    if (!ready) throw new Error('PO document request ownership changed during finalize');
    db.exec('COMMIT');
    transactionOpen = false;
    return { kind: 'created', snapshot };
  } catch (error) {
    if (transactionOpen) rollback(db);
    throw error;
  }
}

function failSnapshotRequest(
  db: DatabaseSync,
  tenantId: string,
  request: ProcurementPurchaseOrderDocumentRequest,
  error: Error,
): boolean {
  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    if (getProcurementPurchaseOrderDocumentSnapshot(db, tenantId, request.snapshotId)) {
      db.exec('COMMIT');
      transactionOpen = false;
      return false;
    }
    const released = markProcurementPurchaseOrderDocumentRequestFailed(db, tenantId, {
      snapshotId: request.snapshotId,
      ownerToken: request.ownerToken,
      leaseVersion: request.leaseVersion,
      lastError: `${error.name || 'Error'}: ${error.message}`.slice(0, 1_000),
      updatedAt: new Date().toISOString(),
    });
    db.exec('COMMIT');
    transactionOpen = false;
    return released;
  } catch (failure) {
    if (transactionOpen) rollback(db);
    throw failure;
  }
}

function reservationLeaseDurationMs(
  context: ProcurementPoDocumentContext,
  storage: AttachmentObjectStorage,
): number {
  if (context.reservationLeaseMs !== undefined) {
    if (!Number.isSafeInteger(context.reservationLeaseMs) || context.reservationLeaseMs < 1) {
      throw new SnapshotFailedError(new Error('invalid test reservation lease duration'));
    }
    return context.reservationLeaseMs;
  }
  const storageTimeoutMs = storage.requestTimeoutMs ?? 0;
  if (!Number.isSafeInteger(storageTimeoutMs) || storageTimeoutMs < 0
    || storageTimeoutMs > Number.MAX_SAFE_INTEGER - RESERVATION_LEASE_GRACE_MS) {
    throw new SnapshotFailedError(new Error('invalid object-storage request timeout'));
  }
  return Math.max(DEFAULT_RESERVATION_LEASE_MS, storageTimeoutMs + RESERVATION_LEASE_GRACE_MS);
}

async function waitForReservation(leaseExpiresAt: number): Promise<void> {
  const remaining = leaseExpiresAt - Date.now();
  const delay = Math.max(1, Math.min(RESERVATION_POLL_INTERVAL_MS, remaining > 0 ? remaining : 1));
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function projectionFromRequest(request: ProcurementPurchaseOrderDocumentRequest): Projection {
  let parsed: unknown;
  try { parsed = JSON.parse(request.projectionJson) as unknown; }
  catch { throw new Error('stored PO document projection is invalid JSON'); }
  const projection = validateProjection(parsed);
  if (stableJson(projection) !== request.projectionJson) throw new Error('stored PO document projection is not canonical');
  const { contextWatermark, generatedAt, ...frozen } = projection;
  if (projection.purchaseOrderId !== request.poId || projection.sourcePoVersion !== request.sourcePoVersion
    || generatedAt !== request.generatedAt || contextWatermark !== watermark(frozen)) {
    throw new Error('stored PO document projection does not match its reservation');
  }
  return projection;
}

async function ensureSnapshotObject(
  storage: AttachmentObjectStorage,
  integrity: AttachmentObjectIntegrity,
  pdf: Uint8Array,
): Promise<AttachmentObjectMetadata> {
  const existing = await exactSnapshotHead(storage, integrity);
  if (existing) return existing;
  let putError: unknown;
  try {
    const stored = await storage.put({ ...integrity, body: pdf, contentType: 'application/pdf' });
    assertPutObject(integrity, stored);
    return stored;
  } catch (error) {
    putError = error;
  }
  const reconciled = await exactSnapshotHead(storage, integrity);
  if (reconciled) return reconciled;
  if (putError instanceof SnapshotFailedError) throw putError;
  throw new StorageFailedError(putError);
}

async function exactSnapshotHead(
  storage: AttachmentObjectStorage,
  integrity: AttachmentObjectIntegrity,
): Promise<AttachmentObjectMetadata | null> {
  try {
    const object = await storage.head(integrity);
    if (object) assertPutObject(integrity, object);
    return object;
  } catch (error) {
    if (error instanceof SnapshotFailedError) throw error;
    throw new StorageFailedError(error);
  }
}

function assertRequestMatches(
  request: ProcurementPurchaseOrderDocumentRequest,
  purchaseOrderId: string,
  expectedVersion: number,
  payloadFingerprint: string,
): void {
  if (request.poId !== purchaseOrderId || request.sourcePoVersion !== expectedVersion
    || request.payloadFingerprint !== payloadFingerprint) throw new IdempotencyConflictError();
}

function assertSameRequest(
  current: ProcurementPurchaseOrderDocumentRequest,
  claimed: ProcurementPurchaseOrderDocumentRequest,
): void {
  if (current.snapshotId !== claimed.snapshotId || current.poId !== claimed.poId
    || current.sourcePoVersion !== claimed.sourcePoVersion || current.payloadFingerprint !== claimed.payloadFingerprint
    || current.projectionJson !== claimed.projectionJson || current.generatedBy !== claimed.generatedBy
    || current.generatedAt !== claimed.generatedAt || current.createdAt !== claimed.createdAt) {
    throw new Error('PO document request immutable payload changed');
  }
}

async function readSnapshot(
  res: ServerResponse,
  id: string,
  kind: 'pdf' | 'print',
  method: string,
  context: ProcurementPoDocumentContext,
): Promise<true> {
  if (method !== 'GET') return sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
  if (!can(context.session, 'read')) return sendJson(res, 403, { error: '无读取采购订单文档快照的权限', code: 'FORBIDDEN' });
  const storage = context.attachmentObjectStorage;
  if (!storage) throw new StorageUnavailableError();
  const snapshot = getProcurementPurchaseOrderDocumentSnapshot(context.db, context.session!.tenantId, id);
  if (!snapshot) throw new NotFoundError();
  if (snapshot.templateVersion !== TEMPLATE_VERSION_STORAGE || snapshot.snapshotKind !== 'purchase_order') {
    throw new SnapshotFailedError(new Error('unsupported snapshot metadata'));
  }

  let object: AttachmentObjectValue;
  try {
    object = await storage.get(snapshotIntegrity(snapshot));
  } catch (error) {
    throw new StorageFailedError(error);
  }
  assertStoredObject(snapshot, object);
  const projection = await recoverProjection(object.body, snapshot);

  if (kind === 'pdf') {
    const filename = `${safeFileName(projection.number)}-v${snapshot.sourcePoVersion}-${snapshot.contentSha256.slice(0, 8)}.pdf`;
    res.writeHead(200, snapshotHeaders(snapshot, {
      'content-type': 'application/pdf',
      'content-length': String(object.body.byteLength),
      'content-disposition': `attachment; filename="${filename}"`,
    }));
    res.end(object.body);
    return true;
  }

  res.writeHead(200, snapshotHeaders(snapshot, { 'content-type': 'text/html; charset=utf-8' }));
  res.end(renderPrintHtml(projection, snapshot));
  return true;
}

function loadProjection(
  db: DatabaseSync,
  tenantId: string,
  purchaseOrderId: string,
  now: Date,
): Projection {
  const row = db.prepare(`SELECT version,status,json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, purchaseOrderId) as
      { version: number; status: string; json: string } | undefined;
  if (!row) throw new NotFoundError();
  const po = objectJson(row.json);

  const supplierId = text(po['supplierId']);
  const supplierRow = supplierId
    ? db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?`)
      .get(tenantId, supplierId) as { json: string } | undefined
    : undefined;
  const supplier = supplierRow ? objectJson(supplierRow.json) : {};
  const contacts = Array.isArray(supplier['contacts']) ? supplier['contacts'] : [];
  const primary = contacts.find((contact) => contact && typeof contact === 'object'
    && (contact as Record<string, unknown>)['primary'] === true) as Record<string, unknown> | undefined;
  const lineRows = db.prepare(`SELECT json FROM procurement_lines
    WHERE tenant_id=? AND kind='purchase_order_line' AND document_id=? ORDER BY line_number,id`)
    .all(tenantId, purchaseOrderId) as Array<{ json: string }>;
  if (lineRows.length === 0) throw new InputError('采购订单必须至少包含一个有效行项目');
  const lines = lineRows.map((entry, index) => projectionLine(objectJson(entry.json), index));
  const frozen: FrozenProjection = {
    purchaseOrderId,
    number: text(po['number'], text(po['externalId'], purchaseOrderId)),
    sourcePoVersion: row.version,
    supplierName: text(supplier['name'], text(po['supplierName'], supplierId || '—')),
    supplierEmail: text(primary?.['email']),
    currency: text(po['currency'], 'CNY'),
    orderedAt: optionalText(po['orderedAt']),
    requiredInHouseAt: optionalText(po['requiredInHouseAt']),
    route: text(po['route'], '—'),
    status: text(po['status'], row.status),
    lines,
  };
  return {
    ...frozen,
    contextWatermark: watermark(frozen),
    generatedAt: validGeneratedAt(now),
  };
}

function projectionLine(line: Record<string, unknown>, index: number): ProjectionLine {
  const label = text(line['lineNumber'], String(index + 1));
  const orderedQty = requiredNumber(line['orderedQty'], `行 ${label} 的订购数量`, { exclusiveMinimum: 0 });
  const unitPrice = requiredNumber(line['unitPrice'], `行 ${label} 的单价`, { minimum: 0 });
  const taxRate = requiredNumber(line['taxRate'], `行 ${label} 的税率`, { minimum: 0, maximum: 1 });
  if (typeof line['taxIncluded'] !== 'boolean') throw new InputError(`行 ${label} 的 taxIncluded 必须是布尔值`);
  const taxIncluded = line['taxIncluded'];
  return {
    lineNumber: label,
    itemId: text(line['itemId'], '—'),
    description: text(line['description'], '—'),
    uom: text(line['uom'], '—'),
    orderedQty,
    unitPrice,
    taxRate,
    taxIncluded,
    total: lineTotal({ orderedQty, unitPrice, taxRate, taxIncluded }),
  };
}

function lineTotal(line: Pick<ProjectionLine, 'orderedQty' | 'unitPrice' | 'taxRate' | 'taxIncluded'>): number {
  const amount = line.orderedQty * line.unitPrice * (line.taxIncluded ? 1 : 1 + line.taxRate);
  return roundMoney(amount);
}

async function renderPdf(projection: Projection): Promise<Uint8Array> {
  await fullFontBytes();
  const rows = projection.lines.map((line) => React.createElement(
    View,
    { key: `${line.lineNumber}:${line.itemId}`, style: pdfStyles.row, wrap: false },
    ...lineCells(line, projection.currency).map((value, index) => pdfCell(value, LINE_COLUMNS[index]!)),
  ));
  const totalFormula = totalFormulaText(projection);
  const subject = `${PROJECTION_SUBJECT_PREFIX}${Buffer.from(stableJson(projection), 'utf8').toString('base64url')}`;
  const document = React.createElement(
    Document,
    {
      title: `Purchase Order ${projection.number}`,
      subject,
      author: 'Readywork',
      creator: 'Readywork PO document service',
      creationDate: new Date(projection.generatedAt),
      modificationDate: new Date(projection.generatedAt),
    },
    React.createElement(
      Page,
      { size: 'A4', style: pdfStyles.page, wrap: true },
      React.createElement(Text, { style: pdfStyles.title }, 'Purchase Order / 采购订单'),
      React.createElement(Text, { style: pdfStyles.subtitle }, 'system-generated snapshot · not an executed contract'),
      React.createElement(Text, { style: pdfStyles.sectionHeading }, 'ORDER DETAILS'),
      React.createElement(
        View,
        { style: pdfStyles.details, wrap: false },
        React.createElement(Text, { style: pdfStyles.detailLine }, `PO ${projection.number} · Version ${projection.sourcePoVersion} · Status ${projection.status}`),
        React.createElement(Text, { style: pdfStyles.detailLine }, `Supplier ${projection.supplierName} · Email ${projection.supplierEmail || '—'} · Route ${projection.route}`),
        React.createElement(Text, { style: pdfStyles.detailLine }, `Ordered ${projection.orderedAt ?? '—'} · Required in-house ${projection.requiredInHouseAt ?? '—'}`),
      ),
      React.createElement(Text, { style: pdfStyles.sectionHeading }, 'LINE ITEMS'),
      React.createElement(
        View,
        { style: pdfStyles.headerRow, wrap: false, fixed: true },
        ...LINE_COLUMNS.map((column) => pdfCell(column.heading, column, pdfStyles.head)),
      ),
      ...rows,
      React.createElement(Text, { style: pdfStyles.total, wrap: false }, `Grand total ${totalFormula}`),
      React.createElement(Text, { style: pdfStyles.sectionHeading }, 'DOCUMENTS'),
      React.createElement(Text, { style: pdfStyles.documentLine }, `Context watermark ${projection.contextWatermark}`),
      React.createElement(Text, { style: pdfStyles.documentLine }, `Template ${TEMPLATE_VERSION} · Generated ${projection.generatedAt}`),
    ),
  );
  return new Uint8Array(await renderToBuffer(document));
}

function pdfCell(value: string, column: ColumnDefinition, extraStyle?: object): React.ReactElement {
  return React.createElement(Text, {
    style: [pdfStyles.cell, { width: column.width }, column.align === 'right' ? pdfStyles.right : undefined, extraStyle] as any,
  }, value);
}

function lineCells(line: ProjectionLine, currency: string): string[] {
  return [
    line.lineNumber,
    line.itemId,
    line.description,
    formatNumber(line.orderedQty),
    line.uom,
    `${formatMoney(line.unitPrice)} ${line.taxIncluded ? 'Tax included' : 'Tax excluded'} · ${formatRate(line.taxRate)}`,
    formatMoney(line.total),
    currency,
  ];
}

function renderPrintHtml(projection: Projection, snapshot: ProcurementPurchaseOrderDocumentSnapshot): string {
  const headings = LINE_COLUMNS.map((column) => `<th scope="col"${column.align === 'right' ? ' class="number"' : ''}>${escapeHtml(column.heading)}</th>`).join('');
  const rows = projection.lines.map((line) => `<tr>${lineCells(line, projection.currency).map((value, index) =>
    `<td${LINE_COLUMNS[index]!.align === 'right' ? ' class="number"' : ''}>${escapeHtml(value)}</td>`).join('')}</tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Purchase Order ${escapeHtml(projection.number)}</title><style>@page{size:A4;margin:${PAGE_MARGIN_MM}mm}@font-face{font-family:"Readywork Noto Sans SC";src:url("${FONT_ROUTE}") format("truetype");font-style:normal;font-weight:100 900;font-display:block}*{box-sizing:border-box}body{margin:0;font:11px/1.45 "Readywork Noto Sans SC";color:#172033}button{margin:0 0 12px;padding:7px 14px}h1{margin:0 0 3px;font-size:22px}.notice{margin:0 0 16px;color:#7c2d12}.section{margin-top:16px}.section h2{margin:0 0 7px;font-size:10px;letter-spacing:.08em;color:#475569}.details{display:grid;grid-template-columns:1fr 1fr;gap:5px 20px;border-top:1px solid #d9e1ec;padding-top:8px}.details div{break-inside:avoid}.details dt{display:inline;color:#64748b}.details dd{display:inline;margin:0 0 0 5px}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}tr{break-inside:avoid}th,td{padding:6px 3px;border-bottom:1px solid #d9e1ec;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{border-top:1px solid #94a3b8;border-bottom-color:#94a3b8;font-size:9px;color:#475569}th:nth-child(1),td:nth-child(1){width:6%}th:nth-child(2),td:nth-child(2){width:13%}th:nth-child(3),td:nth-child(3){width:25%}th:nth-child(4),td:nth-child(4){width:7%}th:nth-child(5),td:nth-child(5){width:7%}th:nth-child(6),td:nth-child(6){width:22%}th:nth-child(7),td:nth-child(7){width:12%}th:nth-child(8),td:nth-child(8){width:8%}.number{text-align:right}.grand-total{margin-top:10px;text-align:right;font-size:13px}.calculation{text-align:right;color:#64748b}.documents{color:#475569}.documents p{margin:4px 0;overflow-wrap:anywhere}@media print{button{display:none}}</style></head><body><button type="button" onclick="window.print()">Print</button><h1>Purchase Order / 采购订单</h1><p class="notice">system-generated snapshot · not an executed contract</p><section class="section" aria-labelledby="order-details"><h2 id="order-details">ORDER DETAILS</h2><dl class="details"><div><dt>PO</dt><dd>${escapeHtml(projection.number)}</dd></div><div><dt>Version</dt><dd>${projection.sourcePoVersion}</dd></div><div><dt>Supplier</dt><dd>${escapeHtml(projection.supplierName)}</dd></div><div><dt>Email</dt><dd>${escapeHtml(projection.supplierEmail || '—')}</dd></div><div><dt>Status</dt><dd>${escapeHtml(projection.status)}</dd></div><div><dt>Route</dt><dd>${escapeHtml(projection.route)}</dd></div><div><dt>Ordered</dt><dd>${escapeHtml(projection.orderedAt ?? '—')}</dd></div><div><dt>Required in-house</dt><dd>${escapeHtml(projection.requiredInHouseAt ?? '—')}</dd></div></dl></section><section class="section" aria-labelledby="line-items"><h2 id="line-items">LINE ITEMS</h2><table><thead><tr>${headings}</tr></thead><tbody>${rows}</tbody></table><div class="grand-total">Grand total <strong>${formatMoney(grandTotal(projection))}</strong> ${escapeHtml(projection.currency)}</div><div class="calculation">${escapeHtml(totalFormulaText(projection))}</div></section><section class="section documents" aria-labelledby="documents"><h2 id="documents">DOCUMENTS</h2><p>Context watermark: ${escapeHtml(snapshot.contextWatermark)}</p><p>Template: ${TEMPLATE_VERSION} · Content SHA-256: ${escapeHtml(snapshot.contentSha256)}</p><p>Generated: ${escapeHtml(snapshot.generatedAt)}</p></section><script>window.addEventListener('load',function(){window.print()},{once:true})</script></body></html>`;
}

async function recoverProjection(pdfBytes: Uint8Array, snapshot: ProcurementPurchaseOrderDocumentSnapshot): Promise<Projection> {
  let loadingTask: { promise: Promise<any>; destroy: () => Promise<void> } | undefined;
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    loadingTask = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: false }) as typeof loadingTask;
    const pdf = await loadingTask!.promise;
    const metadata = await pdf.getMetadata();
    const subject = (metadata.info as Record<string, unknown>)['Subject'];
    if (typeof subject !== 'string' || !subject.startsWith(PROJECTION_SUBJECT_PREFIX)) {
      throw new Error('missing versioned projection metadata');
    }
    const encoded = subject.slice(PROJECTION_SUBJECT_PREFIX.length);
    if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error('invalid projection encoding');
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    const canonicalEncoding = Buffer.from(decoded, 'utf8').toString('base64url');
    if (canonicalEncoding !== encoded) throw new Error('non-canonical projection encoding');
    const parsed = JSON.parse(decoded) as unknown;
    const projection = validateProjection(parsed);
    if (stableJson(projection) !== decoded) throw new Error('projection JSON is not canonical');
    validateProjectionSnapshot(projection, snapshot);
    return projection;
  } catch (error) {
    if (error instanceof SnapshotFailedError) throw error;
    throw new SnapshotFailedError(error);
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => undefined);
  }
}

function validateProjection(value: unknown): Projection {
  const projection = strictObject(value, [
    'purchaseOrderId', 'number', 'sourcePoVersion', 'supplierName', 'supplierEmail', 'currency', 'orderedAt',
    'requiredInHouseAt', 'route', 'status', 'lines', 'contextWatermark', 'generatedAt',
  ], 'projection');
  const linesValue = projection['lines'];
  if (!Array.isArray(linesValue) || linesValue.length === 0) throw new Error('projection lines must be a non-empty array');
  const lines = linesValue.map((value, index) => {
    const line = strictObject(value, [
      'lineNumber', 'itemId', 'description', 'uom', 'orderedQty', 'unitPrice', 'taxRate', 'taxIncluded', 'total',
    ], `projection line ${index + 1}`);
    const result: ProjectionLine = {
      lineNumber: strictString(line['lineNumber'], 'lineNumber'),
      itemId: strictString(line['itemId'], 'itemId'),
      description: strictString(line['description'], 'description'),
      uom: strictString(line['uom'], 'uom'),
      orderedQty: strictNumber(line['orderedQty'], 'orderedQty', { exclusiveMinimum: 0 }),
      unitPrice: strictNumber(line['unitPrice'], 'unitPrice', { minimum: 0 }),
      taxRate: strictNumber(line['taxRate'], 'taxRate', { minimum: 0, maximum: 1 }),
      taxIncluded: strictBoolean(line['taxIncluded'], 'taxIncluded'),
      total: strictNumber(line['total'], 'total', { minimum: 0 }),
    };
    if (result.total !== lineTotal(result)) throw new Error(`projection line ${index + 1} total mismatch`);
    return result;
  });
  return {
    purchaseOrderId: strictString(projection['purchaseOrderId'], 'purchaseOrderId'),
    number: strictString(projection['number'], 'number'),
    sourcePoVersion: strictInteger(projection['sourcePoVersion'], 'sourcePoVersion', 1),
    supplierName: strictString(projection['supplierName'], 'supplierName'),
    supplierEmail: strictString(projection['supplierEmail'], 'supplierEmail', true),
    currency: strictString(projection['currency'], 'currency'),
    orderedAt: strictNullableString(projection['orderedAt'], 'orderedAt'),
    requiredInHouseAt: strictNullableString(projection['requiredInHouseAt'], 'requiredInHouseAt'),
    route: strictString(projection['route'], 'route'),
    status: strictString(projection['status'], 'status'),
    lines,
    contextWatermark: strictString(projection['contextWatermark'], 'contextWatermark'),
    generatedAt: strictTimestamp(projection['generatedAt'], 'generatedAt'),
  };
}

function validateProjectionSnapshot(projection: Projection, snapshot: ProcurementPurchaseOrderDocumentSnapshot): void {
  const { contextWatermark: ignoredWatermark, generatedAt: ignoredGeneratedAt, ...frozen } = projection;
  void ignoredWatermark;
  void ignoredGeneratedAt;
  if (projection.contextWatermark !== watermark(frozen)) throw new Error('projection watermark mismatch');
  if (projection.purchaseOrderId !== snapshot.poId) throw new Error('projection purchase-order mismatch');
  if (projection.sourcePoVersion !== snapshot.sourcePoVersion) throw new Error('projection version mismatch');
  if (projection.contextWatermark !== snapshot.contextWatermark) throw new Error('projection snapshot watermark mismatch');
  if (projection.generatedAt !== snapshot.generatedAt) throw new Error('projection generated time mismatch');
}

function assertStoredObject(snapshot: ProcurementPurchaseOrderDocumentSnapshot, object: AttachmentObjectValue): void {
  const actualHash = digest(object.body);
  if (object.body.byteLength !== snapshot.sizeBytes || actualHash !== snapshot.contentSha256
    || object.metadata.tenantId !== snapshot.tenantId || object.metadata.attachmentId !== snapshot.id
    || object.metadata.version !== 1 || object.metadata.sha256 !== snapshot.contentSha256
    || object.metadata.sizeBytes !== snapshot.sizeBytes || object.metadata.key !== snapshot.objectKey
    || object.metadata.contentType !== 'application/pdf') {
    throw new SnapshotFailedError(new Error('snapshot object integrity mismatch'));
  }
}

function assertPutObject(integrity: AttachmentObjectIntegrity, object: AttachmentObjectMetadata): void {
  if (object.tenantId !== integrity.tenantId || object.attachmentId !== integrity.attachmentId
    || object.version !== integrity.version || object.sha256 !== integrity.sha256
    || object.sizeBytes !== integrity.sizeBytes || object.key !== attachmentObjectKey(integrity)
    || object.contentType !== 'application/pdf') {
    throw new SnapshotFailedError(new Error('stored snapshot metadata mismatch'));
  }
}

function assertReplayMatches(
  snapshot: ProcurementPurchaseOrderDocumentSnapshot,
  purchaseOrderId: string,
  expectedVersion: number,
): void {
  if (snapshot.poId !== purchaseOrderId || snapshot.sourcePoVersion !== expectedVersion
    || snapshot.templateVersion !== TEMPLATE_VERSION_STORAGE || snapshot.snapshotKind !== 'purchase_order') {
    throw new IdempotencyConflictError();
  }
}

function present(
  snapshot: Omit<ProcurementPurchaseOrderDocumentSnapshot, 'tenantId'> | ProcurementPurchaseOrderDocumentSnapshot,
): PoDocumentSnapshot {
  return {
    id: snapshot.id,
    purchaseOrderId: snapshot.poId,
    sourcePoVersion: snapshot.sourcePoVersion,
    contextWatermark: snapshot.contextWatermark,
    templateVersion: TEMPLATE_VERSION,
    contentSha256: snapshot.contentSha256,
    documentId: snapshot.documentId,
    generatedAt: snapshot.generatedAt,
  };
}

function normalizeInput(value: unknown): CreatePoDocumentSnapshotInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('请求体必须是 JSON 对象');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'expectedVersion' && key !== 'purpose')) throw new InputError('请求包含不支持的字段');
  if (!Number.isSafeInteger(body['expectedVersion']) || (body['expectedVersion'] as number) < 1) throw new InputError('expectedVersion 必须是正整数');
  if (body['purpose'] !== 'download' && body['purpose'] !== 'print') throw new InputError('purpose 必须是 download 或 print');
  return { expectedVersion: body['expectedVersion'] as number, purpose: body['purpose'] };
}

function snapshotHeaders(snapshot: ProcurementPurchaseOrderDocumentSnapshot, values: Record<string, string>): Record<string, string> {
  return {
    ...values,
    'cache-control': 'private, no-store',
    'x-content-sha256': snapshot.contentSha256,
    'x-po-context-watermark': snapshot.contextWatermark,
    'x-po-template-version': TEMPLATE_VERSION,
  };
}

function snapshotIntegrity(snapshot: ProcurementPurchaseOrderDocumentSnapshot): AttachmentObjectIntegrity {
  return { tenantId: snapshot.tenantId, attachmentId: snapshot.id, version: 1, sha256: snapshot.contentSha256, sizeBytes: snapshot.sizeBytes };
}

async function fullFontBytes(): Promise<Uint8Array> {
  fontBytesPromise ??= readFile(FONT_PATH).then((bytes) => {
    if (bytes.byteLength !== FONT_SIZE_BYTES || digest(bytes) !== FONT_SHA256) throw new Error('Noto Sans SC font integrity mismatch');
    return new Uint8Array(bytes);
  });
  return fontBytesPromise;
}

function strictObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} keys mismatch`);
  return object;
}

function strictString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${label} must be a string`);
  return value;
}

function strictNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return strictString(value, label);
}

function strictBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function strictInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer`);
  return value as number;
}

function strictNumber(
  value: unknown,
  label: string,
  limits: { minimum?: number; exclusiveMinimum?: number; maximum?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || (limits.minimum !== undefined && value < limits.minimum)
    || (limits.exclusiveMinimum !== undefined && value <= limits.exclusiveMinimum)
    || (limits.maximum !== undefined && value > limits.maximum)) throw new Error(`${label} must be a valid number`);
  return value;
}

function strictTimestamp(value: unknown, label: string): string {
  const candidate = strictString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(candidate) || Number.isNaN(Date.parse(candidate))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return candidate;
}

function requiredNumber(
  value: unknown,
  label: string,
  limits: { minimum?: number; exclusiveMinimum?: number; maximum?: number },
): number {
  try {
    return strictNumber(value, label, limits);
  } catch {
    throw new InputError(`${label}无效`);
  }
}

function validGeneratedAt(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new InputError('文档生成时间无效');
  return value.toISOString();
}

function grandTotal(projection: Projection): number {
  return roundMoney(projection.lines.reduce((sum, line) => sum + line.total, 0));
}

function totalFormulaText(projection: Projection): string {
  return `${projection.lines.map((line) => formatMoney(line.total)).join(' + ')} = ${formatMoney(grandTotal(projection))} ${projection.currency}`;
}

function formatMoney(value: number): string { return value.toFixed(2); }
function formatNumber(value: number): string { return Number.isInteger(value) ? String(value) : String(value); }
function formatRate(value: number): string { return `${Number((value * 100).toFixed(4))}%`; }
function roundMoney(value: number): number { return Math.round((value + Number.EPSILON) * 100) / 100; }
function watermark(frozen: FrozenProjection): string { return `po-context-v1:${digest(stableJson(frozen))}`; }
function pdfUrl(id: string): string { return `/api/procurement/purchase-order-document-snapshots/${encodeURIComponent(id)}/pdf`; }
function printUrl(id: string): string { return `/api/procurement/purchase-order-document-snapshots/${encodeURIComponent(id)}/print`; }
function decode(value: string): string { try { return decodeURIComponent(value); } catch { throw new InputError('ID 无效'); } }
function idempotencyKey(req: IncomingMessage): string {
  const value = req.headers['idempotency-key'];
  const key = (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/u.test(key)) throw new InputError('Idempotency-Key 必填且最长 200 个字符');
  return key;
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.byteLength;
    if (size > 64 * 1024) throw new InputError('请求体过大');
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown; }
  catch { throw new InputError('请求体不是有效 JSON'); }
}
function objectJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid object JSON');
    return parsed as Record<string, unknown>;
  } catch {
    throw new InputError('采购订单上下文包含无效 JSON');
  }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('unsupported canonical JSON value');
  return encoded;
}
function digest(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
function text(value: unknown, fallback = ''): string { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }
function optionalText(value: unknown): string | null { const candidate = text(value); return candidate || null; }
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
function safeFileName(value: string): string { return value.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '') || 'purchase-order'; }
function rollback(db: DatabaseSync): void { try { db.exec('ROLLBACK'); } catch { /* no active transaction */ } }
function isExpectedError(error: unknown): boolean {
  return error instanceof InputError || error instanceof NotFoundError || error instanceof VersionConflictError
    || error instanceof IdempotencyConflictError || error instanceof StorageUnavailableError
    || error instanceof StorageFailedError || error instanceof SnapshotFailedError;
}
function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
function sendError(res: ServerResponse, error: unknown): true {
  if (error instanceof InputError) return sendJson(res, 422, { error: error.message, code: 'INVALID_PO_DOCUMENT_INPUT' });
  if (error instanceof NotFoundError) return sendJson(res, 404, { error: error.message, code: 'PO_DOCUMENT_NOT_FOUND' });
  if (error instanceof VersionConflictError) return sendJson(res, 409, { error: error.message, code: 'PO_DOCUMENT_VERSION_CONFLICT', currentVersion: error.currentVersion });
  if (error instanceof IdempotencyConflictError) return sendJson(res, 409, { error: error.message, code: 'PO_DOCUMENT_IDEMPOTENCY_CONFLICT' });
  if (error instanceof StorageUnavailableError) return sendJson(res, 503, { error: error.message, code: 'PO_DOCUMENT_STORAGE_UNAVAILABLE' });
  if (error instanceof StorageFailedError) return sendJson(res, 500, { error: error.message, code: 'PO_DOCUMENT_STORAGE_FAILED' });
  if (error instanceof SnapshotFailedError) return sendJson(res, 500, { error: error.message, code: 'PO_DOCUMENT_SNAPSHOT_FAILED' });
  return sendJson(res, 500, { error: '采购订单文档快照创建失败', code: 'PO_DOCUMENT_SNAPSHOT_FAILED' });
}

class InputError extends Error {}
class NotFoundError extends Error { constructor() { super('采购订单文档快照不存在'); } }
class VersionConflictError extends Error { constructor(readonly currentVersion: number) { super('采购订单版本已变化，请刷新后重试'); } }
class IdempotencyConflictError extends Error { constructor() { super('该 Idempotency-Key 已用于不同的采购订单文档快照'); } }
class StorageUnavailableError extends Error { constructor() { super('采购订单文档对象存储未配置'); } }
class StorageFailedError extends Error { constructor(_cause: unknown) { super('采购订单文档对象存储失败'); } }
class SnapshotFailedError extends Error { constructor(_cause: unknown) { super('采购订单文档快照完整性校验或元数据写入失败'); } }
