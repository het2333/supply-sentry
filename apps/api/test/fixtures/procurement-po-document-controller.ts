import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { openPersistence } from '@readywork/persistence';
import type { Session } from '../../src/auth.js';
import {
  attachmentObjectKey,
  type AttachmentObjectIntegrity,
  type AttachmentObjectMetadata,
  type AttachmentObjectStorage,
  type AttachmentObjectValue,
  type PutAttachmentObjectInput,
} from '../../src/attachment-object-storage.js';
import { handleProcurementPoDocumentRequest } from '../../src/procurement-po-documents.js';

type Barrier = {
  directory: string;
  tag: string;
  releaseFile: string;
  expectedArrivals?: number;
  timeoutMs: number;
};

type RequestCommand = {
  id: string;
  type: 'request';
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  putBarrier?: Barrier;
  afterReservationBarrier?: Barrier;
  beforeFinalizeBarrier?: Barrier;
  reservationLeaseMs?: number;
  failSnapshotInsert?: boolean;
};

type MutateCommand = {
  id: string;
  type: 'mutate';
  markerFile: string;
  purchaseOrderId: string;
};

type CloseCommand = { id: string; type: 'close' };
type Command = RequestCommand | MutateCommand | CloseCommand;

const databasePath = requiredEnv('READYWORK_TEST_PO_DOCUMENT_DB');
const bucketDirectory = requiredEnv('READYWORK_TEST_PO_DOCUMENT_BUCKET');
const eventLogPath = requiredEnv('READYWORK_TEST_PO_DOCUMENT_EVENTS');
const tenantId = requiredEnv('READYWORK_TEST_PO_DOCUMENT_TENANT');
const fixedNow = new Date(requiredEnv('READYWORK_TEST_PO_DOCUMENT_NOW'));
const store = openPersistence(databasePath, { tenantId });
let activePutBarrier: Barrier | undefined;

class SharedFilesystemStorage implements AttachmentObjectStorage {
  async put(input: PutAttachmentObjectInput): Promise<AttachmentObjectMetadata> {
    await recordEvent('put', input.attachmentId);
    if (activePutBarrier) await waitAtBarrier(activePutBarrier);
    const key = attachmentObjectKey(input);
    const target = objectPath(key);
    await mkdir(bucketDirectory, { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, input.body);
    await rename(temporary, target);
    return metadata(input, key);
  }

  async get(input: AttachmentObjectIntegrity): Promise<AttachmentObjectValue> {
    const key = attachmentObjectKey(input);
    const body = new Uint8Array(await readFile(objectPath(key)));
    assertIntegrity(input, body);
    return { body, metadata: metadata(input, key) };
  }

  async delete(input: { tenantId: string; attachmentId: string; version: number }): Promise<void> {
    await recordEvent('delete', input.attachmentId);
    try { await unlink(objectPath(attachmentObjectKey(input))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  async head(input: AttachmentObjectIntegrity): Promise<AttachmentObjectMetadata | null> {
    const key = attachmentObjectKey(input);
    let body: Uint8Array;
    try { body = new Uint8Array(await readFile(objectPath(key))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    assertIntegrity(input, body);
    return metadata(input, key);
  }

  async createSignedGetUrl(): Promise<never> {
    throw new Error('not used by the PO document controller fixture');
  }
}

const storage = new SharedFilesystemStorage();
const session: Session = {
  username: 'child-controller',
  tenantId,
  humanId: `human:child:${process.pid}`,
  name: 'Child controller',
  role: '采购专员',
  expiresAt: Date.now() + 3_600_000,
};

process.on('message', (message: Command) => {
  void handleCommand(message).catch((error) => {
    send({ id: message.id, error: error instanceof Error ? error.stack ?? error.message : String(error) });
  });
});

send({ type: 'ready', pid: process.pid });

async function handleCommand(command: Command): Promise<void> {
  if (command.type === 'close') {
    store.close();
    send({ id: command.id, result: { closed: true } });
    process.disconnect();
    return;
  }
  if (command.type === 'mutate') {
    await writeFile(command.markerFile, String(process.pid));
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const poRow = store.db.prepare(`SELECT json FROM procurement_documents
        WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, command.purchaseOrderId) as { json: string };
      const po = JSON.parse(poRow.json) as Record<string, unknown>;
      const mutationAt = '2026-09-02T12:30:00.000Z';
      po['number'] = 'P00501-ATOMIC-MUTATION';
      po['updatedAt'] = mutationAt;
      store.db.prepare(`UPDATE procurement_documents SET version=version+1,json=?,updated_at=?
        WHERE tenant_id=? AND kind='purchase_order' AND id=?`).run(
        JSON.stringify(po), mutationAt, tenantId, command.purchaseOrderId,
      );
      const lineRow = store.db.prepare(`SELECT id,json FROM procurement_lines
        WHERE tenant_id=? AND kind='purchase_order_line' AND document_id=? ORDER BY line_number,id LIMIT 1`)
        .get(tenantId, command.purchaseOrderId) as { id: string; json: string };
      const line = JSON.parse(lineRow.json) as Record<string, unknown>;
      line['description'] = 'MUTATED BETWEEN HEADER AND LINE READ';
      store.db.prepare(`UPDATE procurement_lines SET json=? WHERE tenant_id=? AND kind='purchase_order_line' AND id=?`)
        .run(JSON.stringify(line), tenantId, lineRow.id);
      store.db.exec('COMMIT');
      send({ id: command.id, result: { mutated: true } });
    } catch (error) {
      try { store.db.exec('ROLLBACK'); } catch { /* no active transaction */ }
      throw error;
    }
    return;
  }

  activePutBarrier = command.putBarrier;
  if (command.failSnapshotInsert) {
    store.db.exec(`CREATE TEMP TRIGGER reject_po_document_snapshot_insert
      BEFORE INSERT ON procurement_purchase_order_document_snapshots
      BEGIN SELECT RAISE(ABORT, 'isolated child metadata failure'); END`);
  }
  const request = requestFor(command);
  const response = new CapturedResponse();
  try {
    await handleProcurementPoDocumentRequest(request, response.value, command.path, command.method, {
      db: store.db,
      session,
      attachmentObjectStorage: storage,
      now: () => fixedNow,
      ...(command.afterReservationBarrier ? { afterReservationCommit: () => waitAtBarrier(command.afterReservationBarrier!) } : {}),
      ...(command.beforeFinalizeBarrier ? { beforeSnapshotFinalize: () => waitAtBarrier(command.beforeFinalizeBarrier!) } : {}),
      ...(command.reservationLeaseMs === undefined ? {} : { reservationLeaseMs: command.reservationLeaseMs }),
    });
    send({ id: command.id, result: response.result() });
  } finally {
    activePutBarrier = undefined;
    if (command.failSnapshotInsert) store.db.exec('DROP TRIGGER IF EXISTS reject_po_document_snapshot_insert');
  }
}

class CapturedResponse {
  readonly chunks: Buffer[] = [];
  status = 200;
  headers: Record<string, string> = {};

  readonly value = {
    writeHead: (status: number, headers?: OutgoingHttpHeaders) => {
      this.status = status;
      for (const [key, value] of Object.entries(headers ?? {})) {
        if (value !== undefined) this.headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      return this.value;
    },
    end: (chunk?: string | Uint8Array) => {
      if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return this.value;
    },
  } as unknown as ServerResponse;

  result(): Record<string, unknown> {
    const bytes = Buffer.concat(this.chunks);
    const contentType = this.headers['content-type'] ?? '';
    return {
      status: this.status,
      headers: this.headers,
      sizeBytes: bytes.byteLength,
      bodySha256: createHash('sha256').update(bytes).digest('hex'),
      ...(contentType.startsWith('application/json') ? { body: JSON.parse(bytes.toString('utf8')) as unknown }
        : contentType.startsWith('text/html') ? { text: bytes.toString('utf8') }
          : {}),
    };
  }
}

function requestFor(command: RequestCommand): IncomingMessage {
  const stream = Readable.from(command.body === undefined ? [] : [JSON.stringify(command.body)]);
  const headers: IncomingHttpHeaders = {};
  if (command.idempotencyKey) headers['idempotency-key'] = command.idempotencyKey;
  Object.defineProperties(stream, {
    headers: { value: headers },
    method: { value: command.method },
    url: { value: command.path },
  });
  return stream as unknown as IncomingMessage;
}

async function waitAtBarrier(barrier: Barrier): Promise<void> {
  await mkdir(barrier.directory, { recursive: true });
  const arrival = `${barrier.directory}/${barrier.tag}-${process.pid}.arrived`;
  await writeFile(arrival, String(process.pid));
  const deadline = Date.now() + barrier.timeoutMs;
  while (Date.now() <= deadline) {
    const entries = await readdir(barrier.directory);
    const arrivals = entries.filter((entry) => entry.startsWith(`${barrier.tag}-`) && entry.endsWith('.arrived')).length;
    if ((barrier.expectedArrivals !== undefined && arrivals >= barrier.expectedArrivals)
      || entries.includes(barrier.releaseFile)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (barrier.expectedArrivals !== undefined) return;
  throw new Error(`barrier ${barrier.tag} timed out`);
}

async function recordEvent(operation: 'put' | 'delete', attachmentId: string): Promise<void> {
  await appendFile(eventLogPath, `${JSON.stringify({ operation, attachmentId, pid: process.pid })}\n`);
}

function objectPath(key: string): string {
  return `${bucketDirectory}/${createHash('sha256').update(key).digest('hex')}.pdf`;
}

function metadata(input: AttachmentObjectIntegrity, key: string): AttachmentObjectMetadata {
  return { ...input, key, contentType: 'application/pdf' };
}

function assertIntegrity(input: AttachmentObjectIntegrity, body: Uint8Array): void {
  const hash = createHash('sha256').update(body).digest('hex');
  if (body.byteLength !== input.sizeBytes || hash !== input.sha256) throw new Error('shared filesystem object integrity mismatch');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function send(value: unknown): void {
  if (process.send) process.send(value);
}
