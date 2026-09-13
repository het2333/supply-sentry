export type ProcurementDateFormat = "DD MMM YYYY" | "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";

export type ProcurementTenantPreferences = {
  countryCode: string;
  workingDays: number[];
  timeZone: string;
  dateFormat: ProcurementDateFormat;
  slaEscalationsEnabled: boolean;
  excludeWeekends: boolean;
  excludePublicHolidays: boolean;
  autoCalculateLeadTime: boolean;
};

export const DEFAULT_PROCUREMENT_TENANT_PREFERENCES: ProcurementTenantPreferences = Object.freeze({
  countryCode: "CN",
  workingDays: [1, 2, 3, 4, 5],
  timeZone: "Asia/Shanghai",
  dateFormat: "DD MMM YYYY",
  slaEscalationsEnabled: true,
  excludeWeekends: true,
  excludePublicHolidays: true,
  autoCalculateLeadTime: true,
});

export type DatePresentation = "date" | "date-time" | "short-date-time" | "time";

export function formatProcurementDate(
  value: string | number | Date | null | undefined,
  preferences: ProcurementTenantPreferences,
  presentation: DatePresentation = "date-time",
  fallback = "—",
  language: "zh-CN" | "en" = "zh-CN",
): string {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && presentation === "date") {
    const [year, month, day] = value.split("-") as [string, string, string];
    return orderedDate(year, month, day, preferences.dateFormat, language);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : fallback;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: preferences.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
    const year = part("year");
    const month = part("month");
    const day = part("day");
    const time = `${part("hour")}:${part("minute")}`;
    if (presentation === "time") return time;
    if (presentation === "short-date-time") return `${orderedShortDate(month, day, preferences.dateFormat, language)} ${time}`;
    const fullDate = orderedDate(year, month, day, preferences.dateFormat, language);
    return presentation === "date" ? fullDate : `${fullDate} ${time}`;
  } catch {
    return fallback;
  }
}

export function procurementCalendarDate(value: Date, timeZone: string): string {
  if (Number.isNaN(value.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

export function procurementCalendarDateDaysBefore(value: Date, timeZone: string, daysBefore: number): string {
  const current = procurementCalendarDate(value, timeZone);
  const [year, month, day] = current.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined || ![year, month, day].every(Number.isFinite)) return current;
  return new Date(Date.UTC(year, month - 1, day - Math.max(0, Math.trunc(daysBefore)))).toISOString().slice(0, 10);
}

type ProcurementDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function dateTimePartsInZone(value: Date, timeZone: string): ProcurementDateTimeParts | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value);
    const result = {
      year: part("year"),
      month: part("month"),
      day: part("day"),
      hour: part("hour"),
      minute: part("minute"),
      second: part("second"),
    };
    return Object.values(result).every(Number.isFinite) ? result : undefined;
  } catch {
    return undefined;
  }
}

function sameDateTimeParts(left: ProcurementDateTimeParts, right: ProcurementDateTimeParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

/** Converts a wall-clock value from a datetime-local control using the tenant's IANA time zone. */
export function procurementDateTimeLocalToIso(value: string, timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return undefined;
  const requested: ProcurementDateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  if (requested.year < 1000 || requested.month < 1 || requested.month > 12 || requested.day < 1 || requested.day > 31
    || requested.hour > 23 || requested.minute > 59 || requested.second > 59) return undefined;
  const wallClockUtc = Date.UTC(requested.year, requested.month - 1, requested.day, requested.hour, requested.minute, requested.second);
  const normalized = new Date(wallClockUtc);
  if (normalized.getUTCFullYear() !== requested.year || normalized.getUTCMonth() !== requested.month - 1 || normalized.getUTCDate() !== requested.day) return undefined;

  let candidate = wallClockUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const displayed = dateTimePartsInZone(new Date(candidate), timeZone);
    if (!displayed) return undefined;
    const displayedAsUtc = Date.UTC(displayed.year, displayed.month - 1, displayed.day, displayed.hour, displayed.minute, displayed.second);
    const correction = wallClockUtc - displayedAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  const resolved = new Date(candidate);
  const resolvedParts = dateTimePartsInZone(resolved, timeZone);
  return resolvedParts && sameDateTimeParts(resolvedParts, requested) ? resolved.toISOString() : undefined;
}

/** Formats an instant for a datetime-local control in the tenant's IANA time zone. */
export function procurementDateTimeLocalValue(value: Date, timeZone: string): string {
  if (Number.isNaN(value.getTime())) return "";
  const parts = dateTimePartsInZone(value, timeZone);
  if (!parts) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

const ENGLISH_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function orderedDate(year: string, month: string, day: string, format: ProcurementDateFormat, language: "zh-CN" | "en"): string {
  if (format === "DD MMM YYYY") return language === "en" ? `${day} ${ENGLISH_MONTHS[Number(month) - 1]} ${year}` : `${year}年${Number(month)}月${Number(day)}日`;
  if (format === "DD/MM/YYYY") return `${day}/${month}/${year}`;
  if (format === "MM/DD/YYYY") return `${month}/${day}/${year}`;
  return `${year}-${month}-${day}`;
}

function orderedShortDate(month: string, day: string, format: ProcurementDateFormat, language: "zh-CN" | "en"): string {
  if (format === "DD MMM YYYY") return language === "en" ? `${day} ${ENGLISH_MONTHS[Number(month) - 1]}` : `${Number(month)}月${Number(day)}日`;
  if (format === "DD/MM/YYYY") return `${day}/${month}`;
  if (format === "MM/DD/YYYY") return `${month}/${day}`;
  return `${month}-${day}`;
}
