import Holidays from 'date-holidays';

export const PROCUREMENT_HOLIDAY_PROVIDER = 'date-holidays';
export const PROCUREMENT_HOLIDAY_PROVIDER_VERSION = '3.36.0';
export const PROCUREMENT_HOLIDAY_PROVIDER_LICENSE = 'ISC AND CC-BY-3.0';

export interface ProcurementPublicHolidaySnapshot {
  countryCode: string;
  dates: string[];
  years: number[];
  source: typeof PROCUREMENT_HOLIDAY_PROVIDER;
  sourceVersion: typeof PROCUREMENT_HOLIDAY_PROVIDER_VERSION;
  sourceLicense: typeof PROCUREMENT_HOLIDAY_PROVIDER_LICENSE;
}

const holidaySnapshotCache = new Map<string, ProcurementPublicHolidaySnapshot>();

export function supportsProcurementPublicHolidays(countryCode: string): boolean {
  const normalized = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return false;
  const holidays = new Holidays();
  return Object.prototype.hasOwnProperty.call(holidays.getCountries('en'), normalized);
}

/**
 * Freezes public-holiday dates around the SLA basis year. SLA rules are
 * allow a one-working-year target offset plus a one-working-year warning
 * offset. An eight-year window safely covers both directions, grace and
 * follow-up arithmetic while keeping immutable evidence bounded.
 */
export function procurementPublicHolidaySnapshot(
  countryCode: string,
  anchor: number | Date,
): ProcurementPublicHolidaySnapshot {
  const normalized = countryCode.trim().toUpperCase();
  if (!supportsProcurementPublicHolidays(normalized)) {
    throw new TypeError(`不支持 ${normalized} 的公共节假日日历`);
  }
  const anchorDate = anchor instanceof Date ? anchor : new Date(anchor);
  if (!Number.isFinite(anchorDate.getTime())) throw new TypeError('节假日日历基准时间无效');
  const anchorYear = anchorDate.getUTCFullYear();
  const cacheKey = `${normalized}:${anchorYear}`;
  const cached = holidaySnapshotCache.get(cacheKey);
  if (cached) return { ...cached, dates: [...cached.dates], years: [...cached.years] };
  const years = Array.from({ length: 8 }, (_, index) => anchorYear - 4 + index);
  const holidays = new Holidays(normalized, { languages: ['en'], types: ['public'] });
  const dates = new Set<string>();
  for (const year of years) {
    for (const holiday of holidays.getHolidays(year)) {
      if (holiday.type !== 'public') continue;
      const date = holiday.date.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.add(date);
    }
  }
  const snapshot: ProcurementPublicHolidaySnapshot = {
    countryCode: normalized,
    dates: [...dates].sort(),
    years,
    source: PROCUREMENT_HOLIDAY_PROVIDER,
    sourceVersion: PROCUREMENT_HOLIDAY_PROVIDER_VERSION,
    sourceLicense: PROCUREMENT_HOLIDAY_PROVIDER_LICENSE,
  };
  if (holidaySnapshotCache.size >= 100) {
    const oldest = holidaySnapshotCache.keys().next().value as string | undefined;
    if (oldest) holidaySnapshotCache.delete(oldest);
  }
  holidaySnapshotCache.set(cacheKey, snapshot);
  return { ...snapshot, dates: [...snapshot.dates], years: [...snapshot.years] };
}
