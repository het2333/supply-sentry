import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './http-errors.js';

const ERP_VALUES = new Set(['', 'sap', 'quickbooks', 'other', 'none']);
const PO_VOLUME_VALUES = new Set(['', 'lt100', '100-500', 'gt500']);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{11,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PublicDemoRequestInput {
  readonly fullName?: unknown;
  readonly email?: unknown;
  readonly company?: unknown;
  readonly role?: unknown;
  readonly country?: unknown;
  readonly erp?: unknown;
  readonly poVolume?: unknown;
  readonly message?: unknown;
  readonly website?: unknown;
}

export interface PublicDemoRequestResult {
  readonly accepted: true;
  readonly requestId: string;
  readonly submittedAt: string;
  readonly replayed: boolean;
}

interface NormalizedDemoRequest {
  fullName: string;
  email: string;
  company: string;
  role: string;
  country: string;
  erp: string;
  poVolume: string;
  message: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function required(value: unknown, label: string, min: number, max: number): string {
  const normalized = text(value);
  if (normalized.length < min || normalized.length > max) {
    throw new HttpError(400, `${label}长度必须为 ${min}–${max} 个字符`, 'DEMO_REQUEST_INVALID');
  }
  return normalized;
}

function optional(value: unknown, label: string, max: number): string {
  const normalized = text(value);
  if (normalized.length > max) throw new HttpError(400, `${label}不能超过 ${max} 个字符`, 'DEMO_REQUEST_INVALID');
  return normalized;
}

function normalizeInput(input: PublicDemoRequestInput): NormalizedDemoRequest {
  if (text(input.website)) throw new HttpError(400, 'Demo 申请未通过校验', 'DEMO_REQUEST_REJECTED');
  const email = required(input.email, '工作邮箱', 5, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, '工作邮箱格式无效', 'DEMO_REQUEST_INVALID');
  const erp = optional(input.erp, 'ERP 系统', 32).toLowerCase();
  const poVolume = optional(input.poVolume, '每月 PO 数量', 32).toLowerCase();
  if (!ERP_VALUES.has(erp)) throw new HttpError(400, 'ERP 系统选项无效', 'DEMO_REQUEST_INVALID');
  if (!PO_VOLUME_VALUES.has(poVolume)) throw new HttpError(400, '每月 PO 数量选项无效', 'DEMO_REQUEST_INVALID');
  return {
    fullName: required(input.fullName, '姓名', 2, 120),
    email,
    company: required(input.company, '公司', 2, 160),
    role: optional(input.role, '职位', 120),
    country: optional(input.country, '国家或地区', 120),
    erp,
    poVolume,
    message: optional(input.message, '试点说明', 2_000),
  };
}

function payloadHash(input: NormalizedDemoRequest): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function submitPublicDemoRequest(
  db: DatabaseSync,
  input: PublicDemoRequestInput,
  idempotencyKeyValue: string | undefined,
  options: { source?: string; now?: string } = {},
): PublicDemoRequestResult {
  const idempotencyKey = text(idempotencyKeyValue);
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new HttpError(400, '缺少有效的幂等键', 'INVALID_IDEMPOTENCY_KEY');
  }
  const normalized = normalizeInput(input);
  const hash = payloadHash(normalized);
  const at = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new Error('Demo 申请时间无效');
  const source = optional(options.source ?? 'product-page', '来源', 80) || 'product-page';

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare(`SELECT id,payload_hash,created_at FROM public_demo_requests WHERE idempotency_key=?`)
      .get(idempotencyKey) as { id: string; payload_hash: string; created_at: string } | undefined;
    if (existing) {
      if (existing.payload_hash !== hash) {
        throw new HttpError(409, '该幂等键已被另一份 Demo 申请使用', 'DEMO_REQUEST_IDEMPOTENCY_CONFLICT');
      }
      db.prepare(`INSERT INTO public_demo_request_events (request_id,event_type,actor_type,metadata_json,created_at) VALUES (?,?,?,?,?)`)
        .run(existing.id, 'idempotent_replay', 'public_visitor', JSON.stringify({ source }), at);
      db.exec('COMMIT');
      return { accepted: true, requestId: existing.id, submittedAt: existing.created_at, replayed: true };
    }

    const requestId = `demo:${randomUUID()}`;
    db.prepare(`INSERT INTO public_demo_requests (
      id,idempotency_key,payload_hash,full_name,work_email,company,role,country,erp,po_volume,message,source,status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      requestId,
      idempotencyKey,
      hash,
      normalized.fullName,
      normalized.email,
      normalized.company,
      normalized.role || null,
      normalized.country || null,
      normalized.erp || null,
      normalized.poVolume || null,
      normalized.message || null,
      source,
      'submitted',
      at,
      at,
    );
    db.prepare(`INSERT INTO public_demo_request_events (request_id,event_type,actor_type,metadata_json,created_at) VALUES (?,?,?,?,?)`)
      .run(requestId, 'submitted', 'public_visitor', JSON.stringify({ source }), at);
    db.exec('COMMIT');
    return { accepted: true, requestId, submittedAt: at, replayed: false };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already completed */ }
    throw error;
  }
}
