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
): string {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && presentation === "date") {
    const [year, month, day] = value.split("-") as [string, string, string];
    return orderedDate(year, month, day, preferences.dateFormat);
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
    if (presentation === "short-date-time") return `${orderedShortDate(month, day, preferences.dateFormat)} ${time}`;
    const fullDate = orderedDate(year, month, day, preferences.dateFormat);
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

function orderedDate(year: string, month: string, day: string, format: ProcurementDateFormat): string {
  if (format === "DD MMM YYYY") return `${year}年${Number(month)}月${Number(day)}日`;
  if (format === "DD/MM/YYYY") return `${day}/${month}/${year}`;
  if (format === "MM/DD/YYYY") return `${month}/${day}/${year}`;
  return `${year}-${month}-${day}`;
}

function orderedShortDate(month: string, day: string, format: ProcurementDateFormat): string {
  if (format === "DD MMM YYYY") return `${Number(month)}月${Number(day)}日`;
  if (format === "DD/MM/YYYY") return `${day}/${month}`;
  if (format === "MM/DD/YYYY") return `${month}/${day}`;
  return `${month}-${day}`;
}
