import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TwinProjectionJob } from '@readywork/core';
import {
  canonicalTwinJson,
  enqueuePurchaseOrderBackfill,
  ProcurementPoProjector,
  SqliteManufacturingContextStore,
  SqliteTwinProjectionQueue,
} from '@readywork/context';
import { recordManufacturingContextHeartbeat } from './manufacturing-context-readiness.js';

const CLAIM_LIMIT = 25;
const LEASE_DURATION_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 3_000;

interface DocumentRow {
  kind: string;
  id: string;
  version: number;
  json: string;
}

interface LineRow {
  kind: string;
  id: string;
  document_id: string;
  json: string;
}

interface ParsedLine extends LineRow {
  value: Record<string, unknown>;
}

interface ParsedDocument extends DocumentRow {
  value: Record<string, unknown>;
}

const DOCUMENT_KINDS = new Set([
  'item', 'supplier', 'requisition', 'rfq', 'quote', 'quote_comparison', 'award',
  'purchase_order', 'confirmation', 'production_progress', 'shipment', 'transport_event',
  'receipt', 'invoice', 'match', 'communication',
]);

const LINE_KINDS = new Set([
  'requisition_line', 'rfq_line', 'quote_line', 'award_line', 'purchase_order_line',
  'confirmation_line', 'production_progress_line', 'shipment_line', 'receipt_line',
  'invoice_line', 'match_line',
]);

function safeUnsupported(job: Pick<TwinProjectionJob, 'sourceTable' | 'eventType'>): Error {
  return new Error(`Unsupported Twin projection source/event: ${job.sourceTable}/${job.eventType}`);
}

function isLeaseConflict(error: unknown): boolean {
  return error instanceof Error && error.message === 'Twin projection 租约冲突';
}

function parseRecord(json: string, source: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`Twin projection source row is invalid: ${source}`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sourceId(sourceKey: string, kind: string): string {
  const prefix = `${kind}:`;
  if (!sourceKey.startsWith(prefix) || sourceKey.length === prefix.length) {
    throw new Error('Twin projection source key does not match its event type');
  }
  return sourceKey.slice(prefix.length);
}

function loadGraph(db: DatabaseSync, tenantId: string): {
  documents: ParsedDocument[];
  lines: ParsedLine[];
  purchaseOrders: ParsedDocument[];
  purchaseOrderLines: ParsedLine[];
} {
  const documents = (db.prepare(`SELECT kind,id,version,json FROM procurement_documents
    WHERE tenant_id=? ORDER BY kind,id`).all(tenantId) as unknown as DocumentRow[])
    .map((row) => ({ ...row, value: parseRecord(row.json, 'procurement_documents') }));
  const lines = (db.prepare(`SELECT kind,id,document_id,json FROM procurement_lines
    WHERE tenant_id=? ORDER BY kind,id`).all(tenantId) as unknown as LineRow[])
    .map((row) => ({ ...row, value: parseRecord(row.json, 'procurement_lines') }));
  return {
    documents,
    lines,
    purchaseOrders: documents.filter((row) => row.kind === 'purchase_order'),
    purchaseOrderLines: lines.filter((row) => row.kind === 'purchase_order_line'),
  };
}

function poLineBelongsTo(line: ParsedLine, poId: string): boolean {
  return stringValue(line.value['poId']) === poId || line.document_id === poId;
}

function poIdsForLineReference(
  graph: ReturnType<typeof loadGraph>,
  field: string,
  lineId: string,
): string[] {
  return graph.purchaseOrderLines
    .filter((line) => stringValue(line.value[field]) === lineId)
    .map((line) => stringValue(line.value['poId']) ?? line.document_id);
}

function poIdsForPoLineId(graph: ReturnType<typeof loadGraph>, poLineId: string): string[] {
  return graph.purchaseOrderLines
    .filter((line) => line.id === poLineId)
    .map((line) => stringValue(line.value['poId']) ?? line.document_id);
}

function poIdsForDocument(
  graph: ReturnType<typeof loadGraph>,
  document: ParsedDocument,
): string[] {
  const { kind, id, value } = document;
  if (kind === 'purchase_order') return [id];
  if (kind === 'supplier') {
    return graph.purchaseOrders.filter((po) => stringValue(po.value['supplierId']) === id).map((po) => po.id);
  }
  if (kind === 'item') {
    return graph.purchaseOrderLines.filter((line) => stringValue(line.value['itemId']) === id)
      .map((line) => stringValue(line.value['poId']) ?? line.document_id);
  }
  if (kind === 'award') {
    const awardLineIds = new Set(graph.lines.filter((line) => line.kind === 'award_line' && line.document_id === id).map((line) => line.id));
    return graph.purchaseOrders.filter((po) => stringValue(po.value['awardId']) === id)
      .filter((po) => graph.purchaseOrderLines.some((line) => poLineBelongsTo(line, po.id)
        && awardLineIds.has(stringValue(line.value['awardLineId']) ?? '')))
      .map((po) => po.id);
  }
  if (kind === 'rfq') {
    const lineIds = new Set(graph.lines.filter((line) => line.kind === 'rfq_line' && line.document_id === id).map((line) => line.id));
    return graph.purchaseOrderLines.filter((line) => lineIds.has(stringValue(line.value['rfqLineId']) ?? ''))
      .map((line) => stringValue(line.value['poId']) ?? line.document_id);
  }
  if (kind === 'quote') {
    const lineIds = new Set(graph.lines.filter((line) => line.kind === 'quote_line' && line.document_id === id).map((line) => line.id));
    return graph.purchaseOrderLines.filter((line) => lineIds.has(stringValue(line.value['quoteLineId']) ?? ''))
      .map((line) => stringValue(line.value['poId']) ?? line.document_id);
  }
  if (kind === 'quote_comparison') {
    const rfqId = stringValue(value['rfqId']);
    const rfq = rfqId ? graph.documents.find((row) => row.kind === 'rfq' && row.id === rfqId) : undefined;
    return rfq ? poIdsForDocument(graph, rfq) : [];
  }
  if (kind === 'requisition') {
    const requisitionLineIds = new Set(graph.lines.filter((line) => line.kind === 'requisition_line' && line.document_id === id).map((line) => line.id));
    return graph.purchaseOrderLines.filter((line) => requisitionLineIds.has(stringValue(line.value['requisitionLineId']) ?? ''))
      .map((line) => stringValue(line.value['poId']) ?? line.document_id);
  }
  if (['confirmation', 'production_progress', 'shipment', 'transport_event', 'receipt', 'match'].includes(kind)) {
    const poId = stringValue(value['poId']);
    return poId ? [poId] : [];
  }
  if (kind === 'invoice') {
    const poLineIds = graph.lines.filter((line) => line.kind === 'invoice_line' && line.document_id === id)
      .map((line) => stringValue(line.value['poLineId'])).filter((value): value is string => value !== undefined);
    return poLineIds.flatMap((poLineId) => poIdsForPoLineId(graph, poLineId));
  }
  if (kind === 'communication') {
    const businessObjectId = stringValue(value['businessObjectId']);
    if (!businessObjectId) throw new Error('Twin projection communication target is unavailable');
    if (value['businessObjectType'] === 'purchase_order') return [businessObjectId];
    if (value['businessObjectType'] === 'rfq') {
      const rfq = graph.documents.find((row) => row.kind === 'rfq' && row.id === businessObjectId);
      if (!rfq) throw new Error('Twin projection RFQ communication target is unavailable');
      return poIdsForDocument(graph, rfq);
    }
    throw new Error('Twin projection communication target type is unsupported');
  }
  return [];
}

function poIdsForLine(graph: ReturnType<typeof loadGraph>, line: ParsedLine): string[] {
  const kind = line.kind;
  if (kind === 'purchase_order_line') return [stringValue(line.value['poId']) ?? line.document_id];
  if (kind === 'requisition_line') return poIdsForLineReference(graph, 'requisitionLineId', line.id);
  if (kind === 'rfq_line') return poIdsForLineReference(graph, 'rfqLineId', line.id);
  if (kind === 'quote_line') return poIdsForLineReference(graph, 'quoteLineId', line.id);
  if (kind === 'award_line') return poIdsForLineReference(graph, 'awardLineId', line.id);
  const poLineId = stringValue(line.value['poLineId']);
  if (poLineId) return poIdsForPoLineId(graph, poLineId);
  const parentKind: Record<string, string> = {
    confirmation_line: 'confirmation', production_progress_line: 'production_progress',
    shipment_line: 'shipment', receipt_line: 'receipt', invoice_line: 'invoice', match_line: 'match',
  };
  const parent = parentKind[kind]
    ? graph.documents.find((row) => row.kind === parentKind[kind] && row.id === line.document_id)
    : undefined;
  return parent ? poIdsForDocument(graph, parent) : [];
}

function existingPurchaseOrderIds(graph: ReturnType<typeof loadGraph>, candidates: readonly string[]): string[] {
  const known = new Set(graph.purchaseOrders.map((row) => row.id));
  return [...new Set(candidates)].filter((id) => known.has(id)).sort();
}

/** Resolves one durable source mutation to the exact tenant-bound PO roots it can affect. */
export function resolveAffectedPurchaseOrderIds(
  db: DatabaseSync,
  job: Pick<TwinProjectionJob, 'tenantId' | 'sourceTable' | 'sourceKey' | 'sourceRevision' | 'eventType'>,
): string[] {
  const graph = loadGraph(db, job.tenantId);
  if (job.sourceTable === 'procurement_documents' && job.eventType === 'purchase_order.backfill') {
    const id = job.sourceKey.startsWith('purchase_order:') ? sourceId(job.sourceKey, 'purchase_order') : job.sourceKey;
    return existingPurchaseOrderIds(graph, [id]);
  }
  if (job.sourceTable === 'procurement_documents') {
    const kind = job.eventType.endsWith('.changed') ? job.eventType.slice(0, -'.changed'.length) : '';
    if (!DOCUMENT_KINDS.has(kind)) throw safeUnsupported(job);
    const id = sourceId(job.sourceKey, kind);
    const document = graph.documents.find((row) => row.kind === kind && row.id === id);
    if (!document) throw new Error('Twin projection source row is unavailable');
    return existingPurchaseOrderIds(graph, poIdsForDocument(graph, document));
  }
  if (job.sourceTable === 'procurement_lines') {
    const kind = job.eventType.endsWith('.changed') ? job.eventType.slice(0, -'.changed'.length) : '';
    if (!LINE_KINDS.has(kind)) throw safeUnsupported(job);
    const id = sourceId(job.sourceKey, kind);
    const line = graph.lines.find((row) => row.kind === kind && row.id === id);
    if (!line) throw new Error('Twin projection source row is unavailable');
    return existingPurchaseOrderIds(graph, poIdsForLine(graph, line));
  }
  if (job.sourceTable === 'procurement_po_stage_events'
    && job.eventType === 'procurement_po_stage_event.created') {
    const row = db.prepare(`SELECT po_id FROM procurement_po_stage_events
      WHERE tenant_id=? AND id=?`).get(job.tenantId, job.sourceKey) as { po_id: string } | undefined;
    if (!row) throw new Error('Twin projection source row is unavailable');
    return existingPurchaseOrderIds(graph, [row.po_id]);
  }
  if (job.sourceTable === 'procurement_po_line_quantity_events'
    && job.eventType === 'procurement_po_line_quantity_event.created') {
    const rows = db.prepare(`SELECT source_system,source_event_id,po_line_id FROM procurement_po_line_quantity_events
      WHERE tenant_id=? ORDER BY source_system,source_event_id`).all(job.tenantId) as unknown as Array<{ source_system: string; source_event_id: string; po_line_id: string }>;
    const row = rows.find((candidate) => `${candidate.source_system}:${candidate.source_event_id}` === job.sourceKey);
    if (!row) throw new Error('Twin projection source row is unavailable');
    return existingPurchaseOrderIds(graph, poIdsForPoLineId(graph, row.po_line_id));
  }
  if (job.sourceTable === 'procurement_po_line_quantity_projections'
    && job.eventType === 'procurement_po_line_quantity_projection.changed') {
    const row = db.prepare(`SELECT po_line_id FROM procurement_po_line_quantity_projections
      WHERE tenant_id=? AND po_line_id=?`).get(job.tenantId, job.sourceKey) as { po_line_id: string } | undefined;
    if (!row) throw new Error('Twin projection source row is unavailable');
    return existingPurchaseOrderIds(graph, poIdsForPoLineId(graph, row.po_line_id));
  }
  if (job.sourceTable === 'procurement_outbox' && job.eventType === 'procurement_outbox.changed') {
    const row = db.prepare(`SELECT action,aggregate_id,json FROM procurement_outbox
      WHERE tenant_id=? AND id=?`).get(job.tenantId, job.sourceKey) as { action: string; aggregate_id: string; json: string } | undefined;
    if (!row) throw new Error('Twin projection source row is unavailable');
    parseRecord(row.json, 'procurement_outbox');
    if (row.action.startsWith('purchase_order.')) return existingPurchaseOrderIds(graph, [row.aggregate_id]);
    const aggregateKind = row.action.startsWith('rfq.') ? 'rfq' : row.action.startsWith('invoice.') ? 'invoice' : undefined;
    const aggregate = aggregateKind
      ? graph.documents.find((document) => document.kind === aggregateKind && document.id === row.aggregate_id)
      : undefined;
    if (!aggregate) throw safeUnsupported(job);
    return existingPurchaseOrderIds(graph, poIdsForDocument(graph, aggregate));
  }
  if (job.sourceTable === 'procurement_sla_evaluations'
    && (job.eventType === 'procurement_sla_evaluation.changed'
      || job.eventType === 'procurement_sla_evaluation.deleted')) {
    if (job.eventType.endsWith('.changed')) {
      const row = db.prepare(`SELECT 1 FROM procurement_sla_evaluations
        WHERE tenant_id=? AND po_id=?`).get(job.tenantId, job.sourceKey);
      if (!row) throw new Error('Twin projection source row is unavailable');
    }
    return existingPurchaseOrderIds(graph, [job.sourceKey]);
  }
  if (job.sourceTable === 'procurement_execution_approvals'
    && job.eventType === 'twin_fact_correction.approved') {
    const row = db.prepare(`SELECT kind,json FROM procurement_execution_approvals
      WHERE tenant_id=? AND id=?`).get(job.tenantId, job.sourceKey) as { kind: string; json: string } | undefined;
    if (!row || row.kind !== 'twin_fact_correction') throw new Error('Twin projection source row is unavailable');
    const approval = parseRecord(row.json, 'procurement_execution_approvals');
    const objectId = stringValue(approval['objectId']);
    const entityId = stringValue(approval['entityId']);
    const entity = entityId ? db.prepare(`SELECT attributes_json FROM twin_entities
      WHERE tenant_id=? AND id=?`).get(job.tenantId, entityId) as { attributes_json: string } | undefined : undefined;
    const attributes = entity ? parseRecord(entity.attributes_json, 'twin_entities') : undefined;
    return existingPurchaseOrderIds(graph, [stringValue(attributes?.['businessObjectId']) ?? objectId ?? '']);
  }
  throw safeUnsupported(job);
}

function projectorJob(db: DatabaseSync, source: TwinProjectionJob, poId: string): TwinProjectionJob {
  const row = db.prepare(`SELECT version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(source.tenantId, poId) as { version: number; json: string } | undefined;
  if (!row) throw new Error('Twin projection affected PO is unavailable');
  return {
    ...source,
    sourceTable: 'procurement_documents',
    sourceKey: poId,
    sourceRevision: String(row.version),
    eventType: 'purchase_order.backfill',
    payloadHash: createHash('sha256').update(canonicalTwinJson(JSON.parse(row.json) as unknown)).digest('hex'),
  };
}

function combinedWatermark(source: TwinProjectionJob, projected: readonly { poId: string; watermark: string }[]): string {
  if (projected.length === 1) return projected[0]!.watermark;
  const value = projected.length === 0
    ? [source.tenantId, source.sourceTable, source.sourceKey, source.sourceRevision, source.eventType]
    : projected.flatMap((item) => [item.poId, item.watermark]);
  return `twin:projection-watermark:${createHash('sha256').update(canonicalTwinJson(value)).digest('hex')}`;
}

export interface ManufacturingContextWorkerOptions {
  queue: SqliteTwinProjectionQueue;
  workerId: string;
  now: () => string;
  project: (job: TwinProjectionJob) => { projectedWatermark: string };
  /** Required by the runtime dispatcher; omitted only by the narrow queue-recovery contract test. */
  db?: DatabaseSync;
  pollIntervalMs?: number;
}

export interface ManufacturingContextWorkerStatus {
  state: 'ready' | 'unavailable';
  lastHeartbeatAt: string | null;
}

export class ManufacturingContextWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private currentStatus: ManufacturingContextWorkerStatus = { state: 'unavailable', lastHeartbeatAt: null };

  constructor(private readonly options: ManufacturingContextWorkerOptions) {
    if (!options.workerId.trim()) throw new Error('Manufacturing Context workerId 不能为空');
  }

  status = (): ManufacturingContextWorkerStatus => ({ ...this.currentStatus });

  async runOnce(): Promise<number> {
    const claimedAt = this.options.now();
    const jobs = this.options.queue.claim({
      workerId: this.options.workerId,
      claimedAt,
      leaseDurationMs: LEASE_DURATION_MS,
      limit: CLAIM_LIMIT,
    });
    for (const job of jobs) {
      let projected: Array<{ poId: string; watermark: string }>;
      try {
        if (!this.options.db
          && (job.sourceTable !== 'procurement_documents'
            || !['purchase_order.changed', 'purchase_order.backfill'].includes(job.eventType))) {
          throw safeUnsupported(job);
        }
        const affectedPoIds = this.options.db
          ? resolveAffectedPurchaseOrderIds(this.options.db, job)
          : undefined;
        projected = affectedPoIds === undefined
          ? [{ poId: job.sourceKey, watermark: this.options.project(job).projectedWatermark }]
          : affectedPoIds.map((poId) => ({
              poId,
              watermark: this.options.project(projectorJob(this.options.db!, job, poId)).projectedWatermark,
            }));
      } catch (error) {
        try {
          this.options.queue.fail({
            id: job.id,
            leaseToken: job.leaseToken!,
            failedAt: this.options.now(),
            error,
          });
        } catch {
          // A stale lease is already reclaimable; settlement must not abort the batch.
        }
        continue;
      }
      try {
        this.options.queue.succeed({
          id: job.id,
          leaseToken: job.leaseToken!,
          completedAt: this.options.now(),
          projectedWatermark: combinedWatermark(job, projected),
        });
      } catch (error) {
        if (!isLeaseConflict(error)) {
          try {
            this.options.queue.fail({
              id: job.id,
              leaseToken: job.leaseToken!,
              failedAt: this.options.now(),
              error,
            });
          } catch {
            // Settlement errors remain isolated to this job.
          }
        }
        // A stale lease is already reclaimable; never convert projected work to false success.
      }
    }
    this.currentStatus = { state: 'ready', lastHeartbeatAt: this.options.now() };
    return jobs.length;
  }

  start(): void {
    if (this.timer) return;
    const pollIntervalMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('Manufacturing Context poll interval 必须大于 0');
    const poll = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.runOnce();
      } catch {
        this.currentStatus = { state: 'unavailable', lastHeartbeatAt: this.currentStatus.lastHeartbeatAt };
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void poll(), pollIntervalMs);
    this.timer.unref();
    void poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export interface ManufacturingContextRuntimeOptions {
  surface: 'compat' | 'business' | 'control';
  db: DatabaseSync;
  workerId: string;
  now: () => string;
  pollIntervalMs?: number;
}

/** Discovers tenant queues while keeping every Store, Queue and projector tenant-bound. */
export class ManufacturingContextRuntime {
  private readonly workers = new Map<string, ManufacturingContextWorker>();
  private readonly initializedTenants = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: Omit<ManufacturingContextRuntimeOptions, 'surface'>) {
    if (!options.workerId.trim()) throw new Error('Manufacturing Context runtime workerId 不能为空');
  }

  status = (tenantId: string): ManufacturingContextWorkerStatus => (
    this.workers.get(tenantId)?.status() ?? { state: 'unavailable', lastHeartbeatAt: null }
  );

  async runOnce(): Promise<Record<string, number>> {
    const tenants = this.options.db.prepare(`SELECT tenant_id FROM procurement_documents
      WHERE kind='purchase_order'
      UNION SELECT tenant_id FROM twin_projection_jobs
      ORDER BY tenant_id`).all() as Array<{ tenant_id: string }>;
    const result: Record<string, number> = {};
    for (const row of tenants) {
      const tenantId = row.tenant_id;
      if (!this.initializedTenants.has(tenantId)) {
        enqueuePurchaseOrderBackfill(this.options.db, tenantId, this.options.now());
        this.initializedTenants.add(tenantId);
      }
      let worker = this.workers.get(tenantId);
      if (!worker) {
        const store = new SqliteManufacturingContextStore(this.options.db, tenantId);
        const queue = new SqliteTwinProjectionQueue(this.options.db, tenantId);
        const projector = new ProcurementPoProjector(this.options.db, tenantId, store);
        worker = new ManufacturingContextWorker({
          db: this.options.db,
          queue,
          workerId: `${this.options.workerId}:${tenantId}`,
          now: this.options.now,
          project: (job) => ({ projectedWatermark: projector.project(job).sourceWatermark }),
        });
        this.workers.set(tenantId, worker);
      }
      result[tenantId] = await worker.runOnce();
      const pollIntervalMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      recordManufacturingContextHeartbeat(this.options.db, {
        tenantId,
        workerId: `${this.options.workerId}:${tenantId}`,
        workerReady: true,
        lastHeartbeatAt: this.options.now(),
        pollIntervalMs,
      });
    }
    return result;
  }

  start(): void {
    if (this.timer) return;
    const pollIntervalMs = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('Manufacturing Context poll interval 必须大于 0');
    const poll = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.runOnce();
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void poll().catch(() => undefined), pollIntervalMs);
    this.timer.unref();
    void poll().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function createManufacturingContextRuntime(
  options: ManufacturingContextRuntimeOptions,
): ManufacturingContextRuntime | undefined {
  if (options.surface === 'control') return undefined;
  const { surface: _surface, ...runtimeOptions } = options;
  return new ManufacturingContextRuntime(runtimeOptions);
}
