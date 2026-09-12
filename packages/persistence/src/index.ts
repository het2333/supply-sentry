import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import {
  MANUFACTURING_CONTEXT_RUNTIME_SCHEMA,
  MANUFACTURING_CONTEXT_SCHEMA,
  ensureManufacturingContextSchema,
} from './manufacturing-context-schema.js';
import {
  enqueueTwinProjectionInCurrentTransaction,
  persistProcurementLineProjectionInCurrentTransaction,
  twinProjectionPayloadHash,
} from './twin-projection-enqueue.js';
export * from './twin-projection-enqueue.js';
import type {
  AIEmployee,
  ApprovalRequest,
  BudgetState,
  BusinessObject,
  DomainEvent,
  EntityId,
  Exception,
  Activity,
  RuntimeHub,
  Task,
  TaskStatus,
  EmployeeDefinition,
  EmployeeVersion,
  EmployeeDeployment,
  ProcurementDocument,
  ProcurementLine,
  Communication,
  ProcurementRequisition,
  RequisitionLine,
  RequestForQuotation,
  RequestForQuotationLine,
  SupplierQuote,
  SupplierQuoteLine,
  Supplier,
  Award,
  AwardLine,
  PurchaseOrder,
  PurchaseOrderConfirmation,
  PurchaseOrderConfirmationLine,
  PurchaseOrderLine,
  ProductionProgress,
  ProductionProgressLine,
  ProductionProgressStatus,
  ProcurementFulfilmentEvidenceSource,
  QuoteComparisonSnapshot,
  Shipment,
  ShipmentLine,
  TransportEvent,
  TransportEventCode,
  Receipt,
  ReceiptLine,
  SupplierInvoice,
  SupplierInvoiceLine,
  ThreeWayMatch,
  ThreeWayMatchLine,
  SupplierReplyField,
  LineMatchPolicy,
  ProcurementExecutionApproval,
  ProcurementOutboxAttachmentSnapshot,
  ProcurementOutboxMessage,
  PurchaseOrderLineQuantityEvent,
  PurchaseOrderLineQuantityProjection,
  QuantityProjectionResult,
  LineMatchDisposition,
  LineMatchResult,
  ProcurementDocumentJob,
  SupplierOperatingProfile,
} from '@readywork/core';
import {
  applyPurchaseOrderLineQuantityEvent as projectPurchaseOrderLineQuantityEvent,
  createPurchaseOrderLineQuantityProjection,
  createRuntimeHub,
  evaluateSupplierConfirmationVariance,
  matchPurchaseOrderLine,
  nowIso,
  validateSupplierOperatingProfile,
} from '@readywork/core';
import type {
  ApprovalRepository,
  BudgetRepository,
  BusinessObjectRepository,
  EventRepository,
  ExceptionRepository,
  ActivityRepository,
  TaskRepository,
} from '@readywork/core';

/**
 * node:sqlite 持久化 —— 零依赖。
 *
 * 用法：
 *   const store = openPersistence('./data.db');
 *   const hub = createPersistentRuntimeHub(store);   // 全部仓储落盘
 *   // 组织/员工是代码装配的：先注册（createSupplyChainRuntime 传 hub），再 restoreOrg + persistOrg + attach
 *
 * 崩溃恢复语义：
 *   - waiting_* 任务跨重启保留，引擎 rearmWaits() 后事件可继续恢复
 *   - 重启时仍处于 created/queued/running 的任务标记为 failed（进程中断）
 *   - 事件日志、预算、员工统计全部保留
 */

// ---------------------------------------------------------------- Store

export interface PersistenceStore {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  tasks: TaskRepository;
  objects: BusinessObjectRepository;
  approvals: ApprovalRepository;
  events: EventRepository;
  budget: BudgetRepository;
  exceptions: ExceptionRepository;
  activities: ActivityRepository;
  org: OrgRepository;
  workforce: WorkforceRepository;
  procurement: ProcurementRepository;
  close(): void;
}

export type ProcurementRouteExportState = 'ready' | 'expired' | 'deleted';

export interface ProcurementRouteExportRecord {
  tenantId: string;
  id: string;
  route: 'local' | 'import';
  normalizedFiltersJson: string;
  sourceWatermark: string;
  rowCount: number;
  contentSha256: string;
  sizeBytes: number;
  objectKey: string;
  state: ProcurementRouteExportState;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  idempotencyKey: string;
}

type ProcurementRouteExportRow = {
  tenant_id: string; id: string; route: 'local' | 'import'; normalized_filters_json: string; source_watermark: string;
  row_count: number; content_sha256: string; size_bytes: number; object_key: string; state: ProcurementRouteExportState;
  created_by: string; created_at: string; expires_at: string; idempotency_key: string;
};

function presentProcurementRouteExport(row: ProcurementRouteExportRow): ProcurementRouteExportRecord {
  return {
    tenantId: row.tenant_id, id: row.id, route: row.route, normalizedFiltersJson: row.normalized_filters_json,
    sourceWatermark: row.source_watermark, rowCount: row.row_count, contentSha256: row.content_sha256,
    sizeBytes: row.size_bytes, objectKey: row.object_key, state: row.state, createdBy: row.created_by,
    createdAt: row.created_at, expiresAt: row.expires_at, idempotencyKey: row.idempotency_key,
  };
}

export function createProcurementRouteExport(db: DatabaseSync, input: ProcurementRouteExportRecord): ProcurementRouteExportRecord {
  db.prepare(`INSERT INTO procurement_route_exports
    (tenant_id,id,route,normalized_filters_json,source_watermark,row_count,content_sha256,size_bytes,object_key,state,created_by,created_at,expires_at,idempotency_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.tenantId, input.id, input.route, input.normalizedFiltersJson, input.sourceWatermark, input.rowCount,
    input.contentSha256, input.sizeBytes, input.objectKey, input.state, input.createdBy, input.createdAt, input.expiresAt,
    input.idempotencyKey,
  );
  return input;
}

export function getProcurementRouteExport(db: DatabaseSync, tenantId: string, id: string): ProcurementRouteExportRecord | null {
  const row = db.prepare('SELECT * FROM procurement_route_exports WHERE tenant_id=? AND id=?').get(tenantId, id) as ProcurementRouteExportRow | undefined;
  return row ? presentProcurementRouteExport(row) : null;
}

export function findProcurementRouteExportByIdempotency(db: DatabaseSync, tenantId: string, idempotencyKey: string): ProcurementRouteExportRecord | null {
  const row = db.prepare('SELECT * FROM procurement_route_exports WHERE tenant_id=? AND idempotency_key=?').get(tenantId, idempotencyKey) as ProcurementRouteExportRow | undefined;
  return row ? presentProcurementRouteExport(row) : null;
}

export type SupplierOperatingProfileEventSource = 'manual' | 'odoo' | 'import' | 'system';

export interface ProcurementSupplierOperatingProfileEvent {
  tenantId: string;
  id: string;
  supplierId: string;
  version: number;
  before: Partial<Omit<SupplierOperatingProfile, 'supplierId' | 'version'>> | null;
  after: Partial<Omit<SupplierOperatingProfile, 'supplierId' | 'version'>>;
  actorId: string;
  reason: string;
  source: SupplierOperatingProfileEventSource;
  createdAt: string;
}

export class ProcurementSupplierOperatingProfileVersionConflictError extends Error {
  constructor(readonly expectedVersion: number, readonly actualVersion: number) {
    super(`supplier operating profile version conflict: expected=${expectedVersion}, actual=${actualVersion}`);
    this.name = 'ProcurementSupplierOperatingProfileVersionConflictError';
  }
}

type SupplierOperatingProfileRow = {
  tenant_id: string; supplier_id: string; version: number; country_code: string; route: SupplierOperatingProfile['route'];
  supplier_type: SupplierOperatingProfile['supplierType']; industry: string; address_json: string; primary_material_code: string;
  primary_material_name: string; default_lead_time_days: number | null; product_criticality: SupplierOperatingProfile['productCriticality'];
  payment_terms: string; contract_starts_on: string | null; contract_ends_on: string | null; status: SupplierOperatingProfile['status'];
};

function supplierOperatingProfileFromRow(row: SupplierOperatingProfileRow): SupplierOperatingProfile {
  return validateSupplierOperatingProfile({
    supplierId: row.supplier_id,
    countryCode: row.country_code || null,
    route: row.route,
    supplierType: row.supplier_type,
    industry: row.industry || null,
    address: JSON.parse(row.address_json) as unknown,
    primaryMaterialCode: row.primary_material_code || null,
    primaryMaterialName: row.primary_material_name || null,
    defaultLeadTimeDays: row.default_lead_time_days,
    productCriticality: row.product_criticality,
    paymentTerms: row.payment_terms || null,
    contractStartsOn: row.contract_starts_on,
    contractEndsOn: row.contract_ends_on,
    status: row.status,
    version: row.version,
  });
}

function supplierOperatingProfileValues(profile: SupplierOperatingProfile): readonly (string | number | null)[] {
  return [
    profile.version, profile.countryCode ?? '', profile.route, profile.supplierType, profile.industry ?? '', JSON.stringify(profile.address),
    profile.primaryMaterialCode ?? '', profile.primaryMaterialName ?? '', profile.defaultLeadTimeDays, profile.productCriticality,
    profile.paymentTerms ?? '', profile.contractStartsOn, profile.contractEndsOn, profile.status,
  ];
}

export function createProcurementSupplierOperatingProfile(
  db: DatabaseSync,
  tenantId: string,
  input: { profile: SupplierOperatingProfile; actorId: string; reason: string; source: SupplierOperatingProfileEventSource; at: string },
): SupplierOperatingProfile {
  const profile = validateSupplierOperatingProfile(input.profile);
  if (profile.version !== 1) throw new Error('new supplier operating profile version must be 1');
  const actorId = requireRepositoryText(input.actorId, 'actorId');
  const reason = requireRepositoryText(input.reason, 'reason');
  const at = requireEvidenceTimestamp(input.at, 'at');
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO procurement_supplier_operating_profiles
      (tenant_id,supplier_id,version,country_code,route,supplier_type,industry,address_json,primary_material_code,primary_material_name,
       default_lead_time_days,product_criticality,payment_terms,contract_starts_on,contract_ends_on,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenantId, profile.supplierId, ...supplierOperatingProfileValues(profile), at, at,
    );
    appendProcurementSupplierOperatingProfileEvent(db, tenantId, {
      supplierId: profile.supplierId, version: profile.version, before: null, after: profileEventFields(profile), actorId, reason, source: input.source, at,
    });
    if (ownsTransaction) db.exec('COMMIT');
    return profile;
  } catch (error) {
    if (ownsTransaction) rollback(db);
    throw error;
  }
}

export function getProcurementSupplierOperatingProfile(db: DatabaseSync, tenantId: string, supplierId: string): SupplierOperatingProfile | null {
  const row = db.prepare(`SELECT tenant_id,supplier_id,version,country_code,route,supplier_type,industry,address_json,primary_material_code,
    primary_material_name,default_lead_time_days,product_criticality,payment_terms,contract_starts_on,contract_ends_on,status
    FROM procurement_supplier_operating_profiles WHERE tenant_id=? AND supplier_id=?`).get(tenantId, supplierId) as SupplierOperatingProfileRow | undefined;
  return row ? supplierOperatingProfileFromRow(row) : null;
}

export function updateProcurementSupplierOperatingProfile(
  db: DatabaseSync,
  tenantId: string,
  input: {
    supplierId: string; expectedVersion: number; patch: Partial<Omit<SupplierOperatingProfile, 'supplierId' | 'version'>>;
    actorId: string; reason: string; source: SupplierOperatingProfileEventSource; at: string;
  },
): SupplierOperatingProfile {
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('expectedVersion must be a positive safe integer');
  const current = getProcurementSupplierOperatingProfile(db, tenantId, input.supplierId);
  if (!current) throw new Error('supplier operating profile not found');
  if (current.version !== input.expectedVersion) throw new ProcurementSupplierOperatingProfileVersionConflictError(input.expectedVersion, current.version);
  const next = validateSupplierOperatingProfile({ ...current, ...input.patch, supplierId: current.supplierId, version: current.version + 1 });
  const diff = supplierOperatingProfileDiff(current, next);
  if (!Object.keys(diff.after).length) throw new Error('supplier operating profile patch has no changed fields');
  const actorId = requireRepositoryText(input.actorId, 'actorId');
  const reason = requireRepositoryText(input.reason, 'reason');
  const at = requireEvidenceTimestamp(input.at, 'at');
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const changed = db.prepare(`UPDATE procurement_supplier_operating_profiles SET version=?,country_code=?,route=?,supplier_type=?,industry=?,address_json=?,
      primary_material_code=?,primary_material_name=?,default_lead_time_days=?,product_criticality=?,payment_terms=?,contract_starts_on=?,contract_ends_on=?,
      status=?,updated_at=? WHERE tenant_id=? AND supplier_id=? AND version=?`).run(
      ...supplierOperatingProfileValues(next), at, tenantId, current.supplierId, current.version,
    );
    if (Number(changed.changes) !== 1) throw new ProcurementSupplierOperatingProfileVersionConflictError(input.expectedVersion, current.version + 1);
    appendProcurementSupplierOperatingProfileEvent(db, tenantId, {
      supplierId: current.supplierId, version: next.version, before: diff.before, after: diff.after, actorId, reason, source: input.source, at,
    });
    if (ownsTransaction) db.exec('COMMIT');
    return next;
  } catch (error) {
    if (ownsTransaction) rollback(db);
    throw error;
  }
}

function appendProcurementSupplierOperatingProfileEvent(
  db: DatabaseSync,
  tenantId: string,
  input: Omit<ProcurementSupplierOperatingProfileEvent, 'tenantId' | 'id' | 'createdAt'> & { at: string },
): ProcurementSupplierOperatingProfileEvent {
  const event: ProcurementSupplierOperatingProfileEvent = {
    tenantId, id: `supplier-profile-event:${randomUUID()}`, supplierId: input.supplierId, version: input.version,
    before: input.before, after: input.after, actorId: input.actorId, reason: input.reason, source: input.source, createdAt: input.at,
  };
  db.prepare(`INSERT INTO procurement_supplier_operating_profile_events
    (tenant_id,id,supplier_id,version,before_json,after_json,actor_id,reason,source,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    event.tenantId, event.id, event.supplierId, event.version, event.before === null ? null : JSON.stringify(event.before),
    JSON.stringify(event.after), event.actorId, event.reason, event.source, event.createdAt,
  );
  return event;
}

export function listProcurementSupplierOperatingProfileEvents(
  db: DatabaseSync, tenantId: string, supplierId: string,
): ProcurementSupplierOperatingProfileEvent[] {
  const rows = db.prepare(`SELECT tenant_id,id,supplier_id,version,before_json,after_json,actor_id,reason,source,created_at
    FROM procurement_supplier_operating_profile_events WHERE tenant_id=? AND supplier_id=? ORDER BY version,created_at,id`)
    .all(tenantId, supplierId) as Array<{
      tenant_id: string; id: string; supplier_id: string; version: number; before_json: string | null; after_json: string;
      actor_id: string; reason: string; source: SupplierOperatingProfileEventSource; created_at: string;
    }>;
  return rows.map((row) => ({
    tenantId: row.tenant_id, id: row.id, supplierId: row.supplier_id, version: row.version,
    before: row.before_json === null ? null : JSON.parse(row.before_json) as Partial<Omit<SupplierOperatingProfile, 'supplierId' | 'version'>>,
    after: JSON.parse(row.after_json) as Partial<Omit<SupplierOperatingProfile, 'supplierId' | 'version'>>, actorId: row.actor_id, reason: row.reason,
    source: row.source, createdAt: row.created_at,
  }));
}

function profileEventFields(profile: SupplierOperatingProfile): Partial<Omit<SupplierOperatingProfile, 'supplierId' | 'version'>> {
  const { supplierId: _supplierId, version: _version, ...fields } = profile;
  return fields;
}

function supplierOperatingProfileDiff(
  before: SupplierOperatingProfile,
  after: SupplierOperatingProfile,
): {
  before: Partial<Omit<SupplierOperatingProfile, 'supplierId' | 'version'>>;
  after: Partial<Omit<SupplierOperatingProfile, 'supplierId' | 'version'>>;
} {
  const previous = profileEventFields(before);
  const next = profileEventFields(after);
  const beforeDiff: Record<string, unknown> = {};
  const afterDiff: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof typeof next>) {
    if (isDeepStrictEqual(previous[key], next[key])) continue;
    beforeDiff[key] = previous[key];
    afterDiff[key] = next[key];
  }
  return {
    before: beforeDiff as Partial<Omit<SupplierOperatingProfile, 'supplierId' | 'version'>>,
    after: afterDiff as Partial<Omit<SupplierOperatingProfile, 'supplierId' | 'version'>>,
  };
}

export type ProcurementPurchaseOrderAmendmentAction = 'edit' | 'cancel';
export type ProcurementPurchaseOrderAmendmentState = 'requested' | 'queued' | 'pending' | 'dispatched' | 'unknown' | 'applied' | 'failed' | 'rejected' | 'cancelled';

export interface ProcurementPurchaseOrderAmendment {
  tenantId: string; id: string; poId: string; action: ProcurementPurchaseOrderAmendmentAction; sourcePoVersion: number;
  normalizedPatch: Readonly<Record<string, unknown>>; state: ProcurementPurchaseOrderAmendmentState; outboxId: string | null;
  receiptReference: string | null; idempotencyKey: string; actorId: string; reason: string; createdAt: string; updatedAt: string; appliedAt: string | null;
}

export interface ProcurementPurchaseOrderAmendmentAuditEvent {
  tenantId: string; id: string; amendmentId: string; sequence: number; fromState: ProcurementPurchaseOrderAmendmentState | null;
  toState: ProcurementPurchaseOrderAmendmentState; actorId: string; reason: string; outboxId: string | null; receiptReference: string | null; createdAt: string;
}

export class ProcurementPurchaseOrderAmendmentIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super('purchase order amendment idempotency key was reused with a different request');
    this.name = 'ProcurementPurchaseOrderAmendmentIdempotencyConflictError';
  }
}

function stableJsonObject(value: unknown): string {
  if (value === null || Array.isArray(value) || typeof value !== 'object' || !isPlainObject(value)) {
    throw new Error('normalizedPatch must be a plain JSON object');
  }
  return stableJsonValue(value, new Set<object>(), 'normalizedPatch');
}

function stableJsonValue(value: unknown, stack: Set<object>, path: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite JSON values`);
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`${path} must contain JSON values`);
  }
  if (typeof value !== 'object' || value === null) throw new Error(`${path} must contain JSON values`);
  if (stack.has(value)) throw new Error(`${path} must not contain a cycle`);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== value.length) {
      throw new Error(`${path} must not contain a sparse or anomalous array`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error(`${path} must not contain a sparse or anomalous array`);
    }
    if (Object.getOwnPropertyNames(value).some((key) => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) {
      throw new Error(`${path} must not contain a sparse or anomalous array`);
    }
    stack.add(value);
    try { return `[${value.map((item, index) => stableJsonValue(item, stack, `${path}[${index}]`)).join(',')}]`; }
    finally { stack.delete(value); }
  }
  if (!isPlainObject(value)) throw new Error(`${path} must not contain a custom prototype`);
  if (Object.getOwnPropertySymbols(value).length) throw new Error(`${path} must not contain symbol keys`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error(`${path}.${key} must not contain a getter`);
  }
  stack.add(value);
  try {
    return `{${Object.keys(descriptors).sort().map((key) => `${JSON.stringify(key)}:${stableJsonValue(descriptors[key]!.value, stack, `${path}.${key}`)}`).join(',')}}`;
  } finally { stack.delete(value); }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function amendmentFromRow(row: {
  tenant_id: string; id: string; po_id: string; action: ProcurementPurchaseOrderAmendmentAction; source_po_version: number;
  normalized_patch_json: string; state: ProcurementPurchaseOrderAmendmentState; outbox_id: string | null; receipt_reference: string | null;
  idempotency_key: string; actor_id: string; reason: string; created_at: string; updated_at: string; applied_at: string | null;
}): ProcurementPurchaseOrderAmendment {
  return {
    tenantId: row.tenant_id, id: row.id, poId: row.po_id, action: row.action, sourcePoVersion: row.source_po_version,
    normalizedPatch: JSON.parse(row.normalized_patch_json) as Record<string, unknown>, state: row.state, outboxId: row.outbox_id,
    receiptReference: row.receipt_reference, idempotencyKey: row.idempotency_key, actorId: row.actor_id, reason: row.reason,
    createdAt: row.created_at, updatedAt: row.updated_at, appliedAt: row.applied_at,
  };
}

export function createProcurementPurchaseOrderAmendment(
  db: DatabaseSync,
  tenantId: string,
  input: {
    id: string; poId: string; action: ProcurementPurchaseOrderAmendmentAction; sourcePoVersion: number; normalizedPatch: Readonly<Record<string, unknown>>;
    idempotencyKey: string; actorId: string; reason: string; at: string;
  },
): { amendment: ProcurementPurchaseOrderAmendment; replayed: boolean } {
  if (!Number.isSafeInteger(input.sourcePoVersion) || input.sourcePoVersion < 1) throw new Error('sourcePoVersion must be a positive safe integer');
  const id = requireRepositoryText(input.id, 'id'); const poId = requireRepositoryText(input.poId, 'poId');
  const idempotencyKey = requireRepositoryText(input.idempotencyKey, 'idempotencyKey'); const actorId = requireRepositoryText(input.actorId, 'actorId');
  if (input.action !== 'edit' && input.action !== 'cancel') throw new Error('invalid amendment action');
  const reason = requireRepositoryText(input.reason, 'reason'); const at = requireEvidenceTimestamp(input.at, 'at'); const normalizedPatchJson = stableJsonObject(input.normalizedPatch);
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const replay = db.prepare(`SELECT * FROM procurement_purchase_order_amendments WHERE tenant_id=? AND idempotency_key=?`)
      .get(tenantId, idempotencyKey) as Parameters<typeof amendmentFromRow>[0] | undefined;
    if (replay) {
      const existing = amendmentFromRow(replay);
      if (existing.poId !== poId || existing.action !== input.action || existing.sourcePoVersion !== input.sourcePoVersion
        || stableJsonObject(existing.normalizedPatch) !== normalizedPatchJson || existing.actorId !== actorId || existing.reason !== reason) {
        throw new ProcurementPurchaseOrderAmendmentIdempotencyConflictError(idempotencyKey);
      }
      if (ownsTransaction) db.exec('COMMIT');
      return { amendment: existing, replayed: true };
    }
    db.prepare(`INSERT INTO procurement_purchase_order_amendments
      (tenant_id,id,po_id,action,source_po_version,normalized_patch_json,state,outbox_id,receipt_reference,idempotency_key,actor_id,reason,created_at,updated_at,applied_at)
      VALUES (?,?,?,?,?,?, 'requested',NULL,NULL,?,?,?,?,?,NULL)`).run(
      tenantId, id, poId, input.action, input.sourcePoVersion, normalizedPatchJson, idempotencyKey, actorId, reason, at, at,
    );
    const amendment = getProcurementPurchaseOrderAmendment(db, tenantId, id)!;
    appendProcurementPurchaseOrderAmendmentAudit(db, tenantId, {
      amendmentId: id, fromState: null, toState: 'requested', actorId, reason, outboxId: null, receiptReference: null, at,
    });
    if (ownsTransaction) db.exec('COMMIT');
    return { amendment, replayed: false };
  } catch (error) {
    if (ownsTransaction) rollback(db);
    throw error;
  }
}

export function getProcurementPurchaseOrderAmendment(db: DatabaseSync, tenantId: string, id: string): ProcurementPurchaseOrderAmendment | null {
  const row = db.prepare('SELECT * FROM procurement_purchase_order_amendments WHERE tenant_id=? AND id=?').get(tenantId, id) as Parameters<typeof amendmentFromRow>[0] | undefined;
  return row ? amendmentFromRow(row) : null;
}

const AMENDMENT_LEGAL_TRANSITIONS: Readonly<Record<ProcurementPurchaseOrderAmendmentState, readonly ProcurementPurchaseOrderAmendmentState[]>> = {
  requested: ['queued', 'pending', 'rejected', 'cancelled'], queued: ['pending', 'dispatched', 'failed', 'cancelled'],
  pending: ['dispatched', 'failed', 'rejected', 'cancelled'], dispatched: ['applied', 'failed', 'unknown'],
  unknown: ['applied', 'failed'], failed: ['queued', 'pending', 'cancelled'], applied: [], rejected: [], cancelled: [],
};

export function transitionProcurementPurchaseOrderAmendment(
  db: DatabaseSync,
  tenantId: string,
  input: { id: string; state: ProcurementPurchaseOrderAmendmentState; actorId: string; reason: string; outboxId?: string; receiptReference?: string; at: string },
): ProcurementPurchaseOrderAmendment {
  const current = getProcurementPurchaseOrderAmendment(db, tenantId, input.id);
  if (!current) throw new Error('purchase order amendment not found');
  if (!AMENDMENT_LEGAL_TRANSITIONS[current.state].includes(input.state)) throw new Error(`illegal state transition: ${current.state} -> ${input.state}`);
  const actorId = requireRepositoryText(input.actorId, 'actorId'); const reason = requireRepositoryText(input.reason, 'reason'); const at = requireEvidenceTimestamp(input.at, 'at');
  const outboxId = input.outboxId === undefined ? current.outboxId : requireRepositoryText(input.outboxId, 'outboxId');
  const receiptReference = input.receiptReference === undefined ? current.receiptReference : requireRepositoryText(input.receiptReference, 'receiptReference');
  if (['queued', 'pending', 'dispatched', 'failed', 'unknown', 'applied'].includes(input.state) && !outboxId) {
    throw new Error(`outboxId is required for amendment state ${input.state}`);
  }
  if (input.state === 'applied' && !receiptReference) throw new Error('receiptReference is required for amendment state applied');
  const appliedAt = input.state === 'applied' ? at : current.appliedAt;
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const changed = db.prepare(`UPDATE procurement_purchase_order_amendments SET state=?,outbox_id=?,receipt_reference=?,updated_at=?,applied_at=?
      WHERE tenant_id=? AND id=? AND state=?`).run(input.state, outboxId, receiptReference, at, appliedAt, tenantId, current.id, current.state);
    if (Number(changed.changes) !== 1) throw new Error('purchase order amendment state changed concurrently');
    appendProcurementPurchaseOrderAmendmentAudit(db, tenantId, {
      amendmentId: current.id, fromState: current.state, toState: input.state, actorId, reason, outboxId, receiptReference, at,
    });
    const amendment = getProcurementPurchaseOrderAmendment(db, tenantId, current.id)!;
    if (ownsTransaction) db.exec('COMMIT');
    return amendment;
  } catch (error) {
    if (ownsTransaction) rollback(db);
    throw error;
  }
}

function appendProcurementPurchaseOrderAmendmentAudit(
  db: DatabaseSync, tenantId: string,
  input: Omit<ProcurementPurchaseOrderAmendmentAuditEvent, 'tenantId' | 'id' | 'sequence' | 'createdAt'> & { at: string },
): ProcurementPurchaseOrderAmendmentAuditEvent {
  const sequence = (db.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM procurement_purchase_order_amendment_audit
    WHERE tenant_id=? AND amendment_id=?`).get(tenantId, input.amendmentId) as { sequence: number }).sequence;
  const event: ProcurementPurchaseOrderAmendmentAuditEvent = {
    tenantId, id: `po-amendment-audit:${randomUUID()}`, amendmentId: input.amendmentId, sequence, fromState: input.fromState,
    toState: input.toState, actorId: input.actorId, reason: input.reason, outboxId: input.outboxId,
    receiptReference: input.receiptReference, createdAt: input.at,
  };
  db.prepare(`INSERT INTO procurement_purchase_order_amendment_audit
    (tenant_id,id,amendment_id,sequence,from_state,to_state,actor_id,reason,outbox_id,receipt_reference,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    event.tenantId, event.id, event.amendmentId, event.sequence, event.fromState, event.toState, event.actorId, event.reason,
    event.outboxId, event.receiptReference, event.createdAt,
  );
  return event;
}

export function listProcurementPurchaseOrderAmendmentAudit(
  db: DatabaseSync, tenantId: string, amendmentId: string,
): ProcurementPurchaseOrderAmendmentAuditEvent[] {
  return (db.prepare(`SELECT tenant_id,id,amendment_id,sequence,from_state,to_state,actor_id,reason,outbox_id,receipt_reference,created_at
    FROM procurement_purchase_order_amendment_audit WHERE tenant_id=? AND amendment_id=? ORDER BY sequence`).all(tenantId, amendmentId) as Array<{
      tenant_id: string; id: string; amendment_id: string; sequence: number; from_state: ProcurementPurchaseOrderAmendmentState | null;
      to_state: ProcurementPurchaseOrderAmendmentState; actor_id: string; reason: string; outbox_id: string | null;
      receipt_reference: string | null; created_at: string;
    }>).map((row) => ({
    tenantId: row.tenant_id, id: row.id, amendmentId: row.amendment_id, sequence: row.sequence, fromState: row.from_state, toState: row.to_state,
    actorId: row.actor_id, reason: row.reason, outboxId: row.outbox_id, receiptReference: row.receipt_reference, createdAt: row.created_at,
  }));
}

export interface ProcurementPurchaseOrderDocumentSnapshot {
  tenantId: string; id: string; poId: string; documentId: string; snapshotKind: 'purchase_order' | 'amendment' | 'cancellation';
  sourcePoVersion: number; contextWatermark: string; templateVersion: number; contentSha256: string; objectKey: string; sizeBytes: number;
  generatedBy: string; generatedAt: string;
}

export type ProcurementPurchaseOrderDocumentRequestState = 'generating' | 'ready' | 'failed';

export interface ProcurementPurchaseOrderDocumentRequest {
  tenantId: string;
  snapshotId: string;
  poId: string;
  sourcePoVersion: number;
  payloadFingerprint: string;
  projectionJson: string;
  generatedBy: string;
  generatedAt: string;
  state: ProcurementPurchaseOrderDocumentRequestState;
  ownerToken: string;
  leaseVersion: number;
  leaseExpiresAt: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

function documentRequestFromRow(row: {
  tenant_id: string; snapshot_id: string; po_id: string; source_po_version: number; payload_fingerprint: string;
  projection_json: string; generated_by: string; generated_at: string; state: ProcurementPurchaseOrderDocumentRequestState;
  owner_token: string; lease_version: number; lease_expires_at: number; last_error: string | null; created_at: string; updated_at: string;
}): ProcurementPurchaseOrderDocumentRequest {
  return {
    tenantId: row.tenant_id, snapshotId: row.snapshot_id, poId: row.po_id, sourcePoVersion: row.source_po_version,
    payloadFingerprint: row.payload_fingerprint, projectionJson: row.projection_json, generatedBy: row.generated_by,
    generatedAt: row.generated_at, state: row.state, ownerToken: row.owner_token, leaseVersion: row.lease_version,
    leaseExpiresAt: row.lease_expires_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function validateDocumentRequest(input: Omit<ProcurementPurchaseOrderDocumentRequest, 'tenantId'>): Omit<ProcurementPurchaseOrderDocumentRequest, 'tenantId'> {
  if (!Number.isSafeInteger(input.sourcePoVersion) || input.sourcePoVersion < 1
    || !Number.isSafeInteger(input.leaseVersion) || input.leaseVersion < 1
    || !Number.isSafeInteger(input.leaseExpiresAt) || input.leaseExpiresAt < 0) {
    throw new Error('invalid PO document request numeric metadata');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.payloadFingerprint)) throw new Error('payloadFingerprint must be a lowercase SHA-256 hash');
  if (!['generating', 'ready', 'failed'].includes(input.state)) throw new Error('invalid PO document request state');
  const projectionJson = requireRepositoryText(input.projectionJson, 'projectionJson');
  let projection: unknown;
  try { projection = JSON.parse(projectionJson); }
  catch { throw new Error('projectionJson must be valid JSON'); }
  if (projection === null || Array.isArray(projection) || typeof projection !== 'object') throw new Error('projectionJson must encode an object');
  return {
    snapshotId: requireRepositoryText(input.snapshotId, 'snapshotId'),
    poId: requireRepositoryText(input.poId, 'poId'),
    sourcePoVersion: input.sourcePoVersion,
    payloadFingerprint: input.payloadFingerprint,
    projectionJson,
    generatedBy: requireRepositoryText(input.generatedBy, 'generatedBy'),
    generatedAt: requireEvidenceTimestamp(input.generatedAt, 'generatedAt'),
    state: input.state,
    ownerToken: requireRepositoryText(input.ownerToken, 'ownerToken'),
    leaseVersion: input.leaseVersion,
    leaseExpiresAt: input.leaseExpiresAt,
    lastError: input.lastError === null ? null : requireRepositoryText(input.lastError, 'lastError'),
    createdAt: requireEvidenceTimestamp(input.createdAt, 'createdAt'),
    updatedAt: requireEvidenceTimestamp(input.updatedAt, 'updatedAt'),
  };
}

export function createProcurementPurchaseOrderDocumentRequest(
  db: DatabaseSync, tenantId: string, input: Omit<ProcurementPurchaseOrderDocumentRequest, 'tenantId'>,
): ProcurementPurchaseOrderDocumentRequest {
  const request = { tenantId: requireRepositoryText(tenantId, 'tenantId'), ...validateDocumentRequest(input) };
  db.prepare(`INSERT INTO procurement_purchase_order_document_requests
    (tenant_id,snapshot_id,po_id,source_po_version,payload_fingerprint,projection_json,generated_by,generated_at,state,
     owner_token,lease_version,lease_expires_at,last_error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    request.tenantId, request.snapshotId, request.poId, request.sourcePoVersion, request.payloadFingerprint,
    request.projectionJson, request.generatedBy, request.generatedAt, request.state, request.ownerToken,
    request.leaseVersion, request.leaseExpiresAt, request.lastError, request.createdAt, request.updatedAt,
  );
  return request;
}

export function getProcurementPurchaseOrderDocumentRequest(
  db: DatabaseSync, tenantId: string, snapshotId: string,
): ProcurementPurchaseOrderDocumentRequest | null {
  const row = db.prepare(`SELECT * FROM procurement_purchase_order_document_requests
    WHERE tenant_id=? AND snapshot_id=?`).get(tenantId, snapshotId) as Parameters<typeof documentRequestFromRow>[0] | undefined;
  return row ? documentRequestFromRow(row) : null;
}

export function takeoverProcurementPurchaseOrderDocumentRequest(
  db: DatabaseSync,
  tenantId: string,
  input: { snapshotId: string; expectedLeaseVersion: number; ownerToken: string; leaseExpiresAt: number; nowEpochMs: number; updatedAt: string },
): ProcurementPurchaseOrderDocumentRequest | null {
  if (!Number.isSafeInteger(input.expectedLeaseVersion) || input.expectedLeaseVersion < 1
    || !Number.isSafeInteger(input.nowEpochMs) || input.nowEpochMs < 0
    || !Number.isSafeInteger(input.leaseExpiresAt) || input.leaseExpiresAt <= input.nowEpochMs) {
    throw new Error('invalid PO document request takeover lease');
  }
  const changed = db.prepare(`UPDATE procurement_purchase_order_document_requests
    SET state='generating',owner_token=?,lease_version=lease_version+1,lease_expires_at=?,last_error=NULL,updated_at=?
    WHERE tenant_id=? AND snapshot_id=? AND lease_version=? AND state!='ready'
      AND (state='failed' OR lease_expires_at<=?)`).run(
    requireRepositoryText(input.ownerToken, 'ownerToken'), input.leaseExpiresAt,
    requireEvidenceTimestamp(input.updatedAt, 'updatedAt'), tenantId, requireRepositoryText(input.snapshotId, 'snapshotId'),
    input.expectedLeaseVersion, input.nowEpochMs,
  );
  return Number(changed.changes) === 1 ? getProcurementPurchaseOrderDocumentRequest(db, tenantId, input.snapshotId) : null;
}

export function markProcurementPurchaseOrderDocumentRequestReady(
  db: DatabaseSync,
  tenantId: string,
  input: { snapshotId: string; ownerToken: string; leaseVersion: number; updatedAt: string },
): boolean {
  if (!Number.isSafeInteger(input.leaseVersion) || input.leaseVersion < 1) throw new Error('invalid PO document request lease version');
  const changed = db.prepare(`UPDATE procurement_purchase_order_document_requests
    SET state='ready',lease_expires_at=0,last_error=NULL,updated_at=?
    WHERE tenant_id=? AND snapshot_id=? AND state='generating' AND owner_token=? AND lease_version=?`).run(
    requireEvidenceTimestamp(input.updatedAt, 'updatedAt'), tenantId, requireRepositoryText(input.snapshotId, 'snapshotId'),
    requireRepositoryText(input.ownerToken, 'ownerToken'), input.leaseVersion,
  );
  return Number(changed.changes) === 1;
}

export function markProcurementPurchaseOrderDocumentRequestFailed(
  db: DatabaseSync,
  tenantId: string,
  input: { snapshotId: string; ownerToken: string; leaseVersion: number; lastError: string; updatedAt: string },
): boolean {
  if (!Number.isSafeInteger(input.leaseVersion) || input.leaseVersion < 1) throw new Error('invalid PO document request lease version');
  const changed = db.prepare(`UPDATE procurement_purchase_order_document_requests
    SET state='failed',lease_expires_at=0,last_error=?,updated_at=?
    WHERE tenant_id=? AND snapshot_id=? AND state='generating' AND owner_token=? AND lease_version=?`).run(
    requireRepositoryText(input.lastError, 'lastError'), requireEvidenceTimestamp(input.updatedAt, 'updatedAt'),
    tenantId, requireRepositoryText(input.snapshotId, 'snapshotId'), requireRepositoryText(input.ownerToken, 'ownerToken'), input.leaseVersion,
  );
  return Number(changed.changes) === 1;
}

function documentSnapshotFromRow(row: {
  tenant_id: string; id: string; po_id: string; document_id: string; snapshot_kind: ProcurementPurchaseOrderDocumentSnapshot['snapshotKind'];
  source_po_version: number; context_watermark: string; template_version: number; content_sha256: string; object_key: string; size_bytes: number;
  generated_by: string; generated_at: string;
}): ProcurementPurchaseOrderDocumentSnapshot {
  return {
    tenantId: row.tenant_id, id: row.id, poId: row.po_id, documentId: row.document_id, snapshotKind: row.snapshot_kind,
    sourcePoVersion: row.source_po_version, contextWatermark: row.context_watermark, templateVersion: row.template_version,
    contentSha256: row.content_sha256, objectKey: row.object_key, sizeBytes: row.size_bytes, generatedBy: row.generated_by, generatedAt: row.generated_at,
  };
}

export function createProcurementPurchaseOrderDocumentSnapshot(
  db: DatabaseSync, tenantId: string, input: Omit<ProcurementPurchaseOrderDocumentSnapshot, 'tenantId'>,
): ProcurementPurchaseOrderDocumentSnapshot {
  if (!Number.isSafeInteger(input.sourcePoVersion) || input.sourcePoVersion < 1 || !Number.isSafeInteger(input.templateVersion) || input.templateVersion < 1
    || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error('invalid document snapshot numeric metadata');
  if (!/^[0-9a-f]{64}$/.test(input.contentSha256)) throw new Error('contentSha256 must be a lowercase SHA-256 hash');
  if (!['purchase_order', 'amendment', 'cancellation'].includes(input.snapshotKind)) throw new Error('invalid snapshotKind');
  const snapshot: ProcurementPurchaseOrderDocumentSnapshot = {
    tenantId, ...input, id: requireRepositoryText(input.id, 'id'), poId: requireRepositoryText(input.poId, 'poId'),
    documentId: requireRepositoryText(input.documentId, 'documentId'), contextWatermark: requireRepositoryText(input.contextWatermark, 'contextWatermark'),
    objectKey: requireRepositoryText(input.objectKey, 'objectKey'), generatedBy: requireRepositoryText(input.generatedBy, 'generatedBy'),
    generatedAt: requireEvidenceTimestamp(input.generatedAt, 'generatedAt'),
  };
  db.prepare(`INSERT INTO procurement_purchase_order_document_snapshots
    (tenant_id,id,po_id,document_id,snapshot_kind,source_po_version,context_watermark,template_version,content_sha256,object_key,size_bytes,generated_by,generated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    snapshot.tenantId, snapshot.id, snapshot.poId, snapshot.documentId, snapshot.snapshotKind, snapshot.sourcePoVersion,
    snapshot.contextWatermark, snapshot.templateVersion, snapshot.contentSha256, snapshot.objectKey, snapshot.sizeBytes, snapshot.generatedBy, snapshot.generatedAt,
  );
  return snapshot;
}

export function getProcurementPurchaseOrderDocumentSnapshot(
  db: DatabaseSync, tenantId: string, id: string,
): ProcurementPurchaseOrderDocumentSnapshot | null {
  const row = db.prepare('SELECT * FROM procurement_purchase_order_document_snapshots WHERE tenant_id=? AND id=?').get(tenantId, id) as Parameters<typeof documentSnapshotFromRow>[0] | undefined;
  return row ? documentSnapshotFromRow(row) : null;
}

/** Stable correlation identity frozen into every Readywork -> Odoo PO draft request. */
export function purchaseOrderOdooCorrelationKey(tenantId: string, poId: string): string {
  const tenant = tenantId.trim();
  const purchaseOrderId = poId.trim();
  if (!tenant || !purchaseOrderId) throw new Error('Odoo PO correlation tenantId 和 poId 不能为空');
  return `readywork:${tenant}:${purchaseOrderId}`;
}

export interface OrgRow {
  kind: 'tenant' | 'department' | 'human' | 'ai';
  id: string;
  json: string;
}

export interface OrgRepository {
  list(): OrgRow[];
  save(row: OrgRow): void;
  get(kind: OrgRow['kind'], id: string): OrgRow | undefined;
}

export interface WorkforceRepository {
  saveDefinition(definition: EmployeeDefinition, currentVersionId: string): void;
  getDefinition(id: string): EmployeeDefinition | undefined;
  listDefinitions(): EmployeeDefinition[];
  saveVersion(version: EmployeeVersion): void;
  getVersion(id: string): EmployeeVersion | undefined;
  listVersions(employeeId: string): EmployeeVersion[];
  saveDeployment(deployment: EmployeeDeployment): void;
  getDeployment(employeeId: string): EmployeeDeployment | undefined;
}

export type ProcurementDocumentKind = 'item' | 'supplier' | 'requisition' | 'rfq' | 'quote' | 'quote_comparison' | 'award' | 'purchase_order' | 'confirmation' | 'production_progress' | 'shipment' | 'transport_event' | 'receipt' | 'invoice' | 'match' | 'communication';
export type ProcurementLineKind = 'requisition_line' | 'rfq_line' | 'quote_line' | 'award_line' | 'purchase_order_line' | 'confirmation_line' | 'production_progress_line' | 'shipment_line' | 'receipt_line' | 'invoice_line' | 'match_line';

export interface VersionedProcurementDocument<T extends ProcurementDocument = ProcurementDocument> {
  document: T;
  version: number;
}

export interface IdempotentRequisitionCreate {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly requisition: ProcurementRequisition;
  readonly lines: readonly RequisitionLine[];
}

export interface IdempotentRequisitionResult {
  readonly requisition: VersionedProcurementDocument<ProcurementRequisition>;
  readonly lines: RequisitionLine[];
  readonly replayed: boolean;
}

export class ProcurementIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super('采购申请幂等键已被不同载荷使用');
    this.name = 'ProcurementIdempotencyConflictError';
  }
}

export class ProcurementQuantityEventConflictError extends Error {
  constructor() {
    super('数量事件幂等键已被不同载荷使用');
    this.name = 'ProcurementQuantityEventConflictError';
  }
}

export type IdempotentProcurementCreateKind = 'rfq' | 'quote';

export interface IdempotentProcurementCreate<
  TDocument extends ProcurementDocument,
  TLine extends ProcurementLine,
> {
  readonly kind: IdempotentProcurementCreateKind;
  readonly lineKind: 'rfq_line' | 'quote_line';
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly document: TDocument;
  readonly lines: readonly TLine[];
}

export interface IdempotentProcurementCreateResult<
  TDocument extends ProcurementDocument,
  TLine extends ProcurementLine,
> {
  readonly document: VersionedProcurementDocument<TDocument>;
  readonly lines: TLine[];
  readonly replayed: boolean;
}

export class ProcurementCreateIdempotencyConflictError extends Error {
  constructor(readonly kind: IdempotentProcurementCreateKind, readonly idempotencyKey: string) {
    super(`${kind} 幂等键已被不同载荷使用`);
    this.name = 'ProcurementCreateIdempotencyConflictError';
  }
}

export type ProcurementValidationCode =
  | 'INVALID_INPUT'
  | 'RFQ_NOT_FOUND'
  | 'PO_NOT_FOUND'
  | 'SUPPLIER_NOT_FOUND'
  | 'SUPPLIER_NOT_CANDIDATE'
  | 'SUPPLIER_PO_MISMATCH'
  | 'SUPPLIER_EMAIL_MISMATCH'
  | 'RFQ_LINE_SET_MISMATCH'
  | 'QUOTE_SET_MISMATCH'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_LINE_NOT_FOUND'
  | 'QUOTE_RELATION_MISMATCH'
  | 'QUOTE_NOT_ELIGIBLE'
  | 'QUOTE_EXPIRED'
  | 'AWARD_LINE_SET_MISMATCH'
  | 'AWARD_QUANTITY_INVALID'
  | 'UNMODELED_QUOTE_CHARGES'
  | 'DUPLICATE_PO_NUMBER'
  | 'IMPORT_DOCUMENT_GATE_BLOCKED';

/** Stable business-validation failure; API layers may map `code` to 404/422. */
export class ProcurementValidationError extends Error {
  constructor(readonly code: ProcurementValidationCode, message: string) {
    super(message);
    this.name = 'ProcurementValidationError';
  }
}

export class ProcurementRfqVersionConflictError extends Error {
  readonly code = 'RFQ_VERSION_CONFLICT' as const;
  constructor(readonly expectedVersion: number, readonly actualVersion: number) {
    super(`RFQ 版本冲突: expected=${expectedVersion}, actual=${actualVersion}`);
    this.name = 'ProcurementRfqVersionConflictError';
  }
}

export class ProcurementQuoteVersionConflictError extends Error {
  readonly code = 'QUOTE_VERSION_CONFLICT' as const;
  constructor(readonly quoteId: EntityId, readonly expectedVersion: number, readonly actualVersion: number) {
    super(`报价版本冲突: quote=${quoteId}, expected=${expectedVersion}, actual=${actualVersion}`);
    this.name = 'ProcurementQuoteVersionConflictError';
  }
}

export class ProcurementRfqStateConflictError extends Error {
  readonly code = 'RFQ_STATE_CONFLICT' as const;
  constructor(readonly actualStatus: string, readonly allowedStatuses: readonly string[]) {
    super(`RFQ 状态 ${actualStatus} 不允许执行该操作`);
    this.name = 'ProcurementRfqStateConflictError';
  }
}

export class ProcurementQuoteComparisonIdempotencyConflictError extends Error {
  readonly code = 'QUOTE_COMPARISON_IDEMPOTENCY_CONFLICT' as const;
  constructor(readonly idempotencyKey: string) {
    super('报价比较幂等键已被不同载荷使用');
    this.name = 'ProcurementQuoteComparisonIdempotencyConflictError';
  }
}

export class ProcurementAwardIdempotencyConflictError extends Error {
  readonly code = 'AWARD_IDEMPOTENCY_CONFLICT' as const;
  constructor(readonly idempotencyKey: string) {
    super('定标幂等键已被不同载荷使用');
    this.name = 'ProcurementAwardIdempotencyConflictError';
  }
}

export class ProcurementRfqAlreadyAwardedError extends Error {
  readonly code = 'RFQ_ALREADY_AWARDED' as const;
  constructor(readonly rfqId: EntityId) {
    super('RFQ 已定标');
    this.name = 'ProcurementRfqAlreadyAwardedError';
  }
}

export interface QuoteVersionExpectation {
  readonly quoteId: EntityId;
  readonly version: number;
}

export interface PersistQuoteComparisonInput {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly expectedRfqVersion: number;
  readonly quoteVersions: readonly QuoteVersionExpectation[];
  readonly snapshot: QuoteComparisonSnapshot;
}

export interface PersistQuoteComparisonResult {
  readonly snapshot: VersionedProcurementDocument<QuoteComparisonSnapshot>;
  readonly rfq: VersionedProcurementDocument<RequestForQuotation>;
  readonly replayed: boolean;
}

export interface AwardRfqLineSelection {
  readonly rfqLineId: EntityId;
  readonly quoteLineId: EntityId;
  readonly awardedQuantity: number;
  readonly selectionReason: string;
}

export interface AwardRfqInput {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly rfqId: EntityId;
  readonly expectedRfqVersion: number;
  readonly approvedBy: EntityId;
  readonly approvedAt: string;
  readonly lines: readonly AwardRfqLineSelection[];
}

export interface DraftPurchaseOrderResult {
  readonly purchaseOrder: VersionedProcurementDocument<PurchaseOrder>;
  readonly lines: readonly PurchaseOrderLine[];
}

export interface AwardRfqResult {
  readonly award: VersionedProcurementDocument<Award>;
  readonly lines: readonly AwardLine[];
  readonly purchaseOrders: readonly DraftPurchaseOrderResult[];
  readonly rfq: VersionedProcurementDocument<RequestForQuotation>;
  readonly replayed: boolean;
}

export type ProcurementExecutionAction =
  | 'send_rfq'
  | 'send_po'
  | 'edit_po'
  | 'cancel_po'
  | 'duplicate_po'
  | 'create_odoo_po_draft'
  | 'record_confirmation'
  | 'decide_confirmation'
  | 'queue_followup'
  | 'update_rihd'
  | 'mark_at_risk'
  | 'record_production_progress'
  | 'record_shipment'
  | 'record_transport_event'
  | 'record_receipt'
  | 'record_invoice'
  | 'match_invoice'
  | 'decide_ap';

export interface PurchaseOrderEditLineInput {
  readonly id: EntityId;
  readonly itemCode: string;
  readonly description: string;
  readonly quantity: number;
  readonly unit: string;
  readonly unitPrice: number | null;
  readonly taxRate: number | null;
}

/** The only mutable PO facts accepted by the source-aware Edit PO contract. */
export interface PurchaseOrderEditPatch {
  readonly supplierId?: EntityId;
  readonly requiredInHouseAt?: string;
  readonly materialType?: 'direct' | 'indirect';
  readonly contactId?: EntityId | null;
  readonly lines?: readonly PurchaseOrderEditLineInput[];
}

export interface ExecutionLineInput {
  readonly poLineId: EntityId;
  readonly quantity: number;
  readonly unitPrice?: number;
  readonly promisedAt?: string;
  readonly receiptAllocations?: readonly { receiptLineId: EntityId; allocatedQty: number }[];
  readonly netAmount?: number;
  readonly currency?: string;
  readonly progressStatus?: ProductionProgressStatus;
  readonly completionPercent?: number;
  readonly expectedReadyAt?: string;
  readonly note?: string;
}

export interface ProcurementExecutionMutationInput {
  readonly action: ProcurementExecutionAction;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly actorId: EntityId;
  readonly permission: 'operate' | 'approve' | 'operate_and_approve';
  readonly aggregateId: EntityId;
  readonly expectedVersion: number;
  readonly occurredAt: string;
  readonly connectorId?: string;
  readonly connectorReady?: boolean;
  readonly decision?: 'approved' | 'rejected';
  readonly shortfallDisposition?: 'cancel_remainder';
  readonly confirmationMissingFields?: readonly SupplierReplyField[];
  readonly reason?: string;
  readonly evidenceSource?: ProcurementFulfilmentEvidenceSource;
  readonly evidenceReference?: string;
  readonly supplierId?: EntityId;
  readonly supplierReference?: string;
  readonly warehouseId?: EntityId;
  readonly shipmentId?: EntityId;
  readonly carrier?: string;
  readonly trackingNumber?: string;
  readonly estimatedArrivalAt?: string;
  readonly requiredInHouseAt?: string;
  readonly purchaseOrderNumber?: string;
  readonly riskSeverity?: 'medium' | 'high' | 'critical';
  readonly riskCategory?: 'supplier_response' | 'schedule' | 'production' | 'logistics' | 'quality' | 'commercial' | 'compliance' | 'other';
  readonly recommendedAction?: string;
  readonly eventCode?: TransportEventCode;
  readonly eventOccurredAt?: string;
  readonly eventReference?: string;
  readonly location?: string;
  readonly carrierReference?: string;
  readonly invoiceNumber?: string;
  readonly currency?: string;
  readonly invoiceDate?: string;
  readonly poId?: EntityId;
  readonly lines?: readonly ExecutionLineInput[];
  readonly matchPolicy?: LineMatchPolicy;
  readonly patch?: PurchaseOrderEditPatch;
}

export interface ProcurementExecutionMutationResult {
  readonly action: ProcurementExecutionAction;
  readonly aggregate: VersionedProcurementDocument;
  readonly createdDocuments: readonly ProcurementDocument[];
  readonly createdLines: readonly ProcurementLine[];
  readonly approval?: ProcurementExecutionApproval;
  readonly outbox?: ProcurementOutboxMessage;
  readonly messageDraft?: Readonly<Record<string, unknown>>;
  readonly exception?: Exception;
  readonly amendment?: ProcurementPurchaseOrderAmendment;
  /** Stable cancellation request identity returned by cancel_po. */
  readonly requestId?: string;
  readonly replayed: boolean;
}

export interface ClaimProcurementOutboxInput {
  readonly workerId: string;
  readonly claimedAt: string;
  readonly leaseDurationMs: number;
  readonly limit?: number;
  readonly channel?: ProcurementOutboxMessage['channel'];
}

export interface CompleteProcurementOutboxInput {
  readonly id: EntityId;
  readonly leaseToken: string;
  readonly completedAt: string;
  readonly sentAttachments?: readonly ProcurementOutboxAttachmentSnapshot[];
  readonly connectorResult?: Readonly<Record<string, unknown>>;
}

export interface FailProcurementOutboxInput {
  /** A gateway scheduling replay performed no new channel attempt. Requires retryAt. */
  readonly deferred?: boolean;
  readonly id: EntityId;
  readonly leaseToken: string;
  readonly failedAt: string;
  readonly error: string;
  /** True when the connector may have accepted the external side effect. */
  readonly uncertain?: boolean;
  /** Omit to make the failure terminal; provide a future time to schedule a retry. */
  readonly retryAt?: string;
}

/** Durable work queue for document extraction.  These actions never imply an external side effect. */
export interface EnqueueProcurementDocumentJobInput {
  readonly attachmentId: EntityId;
  readonly id?: EntityId;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
}

export interface ClaimProcurementDocumentJobsInput {
  readonly workerId: string;
  readonly claimedAt: string;
  readonly leaseDurationMs: number;
  readonly limit?: number;
}

export interface CompleteProcurementDocumentJobInput {
  readonly id: EntityId;
  readonly lockToken: string;
  readonly completedAt: string;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly detectedContentType?: string;
  readonly extractedTextPreview?: string;
}

export interface FailProcurementDocumentJobInput {
  readonly id: EntityId;
  readonly lockToken: string;
  readonly failedAt: string;
  readonly error: string;
  /** Omit to use the job's normal retry policy. Set false for a terminal failure. */
  readonly retry?: boolean;
  readonly retryAt?: string;
}

export class ProcurementDocumentJobLeaseConflictError extends Error {
  readonly code = 'PROCUREMENT_DOCUMENT_JOB_LEASE_CONFLICT' as const;
  constructor(readonly jobId: EntityId) {
    super('文档任务租约已失效或不属于当前 worker');
    this.name = 'ProcurementDocumentJobLeaseConflictError';
  }
}

export interface RequeueBlockedProcurementOutboxInput {
  readonly connectorId: string;
  readonly requeuedAt: string;
  readonly limit?: number;
}

export class ProcurementExecutionIdempotencyConflictError extends Error {
  readonly code = 'EXECUTION_IDEMPOTENCY_CONFLICT' as const;
  constructor(readonly action: ProcurementExecutionAction, readonly idempotencyKey: string) {
    super(`${action} 幂等键已被不同载荷使用`);
    this.name = 'ProcurementExecutionIdempotencyConflictError';
  }
}

export class ProcurementExecutionVersionConflictError extends Error {
  readonly code = 'EXECUTION_VERSION_CONFLICT' as const;
  constructor(readonly expectedVersion: number, readonly actualVersion: number) {
    super(`采购执行版本冲突: expected=${expectedVersion}, actual=${actualVersion}`);
    this.name = 'ProcurementExecutionVersionConflictError';
  }
}

export class ProcurementExecutionStateConflictError extends Error {
  readonly code = 'EXECUTION_STATE_CONFLICT' as const;
  constructor(readonly status: string, readonly action: ProcurementExecutionAction) {
    super(`状态 ${status} 不允许执行 ${action}`);
    this.name = 'ProcurementExecutionStateConflictError';
  }
}

/**
 * A PO may remain `draft` while its email sits in the durable outbox.  This
 * separate conflict makes that in-flight state explicit instead of allowing a
 * second send request with a fresh HTTP idempotency key to enqueue another
 * external side effect.
 */
export class ProcurementExecutionSendInFlightError extends Error {
  readonly code = 'EXECUTION_SEND_IN_FLIGHT' as const;
  constructor(readonly aggregateId: EntityId, readonly outboxId: EntityId) {
    super('该采购订单已有正在等待或发送中的发送任务');
    this.name = 'ProcurementExecutionSendInFlightError';
  }
}

export class ProcurementExecutionPermissionError extends Error {
  readonly code = 'EXECUTION_PERMISSION_DENIED' as const;
  constructor(readonly requiredPermission: 'operate' | 'approve' | 'operate_and_approve') {
    super(`采购执行需要 ${requiredPermission} 权限`);
    this.name = 'ProcurementExecutionPermissionError';
  }
}

export class ProcurementDuplicateInvoiceError extends Error {
  readonly code = 'DUPLICATE_INVOICE' as const;
  constructor(readonly invoiceNumber: string) {
    super('同一供应商的发票号已存在');
    this.name = 'ProcurementDuplicateInvoiceError';
  }
}

export class ProcurementOutboxLeaseConflictError extends Error {
  readonly code = 'PROCUREMENT_OUTBOX_LEASE_CONFLICT' as const;
  constructor(readonly outboxId: EntityId) {
    super('采购 outbox 租约已失效或不属于当前 worker');
    this.name = 'ProcurementOutboxLeaseConflictError';
  }
}

export interface SupplierSyncIssue {
  readonly row: number;
  readonly reason: string;
}

export interface SupplierSyncItem {
  readonly id: string;
  readonly externalId: string;
  readonly name: string;
  readonly currency: string;
  readonly contacts: Supplier['contacts'];
  readonly countryCode?: string;
  readonly countryName?: string;
  readonly city?: string;
  readonly street?: string;
  readonly street2?: string;
  readonly postalCode?: string;
  readonly status: Supplier['status'];
  readonly sourceSystem: string;
  readonly version: number;
}

export interface SupplierSyncResult {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly issues: SupplierSyncIssue[];
  readonly items: SupplierSyncItem[];
}

export interface IdempotentSupplierSync {
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly suppliers: readonly Supplier[];
  readonly issues: readonly SupplierSyncIssue[];
  readonly completedAt: string;
}

export class SupplierSyncIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super('供应商同步幂等键已被不同载荷使用');
    this.name = 'SupplierSyncIdempotencyConflictError';
  }
}

export interface IdempotentInboundCommunication {
  readonly payloadHash: string;
  readonly communication: Communication;
}

export interface IdempotentInboundCommunicationResult {
  readonly communication: VersionedProcurementDocument<Communication>;
  readonly replayed: boolean;
}

export class ProcurementInboundCommunicationIdempotencyConflictError extends Error {
  readonly code = 'INBOUND_COMMUNICATION_IDENTITY_CONFLICT' as const;
  constructor() {
    super('入站邮件标识已被不同证据载荷使用');
    this.name = 'ProcurementInboundCommunicationIdempotencyConflictError';
  }
}

export interface StoredMatchDecision {
  id: EntityId;
  tenantId: EntityId;
  ruleVersion: string;
  status: LineMatchDisposition;
  snapshot: LineMatchResult;
  createdAt: string;
}

export interface ProcurementRepository {
  saveDocument<T extends ProcurementDocument>(kind: ProcurementDocumentKind, document: T, expectedVersion?: number): VersionedProcurementDocument<T>;
  getDocument<T extends ProcurementDocument = ProcurementDocument>(kind: ProcurementDocumentKind, id: EntityId): VersionedProcurementDocument<T> | undefined;
  listDocuments<T extends ProcurementDocument = ProcurementDocument>(kind: ProcurementDocumentKind): VersionedProcurementDocument<T>[];
  saveLine<T extends ProcurementLine>(kind: ProcurementLineKind, documentId: EntityId, line: T): T;
  getLine<T extends ProcurementLine = ProcurementLine>(kind: ProcurementLineKind, id: EntityId): T | undefined;
  listLines<T extends ProcurementLine = ProcurementLine>(kind: ProcurementLineKind, documentId: EntityId): T[];
  applyPurchaseOrderLineQuantityEvent(line: PurchaseOrderLine, event: PurchaseOrderLineQuantityEvent): QuantityProjectionResult;
  getPurchaseOrderLineQuantityProjection(poLineId: EntityId): PurchaseOrderLineQuantityProjection | undefined;
  appendMatchDecision(decision: StoredMatchDecision): void;
  getMatchDecision(id: EntityId): StoredMatchDecision | undefined;
  createRequisitionIdempotent(input: IdempotentRequisitionCreate): IdempotentRequisitionResult;
  createRfqIdempotent(input: Omit<IdempotentProcurementCreate<RequestForQuotation, RequestForQuotationLine>, 'kind' | 'lineKind'>): IdempotentProcurementCreateResult<RequestForQuotation, RequestForQuotationLine>;
  createQuoteIdempotent(input: Omit<IdempotentProcurementCreate<SupplierQuote, SupplierQuoteLine>, 'kind' | 'lineKind'>): IdempotentProcurementCreateResult<SupplierQuote, SupplierQuoteLine>;
  persistQuoteComparison(input: PersistQuoteComparisonInput): PersistQuoteComparisonResult;
  awardRfqAndCreateDraftPurchaseOrders(input: AwardRfqInput): AwardRfqResult;
  executeProcurementMutation(input: ProcurementExecutionMutationInput): ProcurementExecutionMutationResult;
  getExecutionApproval(id: EntityId): ProcurementExecutionApproval | undefined;
  getOutboxMessage(id: EntityId): ProcurementOutboxMessage | undefined;
  listOutboxMessages(status?: ProcurementOutboxMessage['status']): ProcurementOutboxMessage[];
  requeueBlockedOutboxMessages(input: RequeueBlockedProcurementOutboxInput): ProcurementOutboxMessage[];
  claimOutboxMessages(input: ClaimProcurementOutboxInput): ProcurementOutboxMessage[];
  completeOutboxMessage(input: CompleteProcurementOutboxInput): ProcurementOutboxMessage;
  failOutboxMessage(input: FailProcurementOutboxInput): ProcurementOutboxMessage;
  getSupplierSyncResult(idempotencyKey: string, payloadHash: string): SupplierSyncResult | undefined;
  syncSuppliersIdempotent(input: IdempotentSupplierSync): SupplierSyncResult;
  persistInboundCommunicationIdempotent(input: IdempotentInboundCommunication): IdempotentInboundCommunicationResult;
  enqueueDocumentJob(input: EnqueueProcurementDocumentJobInput): ProcurementDocumentJob;
  getDocumentJob(id: EntityId): ProcurementDocumentJob | undefined;
  listDocumentJobs(status?: ProcurementDocumentJob['status']): ProcurementDocumentJob[];
  claimDocumentJobs(input: ClaimProcurementDocumentJobsInput): ProcurementDocumentJob[];
  completeDocumentJob(input: CompleteProcurementDocumentJobInput): ProcurementDocumentJob;
  failDocumentJob(input: FailProcurementDocumentJobInput): ProcurementDocumentJob;
}

const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS business_objects (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  json TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget (
  employee_id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exceptions (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  object_id TEXT,
  seq INTEGER,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS org (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
`;

const PLATFORM_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_tasks (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, employee_id TEXT NOT NULL,
  json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS runtime_business_objects (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS runtime_approvals (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
  json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS runtime_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, type TEXT NOT NULL,
  json TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runtime_events_tenant_seq ON runtime_events (tenant_id, seq);
CREATE TABLE IF NOT EXISTS runtime_budget (
  tenant_id TEXT NOT NULL, employee_id TEXT NOT NULL, json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, employee_id)
);
CREATE TABLE IF NOT EXISTS runtime_exceptions (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, object_id TEXT NOT NULL, status TEXT NOT NULL,
  json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS runtime_activities (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, object_id TEXT, seq INTEGER, json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS runtime_org (
  tenant_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, kind, id)
);

CREATE TABLE IF NOT EXISTS workforce_employees (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, definition_json TEXT NOT NULL,
  current_version_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS workforce_employee_versions (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, employee_id TEXT NOT NULL, version TEXT NOT NULL,
  definition_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS workforce_employee_deployments (
  tenant_id TEXT NOT NULL, employee_id TEXT NOT NULL, version_id TEXT NOT NULL,
  deploy_mode TEXT NOT NULL, active_workflow_version_id TEXT, permission_policy_id TEXT,
  rule_set_id TEXT, connector_grant_ids_json TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, employee_id)
);

CREATE TABLE IF NOT EXISTS control_connector_installations (
  tenant_id TEXT NOT NULL, connector_id TEXT NOT NULL, version INTEGER NOT NULL,
  status TEXT NOT NULL, config_json TEXT NOT NULL, installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, error TEXT, PRIMARY KEY (tenant_id, connector_id, version)
);
CREATE TABLE IF NOT EXISTS control_credentials (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, connector_id TEXT NOT NULL,
  credential_type TEXT NOT NULL, name TEXT NOT NULL, encrypted_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'untested', last_tested_at TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS control_connector_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, connector_id TEXT NOT NULL,
  event_type TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_connector_events_tenant ON control_connector_events (tenant_id, seq DESC);
CREATE TABLE IF NOT EXISTS control_security_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL, severity TEXT NOT NULL, request_id TEXT NOT NULL,
  method TEXT NOT NULL, path TEXT NOT NULL, actor_id TEXT,
  message TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_security_events_tenant ON control_security_events (tenant_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_control_security_events_created ON control_security_events (tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS control_security_event_resolutions (
  tenant_id TEXT NOT NULL, event_seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','accepted_risk','resolved')),
  reason TEXT NOT NULL, actor_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, event_seq)
);
CREATE INDEX IF NOT EXISTS idx_control_security_event_resolutions_status
  ON control_security_event_resolutions (tenant_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS control_security_event_resolution_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, event_seq INTEGER NOT NULL,
  from_status TEXT NOT NULL, to_status TEXT NOT NULL,
  reason TEXT NOT NULL, actor_id TEXT NOT NULL, version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_security_event_resolution_audit_event
  ON control_security_event_resolution_audit (tenant_id, event_seq, seq DESC);
CREATE TABLE IF NOT EXISTS action_executions (
  tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, run_id TEXT NOT NULL,
  node_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL,
  lease_expires_at TEXT, attempt INTEGER NOT NULL DEFAULT 1, updated_at TEXT,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS control_temporal_approval_decisions (
  tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, decision_id TEXT NOT NULL,
  node_id TEXT NOT NULL, decision TEXT NOT NULL, status TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  lease_expires_at TEXT,
  error TEXT,
  PRIMARY KEY (tenant_id, run_id, decision_id)
);
`;

const WORKFLOW_CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS editor_workflows (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS editor_versions (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, current INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS editor_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS control_workflow_drafts (tenant_id TEXT NOT NULL, employee_id TEXT NOT NULL, workflow_id TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, employee_id, workflow_id));
CREATE TABLE IF NOT EXISTS control_workflow_versions (seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, employee_id TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, current INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL, rule_set_version TEXT, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (tenant_id, employee_id, id));
CREATE TABLE IF NOT EXISTS control_workflow_runs (tenant_id TEXT NOT NULL, id TEXT NOT NULL, employee_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_version_id TEXT, temporal_workflow_id TEXT, status TEXT NOT NULL, mode TEXT NOT NULL, idempotency_key TEXT, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, idempotency_key));
CREATE TABLE IF NOT EXISTS control_node_runs (tenant_id TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, json TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, PRIMARY KEY (tenant_id, id));
CREATE INDEX IF NOT EXISTS idx_control_node_runs_run ON control_node_runs (tenant_id, run_id, started_at);
CREATE TABLE IF NOT EXISTS control_business_activities (tenant_id TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL, node_run_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, object_id TEXT, json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, id));
CREATE INDEX IF NOT EXISTS idx_control_business_activities_run ON control_business_activities (tenant_id, run_id, created_at);
CREATE TABLE IF NOT EXISTS control_rule_sets (tenant_id TEXT NOT NULL, employee_id TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, current INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, employee_id, id));
CREATE TABLE IF NOT EXISTS control_workflow_quarantine (tenant_id TEXT NOT NULL, employee_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, quarantined_at TEXT NOT NULL, PRIMARY KEY (tenant_id, employee_id, kind, id));
CREATE TABLE IF NOT EXISTS control_workflow_blueprint_imports (tenant_id TEXT NOT NULL, employee_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_fingerprint TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, actor_id TEXT NOT NULL, before_snapshot TEXT NOT NULL, after_snapshot TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, employee_id, idempotency_key));
`;

const PROCUREMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_documents (
  tenant_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  source_system TEXT NOT NULL, external_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
  json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, kind, id),
  UNIQUE (tenant_id, kind, source_system, external_id)
);
CREATE TABLE IF NOT EXISTS procurement_lines (
  tenant_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
  document_id TEXT NOT NULL, line_number TEXT NOT NULL, json TEXT NOT NULL,
  projection_generation INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, kind, id),
  UNIQUE (tenant_id, kind, document_id, line_number)
);
CREATE INDEX IF NOT EXISTS idx_procurement_lines_document
  ON procurement_lines (tenant_id, kind, document_id, line_number);
CREATE TABLE IF NOT EXISTS procurement_attachments (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL,
  requisition_id TEXT NOT NULL, requisition_line_id TEXT,
  owner_type TEXT NOT NULL DEFAULT 'requisition', owner_id TEXT,
  file_name TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, version INTEGER NOT NULL, supersedes_id TEXT,
  extraction_status TEXT NOT NULL, extracted_text_preview TEXT,
  content BLOB NOT NULL, status TEXT NOT NULL,
  security_status TEXT NOT NULL DEFAULT 'pending_scan',
  processing_status TEXT NOT NULL DEFAULT 'not_queued',
  detected_content_type TEXT, scan_error TEXT, parse_error TEXT, parsed_at TEXT,
  storage_backend TEXT NOT NULL DEFAULT 'sqlite', object_key TEXT, storage_etag TEXT, storage_encryption TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_attachments_requisition
  ON procurement_attachments (tenant_id, requisition_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_attachment_version
  ON procurement_attachments (tenant_id, requisition_id, ifnull(requisition_line_id, ''), file_name, version);
CREATE TABLE IF NOT EXISTS procurement_attachment_idempotency (
  tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS procurement_attachment_audit (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, attachment_id TEXT NOT NULL,
  requisition_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
  owner_type TEXT NOT NULL DEFAULT 'requisition', owner_id TEXT,
  detail_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_attachment_audit_object
  ON procurement_attachment_audit (tenant_id, requisition_id, created_at);
CREATE TABLE IF NOT EXISTS procurement_document_jobs (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, attachment_id TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL, locked_at TEXT, lock_token TEXT, lease_expires_at TEXT,
  error TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_document_jobs_claim
  ON procurement_document_jobs (tenant_id, status, available_at, lease_expires_at, created_at);
CREATE TABLE IF NOT EXISTS procurement_po_line_quantity_events (
  tenant_id TEXT NOT NULL, source_system TEXT NOT NULL, source_event_id TEXT NOT NULL,
  po_line_id TEXT NOT NULL, dimension TEXT NOT NULL, delta REAL NOT NULL,
  occurred_at TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, source_system, source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_quantity_events_line
  ON procurement_po_line_quantity_events (tenant_id, po_line_id, occurred_at);
CREATE TABLE IF NOT EXISTS procurement_po_line_quantity_projections (
  tenant_id TEXT NOT NULL, po_line_id TEXT NOT NULL, ordered_qty REAL NOT NULL,
  confirmed_qty REAL NOT NULL, shipped_qty REAL NOT NULL, received_qty REAL NOT NULL,
  invoiced_qty REAL NOT NULL, cancelled_qty REAL NOT NULL, projection_json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, po_line_id)
);
CREATE TABLE IF NOT EXISTS procurement_match_decisions (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, rule_version TEXT NOT NULL,
  status TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_match_decisions_status
  ON procurement_match_decisions (tenant_id, status, created_at);
`;

const PROCUREMENT_REQUISITION_IDEMPOTENCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_requisition_idempotency (
  tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  requisition_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
`;

const PROCUREMENT_CREATE_IDEMPOTENCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_create_idempotency (
  tenant_id TEXT NOT NULL, kind TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL, document_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, kind, idempotency_key)
);
`;

const PROCUREMENT_SOURCING_DECISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_quote_comparison_idempotency (
  tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS procurement_award_idempotency (
  tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  rfq_id TEXT NOT NULL, award_id TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_award_rfq
  ON procurement_documents (tenant_id, json_extract(json, '$.rfqId'))
  WHERE kind = 'award';
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_award_rfq_line
  ON procurement_lines (tenant_id, json_extract(json, '$.rfqLineId'))
  WHERE kind = 'award_line';
`;

const PROCUREMENT_RFQ_OPEN_TO_DRAFT_MIGRATION = `
UPDATE procurement_documents
SET status = 'draft', json = json_set(json, '$.status', 'draft')
WHERE kind = 'rfq' AND status = 'open';
`;

const PROCUREMENT_QUOTE_COMPARISON_REVISIONS_MIGRATION = `
DROP INDEX IF EXISTS uq_procurement_quote_comparison_rfq;
`;

const PROCUREMENT_EXECUTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_execution_idempotency (
  tenant_id TEXT NOT NULL, action TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, action, idempotency_key)
);
CREATE TABLE IF NOT EXISTS procurement_execution_approvals (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT NOT NULL,
  status TEXT NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_execution_approvals_object
  ON procurement_execution_approvals (tenant_id, object_id, status);
CREATE TABLE IF NOT EXISTS procurement_outbox (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, channel TEXT NOT NULL, connector_id TEXT NOT NULL,
  action TEXT NOT NULL, aggregate_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL, payload_json TEXT NOT NULL, json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, channel, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_procurement_outbox_status
  ON procurement_outbox (tenant_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_invoice_number
  ON procurement_documents (tenant_id, json_extract(json, '$.supplierId'), json_extract(json, '$.invoiceNumber'))
  WHERE kind = 'invoice';
`;

// Columns are installed idempotently by ensureProcurementOutboxColumns so this
// migration is safe both for databases upgraded from v12 and schemas created by
// initializeControlPlaneSchema before runMigrations is called.
const PROCUREMENT_OUTBOX_DELIVERY_MIGRATION = `SELECT 1;`;

/**
 * Human-reviewed supplier messages.  The message remains a draft until a
 * reviewer explicitly approves it; delivery is tracked by procurement_outbox
 * and only a completed connector call may advance it to `sent`.
 */
const PROCUREMENT_MESSAGE_DRAFT_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_message_drafts (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  purchase_order_id TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  trigger_code TEXT NOT NULL,
  trigger_evidence_json TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  outbox_id TEXT,
  created_by TEXT NOT NULL,
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  sent_at TEXT,
  sender_name TEXT,
  sender_title TEXT,
  sender_organization TEXT,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, trigger_code)
);
CREATE INDEX IF NOT EXISTS idx_procurement_message_drafts_status
  ON procurement_message_drafts (tenant_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS procurement_message_draft_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_message_draft_events_draft
  ON procurement_message_draft_events (tenant_id, draft_id, created_at, id);
`;

/**
 * Supplier-facing identity used by every procurement communication.  It is
 * deliberately separate from SMTP credentials: the professional contact is
 * business configuration, not a secret, and every change remains auditable.
 */
const PROCUREMENT_COMMUNICATION_IDENTITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_communication_identities (
  tenant_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  title TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id)
);
CREATE TABLE IF NOT EXISTS procurement_communication_identity_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_communication_identity_events
  ON procurement_communication_identity_events (tenant_id,created_at,id);
`;

/**
 * Tenant-level procurement deployment profile. Navisight explicitly supports
 * both ERP-connected and email-only operation, so the source-of-record choice
 * is persisted and audited instead of being inferred from installed
 * connectors. Absence keeps the existing Odoo-connected behavior.
 */
const PROCUREMENT_DEPLOYMENT_PROFILE_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_deployment_profiles (
  tenant_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('odoo_connected','email_only')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id)
);
CREATE TABLE IF NOT EXISTS procurement_deployment_profile_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_deployment_profile_events
  ON procurement_deployment_profile_events (tenant_id,created_at,id);
`;

/**
 * Tenant-level locale and calendar preferences used by procurement pages and
 * scheduled policies. Values remain versioned and audited; timestamps in the
 * operational ledger continue to be persisted as ISO UTC instants.
 */
const PROCUREMENT_TENANT_PREFERENCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_tenant_preferences (
  tenant_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  working_days_json TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  date_format TEXT NOT NULL,
  sla_escalations_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sla_escalations_enabled IN (0,1)),
  exclude_weekends INTEGER NOT NULL DEFAULT 1 CHECK (exclude_weekends IN (0,1)),
  exclude_public_holidays INTEGER NOT NULL DEFAULT 1 CHECK (exclude_public_holidays IN (0,1)),
  auto_calculate_lead_time INTEGER NOT NULL DEFAULT 1 CHECK (auto_calculate_lead_time IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id)
);
CREATE TABLE IF NOT EXISTS procurement_tenant_preference_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_tenant_preference_events
  ON procurement_tenant_preference_events (tenant_id,created_at,id);
`;

/** Meta WhatsApp acknowledgement, delivery/read callbacks and inbound evidence. */
const PROCUREMENT_WHATSAPP_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_whatsapp_delivery_events (
  tenant_id TEXT NOT NULL,
  event_fingerprint TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  draft_id TEXT,
  outbox_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted','sent','delivered','read','failed')),
  occurred_at TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  raw_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,event_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_procurement_whatsapp_delivery_message
  ON procurement_whatsapp_delivery_events (tenant_id,provider_message_id,occurred_at,status);
CREATE INDEX IF NOT EXISTS idx_procurement_whatsapp_delivery_draft
  ON procurement_whatsapp_delivery_events (tenant_id,draft_id,occurred_at,status);
CREATE TABLE IF NOT EXISTS procurement_whatsapp_inbound_messages (
  tenant_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  context_message_id TEXT,
  from_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  communication_id TEXT,
  po_id TEXT,
  supplier_id TEXT,
  raw_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_whatsapp_inbound_po
  ON procurement_whatsapp_inbound_messages (tenant_id,po_id,occurred_at,provider_message_id);
`;

const PROCUREMENT_NOTIFICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_notifications (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  tag TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unread',
  version INTEGER NOT NULL DEFAULT 1,
  read_by TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_procurement_notifications_status
  ON procurement_notifications (tenant_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_procurement_notifications_object
  ON procurement_notifications (tenant_id, object_type, object_id, created_at DESC);
CREATE TABLE IF NOT EXISTS procurement_notification_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_notification_events_notification
  ON procurement_notification_events (tenant_id, notification_id, created_at, id);
`;

/**
 * Procurement-route facts are kept outside imported PO JSON so an ERP refresh
 * cannot erase a reviewed route decision.  Every change is versioned and
 * accompanied by an audit event with its evidence.
 */
const PROCUREMENT_ROUTE_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_route_assignments (
  tenant_id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('local','import')),
  source TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, po_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_route_assignments_route
  ON procurement_route_assignments (tenant_id, route, updated_at DESC, po_id);
CREATE TABLE IF NOT EXISTS procurement_route_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_route_events_po
  ON procurement_route_events (tenant_id, po_id, created_at, id);
`;

const PROCUREMENT_ROUTE_ASSIGNMENT_IDEMPOTENCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_route_assignment_idempotency (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
`;

/**
 * PO-specific contract and Incoterm evidence files. The binary remains in the
 * shared attachment store and must pass its existing malware/parser pipeline;
 * this table only owns the versioned business binding and route audit trail.
 */
const PROCUREMENT_ROUTE_EVIDENCE_DOCUMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_route_evidence_documents (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN ('contract','incoterm')),
  attachment_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_route_evidence_documents_po
  ON procurement_route_evidence_documents (tenant_id,po_id,status,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS procurement_route_evidence_document_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_route_evidence_document_events_po
  ON procurement_route_evidence_document_events (tenant_id,po_id,created_at,id);
CREATE TABLE IF NOT EXISTS procurement_route_evidence_document_idempotency (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,idempotency_key)
);
`;

/**
 * Immutable procurement-risk materializations.  A snapshot is keyed by the
 * source portfolio watermark, so retries are idempotent while every genuine
 * procurement fact change can produce a new point in the historical trend.
 */
const PROCUREMENT_RISK_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_risk_snapshots (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_watermark TEXT NOT NULL,
  as_of TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_watermark)
);
CREATE INDEX IF NOT EXISTS idx_procurement_risk_snapshots_range
  ON procurement_risk_snapshots (tenant_id, as_of DESC, id);
`;

/**
 * Versioned procurement SLA control plane and its current/materialized PO
 * evaluations. Policies remain immutable after publication; a new draft must
 * be created for later changes. Evaluation events provide an auditable status
 * history without putting derived deadlines back into imported ERP JSON.
 */
const PROCUREMENT_SLA_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_sla_policies (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')),
  version INTEGER NOT NULL DEFAULT 1,
  rules_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  published_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_sla_published
  ON procurement_sla_policies (tenant_id) WHERE status='published';
CREATE INDEX IF NOT EXISTS idx_procurement_sla_policies_status
  ON procurement_sla_policies (tenant_id, status, updated_at DESC, id);
CREATE TABLE IF NOT EXISTS procurement_sla_policy_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_sla_policy_events_policy
  ON procurement_sla_policy_events (tenant_id, policy_id, created_at, id);
CREATE TABLE IF NOT EXISTS procurement_sla_evaluations (
  tenant_id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  rule_id TEXT,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  due_at TEXT,
  grace_until TEXT,
  next_followup_at TEXT,
  followup_count INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  evaluated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, po_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_sla_evaluations_status
  ON procurement_sla_evaluations (tenant_id, status, due_at, po_id);
CREATE TABLE IF NOT EXISTS procurement_sla_evaluation_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  rule_id TEXT,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_sla_evaluation_events_po
  ON procurement_sla_evaluation_events (tenant_id, po_id, created_at, id);
`;

/** Tenant-scoped Advanced SLA profiles, their immutable audit trails, runtime
 * kill switches, and normalized CSV import batches. */
const PROCUREMENT_ADVANCED_SLA_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_advanced_sla_profiles (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')),
  version INTEGER NOT NULL DEFAULT 1, sections_json TEXT NOT NULL, auto_send_json TEXT NOT NULL,
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL, published_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT,
  PRIMARY KEY (tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_advanced_sla_published
  ON procurement_advanced_sla_profiles (tenant_id) WHERE status='published';
CREATE INDEX IF NOT EXISTS idx_procurement_advanced_sla_profiles
  ON procurement_advanced_sla_profiles (tenant_id,status,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS procurement_advanced_sla_profile_events (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, profile_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  action TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_advanced_sla_profile_events
  ON procurement_advanced_sla_profile_events (tenant_id,profile_id,created_at,id);
CREATE TABLE IF NOT EXISTS procurement_advanced_sla_runtime_controls (
  tenant_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,profile_id)
);
CREATE TABLE IF NOT EXISTS procurement_advanced_sla_runtime_events (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version INTEGER NOT NULL, actor_id TEXT NOT NULL,
  action TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_advanced_sla_runtime_events
  ON procurement_advanced_sla_runtime_events (tenant_id,profile_id,created_at,id);
CREATE TABLE IF NOT EXISTS procurement_advanced_sla_import_batches (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_version INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, source_name TEXT NOT NULL DEFAULT '', payload_hash TEXT NOT NULL, sections_json TEXT NOT NULL,
  summary_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('previewed','applied')),
  error_json TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, applied_by TEXT, applied_at TEXT,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_advanced_sla_import_batches
  ON procurement_advanced_sla_import_batches (tenant_id,profile_id,created_at DESC,id);
`;

/**
 * Import-document control plane.  Requirements are versioned with a policy;
 * PO bindings point at the immutable attachment version that was actually
 * reviewed.  The materialized evaluation is intentionally separate from the
 * imported PO JSON so a document scan or expiry can change the gate without
 * fabricating an ERP update.
 */
const PROCUREMENT_IMPORT_DOCUMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_import_document_policies (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','retired')),
  version INTEGER NOT NULL DEFAULT 1,
  requirements_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  published_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_import_document_policy_published
  ON procurement_import_document_policies (tenant_id) WHERE status='published';
CREATE INDEX IF NOT EXISTS idx_procurement_import_document_policies_status
  ON procurement_import_document_policies (tenant_id,status,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS procurement_import_document_policy_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_import_document_policy_events
  ON procurement_import_document_policy_events (tenant_id,policy_id,created_at,id);
CREATE TABLE IF NOT EXISTS procurement_import_documents (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  requirement_code TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  document_number TEXT,
  issued_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','removed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_import_document_active
  ON procurement_import_documents (tenant_id,po_id,requirement_code) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_procurement_import_documents_po
  ON procurement_import_documents (tenant_id,po_id,status,requirement_code);
CREATE TABLE IF NOT EXISTS procurement_import_document_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  import_document_id TEXT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_import_document_events_po
  ON procurement_import_document_events (tenant_id,po_id,created_at,id);
CREATE TABLE IF NOT EXISTS procurement_import_document_evaluations (
  tenant_id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  policy_id TEXT,
  policy_version INTEGER,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  evaluated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,po_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_import_document_evaluations_status
  ON procurement_import_document_evaluations (tenant_id,status,updated_at DESC,po_id);
CREATE TABLE IF NOT EXISTS procurement_import_document_idempotency (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,idempotency_key)
);
`;

/** Immutable supplier-execution scorecards derived from post-PO facts. */
const PROCUREMENT_SUPPLIER_PERFORMANCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_supplier_performance_snapshots (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source_watermark TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  as_of TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,source_watermark)
);
CREATE INDEX IF NOT EXISTS idx_procurement_supplier_performance_range
  ON procurement_supplier_performance_snapshots (tenant_id,as_of DESC,id);
`;

/**
 * Immutable, evidence-carrying PO execution stage facts.  A document imported
 * from ERP may only create an observed-status fact; exact transitions are
 * written by the execution transaction that owns the business side effect.
 */
const PROCUREMENT_PO_STAGE_EVENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_po_stage_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('po_sent','supplier_commitment','fulfilment_production','dispatch_transit','delivery_grn')),
  event_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('completed','active','pending','blocked')),
  occurred_at TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,po_id,stage,event_type,source_kind,source_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_po_stage_events_po
  ON procurement_po_stage_events (tenant_id,po_id,occurred_at,id);
`;

const PROCUREMENT_PO_STAGE_EVENT_MIGRATION = `${PROCUREMENT_PO_STAGE_EVENT_SCHEMA}
INSERT OR IGNORE INTO procurement_po_stage_events
  (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
SELECT
  d.tenant_id,
  'po-stage-event:migration26:' || d.id,
  d.id,
  CASE
    WHEN d.status='draft' THEN 'po_sent'
    WHEN d.status IN ('sent','awaiting_confirmation','rejected') THEN 'supplier_commitment'
    WHEN d.status IN ('confirmed','in_production','awaiting_shipment') THEN 'fulfilment_production'
    WHEN d.status IN ('partially_shipped','shipped') THEN 'dispatch_transit'
    WHEN d.status IN ('partially_received','received') THEN 'delivery_grn'
    ELSE 'po_sent'
  END,
  'observed_status_backfill',
  CASE WHEN d.status='rejected' THEN 'blocked' WHEN d.status='received' THEN 'completed' ELSE 'active' END,
  d.updated_at,
  'migration',
  'migration26:' || d.id,
  'system:migration',
  json_object(
    'observedStatus', d.status,
    'exactTransitionTime', json('false'),
    'observationAt', d.updated_at,
    'note', 'Migration 26 observed the persisted PO status; this is not an exact historical transition timestamp'
  ),
  d.updated_at
FROM procurement_documents d
WHERE d.kind='purchase_order';
`;

/** Durable, tenant-scoped scheduler state for automatic SLA evaluation. */
const PROCUREMENT_SLA_AUTOMATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_sla_automation_leases (
  tenant_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  next_run_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  last_status TEXT,
  last_result_json TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_sla_automation_due
  ON procurement_sla_automation_leases (enabled,next_run_at,lease_expires_at,tenant_id);
CREATE TABLE IF NOT EXISTS procurement_sla_automation_runs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','abandoned')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_sla_automation_runs_tenant
  ON procurement_sla_automation_runs (tenant_id,started_at DESC,id);
`;

/**
 * Tenant- and user-scoped purchase-order conversations.  The request table is
 * the idempotency/lease boundary; messages are append-only and ordered by a
 * conversation-local sequence so a client-supplied history can never replace
 * the server's authoritative transcript.
 */
const PROCUREMENT_PO_CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_po_chat_conversations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version INTEGER NOT NULL DEFAULT 0,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,po_id,created_by)
);
CREATE INDEX IF NOT EXISTS idx_procurement_po_chat_conversation_po
  ON procurement_po_chat_conversations (tenant_id,po_id,created_by,updated_at DESC);
CREATE TABLE IF NOT EXISTS procurement_po_chat_messages (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  model TEXT,
  model_route TEXT,
  token_usage_json TEXT,
  attachment_id TEXT,
  suggestions_json TEXT NOT NULL DEFAULT '[]',
  request_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,conversation_id,sequence),
  UNIQUE (tenant_id,request_id,role)
);
CREATE INDEX IF NOT EXISTS idx_procurement_po_chat_message_history
  ON procurement_po_chat_messages (tenant_id,conversation_id,sequence);
CREATE TABLE IF NOT EXISTS procurement_po_chat_requests (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','completed')),
  response_json TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_procurement_po_chat_request_lease
  ON procurement_po_chat_requests (tenant_id,status,lease_expires_at,created_at);
CREATE TABLE IF NOT EXISTS procurement_po_chat_audit (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  po_id TEXT NOT NULL,
  message_id TEXT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_po_chat_audit_conversation
  ON procurement_po_chat_audit (tenant_id,conversation_id,created_at,id);
`;

/**
 * Read-only route assistant state. Route facts themselves continue to live in
 * procurement_route_assignments and the portfolio projection; this schema is
 * deliberately limited to conversation, request recovery and audit records.
 */
const PROCUREMENT_ROUTE_CHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_route_chat_conversations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('local','import')),
  created_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','archived')) DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 0,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_route_chat_conversation_owner
  ON procurement_route_chat_conversations (tenant_id,route,created_by,updated_at DESC);
CREATE TABLE IF NOT EXISTS procurement_route_chat_messages (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('local','import')),
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','failed')),
  model TEXT,
  model_route TEXT CHECK (model_route IN ('fast','reasoning')),
  token_usage_json TEXT,
  request_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,conversation_id,sequence),
  UNIQUE (tenant_id,request_id,role)
);
CREATE INDEX IF NOT EXISTS idx_procurement_route_chat_message_history
  ON procurement_route_chat_messages (tenant_id,conversation_id,sequence);
CREATE TABLE IF NOT EXISTS procurement_route_chat_requests (
  tenant_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('local','import')),
  user_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','completed','superseded')),
  response_json TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id,created_by,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_procurement_route_chat_request_lease
  ON procurement_route_chat_requests (tenant_id,created_by,status,lease_expires_at,created_at);
CREATE TABLE IF NOT EXISTS procurement_route_chat_audit (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('local','import')),
  message_id TEXT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_route_chat_audit_conversation
  ON procurement_route_chat_audit (tenant_id,conversation_id,created_at,id);
-- Defensive cleanup for databases initialized by a pre-release build before
-- the partial unique index existed.  It retains the latest active transcript.
UPDATE procurement_route_chat_conversations AS old
SET status='archived'
WHERE old.status='active' AND EXISTS (
  SELECT 1 FROM procurement_route_chat_conversations AS newer
  WHERE newer.tenant_id=old.tenant_id AND newer.route=old.route AND newer.created_by=old.created_by
    AND newer.status='active'
    AND (newer.updated_at>old.updated_at OR (newer.updated_at=old.updated_at AND newer.id>old.id))
);
-- A route assistant has one deterministic active transcript per user.  Older
-- transcripts remain available by explicit id after startNew archives them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_route_chat_one_active_owner
  ON procurement_route_chat_conversations (tenant_id,route,created_by)
  WHERE status='active';
`;

/** Route-chat messages gained one immutable shared attachment reference after
 * the original transcript schema shipped.  The binary remains in
 * procurement_attachments and follows the existing scan/parser job pipeline. */
const PROCUREMENT_ROUTE_CHAT_ATTACHMENT_MIGRATION = `
ALTER TABLE procurement_route_chat_messages ADD COLUMN attachment_id TEXT;
CREATE INDEX IF NOT EXISTS idx_procurement_route_chat_message_attachment
  ON procurement_route_chat_messages (tenant_id,attachment_id);
`;

/** Additive clean-room contracts required by the Navisight-aligned desktop.
 * Existing v1 JSON payloads remain untouched and readable. */
const NAVISIGHT_CLEAN_ROOM_ALIGNMENT_V2_MIGRATION = `
CREATE TABLE procurement_supplier_operating_profiles (
  tenant_id TEXT NOT NULL, supplier_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  country_code TEXT NOT NULL DEFAULT '' CHECK (country_code = '' OR country_code GLOB '[A-Z][A-Z]'),
  route TEXT NOT NULL CHECK (route IN ('local','import','unclassified')),
  supplier_type TEXT NOT NULL CHECK (supplier_type IN ('manufacturer','distributor','service','other')),
  industry TEXT NOT NULL DEFAULT '', address_json TEXT NOT NULL DEFAULT 'null'
    CHECK (json_valid(address_json) AND json_type(address_json) IN ('null','object')),
  primary_material_code TEXT NOT NULL DEFAULT '', primary_material_name TEXT NOT NULL DEFAULT '',
  default_lead_time_days INTEGER CHECK (default_lead_time_days IS NULL OR default_lead_time_days >= 0),
  product_criticality TEXT NOT NULL CHECK (product_criticality IN ('high','medium','low','unclassified')),
  payment_terms TEXT NOT NULL DEFAULT '',
  contract_starts_on TEXT CHECK (contract_starts_on IS NULL OR (contract_starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(contract_starts_on)=contract_starts_on AND date(contract_starts_on,'+0 days')=contract_starts_on)),
  contract_ends_on TEXT CHECK (contract_ends_on IS NULL OR (contract_ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(contract_ends_on)=contract_ends_on AND date(contract_ends_on,'+0 days')=contract_ends_on)),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,supplier_id),
  CHECK (contract_starts_on IS NULL OR contract_ends_on IS NULL OR contract_starts_on <= contract_ends_on)
);
CREATE INDEX idx_procurement_supplier_operating_profiles_route
  ON procurement_supplier_operating_profiles (tenant_id,route,status,supplier_id);

CREATE TRIGGER trg_procurement_supplier_operating_profiles_valid_address_insert
BEFORE INSERT ON procurement_supplier_operating_profiles
WHEN json_type(NEW.address_json)='object' AND (
  COALESCE(json_type(NEW.address_json,'$.line1')='text',0)=0 OR COALESCE(json_type(NEW.address_json,'$.city')='text',0)=0 OR
  COALESCE(json_type(NEW.address_json,'$.countryCode')='text',0)=0 OR
  COALESCE(json_type(NEW.address_json,'$.line2') IN ('text','null'),0)=0 OR COALESCE(json_type(NEW.address_json,'$.region') IN ('text','null'),0)=0 OR
  COALESCE(json_type(NEW.address_json,'$.postalCode') IN ('text','null'),0)=0 OR
  length(trim(json_extract(NEW.address_json,'$.line1')))=0 OR length(trim(json_extract(NEW.address_json,'$.city')))=0 OR
  (json_type(NEW.address_json,'$.line2')='text' AND length(trim(json_extract(NEW.address_json,'$.line2')))=0) OR
  (json_type(NEW.address_json,'$.region')='text' AND length(trim(json_extract(NEW.address_json,'$.region')))=0) OR
  (json_type(NEW.address_json,'$.postalCode')='text' AND length(trim(json_extract(NEW.address_json,'$.postalCode')))=0) OR
  json_extract(NEW.address_json,'$.countryCode') NOT GLOB '[A-Z][A-Z]' OR
  EXISTS (SELECT 1 FROM json_each(NEW.address_json) WHERE key NOT IN ('line1','line2','city','region','postalCode','countryCode'))
)
BEGIN SELECT RAISE(ABORT, 'invalid supplier address'); END;
CREATE TRIGGER trg_procurement_supplier_operating_profiles_valid_address_update
BEFORE UPDATE OF address_json ON procurement_supplier_operating_profiles
WHEN json_type(NEW.address_json)='object' AND (
  COALESCE(json_type(NEW.address_json,'$.line1')='text',0)=0 OR COALESCE(json_type(NEW.address_json,'$.city')='text',0)=0 OR
  COALESCE(json_type(NEW.address_json,'$.countryCode')='text',0)=0 OR
  COALESCE(json_type(NEW.address_json,'$.line2') IN ('text','null'),0)=0 OR COALESCE(json_type(NEW.address_json,'$.region') IN ('text','null'),0)=0 OR
  COALESCE(json_type(NEW.address_json,'$.postalCode') IN ('text','null'),0)=0 OR
  length(trim(json_extract(NEW.address_json,'$.line1')))=0 OR length(trim(json_extract(NEW.address_json,'$.city')))=0 OR
  (json_type(NEW.address_json,'$.line2')='text' AND length(trim(json_extract(NEW.address_json,'$.line2')))=0) OR
  (json_type(NEW.address_json,'$.region')='text' AND length(trim(json_extract(NEW.address_json,'$.region')))=0) OR
  (json_type(NEW.address_json,'$.postalCode')='text' AND length(trim(json_extract(NEW.address_json,'$.postalCode')))=0) OR
  json_extract(NEW.address_json,'$.countryCode') NOT GLOB '[A-Z][A-Z]' OR
  EXISTS (SELECT 1 FROM json_each(NEW.address_json) WHERE key NOT IN ('line1','line2','city','region','postalCode','countryCode'))
)
BEGIN SELECT RAISE(ABORT, 'invalid supplier address'); END;

CREATE TABLE procurement_supplier_operating_profile_events (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, supplier_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1), before_json TEXT, after_json TEXT NOT NULL,
  actor_id TEXT NOT NULL, reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','odoo','import','system')),
  created_at TEXT NOT NULL, PRIMARY KEY (tenant_id,id)
);
CREATE INDEX idx_procurement_supplier_operating_profile_events_supplier
  ON procurement_supplier_operating_profile_events (tenant_id,supplier_id,version,created_at,id);

CREATE TABLE procurement_purchase_order_amendments (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, po_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('edit','cancel')),
  source_po_version INTEGER NOT NULL CHECK (source_po_version >= 1), normalized_patch_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested','queued','pending','dispatched','unknown','applied','failed','rejected','cancelled')),
  outbox_id TEXT, receipt_reference TEXT, idempotency_key TEXT NOT NULL,
  actor_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, applied_at TEXT,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX idx_procurement_purchase_order_amendments_po
  ON procurement_purchase_order_amendments (tenant_id,po_id,created_at,id);
CREATE TRIGGER trg_procurement_purchase_order_amendments_request_immutable
BEFORE UPDATE ON procurement_purchase_order_amendments
WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.id IS NOT OLD.id OR NEW.po_id IS NOT OLD.po_id OR NEW.action IS NOT OLD.action
  OR NEW.source_po_version IS NOT OLD.source_po_version OR NEW.normalized_patch_json IS NOT OLD.normalized_patch_json
  OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.actor_id IS NOT OLD.actor_id OR NEW.reason IS NOT OLD.reason
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable amendment request'); END;

CREATE TABLE procurement_purchase_order_amendment_audit (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, amendment_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence >= 1),
  from_state TEXT CHECK (from_state IN ('requested','queued','pending','dispatched','unknown','applied','failed','rejected','cancelled')),
  to_state TEXT NOT NULL CHECK (to_state IN ('requested','queued','pending','dispatched','unknown','applied','failed','rejected','cancelled')),
  actor_id TEXT NOT NULL, reason TEXT NOT NULL, outbox_id TEXT, receipt_reference TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,amendment_id,sequence)
);
CREATE INDEX idx_procurement_purchase_order_amendment_audit_amendment
  ON procurement_purchase_order_amendment_audit (tenant_id,amendment_id,sequence);

CREATE TABLE procurement_purchase_order_document_requests (
  tenant_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, po_id TEXT NOT NULL,
  source_po_version INTEGER NOT NULL CHECK (source_po_version >= 1),
  payload_fingerprint TEXT NOT NULL CHECK (length(payload_fingerprint) = 64 AND payload_fingerprint NOT GLOB '*[^0-9a-f]*'),
  projection_json TEXT NOT NULL CHECK (json_valid(projection_json) AND json_type(projection_json) = 'object'),
  generated_by TEXT NOT NULL, generated_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('generating','ready','failed')),
  owner_token TEXT NOT NULL, lease_version INTEGER NOT NULL CHECK (lease_version >= 1),
  lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at >= 0), last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,snapshot_id)
);
CREATE INDEX idx_procurement_purchase_order_document_requests_state
  ON procurement_purchase_order_document_requests (tenant_id,state,lease_expires_at,snapshot_id);
CREATE TRIGGER trg_procurement_purchase_order_document_requests_payload_immutable
BEFORE UPDATE ON procurement_purchase_order_document_requests
WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.snapshot_id IS NOT OLD.snapshot_id OR NEW.po_id IS NOT OLD.po_id
  OR NEW.source_po_version IS NOT OLD.source_po_version OR NEW.payload_fingerprint IS NOT OLD.payload_fingerprint
  OR NEW.projection_json IS NOT OLD.projection_json OR NEW.generated_by IS NOT OLD.generated_by
  OR NEW.generated_at IS NOT OLD.generated_at OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT, 'immutable document request'); END;

CREATE TABLE procurement_purchase_order_document_snapshots (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, po_id TEXT NOT NULL, document_id TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('purchase_order','amendment','cancellation')),
  source_po_version INTEGER NOT NULL CHECK (source_po_version >= 1), context_watermark TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version >= 1),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  object_key TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  generated_by TEXT NOT NULL, generated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,document_id)
);
CREATE INDEX idx_procurement_purchase_order_document_snapshots_po
  ON procurement_purchase_order_document_snapshots (tenant_id,po_id,generated_at,id);

CREATE TRIGGER trg_procurement_supplier_operating_profile_events_no_update
BEFORE UPDATE ON procurement_supplier_operating_profile_events
BEGIN SELECT RAISE(ABORT, 'supplier operating profile events are append-only'); END;
CREATE TRIGGER trg_procurement_supplier_operating_profile_events_no_delete
BEFORE DELETE ON procurement_supplier_operating_profile_events
BEGIN SELECT RAISE(ABORT, 'supplier operating profile events are append-only'); END;
CREATE TRIGGER trg_procurement_purchase_order_amendment_audit_no_update
BEFORE UPDATE ON procurement_purchase_order_amendment_audit
BEGIN SELECT RAISE(ABORT, 'purchase order amendment audit is append-only'); END;
CREATE TRIGGER trg_procurement_purchase_order_amendment_audit_no_delete
BEFORE DELETE ON procurement_purchase_order_amendment_audit
BEGIN SELECT RAISE(ABORT, 'purchase order amendment audit is append-only'); END;
CREATE TRIGGER trg_procurement_purchase_order_document_snapshots_no_update
BEFORE UPDATE ON procurement_purchase_order_document_snapshots
BEGIN SELECT RAISE(ABORT, 'purchase order document snapshots are append-only'); END;
CREATE TRIGGER trg_procurement_purchase_order_document_snapshots_no_delete
BEFORE DELETE ON procurement_purchase_order_document_snapshots
BEGIN SELECT RAISE(ABORT, 'purchase order document snapshots are append-only'); END;

CREATE TABLE procurement_route_exports (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('local','import')), normalized_filters_json TEXT NOT NULL,
  source_watermark TEXT NOT NULL, row_count INTEGER NOT NULL CHECK (row_count >= 0),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0), object_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','expired','deleted')),
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX idx_procurement_route_exports_created
  ON procurement_route_exports (tenant_id,created_at DESC,id);

ALTER TABLE procurement_advanced_sla_profiles
  ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version IN (1,2));
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN template_version INTEGER NOT NULL DEFAULT 1 CHECK (template_version >= 1);
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version IN (1,2));
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN domain TEXT NOT NULL DEFAULT 'global' CHECK (domain IN ('global','production_service_milestones','communication_escalation','payment_terms','logistics_planning','logistics_handover','transit_monitoring','regulatory_import_approval','customs_clearance','quality_inspection_grn'));
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN source_sha256 TEXT NOT NULL DEFAULT '' CHECK (source_sha256 = '' OR (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0);
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN valid_count INTEGER NOT NULL DEFAULT 0 CHECK (valid_count >= 0);
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN invalid_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_count >= 0);
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN warning_count INTEGER NOT NULL DEFAULT 0 CHECK (warning_count >= 0);
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN candidate_hash TEXT NOT NULL DEFAULT '' CHECK (candidate_hash = '' OR (length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN validation_results_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE procurement_advanced_sla_import_batches
  ADD COLUMN validated_at TEXT;
`;

/** Per supplier-material product criticality used by the PO risk model. */
const PROCUREMENT_MATERIAL_LEAD_TIME_CRITICALITY_MIGRATION = `
ALTER TABLE procurement_material_lead_times
  ADD COLUMN criticality TEXT NOT NULL DEFAULT 'medium'
  CHECK (criticality IN ('high','medium','low'));
`;

/**
 * Append-only invalidation feed consumed by the Web SSE endpoint. Triggers are
 * deliberately metadata-only: no email body, chat content, document JSON or
 * credential can enter the realtime stream. A single AUTOINCREMENT cursor
 * provides deterministic resume semantics across API restarts.
 */
const PROCUREMENT_REALTIME_EVENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_realtime_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('pos','outbox','messages','notifications')),
  event_type TEXT NOT NULL,
  object_id TEXT,
  object_version TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_procurement_realtime_events_tenant_cursor
  ON procurement_realtime_events (tenant_id,seq);

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_document_insert
AFTER INSERT ON procurement_documents
WHEN NEW.kind IN ('purchase_order','confirmation','production_progress','shipment','transport_event','receipt','invoice','match','communication')
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'pos',NEW.kind || '.created',
     CASE
       WHEN NEW.kind='purchase_order' THEN NEW.id
       WHEN json_valid(NEW.json) THEN COALESCE(json_extract(NEW.json,'$.poId'),NEW.id)
       ELSE NEW.id
     END,
     CAST(NEW.version AS TEXT),NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_document_update
AFTER UPDATE ON procurement_documents
WHEN NEW.kind IN ('purchase_order','confirmation','production_progress','shipment','transport_event','receipt','invoice','match','communication')
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'pos',NEW.kind || '.changed',
     CASE
       WHEN NEW.kind='purchase_order' THEN NEW.id
       WHEN json_valid(NEW.json) THEN COALESCE(json_extract(NEW.json,'$.poId'),NEW.id)
       ELSE NEW.id
     END,
     CAST(NEW.version AS TEXT),NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_outbox_insert
AFTER INSERT ON procurement_outbox
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'outbox','outbox.created',NEW.aggregate_id,NEW.status,NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_outbox_update
AFTER UPDATE OF status,updated_at ON procurement_outbox
WHEN NEW.status <> OLD.status OR NEW.updated_at <> OLD.updated_at
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'outbox','outbox.changed',NEW.aggregate_id,NEW.status,NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_message_draft_insert
AFTER INSERT ON procurement_message_drafts
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'messages','message_draft.created',NEW.purchase_order_id,CAST(NEW.version AS TEXT),NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_message_draft_update
AFTER UPDATE OF status,version,updated_at ON procurement_message_drafts
WHEN NEW.version <> OLD.version OR NEW.status <> OLD.status OR NEW.updated_at <> OLD.updated_at
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'messages','message_draft.changed',NEW.purchase_order_id,CAST(NEW.version AS TEXT),NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_notification_insert
AFTER INSERT ON procurement_notifications
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'notifications','notification.created',NEW.object_id,CAST(NEW.version AS TEXT),NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_notification_update
AFTER UPDATE OF status,version,updated_at ON procurement_notifications
WHEN NEW.version <> OLD.version OR NEW.status <> OLD.status OR NEW.updated_at <> OLD.updated_at
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'notifications','notification.changed',NEW.object_id,CAST(NEW.version AS TEXT),NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_po_chat_message_insert
AFTER INSERT ON procurement_po_chat_messages
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'messages','po_chat_message.created',NEW.po_id,CAST(NEW.sequence AS TEXT),NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_po_chat_attachment_insert
AFTER INSERT ON procurement_attachments
WHEN NEW.owner_type='po_chat_message'
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'messages','po_chat_attachment.created',NEW.owner_id,CAST(NEW.version AS TEXT),NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_procurement_realtime_po_chat_attachment_update
AFTER UPDATE OF security_status,processing_status,extraction_status,parsed_at ON procurement_attachments
WHEN NEW.owner_type='po_chat_message'
  AND (NEW.security_status <> OLD.security_status
    OR NEW.processing_status <> OLD.processing_status
    OR NEW.extraction_status <> OLD.extraction_status
    OR COALESCE(NEW.parsed_at,'') <> COALESCE(OLD.parsed_at,''))
BEGIN
  INSERT INTO procurement_realtime_events
    (tenant_id,family,event_type,object_id,object_version,occurred_at)
  VALUES
    (NEW.tenant_id,'messages','po_chat_attachment.changed',NEW.owner_id,
     NEW.security_status || ':' || NEW.processing_status || ':' || NEW.extraction_status,
     COALESCE(NEW.parsed_at,NEW.created_at));
END;
`;

/**
 * Supplier/material manufacturing lead-time master data.  The active row is
 * versioned in place for optimistic concurrency while every mutation is
 * copied to an append-only event.  `match_key` is computed by the API from a
 * normalized item code, material name, or the supplier/route default (`*`),
 * so imported PO text is never used to guess a supplier identity or route.
 */
const PROCUREMENT_MATERIAL_LEAD_TIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_material_lead_times (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  supplier_name_snapshot TEXT NOT NULL,
  material TEXT NOT NULL DEFAULT '',
  item_code TEXT NOT NULL DEFAULT '',
  material_type TEXT NOT NULL DEFAULT '',
  procurement_route TEXT NOT NULL CHECK (procurement_route IN ('local','import')),
  match_key TEXT NOT NULL,
  standard_lead_time_days INTEGER NOT NULL CHECK (standard_lead_time_days BETWEEN 1 AND 3650),
  remarks TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  retired_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_material_lead_time_active_match
  ON procurement_material_lead_times (tenant_id,supplier_id,procurement_route,match_key)
  WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_procurement_material_lead_time_supplier
  ON procurement_material_lead_times (tenant_id,supplier_id,status,procurement_route,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS procurement_material_lead_time_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  lead_time_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created','updated','retired')),
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_material_lead_time_events_item
  ON procurement_material_lead_time_events (tenant_id,lead_time_id,created_at DESC,id);
`;

const SUPPLIER_SYNC_IDEMPOTENCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS supplier_sync_idempotency (
  tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
`;

const PROCUREMENT_INBOUND_COMMUNICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_inbound_communication_identities (
  tenant_id TEXT NOT NULL,
  communication_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  mailbox TEXT NOT NULL DEFAULT '',
  provider_uid TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, communication_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_inbound_provider_uid
  ON procurement_inbound_communication_identities (tenant_id, provider, mailbox, provider_uid)
  WHERE provider_uid <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_procurement_inbound_message_id
  ON procurement_inbound_communication_identities (tenant_id, message_id)
  WHERE message_id <> '';
`;

/** Durable observability for real IMAP polling and manual supplier-reply checks. */
const PROCUREMENT_INBOUND_MAIL_MONITOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_inbound_mail_status (
  tenant_id TEXT PRIMARY KEY,
  configured INTEGER NOT NULL DEFAULT 0 CHECK (configured IN (0,1)),
  connected INTEGER NOT NULL DEFAULT 0 CHECK (connected IN (0,1)),
  provider TEXT,
  mailbox TEXT,
  last_started_at TEXT,
  last_completed_at TEXT,
  last_status TEXT CHECK (last_status IS NULL OR last_status IN ('running','completed','failed')),
  last_handled_count INTEGER,
  last_error TEXT,
  next_poll_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS procurement_inbound_mail_runs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('automatic','manual')),
  actor_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  handled_count INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  PRIMARY KEY (tenant_id,id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_inbound_mail_runs_tenant
  ON procurement_inbound_mail_runs (tenant_id,started_at DESC,id);
`;

const PROCUREMENT_INBOUND_MAIL_REJECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_inbound_mail_rejections (
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  provider_uid TEXT NOT NULL,
  message_id TEXT,
  observed_sender TEXT,
  po_number TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  next_attempt_at TEXT,
  PRIMARY KEY (tenant_id,provider,mailbox,provider_uid)
);
CREATE INDEX IF NOT EXISTS idx_procurement_inbound_mail_rejections_tenant
  ON procurement_inbound_mail_rejections (tenant_id,last_seen_at DESC,provider_uid);
`;

const PROCUREMENT_PO_INTAKE_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_po_intake_candidates (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  provider_uid TEXT NOT NULL,
  message_id TEXT,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  received_at TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  status TEXT NOT NULL,
  parsed_header_json TEXT,
  parsed_lines_json TEXT,
  parser_confidence REAL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  supplier_match_json TEXT,
  accepted_po_id TEXT,
  rejection_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,provider,mailbox,provider_uid,attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_po_intake_status
  ON procurement_po_intake_candidates (tenant_id,status,received_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_procurement_po_intake_attachment
  ON procurement_po_intake_candidates (tenant_id,attachment_id);
`;

const PROCUREMENT_ODOO_SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_odoo_sync_runs (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_procurement_odoo_sync_snapshot
  ON procurement_odoo_sync_runs (tenant_id, snapshot_hash, created_at);
`;

/**
 * Public product-demo requests are deliberately separate from tenant business
 * data. The public endpoint has no authenticated tenant yet, so every write is
 * protected by a caller idempotency key and accompanied by an append-only
 * event. External email or CRM delivery is intentionally not implied here.
 */
const PUBLIC_DEMO_REQUEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS public_demo_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  work_email TEXT NOT NULL,
  company TEXT NOT NULL,
  role TEXT,
  country TEXT,
  erp TEXT,
  po_volume TEXT,
  message TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted','reviewing','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_public_demo_requests_created
  ON public_demo_requests (created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_public_demo_requests_email
  ON public_demo_requests (work_email, created_at DESC);
CREATE TABLE IF NOT EXISTS public_demo_request_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted','idempotent_replay','status_changed')),
  actor_type TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES public_demo_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_public_demo_request_events_request
  ON public_demo_request_events (request_id, seq);
`;

// Separate migration so databases created before document jobs retain their
// attachment bytes and receive conservative, non-safe defaults.
const PROCUREMENT_DOCUMENT_AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_document_jobs (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, attachment_id TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL, locked_at TEXT, lock_token TEXT, lease_expires_at TEXT,
  error TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_document_jobs_claim
  ON procurement_document_jobs (tenant_id, status, available_at, lease_expires_at, created_at);
`;

const PROCUREMENT_ATTACHMENT_OBJECT_STORAGE_MIGRATION = `SELECT 1;`;

const PROCUREMENT_AI_REPLY_SCHEMA = `
CREATE TABLE IF NOT EXISTS procurement_ai_reply_analyses (
  tenant_id TEXT NOT NULL, communication_id TEXT NOT NULL, po_id TEXT NOT NULL,
  status TEXT NOT NULL, model TEXT NOT NULL, po_version INTEGER NOT NULL,
  result_json TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, communication_id)
);
CREATE INDEX IF NOT EXISTS idx_procurement_ai_reply_po ON procurement_ai_reply_analyses (tenant_id, po_id);
`;

export function initializeControlPlaneSchema(db: DatabaseSync): void {
  db.exec(PROCUREMENT_AI_REPLY_SCHEMA);
  db.exec(`${PLATFORM_SCHEMA}\n${WORKFLOW_CONTROL_SCHEMA}\n${PROCUREMENT_SCHEMA}\n${PROCUREMENT_REQUISITION_IDEMPOTENCY_SCHEMA}\n${PROCUREMENT_CREATE_IDEMPOTENCY_SCHEMA}\n${SUPPLIER_SYNC_IDEMPOTENCY_SCHEMA}\n${PROCUREMENT_SOURCING_DECISION_SCHEMA}\n${PROCUREMENT_EXECUTION_SCHEMA}\n${PROCUREMENT_MESSAGE_DRAFT_SCHEMA}\n${PROCUREMENT_COMMUNICATION_IDENTITY_SCHEMA}\n${PROCUREMENT_DEPLOYMENT_PROFILE_SCHEMA}\n${PROCUREMENT_NOTIFICATION_SCHEMA}\n${PROCUREMENT_ROUTE_SCHEMA}\n${PROCUREMENT_RISK_SNAPSHOT_SCHEMA}\n${PROCUREMENT_SLA_SCHEMA}\n${PROCUREMENT_ADVANCED_SLA_SCHEMA}\n${PROCUREMENT_INBOUND_COMMUNICATION_SCHEMA}\n${PROCUREMENT_INBOUND_MAIL_MONITOR_SCHEMA}\n${PROCUREMENT_INBOUND_MAIL_REJECTION_SCHEMA}\n${PROCUREMENT_PO_INTAKE_SCHEMA}\n${PROCUREMENT_ODOO_SYNC_SCHEMA}\n${PROCUREMENT_PO_STAGE_EVENT_SCHEMA}\n${PROCUREMENT_SLA_AUTOMATION_SCHEMA}\n${PROCUREMENT_WHATSAPP_SCHEMA}\n${PROCUREMENT_PO_CHAT_SCHEMA}\n${PROCUREMENT_ROUTE_CHAT_SCHEMA}\n${PUBLIC_DEMO_REQUEST_SCHEMA}`);
  ensureManufacturingContextSchema(db);
  ensureColumn(db, 'control_connector_installations', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'control_connector_installations', 'error', 'TEXT');
  ensureColumn(db, 'control_credentials', 'status', "TEXT NOT NULL DEFAULT 'untested'");
  ensureColumn(db, 'control_credentials', 'last_tested_at', 'TEXT');
  ensureColumn(db, 'control_credentials', 'last_error', 'TEXT');
  ensureActionExecutionColumns(db);
  ensureApprovalDecisionColumns(db);
  ensureProcurementColumns(db);
  ensureProcurementAttachmentDocumentColumns(db);
  ensureProcurementOutboxColumns(db);
  ensureProcurementMessageDraftColumns(db);
  ensureProcurementInboundMailBackoffColumns(db);
  ensureAdvancedSlaColumns(db);
  ensureProcurementRealtimeEventSchema(db);
}

export interface PersistenceOptions { tenantId?: string }

type ProcurementPoStage = 'po_sent' | 'supplier_commitment' | 'fulfilment_production' | 'dispatch_transit' | 'delivery_grn';
type ProcurementPoStageState = 'completed' | 'active' | 'pending' | 'blocked';

function observedPoStage(status: string): { stage: ProcurementPoStage; state: ProcurementPoStageState } {
  if (status === 'draft') return { stage: 'po_sent', state: 'active' };
  if (status === 'rejected') return { stage: 'supplier_commitment', state: 'blocked' };
  if (['sent', 'awaiting_confirmation'].includes(status)) return { stage: 'supplier_commitment', state: 'active' };
  if (['confirmed', 'in_production', 'awaiting_shipment'].includes(status)) return { stage: 'fulfilment_production', state: 'active' };
  if (['partially_shipped', 'shipped'].includes(status)) return { stage: 'dispatch_transit', state: 'active' };
  if (status === 'partially_received') return { stage: 'delivery_grn', state: 'active' };
  if (status === 'received') return { stage: 'delivery_grn', state: 'completed' };
  return { stage: 'po_sent', state: 'active' };
}

function purchaseOrderDisplayNumber(po: PurchaseOrder): string {
  const number = (po as unknown as Record<string, unknown>)['number'];
  return typeof number === 'string' && number.trim() ? number.trim() : po.externalId || po.id;
}

const MESSAGING_GATEWAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS messaging_inbound_messages (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','teams')),
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  raw_fingerprint TEXT NOT NULL CHECK (length(raw_fingerprint) = 64),
  status TEXT NOT NULL CHECK (status IN ('received','dispatching','processed','rejected','failed')),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  outcome_code TEXT,
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel, adapter_id, provider_message_id)
);
CREATE INDEX IF NOT EXISTS idx_messaging_inbound_claim
  ON messaging_inbound_messages (tenant_id, status, lease_expires_at, received_at, id);

CREATE TABLE IF NOT EXISTS messaging_deliveries (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','teams')),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending','sending','accepted','retry_wait','unknown','failed','abandoned')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  external_dispatch_started INTEGER NOT NULL DEFAULT 0 CHECK (external_dispatch_started IN (0,1)),
  provider_message_id TEXT,
  accepted_at TEXT,
  next_attempt_at TEXT,
  error TEXT,
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, adapter_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_messaging_deliveries_claim
  ON messaging_deliveries (tenant_id, adapter_id, status, next_attempt_at, lease_expires_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_messaging_deliveries_exception
  ON messaging_deliveries (tenant_id, status, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS messaging_adapter_states (
  tenant_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','whatsapp','teams')),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','degraded','paused','paused_by_breaker','disabled','unconfigured')),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  failure_window_started_at TEXT,
  last_health_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  pause_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, adapter_id)
);

CREATE TABLE IF NOT EXISTS messaging_gateway_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_messaging_gateway_events_tenant
  ON messaging_gateway_events (tenant_id, seq DESC);

CREATE TABLE IF NOT EXISTS messaging_gateway_actions (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('pause','resume')),
  adapter_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
`;

const MESSAGING_DYNAMIC_CHANNEL_MIGRATION = `
CREATE TABLE messaging_inbound_attachments_v55 (
  tenant_id TEXT NOT NULL, inbound_id TEXT NOT NULL, id TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), content BLOB NOT NULL,
  PRIMARY KEY(tenant_id,inbound_id,id)
);
INSERT INTO messaging_inbound_attachments_v55
  SELECT tenant_id,inbound_id,id,descriptor_json,content FROM messaging_inbound_attachments;
DROP TABLE messaging_inbound_attachments;

CREATE TABLE messaging_inbound_messages_v55 (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (
    length(channel) BETWEEN 1 AND 96
    AND channel GLOB '[a-z0-9]*'
    AND channel NOT GLOB '*[^a-z0-9._:-]*'
  ),
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  raw_fingerprint TEXT NOT NULL CHECK (length(raw_fingerprint) = 64),
  status TEXT NOT NULL CHECK (status IN ('received','dispatching','processed','rejected','failed')),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  outcome_code TEXT,
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, channel, adapter_id, provider_message_id)
);
INSERT INTO messaging_inbound_messages_v55 SELECT * FROM messaging_inbound_messages;
DROP TABLE messaging_inbound_messages;
ALTER TABLE messaging_inbound_messages_v55 RENAME TO messaging_inbound_messages;
CREATE INDEX idx_messaging_inbound_claim
  ON messaging_inbound_messages (tenant_id, status, lease_expires_at, received_at, id);

CREATE TABLE messaging_inbound_attachments (
  tenant_id TEXT NOT NULL, inbound_id TEXT NOT NULL, id TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), content BLOB NOT NULL,
  PRIMARY KEY(tenant_id,inbound_id,id),
  FOREIGN KEY(tenant_id,inbound_id) REFERENCES messaging_inbound_messages(tenant_id,id)
);
INSERT INTO messaging_inbound_attachments
  SELECT tenant_id,inbound_id,id,descriptor_json,content FROM messaging_inbound_attachments_v55;
DROP TABLE messaging_inbound_attachments_v55;

CREATE TABLE messaging_deliveries_v55 (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (
    length(channel) BETWEEN 1 AND 96
    AND channel GLOB '[a-z0-9]*'
    AND channel NOT GLOB '*[^a-z0-9._:-]*'
  ),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending','sending','accepted','retry_wait','unknown','failed','abandoned')),
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  external_dispatch_started INTEGER NOT NULL DEFAULT 0 CHECK (external_dispatch_started IN (0,1)),
  provider_message_id TEXT,
  accepted_at TEXT,
  next_attempt_at TEXT,
  error TEXT,
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, adapter_id, idempotency_key)
);
INSERT INTO messaging_deliveries_v55 SELECT * FROM messaging_deliveries;
DROP TABLE messaging_deliveries;
ALTER TABLE messaging_deliveries_v55 RENAME TO messaging_deliveries;
CREATE INDEX idx_messaging_deliveries_claim
  ON messaging_deliveries (tenant_id, adapter_id, status, next_attempt_at, lease_expires_at, created_at, id);
CREATE INDEX idx_messaging_deliveries_exception
  ON messaging_deliveries (tenant_id, status, updated_at DESC, id);

CREATE TABLE messaging_adapter_states_v55 (
  tenant_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (
    length(channel) BETWEEN 1 AND 96
    AND channel GLOB '[a-z0-9]*'
    AND channel NOT GLOB '*[^a-z0-9._:-]*'
  ),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','degraded','paused','paused_by_breaker','disabled','unconfigured')),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  failure_window_started_at TEXT,
  last_health_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  pause_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  configured INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, adapter_id)
);
INSERT INTO messaging_adapter_states_v55 SELECT * FROM messaging_adapter_states;
DROP TABLE messaging_adapter_states;
ALTER TABLE messaging_adapter_states_v55 RENAME TO messaging_adapter_states;
`;

const HERMES_GATEWAY_INTEGRATION_SCHEMA = `
CREATE TABLE hermes_tenant_profiles (
  tenant_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL UNIQUE CHECK (
    length(profile_id) BETWEEN 8 AND 64
    AND profile_id NOT GLOB '*[^a-z0-9-]*'
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE hermes_platform_snapshots (
  tenant_id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  catalog_json TEXT NOT NULL CHECK (json_valid(catalog_json)),
  FOREIGN KEY (tenant_id) REFERENCES hermes_tenant_profiles(tenant_id)
);

CREATE TABLE hermes_bridge_nonces (
  tenant_id TEXT NOT NULL,
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 8 AND 160),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, nonce)
);
CREATE INDEX idx_hermes_bridge_nonces_expiry ON hermes_bridge_nonces (expires_at);

CREATE TABLE hermes_bridge_receipts (
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  inbound_id TEXT,
  delivery_id TEXT,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, request_id)
);

CREATE TABLE hermes_platform_actions (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  platform_id TEXT NOT NULL CHECK (
    length(platform_id) BETWEEN 1 AND 96
    AND platform_id GLOB '[a-z0-9]*'
    AND platform_id NOT GLOB '*[^a-z0-9._:-]*'
  ),
  action TEXT NOT NULL CHECK (action IN ('configure','enable','disable','test','onboarding')),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  configured_fields_json TEXT NOT NULL CHECK (json_valid(configured_fields_json)),
  secret_fingerprints_json TEXT NOT NULL CHECK (json_valid(secret_fingerprints_json)),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
`;

export function runMigrations(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const migrations = [
    { version: 1, name: 'legacy-runtime-schema', sql: LEGACY_SCHEMA },
    { version: 2, name: 'tenant-runtime-and-workforce-control-plane', sql: PLATFORM_SCHEMA },
    { version: 3, name: 'workflow-control-plane', sql: WORKFLOW_CONTROL_SCHEMA },
    { version: 4, name: 'connector-credential-status-and-events', sql: PLATFORM_SCHEMA },
    { version: 5, name: 'procurement-domain-model', sql: PROCUREMENT_SCHEMA },
    { version: 6, name: 'procurement-requisition-idempotency', sql: PROCUREMENT_REQUISITION_IDEMPOTENCY_SCHEMA },
    { version: 7, name: 'side-effect-leases-and-temporal-approval-decisions', sql: PLATFORM_SCHEMA },
    { version: 8, name: 'procurement-rfq-quote-idempotency', sql: PROCUREMENT_CREATE_IDEMPOTENCY_SCHEMA },
    { version: 9, name: 'supplier-sync-idempotency', sql: SUPPLIER_SYNC_IDEMPOTENCY_SCHEMA },
    { version: 10, name: 'procurement-sourcing-decisions', sql: PROCUREMENT_SOURCING_DECISION_SCHEMA },
    { version: 11, name: 'procurement-rfq-open-to-draft', sql: PROCUREMENT_RFQ_OPEN_TO_DRAFT_MIGRATION },
    { version: 12, name: 'procurement-execution-main-chain', sql: PROCUREMENT_EXECUTION_SCHEMA },
    { version: 13, name: 'procurement-outbox-leased-delivery', sql: PROCUREMENT_OUTBOX_DELIVERY_MIGRATION },
    { version: 14, name: 'procurement-inbound-communication-idempotency', sql: PROCUREMENT_INBOUND_COMMUNICATION_SCHEMA },
    { version: 15, name: 'procurement-quote-comparison-revisions', sql: PROCUREMENT_QUOTE_COMPARISON_REVISIONS_MIGRATION },
    { version: 16, name: 'procurement-odoo-import-idempotency', sql: PROCUREMENT_ODOO_SYNC_SCHEMA },
    { version: 17, name: 'procurement-document-agent-queue', sql: PROCUREMENT_DOCUMENT_AGENT_SCHEMA },
    { version: 18, name: 'procurement-attachment-object-storage', sql: PROCUREMENT_ATTACHMENT_OBJECT_STORAGE_MIGRATION },
    { version: 19, name: 'procurement-message-drafts', sql: PROCUREMENT_MESSAGE_DRAFT_SCHEMA },
    { version: 20, name: 'procurement-notifications', sql: PROCUREMENT_NOTIFICATION_SCHEMA },
    { version: 21, name: 'procurement-route-assignments', sql: PROCUREMENT_ROUTE_SCHEMA },
    { version: 22, name: 'procurement-risk-snapshots', sql: PROCUREMENT_RISK_SNAPSHOT_SCHEMA },
    { version: 23, name: 'procurement-sla-control-plane', sql: PROCUREMENT_SLA_SCHEMA },
    { version: 24, name: 'procurement-import-document-gate', sql: PROCUREMENT_IMPORT_DOCUMENT_SCHEMA },
    { version: 25, name: 'procurement-supplier-performance-snapshots', sql: PROCUREMENT_SUPPLIER_PERFORMANCE_SCHEMA },
    { version: 26, name: 'procurement-po-stage-events', sql: PROCUREMENT_PO_STAGE_EVENT_MIGRATION },
    { version: 27, name: 'procurement-sla-automation', sql: PROCUREMENT_SLA_AUTOMATION_SCHEMA },
    { version: 28, name: 'procurement-whatsapp-business-messaging', sql: PROCUREMENT_WHATSAPP_SCHEMA },
    { version: 29, name: 'procurement-inbound-mail-monitor', sql: PROCUREMENT_INBOUND_MAIL_MONITOR_SCHEMA },
    { version: 30, name: 'procurement-inbound-mail-rejections', sql: PROCUREMENT_INBOUND_MAIL_REJECTION_SCHEMA },
    { version: 31, name: 'procurement-email-po-intake', sql: PROCUREMENT_PO_INTAKE_SCHEMA },
    { version: 32, name: 'procurement-inbound-mail-backoff', sql: 'SELECT 1;' },
    { version: 33, name: 'procurement-professional-communication-identity', sql: PROCUREMENT_COMMUNICATION_IDENTITY_SCHEMA },
    { version: 34, name: 'procurement-deployment-profile', sql: PROCUREMENT_DEPLOYMENT_PROFILE_SCHEMA },
    { version: 35, name: 'manufacturing-context-twin', sql: MANUFACTURING_CONTEXT_SCHEMA },
    { version: 36, name: 'procurement-line-projection-generations', sql: 'SELECT 1;' },
    { version: 37, name: 'manufacturing-context-worker-heartbeats', sql: MANUFACTURING_CONTEXT_RUNTIME_SCHEMA },
    { version: 38, name: 'procurement-advanced-sla', sql: PROCUREMENT_ADVANCED_SLA_SCHEMA },
    { version: 39, name: 'procurement-tenant-preferences', sql: PROCUREMENT_TENANT_PREFERENCES_SCHEMA },
    { version: 40, name: 'procurement-po-context-chat', sql: PROCUREMENT_PO_CHAT_SCHEMA },
    { version: 41, name: 'procurement-inbound-mail-rejection-evidence', sql: 'SELECT 1;' },
    { version: 42, name: 'procurement-realtime-event-feed', sql: 'SELECT 1;' },
    { version: 43, name: 'procurement-material-lead-times', sql: PROCUREMENT_MATERIAL_LEAD_TIME_SCHEMA },
    { version: 44, name: 'procurement-route-evidence-documents', sql: PROCUREMENT_ROUTE_EVIDENCE_DOCUMENT_SCHEMA },
    { version: 45, name: 'public-demo-requests', sql: PUBLIC_DEMO_REQUEST_SCHEMA },
    { version: 46, name: 'procurement-general-settings-policies', sql: 'SELECT 1;' },
    { version: 47, name: 'procurement-route-context-chat', sql: PROCUREMENT_ROUTE_CHAT_SCHEMA },
    { version: 48, name: 'procurement-route-chat-attachments', sql: PROCUREMENT_ROUTE_CHAT_ATTACHMENT_MIGRATION },
    { version: 49, name: 'navisight-clean-room-alignment-v2', sql: NAVISIGHT_CLEAN_ROOM_ALIGNMENT_V2_MIGRATION },
    { version: 50, name: 'procurement-material-lead-time-criticality', sql: PROCUREMENT_MATERIAL_LEAD_TIME_CRITICALITY_MIGRATION },
    { version: 51, name: 'procurement-ai-supplier-reply-analysis', sql: PROCUREMENT_AI_REPLY_SCHEMA },
    { version: 52, name: 'procurement-route-assignment-idempotency', sql: PROCUREMENT_ROUTE_ASSIGNMENT_IDEMPOTENCY_SCHEMA },
    { version: 53, name: 'messaging-gateway-boundaries', sql: MESSAGING_GATEWAY_SCHEMA },
    { version: 54, name: 'messaging-durable-inputs-and-lifecycle', sql: `
      CREATE TABLE messaging_inbound_attachments (
        tenant_id TEXT NOT NULL, inbound_id TEXT NOT NULL, id TEXT NOT NULL,
        descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)), content BLOB NOT NULL,
        PRIMARY KEY(tenant_id,inbound_id,id),
        FOREIGN KEY(tenant_id,inbound_id) REFERENCES messaging_inbound_messages(tenant_id,id)
      );
      ALTER TABLE messaging_adapter_states ADD COLUMN started_at TEXT;
      ALTER TABLE messaging_adapter_states ADD COLUMN configured INTEGER NOT NULL DEFAULT 0;
    ` },
    { version: 55, name: 'messaging-dynamic-channel-identifiers', sql: MESSAGING_DYNAMIC_CHANNEL_MIGRATION },
    { version: 56, name: 'hermes-gateway-integration', sql: HERMES_GATEWAY_INTEGRATION_SCHEMA },
  ];
  let applied = 0;
  for (const migration of migrations) {
    const exists = db.prepare('SELECT name FROM schema_migrations WHERE version = ?').get(migration.version) as { name: string } | undefined;
    if (exists) {
      assertMigrationName(migration.version, migration.name, exists.name);
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const afterLock = db.prepare('SELECT name FROM schema_migrations WHERE version = ?').get(migration.version) as { name: string } | undefined;
      if (afterLock) {
        assertMigrationName(migration.version, migration.name, afterLock.name);
        db.exec('COMMIT');
        continue;
      }
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, nowIso());
      db.exec('COMMIT');
      applied += 1;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  assertRecordedCleanRoomV2Schema(db);
  assertRecordedMaterialLeadTimeCriticalitySchema(db);
  ensureColumn(db, 'control_connector_installations', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'control_connector_installations', 'error', 'TEXT');
  ensureColumn(db, 'control_credentials', 'status', "TEXT NOT NULL DEFAULT 'untested'");
  ensureColumn(db, 'control_credentials', 'last_tested_at', 'TEXT');
  ensureColumn(db, 'control_credentials', 'last_error', 'TEXT');
  ensureActionExecutionColumns(db);
  ensureApprovalDecisionColumns(db);
  ensureProcurementColumns(db);
  ensureProcurementAttachmentDocumentColumns(db);
  ensureProcurementOutboxColumns(db);
  ensureProcurementMessageDraftColumns(db);
  ensureProcurementInboundMailBackoffColumns(db);
  ensureProcurementTenantPreferenceColumns(db);
  ensureManufacturingContextSchema(db);
  ensureAdvancedSlaColumnsSerialized(db);
  ensureProcurementRealtimeEventSchema(db);
  return applied;
}

function assertRecordedMaterialLeadTimeCriticalitySchema(db: DatabaseSync): void {
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=50').get()) return;
  const column = (db.prepare('PRAGMA table_info(procurement_material_lead_times)').all() as Array<{
    name: string; type: string; notnull: number; dflt_value: string | null;
  }>).find((entry) => entry.name === 'criticality');
  const sql = tableSql(db, 'procurement_material_lead_times');
  if (!column || column.type !== 'TEXT' || column.notnull !== 1 || column.dflt_value !== "'medium'"
    || !sql.includes("criticalityin('high','medium','low')")) {
    throw new Error('migration 50 schema is missing the constrained procurement_material_lead_times.criticality column');
  }
}

/** Migration 49 is still an unreleased v48→v49 plan migration.  A recorded
 * version is a no-op only after its complete schema is present; silently
 * accepting a partial 49 would make the repository write into a false schema. */
function legacyRecordedCleanRoomV2Validation(db: DatabaseSync): void {
  const recorded = db.prepare('SELECT 1 FROM schema_migrations WHERE version=49').get();
  if (!recorded) return;
  const tables: Readonly<Record<string, readonly string[]>> = {
    procurement_supplier_operating_profiles: ['tenant_id','supplier_id','version','country_code','route','supplier_type','industry','address_json','primary_material_code','primary_material_name','default_lead_time_days','product_criticality','payment_terms','contract_starts_on','contract_ends_on','status','created_at','updated_at'],
    procurement_supplier_operating_profile_events: ['tenant_id','id','supplier_id','version','before_json','after_json','actor_id','reason','source','created_at'],
    procurement_purchase_order_amendments: ['tenant_id','id','po_id','action','source_po_version','normalized_patch_json','state','outbox_id','receipt_reference','idempotency_key','actor_id','reason','created_at','updated_at','applied_at'],
    procurement_purchase_order_amendment_audit: ['tenant_id','id','amendment_id','sequence','from_state','to_state','actor_id','reason','outbox_id','receipt_reference','created_at'],
    procurement_purchase_order_document_requests: ['tenant_id','snapshot_id','po_id','source_po_version','payload_fingerprint','projection_json','generated_by','generated_at','state','owner_token','lease_version','lease_expires_at','last_error','created_at','updated_at'],
    procurement_purchase_order_document_snapshots: ['tenant_id','id','po_id','document_id','snapshot_kind','source_po_version','context_watermark','template_version','content_sha256','object_key','size_bytes','generated_by','generated_at'],
    procurement_route_exports: ['tenant_id','id','route','normalized_filters_json','source_watermark','row_count','content_sha256','size_bytes','object_key','state','created_by','created_at','expires_at','idempotency_key'],
  };
  const sqlByTable = new Map<string, string>();
  for (const [table, expectedColumns] of Object.entries(tables)) {
    const found = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
    if (!found) throw new Error(`migration 49 schema is missing table ${table}`);
    const actual = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((entry) => entry.name);
    if (actual.length !== expectedColumns.length || actual.some((column, index) => column !== expectedColumns[index])) {
      throw new Error(`migration 49 schema has unexpected columns for ${table}`);
    }
    sqlByTable.set(table, compactSchemaSql(found.sql));
  }
  assertMigration49Sql(sqlByTable.get('procurement_supplier_operating_profiles')!, [
    "country_code=''ORcountry_codeGLOB'[A-Z][A-Z]'", "json_valid(address_json)", "json_type(address_json)IN('null','object')",
    "product_criticalityIN('high','medium','low','unclassified')", "date(contract_starts_on)=contract_starts_on", "date(contract_ends_on)=contract_ends_on",
  ], 'procurement_supplier_operating_profiles');
  assertMigration49Sql(sqlByTable.get('procurement_purchase_order_amendments')!, ["stateIN('requested','queued','pending','dispatched','unknown','applied','failed','rejected','cancelled')"], 'procurement_purchase_order_amendments');
  assertMigration49Sql(sqlByTable.get('procurement_purchase_order_amendment_audit')!, ['UNIQUE(tenant_id,amendment_id,sequence)'], 'procurement_purchase_order_amendment_audit');
  assertMigration49Sql(sqlByTable.get('procurement_purchase_order_document_requests')!, [
    'source_po_version>=1', 'length(payload_fingerprint)=64', 'json_valid(projection_json)', "json_type(projection_json)='object'",
    "stateIN('generating','ready','failed')", 'lease_version>=1', 'lease_expires_at>=0',
  ], 'procurement_purchase_order_document_requests');
  assertMigration49Sql(sqlByTable.get('procurement_purchase_order_document_snapshots')!, ["snapshot_kindIN('purchase_order','amendment','cancellation')", "length(content_sha256)=64", 'size_bytes>=0'], 'procurement_purchase_order_document_snapshots');
  assertMigration49Sql(sqlByTable.get('procurement_route_exports')!, ["routeIN('local','import')", 'row_count>=0', 'size_bytes>=0', "stateIN('ready','expired','deleted')"], 'procurement_route_exports');

  const indexes: Readonly<Record<string, readonly string[]>> = {
    idx_procurement_supplier_operating_profiles_route: ['procurement_supplier_operating_profiles', 'tenant_id,route,status,supplier_id'],
    idx_procurement_supplier_operating_profile_events_supplier: ['procurement_supplier_operating_profile_events', 'tenant_id,supplier_id,version,created_at,id'],
    idx_procurement_purchase_order_amendments_po: ['procurement_purchase_order_amendments', 'tenant_id,po_id,created_at,id'],
    idx_procurement_purchase_order_amendment_audit_amendment: ['procurement_purchase_order_amendment_audit', 'tenant_id,amendment_id,sequence'],
    idx_procurement_purchase_order_document_requests_state: ['procurement_purchase_order_document_requests', 'tenant_id,state,lease_expires_at,snapshot_id'],
    idx_procurement_purchase_order_document_snapshots_po: ['procurement_purchase_order_document_snapshots', 'tenant_id,po_id,generated_at,id'],
    idx_procurement_route_exports_created: ['procurement_route_exports', 'tenant_id,created_atdesc,id'],
  };
  for (const [name, [table, columns]] of Object.entries(indexes)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as { sql: string } | undefined;
    if (!row || !compactSchemaSql(row.sql).includes(compactSchemaSql(`ON ${table} (${columns})`))) throw new Error(`migration 49 schema is missing index ${name}`);
  }
  const triggers: Readonly<Record<string, readonly string[]>> = {
    trg_procurement_supplier_operating_profiles_valid_address_insert: ['BEFOREINSERTONprocurement_supplier_operating_profiles', 'invalidsupplieraddress'],
    trg_procurement_supplier_operating_profiles_valid_address_update: ['BEFOREUPDATEOFaddress_jsonONprocurement_supplier_operating_profiles', 'invalidsupplieraddress'],
    trg_procurement_supplier_operating_profile_events_no_update: ['BEFOREUPDATEONprocurement_supplier_operating_profile_events', 'append-only'],
    trg_procurement_supplier_operating_profile_events_no_delete: ['BEFOREDELETEONprocurement_supplier_operating_profile_events', 'append-only'],
    trg_procurement_purchase_order_amendments_request_immutable: ['BEFOREUPDATEONprocurement_purchase_order_amendments', 'immutableamendmentrequest'],
    trg_procurement_purchase_order_amendment_audit_no_update: ['BEFOREUPDATEONprocurement_purchase_order_amendment_audit', 'append-only'],
    trg_procurement_purchase_order_amendment_audit_no_delete: ['BEFOREDELETEONprocurement_purchase_order_amendment_audit', 'append-only'],
    trg_procurement_purchase_order_document_requests_payload_immutable: ['BEFOREUPDATEONprocurement_purchase_order_document_requests', 'immutabledocumentrequest'],
    trg_procurement_purchase_order_document_snapshots_no_update: ['BEFOREUPDATEONprocurement_purchase_order_document_snapshots', 'append-only'],
    trg_procurement_purchase_order_document_snapshots_no_delete: ['BEFOREDELETEONprocurement_purchase_order_document_snapshots', 'append-only'],
  };
  for (const [name, tokens] of Object.entries(triggers)) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined;
    const sql = row ? compactSchemaSql(row.sql) : '';
    if (!row || tokens.some((token) => !sql.includes(compactSchemaSql(token)))) throw new Error(`migration 49 schema is missing trigger ${name}`);
  }
  assertMigration49Column(db, 'procurement_advanced_sla_profiles', 'schema_version', 'INTEGER', 1, '1');
  for (const [name, type, notNull, defaultValue] of [
    ['template_version', 'INTEGER', 1, '1'], ['schema_version', 'INTEGER', 1, '1'], ['domain', 'TEXT', 1, "'global'"],
    ['source_sha256', 'TEXT', 1, "''"], ['total_count', 'INTEGER', 1, '0'], ['valid_count', 'INTEGER', 1, '0'],
    ['invalid_count', 'INTEGER', 1, '0'], ['warning_count', 'INTEGER', 1, '0'], ['candidate_hash', 'TEXT', 1, "''"],
    ['validation_results_json', 'TEXT', 1, "'[]'"], ['validated_at', 'TEXT', 0, null],
  ] as const) assertMigration49Column(db, 'procurement_advanced_sla_import_batches', name, type, notNull, defaultValue);
  const profileSql = tableSql(db, 'procurement_advanced_sla_profiles');
  const importSql = tableSql(db, 'procurement_advanced_sla_import_batches');
  assertMigration49Sql(profileSql, ['schema_versionINTEGERNOTNULLDEFAULT1CHECK(schema_versionIN(1,2))'], 'procurement_advanced_sla_profiles');
  assertMigration49Sql(importSql, ['template_versionINTEGERNOTNULLDEFAULT1CHECK(template_version>=1)', 'schema_versionINTEGERNOTNULLDEFAULT1CHECK(schema_versionIN(1,2))', "domainTEXTNOTNULLDEFAULT'global'CHECK(domainIN('global','production_service_milestones','communication_escalation','payment_terms','logistics_planning','logistics_handover','transit_monitoring','regulatory_import_approval','customs_clearance','quality_inspection_grn'))"], 'procurement_advanced_sla_import_batches');
}

function compactSchemaSql(sql: string): string { return sql.replace(/\s+/g, '').toLowerCase(); }

function tableSql(db: DatabaseSync, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`migration 49 schema is missing table ${table}`);
  return compactSchemaSql(row.sql);
}

function assertMigration49Sql(sql: string, fragments: readonly string[], table: string): void {
  const compact = compactSchemaSql(sql);
  for (const fragment of fragments) if (!compact.includes(compactSchemaSql(fragment))) throw new Error(`migration 49 schema is missing constraint on ${table}`);
}

function assertMigration49Column(db: DatabaseSync, table: string, name: string, type: string, notNull: number, defaultValue: string | null): void {
  const row = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>).find((item) => item.name === name);
  if (!row || row.type !== type || row.notnull !== notNull || row.dflt_value !== defaultValue) throw new Error(`migration 49 schema is missing ${table}.${name}`);
}

const MIGRATION_49_OWNED_OBJECTS = [
  'table:procurement_supplier_operating_profiles', 'table:procurement_supplier_operating_profile_events',
  'table:procurement_purchase_order_amendments', 'table:procurement_purchase_order_amendment_audit',
  'table:procurement_purchase_order_document_requests', 'table:procurement_purchase_order_document_snapshots', 'table:procurement_route_exports',
  'table:procurement_advanced_sla_profiles', 'table:procurement_advanced_sla_import_batches',
  'index:idx_procurement_supplier_operating_profiles_route', 'index:idx_procurement_supplier_operating_profile_events_supplier',
  'index:idx_procurement_purchase_order_amendments_po', 'index:idx_procurement_purchase_order_amendment_audit_amendment',
  'index:idx_procurement_purchase_order_document_requests_state', 'index:idx_procurement_purchase_order_document_snapshots_po', 'index:idx_procurement_route_exports_created',
  'trigger:trg_procurement_supplier_operating_profiles_valid_address_insert', 'trigger:trg_procurement_supplier_operating_profiles_valid_address_update',
  'trigger:trg_procurement_supplier_operating_profile_events_no_update', 'trigger:trg_procurement_supplier_operating_profile_events_no_delete',
  'trigger:trg_procurement_purchase_order_amendments_request_immutable', 'trigger:trg_procurement_purchase_order_amendment_audit_no_update',
  'trigger:trg_procurement_purchase_order_amendment_audit_no_delete', 'trigger:trg_procurement_purchase_order_document_requests_payload_immutable',
  'trigger:trg_procurement_purchase_order_document_snapshots_no_update',
  'trigger:trg_procurement_purchase_order_document_snapshots_no_delete',
] as const;
// Predeployment v48→v49 contract: updating this literal requires a deliberate
// migration-49 manifest review, never a silent acceptance of schema drift.
const MIGRATION_49_SCHEMA_FINGERPRINT = 'd0df0c49d24ca571c288f3536e594211086db773f1620932d030f98df2f4c8ea';

function assertRecordedCleanRoomV2Schema(db: DatabaseSync): void {
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=49').get()) return;
  const rows = db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger')`).all() as Array<{ type: string; name: string; sql: string | null }>;
  const owned = rows.filter((row) => MIGRATION_49_OWNED_OBJECTS.includes(`${row.type}:${row.name}` as typeof MIGRATION_49_OWNED_OBJECTS[number]));
  const names = owned.map((row) => `${row.type}:${row.name}`).sort();
  const expected = [...MIGRATION_49_OWNED_OBJECTS].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`migration 49 schema object set mismatch: expected ${expected.filter((name) => !names.includes(name)).join(',') || 'none'}`);
  }
  if (owned.some((row) => !row.sql)) throw new Error('migration 49 schema has an object without DDL');
  const canonical = owned.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
    .map((row) => `${row.type}:${row.name}\n${row.sql!.replace(/\s+/g, ' ').trim().toLowerCase()}`).join('\n');
  const actual = createHash('sha256').update(canonical).digest('hex');
  if (actual !== MIGRATION_49_SCHEMA_FINGERPRINT) throw new Error(`migration 49 schema fingerprint mismatch: ${actual}`);
}

function assertMigrationName(version: number, expected: string, actual: string): void {
  if (actual !== expected) throw new Error(`migration ${version} name conflict: expected ${expected}, recorded ${actual}`);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    // Two API/worker processes may repair the same legacy SQLite schema after
    // migrations are committed. If the competing process added the exact
    // column first, the desired postcondition is already satisfied; every
    // other ALTER failure must still propagate.
    const afterRace = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (afterRace.some((item) => item.name === column)) return;
    throw error;
  }
}

function ensureProcurementTenantPreferenceColumns(db: DatabaseSync): void {
  ensureColumn(db, 'procurement_tenant_preferences', 'sla_escalations_enabled', 'INTEGER NOT NULL DEFAULT 1 CHECK (sla_escalations_enabled IN (0,1))');
  ensureColumn(db, 'procurement_tenant_preferences', 'exclude_weekends', 'INTEGER NOT NULL DEFAULT 1 CHECK (exclude_weekends IN (0,1))');
  ensureColumn(db, 'procurement_tenant_preferences', 'exclude_public_holidays', 'INTEGER NOT NULL DEFAULT 1 CHECK (exclude_public_holidays IN (0,1))');
  ensureColumn(db, 'procurement_tenant_preferences', 'auto_calculate_lead_time', 'INTEGER NOT NULL DEFAULT 1 CHECK (auto_calculate_lead_time IN (0,1))');
}

function ensureProcurementRealtimeEventSchema(db: DatabaseSync): void {
  db.exec(PROCUREMENT_REALTIME_EVENT_SCHEMA);
}

function ensureAdvancedSlaColumnsSerialized(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    ensureAdvancedSlaColumns(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureAdvancedSlaColumns(db: DatabaseSync): void {
  ensureColumn(db, 'procurement_advanced_sla_profiles', 'description', "TEXT NOT NULL DEFAULT ''");
  const controlVersionMissing = !hasColumn(db, 'procurement_advanced_sla_runtime_controls', 'profile_version');
  const eventVersionMissing = !hasColumn(db, 'procurement_advanced_sla_runtime_events', 'profile_version');
  ensureColumn(db, 'procurement_advanced_sla_runtime_controls', 'profile_version', 'INTEGER');
  ensureColumn(db, 'procurement_advanced_sla_runtime_events', 'profile_version', 'INTEGER');
  repairAdvancedSlaRuntimeProfileVersions(db, controlVersionMissing, eventVersionMissing);
  ensureColumn(db, 'procurement_advanced_sla_import_batches', 'source_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'procurement_advanced_sla_import_batches', 'error_json', 'TEXT');
  ensureColumn(db, 'procurement_advanced_sla_import_batches', 'updated_at', "TEXT NOT NULL DEFAULT ''");
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function repairAdvancedSlaRuntimeProfileVersions(db: DatabaseSync, controlVersionMissing: boolean, eventVersionMissing: boolean): void {
  if (controlVersionMissing || db.prepare(`SELECT 1 FROM procurement_advanced_sla_runtime_controls WHERE profile_version IS NULL OR profile_version IN (0,1) LIMIT 1`).get()) {
    db.exec(`UPDATE procurement_advanced_sla_runtime_controls AS control
      SET profile_version = (
        SELECT CASE profile.status
          WHEN 'published' THEN profile.version
          WHEN 'retired' THEN CASE WHEN profile.version > 1 THEN profile.version - 1 END
        END
        FROM procurement_advanced_sla_profiles AS profile
        WHERE profile.tenant_id=control.tenant_id AND profile.id=control.profile_id
      )
      WHERE (control.profile_version IS NULL OR control.profile_version IN (0,1))
        AND EXISTS (
          SELECT 1 FROM procurement_advanced_sla_profiles AS profile
          WHERE profile.tenant_id=control.tenant_id AND profile.id=control.profile_id
            AND profile.status IN ('published','retired')
        )`);
  }
  if (!eventVersionMissing && !db.prepare(`SELECT 1 FROM procurement_advanced_sla_runtime_events WHERE profile_version IS NULL OR profile_version IN (0,1) LIMIT 1`).get()) return;
  const events = db.prepare(`SELECT tenant_id,id,profile_id,detail_json
    FROM procurement_advanced_sla_runtime_events
    WHERE profile_version IS NULL OR profile_version IN (0,1)`).all() as Array<{ tenant_id: string; id: string; profile_id: string; detail_json: string }>;
  const update = db.prepare(`UPDATE procurement_advanced_sla_runtime_events SET profile_version=? WHERE tenant_id=? AND id=?`);
  const publication = db.prepare(`SELECT detail_json FROM procurement_advanced_sla_profile_events
    WHERE tenant_id=? AND profile_id=? AND action IN ('published','import_applied_published')
    ORDER BY created_at DESC,id DESC LIMIT 1`);
  for (const event of events) {
    let exactVersion: number | null = null;
    try {
      const detail = JSON.parse(event.detail_json) as Record<string, unknown>;
      if (Number.isSafeInteger(detail['profileVersion']) && Number(detail['profileVersion']) >= 1 && (detail['profileId'] === undefined || detail['profileId'] === event.profile_id)) exactVersion = Number(detail['profileVersion']);
    } catch { /* malformed legacy evidence remains explicitly unknown */ }
    if (exactVersion === null) {
      const evidence = publication.get(event.tenant_id, event.profile_id) as { detail_json: string } | undefined;
      if (evidence) {
        try {
          const version = (JSON.parse(evidence.detail_json) as Record<string, unknown>)['version'];
          if (Number.isSafeInteger(version) && Number(version) >= 1) exactVersion = Number(version);
        } catch { /* malformed immutable evidence remains explicitly unknown */ }
      }
    }
    if (exactVersion !== null || eventVersionMissing) update.run(exactVersion, event.tenant_id, event.id);
  }
}

function ensureProcurementColumns(db: DatabaseSync): void {
  ensureColumn(db, 'procurement_documents', 'status', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'procurement_lines', 'projection_generation', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'supplier_sync_idempotency', 'payload_hash', "TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE procurement_documents SET status = COALESCE(json_extract(json, '$.status'), '') WHERE status = ''");
}

function ensureProcurementInboundMailBackoffColumns(db: DatabaseSync): void {
  ensureColumn(db, 'procurement_inbound_mail_status', 'next_poll_at', 'TEXT');
  ensureColumn(db, 'procurement_inbound_mail_status', 'consecutive_failures', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'procurement_inbound_mail_rejections', 'next_attempt_at', 'TEXT');
  ensureColumn(db, 'procurement_inbound_mail_rejections', 'observed_sender', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_procurement_inbound_mail_rejections_due
    ON procurement_inbound_mail_rejections (tenant_id,provider,mailbox,next_attempt_at,provider_uid)`);
}

function ensureProcurementAttachmentDocumentColumns(db: DatabaseSync): void {
  ensureColumn(db, 'procurement_attachments', 'owner_type', "TEXT NOT NULL DEFAULT 'requisition'");
  ensureColumn(db, 'procurement_attachments', 'owner_id', 'TEXT');
  ensureColumn(db, 'procurement_attachment_audit', 'owner_type', "TEXT NOT NULL DEFAULT 'requisition'");
  ensureColumn(db, 'procurement_attachment_audit', 'owner_id', 'TEXT');
  ensureColumn(db, 'procurement_attachments', 'security_status', "TEXT NOT NULL DEFAULT 'pending_scan'");
  ensureColumn(db, 'procurement_attachments', 'processing_status', "TEXT NOT NULL DEFAULT 'not_queued'");
  ensureColumn(db, 'procurement_attachments', 'detected_content_type', 'TEXT');
  ensureColumn(db, 'procurement_attachments', 'scan_error', 'TEXT');
  ensureColumn(db, 'procurement_attachments', 'parse_error', 'TEXT');
  ensureColumn(db, 'procurement_attachments', 'parsed_at', 'TEXT');
  ensureColumn(db, 'procurement_attachments', 'storage_backend', "TEXT NOT NULL DEFAULT 'sqlite'");
  ensureColumn(db, 'procurement_attachments', 'object_key', 'TEXT');
  ensureColumn(db, 'procurement_attachments', 'storage_etag', 'TEXT');
  ensureColumn(db, 'procurement_attachments', 'storage_encryption', 'TEXT');
  // Existing files have not been scanned retroactively.  Do not turn them
  // into "clean" merely because a schema upgrade happened.
  db.exec("UPDATE procurement_attachments SET security_status='pending_scan' WHERE security_status IS NULL OR security_status='' ");
  db.exec("UPDATE procurement_attachments SET processing_status='not_queued' WHERE processing_status IS NULL OR processing_status='' ");
  db.exec("UPDATE procurement_attachments SET storage_backend='sqlite' WHERE storage_backend IS NULL OR storage_backend='' ");
  db.exec("UPDATE procurement_attachments SET owner_type='requisition' WHERE owner_type IS NULL OR owner_type='' ");
  db.exec("UPDATE procurement_attachments SET owner_id=requisition_id WHERE owner_id IS NULL OR owner_id='' ");
  db.exec("UPDATE procurement_attachment_audit SET owner_type='requisition' WHERE owner_type IS NULL OR owner_type='' ");
  db.exec("UPDATE procurement_attachment_audit SET owner_id=requisition_id WHERE owner_id IS NULL OR owner_id='' ");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_procurement_attachments_owner
    ON procurement_attachments (tenant_id,owner_type,owner_id,created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_procurement_attachment_audit_owner
    ON procurement_attachment_audit (tenant_id,owner_type,owner_id,created_at)`);
  db.exec(`CREATE TABLE IF NOT EXISTS procurement_document_jobs (
    tenant_id TEXT NOT NULL, id TEXT NOT NULL, attachment_id TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
    available_at TEXT NOT NULL, locked_at TEXT, lock_token TEXT, lease_expires_at TEXT,
    error TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
    PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, attachment_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_procurement_document_jobs_claim
    ON procurement_document_jobs (tenant_id, status, available_at, lease_expires_at, created_at)`);
  // Retroactively enqueue active legacy files without marking them safe.  The
  // worker will run the same content gate and optional malware scanner used
  // for new uploads before persisting any parse result.
  db.exec(`INSERT OR IGNORE INTO procurement_document_jobs
    (tenant_id,id,attachment_id,status,attempts,max_attempts,available_at,created_at,updated_at)
    SELECT tenant_id,'document-job:backfill:' || id,id,'queued',0,3,created_at,created_at,created_at
    FROM procurement_attachments WHERE status='active' AND processing_status='not_queued'`);
  db.exec(`UPDATE procurement_attachments SET processing_status='queued'
    WHERE status='active' AND processing_status='not_queued'
      AND EXISTS (SELECT 1 FROM procurement_document_jobs j WHERE j.tenant_id=procurement_attachments.tenant_id AND j.attachment_id=procurement_attachments.id)`);
}

function ensureProcurementOutboxColumns(db: DatabaseSync): void {
  ensureColumn(db, 'procurement_outbox', 'attempt', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'procurement_outbox', 'next_attempt_at', 'TEXT');
  ensureColumn(db, 'procurement_outbox', 'lease_owner', 'TEXT');
  ensureColumn(db, 'procurement_outbox', 'lease_token', 'TEXT');
  ensureColumn(db, 'procurement_outbox', 'lease_expires_at', 'TEXT');
  ensureColumn(db, 'procurement_outbox', 'dispatched_at', 'TEXT');
  ensureColumn(db, 'procurement_outbox', 'failed_at', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_procurement_outbox_delivery
    ON procurement_outbox (tenant_id, channel, status, next_attempt_at, lease_expires_at, created_at)`);
}

function ensureProcurementMessageDraftColumns(db: DatabaseSync): void {
  ensureColumn(db, 'procurement_message_drafts', 'channel', "TEXT NOT NULL DEFAULT 'email'");
  ensureColumn(db, 'procurement_message_drafts', 'sender_name', 'TEXT');
  ensureColumn(db, 'procurement_message_drafts', 'sender_title', 'TEXT');
  ensureColumn(db, 'procurement_message_drafts', 'sender_organization', 'TEXT');
}

function ensureActionExecutionColumns(db: DatabaseSync): void {
  ensureColumn(db, 'action_executions', 'lease_expires_at', 'TEXT');
  ensureColumn(db, 'action_executions', 'attempt', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'action_executions', 'updated_at', 'TEXT');
}

function ensureApprovalDecisionColumns(db: DatabaseSync): void {
  ensureColumn(db, 'control_temporal_approval_decisions', 'lease_expires_at', 'TEXT');
}

function migrateLegacyRows(db: DatabaseSync, tenantId: string): void {
  db.prepare('INSERT OR IGNORE INTO runtime_tasks (tenant_id,id,status,employee_id,json,updated_at) SELECT ?,id,status,employee_id,json,updated_at FROM tasks').run(tenantId);
  db.prepare('INSERT OR IGNORE INTO runtime_business_objects (tenant_id,id,type,json,updated_at) SELECT ?,id,type,json,updated_at FROM business_objects').run(tenantId);
  db.prepare('INSERT OR IGNORE INTO runtime_approvals (tenant_id,id,task_id,status,json,updated_at) SELECT ?,id,task_id,status,json,updated_at FROM approvals').run(tenantId);
  const hasEvents = db.prepare('SELECT 1 AS ok FROM runtime_events WHERE tenant_id = ? LIMIT 1').get(tenantId);
  if (!hasEvents) db.prepare('INSERT INTO runtime_events (tenant_id,type,json,at) SELECT ?,type,json,at FROM events ORDER BY seq').run(tenantId);
  db.prepare('INSERT OR IGNORE INTO runtime_budget (tenant_id,employee_id,json,updated_at) SELECT ?,employee_id,json,updated_at FROM budget').run(tenantId);
  db.prepare('INSERT OR IGNORE INTO runtime_exceptions (tenant_id,id,object_id,status,json,updated_at) SELECT ?,id,object_id,status,json,updated_at FROM exceptions').run(tenantId);
  db.prepare('INSERT OR IGNORE INTO runtime_activities (tenant_id,id,object_id,seq,json,updated_at) SELECT ?,id,object_id,seq,json,updated_at FROM activities').run(tenantId);
  db.prepare('INSERT OR IGNORE INTO runtime_org (tenant_id,kind,id,json,updated_at) SELECT ?,kind,id,json,updated_at FROM org').run(tenantId);
}

export function openPersistence(dbPath: string, options: PersistenceOptions = {}): PersistenceStore {
  const db = new DatabaseSync(dbPath);
  // P2 的业务面、控制面和 Worker 会同时打开同一 SQLite 文件。
  // 先设置忙等待，避免并发启动时 WAL 初始化或迁移瞬时争锁直接让进程退出。
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const tenantId = options.tenantId ?? 't:acme';
  migrateLegacyRows(db, tenantId);
  const store: PersistenceStore = {
    db,
    tenantId,
    tasks: new SqliteTaskRepository(db, tenantId),
    objects: new SqliteBusinessObjectRepository(db, tenantId),
    approvals: new SqliteApprovalRepository(db, tenantId),
    events: new SqliteEventRepository(db, tenantId),
    budget: new SqliteBudgetRepository(db, tenantId),
    exceptions: new SqliteExceptionRepository(db, tenantId),
    activities: new SqliteActivityRepository(db, tenantId),
    org: new SqliteOrgRepository(db, tenantId),
    workforce: new SqliteWorkforceRepository(db, tenantId),
    procurement: new SqliteProcurementRepository(db, tenantId),
    close: () => db.close(),
  };
  return store;
}

/** 在共享数据库连接上创建严格按租户过滤的采购仓储。 */
export function createProcurementRepository(db: DatabaseSync, tenantId: string): ProcurementRepository {
  return new SqliteProcurementRepository(db, tenantId);
}

// ---------------------------------------------------------------- 仓储实现

class SqliteTaskRepository implements TaskRepository {
  private cache = new Map<EntityId, Task>();

  constructor(private db: DatabaseSync, private tenantId: string) {}

  get(id: EntityId): Task | undefined {
    if (this.cache.has(id)) return this.cache.get(id);
    const row = this.db.prepare('SELECT json FROM runtime_tasks WHERE tenant_id = ? AND id = ?').get(this.tenantId, id) as { json: string } | undefined;
    if (!row) return undefined;
    const t = JSON.parse(row.json) as Task;
    this.cache.set(id, t);
    return t;
  }

  list(status?: TaskStatus): Task[] {
    // 先把 DB 里尚未缓存的实例载入（不覆盖已缓存的活跃对象）
    const rows = this.db.prepare('SELECT json FROM runtime_tasks WHERE tenant_id = ?').all(this.tenantId) as { json: string }[];
    for (const r of rows) {
      const t = JSON.parse(r.json) as Task;
      if (!this.cache.has(t.id)) this.cache.set(t.id, t);
    }
    const all = [...this.cache.values()];
    return status ? all.filter((t) => t.status === status) : all;
  }

  save(task: Task): void {
    this.cache.set(task.id, task);
    this.db
      .prepare('INSERT INTO runtime_tasks (tenant_id, id, status, employee_id, json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET status = excluded.status, employee_id = excluded.employee_id, json = excluded.json, updated_at = excluded.updated_at')
      .run(this.tenantId, task.id, task.status, task.employeeId, JSON.stringify(task), nowIso());
  }
}

class SqliteBusinessObjectRepository implements BusinessObjectRepository {
  private cache = new Map<EntityId, BusinessObject>();

  constructor(private db: DatabaseSync, private tenantId: string) {}

  get(id: EntityId): BusinessObject | undefined {
    if (this.cache.has(id)) return this.cache.get(id);
    const row = this.db.prepare('SELECT json FROM runtime_business_objects WHERE tenant_id = ? AND id = ?').get(this.tenantId, id) as { json: string } | undefined;
    if (!row) return undefined;
    const bo = JSON.parse(row.json) as BusinessObject;
    this.cache.set(id, bo);
    return bo;
  }

  list(type?: string): BusinessObject[] {
    const rows = this.db.prepare('SELECT json FROM runtime_business_objects WHERE tenant_id = ?').all(this.tenantId) as { json: string }[];
    for (const r of rows) {
      const bo = JSON.parse(r.json) as BusinessObject;
      if (!this.cache.has(bo.id)) this.cache.set(bo.id, bo);
    }
    const all = [...this.cache.values()];
    return type ? all.filter((b) => b.type === type) : all;
  }

  save(bo: BusinessObject): void {
    this.cache.set(bo.id, bo);
    this.db
      .prepare('INSERT INTO runtime_business_objects (tenant_id, id, type, json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET type = excluded.type, json = excluded.json, updated_at = excluded.updated_at')
      .run(this.tenantId, bo.id, bo.type, JSON.stringify(bo), bo.updatedAt);
  }
}

class SqliteApprovalRepository implements ApprovalRepository {
  private cache = new Map<EntityId, ApprovalRequest>();

  constructor(private db: DatabaseSync, private tenantId: string) {}

  get(id: EntityId): ApprovalRequest | undefined {
    if (this.cache.has(id)) return this.cache.get(id);
    const row = this.db.prepare('SELECT json FROM runtime_approvals WHERE tenant_id = ? AND id = ?').get(this.tenantId, id) as { json: string } | undefined;
    if (!row) return undefined;
    const req = JSON.parse(row.json) as ApprovalRequest;
    this.cache.set(id, req);
    return req;
  }

  listByTask(taskId: EntityId): ApprovalRequest[] {
    this.warmCache();
    return [...this.cache.values()].filter((r) => r.taskId === taskId);
  }

  listPending(): ApprovalRequest[] {
    this.warmCache();
    return [...this.cache.values()].filter((r) => r.status === 'pending');
  }

  private warmCache(): void {
    const rows = this.db.prepare('SELECT json FROM runtime_approvals WHERE tenant_id = ?').all(this.tenantId) as { json: string }[];
    for (const r of rows) {
      const req = JSON.parse(r.json) as ApprovalRequest;
      if (!this.cache.has(req.id)) this.cache.set(req.id, req);
    }
  }

  save(req: ApprovalRequest): void {
    this.cache.set(req.id, req);
    this.db
      .prepare('INSERT INTO runtime_approvals (tenant_id, id, task_id, status, json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET task_id = excluded.task_id, status = excluded.status, json = excluded.json, updated_at = excluded.updated_at')
      .run(this.tenantId, req.id, req.taskId, req.status, JSON.stringify(req), req.decidedAt ?? req.requestedAt);
  }
}

class SqliteEventRepository implements EventRepository {
  constructor(private db: DatabaseSync, private tenantId: string) {}

  append(e: DomainEvent): void {
    this.db.prepare('INSERT INTO runtime_events (tenant_id, type, json, at) VALUES (?, ?, ?, ?)').run(this.tenantId, e.type, JSON.stringify(e), e.at);
  }

  list(limit?: number): DomainEvent[] {
    const sql = limit === undefined ? 'SELECT json FROM runtime_events WHERE tenant_id = ? ORDER BY seq' : 'SELECT json FROM runtime_events WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?';
    const rows = (limit === undefined ? this.db.prepare(sql).all(this.tenantId) : this.db.prepare(sql).all(this.tenantId, limit)) as { json: string }[];
    const events = rows.map((r) => JSON.parse(r.json) as DomainEvent);
    return limit === undefined ? events : events.reverse();
  }
}

class SqliteBudgetRepository implements BudgetRepository {
  constructor(private db: DatabaseSync, private tenantId: string) {}

  get(employeeId: EntityId): BudgetState | undefined {
    const row = this.db.prepare('SELECT json FROM runtime_budget WHERE tenant_id = ? AND employee_id = ?').get(this.tenantId, employeeId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as BudgetState) : undefined;
  }

  save(state: BudgetState): void {
    this.db
      .prepare('INSERT INTO runtime_budget (tenant_id, employee_id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, employee_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(this.tenantId, state.employeeId, JSON.stringify(state), nowIso());
  }
}

class SqliteExceptionRepository implements ExceptionRepository {
  private cache = new Map<EntityId, Exception>();

  constructor(private db: DatabaseSync, private tenantId: string) {}

  get(id: EntityId): Exception | undefined {
    if (this.cache.has(id)) return this.cache.get(id);
    const row = this.db.prepare('SELECT json FROM runtime_exceptions WHERE tenant_id = ? AND id = ?').get(this.tenantId, id) as { json: string } | undefined;
    if (!row) return undefined;
    const e = JSON.parse(row.json) as Exception;
    this.cache.set(id, e);
    return e;
  }

  list(): Exception[] {
    const rows = this.db.prepare('SELECT json FROM runtime_exceptions WHERE tenant_id = ?').all(this.tenantId) as { json: string }[];
    for (const r of rows) {
      const e = JSON.parse(r.json) as Exception;
      if (!this.cache.has(e.id)) this.cache.set(e.id, e);
    }
    return [...this.cache.values()];
  }

  save(exc: Exception): void {
    this.cache.set(exc.id, exc);
    this.db
      .prepare('INSERT INTO runtime_exceptions (tenant_id, id, object_id, status, json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET object_id = excluded.object_id, status = excluded.status, json = excluded.json, updated_at = excluded.updated_at')
      .run(this.tenantId, exc.id, exc.objectId, exc.status, JSON.stringify(exc), nowIso());
  }
}

class SqliteActivityRepository implements ActivityRepository {
  constructor(private db: DatabaseSync, private tenantId: string) {}

  append(a: Activity): void {
    this.db.prepare('INSERT INTO runtime_activities (tenant_id, id, object_id, json, updated_at) VALUES (?, ?, ?, ?, ?)').run(this.tenantId, a.id, a.objectId ?? null, JSON.stringify(a), nowIso());
  }

  list(objectId?: EntityId, limit?: number): Activity[] {
    const sql = objectId
      ? (limit === undefined ? 'SELECT json FROM runtime_activities WHERE tenant_id = ? AND object_id = ? ORDER BY seq, rowid' : 'SELECT json FROM runtime_activities WHERE tenant_id = ? AND object_id = ? ORDER BY rowid DESC LIMIT ?')
      : (limit === undefined ? 'SELECT json FROM runtime_activities WHERE tenant_id = ? ORDER BY seq, rowid' : 'SELECT json FROM runtime_activities WHERE tenant_id = ? ORDER BY rowid DESC LIMIT ?');
    const args = objectId ? (limit === undefined ? [this.tenantId, objectId] : [this.tenantId, objectId, limit]) : (limit === undefined ? [this.tenantId] : [this.tenantId, limit]);
    const rows = this.db.prepare(sql).all(...args) as { json: string }[];
    const list = rows.map((r) => JSON.parse(r.json) as Activity);
    return limit === undefined ? list : list.reverse();
  }
}

const LINE_DOCUMENT_KIND: Record<ProcurementLineKind, ProcurementDocumentKind> = {
  requisition_line: 'requisition',
  rfq_line: 'rfq',
  quote_line: 'quote',
  award_line: 'award',
  purchase_order_line: 'purchase_order',
  confirmation_line: 'confirmation',
  production_progress_line: 'production_progress',
  shipment_line: 'shipment',
  receipt_line: 'receipt',
  invoice_line: 'invoice',
  match_line: 'match',
};

const LINE_PARENT_FIELD: Record<ProcurementLineKind, string> = {
  requisition_line: 'requisitionId',
  rfq_line: 'rfqId',
  quote_line: 'quoteId',
  award_line: 'awardId',
  purchase_order_line: 'poId',
  confirmation_line: 'confirmationId',
  production_progress_line: 'progressId',
  shipment_line: 'shipmentId',
  receipt_line: 'receiptId',
  invoice_line: 'invoiceId',
  match_line: 'matchId',
};

class SqliteProcurementRepository implements ProcurementRepository {
  constructor(private db: DatabaseSync, private tenantId: string) {}

  private enqueueDocumentProjection(kind: ProcurementDocumentKind, document: ProcurementDocument, version: number): void {
    enqueueTwinProjectionInCurrentTransaction(this.db, {
      tenantId: this.tenantId,
      sourceTable: 'procurement_documents',
      sourceKey: `${kind}:${document.id}`,
      sourceRevision: String(version),
      eventType: `${kind}.changed`,
      payloadHash: twinProjectionPayloadHash(document),
      availableAt: document.updatedAt,
    });
  }

  private enqueueLineProjection(kind: ProcurementLineKind, line: ProcurementLine, availableAt: string, generation = 1): void {
    const payloadHash = twinProjectionPayloadHash(line);
    enqueueTwinProjectionInCurrentTransaction(this.db, {
      tenantId: this.tenantId,
      sourceTable: 'procurement_lines',
      sourceKey: `${kind}:${line.id}`,
      sourceRevision: String(generation),
      eventType: `${kind}.changed`,
      payloadHash,
      availableAt,
    });
  }

  private enqueueOutboxProjection(outbox: ProcurementOutboxMessage): void {
    const payloadHash = twinProjectionPayloadHash(outbox);
    enqueueTwinProjectionInCurrentTransaction(this.db, {
      tenantId: this.tenantId,
      sourceTable: 'procurement_outbox',
      sourceKey: outbox.id,
      sourceRevision: payloadHash,
      eventType: 'procurement_outbox.changed',
      payloadHash,
      availableAt: outbox.updatedAt,
    });
  }

  enqueueDocumentJob(input: EnqueueProcurementDocumentJobInput): ProcurementDocumentJob {
    const id = input.id ?? `document-job:${randomUUID()}`;
    const at = input.availableAt ?? nowIso();
    const maxAttempts = input.maxAttempts ?? 3;
    if (!input.attachmentId) throw new ProcurementValidationError('INVALID_INPUT', '文档任务必须关联附件');
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new ProcurementValidationError('INVALID_INPUT', 'maxAttempts 必须为正整数');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const attachment = this.db.prepare(`SELECT id FROM procurement_attachments WHERE tenant_id=? AND id=?`)
        .get(this.tenantId, input.attachmentId) as { id: string } | undefined;
      if (!attachment) throw new ProcurementValidationError('INVALID_INPUT', '附件不存在或不属于当前租户');
      const existing = this.db.prepare(`SELECT * FROM procurement_document_jobs WHERE tenant_id=? AND attachment_id=?`)
        .get(this.tenantId, input.attachmentId) as DocumentJobRow | undefined;
      if (existing) {
        this.db.exec('COMMIT');
        return documentJobFromRow(existing);
      }
      this.db.prepare(`INSERT INTO procurement_document_jobs
        (tenant_id,id,attachment_id,status,attempts,max_attempts,available_at,created_at,updated_at)
        VALUES (?,?,?,'queued',0,?,?,?,?)`)
        .run(this.tenantId, id, input.attachmentId, maxAttempts, at, at, at);
      this.db.prepare(`UPDATE procurement_attachments SET processing_status='queued',parse_error=NULL
        WHERE tenant_id=? AND id=?`).run(this.tenantId, input.attachmentId);
      const row = this.db.prepare(`SELECT * FROM procurement_document_jobs WHERE tenant_id=? AND id=?`)
        .get(this.tenantId, id) as unknown as DocumentJobRow;
      this.db.exec('COMMIT');
      return documentJobFromRow(row);
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  getDocumentJob(id: EntityId): ProcurementDocumentJob | undefined {
    const row = this.db.prepare(`SELECT * FROM procurement_document_jobs WHERE tenant_id=? AND id=?`)
      .get(this.tenantId, id) as DocumentJobRow | undefined;
    return row ? documentJobFromRow(row) : undefined;
  }

  listDocumentJobs(status?: ProcurementDocumentJob['status']): ProcurementDocumentJob[] {
    const rows = (status === undefined
      ? this.db.prepare(`SELECT * FROM procurement_document_jobs WHERE tenant_id=? ORDER BY created_at,id`).all(this.tenantId)
      : this.db.prepare(`SELECT * FROM procurement_document_jobs WHERE tenant_id=? AND status=? ORDER BY created_at,id`).all(this.tenantId, status)) as unknown as DocumentJobRow[];
    return rows.map(documentJobFromRow);
  }

  claimDocumentJobs(input: ClaimProcurementDocumentJobsInput): ProcurementDocumentJob[] {
    const limit = input.limit ?? 10;
    if (!input.workerId || !Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new ProcurementValidationError('INVALID_INPUT', '文档任务领取参数无效');
    }
    const leaseExpiresAt = new Date(new Date(input.claimedAt).getTime() + input.leaseDurationMs).toISOString();
    if (Number.isNaN(Date.parse(leaseExpiresAt))) throw new ProcurementValidationError('INVALID_INPUT', 'claimedAt 必须是 ISO 时间');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const candidates = this.db.prepare(`SELECT id FROM procurement_document_jobs
        WHERE tenant_id=? AND attempts < max_attempts AND (
          (status='queued' AND available_at<=?) OR (status='processing' AND lease_expires_at<=?)
        ) ORDER BY available_at,created_at,id LIMIT ?`).all(this.tenantId, input.claimedAt, input.claimedAt, limit) as Array<{ id: string }>;
      const claimed: ProcurementDocumentJob[] = [];
      for (const candidate of candidates) {
        const token = `document-job-lease:${randomUUID()}`;
        const changed = this.db.prepare(`UPDATE procurement_document_jobs
          SET status='processing',attempts=attempts+1,locked_at=?,lock_token=?,lease_expires_at=?,updated_at=?,error=NULL
          WHERE tenant_id=? AND id=? AND attempts<max_attempts AND (
            (status='queued' AND available_at<=?) OR (status='processing' AND lease_expires_at<=?)
          )`).run(input.claimedAt, token, leaseExpiresAt, input.claimedAt, this.tenantId, candidate.id, input.claimedAt, input.claimedAt);
        if (Number(changed.changes) !== 1) continue;
        this.db.prepare(`UPDATE procurement_attachments SET processing_status='processing' WHERE tenant_id=? AND id=(SELECT attachment_id FROM procurement_document_jobs WHERE tenant_id=? AND id=?)`)
          .run(this.tenantId, this.tenantId, candidate.id);
        const row = this.db.prepare(`SELECT * FROM procurement_document_jobs WHERE tenant_id=? AND id=?`).get(this.tenantId, candidate.id) as unknown as DocumentJobRow;
        claimed.push(documentJobFromRow(row));
      }
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  completeDocumentJob(input: CompleteProcurementDocumentJobInput): ProcurementDocumentJob {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.documentJobRowOrThrow(input.id);
      if (current.status === 'completed' && current.lock_token === input.lockToken) {
        this.db.exec('COMMIT'); return documentJobFromRow(current);
      }
      if (current.status !== 'processing' || current.lock_token !== input.lockToken) throw new ProcurementDocumentJobLeaseConflictError(input.id);
      this.db.prepare(`UPDATE procurement_document_jobs SET status='completed',result_json=?,error=NULL,completed_at=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='processing' AND lock_token=?`)
        .run(input.result === undefined ? null : JSON.stringify(input.result), input.completedAt, input.completedAt, this.tenantId, input.id, input.lockToken);
      this.db.prepare(`UPDATE procurement_attachments SET processing_status='parsed',parse_error=NULL,parsed_at=?,
        detected_content_type=COALESCE(?,detected_content_type),extracted_text_preview=COALESCE(?,extracted_text_preview)
        WHERE tenant_id=? AND id=?`).run(input.completedAt, input.detectedContentType ?? null, input.extractedTextPreview ?? null, this.tenantId, current.attachment_id);
      const row = this.documentJobRowOrThrow(input.id);
      this.db.exec('COMMIT'); return documentJobFromRow(row);
    } catch (error) { rollback(this.db); throw error; }
  }

  failDocumentJob(input: FailProcurementDocumentJobInput): ProcurementDocumentJob {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.documentJobRowOrThrow(input.id);
      if (current.status !== 'processing' || current.lock_token !== input.lockToken) throw new ProcurementDocumentJobLeaseConflictError(input.id);
      const shouldRetry = input.retry !== false && current.attempts < current.max_attempts;
      const status = shouldRetry ? 'queued' : 'failed';
      const availableAt = shouldRetry ? (input.retryAt ?? input.failedAt) : current.available_at;
      this.db.prepare(`UPDATE procurement_document_jobs SET status=?,available_at=?,locked_at=NULL,lock_token=NULL,lease_expires_at=NULL,error=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='processing' AND lock_token=?`)
        .run(status, availableAt, input.error, input.failedAt, this.tenantId, input.id, input.lockToken);
      this.db.prepare(`UPDATE procurement_attachments SET processing_status=?,parse_error=? WHERE tenant_id=? AND id=?`)
        .run(shouldRetry ? 'queued' : 'parse_failed', input.error, this.tenantId, current.attachment_id);
      const row = this.documentJobRowOrThrow(input.id);
      this.db.exec('COMMIT'); return documentJobFromRow(row);
    } catch (error) { rollback(this.db); throw error; }
  }

  private documentJobRowOrThrow(id: EntityId): DocumentJobRow {
    const row = this.db.prepare(`SELECT * FROM procurement_document_jobs WHERE tenant_id=? AND id=?`).get(this.tenantId, id) as DocumentJobRow | undefined;
    if (!row) throw new ProcurementValidationError('INVALID_INPUT', '文档任务不存在或不属于当前租户');
    return row;
  }

  saveDocument<T extends ProcurementDocument>(
    kind: ProcurementDocumentKind,
    document: T,
    expectedVersion = 0,
  ): VersionedProcurementDocument<T> {
    if (document.tenantId !== this.tenantId) throw new Error('采购单据与仓储租户不一致');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('expectedVersion 必须是非负整数');
    if (kind === 'quote_comparison') {
      throw new ProcurementValidationError('INVALID_INPUT', '报价比较快照只能由 persistQuoteComparison 原子创建');
    }
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db
        .prepare('SELECT version FROM procurement_documents WHERE tenant_id = ? AND kind = ? AND id = ?')
        .get(this.tenantId, kind, document.id) as { version: number } | undefined;
      if (!current) {
        if (expectedVersion !== 0) throw new Error(`采购单据版本冲突: expected=${expectedVersion}, actual=0`);
        this.db.prepare(`
          INSERT INTO procurement_documents
            (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(this.tenantId, kind, document.id, document.sourceSystem, document.externalId, document.status, 1, JSON.stringify(document), document.createdAt, document.updatedAt);
        this.enqueueDocumentProjection(kind, document, 1);
        if (kind === 'purchase_order') this.recordObservedPurchaseOrderStatus(document as unknown as PurchaseOrder, 1);
        if (ownsTransaction) this.db.exec('COMMIT');
        return { document, version: 1 };
      }
      if (current.version !== expectedVersion) throw new Error(`采购单据版本冲突: expected=${expectedVersion}, actual=${current.version}`);
      const nextVersion = current.version + 1;
      const changed = this.db.prepare(`
        UPDATE procurement_documents
        SET source_system=?, external_id=?, status=?, version=?, json=?, updated_at=?
        WHERE tenant_id=? AND kind=? AND id=? AND version=?
      `).run(document.sourceSystem, document.externalId, document.status, nextVersion, JSON.stringify(document), document.updatedAt, this.tenantId, kind, document.id, current.version);
      if (Number(changed.changes) !== 1) throw new Error('采购单据版本并发更新冲突');
      this.enqueueDocumentProjection(kind, document, nextVersion);
      if (kind === 'purchase_order') this.recordObservedPurchaseOrderStatus(document as unknown as PurchaseOrder, nextVersion);
      if (ownsTransaction) this.db.exec('COMMIT');
      return { document, version: nextVersion };
    } catch (error) {
      if (ownsTransaction) rollback(this.db);
      throw error;
    }
  }

  getDocument<T extends ProcurementDocument = ProcurementDocument>(
    kind: ProcurementDocumentKind,
    id: EntityId,
  ): VersionedProcurementDocument<T> | undefined {
    const row = this.db
      .prepare('SELECT version,json FROM procurement_documents WHERE tenant_id=? AND kind=? AND id=?')
      .get(this.tenantId, kind, id) as { version: number; json: string } | undefined;
    return row ? { document: JSON.parse(row.json) as T, version: row.version } : undefined;
  }

  listDocuments<T extends ProcurementDocument = ProcurementDocument>(kind: ProcurementDocumentKind): VersionedProcurementDocument<T>[] {
    return (this.db
      .prepare('SELECT version,json FROM procurement_documents WHERE tenant_id=? AND kind=? ORDER BY created_at DESC,id')
      .all(this.tenantId, kind) as Array<{ version: number; json: string }>).map((row) => ({
        document: JSON.parse(row.json) as T,
        version: row.version,
      }));
  }

  getSupplierSyncResult(idempotencyKey: string, payloadHash: string): SupplierSyncResult | undefined {
    if (!idempotencyKey) throw new Error('供应商同步幂等键不能为空');
    if (!payloadHash) throw new Error('供应商同步载荷摘要不能为空');
    const row = this.db.prepare(`
      SELECT payload_hash,response_json FROM supplier_sync_idempotency
      WHERE tenant_id=? AND idempotency_key=?
    `).get(this.tenantId, idempotencyKey) as { payload_hash: string; response_json: string } | undefined;
    if (!row) return undefined;
    if (row.payload_hash !== payloadHash) throw new SupplierSyncIdempotencyConflictError(idempotencyKey);
    return JSON.parse(row.response_json) as SupplierSyncResult;
  }

  syncSuppliersIdempotent(input: IdempotentSupplierSync): SupplierSyncResult {
    const { idempotencyKey, payloadHash, suppliers, issues, completedAt } = input;
    if (!idempotencyKey) throw new Error('供应商同步幂等键不能为空');
    if (!payloadHash) throw new Error('供应商同步载荷摘要不能为空');
    for (const supplier of suppliers) {
      if (supplier.tenantId !== this.tenantId) throw new Error('供应商与仓储租户不一致');
      if (!supplier.id || !supplier.sourceSystem.trim() || !supplier.externalId.trim()) throw new Error('供应商外部标识无效');
    }

    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const replay = this.getSupplierSyncResult(idempotencyKey, payloadHash);
      if (replay) {
        if (ownsTransaction) this.db.exec('COMMIT');
        return replay;
      }

      let created = 0;
      let updated = 0;
      let unchanged = 0;
      const items: SupplierSyncItem[] = [];
      for (const candidate of suppliers) {
        let stored = this.findSupplier(candidate);
        if (!stored) {
          try {
            this.db.prepare(`
              INSERT INTO procurement_documents
                (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
              VALUES (?,'supplier',?,?,?,?,1,?,?,?)
            `).run(
              this.tenantId, candidate.id, candidate.sourceSystem, candidate.externalId,
              candidate.status, JSON.stringify(candidate), candidate.createdAt, candidate.updatedAt,
            );
            stored = { document: candidate, version: 1 };
            this.enqueueDocumentProjection('supplier', candidate, 1);
            created += 1;
          } catch (error) {
            if (!(error instanceof Error) || !/UNIQUE constraint failed: procurement_documents/.test(error.message)) throw error;
            stored = this.findSupplier(candidate);
            if (!stored) throw error;
          }
        }

        if (stored.version !== 1 || stored.document !== candidate) {
          const document: Supplier = {
            ...candidate,
            id: stored.document.id,
            tenantId: this.tenantId,
            createdAt: stored.document.createdAt,
          };
          if (sameSupplierContent(stored.document, document)) {
            unchanged += 1;
          } else {
            const nextVersion = stored.version + 1;
            const changed = this.db.prepare(`
              UPDATE procurement_documents
              SET source_system=?,external_id=?,status=?,version=?,json=?,updated_at=?
              WHERE tenant_id=? AND kind='supplier' AND id=? AND version=?
            `).run(
              document.sourceSystem, document.externalId, document.status, nextVersion,
              JSON.stringify(document), document.updatedAt, this.tenantId, document.id, stored.version,
            );
            if (Number(changed.changes) !== 1) throw new Error('供应商版本并发更新冲突');
            stored = { document, version: nextVersion };
            this.enqueueDocumentProjection('supplier', document, nextVersion);
            updated += 1;
          }
        }
        items.push(supplierSyncItem(stored));
      }

      const result: SupplierSyncResult = { created, updated, unchanged, issues: [...issues], items };
      this.db.prepare(`
        INSERT INTO supplier_sync_idempotency
          (tenant_id,idempotency_key,payload_hash,response_json,created_at)
        VALUES (?,?,?,?,?)
      `).run(this.tenantId, idempotencyKey, payloadHash, JSON.stringify(result), completedAt);
      if (ownsTransaction) this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (ownsTransaction) rollback(this.db);
      throw error;
    }
  }

  private findSupplier(candidate: Supplier): VersionedProcurementDocument<Supplier> | undefined {
    const external = this.db.prepare(`
      SELECT version,json FROM procurement_documents
      WHERE tenant_id=? AND kind='supplier' AND source_system=? AND external_id=?
    `).get(this.tenantId, candidate.sourceSystem, candidate.externalId) as { version: number; json: string } | undefined;
    const row = external ?? this.db.prepare(`
      SELECT version,json FROM procurement_documents
      WHERE tenant_id=? AND kind='supplier' AND id=?
    `).get(this.tenantId, candidate.id) as { version: number; json: string } | undefined;
    return row ? { document: JSON.parse(row.json) as Supplier, version: row.version } : undefined;
  }

  persistInboundCommunicationIdempotent(input: IdempotentInboundCommunication): IdempotentInboundCommunicationResult {
    const { communication, payloadHash } = input;
    if (communication.tenantId !== this.tenantId) throw new Error('入站通讯与仓储租户不一致');
    if (!payloadHash.trim()) throw new Error('入站通讯载荷摘要不能为空');
    if (communication.direction !== 'inbound' || communication.channel !== 'email') throw new Error('入站邮件必须为 email/inbound');
    if (!['rfq', 'purchase_order'].includes(communication.businessObjectType) || !communication.businessObjectId.trim()) {
      throw new Error('入站邮件必须关联 RFQ 或采购订单');
    }
    if (!communication.supplierId?.trim()) throw new Error('入站邮件必须关联供应商');

    const provider = communication.provider?.trim() ?? '';
    const mailbox = communication.mailbox?.trim() ?? '';
    const providerUid = communication.uid?.trim() ?? '';
    const messageId = communication.messageId?.trim() ?? '';
    const anyProviderIdentity = Boolean(provider || mailbox || providerUid);
    const completeProviderIdentity = Boolean(provider && mailbox && providerUid);
    if (anyProviderIdentity && !completeProviderIdentity) throw new Error('provider、mailbox 与 uid 必须同时提供');
    if (!completeProviderIdentity && !messageId) throw new Error('入站邮件必须提供 provider/mailbox/uid 或 messageId');

    type IdentityRow = { communication_id: string; payload_hash: string };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const identities: IdentityRow[] = [];
      if (completeProviderIdentity) {
        const row = this.db.prepare(`SELECT communication_id,payload_hash
          FROM procurement_inbound_communication_identities
          WHERE tenant_id=? AND provider=? AND mailbox=? AND provider_uid=?`)
          .get(this.tenantId, provider, mailbox, providerUid) as IdentityRow | undefined;
        if (row) identities.push(row);
      }
      if (messageId) {
        const row = this.db.prepare(`SELECT communication_id,payload_hash
          FROM procurement_inbound_communication_identities
          WHERE tenant_id=? AND message_id=?`)
          .get(this.tenantId, messageId) as IdentityRow | undefined;
        if (row) identities.push(row);
      }
      if (identities.length > 0) {
        const communicationIds = new Set(identities.map((row) => row.communication_id));
        if (communicationIds.size !== 1 || identities.some((row) => row.payload_hash !== payloadHash)) {
          throw new ProcurementInboundCommunicationIdempotencyConflictError();
        }
        const communicationId = identities[0]!.communication_id;
        const stored = this.db.prepare(`SELECT version,json FROM procurement_documents
          WHERE tenant_id=? AND kind='communication' AND id=?`)
          .get(this.tenantId, communicationId) as { version: number; json: string } | undefined;
        if (!stored) throw new Error('入站邮件幂等记录引用的通讯不存在');
        let document = JSON.parse(stored.json) as Communication;
        let version = stored.version;
        // Matching provider identity and immutable payload prove this provenance;
        // preserve any earlier direct origin instead of replacing it on replay.
        if (communication.gatewayInboundId && !document.gatewayInboundId) {
          document = { ...document, gatewayInboundId: communication.gatewayInboundId };
          version += 1;
          this.db.prepare(`UPDATE procurement_documents SET json=?,version=? WHERE tenant_id=? AND kind='communication' AND id=?`)
            .run(JSON.stringify(document),version,this.tenantId,communicationId);
          this.enqueueDocumentProjection('communication',document,version);
        }
        this.db.exec('COMMIT');
        return { communication: { document, version }, replayed: true };
      }

      const supplier = this.getDocument<Supplier>('supplier', communication.supplierId);
      if (!supplier) throw new ProcurementValidationError('SUPPLIER_NOT_FOUND', '供应商不存在');
      if (communication.businessObjectType === 'rfq') {
        const rfq = this.getDocument<RequestForQuotation>('rfq', communication.businessObjectId);
        if (!rfq) throw new ProcurementValidationError('RFQ_NOT_FOUND', 'RFQ 不存在');
        if (!rfq.document.supplierIds.includes(communication.supplierId)) {
          throw new ProcurementValidationError('SUPPLIER_NOT_CANDIDATE', '供应商不在该 RFQ 候选范围内');
        }
      } else {
        const po = this.getDocument<PurchaseOrder>('purchase_order', communication.businessObjectId);
        if (!po) throw new ProcurementValidationError('PO_NOT_FOUND', '采购订单不存在');
        if (po.document.supplierId !== communication.supplierId) {
          throw new ProcurementValidationError('SUPPLIER_PO_MISMATCH', '供应商不是该采购订单的交易方');
        }
      }
      const fromEmail = inboundEmailAddress(communication.from ?? '');
      const supplierEmails = new Set(supplier.document.contacts
        .flatMap((contact) => contact.email ? [contact.email.trim().toLowerCase()] : []));
      if (!fromEmail || !supplierEmails.has(fromEmail)) {
        throw new ProcurementValidationError('SUPPLIER_EMAIL_MISMATCH', '发件人邮箱与所选供应商联系人不匹配');
      }

      this.db.prepare(`INSERT INTO procurement_documents
        (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
        VALUES (?,'communication',?,?,?,?,1,?,?,?)`)
        .run(this.tenantId, communication.id, communication.sourceSystem, communication.externalId,
          communication.status, JSON.stringify(communication), communication.createdAt, communication.updatedAt);
      this.enqueueDocumentProjection('communication', communication, 1);
      this.db.prepare(`INSERT INTO procurement_inbound_communication_identities
        (tenant_id,communication_id,provider,mailbox,provider_uid,message_id,payload_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(this.tenantId, communication.id, provider, mailbox, providerUid, messageId, payloadHash, communication.createdAt);
      this.db.exec('COMMIT');
      return { communication: { document: communication, version: 1 }, replayed: false };
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  saveLine<T extends ProcurementLine>(kind: ProcurementLineKind, documentId: EntityId, line: T): T {
    const documentKind = LINE_DOCUMENT_KIND[kind];
    const parentField = LINE_PARENT_FIELD[kind];
    const parentId = (line as unknown as Record<string, unknown>)[parentField];
    if (parentId !== documentId) throw new Error(`采购行父单据不一致: ${parentField}=${String(parentId)}, documentId=${documentId}`);
    const documentExists = this.db
      .prepare('SELECT 1 AS ok FROM procurement_documents WHERE tenant_id=? AND kind=? AND id=?')
      .get(this.tenantId, documentKind, documentId);
    if (!documentExists) throw new Error(`采购行所属单据不存在: ${documentKind}/${documentId}`);
    if (kind === 'rfq_line' || kind === 'quote_line') {
      const existing = this.db.prepare('SELECT 1 AS ok FROM procurement_lines WHERE tenant_id=? AND kind=? AND id=?')
        .get(this.tenantId, kind, line.id);
      if (existing) throw new ProcurementValidationError('INVALID_INPUT', `${kind} 是已提交商业快照，不可覆盖`);
    }
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const parent = this.db.prepare(`SELECT updated_at FROM procurement_documents
        WHERE tenant_id=? AND kind=? AND id=?`).get(this.tenantId, documentKind, documentId) as { updated_at: string };
      persistProcurementLineProjectionInCurrentTransaction(this.db, {
        tenantId: this.tenantId,
        kind,
        lineId: line.id,
        documentId,
        lineNumber: line.lineNumber,
        line,
        availableAt: parent.updated_at,
      });
      if (ownsTransaction) this.db.exec('COMMIT');
      return line;
    } catch (error) {
      if (ownsTransaction) rollback(this.db);
      throw error;
    }
  }

  getLine<T extends ProcurementLine = ProcurementLine>(kind: ProcurementLineKind, id: EntityId): T | undefined {
    const row = this.db
      .prepare('SELECT json FROM procurement_lines WHERE tenant_id=? AND kind=? AND id=?')
      .get(this.tenantId, kind, id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }

  listLines<T extends ProcurementLine = ProcurementLine>(kind: ProcurementLineKind, documentId: EntityId): T[] {
    return (this.db
      .prepare('SELECT json FROM procurement_lines WHERE tenant_id=? AND kind=? AND document_id=? ORDER BY line_number,id')
      .all(this.tenantId, kind, documentId) as Array<{ json: string }>).map((row) => JSON.parse(row.json) as T);
  }

  createRequisitionIdempotent(input: IdempotentRequisitionCreate): IdempotentRequisitionResult {
    const { requisition, lines, idempotencyKey, payloadHash } = input;
    if (requisition.tenantId !== this.tenantId) throw new Error('采购单据与仓储租户不一致');
    if (!idempotencyKey) throw new Error('采购申请幂等键不能为空');
    if (!payloadHash) throw new Error('采购申请载荷摘要不能为空');
    if (lines.length === 0) throw new Error('采购申请必须至少包含一行');
    for (const line of lines) {
      if (line.requisitionId !== requisition.id) throw new Error(`采购行父单据不一致: requisitionId=${line.requisitionId}, documentId=${requisition.id}`);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`
        SELECT payload_hash,requisition_id FROM procurement_requisition_idempotency
        WHERE tenant_id=? AND idempotency_key=?
      `).get(this.tenantId, idempotencyKey) as { payload_hash: string; requisition_id: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new ProcurementIdempotencyConflictError(idempotencyKey);
        const stored = this.getDocument<ProcurementRequisition>('requisition', existing.requisition_id);
        if (!stored) throw new Error('采购申请幂等记录引用的单据不存在');
        const storedLines = this.listLines<RequisitionLine>('requisition_line', existing.requisition_id);
        this.db.exec('COMMIT');
        return { requisition: stored, lines: storedLines, replayed: true };
      }

      this.db.prepare(`
        INSERT INTO procurement_documents
          (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
        VALUES (?, 'requisition', ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        this.tenantId,
        requisition.id,
        requisition.sourceSystem,
        requisition.externalId,
        requisition.status,
        JSON.stringify(requisition),
        requisition.createdAt,
        requisition.updatedAt,
      );
      const insertLine = this.db.prepare(`
        INSERT INTO procurement_lines (tenant_id,kind,id,document_id,line_number,json)
        VALUES (?, 'requisition_line', ?, ?, ?, ?)
      `);
      for (const line of lines) {
        insertLine.run(this.tenantId, line.id, requisition.id, line.lineNumber, JSON.stringify(line));
      }
      this.db.prepare(`
        INSERT INTO procurement_requisition_idempotency
          (tenant_id,idempotency_key,payload_hash,requisition_id,created_at)
        VALUES (?,?,?,?,?)
      `).run(this.tenantId, idempotencyKey, payloadHash, requisition.id, requisition.createdAt);
      this.db.exec('COMMIT');
      return { requisition: { document: requisition, version: 1 }, lines: [...lines], replayed: false };
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  createRfqIdempotent(
    input: Omit<IdempotentProcurementCreate<RequestForQuotation, RequestForQuotationLine>, 'kind' | 'lineKind'>,
  ): IdempotentProcurementCreateResult<RequestForQuotation, RequestForQuotationLine> {
    // RFQ creation is a draft operation. `open` was a legacy API-only state and
    // is normalized here so newly persisted RFQs always enter the legal machine.
    const document: RequestForQuotation = { ...input.document, status: 'draft' };
    return this.createDocumentWithLinesIdempotent({ ...input, document, kind: 'rfq', lineKind: 'rfq_line' });
  }

  createQuoteIdempotent(
    input: Omit<IdempotentProcurementCreate<SupplierQuote, SupplierQuoteLine>, 'kind' | 'lineKind'>,
  ): IdempotentProcurementCreateResult<SupplierQuote, SupplierQuoteLine> {
    return this.createDocumentWithLinesIdempotent({ ...input, kind: 'quote', lineKind: 'quote_line' });
  }

  persistQuoteComparison(input: PersistQuoteComparisonInput): PersistQuoteComparisonResult {
    const { idempotencyKey, payloadHash, expectedRfqVersion, quoteVersions } = input;
    const snapshot = JSON.parse(JSON.stringify(input.snapshot)) as QuoteComparisonSnapshot;
    requireRepositoryText(idempotencyKey, 'idempotencyKey');
    requireRepositoryText(payloadHash, 'payloadHash');
    requireExpectedVersion(expectedRfqVersion);
    if (snapshot.tenantId !== this.tenantId) throw new ProcurementValidationError('INVALID_INPUT', '比较快照与仓储租户不一致');
    if (snapshot.rfqVersion !== expectedRfqVersion) throw new ProcurementValidationError('INVALID_INPUT', '快照 RFQ 版本与期望版本不一致');
    if (snapshot.status !== 'final') throw new ProcurementValidationError('INVALID_INPUT', '比较快照状态必须为 final');
    if (!snapshot.lineComparisons.length) throw new ProcurementValidationError('INVALID_INPUT', '比较快照必须包含行结果');
    validateQuoteComparisonSnapshot(snapshot);
    validateQuoteVersionExpectations(quoteVersions);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const replayRow = this.db.prepare(`
        SELECT payload_hash,response_json FROM procurement_quote_comparison_idempotency
        WHERE tenant_id=? AND idempotency_key=?
      `).get(this.tenantId, idempotencyKey) as { payload_hash: string; response_json: string } | undefined;
      if (replayRow) {
        if (replayRow.payload_hash !== payloadHash) throw new ProcurementQuoteComparisonIdempotencyConflictError(idempotencyKey);
        const replay = JSON.parse(replayRow.response_json) as PersistQuoteComparisonResult;
        this.db.exec('COMMIT');
        return { ...replay, replayed: true };
      }

      const storedRfq = this.getDocument<RequestForQuotation>('rfq', snapshot.rfqId);
      if (!storedRfq) throw new ProcurementValidationError('RFQ_NOT_FOUND', 'RFQ 不存在');
      if (storedRfq.version !== expectedRfqVersion) throw new ProcurementRfqVersionConflictError(expectedRfqVersion, storedRfq.version);
      const allowedStatuses = ['draft', 'sent', 'awaiting_quotes', 'partial_quotes', 'quotes_complete', 'compared'] as const;
      if (!allowedStatuses.includes(storedRfq.document.status as typeof allowedStatuses[number])) {
        throw new ProcurementRfqStateConflictError(storedRfq.document.status, allowedStatuses);
      }

      const rfqLines = this.listLines<RequestForQuotationLine>('rfq_line', snapshot.rfqId);
      assertExactIdSet(
        snapshot.lineComparisons.map((line) => line.rfqLineId),
        rfqLines.map((line) => line.id),
        'RFQ_LINE_SET_MISMATCH',
        '比较快照必须精确覆盖所有 RFQ 行',
      );

      const storedQuotes = this.listDocuments<SupplierQuote>('quote').filter(({ document }) => document.rfqId === snapshot.rfqId);
      assertExactIdSet(
        quoteVersions.map((item) => item.quoteId),
        storedQuotes.map(({ document }) => document.id),
        'QUOTE_SET_MISMATCH',
        '报价 ID/版本集必须与 RFQ 当前报价精确一致',
      );
      const expectedQuoteVersion = new Map(quoteVersions.map((item) => [item.quoteId, item.version]));
      for (const stored of storedQuotes) {
        const expected = expectedQuoteVersion.get(stored.document.id)!;
        if (stored.version !== expected) throw new ProcurementQuoteVersionConflictError(stored.document.id, expected, stored.version);
      }

      const snapshotQuoteIds = new Set<EntityId>();
      const rfqLineById = new Map(rfqLines.map((line) => [line.id, line]));
      const storedQuoteById = new Map(storedQuotes.map((quote) => [quote.document.id, quote]));
      for (const comparison of snapshot.lineComparisons) {
        const rfqLine = rfqLineById.get(comparison.rfqLineId);
        if (!rfqLine || comparison.lineNumber !== rfqLine.lineNumber || comparison.itemId !== rfqLine.itemId) {
          throw new ProcurementValidationError('QUOTE_RELATION_MISMATCH', '比较行与 RFQ 行不一致');
        }
        const seenQuoteLines = new Set<EntityId>();
        for (const quoteResult of comparison.quotes) {
          if (seenQuoteLines.has(quoteResult.quoteLineId)) throw new ProcurementValidationError('QUOTE_SET_MISMATCH', '比较行包含重复 quoteLineId');
          seenQuoteLines.add(quoteResult.quoteLineId);
          snapshotQuoteIds.add(quoteResult.quoteId);
          const quote = storedQuoteById.get(quoteResult.quoteId);
          if (!quote || quote.version !== quoteResult.quoteVersion || quoteResult.quoteVersion !== expectedQuoteVersion.get(quoteResult.quoteId)) {
            throw new ProcurementValidationError('QUOTE_SET_MISMATCH', '快照中的 quoteId/quoteVersion 与期望报价集不一致');
          }
          const quoteLine = this.getLine<SupplierQuoteLine>('quote_line', quoteResult.quoteLineId);
          if (!quoteLine) throw new ProcurementValidationError('QUOTE_LINE_NOT_FOUND', '快照引用的报价行不存在');
          if (quoteLine.quoteId !== quote.document.id || quoteLine.rfqLineId !== rfqLine.id || quote.document.supplierId !== quoteResult.supplierId) {
            throw new ProcurementValidationError('QUOTE_RELATION_MISMATCH', '快照 quoteId/quoteLineId/RFQ 行关联不一致');
          }
        }
      }
      assertExactIdSet(
        [...snapshotQuoteIds],
        quoteVersions.map((item) => item.quoteId),
        'QUOTE_SET_MISMATCH',
        '快照行报价必须精确引用期望报价集',
      );

      this.db.prepare(`
        INSERT INTO procurement_documents
          (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
        VALUES (?,'quote_comparison',?,?,?,?,1,?,?,?)
      `).run(
        this.tenantId, snapshot.id, snapshot.sourceSystem, snapshot.externalId, snapshot.status,
        JSON.stringify(snapshot), snapshot.createdAt, snapshot.updatedAt,
      );
      const allLinesRecommended = snapshot.lineComparisons.every((line) => line.recommendedSupplierId !== null);
      const updatedRfq: RequestForQuotation = {
        ...storedRfq.document,
        status: allLinesRecommended ? 'pending_award' : 'compared',
        comparisonSnapshotId: snapshot.id,
        updatedAt: snapshot.createdAt,
      };
      const nextRfqVersion = storedRfq.version + 1;
      const changed = this.db.prepare(`
        UPDATE procurement_documents SET status=?,version=?,json=?,updated_at=?
        WHERE tenant_id=? AND kind='rfq' AND id=? AND version=?
      `).run(
        updatedRfq.status, nextRfqVersion, JSON.stringify(updatedRfq), updatedRfq.updatedAt,
        this.tenantId, updatedRfq.id, storedRfq.version,
      );
      if (Number(changed.changes) !== 1) throw new ProcurementRfqVersionConflictError(expectedRfqVersion, storedRfq.version);
      const result: PersistQuoteComparisonResult = {
        snapshot: { document: snapshot, version: 1 },
        rfq: { document: updatedRfq, version: nextRfqVersion },
        replayed: false,
      };
      this.db.prepare(`
        INSERT INTO procurement_quote_comparison_idempotency
          (tenant_id,idempotency_key,payload_hash,snapshot_id,response_json,created_at)
        VALUES (?,?,?,?,?,?)
      `).run(this.tenantId, idempotencyKey, payloadHash, snapshot.id, JSON.stringify(result), snapshot.createdAt);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  awardRfqAndCreateDraftPurchaseOrders(input: AwardRfqInput): AwardRfqResult {
    const { idempotencyKey, payloadHash, rfqId, expectedRfqVersion, approvedBy, lines } = input;
    requireRepositoryText(idempotencyKey, 'idempotencyKey');
    requireRepositoryText(payloadHash, 'payloadHash');
    requireRepositoryText(rfqId, 'rfqId');
    requireRepositoryText(approvedBy, 'approvedBy');
    requireExpectedVersion(expectedRfqVersion);
    const approvedAt = requireIsoDate(input.approvedAt, 'approvedAt');
    if (!lines.length) throw new ProcurementValidationError('INVALID_INPUT', '定标必须至少包含一行');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const replayRow = this.db.prepare(`
        SELECT payload_hash,response_json FROM procurement_award_idempotency
        WHERE tenant_id=? AND idempotency_key=?
      `).get(this.tenantId, idempotencyKey) as { payload_hash: string; response_json: string } | undefined;
      if (replayRow) {
        if (replayRow.payload_hash !== payloadHash) throw new ProcurementAwardIdempotencyConflictError(idempotencyKey);
        const replay = JSON.parse(replayRow.response_json) as AwardRfqResult;
        this.db.exec('COMMIT');
        return { ...replay, replayed: true };
      }

      const storedRfq = this.getDocument<RequestForQuotation>('rfq', rfqId);
      if (!storedRfq) throw new ProcurementValidationError('RFQ_NOT_FOUND', 'RFQ 不存在');
      if (storedRfq.document.status === 'awarded') throw new ProcurementRfqAlreadyAwardedError(rfqId);
      if (storedRfq.version !== expectedRfqVersion) throw new ProcurementRfqVersionConflictError(expectedRfqVersion, storedRfq.version);
      if (storedRfq.document.status !== 'pending_award') {
        throw new ProcurementRfqStateConflictError(storedRfq.document.status, ['pending_award']);
      }
      if (!storedRfq.document.comparisonSnapshotId) {
        throw new ProcurementValidationError('INVALID_INPUT', 'RFQ 缺少定标所需的比较快照');
      }
      const snapshot = this.getDocument<QuoteComparisonSnapshot>('quote_comparison', storedRfq.document.comparisonSnapshotId)?.document;
      if (!snapshot || snapshot.rfqId !== rfqId) {
        throw new ProcurementValidationError('INVALID_INPUT', 'RFQ 比较快照不存在或关联错误');
      }

      const rfqLines = this.listLines<RequestForQuotationLine>('rfq_line', rfqId);
      assertExactIdSet(
        lines.map((line) => line.rfqLineId),
        rfqLines.map((line) => line.id),
        'AWARD_LINE_SET_MISMATCH',
        '定标必须精确覆盖所有 RFQ 行',
      );
      if (new Set(lines.map((line) => line.quoteLineId)).size !== lines.length) {
        throw new ProcurementValidationError('AWARD_LINE_SET_MISMATCH', 'quoteLineId 不能重复');
      }

      const rfqLineById = new Map(rfqLines.map((line) => [line.id, line]));
      const comparisonByLineId = new Map(snapshot.lineComparisons.map((line) => [line.rfqLineId, line]));
      const prepared = lines.map((selection) => {
        const reason = requireRepositoryText(selection.selectionReason, 'selectionReason');
        const rfqLine = rfqLineById.get(selection.rfqLineId)!;
        if (!Number.isFinite(selection.awardedQuantity) || selection.awardedQuantity <= 0 || selection.awardedQuantity !== rfqLine.requestedQty) {
          throw new ProcurementValidationError('AWARD_QUANTITY_INVALID', '初版定标数量必须等于 RFQ 请求数量');
        }
        const comparison = comparisonByLineId.get(rfqLine.id);
        const quoteResult = comparison?.quotes.find((quote) => quote.quoteLineId === selection.quoteLineId);
        if (!quoteResult || quoteResult.eligibility !== 'eligible') {
          throw new ProcurementValidationError('QUOTE_NOT_ELIGIBLE', '选中的报价行不在快照中或不可定标');
        }
        const storedQuote = this.getDocument<SupplierQuote>('quote', quoteResult.quoteId);
        if (!storedQuote) throw new ProcurementValidationError('QUOTE_NOT_FOUND', '报价不存在');
        const quoteLine = this.getLine<SupplierQuoteLine>('quote_line', selection.quoteLineId);
        if (!quoteLine) throw new ProcurementValidationError('QUOTE_LINE_NOT_FOUND', '报价行不存在');
        if (
          storedQuote.version !== quoteResult.quoteVersion
          || storedQuote.document.rfqId !== rfqId
          || quoteLine.quoteId !== storedQuote.document.id
          || quoteLine.rfqLineId !== rfqLine.id
          || quoteResult.supplierId !== storedQuote.document.supplierId
          || !storedRfq.document.supplierIds.includes(storedQuote.document.supplierId)
        ) {
          throw new ProcurementValidationError('QUOTE_RELATION_MISMATCH', '报价、报价行、RFQ 行或供应商关联不一致');
        }
        if (storedQuote.document.status !== 'received') throw new ProcurementValidationError('QUOTE_NOT_ELIGIBLE', '报价状态不可定标');
        if (storedQuote.document.validUntil && Date.parse(storedQuote.document.validUntil) < Date.parse(approvedAt)) {
          throw new ProcurementValidationError('QUOTE_EXPIRED', '报价已过期');
        }
        if (quoteLine.quotedQty < selection.awardedQuantity || quoteLine.uom !== rfqLine.uom) {
          throw new ProcurementValidationError('AWARD_QUANTITY_INVALID', '报价数量不足或计量单位不一致');
        }
        if (quoteLine.moq !== undefined && selection.awardedQuantity < quoteLine.moq) {
          throw new ProcurementValidationError('QUOTE_NOT_ELIGIBLE', '定标数量低于报价 MOQ');
        }
        if ((quoteLine.oneTimeCharges ?? []).some((charge) => charge.amount !== 0) || (quoteLine.freight ?? 0) !== 0) {
          throw new ProcurementValidationError('UNMODELED_QUOTE_CHARGES', 'PO 尚未建模一次性费用或运费，禁止静默丢失');
        }
        const basis = quoteLine.priceBasisQuantity ?? 1;
        if (!Number.isFinite(basis) || basis <= 0 || !Number.isFinite(quoteLine.unitPrice) || quoteLine.unitPrice < 0) {
          throw new ProcurementValidationError('INVALID_INPUT', '报价价格基数或单价无效');
        }
        if (quoteLine.taxRate !== undefined && (!Number.isFinite(quoteLine.taxRate) || quoteLine.taxRate < 0 || quoteLine.taxRate > 1)) {
          throw new ProcurementValidationError('INVALID_INPUT', '报价税率必须在 0 到 1 之间');
        }
        return {
          selection,
          selectionReason: reason,
          rfqLine,
          quote: storedQuote.document,
          quoteLine,
          normalizedUnitPrice: quoteLine.unitPrice / basis,
          basis,
        };
      });

      const awardId = `award:${randomUUID()}`;
      const award: Award = {
        id: awardId,
        tenantId: this.tenantId,
        sourceSystem: 'readywork',
        externalId: awardId,
        status: 'approved',
        createdAt: approvedAt,
        updatedAt: approvedAt,
        rfqId,
        approvedBy,
        approvedAt,
      };
      const awardLines: AwardLine[] = prepared.map(({ selection, selectionReason, rfqLine, quote, quoteLine, normalizedUnitPrice, basis }) => ({
        id: `award-line:${randomUUID()}`,
        awardId,
        rfqLineId: rfqLine.id,
        quoteLineId: quoteLine.id,
        supplierId: quote.supplierId,
        lineNumber: rfqLine.lineNumber,
        itemId: rfqLine.itemId,
        ...(rfqLine.description ? { description: rfqLine.description } : {}),
        uom: rfqLine.uom,
        awardedQty: selection.awardedQuantity,
        unitPrice: normalizedUnitPrice,
        currency: quote.currency,
        selectionReason,
        quotedUnitPrice: quoteLine.unitPrice,
        priceBasisQuantity: basis,
        ...(quoteLine.taxIncluded === undefined ? {} : { taxIncluded: quoteLine.taxIncluded }),
        ...(quoteLine.taxRate === undefined ? {} : { taxRate: quoteLine.taxRate }),
      }));

      this.db.prepare(`
        INSERT INTO procurement_documents
          (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
        VALUES (?,'award',?,?,?,?,1,?,?,?)
      `).run(this.tenantId, award.id, award.sourceSystem, award.externalId, award.status, JSON.stringify(award), award.createdAt, award.updatedAt);
      const insertLine = this.db.prepare(`
        INSERT INTO procurement_lines (tenant_id,kind,id,document_id,line_number,json)
        VALUES (?,?,?,?,?,?)
      `);
      for (const line of awardLines) insertLine.run(this.tenantId, 'award_line', line.id, award.id, line.lineNumber, JSON.stringify(line));

      const awardLineByRfqLine = new Map(awardLines.map((line) => [line.rfqLineId, line]));
      const groups = new Map<string, typeof prepared>();
      for (const item of prepared) {
        const key = `${item.quote.supplierId}\u0000${item.quote.currency}`;
        const group = groups.get(key) ?? [];
        group.push(item);
        groups.set(key, group);
      }
      const purchaseOrders: DraftPurchaseOrderResult[] = [];
      for (const [, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const first = group[0]!;
        const poId = `po:${randomUUID()}`;
        const po: PurchaseOrder = {
          id: poId,
          tenantId: this.tenantId,
          sourceSystem: 'readywork',
          externalId: poId,
          status: 'draft',
          createdAt: approvedAt,
          updatedAt: approvedAt,
          awardId,
          supplierId: first.quote.supplierId,
          currency: first.quote.currency,
          orderedAt: approvedAt,
        };
        const poLines: PurchaseOrderLine[] = group.map(({ selection, rfqLine, quote, quoteLine, normalizedUnitPrice, basis }) => {
          const awardLine = awardLineByRfqLine.get(rfqLine.id)!;
          return {
            id: `po-line:${randomUUID()}`,
            poId,
            awardLineId: awardLine.id,
            quoteLineId: quoteLine.id,
            rfqLineId: rfqLine.id,
            ...(rfqLine.requisitionLineId ? { requisitionLineId: rfqLine.requisitionLineId } : {}),
            lineNumber: rfqLine.lineNumber,
            itemId: rfqLine.itemId,
            ...(rfqLine.description ? { description: rfqLine.description } : {}),
            uom: rfqLine.uom,
            orderedQty: selection.awardedQuantity,
            unitPrice: normalizedUnitPrice,
            currency: quote.currency,
            quotedUnitPrice: quoteLine.unitPrice,
            priceBasisQuantity: basis,
            ...(quoteLine.taxIncluded === undefined ? {} : { taxIncluded: quoteLine.taxIncluded }),
            ...(quoteLine.taxRate === undefined ? {} : { taxRate: quoteLine.taxRate }),
            ...(rfqLine.requiredAt ? { requestedAt: rfqLine.requiredAt } : {}),
          };
        });
        this.db.prepare(`
          INSERT INTO procurement_documents
            (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
          VALUES (?,'purchase_order',?,?,?,?,1,?,?,?)
        `).run(this.tenantId, po.id, po.sourceSystem, po.externalId, po.status, JSON.stringify(po), po.createdAt, po.updatedAt);
        this.enqueueDocumentProjection('purchase_order', po, 1);
        for (const line of poLines) {
          insertLine.run(this.tenantId, 'purchase_order_line', line.id, po.id, line.lineNumber, JSON.stringify(line));
          this.enqueueLineProjection('purchase_order_line', line, po.updatedAt);
        }
        purchaseOrders.push({ purchaseOrder: { document: po, version: 1 }, lines: poLines });
      }

      const updatedRfq: RequestForQuotation = { ...storedRfq.document, status: 'awarded', updatedAt: approvedAt };
      const nextRfqVersion = storedRfq.version + 1;
      const changed = this.db.prepare(`
        UPDATE procurement_documents SET status=?,version=?,json=?,updated_at=?
        WHERE tenant_id=? AND kind='rfq' AND id=? AND version=?
      `).run(
        updatedRfq.status, nextRfqVersion, JSON.stringify(updatedRfq), updatedRfq.updatedAt,
        this.tenantId, updatedRfq.id, storedRfq.version,
      );
      if (Number(changed.changes) !== 1) throw new ProcurementRfqVersionConflictError(expectedRfqVersion, storedRfq.version);
      const result: AwardRfqResult = {
        award: { document: award, version: 1 },
        lines: awardLines,
        purchaseOrders,
        rfq: { document: updatedRfq, version: nextRfqVersion },
        replayed: false,
      };
      this.db.prepare(`
        INSERT INTO procurement_award_idempotency
          (tenant_id,idempotency_key,payload_hash,rfq_id,award_id,response_json,created_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(this.tenantId, idempotencyKey, payloadHash, rfqId, award.id, JSON.stringify(result), approvedAt);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  getExecutionApproval(id: EntityId): ProcurementExecutionApproval | undefined {
    const row = this.db.prepare('SELECT json FROM procurement_execution_approvals WHERE tenant_id=? AND id=?')
      .get(this.tenantId, id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as ProcurementExecutionApproval : undefined;
  }

  getOutboxMessage(id: EntityId): ProcurementOutboxMessage | undefined {
    const row = this.db.prepare('SELECT json FROM procurement_outbox WHERE tenant_id=? AND id=?')
      .get(this.tenantId, id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as ProcurementOutboxMessage : undefined;
  }

  listOutboxMessages(status?: ProcurementOutboxMessage['status']): ProcurementOutboxMessage[] {
    const rows = status
      ? this.db.prepare('SELECT json FROM procurement_outbox WHERE tenant_id=? AND status=? ORDER BY created_at,id').all(this.tenantId, status)
      : this.db.prepare('SELECT json FROM procurement_outbox WHERE tenant_id=? ORDER BY created_at,id').all(this.tenantId);
    return (rows as Array<{ json: string }>).map((row) => JSON.parse(row.json) as ProcurementOutboxMessage);
  }

  requeueBlockedOutboxMessages(input: RequeueBlockedProcurementOutboxInput): ProcurementOutboxMessage[] {
    const connectorId = requireRepositoryText(input.connectorId, 'connectorId');
    const requeuedAt = requireIsoDate(input.requeuedAt, 'requeuedAt');
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
      throw new ProcurementValidationError('INVALID_INPUT', 'limit 必须是 1-500 的整数');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`SELECT id,json FROM procurement_outbox
        WHERE tenant_id=? AND connector_id=? AND status='blocked' ORDER BY created_at,id LIMIT ?`)
        .all(this.tenantId, connectorId, limit) as Array<{ id: string; json: string }>;
      const requeued: ProcurementOutboxMessage[] = [];
      for (const row of rows) {
        const current = JSON.parse(row.json) as ProcurementOutboxMessage;
        const next = { ...current, status: 'pending' as const, nextAttemptAt: requeuedAt, requeuedAt, updatedAt: requeuedAt };
        delete next.error;
        const changed = this.db.prepare(`UPDATE procurement_outbox
          SET status='pending',next_attempt_at=?,json=?,updated_at=?
          WHERE tenant_id=? AND id=? AND connector_id=? AND status='blocked'`)
          .run(requeuedAt, JSON.stringify(next), requeuedAt, this.tenantId, row.id, connectorId);
        if (Number(changed.changes) === 1) requeued.push(next);
      }
      this.db.exec('COMMIT');
      return requeued;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  claimOutboxMessages(input: ClaimProcurementOutboxInput): ProcurementOutboxMessage[] {
    const workerId = requireRepositoryText(input.workerId, 'workerId');
    const claimedAt = requireIsoDate(input.claimedAt, 'claimedAt');
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new ProcurementValidationError('INVALID_INPUT', 'leaseDurationMs 必须是正整数');
    }
    const limit = input.limit ?? 1;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new ProcurementValidationError('INVALID_INPUT', 'limit 必须是 1-100 的整数');
    }
    if (input.channel !== undefined && input.channel !== 'email' && input.channel !== 'whatsapp' && input.channel !== 'erp') {
      throw new ProcurementValidationError('INVALID_INPUT', 'channel 必须是 email、whatsapp 或 erp');
    }
    const leaseExpiresAt = new Date(Date.parse(claimedAt) + input.leaseDurationMs).toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const baseWhere = `tenant_id=? AND (
        (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
        OR (status='processing' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?)
      )`;
      const rows = (input.channel
        ? this.db.prepare(`SELECT id,json,attempt FROM procurement_outbox WHERE ${baseWhere} AND channel=?
            ORDER BY COALESCE(next_attempt_at,created_at),created_at,id LIMIT ?`)
          .all(this.tenantId, claimedAt, claimedAt, input.channel, limit)
        : this.db.prepare(`SELECT id,json,attempt FROM procurement_outbox WHERE ${baseWhere}
            ORDER BY COALESCE(next_attempt_at,created_at),created_at,id LIMIT ?`)
          .all(this.tenantId, claimedAt, claimedAt, limit)) as Array<{ id: string; json: string; attempt: number }>;
      const claimed: ProcurementOutboxMessage[] = [];
      for (const row of rows) {
        const current = JSON.parse(row.json) as ProcurementOutboxMessage;
        const leaseToken = `procurement-lease:${randomUUID()}`;
        const leased = {
          ...current,
          status: 'processing' as const,
          attempts: Math.max(current.attempts ?? 0, row.attempt) + 1,
          leaseOwner: workerId,
          leaseToken,
          leaseExpiresAt,
          updatedAt: claimedAt,
        };
        delete leased.nextAttemptAt;
        delete leased.dispatchedAt;
        delete leased.failedAt;
        delete leased.error;
        const changed = this.db.prepare(`
          UPDATE procurement_outbox
          SET status='processing',attempt=?,next_attempt_at=NULL,lease_owner=?,lease_token=?,lease_expires_at=?,
              dispatched_at=NULL,failed_at=NULL,json=?,updated_at=?
          WHERE tenant_id=? AND id=? AND (
            (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?))
            OR (status='processing' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?)
          )
        `).run(leased.attempts, workerId, leaseToken, leaseExpiresAt, JSON.stringify(leased), claimedAt,
          this.tenantId, row.id, claimedAt, claimedAt);
        if (Number(changed.changes) !== 1) continue;
        claimed.push(leased);
      }
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  completeOutboxMessage(input: CompleteProcurementOutboxInput): ProcurementOutboxMessage {
    const id = requireRepositoryText(input.id, 'id');
    const leaseToken = requireRepositoryText(input.leaseToken, 'leaseToken');
    const completedAt = requireIsoDate(input.completedAt, 'completedAt');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT status,lease_token,lease_expires_at,json FROM procurement_outbox
        WHERE tenant_id=? AND id=?`).get(this.tenantId, id) as {
          status: ProcurementOutboxMessage['status']; lease_token: string | null; lease_expires_at: string | null; json: string;
        } | undefined;
      if (!row) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 消息不存在');
      const current = JSON.parse(row.json) as ProcurementOutboxMessage;
      if (row.status === 'dispatched' && row.lease_token === leaseToken) {
        this.db.exec('COMMIT');
        return current;
      }
      if (row.status !== 'processing' || row.lease_token !== leaseToken
        || !row.lease_expires_at || Date.parse(row.lease_expires_at) < Date.parse(completedAt)) {
        throw new ProcurementOutboxLeaseConflictError(id);
      }
      const frozenAttachments = outboxAttachmentSnapshots(current.payload['attachments']);
      const sentAttachments = input.sentAttachments === undefined ? [] : outboxAttachmentSnapshots(input.sentAttachments);
      if ((current.action === 'rfq.send' || current.action === 'purchase_order.send')
        && !isDeepStrictEqual(frozenAttachments, sentAttachments)) {
        throw new ProcurementValidationError('INVALID_INPUT', '已发送附件清单与 RFQ outbox 冻结快照不一致');
      }
      const completed = {
        ...current,
        status: 'dispatched' as const,
        dispatchedAt: completedAt,
        updatedAt: completedAt,
        ...(sentAttachments.length > 0 ? { sentAttachments } : {}),
        ...(input.connectorResult ? { connectorResult: safeConnectorResult(input.connectorResult) } : {}),
      };
      delete completed.nextAttemptAt;
      delete completed.failedAt;
      delete completed.error;
      const changed = this.db.prepare(`UPDATE procurement_outbox
        SET status='dispatched',next_attempt_at=NULL,dispatched_at=?,failed_at=NULL,json=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='processing' AND lease_token=?`)
        .run(completedAt, JSON.stringify(completed), completedAt, this.tenantId, id, leaseToken);
      if (Number(changed.changes) !== 1) throw new ProcurementOutboxLeaseConflictError(id);
      this.applyCompletedOutboxFact(completed, completedAt);
      this.recordSentAttachmentAudit(completed, completedAt);
      this.enqueueOutboxProjection(completed);
      this.db.exec('COMMIT');
      return completed;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  failOutboxMessage(input: FailProcurementOutboxInput): ProcurementOutboxMessage {
    const id = requireRepositoryText(input.id, 'id');
    const leaseToken = requireRepositoryText(input.leaseToken, 'leaseToken');
    const failedAt = requireIsoDate(input.failedAt, 'failedAt');
    const errorMessage = redactProcurementOutboxError(requireRepositoryText(input.error, 'error'));
    const retryAt = input.retryAt === undefined ? undefined : requireIsoDate(input.retryAt, 'retryAt');
    if (retryAt !== undefined && Date.parse(retryAt) <= Date.parse(failedAt)) {
      throw new ProcurementValidationError('INVALID_INPUT', 'retryAt 必须晚于 failedAt');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT status,lease_token,lease_expires_at,json FROM procurement_outbox
        WHERE tenant_id=? AND id=?`).get(this.tenantId, id) as {
          status: ProcurementOutboxMessage['status']; lease_token: string | null; lease_expires_at: string | null; json: string;
        } | undefined;
      if (!row) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 消息不存在');
      if (row.status !== 'processing' || row.lease_token !== leaseToken
        || !row.lease_expires_at || Date.parse(row.lease_expires_at) < Date.parse(failedAt)) {
        throw new ProcurementOutboxLeaseConflictError(id);
      }
      const current = JSON.parse(row.json) as ProcurementOutboxMessage;
      const failed = {
        ...current,
        attempts: input.deferred && retryAt ? Math.max(0,current.attempts-1) : current.attempts,
        status: retryAt === undefined ? 'failed' as const : 'pending' as const,
        updatedAt: failedAt,
        error: errorMessage,
        ...(retryAt === undefined ? { failedAt } : { nextAttemptAt: retryAt }),
      };
      delete failed.leaseOwner;
      delete failed.leaseToken;
      delete failed.leaseExpiresAt;
      if (retryAt === undefined) delete failed.nextAttemptAt;
      else delete failed.failedAt;
      const changed = this.db.prepare(`UPDATE procurement_outbox
        SET status=?,next_attempt_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,attempt=?,
            failed_at=?,json=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status='processing' AND lease_token=?`)
        .run(failed.status, retryAt ?? null, failed.attempts, retryAt === undefined ? failedAt : null,
          JSON.stringify(failed), failedAt, this.tenantId, id, leaseToken);
      if (Number(changed.changes) !== 1) throw new ProcurementOutboxLeaseConflictError(id);
      if (retryAt === undefined && (failed.action === 'purchase_order.amend' || failed.action === 'purchase_order.cancel') && failed.channel === 'erp' && input.uncertain === true) {
        this.markPurchaseOrderAmendmentUnknown(failed, failedAt, 'Odoo amendment dispatch outcome is uncertain; manual review required');
      } else if (retryAt === undefined && (failed.action === 'purchase_order.amend' || failed.action === 'purchase_order.cancel') && failed.channel === 'erp') {
        this.markPurchaseOrderAmendmentFailed(failed, failedAt, 'Odoo amendment was rejected before external dispatch began');
      } else if (retryAt === undefined) {
        this.insertOutboxFailureException(failed, failedAt, input.uncertain === true);
      }
      this.enqueueOutboxProjection(failed);
      this.db.exec('COMMIT');
      return failed;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  executeProcurementMutation(input: ProcurementExecutionMutationInput): ProcurementExecutionMutationResult {
    requireRepositoryText(input.idempotencyKey, 'idempotencyKey');
    requireRepositoryText(input.payloadHash, 'payloadHash');
    requireRepositoryText(input.actorId, 'actorId');
    requireRepositoryText(input.aggregateId, 'aggregateId');
    requireExpectedVersion(input.expectedVersion);
    if (input.shortfallDisposition !== undefined && input.shortfallDisposition !== 'cancel_remainder') {
      throw new ProcurementValidationError('INVALID_INPUT', 'shortfallDisposition 必须为 cancel_remainder');
    }
    if (input.shortfallDisposition !== undefined && (input.action !== 'decide_confirmation' || input.decision !== 'approved')) {
      throw new ProcurementValidationError('INVALID_INPUT', 'shortfallDisposition 只允许用于批准供应商短交确认');
    }
    if (input.confirmationMissingFields !== undefined) {
      requireConfirmationMissingFields(input.confirmationMissingFields);
      if (input.action !== 'queue_followup') {
        throw new ProcurementValidationError('INVALID_INPUT', 'confirmationMissingFields 只允许用于供应商确认补充草稿');
      }
      if (!input.supplierReference) {
        throw new ProcurementValidationError('INVALID_INPUT', '供应商确认补充草稿必须绑定原始入站回复');
      }
    }
    const occurredAt = requireIsoDate(input.occurredAt, 'occurredAt');
    if (input.action === 'cancel_po' && input.permission !== 'operate_and_approve') {
      throw new ProcurementExecutionPermissionError('operate_and_approve');
    }
    const approvalAction = input.action === 'decide_confirmation' || input.action === 'decide_ap'
      || input.action === 'create_odoo_po_draft'
      || input.action === 'update_rihd'
      || input.action === 'record_production_progress'
      || input.action === 'record_shipment' || input.action === 'record_transport_event' || input.action === 'record_receipt';
    const supplierEmailAiAction = input.evidenceSource === 'supplier_email_ai'
      && (input.action === 'record_production_progress' || input.action === 'record_shipment');
    if (approvalAction && supplierEmailAiAction && input.permission !== 'operate') throw new ProcurementExecutionPermissionError('operate');
    if (approvalAction && !supplierEmailAiAction && input.permission !== 'approve') throw new ProcurementExecutionPermissionError('approve');
    if (!approvalAction && input.permission !== 'operate' && input.permission !== 'approve' && input.permission !== 'operate_and_approve') throw new ProcurementExecutionPermissionError('operate');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const replayRow = this.db.prepare(`
        SELECT payload_hash,response_json FROM procurement_execution_idempotency
        WHERE tenant_id=? AND action=? AND idempotency_key=?
      `).get(this.tenantId, input.action, input.idempotencyKey) as { payload_hash: string; response_json: string } | undefined;
      if (replayRow) {
        if (replayRow.payload_hash !== input.payloadHash) throw new ProcurementExecutionIdempotencyConflictError(input.action, input.idempotencyKey);
        const replay = JSON.parse(replayRow.response_json) as ProcurementExecutionMutationResult;
        this.db.exec('COMMIT');
        return { ...replay, replayed: true };
      }

      let result: ProcurementExecutionMutationResult;
      switch (input.action) {
        case 'send_rfq': result = this.executeSendRfq(input, occurredAt); break;
        case 'send_po': result = this.executeSendPo(input, occurredAt); break;
        case 'edit_po': result = this.executeEditPurchaseOrder(input, occurredAt); break;
        case 'cancel_po': result = this.executeCancelPurchaseOrder(input, occurredAt); break;
        case 'duplicate_po': result = this.executeDuplicatePurchaseOrder(input, occurredAt); break;
        case 'create_odoo_po_draft': result = this.executeCreateOdooPoDraft(input, occurredAt); break;
        case 'queue_followup': result = this.executeQueueFollowup(input, occurredAt); break;
        case 'update_rihd': result = this.executeUpdateRihd(input, occurredAt); break;
        case 'mark_at_risk': result = this.executeMarkAtRisk(input, occurredAt); break;
        case 'record_confirmation': result = this.executeRecordConfirmation(input, occurredAt); break;
        case 'decide_confirmation': result = this.executeDecideConfirmation(input, occurredAt); break;
        case 'record_production_progress': result = this.executeRecordProductionProgress(input, occurredAt); break;
        case 'record_shipment': result = this.executeRecordShipment(input, occurredAt); break;
        case 'record_transport_event': result = this.executeRecordTransportEvent(input, occurredAt); break;
        case 'record_receipt': result = this.executeRecordReceipt(input, occurredAt); break;
        case 'record_invoice': result = this.executeRecordInvoice(input, occurredAt); break;
        case 'match_invoice': result = this.executeMatchInvoice(input, occurredAt); break;
        case 'decide_ap': result = this.executeDecideAp(input, occurredAt); break;
      }
      this.db.prepare(`
        INSERT INTO procurement_execution_idempotency
          (tenant_id,action,idempotency_key,payload_hash,response_json,created_at)
        VALUES (?,?,?,?,?,?)
      `).run(this.tenantId, input.action, input.idempotencyKey, input.payloadHash, JSON.stringify(result), occurredAt);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  private executeSendRfq(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const rfq = this.executionDocument<RequestForQuotation>('rfq', input.aggregateId, input.expectedVersion,
      ['draft', 'sent', 'awaiting_quotes', 'partial_quotes'], input.action);
    const supplierId = requireRepositoryText(input.supplierId ?? '', 'supplierId');
    if (!rfq.document.supplierIds.includes(supplierId)) {
      throw new ProcurementValidationError('INVALID_INPUT', '供应商不在该 RFQ 候选范围内');
    }
    if (!this.getDocument<Supplier>('supplier', supplierId)) {
      throw new ProcurementValidationError('INVALID_INPUT', '待询价供应商不存在');
    }
    const communicationIdentity = requireActiveCommunicationIdentity(this.db, this.tenantId);
    const attachments = freezeRfqAttachments(rfq.document);
    const outbox = this.insertExecutionOutbox(input, at, 'email', 'rfq.send', rfq.document.id, {
      rfqId: rfq.document.id, supplierId, attachments, communicationIdentity,
    });
    return { action: input.action, aggregate: rfq, createdDocuments: [], createdLines: [], outbox, replayed: false };
  }

  private executeSendPo(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion, ['draft'], input.action);
    // executeProcurementMutation holds BEGIN IMMEDIATE, so this read and the
    // following insert are serialized with every other execution mutation.
    // Do not treat blocked/failed rows as active: a new idempotency key is the
    // explicit operator retry path for messages that were never dispatched.
    const active = this.db.prepare(`
      SELECT id FROM procurement_outbox
      WHERE tenant_id=? AND action='purchase_order.send' AND aggregate_id=?
        AND status IN ('pending','processing')
      ORDER BY created_at,id LIMIT 1
    `).get(this.tenantId, po.document.id) as { id: string } | undefined;
    if (active) throw new ProcurementExecutionSendInFlightError(po.document.id, active.id);
    const communicationIdentity = requireActiveCommunicationIdentity(this.db, this.tenantId);
    const attachments = freezePurchaseOrderAttachments(this.db, this.tenantId, po.document);
    const outbox = this.insertExecutionOutbox(input, at, 'email', 'purchase_order.send', po.document.id, {
      poId: po.document.id, poVersion: po.version, supplierId: po.document.supplierId, attachments, communicationIdentity,
    });
    // Queued is not delivered: the PO remains draft until completeOutboxMessage
    // records connector success and advances both facts in one transaction.
    return { action: input.action, aggregate: po, createdDocuments: [], createdLines: [], outbox, replayed: false };
  }

  private executeEditPurchaseOrder(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.getDocument<PurchaseOrder>('purchase_order', input.aggregateId);
    if (!po) throw new ProcurementValidationError('PO_NOT_FOUND', '采购订单不存在或不可见');
    if (po.version !== input.expectedVersion) throw new ProcurementExecutionVersionConflictError(input.expectedVersion, po.version);
    const patch = requirePurchaseOrderEditPatch(input.patch);
    const reason = requireBoundedBusinessText(input.reason, 'reason', 4, 1_000);
    // A Readywork-created PO becomes Odoo-authoritative as soon as a durable
    // Odoo mapping exists. Its source label remains Readywork provenance only.
    const isLocalDraft = po.document.sourceSystem === 'readywork' && po.document.status === 'draft' && !po.document.odooReference;
    const supplierChanged = patch.supplierId !== undefined && patch.supplierId !== po.document.supplierId;
    if (!isLocalDraft && Object.keys(patch).some((field) => field !== 'requiredInHouseAt')) {
      throw new ProcurementValidationError('INVALID_INPUT', 'Odoo 或已有执行事实的 PO 仅允许修改可权威读回的 RIHD');
    }
    if (supplierChanged && (!isLocalDraft || this.purchaseOrderHasSupplierChangeExecutionFacts(po.document))) {
      throw new ProcurementValidationError('INVALID_INPUT', '已有 Odoo 映射、发送、执行或交付事实的 PO 不允许变更供应商');
    }

    const supplierId = patch.supplierId ?? po.document.supplierId;
    const supplier = this.getDocument<Supplier>('supplier', supplierId)?.document;
    if (!supplier) throw new ProcurementValidationError('SUPPLIER_NOT_FOUND', '采购订单供应商不存在或不可见');
    if (supplierChanged && patch.contactId === undefined) {
      throw new ProcurementValidationError('INVALID_INPUT', '变更供应商时必须明确选择新供应商联系人或清空联系人');
    }
    if (patch.contactId !== undefined && patch.contactId !== null && !supplier.contacts.some((contact) => contact.id === patch.contactId)) {
      throw new ProcurementValidationError('INVALID_INPUT', '联系人不属于当前供应商');
    }
    const currentLines = this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id);
    const editedLines = isLocalDraft && patch.lines !== undefined
      ? editPurchaseOrderLines(currentLines, patch.lines, po.document.currency, patch.requiredInHouseAt)
      : [];

    if (isLocalDraft) {
      const record = po.document as PurchaseOrder & Record<string, unknown>;
      const updatedDocument = {
        ...po.document,
        supplierId,
        ...(patch.requiredInHouseAt === undefined ? {} : { requiredInHouseAt: patch.requiredInHouseAt }),
        ...(patch.materialType === undefined ? {} : { materialType: patch.materialType }),
        ...(patch.contactId === undefined ? {} : { contactId: patch.contactId }),
        updatedAt: at,
      } as PurchaseOrder & Record<string, unknown>;
      const changedLines = editedLines.filter((line) => !isDeepStrictEqual(currentLines.find((current) => current.id === line.id), line));
      const documentChanged = stableJsonObject({ ...record, updatedAt: '' }) !== stableJsonObject({ ...updatedDocument, updatedAt: '' });
      if (!documentChanged && changedLines.length === 0) {
        throw new ProcurementValidationError('INVALID_INPUT', '编辑内容与当前采购订单一致，不会创建空审计记录');
      }
      const beforeHash = purchaseOrderEditStateHash(record, currentLines);
      const afterLines = currentLines.map((line) => changedLines.find((changed) => changed.id === line.id) ?? line);
      const afterHash = purchaseOrderEditStateHash(updatedDocument, afterLines);
      const aggregate = this.updateExecutionDocument('purchase_order', updatedDocument, po.version);
      for (const line of changedLines) this.saveLine('purchase_order_line', po.document.id, line);
      const activity: Activity = {
        id: `activity:po-edited:${randomUUID()}`, at, objectId: po.document.id, actor: input.actorId,
        action: 'purchase_order.edited', summary: '采购订单草稿已更新',
        context: {
          sourcePurchaseOrderVersion: po.version, resultPurchaseOrderVersion: aggregate.version, reason,
          beforeHash, afterHash,
          changedSupplier: supplierChanged, changedContact: patch.contactId !== undefined && patch.contactId !== (record['contactId'] ?? null),
          changedRihd: patch.requiredInHouseAt !== undefined && patch.requiredInHouseAt !== record['requiredInHouseAt'],
          changedMaterialType: patch.materialType !== undefined && patch.materialType !== record['materialType'],
          changedLineIds: changedLines.map((line) => line.id),
        },
      };
      this.db.prepare(`INSERT INTO runtime_activities
        (tenant_id,id,object_id,json,updated_at) VALUES (?,?,?,?,?)`)
        .run(this.tenantId, activity.id, activity.objectId ?? null, JSON.stringify(activity), at);
      return { action: input.action, aggregate, createdDocuments: [], createdLines: changedLines, replayed: false };
    }

    if (patch.requiredInHouseAt === po.document.requiredInHouseAt) {
      throw new ProcurementValidationError('INVALID_INPUT', '编辑内容与当前采购订单一致，不会创建空 amendment');
    }

    const existing = this.db.prepare(`SELECT id FROM procurement_outbox
      WHERE tenant_id=? AND action='purchase_order.amend' AND aggregate_id=?
        AND status IN ('blocked','pending','processing')
      ORDER BY created_at,id LIMIT 1`).get(this.tenantId, po.document.id) as { id: string } | undefined;
    if (existing) throw new ProcurementExecutionSendInFlightError(po.document.id, existing.id);
    const amendmentResult = createProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
      id: `purchase-order-amendment:${randomUUID()}`, poId: po.document.id, action: 'edit', sourcePoVersion: po.version,
      normalizedPatch: { ...patch }, idempotencyKey: input.idempotencyKey, actorId: input.actorId, reason, at,
    });
    const outbox = this.insertExecutionOutbox(input, at, 'erp', 'purchase_order.amend', po.document.id, {
      amendmentId: amendmentResult.amendment.id, poId: po.document.id, sourcePoVersion: po.version, patch, reason,
      actorId: input.actorId, odooMapping: freezeOdooPurchaseOrderMapping(po.document),
    });
    const amendment = transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
      id: amendmentResult.amendment.id, state: 'queued', actorId: input.actorId, reason: 'Odoo amendment queued', outboxId: outbox.id, at,
    });
    return { action: input.action, aggregate: po, createdDocuments: [], createdLines: [], outbox, amendment, replayed: false };
  }

  private executeCancelPurchaseOrder(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.getDocument<PurchaseOrder>('purchase_order', input.aggregateId);
    if (!po) throw new ProcurementValidationError('PO_NOT_FOUND', '采购订单不存在或不可见');
    if (po.version !== input.expectedVersion) throw new ProcurementExecutionVersionConflictError(input.expectedVersion, po.version);
    const reason = requireBoundedBusinessText(input.reason, 'reason', 4, 1_000);
    const blocker = this.purchaseOrderCancellationBlocker(po.document);
    if (blocker) throw new ProcurementExecutionStateConflictError(blocker, input.action);

    const external = po.document.sourceSystem === 'odoo' || Boolean(po.document.odooReference);
    if (!external) {
      const requestId = `purchase-order-cancellation:${randomUUID()}`;
      const aggregate = this.updateExecutionDocument('purchase_order', { ...po.document, status: 'cancelled', updatedAt: at }, po.version);
      this.appendPurchaseOrderCancellationQuantities(po.document.id, input, at);
      const activity: Activity = {
        id: requestId, at, objectId: po.document.id, actor: input.actorId,
        action: 'purchase_order.cancelled', summary: '采购订单已取消',
        context: { requestId, reason, sourcePurchaseOrderVersion: po.version, resultPurchaseOrderVersion: aggregate.version, source: 'readywork' },
      };
      this.db.prepare(`INSERT INTO runtime_activities
        (tenant_id,id,object_id,json,updated_at) VALUES (?,?,?,?,?)`)
        .run(this.tenantId, activity.id, activity.objectId ?? null, JSON.stringify(activity), at);
      return { action: input.action, aggregate, createdDocuments: [], createdLines: [], requestId, replayed: false };
    }

    const existing = this.db.prepare(`SELECT id FROM procurement_purchase_order_amendments
      WHERE tenant_id=? AND po_id=? AND action='cancel'
        AND state IN ('requested','queued','pending','dispatched','unknown')
      ORDER BY created_at,id LIMIT 1`).get(this.tenantId, po.document.id) as { id: string } | undefined;
    if (existing) throw new ProcurementExecutionStateConflictError('cancellation_pending_or_unknown', input.action);
    const amendmentResult = createProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
      id: `purchase-order-cancellation:${randomUUID()}`, poId: po.document.id, action: 'cancel', sourcePoVersion: po.version,
      normalizedPatch: { status: 'cancelled' }, idempotencyKey: input.idempotencyKey, actorId: input.actorId, reason, at,
    });
    const outbox = this.insertExecutionOutbox(input, at, 'erp', 'purchase_order.cancel', po.document.id, {
      amendmentId: amendmentResult.amendment.id, poId: po.document.id, sourcePoVersion: po.version, reason,
      actorId: input.actorId, odooMapping: freezeOdooPurchaseOrderMapping(po.document),
    });
    const amendment = transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
      id: amendmentResult.amendment.id, state: 'queued', actorId: input.actorId, reason: 'Odoo cancellation queued', outboxId: outbox.id, at,
    });
    return { action: input.action, aggregate: po, createdDocuments: [], createdLines: [], outbox, amendment, requestId: amendment.id, replayed: false };
  }

  private purchaseOrderCancellationBlocker(po: PurchaseOrder): string | null {
    if (['cancelled', 'closed', 'partially_shipped', 'shipped', 'partially_received', 'received'].includes(po.status)) return po.status;
    const fulfilmentDocument = this.db.prepare(`SELECT kind FROM procurement_documents
      WHERE tenant_id=? AND kind IN ('shipment','receipt') AND json_extract(json,'$.poId')=?
      ORDER BY created_at,id LIMIT 1`).get(this.tenantId, po.id) as { kind: string } | undefined;
    if (fulfilmentDocument) return fulfilmentDocument.kind === 'receipt' ? 'grn_exists' : 'shipment_exists';
    const invoice = this.db.prepare(`SELECT 1 FROM procurement_lines invoice_line
      JOIN procurement_lines po_line ON po_line.tenant_id=invoice_line.tenant_id
        AND po_line.kind='purchase_order_line' AND po_line.id=json_extract(invoice_line.json,'$.poLineId')
      WHERE invoice_line.tenant_id=? AND invoice_line.kind='invoice_line' AND po_line.document_id=? LIMIT 1`)
      .get(this.tenantId, po.id);
    if (invoice) return 'invoice_exists';
    const executionQuantity = this.db.prepare(`SELECT 1 FROM procurement_po_line_quantity_projections projection
      JOIN procurement_lines po_line ON po_line.tenant_id=projection.tenant_id
        AND po_line.kind='purchase_order_line' AND po_line.id=projection.po_line_id
      WHERE projection.tenant_id=? AND po_line.document_id=?
        AND (projection.shipped_qty>0 OR projection.received_qty>0 OR projection.invoiced_qty>0) LIMIT 1`)
      .get(this.tenantId, po.id);
    return executionQuantity ? 'fulfilment_quantity_exists' : null;
  }

  private appendPurchaseOrderCancellationQuantities(poId: string, input: ProcurementExecutionMutationInput, at: string): void {
    for (const line of this.listLines<PurchaseOrderLine>('purchase_order_line', poId)) {
      const projection = this.getPurchaseOrderLineQuantityProjection(line.id);
      const remaining = line.orderedQty - (projection?.cancelledQty ?? 0);
      if (remaining > 0) this.applyExecutionQuantity(line, 'cancelled', remaining, input, at);
    }
  }

  private purchaseOrderHasSupplierChangeExecutionFacts(po: PurchaseOrder): boolean {
    if (po.odooReference) return true;
    const outbox = this.db.prepare(`SELECT 1 FROM procurement_outbox
      WHERE tenant_id=? AND aggregate_id=?
        AND action IN ('purchase_order.send','purchase_order.create_draft','purchase_order.amend')
      LIMIT 1`).get(this.tenantId, po.id);
    if (outbox) return true;
    const executionDocument = this.db.prepare(`SELECT 1 FROM procurement_documents
      WHERE tenant_id=? AND kind IN ('confirmation','production_progress','shipment','receipt')
        AND json_extract(json,'$.poId')=? LIMIT 1`).get(this.tenantId, po.id);
    if (executionDocument) return true;
    const stage = this.db.prepare("SELECT 1 FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage<>'po_sent' LIMIT 1")
      .get(this.tenantId, po.id);
    if (stage) return true;
    const executionHistory = this.db.prepare(`SELECT 1 FROM procurement_execution_idempotency
      WHERE tenant_id=? AND json_extract(response_json,'$.aggregate.document.id')=? LIMIT 1`).get(this.tenantId, po.id);
    return Boolean(executionHistory);
  }

  private executeDuplicatePurchaseOrder(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const source = this.getDocument<PurchaseOrder>('purchase_order', input.aggregateId);
    if (!source) throw new ProcurementValidationError('PO_NOT_FOUND', '采购订单不存在或不可见');
    if (source.version !== input.expectedVersion) {
      throw new ProcurementExecutionVersionConflictError(input.expectedVersion, source.version);
    }
    const purchaseOrderNumber = requireBoundedBusinessText(input.purchaseOrderNumber, 'purchaseOrderNumber', 1, 120);
    const requiredInHouseAt = requireIsoDate(input.requiredInHouseAt ?? '', 'requiredInHouseAt');
    const reason = requireBoundedBusinessText(input.reason, 'reason', 4, 1_000);
    const duplicateNumber = this.db.prepare(`SELECT id FROM procurement_documents
      WHERE tenant_id=? AND kind='purchase_order'
        AND (lower(trim(external_id))=lower(?)
          OR lower(trim(COALESCE(json_extract(json,'$.number'),'')))=lower(?))
      ORDER BY created_at,id LIMIT 1`).get(this.tenantId, purchaseOrderNumber, purchaseOrderNumber) as { id: string } | undefined;
    if (duplicateNumber) {
      throw new ProcurementValidationError('DUPLICATE_PO_NUMBER', `采购订单编号 ${purchaseOrderNumber} 已存在`);
    }
    const supplier = this.getDocument<Supplier>('supplier', source.document.supplierId);
    if (!supplier) throw new ProcurementValidationError('SUPPLIER_NOT_FOUND', '采购订单供应商不存在');
    const sourceLines = this.listLines<PurchaseOrderLine>('purchase_order_line', source.document.id);
    if (sourceLines.length === 0) throw new ProcurementValidationError('INVALID_INPUT', '采购订单至少需要一行');

    const purchaseOrderId = `purchase-order:readywork:${randomUUID()}`;
    const sourceNumber = purchaseOrderDisplayNumber(source.document);
    const duplicate: PurchaseOrder = {
      id: purchaseOrderId,
      tenantId: this.tenantId,
      sourceSystem: 'readywork',
      externalId: purchaseOrderNumber,
      status: 'draft',
      createdAt: at,
      updatedAt: at,
      supplierId: source.document.supplierId,
      currency: source.document.currency,
      orderedAt: at,
      requiredInHouseAt,
      duplicatedFrom: {
        purchaseOrderId: source.document.id,
        purchaseOrderVersion: source.version,
        purchaseOrderNumber: sourceNumber,
        originalOrderedAt: source.document.orderedAt,
        duplicatedBy: input.actorId,
        duplicatedAt: at,
        reason,
      },
    };
    const duplicateLines: PurchaseOrderLine[] = sourceLines.map((line) => ({
      id: `purchase-order-line:readywork:${randomUUID()}`,
      poId: duplicate.id,
      lineNumber: line.lineNumber,
      itemId: line.itemId,
      ...(line.description ? { description: line.description } : {}),
      uom: line.uom,
      orderedQty: line.orderedQty,
      unitPrice: line.unitPrice,
      currency: line.currency,
      ...(line.quotedUnitPrice === undefined ? {} : { quotedUnitPrice: line.quotedUnitPrice }),
      ...(line.priceBasisQuantity === undefined ? {} : { priceBasisQuantity: line.priceBasisQuantity }),
      ...(line.taxIncluded === undefined ? {} : { taxIncluded: line.taxIncluded }),
      ...(line.taxRate === undefined ? {} : { taxRate: line.taxRate }),
      requestedAt: requiredInHouseAt,
    }));
    this.insertExecutionDocument('purchase_order', duplicate);
    for (const line of duplicateLines) this.insertExecutionLine('purchase_order_line', duplicate.id, line);
    this.recordPoStageEvent({
      poId: duplicate.id,
      stage: 'po_sent',
      eventType: 'draft_created_from_duplicate',
      state: 'active',
      occurredAt: at,
      sourceKind: 'human_action',
      sourceId: `${input.action}:${input.idempotencyKey}`,
      actorId: input.actorId,
      evidence: {
        exactTransitionTime: true,
        sourcePurchaseOrderId: source.document.id,
        sourcePurchaseOrderVersion: source.version,
        sourcePurchaseOrderNumber: sourceNumber,
        purchaseOrderNumber,
        requiredInHouseAt,
        reason,
      },
    });
    const sourceActivity: Activity = {
      id: `activity:po-duplicated-source:${randomUUID()}`,
      at,
      objectId: source.document.id,
      actor: input.actorId,
      action: 'purchase_order.duplicated',
      summary: `采购订单已复制为草稿 ${purchaseOrderNumber}`,
      context: {
        sourcePurchaseOrderVersion: source.version,
        duplicatedPurchaseOrderId: duplicate.id,
        duplicatedPurchaseOrderNumber: purchaseOrderNumber,
        requiredInHouseAt,
        reason,
      },
    };
    const targetActivity: Activity = {
      id: `activity:po-duplicated-target:${randomUUID()}`,
      at,
      objectId: duplicate.id,
      actor: input.actorId,
      action: 'purchase_order.created_from_duplicate',
      summary: `从 ${sourceNumber} 复制建立 PO Draft`,
      context: {
        sourcePurchaseOrderId: source.document.id,
        sourcePurchaseOrderVersion: source.version,
        sourcePurchaseOrderNumber: sourceNumber,
        requiredInHouseAt,
        reason,
      },
    };
    const insertActivity = this.db.prepare(`INSERT INTO runtime_activities
      (tenant_id,id,object_id,json,updated_at) VALUES (?,?,?,?,?)`);
    for (const activity of [sourceActivity, targetActivity]) {
      insertActivity.run(this.tenantId, activity.id, activity.objectId ?? null, JSON.stringify(activity), at);
    }
    return {
      action: input.action,
      aggregate: source,
      createdDocuments: [duplicate],
      createdLines: duplicateLines,
      replayed: false,
    };
  }

  private executeCreateOdooPoDraft(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion,
      ['draft'], input.action);
    if (po.document.sourceSystem !== 'readywork') {
      throw new ProcurementValidationError('INVALID_INPUT', 'Odoo 草稿只能从 Readywork 内部 PO 创建');
    }
    if (po.document.odooReference) {
      throw new ProcurementExecutionStateConflictError(po.document.status, input.action);
    }

    // BEGIN IMMEDIATE serializes this check with the outbox insert.  A failed
    // terminal attempt may be retried with a fresh execution idempotency key;
    // every other state represents an in-flight or already accepted create.
    const existing = this.db.prepare(`
      SELECT id FROM procurement_outbox
      WHERE tenant_id=? AND action='purchase_order.create_draft' AND aggregate_id=?
        AND status<>'failed'
      ORDER BY created_at,id LIMIT 1
    `).get(this.tenantId, po.document.id) as { id: string } | undefined;
    if (existing) throw new ProcurementExecutionSendInFlightError(po.document.id, existing.id);

    const supplier = this.getDocument<Supplier>('supplier', po.document.supplierId)?.document;
    if (!supplier) throw new ProcurementValidationError('SUPPLIER_NOT_FOUND', '采购订单供应商不存在');
    if (supplier.sourceSystem !== 'odoo') {
      throw new ProcurementValidationError('INVALID_INPUT', '采购订单供应商必须是 Odoo 映射');
    }
    const partnerId = parseOdooPartnerId(supplier.externalId);
    const currency = requireRepositoryText(po.document.currency, 'currency');
    const lines = this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id);
    if (lines.length === 0) throw new ProcurementValidationError('INVALID_INPUT', '采购订单至少需要一行');
    const lineSnapshots = lines.map((line, index) => freezeOdooPurchaseOrderLine(line, currency, index));
    const correlationKey = purchaseOrderOdooCorrelationKey(this.tenantId, po.document.id);
    const outbox = this.insertExecutionOutbox(input, at, 'erp', 'purchase_order.create_draft', po.document.id, {
      poId: po.document.id,
      poVersion: po.version,
      supplierMapping: {
        supplierId: supplier.id,
        sourceSystem: supplier.sourceSystem,
        externalId: supplier.externalId,
        partnerId,
      },
      partnerId,
      currency,
      correlationKey,
      lines: lineSnapshots,
    });
    return { action: input.action, aggregate: po, createdDocuments: [], createdLines: [], outbox, replayed: false };
  }

  private executeUpdateRihd(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion,
      ['sent', 'awaiting_confirmation', 'confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped', 'shipped', 'partially_received'], input.action);
    const requiredInHouseAt = requireIsoDate(input.requiredInHouseAt ?? '', 'requiredInHouseAt');
    const reason = requireRepositoryText(input.reason ?? '', 'reason');
    const lines = this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id);
    if (lines.length === 0) throw new ProcurementValidationError('INVALID_INPUT', '采购订单至少需要一行');
    const currentRequiredInHouseAt = purchaseOrderRequiredInHouseAt(po.document, lines);
    if (currentRequiredInHouseAt && currentRequiredInHouseAt.slice(0, 10) === requiredInHouseAt.slice(0, 10)) {
      throw new ProcurementValidationError('INVALID_INPUT', '新 RIHD 与当前要求到货日相同');
    }
    const active = this.db.prepare(`SELECT id FROM procurement_outbox
      WHERE tenant_id=? AND action='purchase_order.update_rihd' AND aggregate_id=?
        AND status IN ('blocked','pending','processing')
      ORDER BY created_at,id LIMIT 1`).get(this.tenantId, po.document.id) as { id: string } | undefined;
    if (active) throw new ProcurementExecutionSendInFlightError(po.document.id, active.id);
    const odooMapping = freezeOdooPurchaseOrderMapping(po.document);
    const lineSnapshots = lines.map((line, index) => ({
      poLineId: requireRepositoryText(line.id, `采购订单第 ${index + 1} 行.poLineId`),
      lineNumber: requireRepositoryText(line.lineNumber, `采购订单第 ${index + 1} 行.lineNumber`),
      orderedQty: requirePositiveFiniteNumber(line.orderedQty, `采购订单第 ${index + 1} 行.orderedQty`),
      requestedAt: line.requestedAt ? requireIsoDate(line.requestedAt, `采购订单第 ${index + 1} 行.requestedAt`) : null,
    }));
    const outbox = this.insertExecutionOutbox(input, at, 'erp', 'purchase_order.update_rihd', po.document.id, {
      poId: po.document.id,
      poVersion: po.version,
      previousRequiredInHouseAt: currentRequiredInHouseAt,
      requiredInHouseAt,
      reason,
      actorId: input.actorId,
      odooMapping,
      lines: lineSnapshots,
    });
    return { action: input.action, aggregate: po, createdDocuments: [], createdLines: [], outbox, replayed: false };
  }

  private executeMarkAtRisk(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion,
      ['sent', 'awaiting_confirmation', 'confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped', 'shipped', 'partially_received'], input.action);
    const severity = requireManualRiskSeverity(input.riskSeverity);
    const category = requireManualRiskCategory(input.riskCategory);
    const reason = requireBoundedBusinessText(input.reason, 'reason', 4, 1_000);
    const recommendedAction = input.recommendedAction === undefined
      ? '核对风险事实、明确负责人和恢复计划，并在异常中心持续跟踪。'
      : requireBoundedBusinessText(input.recommendedAction, 'recommendedAction', 4, 1_000);
    const existing = this.db.prepare(`SELECT id FROM runtime_exceptions
      WHERE tenant_id=? AND object_id=? AND status IN ('open','assigned')
        AND json_extract(json,'$.type')='manual_purchase_order_risk'
      ORDER BY updated_at DESC,id LIMIT 1`).get(this.tenantId, po.document.id) as { id: string } | undefined;
    if (existing) throw new ProcurementExecutionStateConflictError('already_marked', input.action);

    const exception: Exception = {
      id: `procurement-risk:${randomUUID()}`,
      type: 'manual_purchase_order_risk',
      severity,
      objectId: po.document.id,
      objectType: 'purchase_order',
      owner: input.actorId,
      // This is deliberately identified as a human fact.  The legacy field is
      // named aiJudgment, but the value must never imply that a model decided.
      aiJudgment: `人工标记：${reason}`,
      recommendedAction,
      context: {
        source: 'human_mark_at_risk',
        category,
        reason,
        purchaseOrderVersion: po.version,
        purchaseOrderStatus: po.document.status,
        markedBy: input.actorId,
        markedAt: at,
      },
      needsApproval: false,
      status: 'assigned',
      createdAt: at,
    };
    this.db.prepare(`INSERT INTO runtime_exceptions
      (tenant_id,id,object_id,status,json,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(this.tenantId, exception.id, exception.objectId, exception.status, JSON.stringify(exception), at);
    const activity: Activity = {
      id: `activity:po-risk:${exception.id}`,
      at,
      objectId: po.document.id,
      actor: input.actorId,
      action: 'purchase_order.marked_at_risk',
      summary: `采购订单已人工标记为${severity === 'critical' ? '严重' : severity === 'high' ? '高' : '中'}风险`,
      context: {
        exceptionId: exception.id,
        category,
        severity,
        reason,
        recommendedAction,
        purchaseOrderVersion: po.version,
      },
    };
    this.db.prepare(`INSERT INTO runtime_activities
      (tenant_id,id,object_id,json,updated_at) VALUES (?,?,?,?,?)`)
      .run(this.tenantId, activity.id, activity.objectId ?? null, JSON.stringify(activity), at);
    return { action: input.action, aggregate: po, createdDocuments: [], createdLines: [], exception, replayed: false };
  }

  private executeQueueFollowup(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion,
      ['sent', 'awaiting_confirmation', 'confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped'], input.action);
    const reason = requireRepositoryText(input.reason ?? '', 'reason');
    const supplier = this.getDocument<Supplier>('supplier', po.document.supplierId)?.document;
    if (!supplier) throw new ProcurementValidationError('SUPPLIER_NOT_FOUND', '采购订单供应商不存在');
    const recipient = supplier.contacts.find((contact) => contact.primary && contact.email)?.email
      ?? supplier.contacts.find((contact) => contact.email)?.email;
    if (!recipient || isPlaceholderEmailRecipient(recipient)) {
      throw new ProcurementValidationError('INVALID_INPUT', '供应商没有可用的真实邮箱，不能生成可外发跟进草稿');
    }
    const communicationIdentity = requireActiveCommunicationIdentity(this.db, this.tenantId);
    const poNumber = po.document.externalId || po.document.id;
    const poLines = this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id);
    const hasSupplierConfirmation = Boolean(this.db.prepare(`SELECT 1 AS present FROM procurement_documents
      WHERE tenant_id=? AND kind='confirmation' AND json_extract(json,'$.poId')=? AND status<>'rejected'
      ORDER BY created_at,id LIMIT 1`).get(this.tenantId, po.document.id));
    // Odoo `confirmed` only proves the ERP PO is approved. Without a
    // source-bound Confirmation document the PO is still in Supplier
    // Commitment and must not receive a delivery-progress follow-up.
    const acknowledgement = ['sent', 'awaiting_confirmation'].includes(po.document.status)
      || (po.document.status === 'confirmed' && !hasSupplierConfirmation);
    const clarificationFields = input.confirmationMissingFields === undefined
      ? []
      : requireConfirmationMissingFields(input.confirmationMissingFields);
    if (clarificationFields.length && !acknowledgement) {
      throw new ProcurementValidationError('INVALID_INPUT', '只有仍处于供应商承诺阶段的 PO 可以生成缺失确认字段草稿');
    }
    if (clarificationFields.length) {
      const communication = this.getDocument<Communication>('communication', input.supplierReference!)?.document;
      if (!communication
        || communication.businessObjectType !== 'purchase_order'
        || communication.businessObjectId !== po.document.id
        || communication.direction !== 'inbound'
        || communication.status !== 'received'
        || communication.supplierId !== po.document.supplierId) {
        throw new ProcurementValidationError('INVALID_INPUT', '确认补充草稿绑定的邮件不是当前 PO 与供应商的可信入站回复');
      }
    }
    const clarificationLabels = clarificationFields.map(confirmationFieldLabel);
    const subject = clarificationFields.length
      ? `请补充采购订单 ${poNumber} 的${clarificationLabels.join('、')}`
      : acknowledgement ? `请确认采购订单 ${poNumber}` : `请更新采购订单 ${poNumber} 交付进度`;
    const itemSummary = poLines.map((line) => line.description ?? line.itemId).slice(0, 3).join('、') || '采购订单物料';
    const confirmationBlock = acknowledgement ? `\n\n请保留并核对以下结构化确认块：\n\n${buildExecutionConfirmationReplyBlock(poNumber, po.document.currency, poLines)}` : '';
    const requestText = clarificationFields.length
      ? `我们已收到您最近的回复。当前仍缺少：${clarificationLabels.join('、')}。请在下方结构化确认块中补充缺失字段，并保留其他字段供完整核对。`
      : `请协助确认以下事项：\n${reason}`;
    const body = `${supplier.name}，您好：\n\n关于采购订单 ${poNumber}（${itemSummary}），${requestText}${confirmationBlock}\n\n请直接回复本邮件，便于我们更新采购执行计划。\n\n${communicationSignature(communicationIdentity)}`;
    const triggerCode = `manual-followup:${po.document.id}:${input.idempotencyKey}`;
    const draftId = `message-draft:${randomUUID()}`;
    const evidence = { source: 'po_workbench', purchaseOrderId: po.document.id, poVersion: po.version,
      reason, executionIdempotencyKey: input.idempotencyKey, generatedAt: at,
      ...(clarificationFields.length ? {
        sourceCommunicationId: input.supplierReference,
        confirmationMissingFields: clarificationFields,
      } : {}) };
    this.db.prepare(`INSERT INTO procurement_message_drafts
      (tenant_id,id,purchase_order_id,supplier_id,channel,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at,sender_name,sender_title,sender_organization)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`).run(
      this.tenantId, draftId, po.document.id, po.document.supplierId, 'email', recipient.trim().toLowerCase(), subject, body,
      acknowledgement ? 'acknowledgement_followup' : 'delivery_status_escalation', triggerCode, JSON.stringify({ ...evidence, communicationIdentity }), 'draft', input.actorId, at, at,
      communicationIdentity.displayName, communicationIdentity.title, communicationIdentity.organizationName,
    );
    this.db.prepare(`INSERT INTO procurement_message_draft_events
      (tenant_id,id,draft_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`).run(
      this.tenantId, `message-draft-event:${randomUUID()}`, draftId, input.actorId, 'created_from_po_workbench', JSON.stringify(evidence), at,
    );
    return { action: input.action, aggregate: po, createdDocuments: [], createdLines: [],
      messageDraft: { id: draftId, status: 'draft', version: 1, recipient: recipient.trim().toLowerCase(), subject,
        category: acknowledgement ? 'acknowledgement_followup' : 'delivery_status_escalation',
        ...(clarificationFields.length ? { sourceCommunicationId: input.supplierReference, confirmationMissingFields: clarificationFields } : {}) }, replayed: false };
  }

  private executeRecordConfirmation(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    // Odoo `purchase` is an ERP order-state observation, not proof that the
    // supplier has confirmed every line. A later, source-bound supplier reply
    // must therefore be allowed to create the precise confirmation record.
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion, ['sent', 'awaiting_confirmation', 'confirmed'], input.action);
    const poLines = this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id);
    const inputs = requireExecutionLines(input.lines);
    assertExactIdSet(inputs.map((line) => line.poLineId), poLines.map((line) => line.id), 'INVALID_INPUT', '供应商确认必须精确覆盖所有 PO 行');
    const poLineById = new Map(poLines.map((line) => [line.id, line]));
    const confirmationId = `confirmation:${randomUUID()}`;
    const confirmationLines: PurchaseOrderConfirmationLine[] = inputs.map((line, index) => {
      const poLine = poLineById.get(line.poLineId)!;
      const quantity = requirePositiveQuantity(line.quantity, 'confirmed quantity');
      const price = line.unitPrice ?? poLine.unitPrice;
      if (!Number.isFinite(price) || price < 0) throw new ProcurementValidationError('INVALID_INPUT', '确认单价必须是非负有限数');
      const promisedAt = line.promisedAt ? requireIsoDate(line.promisedAt, 'promisedAt') : undefined;
      const variance = evaluateSupplierConfirmationVariance({
        orderedQty: poLine.orderedQty,
        confirmedQty: quantity,
        poUnitPrice: poLine.unitPrice,
        confirmedUnitPrice: price,
        requestedAt: poLine.requestedAt,
        promisedAt,
      });
      if (variance.quantityVariance === undefined || variance.unitPriceVariance === undefined) {
        throw new ProcurementValidationError('INVALID_INPUT', 'PO 数量或单价基准无效，不能登记供应商确认');
      }
      return {
        id: `confirmation-line:${randomUUID()}`, confirmationId, poLineId: poLine.id,
        lineNumber: poLine.lineNumber || String((index + 1) * 10), itemId: poLine.itemId,
        ...(poLine.description ? { description: poLine.description } : {}), uom: poLine.uom,
        confirmedQty: quantity, ...(promisedAt ? { promisedAt } : {}), confirmedUnitPrice: price,
        quantityVariance: variance.quantityVariance, unitPriceVariance: variance.unitPriceVariance,
        ...(variance.promisedAtVarianceDays === undefined ? {} : { promisedAtVarianceDays: variance.promisedAtVarianceDays }),
        requiresApproval: variance.requiresApproval,
      };
    });
    const needsApproval = confirmationLines.some((line) => line.requiresApproval);
    const approval = needsApproval ? this.insertExecutionApproval({
      id: `procurement-approval:${randomUUID()}`, tenantId: this.tenantId, kind: 'supplier_confirmation',
      objectId: confirmationId, poId: po.document.id, status: 'pending', requestedBy: input.actorId,
      requestedAt: at, reason: '供应商确认存在数量、价格或交期差异',
    }) : undefined;
    const confirmation: PurchaseOrderConfirmation = {
      id: confirmationId, tenantId: this.tenantId, sourceSystem: 'supplier', externalId: confirmationId,
      status: needsApproval ? 'pending_approval' : 'confirmed', createdAt: at, updatedAt: at,
      poId: po.document.id, supplierId: po.document.supplierId, confirmedAt: at,
      ...(input.supplierReference ? { supplierReference: requireRepositoryText(input.supplierReference, 'supplierReference') } : {}),
      ...(approval ? { approvalId: approval.id } : {}),
    };
    this.insertExecutionDocument('confirmation', confirmation);
    for (const line of confirmationLines) this.insertExecutionLine('confirmation_line', confirmation.id, line);
    if (!needsApproval) for (const line of confirmationLines) this.applyExecutionQuantity(poLineById.get(line.poLineId)!, 'confirmed', line.confirmedQty, input, at);
    this.recordPoStageEvent({
      poId: po.document.id, stage: 'supplier_commitment', eventType: needsApproval ? 'confirmation_evidence_received' : 'confirmation_accepted',
      state: needsApproval ? 'active' : 'completed', occurredAt: at, sourceKind: 'confirmation', sourceId: confirmation.id, actorId: input.actorId,
      evidence: { confirmationId: confirmation.id, requiresApproval: needsApproval, approvalId: approval?.id ?? null, lineCount: confirmationLines.length, exactTransitionTime: true },
    });
    if (!needsApproval) this.recordPoStageEvent({
      poId: po.document.id, stage: 'fulfilment_production', eventType: 'stage_entered', state: 'active', occurredAt: at,
      sourceKind: 'confirmation', sourceId: confirmation.id, actorId: input.actorId,
      evidence: { causedByStage: 'supplier_commitment', confirmationId: confirmation.id, exactTransitionTime: true },
    });
    const nextStatus = needsApproval ? 'awaiting_confirmation' : 'confirmed';
    const aggregate = this.updateExecutionDocument('purchase_order', { ...po.document, status: nextStatus, updatedAt: at }, po.version);
    return { action: input.action, aggregate, createdDocuments: [confirmation], createdLines: confirmationLines, ...(approval ? { approval } : {}), replayed: false };
  }

  private executeDecideConfirmation(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const approval = this.executionApprovalForDecision(input, 'supplier_confirmation');
    const confirmation = this.getDocument<PurchaseOrderConfirmation>('confirmation', approval.objectId);
    if (!confirmation) throw new ProcurementValidationError('INVALID_INPUT', '供应商确认单不存在');
    const po = this.executionDocument<PurchaseOrder>('purchase_order', approval.poId!, input.expectedVersion, ['awaiting_confirmation'], input.action);
    const decision = requireExecutionDecision(input.decision);
    const confirmationLines = this.listLines<PurchaseOrderConfirmationLine>('confirmation_line', confirmation.document.id);
    const poLines = new Map(this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id).map((line) => [line.id, line]));
    const shortLines = decision === 'approved'
      ? confirmationLines.filter((line) => line.confirmedQty < poLines.get(line.poLineId)!.orderedQty)
      : [];
    if (!shortLines.length && input.shortfallDisposition !== undefined) {
      throw new ProcurementValidationError('INVALID_INPUT', '当前确认不存在短交，不能声明关闭剩余量');
    }
    const shortfallDisposition = shortLines.length
      ? requireShortfallDisposition(input.shortfallDisposition)
      : undefined;
    const closureReason = shortLines.length
      ? requireRepositoryText(input.reason ?? '', '短交剩余量关闭原因')
      : undefined;
    const decided = this.decideExecutionApproval(
      approval,
      decision,
      input.actorId,
      at,
      closureReason ?? input.reason,
      shortfallDisposition,
    );
    if (decision === 'approved') {
      const excessLines = confirmationLines.filter((line) => line.confirmedQty > poLines.get(line.poLineId)!.orderedQty);
      if (excessLines.length) throw new ProcurementValidationError('INVALID_INPUT', '超订购数量的确认必须先修订 PO，不能仅靠差异审批放行');
      for (const line of confirmationLines) {
        const poLine = poLines.get(line.poLineId)!;
        this.applyExecutionQuantity(poLine, 'confirmed', line.confirmedQty, input, at);
        const cancelledRemainder = poLine.orderedQty - line.confirmedQty;
        if (cancelledRemainder > 0) this.applyExecutionQuantity(poLine, 'cancelled', cancelledRemainder, input, at);
      }
    }
    this.recordPoStageEvent({
      poId: po.document.id, stage: 'supplier_commitment', eventType: `confirmation_${decision}`,
      state: decision === 'approved' ? 'completed' : 'blocked', occurredAt: at, sourceKind: 'approval', sourceId: approval.id, actorId: input.actorId,
      evidence: {
        approvalId: approval.id, confirmationId: confirmation.document.id, decision, reason: decided.decisionReason ?? null,
        shortfallDisposition: shortfallDisposition ?? null,
        cancelledRemainderQty: decision === 'approved'
          ? confirmationLines.reduce((sum, line) => sum + Math.max(0, poLines.get(line.poLineId)!.orderedQty - line.confirmedQty), 0)
          : 0,
        exactTransitionTime: true,
      },
    });
    if (decision === 'approved') this.recordPoStageEvent({
      poId: po.document.id, stage: 'fulfilment_production', eventType: 'stage_entered', state: 'active', occurredAt: at,
      sourceKind: 'approval', sourceId: approval.id, actorId: input.actorId,
      evidence: {
        causedByStage: 'supplier_commitment', approvalId: approval.id, confirmationId: confirmation.document.id,
        shortfallDisposition: shortfallDisposition ?? null, exactTransitionTime: true,
      },
    });
    const updatedConfirmation = { ...confirmation.document, status: decision === 'approved' ? 'confirmed' : 'rejected', updatedAt: at };
    this.updateExecutionDocument('confirmation', updatedConfirmation, confirmation.version);
    const aggregate = this.updateExecutionDocument('purchase_order', {
      ...po.document, status: decision === 'approved' ? 'confirmed' : 'rejected', updatedAt: at,
    }, po.version);
    return { action: input.action, aggregate, createdDocuments: [updatedConfirmation], createdLines: [], approval: decided, replayed: false };
  }

  private executeRecordProductionProgress(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion,
      ['confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped'], input.action);
    const evidence = requireFulfilmentEvidence(this.db, this.tenantId, po.document, input);
    const externalId = requireRepositoryText(input.supplierReference ?? '', 'supplierReference');
    if (this.db.prepare(`SELECT 1 FROM procurement_documents
      WHERE tenant_id=? AND kind='production_progress' AND source_system=? AND external_id=?`).get(this.tenantId, evidence.sourceSystem, externalId)) {
      throw new ProcurementValidationError('INVALID_INPUT', '生产进度证据编号已存在');
    }
    const inputs = requireExecutionLines(input.lines);
    assertUniqueExecutionLineIds(inputs);
    const poLines = new Map(this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id).map((line) => [line.id, line]));
    const progressId = `production-progress:${randomUUID()}`;
    const progressLines: ProductionProgressLine[] = inputs.map((line, index) => {
      const poLine = poLines.get(line.poLineId);
      if (!poLine) throw new ProcurementValidationError('INVALID_INPUT', '生产进度行不属于 PO');
      const progressStatus = requireProductionProgressStatus(line.progressStatus);
      const completionPercent = line.completionPercent;
      if (typeof completionPercent !== 'number' || !Number.isFinite(completionPercent) || completionPercent < 0 || completionPercent > 100) {
        throw new ProcurementValidationError('INVALID_INPUT', '生产完成度必须是 0 到 100 的有限数');
      }
      const completedQty = line.quantity;
      if (!Number.isFinite(completedQty) || completedQty < 0) throw new ProcurementValidationError('INVALID_INPUT', '已完成数量必须是非负有限数');
      const projection = this.getPurchaseOrderLineQuantityProjection(poLine.id);
      const effectiveQty = Math.max(0, poLine.orderedQty - (projection?.cancelledQty ?? 0));
      if (completedQty > effectiveQty) throw new ProcurementValidationError('INVALID_INPUT', '已完成数量不能超过该行有效订购数量');
      if (progressStatus === 'ready_to_ship' && (completionPercent !== 100 || completedQty < effectiveQty)) {
        throw new ProcurementValidationError('INVALID_INPUT', '标记待发运时，该行完成度必须为 100% 且完成数量覆盖有效订购量');
      }
      const expectedReadyAt = line.expectedReadyAt ? requireIsoDate(line.expectedReadyAt, 'expectedReadyAt') : undefined;
      if ((progressStatus === 'delayed' || progressStatus === 'blocked') && !line.note?.trim()) {
        throw new ProcurementValidationError('INVALID_INPUT', '延期或受阻进度必须说明原因');
      }
      return {
        id: `production-progress-line:${randomUUID()}`, progressId, poLineId: poLine.id,
        lineNumber: poLine.lineNumber || String((index + 1) * 10), itemId: poLine.itemId,
        ...(poLine.description ? { description: poLine.description } : {}), uom: poLine.uom,
        progressStatus, completionPercent, completedQty,
        ...(expectedReadyAt ? { expectedReadyAt } : {}),
        ...(line.note?.trim() ? { note: requireRepositoryText(line.note, 'note') } : {}),
      };
    });
    const overallStatus = productionOverallStatus(progressLines.map((line) => line.progressStatus));
    const progress: ProductionProgress = {
      id: progressId, tenantId: this.tenantId, sourceSystem: evidence.sourceSystem, externalId,
      status: 'recorded', createdAt: at, updatedAt: at, poId: po.document.id, supplierId: po.document.supplierId,
      reportedAt: at, overallStatus, evidenceSource: evidence.source,
      evidenceReference: evidence.evidenceReference, ...evidence.verificationFields,
    };
    this.insertExecutionDocument('production_progress', progress);
    for (const line of progressLines) this.insertExecutionLine('production_progress_line', progress.id, line);

    const latestByPoLine = new Map<string, ProductionProgressLine>();
    const storedLines = this.db.prepare(`SELECT l.json FROM procurement_lines l
      JOIN procurement_documents d ON d.tenant_id=l.tenant_id AND d.id=l.document_id AND d.kind='production_progress'
      WHERE l.tenant_id=? AND l.kind='production_progress_line' AND json_extract(d.json,'$.poId')=?
      ORDER BY d.created_at DESC,d.id DESC,l.line_number,l.id`).all(this.tenantId, po.document.id) as Array<{ json: string }>;
    for (const row of storedLines) {
      const line = JSON.parse(row.json) as ProductionProgressLine;
      if (!latestByPoLine.has(line.poLineId)) latestByPoLine.set(line.poLineId, line);
    }
    const allReady = [...poLines.values()].every((line) => {
      const projection = this.getPurchaseOrderLineQuantityProjection(line.id);
      const effectiveQty = Math.max(0, line.orderedQty - (projection?.cancelledQty ?? 0));
      if (effectiveQty === 0) return true;
      const latest = latestByPoLine.get(line.id);
      return latest?.progressStatus === 'ready_to_ship' && latest.completionPercent === 100 && latest.completedQty >= effectiveQty;
    });
    const blocked = progressLines.some((line) => line.progressStatus === 'delayed' || line.progressStatus === 'blocked');
    this.recordPoStageEvent({
      poId: po.document.id, stage: 'fulfilment_production',
      eventType: allReady ? 'production_ready_to_ship' : blocked ? 'production_progress_blocked' : 'production_progress_recorded',
      state: allReady ? 'completed' : blocked ? 'blocked' : 'active', occurredAt: at,
      sourceKind: `${evidence.source}_production_progress`, sourceId: progress.id, actorId: input.actorId,
      evidence: { productionProgressId: progress.id, overallStatus, lineCount: progressLines.length,
        allLinesReadyToShip: allReady, evidenceSource: evidence.source, evidenceReference: evidence.evidenceReference,
        ...evidence.verificationFields, exactTransitionTime: allReady },
    });
    const nextStatus = po.document.status === 'partially_shipped' ? 'partially_shipped' : allReady ? 'awaiting_shipment' : 'in_production';
    const aggregate = this.updateExecutionDocument('purchase_order', { ...po.document, status: nextStatus, updatedAt: at }, po.version);
    return { action: input.action, aggregate, createdDocuments: [progress], createdLines: progressLines, replayed: false };
  }

  private executeRecordShipment(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion,
      ['confirmed', 'in_production', 'awaiting_shipment', 'partially_shipped'], input.action);
    const evidence = requireFulfilmentEvidence(this.db, this.tenantId, po.document, input);
    const externalId = requireRepositoryText(input.supplierReference ?? '', 'supplierReference');
    if (this.db.prepare(`SELECT 1 FROM procurement_documents
      WHERE tenant_id=? AND kind='shipment' AND source_system=? AND external_id=?`).get(this.tenantId, evidence.sourceSystem, externalId)) {
      throw new ProcurementValidationError('INVALID_INPUT', '供应商发运单号已存在');
    }
    const inputs = requireExecutionLines(input.lines);
    const poLines = new Map(this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id).map((line) => [line.id, line]));
    assertUniqueExecutionLineIds(inputs);
    const shipmentId = `shipment:${randomUUID()}`;
    const shipmentLines: ShipmentLine[] = inputs.map((line, index) => {
      const poLine = poLines.get(line.poLineId);
      if (!poLine) throw new ProcurementValidationError('INVALID_INPUT', '发运行不属于 PO');
      const quantity = requirePositiveQuantity(line.quantity, 'shipped quantity');
      this.assertCumulativeWithin(poLine, 'shipped', quantity, 'confirmed');
      return { id: `shipment-line:${randomUUID()}`, shipmentId, poLineId: poLine.id,
        lineNumber: poLine.lineNumber || String((index + 1) * 10), itemId: poLine.itemId,
        ...(poLine.description ? { description: poLine.description } : {}), uom: poLine.uom, shippedQty: quantity };
    });
    const shipment: Shipment = {
      id: shipmentId, tenantId: this.tenantId, sourceSystem: evidence.sourceSystem, externalId,
      status: 'shipped', createdAt: at, updatedAt: at, poId: po.document.id, supplierId: po.document.supplierId,
      shippedAt: at, ...(input.carrier ? { carrier: requireRepositoryText(input.carrier, 'carrier') } : {}),
      ...(input.trackingNumber ? { trackingNumber: requireRepositoryText(input.trackingNumber, 'trackingNumber') } : {}),
      ...(input.estimatedArrivalAt ? { estimatedArrivalAt: requireIsoDate(input.estimatedArrivalAt, 'estimatedArrivalAt') } : {}),
      evidenceSource: evidence.source, evidenceReference: evidence.evidenceReference, ...evidence.verificationFields,
    };
    this.insertExecutionDocument('shipment', shipment);
    for (const line of shipmentLines) {
      this.insertExecutionLine('shipment_line', shipment.id, line);
      this.applyExecutionQuantity(poLines.get(line.poLineId)!, 'shipped', line.shippedQty, input, at);
    }
    const complete = [...poLines.values()].every((line) => {
      const projection = this.getPurchaseOrderLineQuantityProjection(line.id);
      return (projection?.shippedQty ?? 0) + (projection?.cancelledQty ?? 0) >= line.orderedQty;
    });
    this.recordPoStageEvent({
      poId: po.document.id, stage: 'fulfilment_production', eventType: complete ? 'fulfilment_completed_by_full_shipment' : 'partial_shipment_progress_recorded',
      state: complete ? 'completed' : 'active', occurredAt: at,
      sourceKind: `${evidence.source}_shipment`, sourceId: shipment.id, actorId: input.actorId,
      evidence: { shipmentId: shipment.id, shipmentComplete: complete, lineCount: shipmentLines.length,
        estimatedArrivalAt: shipment.estimatedArrivalAt ?? null,
        evidenceSource: evidence.source, evidenceReference: evidence.evidenceReference,
        ...evidence.verificationFields, exactTransitionTime: true },
    });
    this.recordPoStageEvent({
      poId: po.document.id, stage: 'dispatch_transit', eventType: complete ? 'full_shipment_recorded' : 'partial_shipment_recorded', state: 'active', occurredAt: at,
      sourceKind: `${evidence.source}_shipment`, sourceId: shipment.id, actorId: input.actorId,
      evidence: { shipmentId: shipment.id, shipmentComplete: complete, carrier: shipment.carrier ?? null,
        trackingNumber: shipment.trackingNumber ?? null, estimatedArrivalAt: shipment.estimatedArrivalAt ?? null,
        evidenceSource: evidence.source,
        evidenceReference: evidence.evidenceReference, ...evidence.verificationFields, exactTransitionTime: true },
    });
    const aggregate = this.updateExecutionDocument('purchase_order', { ...po.document, status: complete ? 'shipped' : 'partially_shipped', updatedAt: at }, po.version);
    return { action: input.action, aggregate, createdDocuments: [shipment], createdLines: shipmentLines, replayed: false };
  }

  private executeRecordTransportEvent(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion,
      ['partially_shipped', 'shipped', 'partially_received'], input.action);
    const verification = requireManualVerification(input);
    const shipmentId = requireRepositoryText(input.shipmentId ?? '', 'shipmentId');
    const shipment = this.getDocument<Shipment>('shipment', shipmentId);
    if (!shipment || shipment.document.poId !== po.document.id) {
      throw new ProcurementValidationError('INVALID_INPUT', '运输节点关联的 Shipment 不属于当前 PO');
    }
    const eventCode = requireTransportEventCode(input.eventCode);
    if (eventCode.startsWith('customs_') && procurementRouteForPo(this.db, this.tenantId, po.document) !== 'import') {
      throw new ProcurementValidationError('INVALID_INPUT', '清关节点只允许记录在有明确进口路线证据的 PO');
    }
    const eventOccurredAt = requireIsoDate(input.eventOccurredAt ?? '', 'eventOccurredAt');
    if (Date.parse(eventOccurredAt) > Date.parse(at) + 300_000) {
      throw new ProcurementValidationError('INVALID_INPUT', '实际运输节点时间不能晚于当前时间超过 5 分钟');
    }
    const externalId = requireRepositoryText(input.eventReference ?? '', 'eventReference');
    if (this.db.prepare(`SELECT 1 FROM procurement_documents
      WHERE tenant_id=? AND kind='transport_event' AND source_system='readywork-manual-verification' AND external_id=?`).get(this.tenantId, externalId)) {
      throw new ProcurementValidationError('INVALID_INPUT', '运输节点证据编号已存在');
    }
    const transportEvent: TransportEvent = {
      id: `transport-event:${randomUUID()}`, tenantId: this.tenantId,
      sourceSystem: 'readywork-manual-verification', externalId, status: 'recorded',
      createdAt: at, updatedAt: at, poId: po.document.id, shipmentId,
      eventCode, occurredAt: eventOccurredAt,
      ...(input.location ? { location: requireRepositoryText(input.location, 'location') } : {}),
      ...(input.estimatedArrivalAt ? { estimatedArrivalAt: requireIsoDate(input.estimatedArrivalAt, 'estimatedArrivalAt') } : {}),
      ...(input.carrierReference ? { carrierReference: requireRepositoryText(input.carrierReference, 'carrierReference') } : {}),
      evidenceSource: 'manual_verified', evidenceReference: verification.evidenceReference,
      verifiedBy: input.actorId, verificationReason: verification.reason,
    };
    this.insertExecutionDocument('transport_event', transportEvent);
    const blocked = eventCode === 'customs_held' || eventCode === 'exception';
    this.recordPoStageEvent({
      poId: po.document.id, stage: 'dispatch_transit', eventType: `transport_${eventCode}`,
      state: blocked ? 'blocked' : 'active', occurredAt: eventOccurredAt,
      sourceKind: 'manual_verified_transport_event', sourceId: transportEvent.id, actorId: input.actorId,
      evidence: {
        transportEventId: transportEvent.id, shipmentId, eventCode,
        location: transportEvent.location ?? null, estimatedArrivalAt: transportEvent.estimatedArrivalAt ?? null,
        carrierReference: transportEvent.carrierReference ?? null, evidenceSource: 'manual_verified',
        evidenceReference: verification.evidenceReference, verifiedBy: input.actorId,
        verificationReason: verification.reason, exactTransitionTime: true,
        carrierDeliveryIsNotGrn: eventCode === 'delivered',
      },
    });
    const aggregate = this.updateExecutionDocument('purchase_order', { ...po.document, updatedAt: at }, po.version);
    return { action: input.action, aggregate, createdDocuments: [transportEvent], createdLines: [], replayed: false };
  }

  private executeRecordReceipt(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion,
      ['partially_shipped', 'shipped', 'partially_received'], input.action);
    const verification = requireManualVerification(input);
    const externalId = requireRepositoryText(input.supplierReference ?? '', 'supplierReference');
    if (this.db.prepare(`SELECT 1 FROM procurement_documents
      WHERE tenant_id=? AND kind='receipt' AND source_system='readywork-manual-verification' AND external_id=?`).get(this.tenantId, externalId)) {
      throw new ProcurementValidationError('INVALID_INPUT', 'GRN / 收货单号已存在');
    }
    const inputs = requireExecutionLines(input.lines);
    const poLines = new Map(this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id).map((line) => [line.id, line]));
    assertUniqueExecutionLineIds(inputs);
    let shipment: VersionedProcurementDocument<Shipment> | undefined;
    if (input.shipmentId) {
      shipment = this.getDocument<Shipment>('shipment', input.shipmentId);
      if (!shipment || shipment.document.poId !== po.document.id) throw new ProcurementValidationError('INVALID_INPUT', '收货关联的发运单不属于 PO');
    }
    const receiptId = `receipt:${randomUUID()}`;
    const receiptLines: ReceiptLine[] = inputs.map((line, index) => {
      const poLine = poLines.get(line.poLineId);
      if (!poLine) throw new ProcurementValidationError('INVALID_INPUT', '收货行不属于 PO');
      const quantity = requirePositiveQuantity(line.quantity, 'received quantity');
      this.assertCumulativeWithin(poLine, 'received', quantity, 'shipped');
      return { id: `receipt-line:${randomUUID()}`, receiptId, poLineId: poLine.id,
        lineNumber: poLine.lineNumber || String((index + 1) * 10), itemId: poLine.itemId,
        ...(poLine.description ? { description: poLine.description } : {}), uom: poLine.uom, receivedQty: quantity };
    });
    const incomingByLine = new Map(receiptLines.map((line) => [line.poLineId, line.receivedQty]));
    const wouldComplete = [...poLines.values()].every((line) => {
      const projection = this.getPurchaseOrderLineQuantityProjection(line.id);
      return (projection?.receivedQty ?? 0) + (projection?.cancelledQty ?? 0) + (incomingByLine.get(line.id) ?? 0) >= line.orderedQty;
    });
    if (wouldComplete) assertImportDocumentCompletionGate(this.db, this.tenantId, po.document.id, po.document as PurchaseOrder & Record<string, unknown>, at);
    const receipt: Receipt = {
      id: receiptId, tenantId: this.tenantId, sourceSystem: 'readywork-manual-verification', externalId,
      status: 'received', createdAt: at, updatedAt: at, poId: po.document.id,
      ...(shipment ? { shipmentId: shipment.document.id } : {}), warehouseId: requireRepositoryText(input.warehouseId ?? '', 'warehouseId'), receivedAt: at,
      evidenceSource: 'manual_verified', evidenceReference: verification.evidenceReference,
      verifiedBy: input.actorId, verificationReason: verification.reason,
    };
    this.insertExecutionDocument('receipt', receipt);
    for (const line of receiptLines) {
      this.insertExecutionLine('receipt_line', receipt.id, line);
      this.applyExecutionQuantity(poLines.get(line.poLineId)!, 'received', line.receivedQty, input, at);
    }
    const complete = [...poLines.values()].every((line) => {
      const projection = this.getPurchaseOrderLineQuantityProjection(line.id);
      return (projection?.receivedQty ?? 0) + (projection?.cancelledQty ?? 0) >= line.orderedQty;
    });
    this.recordPoStageEvent({
      poId: po.document.id, stage: 'dispatch_transit', eventType: complete ? 'final_arrival_recorded' : 'partial_arrival_recorded',
      state: complete ? 'completed' : 'active', occurredAt: at, sourceKind: 'manual_verified_grn', sourceId: receipt.id, actorId: input.actorId,
      evidence: { receiptId: receipt.id, shipmentId: receipt.shipmentId ?? null, receiptComplete: complete,
        evidenceSource: 'manual_verified', evidenceReference: verification.evidenceReference,
        verifiedBy: input.actorId, verificationReason: verification.reason, exactTransitionTime: true },
    });
    this.recordPoStageEvent({
      poId: po.document.id, stage: 'delivery_grn', eventType: complete ? 'grn_completed' : 'partial_grn_recorded',
      state: complete ? 'completed' : 'active', occurredAt: at, sourceKind: 'manual_verified_grn', sourceId: receipt.id, actorId: input.actorId,
      evidence: { receiptId: receipt.id, warehouseId: receipt.warehouseId, receiptComplete: complete,
        evidenceSource: 'manual_verified', evidenceReference: verification.evidenceReference,
        verifiedBy: input.actorId, verificationReason: verification.reason, exactTransitionTime: true },
    });
    const aggregate = this.updateExecutionDocument('purchase_order', { ...po.document, status: complete ? 'received' : 'partially_received', updatedAt: at }, po.version);
    return { action: input.action, aggregate, createdDocuments: [receipt], createdLines: receiptLines, replayed: false };
  }

  private executeRecordInvoice(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const po = this.executionDocument<PurchaseOrder>('purchase_order', input.aggregateId, input.expectedVersion,
      ['partially_received', 'received'], input.action);
    const inputs = requireExecutionLines(input.lines);
    const poLines = new Map(this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id).map((line) => [line.id, line]));
    assertUniqueExecutionLineIds(inputs);
    const invoiceId = `invoice:${randomUUID()}`;
    const currency = requireRepositoryText(input.currency ?? '', 'currency').toUpperCase();
    if (currency !== po.document.currency) throw new ProcurementValidationError('INVALID_INPUT', '发票币种与 PO 不一致');
    const invoiceNumber = requireRepositoryText(input.invoiceNumber ?? '', 'invoiceNumber');
    const duplicateInvoice = this.db.prepare(`
      SELECT 1 FROM procurement_documents
      WHERE tenant_id=? AND kind='invoice' AND json_extract(json,'$.supplierId')=? AND json_extract(json,'$.invoiceNumber')=?
    `).get(this.tenantId, po.document.supplierId, invoiceNumber);
    if (duplicateInvoice) throw new ProcurementDuplicateInvoiceError(invoiceNumber);
    const invoiceLines: SupplierInvoiceLine[] = inputs.map((line, index) => {
      const poLine = poLines.get(line.poLineId);
      if (!poLine) throw new ProcurementValidationError('INVALID_INPUT', '发票行不属于 PO');
      const quantity = requirePositiveQuantity(line.quantity, 'invoiced quantity');
      this.assertCumulativeWithin(poLine, 'invoiced', quantity, 'received');
      const unitPrice = line.unitPrice;
      const netAmount = line.netAmount;
      if (unitPrice === undefined || !Number.isFinite(unitPrice) || unitPrice < 0 || netAmount === undefined || !Number.isFinite(netAmount) || netAmount < 0) {
        throw new ProcurementValidationError('INVALID_INPUT', '发票行单价和净额必须是非负有限数');
      }
      const allocations = line.receiptAllocations ?? [];
      const allocated = allocations.reduce((sum, item) => sum + requirePositiveQuantity(item.allocatedQty, 'allocatedQty'), 0);
      if (allocated !== quantity) throw new ProcurementValidationError('INVALID_INPUT', '收货分配数量必须等于发票数量');
      for (const allocation of allocations) {
        const receiptLine = this.getLine<ReceiptLine>('receipt_line', allocation.receiptLineId);
        if (!receiptLine || receiptLine.poLineId !== poLine.id) throw new ProcurementValidationError('INVALID_INPUT', '发票收货分配关联错误');
      }
      return { id: `invoice-line:${randomUUID()}`, invoiceId, poLineId: poLine.id,
        lineNumber: poLine.lineNumber || String((index + 1) * 10), itemId: poLine.itemId,
        ...(poLine.description ? { description: poLine.description } : {}), uom: poLine.uom,
        receiptAllocations: allocations.map((item) => ({ ...item })), invoicedQty: quantity,
        unitPrice, netAmount, currency };
    });
    const invoice: SupplierInvoice = {
      id: invoiceId, tenantId: this.tenantId, sourceSystem: 'supplier', externalId: invoiceId,
      status: 'received', createdAt: at, updatedAt: at, supplierId: po.document.supplierId,
      invoiceNumber, currency,
      invoiceDate: requireIsoDate(input.invoiceDate ?? '', 'invoiceDate'),
    };
    this.insertExecutionDocument('invoice', invoice);
    for (const line of invoiceLines) {
      this.insertExecutionLine('invoice_line', invoice.id, line);
      this.applyExecutionQuantity(poLines.get(line.poLineId!)!, 'invoiced', line.invoicedQty, input, at);
    }
    const aggregate = this.updateExecutionDocument('purchase_order', { ...po.document, updatedAt: at }, po.version);
    return { action: input.action, aggregate, createdDocuments: [invoice], createdLines: invoiceLines, replayed: false };
  }

  private executeMatchInvoice(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const invoice = this.executionDocument<SupplierInvoice>('invoice', input.aggregateId, input.expectedVersion, ['received', 'three_way_match'], input.action);
    const poId = requireRepositoryText(input.poId ?? '', 'poId');
    const po = this.getDocument<PurchaseOrder>('purchase_order', poId);
    if (!po || po.document.supplierId !== invoice.document.supplierId || po.document.currency !== invoice.document.currency) {
      throw new ProcurementValidationError('INVALID_INPUT', '发票与 PO 供应商或币种不一致');
    }
    if (!input.matchPolicy) throw new ProcurementValidationError('INVALID_INPUT', 'matchPolicy 必填');
    const invoiceLines = this.listLines<SupplierInvoiceLine>('invoice_line', invoice.document.id);
    if (!invoiceLines.length) throw new ProcurementValidationError('INVALID_INPUT', '发票没有可匹配的行');
    const matchId = `match:${randomUUID()}`;
    const matchLines: ThreeWayMatchLine[] = invoiceLines.map((invoiceLine) => {
      const poLine = invoiceLine.poLineId ? this.getLine<PurchaseOrderLine>('purchase_order_line', invoiceLine.poLineId) : undefined;
      if (!poLine || poLine.poId !== po.document.id) throw new ProcurementValidationError('INVALID_INPUT', '发票行缺少合法 PO 行');
      const receipts = (invoiceLine.receiptAllocations ?? []).map((allocation) => {
        const line = this.getLine<ReceiptLine>('receipt_line', allocation.receiptLineId);
        if (!line) throw new ProcurementValidationError('INVALID_INPUT', '收货行不存在');
        return line;
      });
      const matched = matchPurchaseOrderLine({ poLine, receiptLines: receipts, invoiceLine, policy: input.matchPolicy! });
      return { id: `match-line:${randomUUID()}`, matchId, poLineId: poLine.id,
        lineNumber: invoiceLine.lineNumber, itemId: invoiceLine.itemId,
        ...(invoiceLine.description ? { description: invoiceLine.description } : {}), uom: invoiceLine.uom,
        receiptAllocations: matched.receiptAllocations, invoiceLineId: invoiceLine.id,
        disposition: matched.disposition, variances: matched.variances };
    });
    const severity: Record<LineMatchDisposition, number> = { exact_match: 0, within_tolerance: 1, approval_required: 2, severe_exception: 3 };
    const resultDisposition = [...matchLines].sort((a, b) => severity[b.disposition] - severity[a.disposition])[0]!.disposition;
    const match: ThreeWayMatch = {
      id: matchId, tenantId: this.tenantId, sourceSystem: 'readywork', externalId: matchId,
      status: resultDisposition === 'severe_exception' ? 'exception' : 'pending_approval', createdAt: at, updatedAt: at,
      poId: po.document.id, invoiceId: invoice.document.id, result: resultDisposition,
    };
    this.insertExecutionDocument('match', match);
    for (const line of matchLines) this.insertExecutionLine('match_line', match.id, line);
    const approval = resultDisposition === 'severe_exception' ? undefined : this.insertExecutionApproval({
      id: `procurement-approval:${randomUUID()}`, tenantId: this.tenantId, kind: 'accounts_payable',
      objectId: invoice.document.id, poId: po.document.id, status: 'pending', requestedBy: input.actorId,
      requestedAt: at, reason: `行级三单匹配结果: ${resultDisposition}`,
    });
    const aggregate = this.updateExecutionDocument('invoice', {
      ...invoice.document, status: resultDisposition === 'severe_exception' ? 'exception' : 'pending_approval', updatedAt: at,
    }, invoice.version);
    return { action: input.action, aggregate, createdDocuments: [match], createdLines: matchLines, ...(approval ? { approval } : {}), replayed: false };
  }

  private executeDecideAp(input: ProcurementExecutionMutationInput, at: string): ProcurementExecutionMutationResult {
    const approval = this.executionApprovalForDecision(input, 'accounts_payable');
    const invoice = this.executionDocument<SupplierInvoice>('invoice', approval.objectId, input.expectedVersion, ['pending_approval'], input.action);
    const decision = requireExecutionDecision(input.decision);
    const decided = this.decideExecutionApproval(approval, decision, input.actorId, at, input.reason);
    const aggregate = this.updateExecutionDocument('invoice', {
      ...invoice.document, status: decision === 'approved' ? 'payable_approved' : 'exception', updatedAt: at,
    }, invoice.version);
    const outbox = decision === 'approved' ? this.insertExecutionOutbox(input, at, 'erp', 'invoice.update', invoice.document.id, {
      invoiceId: invoice.document.id, status: 'payable_approved',
    }) : undefined;
    return { action: input.action, aggregate, createdDocuments: [], createdLines: [], approval: decided, ...(outbox ? { outbox } : {}), replayed: false };
  }

  private executionDocument<T extends ProcurementDocument>(
    kind: ProcurementDocumentKind,
    id: EntityId,
    expectedVersion: number,
    allowedStatuses: readonly string[],
    action: ProcurementExecutionAction,
  ): VersionedProcurementDocument<T> {
    const stored = this.getDocument<T>(kind, id);
    if (!stored) throw new ProcurementValidationError('INVALID_INPUT', `${kind} 不存在`);
    if (stored.version !== expectedVersion) throw new ProcurementExecutionVersionConflictError(expectedVersion, stored.version);
    if (!allowedStatuses.includes(stored.document.status)) throw new ProcurementExecutionStateConflictError(stored.document.status, action);
    return stored;
  }

  private updateExecutionDocument<T extends ProcurementDocument>(
    kind: ProcurementDocumentKind,
    document: T,
    currentVersion: number,
  ): VersionedProcurementDocument<T> {
    const nextVersion = currentVersion + 1;
    const changed = this.db.prepare(`
      UPDATE procurement_documents SET status=?,version=?,json=?,updated_at=?
      WHERE tenant_id=? AND kind=? AND id=? AND version=?
    `).run(document.status, nextVersion, JSON.stringify(document), document.updatedAt, this.tenantId, kind, document.id, currentVersion);
    if (Number(changed.changes) !== 1) throw new ProcurementExecutionVersionConflictError(currentVersion, currentVersion + 1);
    this.enqueueDocumentProjection(kind, document, nextVersion);
    return { document, version: nextVersion };
  }

  private insertExecutionDocument<T extends ProcurementDocument>(kind: ProcurementDocumentKind, document: T): void {
    if (document.tenantId !== this.tenantId) throw new ProcurementValidationError('INVALID_INPUT', '执行单据与租户不一致');
    this.db.prepare(`
      INSERT INTO procurement_documents
        (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?,?)
    `).run(this.tenantId, kind, document.id, document.sourceSystem, document.externalId,
      document.status, JSON.stringify(document), document.createdAt, document.updatedAt);
    this.enqueueDocumentProjection(kind, document, 1);
  }

  private insertExecutionLine<T extends ProcurementLine>(kind: ProcurementLineKind, documentId: EntityId, line: T): void {
    this.db.prepare(`INSERT INTO procurement_lines (tenant_id,kind,id,document_id,line_number,json) VALUES (?,?,?,?,?,?)`)
      .run(this.tenantId, kind, line.id, documentId, line.lineNumber, JSON.stringify(line));
    const parent = this.db.prepare(`SELECT updated_at FROM procurement_documents
      WHERE tenant_id=? AND kind=? AND id=?`).get(this.tenantId, LINE_DOCUMENT_KIND[kind], documentId) as { updated_at: string };
    this.enqueueLineProjection(kind, line, parent.updated_at);
  }

  private insertExecutionApproval(approval: ProcurementExecutionApproval): ProcurementExecutionApproval {
    this.db.prepare(`
      INSERT INTO procurement_execution_approvals
        (tenant_id,id,kind,object_id,status,json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(this.tenantId, approval.id, approval.kind, approval.objectId, approval.status,
      JSON.stringify(approval), approval.requestedAt, approval.requestedAt);
    return approval;
  }

  private executionApprovalForDecision(
    input: ProcurementExecutionMutationInput,
    kind: ProcurementExecutionApproval['kind'],
  ): ProcurementExecutionApproval {
    const approval = this.getExecutionApproval(input.aggregateId);
    if (!approval || approval.kind !== kind) throw new ProcurementValidationError('INVALID_INPUT', '审批不存在或类型不匹配');
    if (approval.status !== 'pending') throw new ProcurementExecutionStateConflictError(approval.status, input.action);
    return approval;
  }

  private decideExecutionApproval(
    approval: ProcurementExecutionApproval,
    decision: 'approved' | 'rejected',
    actorId: EntityId,
    at: string,
    reason?: string,
    shortfallDisposition?: 'cancel_remainder',
  ): ProcurementExecutionApproval {
    const decided: ProcurementExecutionApproval = {
      ...approval, status: decision, decidedBy: actorId, decidedAt: at,
      ...(reason ? { decisionReason: requireRepositoryText(reason, 'reason') } : {}),
      ...(shortfallDisposition ? { shortfallDisposition } : {}),
    };
    this.db.prepare(`
      UPDATE procurement_execution_approvals SET status=?,json=?,updated_at=?
      WHERE tenant_id=? AND id=? AND status='pending'
    `).run(decided.status, JSON.stringify(decided), at, this.tenantId, decided.id);
    return decided;
  }

  private insertExecutionOutbox(
    input: ProcurementExecutionMutationInput,
    at: string,
    channel: ProcurementOutboxMessage['channel'],
    action: string,
    aggregateId: EntityId,
    payload: Readonly<Record<string, unknown>>,
  ): ProcurementOutboxMessage {
    const connectorId = requireRepositoryText(input.connectorId ?? channel, 'connectorId');
    const ready = input.connectorReady === true;
    const outbox: ProcurementOutboxMessage = {
      id: `procurement-outbox:${randomUUID()}`, tenantId: this.tenantId, channel, connectorId, action,
      aggregateId, idempotencyKey: `${input.action}:${input.idempotencyKey}`,
      status: ready ? 'pending' : 'blocked', payload, attempts: 0, createdAt: at, updatedAt: at,
      ...(!ready ? { error: `${connectorId} connector is not configured` } : {}),
    };
    this.db.prepare(`
      INSERT INTO procurement_outbox
        (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(this.tenantId, outbox.id, channel, connectorId, action, aggregateId, outbox.idempotencyKey,
      outbox.status, JSON.stringify(payload), JSON.stringify(outbox), at, at);
    this.enqueueOutboxProjection(outbox);
    return outbox;
  }

  private applyCompletedOutboxFact(outbox: ProcurementOutboxMessage, at: string): void {
    if (outbox.action === 'purchase_order.cancel' && outbox.channel === 'erp') {
      const amendmentId = requireRepositoryText(typeof outbox.payload['amendmentId'] === 'string' ? outbox.payload['amendmentId'] : '', 'outbox.payload.amendmentId');
      const readbackMatches = outbox.connectorResult?.['readbackMatches'];
      if (typeof readbackMatches !== 'boolean') {
        throw new ProcurementValidationError('INVALID_INPUT', 'Odoo cancellation completion requires an explicit readback match result');
      }
      const dispatched = transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
        id: amendmentId, state: 'dispatched', actorId: `connector:${outbox.connectorId}`,
        reason: 'Odoo cancellation dispatched; awaiting authoritative readback', outboxId: outbox.id, at,
      });
      if (!readbackMatches) {
        transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
          id: dispatched.id, state: 'unknown', actorId: `connector:${outbox.connectorId}`,
          reason: 'Odoo cancellation readback does not show cancelled; manual review required', outboxId: outbox.id, at,
        });
        this.insertOutboxFailureException({ ...outbox, error: 'Odoo cancellation authoritative readback did not match' }, at, true);
        return;
      }
      const po = this.getDocument<PurchaseOrder>('purchase_order', outbox.aggregateId);
      if (!po) throw new ProcurementValidationError('INVALID_INPUT', 'cancellation 对应的采购订单不存在');
      const sourcePoVersion = requirePositiveSafeInteger(outbox.payload['sourcePoVersion'], 'outbox.payload.sourcePoVersion');
      if (po.version !== sourcePoVersion) throw new ProcurementExecutionVersionConflictError(sourcePoVersion, po.version);
      const actorId = requireRepositoryText(typeof outbox.payload['actorId'] === 'string' ? outbox.payload['actorId'] : '', 'outbox.payload.actorId');
      const reason = requireRepositoryText(typeof outbox.payload['reason'] === 'string' ? outbox.payload['reason'] : '', 'outbox.payload.reason');
      const aggregate = this.updateExecutionDocument('purchase_order', { ...po.document, status: 'cancelled', updatedAt: at }, po.version);
      this.appendPurchaseOrderCancellationQuantities(po.document.id, {
        action: 'cancel_po', idempotencyKey: amendmentId, payloadHash: amendmentId, actorId,
        permission: 'operate_and_approve', aggregateId: po.document.id, expectedVersion: sourcePoVersion, occurredAt: at,
      }, at);
      transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
        id: dispatched.id, state: 'applied', actorId: `connector:${outbox.connectorId}`,
        reason: 'Odoo authoritative readback confirms cancellation', outboxId: outbox.id,
        receiptReference: typeof outbox.connectorResult?.['receiptReference'] === 'string' ? outbox.connectorResult['receiptReference'] : outbox.id, at,
      });
      const activity: Activity = {
        id: `activity:po-cancelled:${amendmentId}`, at, objectId: po.document.id, actor: `connector:${outbox.connectorId}`,
        action: 'purchase_order.cancelled', summary: '采购订单已经 Odoo 权威读回确认取消',
        context: { requestId: amendmentId, outboxId: outbox.id, reason, sourcePurchaseOrderVersion: sourcePoVersion, resultPurchaseOrderVersion: aggregate.version, source: 'odoo' },
      };
      this.db.prepare(`INSERT INTO runtime_activities
        (tenant_id,id,object_id,json,updated_at) VALUES (?,?,?,?,?)`)
        .run(this.tenantId, activity.id, activity.objectId ?? null, JSON.stringify(activity), at);
      return;
    }
    if (outbox.action === 'purchase_order.amend' && outbox.channel === 'erp') {
      const amendmentId = requireRepositoryText(typeof outbox.payload['amendmentId'] === 'string' ? outbox.payload['amendmentId'] : '', 'outbox.payload.amendmentId');
      const readbackMatches = outbox.connectorResult?.['readbackMatches'];
      if (typeof readbackMatches !== 'boolean') {
        throw new ProcurementValidationError('INVALID_INPUT', 'Odoo amendment completion requires an explicit readback match result');
      }
      const dispatched = transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
        id: amendmentId, state: 'dispatched', actorId: `connector:${outbox.connectorId}`,
        reason: 'Odoo amendment dispatched; awaiting authoritative readback', outboxId: outbox.id, at,
      });
      if (readbackMatches) {
        const po = this.getDocument<PurchaseOrder>('purchase_order', outbox.aggregateId);
        if (!po) throw new ProcurementValidationError('INVALID_INPUT', 'amendment 对应的采购订单不存在');
        const sourcePoVersion = requirePositiveSafeInteger(outbox.payload['sourcePoVersion'], 'outbox.payload.sourcePoVersion');
        if (po.version !== sourcePoVersion) throw new ProcurementExecutionVersionConflictError(sourcePoVersion, po.version);
        const patch = requirePurchaseOrderEditPatch(outbox.payload['patch'] as PurchaseOrderEditPatch);
        if (Object.keys(patch).some((field) => field !== 'requiredInHouseAt') || patch.requiredInHouseAt === undefined) {
          throw new ProcurementValidationError('INVALID_INPUT', 'Odoo amendment 只允许应用已权威读回的 RIHD');
        }
        const currentLines = this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id);
        const updatedDocument = { ...po.document, requiredInHouseAt: patch.requiredInHouseAt, updatedAt: at } as PurchaseOrder & Record<string, unknown>;
        const updatedLines = currentLines.map((line) => ({ ...line, requestedAt: patch.requiredInHouseAt }));
        const beforeHash = purchaseOrderEditStateHash(po.document as PurchaseOrder & Record<string, unknown>, currentLines);
        const afterHash = purchaseOrderEditStateHash(updatedDocument, updatedLines);
        const aggregate = this.updateExecutionDocument('purchase_order', updatedDocument, po.version);
        for (const line of updatedLines) this.saveLine('purchase_order_line', po.document.id, line);
        transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
          id: dispatched.id, state: 'applied', actorId: `connector:${outbox.connectorId}`,
          reason: 'Odoo authoritative readback matches the queued amendment', outboxId: outbox.id,
          receiptReference: typeof outbox.connectorResult?.['receiptReference'] === 'string' ? outbox.connectorResult['receiptReference'] : outbox.id, at,
        });
        const activity: Activity = {
          id: `activity:po-amendment-applied:${randomUUID()}`, at, objectId: po.document.id, actor: `connector:${outbox.connectorId}`,
          action: 'purchase_order.amendment_applied', summary: 'Odoo amendment 权威读回已应用',
          context: {
            amendmentId, outboxId: outbox.id, sourcePurchaseOrderVersion: sourcePoVersion, resultPurchaseOrderVersion: aggregate.version,
            beforeHash, afterHash, changedRihd: true, changedLineIds: updatedLines.filter((line, index) => line.requestedAt !== currentLines[index]?.requestedAt).map((line) => line.id),
          },
        };
        this.db.prepare(`INSERT INTO runtime_activities
          (tenant_id,id,object_id,json,updated_at) VALUES (?,?,?,?,?)`)
          .run(this.tenantId, activity.id, activity.objectId ?? null, JSON.stringify(activity), at);
      } else {
        transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
          id: dispatched.id, state: 'unknown', actorId: `connector:${outbox.connectorId}`,
          reason: 'Odoo readback does not match the queued amendment; manual review required', outboxId: outbox.id, at,
        });
        this.insertOutboxFailureException({ ...outbox, error: 'Odoo amendment authoritative readback did not match' }, at, true);
      }
      return;
    }
    if (outbox.action === 'purchase_order.draft_email.send' || outbox.action === 'purchase_order.draft_whatsapp.send') {
      const draftId = requireRepositoryText(typeof outbox.payload['draftId'] === 'string' ? outbox.payload['draftId'] : '', 'draftId');
      const row = this.db.prepare(`SELECT status FROM procurement_message_drafts
        WHERE tenant_id=? AND id=?`).get(this.tenantId, draftId) as { status: string } | undefined;
      if (!row) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 对应的沟通草稿不存在');
      if (row.status !== 'sent') {
        if (row.status !== 'approved_queued') {
          throw new ProcurementValidationError('INVALID_INPUT', `沟通草稿状态 ${row.status} 无法确认发送`);
        }
        this.db.prepare(`UPDATE procurement_message_drafts
          SET status='sent',version=version+1,sent_at=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='approved_queued'`)
          .run(at, at, this.tenantId, draftId);
      }
      this.db.prepare(`INSERT OR IGNORE INTO procurement_message_draft_events
        (tenant_id,id,draft_id,actor_id,action,detail_json,created_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run(this.tenantId, `message-draft-event:sent:${outbox.id}`, draftId, 'ai:procurement', 'sent', JSON.stringify({ outboxId: outbox.id, channel: outbox.channel }), at);
      if (outbox.channel === 'whatsapp') {
        const providerMessageId = requireRepositoryText(typeof outbox.connectorResult?.['message_id'] === 'string' ? outbox.connectorResult['message_id'] : '', 'connectorResult.message_id');
        const acceptedAtRaw = typeof outbox.connectorResult?.['accepted_at'] === 'string' ? outbox.connectorResult['accepted_at'] : at;
        const acceptedAt = requireIsoDate(acceptedAtRaw, 'connectorResult.accepted_at');
        const rawHash = createHash('sha256').update(JSON.stringify(outbox.connectorResult ?? {})).digest('hex');
        const fingerprint = createHash('sha256').update(`${providerMessageId}|accepted|${acceptedAt}`).digest('hex');
        this.db.prepare(`INSERT OR IGNORE INTO procurement_whatsapp_delivery_events
          (tenant_id,event_fingerprint,provider_message_id,draft_id,outbox_id,status,occurred_at,raw_hash,created_at)
          VALUES (?,?,?,?,?,'accepted',?,?,?)`).run(this.tenantId, fingerprint, providerMessageId, draftId, outbox.id, acceptedAt, rawHash, at);
      }
      return;
    }
    if (outbox.action === 'rfq.send') {
      const rfq = this.getDocument<RequestForQuotation>('rfq', outbox.aggregateId);
      if (!rfq) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 对应的 RFQ 不存在');
      if (rfq.document.status === 'sent' || rfq.document.status === 'awaiting_quotes' || rfq.document.status === 'partial_quotes') return;
      if (rfq.document.status !== 'draft') {
        throw new ProcurementValidationError('INVALID_INPUT', `RFQ 状态 ${rfq.document.status} 无法确认发送`);
      }
      this.updateExecutionDocument('rfq', { ...rfq.document, status: 'sent', updatedAt: at }, rfq.version);
      return;
    }
    if (outbox.action === 'purchase_order.send') {
      const po = this.getDocument<PurchaseOrder>('purchase_order', outbox.aggregateId);
      if (!po) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 对应的采购订单不存在');
      if (po.document.status === 'sent') return;
      if (po.document.status !== 'draft') {
        throw new ProcurementValidationError('INVALID_INPUT', `PO 状态 ${po.document.status} 无法确认发送`);
      }
      this.updateExecutionDocument('purchase_order', { ...po.document, status: 'sent', updatedAt: at }, po.version);
      this.recordPoStageEvent({
        poId: po.document.id, stage: 'po_sent', eventType: 'connector_delivery_confirmed', state: 'completed', occurredAt: at,
        sourceKind: 'outbox', sourceId: outbox.id, actorId: `connector:${outbox.connectorId}`,
        evidence: { outboxId: outbox.id, connectorId: outbox.connectorId, channel: outbox.channel, action: outbox.action, exactTransitionTime: true },
      });
      this.recordPoStageEvent({
        poId: po.document.id, stage: 'supplier_commitment', eventType: 'stage_entered', state: 'active', occurredAt: at,
        sourceKind: 'outbox', sourceId: outbox.id, actorId: `connector:${outbox.connectorId}`,
        evidence: { causedByStage: 'po_sent', outboxId: outbox.id, exactTransitionTime: true },
      });
      return;
    }
    if (outbox.action === 'purchase_order.create_draft' && outbox.channel === 'erp') {
      const po = this.getDocument<PurchaseOrder>('purchase_order', outbox.aggregateId);
      if (!po) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 对应的采购订单不存在');
      const frozenVersion = requirePositiveSafeInteger(outbox.payload['poVersion'], 'outbox.payload.poVersion');
      if (po.version !== frozenVersion) throw new ProcurementExecutionVersionConflictError(frozenVersion, po.version);
      if (po.document.status !== 'draft' || po.document.sourceSystem !== 'readywork' || po.document.odooReference) {
        throw new ProcurementExecutionStateConflictError(po.document.status, 'create_odoo_po_draft');
      }
      const correlationKey = requireRepositoryText(String(outbox.payload['correlationKey'] ?? ''), 'outbox.payload.correlationKey');
      const result = requireOdooPurchaseOrderDraftResult(outbox.connectorResult, correlationKey);
      const updated = this.updateExecutionDocument('purchase_order', {
        ...po.document,
        updatedAt: at,
        odooReference: { id: result.id, name: result.name, correlationKey, createdAt: at },
      }, frozenVersion);
      const activity: Activity = {
        id: `activity:odoo-po-draft:${outbox.id}`,
        at,
        objectId: po.document.id,
        actor: `connector:${outbox.connectorId}`,
        action: 'purchase_order.odoo_draft_created',
        summary: `Odoo 采购订单草稿 ${result.name} 已建立映射`,
        context: {
          outboxId: outbox.id,
          odooId: result.id,
          odooName: result.name,
          correlationKey,
          poVersion: updated.version,
        },
      };
      this.db.prepare(`INSERT INTO runtime_activities
        (tenant_id,id,object_id,json,updated_at) VALUES (?,?,?,?,?)`)
        .run(this.tenantId, activity.id, activity.objectId ?? null, JSON.stringify(activity), at);
      return;
    }
    if (outbox.action === 'purchase_order.update_rihd' && outbox.channel === 'erp') {
      const po = this.getDocument<PurchaseOrder>('purchase_order', outbox.aggregateId);
      if (!po) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 对应的采购订单不存在');
      const frozenVersion = requirePositiveSafeInteger(outbox.payload['poVersion'], 'outbox.payload.poVersion');
      if (po.version !== frozenVersion) throw new ProcurementExecutionVersionConflictError(frozenVersion, po.version);
      const requiredInHouseAt = requireIsoDate(
        typeof outbox.payload['requiredInHouseAt'] === 'string' ? outbox.payload['requiredInHouseAt'] : '',
        'outbox.payload.requiredInHouseAt',
      );
      const mapping = requireFrozenOdooPurchaseOrderMapping(outbox.payload['odooMapping']);
      const result = requireOdooRihdResult(outbox.connectorResult, mapping.poNumber, requiredInHouseAt);
      const frozenLines = requireFrozenRihdLines(outbox.payload['lines']);
      const currentLines = this.listLines<PurchaseOrderLine>('purchase_order_line', po.document.id);
      if (currentLines.length !== frozenLines.length || result.verifiedLines !== frozenLines.length) {
        throw new ProcurementValidationError('INVALID_INPUT', 'Odoo RIHD 核验行数与入队冻结快照不一致');
      }
      const currentById = new Map(currentLines.map((line) => [line.id, line] as const));
      for (const frozen of frozenLines) {
        const current = currentById.get(frozen.poLineId);
        if (!current || current.lineNumber !== frozen.lineNumber || current.orderedQty !== frozen.orderedQty
          || (current.requestedAt ?? null) !== frozen.requestedAt) {
          throw new ProcurementValidationError('INVALID_INPUT', `PO 行 ${frozen.poLineId} 已在 RIHD 回执前变更`);
        }
      }
      const updated = this.updateExecutionDocument('purchase_order', {
        ...po.document,
        requiredInHouseAt,
        promisedAt: requiredInHouseAt,
        updatedAt: at,
      }, frozenVersion);
      for (const line of currentLines) {
        const changedLine: PurchaseOrderLine = { ...line, requestedAt: requiredInHouseAt };
        this.db.prepare(`UPDATE procurement_lines SET json=?
          WHERE tenant_id=? AND kind='purchase_order_line' AND id=? AND document_id=?`)
          .run(JSON.stringify(changedLine), this.tenantId, changedLine.id, po.document.id);
        this.enqueueLineProjection('purchase_order_line', changedLine, at, updated.version);
      }
      const activity: Activity = {
        id: `activity:po-rihd:${outbox.id}`,
        at,
        objectId: po.document.id,
        actor: `connector:${outbox.connectorId}`,
        action: 'purchase_order.rihd_updated',
        summary: `RIHD 已经 Odoo 写入并核验为 ${requiredInHouseAt.slice(0, 10)}`,
        context: {
          outboxId: outbox.id,
          poVersion: updated.version,
          odooPoNumber: mapping.poNumber,
          previousRequiredInHouseAt: outbox.payload['previousRequiredInHouseAt'] ?? null,
          requiredInHouseAt,
          reason: outbox.payload['reason'],
          actorId: outbox.payload['actorId'],
          updatedLines: result.updatedLines,
          verifiedLines: result.verifiedLines,
          credential: outbox.connectorResult?.['credential'],
        },
      };
      this.db.prepare(`INSERT INTO runtime_activities
        (tenant_id,id,object_id,json,updated_at) VALUES (?,?,?,?,?)`)
        .run(this.tenantId, activity.id, activity.objectId ?? null, JSON.stringify(activity), at);
      return;
    }
    if (outbox.action === 'invoice.update' && outbox.channel === 'erp') {
      const invoice = this.getDocument<SupplierInvoice>('invoice', outbox.aggregateId);
      if (!invoice) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 对应的发票不存在');
      if (invoice.document.status === 'erp_written') return;
      if (invoice.document.status !== 'payable_approved') {
        throw new ProcurementValidationError('INVALID_INPUT', `发票状态 ${invoice.document.status} 无法确认 ERP 回写`);
      }
      this.updateExecutionDocument('invoice', { ...invoice.document, status: 'erp_written', updatedAt: at }, invoice.version);
    }
  }

  private recordObservedPurchaseOrderStatus(po: PurchaseOrder, version: number): void {
    const observed = observedPoStage(po.status);
    this.recordPoStageEvent({
      poId: po.id,
      stage: observed.stage,
      eventType: 'observed_document_status',
      state: observed.state,
      occurredAt: po.updatedAt,
      sourceKind: 'document_snapshot',
      sourceId: `${po.sourceSystem}:${po.externalId}:v${version}`,
      actorId: `source:${po.sourceSystem}`,
      evidence: {
        observedStatus: po.status,
        sourceSystem: po.sourceSystem,
        externalId: po.externalId,
        documentVersion: version,
        exactTransitionTime: false,
        note: 'This event records an imported or directly persisted status observation, not an exact transition timestamp',
      },
    });
  }

  private recordPoStageEvent(input: {
    poId: string;
    stage: ProcurementPoStage;
    eventType: string;
    state: ProcurementPoStageState;
    occurredAt: string;
    sourceKind: string;
    sourceId: string;
    actorId: string;
    evidence: Readonly<Record<string, unknown>>;
  }): void {
    const id = `po-stage-event:${randomUUID()}`;
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO procurement_po_stage_events
      (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      this.tenantId,
      id,
      input.poId,
      input.stage,
      input.eventType,
      input.state,
      input.occurredAt,
      input.sourceKind,
      input.sourceId,
      input.actorId,
      JSON.stringify(input.evidence),
      input.occurredAt,
    );
    if (Number(inserted.changes) === 1) enqueueTwinProjectionInCurrentTransaction(this.db, {
      tenantId: this.tenantId,
      sourceTable: 'procurement_po_stage_events',
      sourceKey: id,
      sourceRevision: '1',
      eventType: 'procurement_po_stage_event.created',
      payloadHash: twinProjectionPayloadHash({ id, ...input }),
      availableAt: input.occurredAt,
    });
  }

  private recordSentAttachmentAudit(outbox: ProcurementOutboxMessage, at: string): void {
    if (!['rfq.send', 'purchase_order.send'].includes(outbox.action) || !outbox.sentAttachments?.length) return;
    if (outbox.action === 'purchase_order.send') {
      const po = this.getDocument<PurchaseOrder>('purchase_order', outbox.aggregateId)?.document;
      if (!po) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 对应的 PO 不存在');
      const insertPoAudit = this.db.prepare(`INSERT OR IGNORE INTO procurement_attachment_audit
        (tenant_id,id,attachment_id,requisition_id,actor_id,action,owner_type,owner_id,detail_json,created_at)
        VALUES (?,?,?,?,?,'sent_with_po','purchase_order',?,?,?)`);
      for (const attachment of outbox.sentAttachments) insertPoAudit.run(
        this.tenantId, `attachment-audit:sent:${outbox.id}:${attachment.id}`, attachment.id, po.id,
        'connector:email', po.id, JSON.stringify({ poId: po.id, outboxId: outbox.id, supplierId: po.supplierId, ...attachment }), at,
      );
      return;
    }
    const rfq = this.getDocument<RequestForQuotation>('rfq', outbox.aggregateId)?.document;
    if (!rfq) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 对应的 RFQ 不存在');
    const supplierId = String(outbox.payload['supplierId'] ?? '');
    const findRequisition = this.db.prepare(`SELECT requisition_id FROM procurement_attachments
      WHERE tenant_id=? AND id=?`);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO procurement_attachment_audit
      (tenant_id,id,attachment_id,requisition_id,actor_id,action,detail_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const attachment of outbox.sentAttachments) {
      const row = findRequisition.get(this.tenantId, attachment.id) as { requisition_id: string } | undefined;
      const requisitionId = rfq.requisitionId ?? row?.requisition_id;
      if (!requisitionId) throw new ProcurementValidationError('INVALID_INPUT', `无法确定已发送附件 ${attachment.id} 的采购需求`);
      insert.run(
        this.tenantId,
        `attachment-audit:sent:${outbox.id}:${attachment.id}`,
        attachment.id,
        requisitionId,
        'ai:procurement',
        'sent_with_rfq',
        JSON.stringify({ rfqId: rfq.id, outboxId: outbox.id, supplierId, ...attachment }),
        at,
      );
    }
  }

  private insertOutboxFailureException(outbox: ProcurementOutboxMessage, at: string, uncertain: boolean): void {
    const exceptionId = `procurement-outbox-exception:${outbox.id}`;
    const exception: Exception = {
      id: exceptionId,
      type: uncertain ? 'external_delivery_uncertain' : 'external_delivery_failed',
      severity: uncertain ? 'critical' : 'high',
      objectId: outbox.aggregateId,
      objectType: outbox.action.startsWith('purchase_order.') ? 'purchase_order' : outbox.channel === 'erp' ? 'invoice' : outbox.action === 'rfq.send' ? 'rfq' : 'purchase_order',
      aiJudgment: uncertain
        ? `外部调用结果不确定: ${outbox.error ?? '派发失败'}`
        : `外部派发终态失败: ${outbox.error ?? '派发失败'}`,
      recommendedAction: uncertain
        ? '先在外部系统人工核验，确认未执行前禁止重放'
        : '修复连接器或业务数据后由人工重新发起',
      context: {
        outboxId: outbox.id, channel: outbox.channel, connectorId: outbox.connectorId,
        action: outbox.action, attempts: outbox.attempts, uncertain,
      },
      needsApproval: false,
      status: 'open',
      createdAt: at,
    };
    this.db.prepare(`INSERT OR IGNORE INTO runtime_exceptions
      (tenant_id,id,object_id,status,json,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(this.tenantId, exception.id, exception.objectId, exception.status, JSON.stringify(exception), at);
  }

  private markPurchaseOrderAmendmentUnknown(outbox: ProcurementOutboxMessage, at: string, reason: string): void {
    const amendmentId = requireRepositoryText(typeof outbox.payload['amendmentId'] === 'string' ? outbox.payload['amendmentId'] : '', 'outbox.payload.amendmentId');
    const amendment = getProcurementPurchaseOrderAmendment(this.db, this.tenantId, amendmentId);
    if (!amendment) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 对应的 PO amendment 不存在');
    if (amendment.state === 'queued') {
      transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
        id: amendmentId, state: 'dispatched', actorId: `connector:${outbox.connectorId}`,
        reason: 'Odoo amendment attempted but no authoritative readback is available', outboxId: outbox.id, at,
      });
      transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
        id: amendmentId, state: 'unknown', actorId: `connector:${outbox.connectorId}`, reason, outboxId: outbox.id, at,
      });
    }
    this.insertOutboxFailureException(outbox, at, true);
  }

  private markPurchaseOrderAmendmentFailed(outbox: ProcurementOutboxMessage, at: string, reason: string): void {
    const amendmentId = requireRepositoryText(typeof outbox.payload['amendmentId'] === 'string' ? outbox.payload['amendmentId'] : '', 'outbox.payload.amendmentId');
    const amendment = getProcurementPurchaseOrderAmendment(this.db, this.tenantId, amendmentId);
    if (!amendment) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 对应的 PO amendment 不存在');
    if (amendment.state === 'queued' || amendment.state === 'pending' || amendment.state === 'dispatched') {
      transitionProcurementPurchaseOrderAmendment(this.db, this.tenantId, {
        id: amendmentId, state: 'failed', actorId: `connector:${outbox.connectorId}`, reason, outboxId: outbox.id, at,
      });
    }
  }

  private assertCumulativeWithin(
    line: PurchaseOrderLine,
    dimension: 'shipped' | 'received' | 'invoiced',
    delta: number,
    reference: 'confirmed' | 'shipped' | 'received',
  ): void {
    const projection = this.getPurchaseOrderLineQuantityProjection(line.id) ?? createPurchaseOrderLineQuantityProjection(line, this.tenantId);
    const current = dimension === 'shipped' ? projection.shippedQty : dimension === 'received' ? projection.receivedQty : projection.invoicedQty;
    const ceiling = reference === 'confirmed'
      ? (projection.confirmedQty || line.orderedQty)
      : reference === 'shipped' ? projection.shippedQty : projection.receivedQty;
    if (current + delta > line.orderedQty || current + delta > ceiling) {
      throw new ProcurementValidationError('INVALID_INPUT', `${dimension} 累计数量超过 ${reference} 或订购数量`);
    }
  }

  private applyExecutionQuantity(
    line: PurchaseOrderLine,
    dimension: PurchaseOrderLineQuantityEvent['dimension'],
    delta: number,
    input: ProcurementExecutionMutationInput,
    at: string,
  ): void {
    const event: PurchaseOrderLineQuantityEvent = {
      tenantId: this.tenantId, sourceSystem: input.evidenceSource === 'manual_verified'
        ? 'readywork-manual-verification' : input.evidenceSource === 'supplier_email_ai' ? 'supplier-email-ai' : 'readywork-execution',
      sourceEventId: `${input.action}:${input.idempotencyKey}:${dimension}:${line.id}`,
      poLineId: line.id, dimension, delta, occurredAt: at,
    };
    const projection = this.getPurchaseOrderLineQuantityProjection(line.id) ?? createPurchaseOrderLineQuantityProjection(line, this.tenantId);
    const result = projectPurchaseOrderLineQuantityEvent(projection, event);
    this.db.prepare(`
      INSERT INTO procurement_po_line_quantity_events
        (tenant_id,source_system,source_event_id,po_line_id,dimension,delta,occurred_at,json)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(this.tenantId, event.sourceSystem, event.sourceEventId, event.poLineId, event.dimension, event.delta, event.occurredAt, JSON.stringify(event));
    const value = result.projection;
    this.db.prepare(`
      INSERT INTO procurement_po_line_quantity_projections
        (tenant_id,po_line_id,ordered_qty,confirmed_qty,shipped_qty,received_qty,invoiced_qty,cancelled_qty,projection_json,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,po_line_id) DO UPDATE SET
        ordered_qty=excluded.ordered_qty,confirmed_qty=excluded.confirmed_qty,shipped_qty=excluded.shipped_qty,
        received_qty=excluded.received_qty,invoiced_qty=excluded.invoiced_qty,cancelled_qty=excluded.cancelled_qty,
        projection_json=excluded.projection_json,updated_at=excluded.updated_at
    `).run(this.tenantId, value.poLineId, value.orderedQty, value.confirmedQty, value.shippedQty,
      value.receivedQty, value.invoicedQty, value.cancelledQty, JSON.stringify(value), at);
    const projectionHash = twinProjectionPayloadHash(value);
    enqueueTwinProjectionInCurrentTransaction(this.db, {
      tenantId: this.tenantId, sourceTable: 'procurement_po_line_quantity_projections', sourceKey: value.poLineId,
      sourceRevision: projectionHash, eventType: 'procurement_po_line_quantity_projection.changed',
      payloadHash: projectionHash, availableAt: at,
    });
  }

  private createDocumentWithLinesIdempotent<
    TDocument extends ProcurementDocument,
    TLine extends ProcurementLine,
  >(input: IdempotentProcurementCreate<TDocument, TLine>): IdempotentProcurementCreateResult<TDocument, TLine> {
    const { kind, lineKind, document, lines, idempotencyKey, payloadHash } = input;
    if (document.tenantId !== this.tenantId) throw new Error('采购单据与仓储租户不一致');
    if (!idempotencyKey) throw new Error(`${kind} 幂等键不能为空`);
    if (!payloadHash) throw new Error(`${kind} 载荷摘要不能为空`);
    if (lines.length === 0) throw new Error(`${kind} 必须至少包含一行`);
    const parentField = LINE_PARENT_FIELD[lineKind];
    for (const line of lines) {
      const parentId = (line as unknown as Record<string, unknown>)[parentField];
      if (parentId !== document.id) throw new Error(`采购行父单据不一致: ${parentField}=${String(parentId)}, documentId=${document.id}`);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`
        SELECT payload_hash,document_id FROM procurement_create_idempotency
        WHERE tenant_id=? AND kind=? AND idempotency_key=?
      `).get(this.tenantId, kind, idempotencyKey) as { payload_hash: string; document_id: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new ProcurementCreateIdempotencyConflictError(kind, idempotencyKey);
        const stored = this.getDocument<TDocument>(kind, existing.document_id);
        if (!stored) throw new Error(`${kind} 幂等记录引用的单据不存在`);
        const storedLines = this.listLines<TLine>(lineKind, existing.document_id);
        this.db.exec('COMMIT');
        return { document: stored, lines: storedLines, replayed: true };
      }

      if (kind === 'quote') {
        const quote = document as unknown as SupplierQuote;
        const rfq = this.getDocument<RequestForQuotation>('rfq', quote.rfqId);
        if (!rfq) throw new ProcurementValidationError('RFQ_NOT_FOUND', 'RFQ 不存在');
        const allowedStatuses = ['draft', 'sent', 'awaiting_quotes', 'partial_quotes', 'quotes_complete', 'compared', 'pending_award'] as const;
        if (!allowedStatuses.includes(rfq.document.status as typeof allowedStatuses[number])) {
          throw new ProcurementRfqStateConflictError(rfq.document.status, allowedStatuses);
        }
      }

      this.db.prepare(`
        INSERT INTO procurement_documents
          (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,1,?,?,?)
      `).run(
        this.tenantId, kind, document.id, document.sourceSystem, document.externalId,
        document.status, JSON.stringify(document), document.createdAt, document.updatedAt,
      );
      const insertLine = this.db.prepare(`
        INSERT INTO procurement_lines (tenant_id,kind,id,document_id,line_number,json)
        VALUES (?,?,?,?,?,?)
      `);
      for (const line of lines) {
        insertLine.run(this.tenantId, lineKind, line.id, document.id, line.lineNumber, JSON.stringify(line));
      }
      if (kind === 'rfq') {
        const rfq = document as unknown as RequestForQuotation;
        const attachments = rfq.attachments ?? [];
        if (attachments.length > 0 && !rfq.requisitionId) {
          throw new ProcurementValidationError('INVALID_INPUT', '含附件的 RFQ 必须关联采购需求');
        }
        const insertAttachmentAudit = this.db.prepare(`INSERT INTO procurement_attachment_audit
          (tenant_id,id,attachment_id,requisition_id,actor_id,action,detail_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`);
        for (const attachment of attachments) {
          insertAttachmentAudit.run(
            this.tenantId,
            `attachment-audit:selected:${rfq.id}:${attachment.id}`,
            attachment.id,
            rfq.requisitionId!,
            rfq.buyerId,
            'selected_for_rfq',
            JSON.stringify({ rfqId: rfq.id, attachmentVersion: attachment.version ?? 1, sha256: attachment.sha256 ?? null }),
            rfq.createdAt,
          );
        }
      }
      this.db.prepare(`
        INSERT INTO procurement_create_idempotency
          (tenant_id,kind,idempotency_key,payload_hash,document_id,created_at)
        VALUES (?,?,?,?,?,?)
      `).run(this.tenantId, kind, idempotencyKey, payloadHash, document.id, document.createdAt);
      if (kind === 'quote') {
        const quote = document as unknown as SupplierQuote;
        const rfq = this.getDocument<RequestForQuotation>('rfq', quote.rfqId);
        if (!rfq) throw new ProcurementValidationError('RFQ_NOT_FOUND', 'RFQ 不存在');
        const receiptingStatuses = ['sent', 'awaiting_quotes', 'partial_quotes', 'quotes_complete', 'compared', 'pending_award'] as const;
        if (receiptingStatuses.includes(rfq.document.status as typeof receiptingStatuses[number])) {
          const quotedSupplierIds = new Set(
            this.listDocuments<SupplierQuote>('quote')
              .filter(({ document: storedQuote }) => storedQuote.rfqId === rfq.document.id)
              .map(({ document: storedQuote }) => storedQuote.supplierId),
          );
          const nextStatus = rfq.document.supplierIds.every((supplierId) => quotedSupplierIds.has(supplierId))
            ? 'quotes_complete'
            : 'partial_quotes';
          if (rfq.document.status !== nextStatus || rfq.document.comparisonSnapshotId !== undefined) {
            const { comparisonSnapshotId: _previousComparisonSnapshotId, ...rfqWithoutComparison } = rfq.document;
            this.updateExecutionDocument('rfq', {
              ...rfqWithoutComparison,
              status: nextStatus,
              updatedAt: document.updatedAt,
            }, rfq.version);
          }
        }
      }
      this.db.exec('COMMIT');
      return { document: { document, version: 1 }, lines: [...lines], replayed: false };
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  applyPurchaseOrderLineQuantityEvent(
    line: PurchaseOrderLine,
    event: PurchaseOrderLineQuantityEvent,
  ): QuantityProjectionResult {
    if (event.tenantId !== this.tenantId) throw new Error('数量事件与仓储租户不一致');
    if (event.poLineId !== line.id) throw new Error('数量事件与 PO 行不一致');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const storedLine = this.getLine<PurchaseOrderLine>('purchase_order_line', line.id);
      if (!storedLine) throw new Error(`PO 行尚未持久化: ${line.id}`);
      if (storedLine.orderedQty !== line.orderedQty) throw new Error('PO 行订购数量与已持久化数据不一致');
      const existing = this.db.prepare(`
        SELECT json FROM procurement_po_line_quantity_events
        WHERE tenant_id=? AND source_system=? AND source_event_id=?
      `).get(this.tenantId, event.sourceSystem, event.sourceEventId) as { json: string } | undefined;
      if (existing) {
        const previous = JSON.parse(existing.json) as PurchaseOrderLineQuantityEvent;
        if (!sameQuantityEvent(previous, event)) throw new ProcurementQuantityEventConflictError();
        const storedProjection = this.getPurchaseOrderLineQuantityProjection(line.id);
        if (!storedProjection) throw new Error('数量事件已存在但 PO 行投影缺失');
        const duplicate = projectPurchaseOrderLineQuantityEvent(storedProjection, event);
        this.db.exec('COMMIT');
        return duplicate;
      }

      const projection = this.loadQuantityProjection(line);
      const result = projectPurchaseOrderLineQuantityEvent(projection, event);
      this.db.prepare(`
        INSERT INTO procurement_po_line_quantity_events
          (tenant_id,source_system,source_event_id,po_line_id,dimension,delta,occurred_at,json)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(this.tenantId, event.sourceSystem, event.sourceEventId, event.poLineId, event.dimension, event.delta, event.occurredAt, JSON.stringify(event));
      const value = result.projection;
      this.db.prepare(`
        INSERT INTO procurement_po_line_quantity_projections
          (tenant_id,po_line_id,ordered_qty,confirmed_qty,shipped_qty,received_qty,invoiced_qty,cancelled_qty,projection_json,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(tenant_id,po_line_id) DO UPDATE SET
          ordered_qty=excluded.ordered_qty,confirmed_qty=excluded.confirmed_qty,
          shipped_qty=excluded.shipped_qty,received_qty=excluded.received_qty,
          invoiced_qty=excluded.invoiced_qty,cancelled_qty=excluded.cancelled_qty,
          projection_json=excluded.projection_json,updated_at=excluded.updated_at
      `).run(
        this.tenantId, value.poLineId, value.orderedQty, value.confirmedQty, value.shippedQty,
        value.receivedQty, value.invoicedQty, value.cancelledQty, JSON.stringify(value), event.occurredAt,
      );
      const eventHash = twinProjectionPayloadHash(event);
      enqueueTwinProjectionInCurrentTransaction(this.db, {
        tenantId: this.tenantId,
        sourceTable: 'procurement_po_line_quantity_events',
        sourceKey: `${event.sourceSystem}:${event.sourceEventId}`,
        sourceRevision: '1',
        eventType: 'procurement_po_line_quantity_event.created',
        payloadHash: eventHash,
        availableAt: event.occurredAt,
      });
      const projectionHash = twinProjectionPayloadHash(value);
      enqueueTwinProjectionInCurrentTransaction(this.db, {
        tenantId: this.tenantId,
        sourceTable: 'procurement_po_line_quantity_projections',
        sourceKey: value.poLineId,
        sourceRevision: projectionHash,
        eventType: 'procurement_po_line_quantity_projection.changed',
        payloadHash: projectionHash,
        availableAt: event.occurredAt,
      });
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }

  getPurchaseOrderLineQuantityProjection(poLineId: EntityId): PurchaseOrderLineQuantityProjection | undefined {
    const row = this.db.prepare(`
      SELECT projection_json FROM procurement_po_line_quantity_projections
      WHERE tenant_id=? AND po_line_id=?
    `).get(this.tenantId, poLineId) as { projection_json: string } | undefined;
    return row ? JSON.parse(row.projection_json) as PurchaseOrderLineQuantityProjection : undefined;
  }

  appendMatchDecision(decision: StoredMatchDecision): void {
    if (decision.tenantId !== this.tenantId) throw new Error('匹配决策与仓储租户不一致');
    if (!decision.ruleVersion.trim()) throw new Error('匹配决策缺少 ruleVersion');
    if (decision.status !== decision.snapshot.disposition) throw new Error('匹配决策状态与快照不一致');
    this.db.prepare(`
      INSERT INTO procurement_match_decisions (tenant_id,id,rule_version,status,snapshot_json,created_at)
      VALUES (?,?,?,?,?,?)
    `).run(this.tenantId, decision.id, decision.ruleVersion, decision.status, JSON.stringify(decision.snapshot), decision.createdAt);
  }

  getMatchDecision(id: EntityId): StoredMatchDecision | undefined {
    const row = this.db.prepare(`
      SELECT rule_version,status,snapshot_json,created_at FROM procurement_match_decisions
      WHERE tenant_id=? AND id=?
    `).get(this.tenantId, id) as { rule_version: string; status: LineMatchDisposition; snapshot_json: string; created_at: string } | undefined;
    return row ? {
      id,
      tenantId: this.tenantId,
      ruleVersion: row.rule_version,
      status: row.status,
      snapshot: JSON.parse(row.snapshot_json) as LineMatchResult,
      createdAt: row.created_at,
    } : undefined;
  }

  private loadQuantityProjection(line: PurchaseOrderLine): PurchaseOrderLineQuantityProjection {
    const stored = this.getPurchaseOrderLineQuantityProjection(line.id);
    if (!stored) return createPurchaseOrderLineQuantityProjection(line, this.tenantId);
    if (stored.orderedQty !== line.orderedQty) throw new Error('PO 行订购数量与数量投影不一致');
    return stored;
  }
}

function sameSupplierContent(left: Supplier, right: Supplier): boolean {
  const { createdAt: _leftCreatedAt, updatedAt: _leftUpdatedAt, ...leftContent } = left;
  const { createdAt: _rightCreatedAt, updatedAt: _rightUpdatedAt, ...rightContent } = right;
  return isDeepStrictEqual(leftContent, rightContent);
}

function supplierSyncItem(stored: VersionedProcurementDocument<Supplier>): SupplierSyncItem {
  const { document, version } = stored;
  return {
    id: document.id,
    externalId: document.externalId,
    name: document.name,
    currency: document.currency,
    contacts: document.contacts,
    ...(document.countryCode ? { countryCode: document.countryCode } : {}),
    ...(document.countryName ? { countryName: document.countryName } : {}),
    ...(document.city ? { city: document.city } : {}),
    ...(document.street ? { street: document.street } : {}),
    ...(document.street2 ? { street2: document.street2 } : {}),
    ...(document.postalCode ? { postalCode: document.postalCode } : {}),
    status: document.status,
    sourceSystem: document.sourceSystem,
    version,
  };
}

function sameQuantityEvent(left: PurchaseOrderLineQuantityEvent, right: PurchaseOrderLineQuantityEvent): boolean {
  return left.tenantId === right.tenantId
    && left.sourceSystem === right.sourceSystem
    && left.sourceEventId === right.sourceEventId
    && left.poLineId === right.poLineId
    && left.dimension === right.dimension
    && left.delta === right.delta
    && left.occurredAt === right.occurredAt;
}

function freezeRfqAttachments(rfq: RequestForQuotation): ProcurementOutboxAttachmentSnapshot[] {
  const attachmentIds = [...(rfq.attachmentIds ?? [])];
  const metadata = [...(rfq.attachments ?? [])];
  assertExactIdSet(
    metadata.map((attachment) => attachment.id),
    attachmentIds,
    'INVALID_INPUT',
    'RFQ 附件 ID 与冻结元数据不一致',
  );
  const byId = new Map(metadata.map((attachment) => [attachment.id, attachment]));
  return attachmentIds.map((id) => {
    const attachment = byId.get(id)!;
    if (typeof attachment.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(attachment.sha256)) {
      throw new ProcurementValidationError('INVALID_INPUT', `RFQ 附件 ${id} 缺少有效 sha256`);
    }
    if (!Number.isSafeInteger(attachment.version) || Number(attachment.version) <= 0) {
      throw new ProcurementValidationError('INVALID_INPUT', `RFQ 附件 ${id} 缺少有效版本`);
    }
    if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes <= 0) {
      throw new ProcurementValidationError('INVALID_INPUT', `RFQ 附件 ${id} 缺少有效大小`);
    }
    return {
      id,
      sha256: attachment.sha256.toLowerCase(),
      version: Number(attachment.version),
      name: requireRepositoryText(attachment.fileName, `RFQ 附件 ${id} 文件名`),
      contentType: requireRepositoryText(attachment.contentType, `RFQ 附件 ${id} 内容类型`),
      sizeBytes: Number(attachment.sizeBytes),
    };
  });
}

function freezePurchaseOrderAttachments(db: DatabaseSync, tenantId: string, po: PurchaseOrder): ProcurementOutboxAttachmentSnapshot[] {
  const sourceAttachmentId = (po as PurchaseOrder & Record<string, unknown>)['sourceAttachmentId'];
  if (sourceAttachmentId === undefined || sourceAttachmentId === null || sourceAttachmentId === '') return [];
  const attachmentId = requireRepositoryText(String(sourceAttachmentId), 'sourceAttachmentId');
  const row = db.prepare(`SELECT id,file_name,content_type,size_bytes,sha256,version,status,security_status,processing_status,owner_type,owner_id
    FROM procurement_attachments WHERE tenant_id=? AND id=?`).get(tenantId, attachmentId) as {
      id: string; file_name: string; content_type: string; size_bytes: number; sha256: string; version: number;
      status: string; security_status: string; processing_status: string; owner_type: string; owner_id: string | null;
    } | undefined;
  if (!row) throw new ProcurementValidationError('INVALID_INPUT', '邮箱 PO 原始附件不存在');
  if (row.status !== 'active' || row.owner_type !== 'purchase_order' || row.owner_id !== po.id) {
    throw new ProcurementValidationError('INVALID_INPUT', '邮箱 PO 原始附件已失效或归属不一致');
  }
  if (row.security_status !== 'clean' || row.processing_status !== 'parsed') {
    throw new ProcurementValidationError('INVALID_INPUT', '邮箱 PO 原始附件未通过安全扫描和文档解析，不能发送');
  }
  if (!/^[a-f0-9]{64}$/i.test(row.sha256) || !Number.isSafeInteger(row.version) || row.version <= 0
    || !Number.isSafeInteger(row.size_bytes) || row.size_bytes <= 0) {
    throw new ProcurementValidationError('INVALID_INPUT', '邮箱 PO 原始附件缺少完整性元数据');
  }
  return [{ id: row.id, sha256: row.sha256.toLowerCase(), version: row.version,
    name: requireRepositoryText(row.file_name, '原始 PO 附件名'), contentType: requireRepositoryText(row.content_type, '原始 PO 附件类型'), sizeBytes: row.size_bytes }];
}

function outboxAttachmentSnapshots(value: unknown): ProcurementOutboxAttachmentSnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ProcurementValidationError('INVALID_INPUT', 'outbox 附件快照必须是数组');
  const snapshots = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ProcurementValidationError('INVALID_INPUT', `outbox 附件快照[${index}] 无效`);
    }
    const record = item as Record<string, unknown>;
    const id = requireRepositoryText(String(record['id'] ?? ''), `outbox 附件快照[${index}].id`);
    const sha256 = String(record['sha256'] ?? '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ProcurementValidationError('INVALID_INPUT', `outbox 附件 ${id} sha256 无效`);
    const version = record['version'];
    if (!Number.isSafeInteger(version) || Number(version) <= 0) throw new ProcurementValidationError('INVALID_INPUT', `outbox 附件 ${id} 版本无效`);
    const sizeBytes = record['sizeBytes'];
    if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) <= 0) throw new ProcurementValidationError('INVALID_INPUT', `outbox 附件 ${id} 大小无效`);
    return {
      id,
      sha256,
      version: Number(version),
      name: requireRepositoryText(String(record['name'] ?? ''), `outbox 附件 ${id} 文件名`),
      contentType: requireRepositoryText(String(record['contentType'] ?? ''), `outbox 附件 ${id} 内容类型`),
      sizeBytes: Number(sizeBytes),
    };
  });
  if (new Set(snapshots.map((item) => item.id)).size !== snapshots.length) {
    throw new ProcurementValidationError('INVALID_INPUT', 'outbox 附件快照 ID 不能重复');
  }
  return snapshots;
}

function requireRepositoryText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ProcurementValidationError('INVALID_INPUT', `${field} 不能为空`);
  return value.trim();
}

function requireBoundedBusinessText(value: string | undefined, field: string, min: number, max: number): string {
  const normalized = requireRepositoryText(value ?? '', field);
  if (normalized.length < min || normalized.length > max) {
    throw new ProcurementValidationError('INVALID_INPUT', `${field} 长度必须为 ${min}–${max} 个字符`);
  }
  return normalized;
}

function requireManualRiskSeverity(value: ProcurementExecutionMutationInput['riskSeverity']): 'medium' | 'high' | 'critical' {
  if (value !== 'medium' && value !== 'high' && value !== 'critical') {
    throw new ProcurementValidationError('INVALID_INPUT', 'riskSeverity 必须为 medium、high 或 critical');
  }
  return value;
}

function requireManualRiskCategory(value: ProcurementExecutionMutationInput['riskCategory']): NonNullable<ProcurementExecutionMutationInput['riskCategory']> {
  const allowed = new Set(['supplier_response', 'schedule', 'production', 'logistics', 'quality', 'commercial', 'compliance', 'other']);
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new ProcurementValidationError('INVALID_INPUT', 'riskCategory 不是允许的采购风险类别');
  }
  return value as NonNullable<ProcurementExecutionMutationInput['riskCategory']>;
}

function inboundEmailAddress(value: string): string | undefined {
  const bracketed = /<\s*([^<>]+?)\s*>/.exec(value);
  const candidate = (bracketed?.[1] ?? value).trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate)) return undefined;
  return candidate.toLowerCase();
}

function redactProcurementOutboxError(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization|api[-_]?key|token|secret|password|passwd|passphrase|credential|cookie)(\s*[=:]\s*)([^\s,;}&]+)/gi, '$1$2[REDACTED]')
    .slice(0, 500);
}

function safeConnectorResult(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (typeof value['id'] === 'number' && Number.isSafeInteger(value['id']) && value['id'] > 0) result['id'] = value['id'];
  if (typeof value['readbackMatches'] === 'boolean') result['readbackMatches'] = value['readbackMatches'];
  for (const key of ['updated_lines', 'verified_lines'] as const) {
    const item = value[key];
    if (typeof item === 'number' && Number.isSafeInteger(item) && item > 0) result[key] = item;
  }
  for (const key of ['message_id', 'accepted_at', 'delivery_status', 'from_name', 'name', 'state', 'correlationKey', 'po_name', 'required_in_house_at', 'receiptReference'] as const) {
    const item = value[key];
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    const limit = key === 'message_id' ? 1_024 : key === 'from_name' || key === 'name' || key === 'po_name' ? 160
      : key === 'correlationKey' ? 500 : key === 'receiptReference' ? 200 : 100;
    if (text.length > limit) {
      throw new ProcurementValidationError('INVALID_INPUT', `connectorResult.${key} 不能超过 ${limit} 字符`);
    }
    if (key === 'from_name' && /[\r\n]/.test(text)) {
      throw new ProcurementValidationError('INVALID_INPUT', 'connectorResult.from_name 不能包含换行符');
    }
    result[key] = text;
  }
  // ERP execution audits retain only the immutable credential identity that
  // was resolved after the outbox lease.  Never persist a credential payload,
  // endpoint, database name or key in an execution record.
  const credential = value['credential'];
  if (credential && typeof credential === 'object' && !Array.isArray(credential)) {
    const audit = credential as Record<string, unknown>;
    const credentialId = typeof audit['credentialId'] === 'string' ? audit['credentialId'].trim() : '';
    const credentialVersion = typeof audit['credentialVersion'] === 'string' ? audit['credentialVersion'].trim() : '';
    const lastTestedAt = typeof audit['lastTestedAt'] === 'string' ? audit['lastTestedAt'].trim() : '';
    if (!credentialId || !credentialVersion || !lastTestedAt
      || credentialId.length > 200 || credentialVersion.length > 100 || lastTestedAt.length > 100) {
      throw new ProcurementValidationError('INVALID_INPUT', 'connectorResult.credential 审计快照无效');
    }
    result['credential'] = { credentialId, credentialVersion, lastTestedAt };
  }
  return result;
}

function requirePurchaseOrderEditPatch(value: PurchaseOrderEditPatch | undefined): PurchaseOrderEditPatch {
  if (!value || Object.keys(value).length === 0) throw new ProcurementValidationError('INVALID_INPUT', 'patch 至少包含一个允许字段');
  if (value.materialType !== undefined && value.materialType !== 'direct' && value.materialType !== 'indirect') {
    throw new ProcurementValidationError('INVALID_INPUT', 'materialType 必须为 direct 或 indirect');
  }
  if (value.requiredInHouseAt !== undefined) requireIsoDate(value.requiredInHouseAt, 'requiredInHouseAt');
  if (value.lines !== undefined && value.lines.length === 0) throw new ProcurementValidationError('INVALID_INPUT', 'lines 必须是非空数组');
  return value;
}

function editPurchaseOrderLines(
  currentLines: readonly PurchaseOrderLine[],
  inputs: readonly PurchaseOrderEditLineInput[],
  currency: string,
  requiredInHouseAt: string | undefined,
): PurchaseOrderLine[] {
  const byId = new Map(currentLines.map((line) => [line.id, line]));
  const ids = new Set<string>();
  return inputs.map((input, index) => {
    const current = byId.get(input.id);
    if (!current) throw new ProcurementValidationError('INVALID_INPUT', `编辑行 ${index + 1} 不属于该采购订单`);
    if (ids.has(input.id)) throw new ProcurementValidationError('INVALID_INPUT', '编辑行不能重复');
    ids.add(input.id);
    const itemId = requireBoundedBusinessText(input.itemCode, `lines[${index}].itemCode`, 1, 240);
    const description = requireBoundedBusinessText(input.description, `lines[${index}].description`, 1, 2_000);
    const uom = requireBoundedBusinessText(input.unit, `lines[${index}].unit`, 1, 64);
    const orderedQty = requirePositiveFiniteNumber(input.quantity, `lines[${index}].quantity`);
    if (input.unitPrice === null) throw new ProcurementValidationError('INVALID_INPUT', `lines[${index}].unitPrice 在本地 Draft 中不能为空`);
    if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0) throw new ProcurementValidationError('INVALID_INPUT', `lines[${index}].unitPrice 必须为非负有限数`);
    if (input.taxRate !== null && (!Number.isFinite(input.taxRate) || input.taxRate < 0 || input.taxRate > 1)) {
      throw new ProcurementValidationError('INVALID_INPUT', `lines[${index}].taxRate 必须在 0 到 1 之间`);
    }
    const { itemId: _itemId, description: _description, uom: _uom, orderedQty: _orderedQty, unitPrice: _unitPrice,
      currency: _currency, taxRate: _taxRate, requestedAt: _requestedAt, ...unchanged } = current;
    return {
      ...unchanged, itemId, description, uom, orderedQty, unitPrice: input.unitPrice, currency,
      ...(input.taxRate === null ? {} : { taxRate: input.taxRate }),
      ...(requiredInHouseAt === undefined ? {} : { requestedAt: requiredInHouseAt }),
    } as PurchaseOrderLine;
  });
}

function purchaseOrderEditStateHash(po: PurchaseOrder & Record<string, unknown>, lines: readonly PurchaseOrderLine[]): string {
  return createHash('sha256').update(stableJsonObject({
    document: { ...po, updatedAt: '' },
    lines: [...lines].map((line) => ({ ...line })).sort((left, right) => left.id.localeCompare(right.id)),
  })).digest('hex');
}

function parseOdooPartnerId(externalId: string): number {
  const value = requireRepositoryText(externalId, 'supplier.externalId');
  const matched = /^(?:odoo(?:-partner)?-)?([1-9]\d*)$/i.exec(value);
  const partnerId = matched ? Number(matched[1]) : Number.NaN;
  if (!Number.isSafeInteger(partnerId) || partnerId <= 0) {
    throw new ProcurementValidationError('INVALID_INPUT', '供应商 externalId 无法解析为 Odoo partner id');
  }
  return partnerId;
}

function purchaseOrderRequiredInHouseAt(
  po: PurchaseOrder,
  lines: readonly PurchaseOrderLine[],
): string | null {
  const candidates = [po.requiredInHouseAt, po.promisedAt, ...lines.map((line) => line.requestedAt)]
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .map((value) => new Date(Date.parse(value)).toISOString())
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return candidates[0] ?? null;
}

function freezeOdooPurchaseOrderMapping(po: PurchaseOrder): Readonly<Record<string, unknown>> {
  const record = po as PurchaseOrder & Record<string, unknown>;
  if (po.sourceSystem === 'odoo') {
    const matched = /^purchase\.order:([1-9]\d*)$/.exec(requireRepositoryText(po.externalId, 'purchaseOrder.externalId'));
    const odooId = matched ? Number(matched[1]) : Number.NaN;
    if (!Number.isSafeInteger(odooId) || odooId <= 0) {
      throw new ProcurementValidationError('INVALID_INPUT', '采购订单没有合法的 Odoo purchase.order 映射');
    }
    return {
      sourceSystem: 'odoo',
      externalId: po.externalId,
      odooId,
      poNumber: requireRepositoryText(typeof record['number'] === 'string' ? record['number'] : '', 'purchaseOrder.number'),
    };
  }
  if (po.sourceSystem === 'readywork' && po.odooReference) {
    return {
      sourceSystem: 'readywork',
      externalId: po.externalId,
      odooId: requirePositiveSafeInteger(po.odooReference.id, 'purchaseOrder.odooReference.id'),
      poNumber: requireRepositoryText(po.odooReference.name, 'purchaseOrder.odooReference.name'),
      correlationKey: requireRepositoryText(po.odooReference.correlationKey, 'purchaseOrder.odooReference.correlationKey'),
    };
  }
  throw new ProcurementValidationError('INVALID_INPUT', '采购订单没有可回写的 Odoo 映射');
}

function freezeOdooPurchaseOrderLine(
  line: PurchaseOrderLine,
  poCurrency: string,
  index: number,
): Readonly<Record<string, unknown>> {
  const label = `采购订单第 ${index + 1} 行`;
  const itemId = requireRepositoryText(line.itemId, `${label}.itemId`);
  const description = requireRepositoryText(line.description ?? '', `${label}.description`);
  if (!Number.isFinite(line.orderedQty) || line.orderedQty <= 0) {
    throw new ProcurementValidationError('INVALID_INPUT', `${label}.qty 必须大于 0`);
  }
  if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
    throw new ProcurementValidationError('INVALID_INPUT', `${label}.unitPrice 必须不小于 0`);
  }
  const currency = requireRepositoryText(line.currency, `${label}.currency`);
  if (currency !== poCurrency) {
    throw new ProcurementValidationError('INVALID_INPUT', `${label}.currency 与 PO 币种不一致`);
  }
  const requestedAt = requireIsoDate(line.requestedAt ?? '', `${label}.requestedAt`);
  return {
    poLineId: requireRepositoryText(line.id, `${label}.poLineId`),
    itemId,
    description,
    qty: line.orderedQty,
    unitPrice: line.unitPrice,
    currency,
    requestedAt,
  };
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProcurementValidationError('INVALID_INPUT', `${field} 必须是正整数`);
  }
  return value;
}

function requirePositiveFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ProcurementValidationError('INVALID_INPUT', `${field} 必须大于 0`);
  }
  return value;
}

function requireOdooPurchaseOrderDraftResult(
  value: Readonly<Record<string, unknown>> | undefined,
  expectedCorrelationKey: string,
): { id: number; name: string } {
  if (!value) throw new ProcurementValidationError('INVALID_INPUT', 'Odoo 草稿回执不能为空');
  const id = requirePositiveSafeInteger(value['id'], 'connectorResult.id');
  const name = requireRepositoryText(typeof value['name'] === 'string' ? value['name'] : '', 'connectorResult.name');
  if (value['state'] !== 'draft') {
    throw new ProcurementValidationError('INVALID_INPUT', 'connectorResult.state 必须为 draft');
  }
  if (value['correlationKey'] !== expectedCorrelationKey) {
    throw new ProcurementValidationError('INVALID_INPUT', 'connectorResult.correlationKey 与 outbox 冻结值不一致');
  }
  return { id, name };
}

function requireFrozenOdooPurchaseOrderMapping(value: unknown): { poNumber: string; odooId: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProcurementValidationError('INVALID_INPUT', 'outbox.payload.odooMapping 必须是对象');
  }
  const mapping = value as Record<string, unknown>;
  return {
    poNumber: requireRepositoryText(typeof mapping['poNumber'] === 'string' ? mapping['poNumber'] : '', 'outbox.payload.odooMapping.poNumber'),
    odooId: requirePositiveSafeInteger(mapping['odooId'], 'outbox.payload.odooMapping.odooId'),
  };
}

function requireFrozenRihdLines(value: unknown): Array<{
  poLineId: string;
  lineNumber: string;
  orderedQty: number;
  requestedAt: string | null;
}> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProcurementValidationError('INVALID_INPUT', 'outbox.payload.lines 必须是非空行快照');
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ProcurementValidationError('INVALID_INPUT', `outbox.payload.lines[${index}] 必须是对象`);
    }
    const line = raw as Record<string, unknown>;
    const poLineId = requireRepositoryText(typeof line['poLineId'] === 'string' ? line['poLineId'] : '', `outbox.payload.lines[${index}].poLineId`);
    if (ids.has(poLineId)) throw new ProcurementValidationError('INVALID_INPUT', 'outbox.payload.lines.poLineId 不能重复');
    ids.add(poLineId);
    const requestedAt = line['requestedAt'] === null
      ? null
      : requireIsoDate(typeof line['requestedAt'] === 'string' ? line['requestedAt'] : '', `outbox.payload.lines[${index}].requestedAt`);
    return {
      poLineId,
      lineNumber: requireRepositoryText(typeof line['lineNumber'] === 'string' ? line['lineNumber'] : '', `outbox.payload.lines[${index}].lineNumber`),
      orderedQty: requirePositiveFiniteNumber(line['orderedQty'], `outbox.payload.lines[${index}].orderedQty`),
      requestedAt,
    };
  });
}

function requireOdooRihdResult(
  value: Readonly<Record<string, unknown>> | undefined,
  expectedPoNumber: string,
  expectedRequiredInHouseAt: string,
): { updatedLines: number; verifiedLines: number } {
  if (!value) throw new ProcurementValidationError('INVALID_INPUT', 'Odoo RIHD 回执不能为空');
  const poNumber = requireRepositoryText(typeof value['po_name'] === 'string' ? value['po_name'] : '', 'connectorResult.po_name');
  if (poNumber !== expectedPoNumber) throw new ProcurementValidationError('INVALID_INPUT', 'connectorResult.po_name 与冻结 Odoo 单号不一致');
  const requiredInHouseAt = requireIsoDate(
    typeof value['required_in_house_at'] === 'string' ? value['required_in_house_at'] : '',
    'connectorResult.required_in_house_at',
  );
  if (requiredInHouseAt.slice(0, 10) !== expectedRequiredInHouseAt.slice(0, 10)) {
    throw new ProcurementValidationError('INVALID_INPUT', 'connectorResult.required_in_house_at 与入队 RIHD 不一致');
  }
  return {
    updatedLines: requirePositiveSafeInteger(value['updated_lines'], 'connectorResult.updated_lines'),
    verifiedLines: requirePositiveSafeInteger(value['verified_lines'], 'connectorResult.verified_lines'),
  };
}

function requireExpectedVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ProcurementValidationError('INVALID_INPUT', 'expectedRfqVersion 必须是正整数');
  return value;
}

interface ProcurementCommunicationIdentitySnapshot {
  displayName: string;
  title: string;
  organizationName: string;
  version: number;
}

function requireActiveCommunicationIdentity(db: DatabaseSync, tenantId: string): ProcurementCommunicationIdentitySnapshot {
  const row = db.prepare(`SELECT display_name,title,organization_name,version,status
    FROM procurement_communication_identities WHERE tenant_id=?`).get(tenantId) as {
      display_name: string; title: string; organization_name: string; version: number; status: string;
    } | undefined;
  if (!row || row.status !== 'active') {
    throw new ProcurementValidationError('INVALID_INPUT', '尚未配置供应商可见的采购专业联系人，不能创建或发送外部沟通');
  }
  return { displayName: row.display_name, title: row.title, organizationName: row.organization_name, version: row.version };
}

function communicationSignature(identity: ProcurementCommunicationIdentitySnapshot): string {
  return `此致\n${identity.displayName}\n${identity.title}｜${identity.organizationName}`;
}

function isPlaceholderEmailRecipient(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  const domain = normalized.split('@')[1] ?? '';
  return !domain || domain === 'example.com' || domain.endsWith('.example.com')
    || domain === 'example.org' || domain === 'example.net'
    || domain === 'demo.cn' || domain.endsWith('.demo.cn') || domain.endsWith('.test');
}

function requireConfirmationMissingFields(value: readonly SupplierReplyField[]): SupplierReplyField[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new ProcurementValidationError('INVALID_INPUT', 'confirmationMissingFields 必须包含 1–2 个缺失确认字段');
  }
  const allowed = new Set<SupplierReplyField>(['quantity', 'unit_price', 'promised_date']);
  const normalized = value.map((field) => {
    if (typeof field !== 'string' || !allowed.has(field as SupplierReplyField)) {
      throw new ProcurementValidationError('INVALID_INPUT', 'confirmationMissingFields 包含未知字段');
    }
    return field as SupplierReplyField;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new ProcurementValidationError('INVALID_INPUT', 'confirmationMissingFields 不能重复');
  }
  return normalized;
}

function confirmationFieldLabel(field: SupplierReplyField): string {
  if (field === 'quantity') return '确认数量';
  if (field === 'unit_price') return '确认单价';
  return '承诺交期';
}

function buildExecutionConfirmationReplyBlock(poNumber: string, currency: string, lines: readonly PurchaseOrderLine[]): string {
  return [
    '[READYWORK-CONFIRMATION]',
    `PO:${poNumber}`,
    ...lines.map((line) => `LINE:${line.lineNumber} | QTY:${line.orderedQty} | UNIT_PRICE:${line.unitPrice} | CURRENCY:${currency} | PROMISED_DATE:${line.requestedAt?.slice(0, 10) ?? 'YYYY-MM-DD'}`),
    '[/READYWORK-CONFIRMATION]',
  ].join('\n');
}

function requireManualVerification(input: ProcurementExecutionMutationInput): { evidenceReference: string; reason: string } {
  if (input.permission !== 'approve') throw new ProcurementExecutionPermissionError('approve');
  if (input.evidenceSource !== 'manual_verified') {
    throw new ProcurementValidationError('INVALID_INPUT', '人工核验事实必须由服务端标记为 manual_verified');
  }
  return {
    evidenceReference: requireRepositoryText(input.evidenceReference ?? '', 'evidenceReference'),
    reason: requireRepositoryText(input.reason ?? '', 'reason'),
  };
}

type FulfilmentEvidence = {
  source: ProcurementFulfilmentEvidenceSource;
  sourceSystem: 'readywork-manual-verification' | 'supplier-email-ai';
  evidenceReference: string;
  verificationFields: { verifiedBy: EntityId; verificationReason: string } | Record<string, never>;
};

function requireFulfilmentEvidence(
  db: DatabaseSync,
  tenantId: string,
  po: PurchaseOrder,
  input: ProcurementExecutionMutationInput,
): FulfilmentEvidence {
  if (input.evidenceSource === 'manual_verified') {
    const verification = requireManualVerification(input);
    return {
      source: 'manual_verified', sourceSystem: 'readywork-manual-verification',
      evidenceReference: verification.evidenceReference,
      verificationFields: { verifiedBy: input.actorId, verificationReason: verification.reason },
    };
  }
  if (input.evidenceSource !== 'supplier_email_ai') {
    throw new ProcurementValidationError('INVALID_INPUT', '履约事实必须声明可信证据来源');
  }
  if (input.actorId !== 'ai:supplier-reply' || input.permission !== 'operate') {
    throw new ProcurementValidationError('INVALID_INPUT', '供应商邮件 AI 事实只能由受限内部解析器登记');
  }
  const evidenceReference = requireRepositoryText(input.evidenceReference ?? '', 'evidenceReference');
  const row = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='communication' AND id=?`).get(tenantId, evidenceReference) as { json: string } | undefined;
  if (!row) throw new ProcurementValidationError('INVALID_INPUT', '供应商邮件证据不存在');
  let communication: Communication;
  try { communication = JSON.parse(row.json) as Communication; }
  catch { throw new ProcurementValidationError('INVALID_INPUT', '供应商邮件证据损坏'); }
  if (communication.direction !== 'inbound' || communication.channel !== 'email'
      || communication.businessObjectType !== 'purchase_order' || communication.businessObjectId !== po.id
      || communication.supplierId !== po.supplierId) {
    throw new ProcurementValidationError('INVALID_INPUT', '供应商邮件证据与采购订单或供应商不一致');
  }
  return {
    source: 'supplier_email_ai', sourceSystem: 'supplier-email-ai', evidenceReference, verificationFields: {},
  };
}

function requireExecutionLines(lines: readonly ExecutionLineInput[] | undefined): readonly ExecutionLineInput[] {
  if (!Array.isArray(lines) || lines.length === 0) throw new ProcurementValidationError('INVALID_INPUT', 'lines 必须是非空数组');
  assertUniqueExecutionLineIds(lines);
  return lines;
}

function assertUniqueExecutionLineIds(lines: readonly ExecutionLineInput[]): void {
  const ids = lines.map((line) => requireRepositoryText(line.poLineId, 'poLineId'));
  if (new Set(ids).size !== ids.length) throw new ProcurementValidationError('INVALID_INPUT', 'poLineId 不能重复');
}

function requirePositiveQuantity(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new ProcurementValidationError('INVALID_INPUT', `${field} 必须大于 0`);
  return value;
}

function requireExecutionDecision(value: ProcurementExecutionMutationInput['decision']): 'approved' | 'rejected' {
  if (value !== 'approved' && value !== 'rejected') throw new ProcurementValidationError('INVALID_INPUT', 'decision 必须为 approved 或 rejected');
  return value;
}

function requireShortfallDisposition(
  value: ProcurementExecutionMutationInput['shortfallDisposition'],
): 'cancel_remainder' {
  if (value !== 'cancel_remainder') {
    throw new ProcurementValidationError('INVALID_INPUT', '短交审批必须显式指定 shortfallDisposition=cancel_remainder');
  }
  return value;
}

const productionProgressStatuses = new Set<ProductionProgressStatus>([
  'materials_ready', 'in_production', 'quality_check', 'ready_to_ship', 'delayed', 'blocked',
]);

function requireProductionProgressStatus(value: ExecutionLineInput['progressStatus']): ProductionProgressStatus {
  if (!value || !productionProgressStatuses.has(value)) {
    throw new ProcurementValidationError('INVALID_INPUT', 'progressStatus 不是允许的生产进度状态');
  }
  return value;
}

function productionOverallStatus(statuses: readonly ProductionProgressStatus[]): ProductionProgressStatus {
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('delayed')) return 'delayed';
  if (statuses.every((status) => status === 'ready_to_ship')) return 'ready_to_ship';
  if (statuses.includes('quality_check')) return 'quality_check';
  if (statuses.includes('in_production')) return 'in_production';
  return 'materials_ready';
}

const transportEventCodes = new Set<TransportEventCode>([
  'picked_up', 'departed_origin', 'arrived_port', 'customs_submitted', 'customs_cleared',
  'customs_held', 'out_for_delivery', 'delivered', 'exception',
]);

function requireTransportEventCode(value: ProcurementExecutionMutationInput['eventCode']): TransportEventCode {
  if (!value || !transportEventCodes.has(value)) {
    throw new ProcurementValidationError('INVALID_INPUT', 'eventCode 不是允许的运输节点');
  }
  return value;
}

function procurementRouteForPo(db: DatabaseSync, tenantId: string, po: PurchaseOrder): 'local' | 'import' | 'unclassified' {
  const assignment = db.prepare(`SELECT route FROM procurement_route_assignments WHERE tenant_id=? AND po_id=?`)
    .get(tenantId, po.id) as { route: string } | undefined;
  if (assignment?.route === 'local' || assignment?.route === 'import') return assignment.route;
  const record = po as unknown as Record<string, unknown>;
  for (const field of ['procurementRoute', 'route']) {
    const value = String(record[field] ?? '').trim().toLowerCase();
    if (['import', 'international', '进口', '海外'].includes(value)) return 'import';
    if (['local', 'domestic', '本地', '国内'].includes(value)) return 'local';
  }
  return 'unclassified';
}

function requireIsoDate(value: string, field: string): string {
  requireRepositoryText(value, field);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new ProcurementValidationError('INVALID_INPUT', `${field} 必须是有效日期`);
  return new Date(time).toISOString();
}

/** Task 8 evidence timestamps are externally meaningful, so unlike older
 * generic timestamps they accept only RFC3339 and are stored as UTC. */
function requireEvidenceTimestamp(value: string, field: string): string {
  if (typeof value !== 'string') throw new ProcurementValidationError('INVALID_INPUT', `${field} 必须是 RFC3339 时间戳`);
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!matched) throw new ProcurementValidationError('INVALID_INPUT', `${field} 必须是 RFC3339 时间戳`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = matched;
  const offsetText = offset!;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59 || (offsetText !== 'Z' && (Number(offsetText.slice(1, 3)) > 23 || Number(offsetText.slice(4, 6)) > 59))) {
    throw new ProcurementValidationError('INVALID_INPUT', `${field} 必须是 RFC3339 时间戳`);
  }
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    throw new ProcurementValidationError('INVALID_INPUT', `${field} 必须是 RFC3339 时间戳`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new ProcurementValidationError('INVALID_INPUT', `${field} 必须是 RFC3339 时间戳`);
  return new Date(time).toISOString();
}

function validateQuoteVersionExpectations(values: readonly QuoteVersionExpectation[]): void {
  if (!values.length) throw new ProcurementValidationError('QUOTE_SET_MISMATCH', '报价版本集不能为空');
  const ids = new Set<string>();
  for (const value of values) {
    requireRepositoryText(value.quoteId, 'quoteId');
    if (!Number.isSafeInteger(value.version) || value.version <= 0) throw new ProcurementValidationError('INVALID_INPUT', 'quote version 必须是正整数');
    if (ids.has(value.quoteId)) throw new ProcurementValidationError('QUOTE_SET_MISMATCH', 'quoteId 不能重复');
    ids.add(value.quoteId);
  }
}

function validateQuoteComparisonSnapshot(snapshot: QuoteComparisonSnapshot): void {
  for (const [field, value] of [
    ['snapshot.id', snapshot.id],
    ['snapshot.externalId', snapshot.externalId],
    ['snapshot.sourceSystem', snapshot.sourceSystem],
    ['snapshot.rfqId', snapshot.rfqId],
    ['snapshot.createdBy', snapshot.createdBy],
    ['snapshot.comparisonCurrency', snapshot.comparisonCurrency],
    ['snapshot.ruleVersion', snapshot.ruleVersion],
    ['snapshot.rateSnapshot.version', snapshot.rateSnapshot.version],
  ] as const) requireRepositoryText(value, field);
  requireIsoDate(snapshot.createdAt, 'snapshot.createdAt');
  requireIsoDate(snapshot.updatedAt, 'snapshot.updatedAt');
  requireIsoDate(snapshot.asOf, 'snapshot.asOf');
  const weights = Object.values(snapshot.weights);
  if (weights.some((value) => !Number.isFinite(value) || value < 0) || weights.every((value) => value === 0)) {
    throw new ProcurementValidationError('INVALID_INPUT', '比较权重必须为非负数且至少一项大于 0');
  }
  for (const value of Object.values(snapshot.rateSnapshot.rates)) {
    if (!Number.isFinite(value) || value <= 0) throw new ProcurementValidationError('INVALID_INPUT', '比较汇率必须大于 0');
  }
  for (const line of snapshot.lineComparisons) {
    requireRepositoryText(line.rfqLineId, 'lineComparison.rfqLineId');
    if (!line.quotes.length) throw new ProcurementValidationError('QUOTE_SET_MISMATCH', '每个 RFQ 行必须至少包含一个报价结果');
    for (const quote of line.quotes) {
      requireRepositoryText(quote.quoteId, 'lineComparison.quoteId');
      requireRepositoryText(quote.quoteLineId, 'lineComparison.quoteLineId');
      if (!Number.isSafeInteger(quote.quoteVersion) || quote.quoteVersion <= 0) {
        throw new ProcurementValidationError('INVALID_INPUT', 'lineComparison.quoteVersion 必须是正整数');
      }
    }
  }
}

function assertExactIdSet(
  actual: readonly string[],
  expected: readonly string[],
  code: ProcurementValidationCode,
  message: string,
): void {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length) {
    throw new ProcurementValidationError(code, message);
  }
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw new ProcurementValidationError(code, message);
  }
}

function rollback(db: DatabaseSync): void {
  try { db.exec('ROLLBACK'); } catch { /* transaction 已结束 */ }
}

class SqliteOrgRepository implements OrgRepository {
  constructor(private db: DatabaseSync, private tenantId: string) {}

  list(): OrgRow[] {
    const rows = this.db.prepare('SELECT kind, id, json FROM runtime_org WHERE tenant_id = ?').all(this.tenantId) as { kind: OrgRow['kind']; id: string; json: string }[];
    return rows;
  }

  get(kind: OrgRow['kind'], id: string): OrgRow | undefined {
    return this.db.prepare('SELECT kind, id, json FROM runtime_org WHERE tenant_id = ? AND kind = ? AND id = ?').get(this.tenantId, kind, id) as OrgRow | undefined;
  }

  save(row: OrgRow): void {
    this.db
      .prepare('INSERT INTO runtime_org (tenant_id, kind, id, json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, kind, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
      .run(this.tenantId, row.kind, row.id, row.json, nowIso());
  }
}

class SqliteWorkforceRepository implements WorkforceRepository {
  constructor(private db: DatabaseSync, private tenantId: string) {}

  saveDefinition(definition: EmployeeDefinition, currentVersionId: string): void {
    if (definition.tenantId !== this.tenantId) throw new Error('员工定义与仓储租户不一致');
    this.db.prepare('INSERT INTO workforce_employees (tenant_id,id,definition_json,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET definition_json=excluded.definition_json,current_version_id=excluded.current_version_id,updated_at=excluded.updated_at')
      .run(this.tenantId, definition.id, JSON.stringify(definition), currentVersionId, definition.createdAt, definition.updatedAt);
  }

  getDefinition(id: string): EmployeeDefinition | undefined {
    const row = this.db.prepare('SELECT definition_json FROM workforce_employees WHERE tenant_id=? AND id=?').get(this.tenantId, id) as { definition_json: string } | undefined;
    return row ? JSON.parse(row.definition_json) as EmployeeDefinition : undefined;
  }

  listDefinitions(): EmployeeDefinition[] {
    return (this.db.prepare('SELECT definition_json FROM workforce_employees WHERE tenant_id=? ORDER BY created_at').all(this.tenantId) as Array<{ definition_json: string }>).map((row) => JSON.parse(row.definition_json) as EmployeeDefinition);
  }

  saveVersion(version: EmployeeVersion): void {
    if (version.tenantId !== this.tenantId) throw new Error('员工版本与仓储租户不一致');
    this.db.prepare('INSERT INTO workforce_employee_versions (tenant_id,id,employee_id,version,definition_json,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET definition_json=excluded.definition_json')
      .run(this.tenantId, version.id, version.employeeId, version.version, JSON.stringify(version), version.createdAt);
  }

  getVersion(id: string): EmployeeVersion | undefined {
    const row = this.db.prepare('SELECT definition_json FROM workforce_employee_versions WHERE tenant_id=? AND id=?').get(this.tenantId, id) as { definition_json: string } | undefined;
    return row ? JSON.parse(row.definition_json) as EmployeeVersion : undefined;
  }

  listVersions(employeeId: string): EmployeeVersion[] {
    return (this.db.prepare('SELECT definition_json FROM workforce_employee_versions WHERE tenant_id=? AND employee_id=? ORDER BY created_at').all(this.tenantId, employeeId) as Array<{ definition_json: string }>).map((row) => JSON.parse(row.definition_json) as EmployeeVersion);
  }

  saveDeployment(deployment: EmployeeDeployment): void {
    if (deployment.tenantId !== this.tenantId) throw new Error('员工部署与仓储租户不一致');
    this.db.prepare('INSERT INTO workforce_employee_deployments (tenant_id,employee_id,version_id,deploy_mode,active_workflow_version_id,permission_policy_id,rule_set_id,connector_grant_ids_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,employee_id) DO UPDATE SET version_id=excluded.version_id,deploy_mode=excluded.deploy_mode,active_workflow_version_id=excluded.active_workflow_version_id,permission_policy_id=excluded.permission_policy_id,rule_set_id=excluded.rule_set_id,connector_grant_ids_json=excluded.connector_grant_ids_json,updated_at=excluded.updated_at')
      .run(this.tenantId, deployment.employeeId, deployment.versionId, deployment.deployMode, deployment.activeWorkflowVersionId ?? null, deployment.permissionPolicyId ?? null, deployment.ruleSetId ?? null, JSON.stringify(deployment.connectorGrantIds), deployment.updatedAt);
  }

  getDeployment(employeeId: string): EmployeeDeployment | undefined {
    const row = this.db.prepare('SELECT version_id,deploy_mode,active_workflow_version_id,permission_policy_id,rule_set_id,connector_grant_ids_json,updated_at FROM workforce_employee_deployments WHERE tenant_id=? AND employee_id=?').get(this.tenantId, employeeId) as { version_id: string; deploy_mode: EmployeeDeployment['deployMode']; active_workflow_version_id: string | null; permission_policy_id: string | null; rule_set_id: string | null; connector_grant_ids_json: string; updated_at: string } | undefined;
    if (!row) return undefined;
    return {
      tenantId: this.tenantId,
      employeeId,
      versionId: row.version_id,
      deployMode: row.deploy_mode,
      activeWorkflowVersionId: row.active_workflow_version_id ?? undefined,
      permissionPolicyId: row.permission_policy_id ?? undefined,
      ruleSetId: row.rule_set_id ?? undefined,
      connectorGrantIds: JSON.parse(row.connector_grant_ids_json) as string[],
      updatedAt: row.updated_at,
    };
  }
}

interface DocumentJobRow {
  tenant_id: string;
  id: string;
  attachment_id: string;
  status: ProcurementDocumentJob['status'];
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_at: string | null;
  lock_token: string | null;
  lease_expires_at: string | null;
  error: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function documentJobFromRow(row: DocumentJobRow): ProcurementDocumentJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    attachmentId: row.attachment_id,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: row.available_at,
    ...(row.locked_at ? { lockedAt: row.locked_at } : {}),
    ...(row.lock_token ? { lockToken: row.lock_token } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) as Readonly<Record<string, unknown>> } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

/**
 * Final GRN is the irreversible V1 boundary for an import PO.  This check is
 * executed inside the same BEGIN IMMEDIATE transaction as the receipt so a
 * policy, binding, attachment scan or expiry cannot change between preflight
 * and the PO becoming received.
 */
function assertImportDocumentCompletionGate(
  db: DatabaseSync,
  tenantId: string,
  poId: string,
  po: PurchaseOrder & Record<string, unknown>,
  at: string,
): void {
  const assignment = db.prepare(`SELECT route FROM procurement_route_assignments WHERE tenant_id=? AND po_id=?`)
    .get(tenantId, poId) as { route: string } | undefined;
  const explicitRoute = String(po['procurementRoute'] ?? po['route'] ?? '').trim().toLowerCase();
  const isImport = assignment?.route === 'import' || (!assignment && ['import', 'international', '进口', '海外'].includes(explicitRoute));
  if (!isImport) return;

  const policy = db.prepare(`SELECT id,version,requirements_json FROM procurement_import_document_policies
    WHERE tenant_id=? AND status='published' ORDER BY published_at DESC,id LIMIT 1`)
    .get(tenantId) as { id: string; version: number; requirements_json: string } | undefined;
  if (!policy) throw new ProcurementValidationError('IMPORT_DOCUMENT_GATE_BLOCKED', '进口 PO 完成受阻：尚未发布进口单证策略');

  let requirements: Array<{ code?: unknown; name?: unknown; required?: unknown; expiryRequired?: unknown }>;
  try { requirements = JSON.parse(policy.requirements_json) as Array<{ code?: unknown; name?: unknown; required?: unknown; expiryRequired?: unknown }>; }
  catch { throw new ProcurementValidationError('IMPORT_DOCUMENT_GATE_BLOCKED', '进口 PO 完成受阻：已发布单证策略无法解析'); }
  const required = requirements.filter((item) => item.required !== false && typeof item.code === 'string' && item.code.trim());
  if (required.length === 0) throw new ProcurementValidationError('IMPORT_DOCUMENT_GATE_BLOCKED', '进口 PO 完成受阻：已发布策略未配置必需单证');

  const rows = db.prepare(`SELECT d.requirement_code,d.expires_at,a.security_status,a.status AS attachment_status
    FROM procurement_import_documents d
    JOIN procurement_attachments a ON a.tenant_id=d.tenant_id AND a.id=d.attachment_id
    WHERE d.tenant_id=? AND d.po_id=? AND d.status='active'`)
    .all(tenantId, poId) as Array<{ requirement_code: string; expires_at: string | null; security_status: string; attachment_status: string }>;
  const byCode = new Map(rows.map((row) => [row.requirement_code, row] as const));
  const problems: string[] = [];
  for (const requirement of required) {
    const code = String(requirement.code);
    const label = typeof requirement.name === 'string' && requirement.name.trim() ? requirement.name.trim() : code;
    const document = byCode.get(code);
    if (!document || document.attachment_status !== 'active') { problems.push(`${label}缺失`); continue; }
    if (document.security_status !== 'clean') { problems.push(`${label}尚未通过安全扫描`); continue; }
    if (requirement.expiryRequired === true && !document.expires_at) { problems.push(`${label}缺少失效日期`); continue; }
    if (document.expires_at && Date.parse(document.expires_at) < Date.parse(at)) problems.push(`${label}已过期`);
  }
  if (problems.length) {
    throw new ProcurementValidationError('IMPORT_DOCUMENT_GATE_BLOCKED', `进口 PO 完成受阻：${problems.join('；')}`);
  }
}

// ---------------------------------------------------------------- Hub 装配

/** 用持久化仓储创建 RuntimeHub，并做重启恢复（事件日志回灌 + 中断任务规范化） */
export function createPersistentRuntimeHub(store: PersistenceStore, options: { normalizeInterrupted?: boolean } = {}): RuntimeHub {
  const hub = createRuntimeHub({
    taskRepo: store.tasks,
    objectRepo: store.objects,
    approvalRepo: store.approvals,
    eventRepo: store.events,
    budgetRepo: store.budget,
    exceptionRepo: store.exceptions,
    activityRepo: store.activities,
  });
  // 事件日志回灌（控制塔 recentEvents 可见历史）
  hub.eventLog.push(...store.events.list(500));
  if (options.normalizeInterrupted !== false) normalizeInterruptedTasks(hub);
  return hub;
}

/** 重启时：created/queued/running 的任务标记为 failed（进程中断） */
export function normalizeInterruptedTasks(hub: RuntimeHub): number {
  let n = 0;
  for (const t of hub.taskRepo.list()) {
    if (t.status !== 'created' && t.status !== 'queued' && t.status !== 'running') continue;
    t.status = 'failed';
    t.error = '进程中断：重启时任务未完成';
    t.failedAt = nowIso();
    hub.taskRepo.save(t);
    hub.bus.emit({ type: 'task.failed', taskId: t.id, employeeId: t.employeeId, error: t.error, attempts: t.attempts, at: nowIso() });
    n += 1;
  }
  return n;
}

/** 订阅事件，持续把员工状态/统计与预算写入 org/budget 表 */
export function attachPersistence(store: PersistenceStore, hub: RuntimeHub): void {
  const saveAi = (id: EntityId): void => {
    const e = hub.org.getAI(id);
    if (e) store.org.save({ kind: 'ai', id: e.id, json: JSON.stringify(e) });
  };
  hub.bus.subscribe((e) => {
    switch (e.type) {
      case 'employee.status_changed':
        saveAi(e.employeeId);
        return;
      case 'task.completed':
      case 'task.failed':
        saveAi(e.employeeId);
        return;
      case 'task.approved':
      case 'task.rejected': {
        const t = hub.machine.get(e.taskId);
        if (t) saveAi(t.employeeId);
        return;
      }
      case 'tool.called':
        saveAi(e.employeeId);
        return;
      case 'budget.recorded': {
        const b = hub.budget.state(e.employeeId);
        if (b) store.budget.save(b);
        return;
      }
    }
  });
}

/** 把当前组织/员工快照写入持久化（启动时调用一次）。
 *  静态组织（tenant/department/human）幂等覆盖；AI 员工行只在首次出现时写入，
 *  之后的运行状态（status/stats）由 attachPersistence 的事件订阅维护，避免覆盖持久化状态。 */
export function persistOrg(store: PersistenceStore, hub: RuntimeHub): void {
  for (const t of hub.org.listTenants()) store.org.save({ kind: 'tenant', id: t.id, json: JSON.stringify(t) });
  for (const d of hub.org.listDepartments()) store.org.save({ kind: 'department', id: d.id, json: JSON.stringify(d) });
  for (const h of hub.org.listHumans()) store.org.save({ kind: 'human', id: h.id, json: JSON.stringify(h) });
  for (const a of hub.org.listAI()) {
    if (!store.org.get('ai', a.id)) store.org.save({ kind: 'ai', id: a.id, json: JSON.stringify(a) });
  }
}

/** 重启后：把持久化的 AI 员工运行状态（status/stats）回写到新注册的员工上，返回恢复数量 */
export function restoreOrgState(store: PersistenceStore, hub: RuntimeHub): number {
  let n = 0;
  for (const row of store.org.list().filter((r) => r.kind === 'ai')) {
    const saved = JSON.parse(row.json) as AIEmployee;
    const cur = hub.org.getAI(saved.id);
    if (!cur) continue;
    cur.status = saved.status;
    cur.stats = saved.stats;
    n += 1;
  }
  return n;
}
