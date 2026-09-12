import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';
import { supportsProcurementPublicHolidays } from './procurement-public-holidays.js';

export const PROCUREMENT_DATE_FORMATS = ['DD MMM YYYY', 'YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'] as const;
export type ProcurementDateFormat = (typeof PROCUREMENT_DATE_FORMATS)[number];

export interface ProcurementTenantPreferences {
  countryCode: string;
  workingDays: number[];
  timeZone: string;
  dateFormat: ProcurementDateFormat;
  slaEscalationsEnabled: boolean;
  excludeWeekends: boolean;
  excludePublicHolidays: boolean;
  autoCalculateLeadTime: boolean;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_PROCUREMENT_TENANT_PREFERENCES = Object.freeze({
  countryCode: 'CN',
  workingDays: Object.freeze([1, 2, 3, 4, 5]),
  timeZone: 'Asia/Shanghai',
  dateFormat: 'DD MMM YYYY' as ProcurementDateFormat,
  slaEscalationsEnabled: true,
  excludeWeekends: true,
  excludePublicHolidays: true,
  autoCalculateLeadTime: true,
});

interface PreferenceRow {
  country_code: string;
  working_days_json: string;
  time_zone: string;
  date_format: ProcurementDateFormat;
  sla_escalations_enabled: number;
  exclude_weekends: number;
  exclude_public_holidays: number;
  auto_calculate_lead_time: number;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export function getProcurementTenantPreferences(db: DatabaseSync, tenantId: string): ProcurementTenantPreferences | null {
  const row = db.prepare(`SELECT country_code,working_days_json,time_zone,date_format,sla_escalations_enabled,exclude_weekends,exclude_public_holidays,auto_calculate_lead_time,version,created_by,updated_by,created_at,updated_at
    FROM procurement_tenant_preferences WHERE tenant_id=?`).get(tenantId) as PreferenceRow | undefined;
  return row ? present(row) : null;
}

export function effectiveProcurementTenantPreferences(db: DatabaseSync, tenantId: string): Omit<ProcurementTenantPreferences, 'version' | 'createdBy' | 'updatedBy' | 'createdAt' | 'updatedAt'> {
  const stored = getProcurementTenantPreferences(db, tenantId);
  if (stored) return {
    countryCode: stored.countryCode,
    workingDays: stored.workingDays,
    timeZone: stored.timeZone,
    dateFormat: stored.dateFormat,
    slaEscalationsEnabled: stored.slaEscalationsEnabled,
    excludeWeekends: stored.excludeWeekends,
    excludePublicHolidays: stored.excludePublicHolidays,
    autoCalculateLeadTime: stored.autoCalculateLeadTime,
  };
  return {
    countryCode: DEFAULT_PROCUREMENT_TENANT_PREFERENCES.countryCode,
    workingDays: [...DEFAULT_PROCUREMENT_TENANT_PREFERENCES.workingDays],
    timeZone: DEFAULT_PROCUREMENT_TENANT_PREFERENCES.timeZone,
    dateFormat: DEFAULT_PROCUREMENT_TENANT_PREFERENCES.dateFormat,
    slaEscalationsEnabled: DEFAULT_PROCUREMENT_TENANT_PREFERENCES.slaEscalationsEnabled,
    excludeWeekends: DEFAULT_PROCUREMENT_TENANT_PREFERENCES.excludeWeekends,
    excludePublicHolidays: DEFAULT_PROCUREMENT_TENANT_PREFERENCES.excludePublicHolidays,
    autoCalculateLeadTime: DEFAULT_PROCUREMENT_TENANT_PREFERENCES.autoCalculateLeadTime,
  };
}

export function effectiveProcurementWorkingDays(
  preferences: Pick<ProcurementTenantPreferences, 'workingDays' | 'excludeWeekends'>,
): number[] {
  return preferences.excludeWeekends
    ? preferences.workingDays.filter((day) => day !== 6 && day !== 7)
    : [...preferences.workingDays];
}

export async function handleProcurementTenantPreferencesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: { db: DatabaseSync; session: Session | null; now?: () => Date },
): Promise<boolean> {
  if (path !== '/api/procurement/tenant-preferences') return false;
  if (!context.session) return json(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { db, session } = context;
  if (!can(session, 'read')) return json(res, 403, { error: '无读取采购区域偏好权限', code: 'FORBIDDEN' });
  if (method === 'GET') return json(res, 200, view(db, session));
  if (method !== 'PUT') return json(res, 405, { error: '不支持的请求方法', code: 'METHOD_NOT_ALLOWED' });
  if (!can(session, 'configure')) return json(res, 403, { error: '只有采购经理或管理员可以配置区域与日历偏好', code: 'FORBIDDEN' });

  try {
    const body = await readJson(req);
    const allowed = new Set([
      'expectedVersion', 'countryCode', 'workingDays', 'timeZone', 'dateFormat',
      'slaEscalationsEnabled', 'excludeWeekends', 'excludePublicHolidays', 'autoCalculateLeadTime', 'reason',
    ]);
    for (const key of Object.keys(body)) if (!allowed.has(key)) throw new PreferenceInputError(`不允许的字段: ${key}`);
    const expectedVersion = nonNegativeInteger(body['expectedVersion'], 'expectedVersion');
    const countryCode = country(body['countryCode']);
    const workingDays = workingDaysValue(body['workingDays']);
    const timeZone = timeZoneValue(body['timeZone']);
    const dateFormat = dateFormatValue(body['dateFormat']);
    const slaEscalationsEnabled = booleanValue(body['slaEscalationsEnabled'], 'slaEscalationsEnabled');
    const excludeWeekends = booleanValue(body['excludeWeekends'], 'excludeWeekends');
    const excludePublicHolidays = booleanValue(body['excludePublicHolidays'], 'excludePublicHolidays');
    const autoCalculateLeadTime = booleanValue(body['autoCalculateLeadTime'], 'autoCalculateLeadTime');
    if (excludeWeekends && workingDays.every((day) => day === 6 || day === 7)) {
      throw new PreferenceInputError('排除周末后必须至少保留一个周一至周五的工作日');
    }
    if (excludePublicHolidays && !supportsProcurementPublicHolidays(countryCode)) {
      throw new PreferenceInputError(`${countryCode} 暂无可验证的公共节假日日历；请关闭排除公共节假日或改用受支持国家`);
    }
    const reason = requiredText(body['reason'], '配置依据', 500, 10);
    const at = (context.now?.() ?? new Date()).toISOString();
    let created = false;

    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getProcurementTenantPreferences(db, session.tenantId);
      if (!current) {
        if (expectedVersion !== 0) throw new PreferenceVersionError(0);
        db.prepare(`INSERT INTO procurement_tenant_preferences
          (tenant_id,country_code,working_days_json,time_zone,date_format,sla_escalations_enabled,exclude_weekends,exclude_public_holidays,auto_calculate_lead_time,version,created_by,updated_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(
          session.tenantId, countryCode, JSON.stringify(workingDays), timeZone, dateFormat,
          integerBoolean(slaEscalationsEnabled), integerBoolean(excludeWeekends), integerBoolean(excludePublicHolidays), integerBoolean(autoCalculateLeadTime),
          session.humanId, session.humanId, at, at,
        );
        insertEvent(db, session.tenantId, session.humanId, 'created', {
          previous: DEFAULT_PROCUREMENT_TENANT_PREFERENCES,
          current: { countryCode, workingDays, timeZone, dateFormat, slaEscalationsEnabled, excludeWeekends, excludePublicHolidays, autoCalculateLeadTime },
          previousVersion: 0,
          version: 1,
          reason,
        }, at);
        created = true;
      } else {
        if (current.version !== expectedVersion) throw new PreferenceVersionError(current.version);
        const changed = current.countryCode !== countryCode
          || current.timeZone !== timeZone
          || current.dateFormat !== dateFormat
          || current.slaEscalationsEnabled !== slaEscalationsEnabled
          || current.excludeWeekends !== excludeWeekends
          || current.excludePublicHolidays !== excludePublicHolidays
          || current.autoCalculateLeadTime !== autoCalculateLeadTime
          || JSON.stringify(current.workingDays) !== JSON.stringify(workingDays);
        if (changed) {
          const updated = db.prepare(`UPDATE procurement_tenant_preferences
            SET country_code=?,working_days_json=?,time_zone=?,date_format=?,sla_escalations_enabled=?,exclude_weekends=?,exclude_public_holidays=?,auto_calculate_lead_time=?,version=version+1,updated_by=?,updated_at=?
            WHERE tenant_id=? AND version=?`).run(
            countryCode, JSON.stringify(workingDays), timeZone, dateFormat,
            integerBoolean(slaEscalationsEnabled), integerBoolean(excludeWeekends), integerBoolean(excludePublicHolidays), integerBoolean(autoCalculateLeadTime),
            session.humanId, at, session.tenantId, expectedVersion,
          );
          if (updated.changes !== 1) throw new PreferenceVersionError(getProcurementTenantPreferences(db, session.tenantId)?.version ?? expectedVersion);
          insertEvent(db, session.tenantId, session.humanId, 'updated', {
            previous: snapshot(current),
            current: { countryCode, workingDays, timeZone, dateFormat, slaEscalationsEnabled, excludeWeekends, excludePublicHolidays, autoCalculateLeadTime },
            previousVersion: expectedVersion,
            version: expectedVersion + 1,
            reason,
          }, at);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return json(res, created ? 201 : 200, view(db, session));
  } catch (error) {
    if (error instanceof PreferenceVersionError) return json(res, 409, {
      error: error.message,
      code: 'TENANT_PREFERENCES_VERSION_CONFLICT',
      currentVersion: error.currentVersion,
    });
    if (error instanceof PreferenceInputError) return json(res, 422, { error: error.message, code: 'INVALID_TENANT_PREFERENCES' });
    return json(res, 500, { error: '采购区域偏好保存失败', code: 'TENANT_PREFERENCES_WRITE_FAILED' });
  }
}

function view(db: DatabaseSync, session: Session): Record<string, unknown> {
  const item = getProcurementTenantPreferences(db, session.tenantId);
  const events = db.prepare(`SELECT id,actor_id,action,detail_json,created_at
    FROM procurement_tenant_preference_events WHERE tenant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20`)
    .all(session.tenantId) as Array<{ id: string; actor_id: string; action: string; detail_json: string; created_at: string }>;
  return {
    item,
    effective: effectiveProcurementTenantPreferences(db, session.tenantId),
    inheritedDefault: !item,
    permissions: { read: can(session, 'read'), configure: can(session, 'configure') },
    events: events.map((event) => ({
      id: event.id,
      actorId: event.actor_id,
      action: event.action,
      detail: safeJson(event.detail_json),
      createdAt: event.created_at,
    })),
  };
}

function present(row: PreferenceRow): ProcurementTenantPreferences {
  return {
    countryCode: row.country_code,
    workingDays: persistedWorkingDays(row.working_days_json),
    timeZone: row.time_zone,
    dateFormat: row.date_format,
    slaEscalationsEnabled: row.sla_escalations_enabled === 1,
    excludeWeekends: row.exclude_weekends === 1,
    excludePublicHolidays: row.exclude_public_holidays === 1,
    autoCalculateLeadTime: row.auto_calculate_lead_time === 1,
    version: row.version,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function snapshot(value: ProcurementTenantPreferences): Record<string, unknown> {
  return {
    countryCode: value.countryCode,
    workingDays: value.workingDays,
    timeZone: value.timeZone,
    dateFormat: value.dateFormat,
    slaEscalationsEnabled: value.slaEscalationsEnabled,
    excludeWeekends: value.excludeWeekends,
    excludePublicHolidays: value.excludePublicHolidays,
    autoCalculateLeadTime: value.autoCalculateLeadTime,
  };
}

function insertEvent(db: DatabaseSync, tenantId: string, actorId: string, action: string, detail: unknown, at: string): void {
  db.prepare(`INSERT INTO procurement_tenant_preference_events
    (tenant_id,id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?)`)
    .run(tenantId, `tenant-preference-event:${randomUUID()}`, actorId, action, JSON.stringify(detail), at);
}

function persistedWorkingDays(value: string): number[] {
  try {
    return workingDaysValue(JSON.parse(value));
  } catch {
    return [...DEFAULT_PROCUREMENT_TENANT_PREFERENCES.workingDays];
  }
}

function country(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value.trim())) throw new PreferenceInputError('countryCode 必须是两个字母的 ISO 国家代码');
  return value.trim().toUpperCase();
}

function workingDaysValue(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) throw new PreferenceInputError('工作日必须包含 1–7 个日期');
  const normalized = value.map((day) => {
    if (!Number.isSafeInteger(day) || Number(day) < 1 || Number(day) > 7) throw new PreferenceInputError('workingDays 只能使用 ISO 周序号 1–7');
    return Number(day);
  });
  if (new Set(normalized).size !== normalized.length) throw new PreferenceInputError('workingDays 不能重复');
  return normalized.sort((left, right) => left - right);
}

function timeZoneValue(value: unknown): string {
  if (typeof value !== 'string') throw new PreferenceInputError('timeZone 必填');
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) throw new PreferenceInputError('timeZone 长度无效');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(new Date('2026-01-01T00:00:00.000Z'));
  } catch {
    throw new PreferenceInputError('timeZone 必须是有效的 IANA 时区');
  }
  return normalized;
}

function dateFormatValue(value: unknown): ProcurementDateFormat {
  if (!PROCUREMENT_DATE_FORMATS.includes(value as ProcurementDateFormat)) throw new PreferenceInputError(`dateFormat 必须是 ${PROCUREMENT_DATE_FORMATS.join('、')} 之一`);
  return value as ProcurementDateFormat;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new PreferenceInputError(`${label} 必须是布尔值`);
  return value;
}

function integerBoolean(value: boolean): number { return value ? 1 : 0; }

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new PreferenceInputError(`${label} 必须是非负整数`);
  return Number(value);
}

function requiredText(value: unknown, label: string, maximum: number, minimum: number): string {
  if (typeof value !== 'string') throw new PreferenceInputError(`${label} 必填`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < minimum || normalized.length > maximum) throw new PreferenceInputError(`${label} 必须为 ${minimum}–${maximum} 个有效字符`);
  return normalized;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_000) throw new PreferenceInputError('请求体过大');
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new PreferenceInputError('请求体必须是 JSON 对象');
  }
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return {}; }
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
  return true;
}

class PreferenceInputError extends Error {}
class PreferenceVersionError extends Error {
  constructor(readonly currentVersion: number) {
    super(`采购区域偏好版本已变化，当前版本 ${currentVersion}`);
  }
}
