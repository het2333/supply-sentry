export type SlaCalendarMode = "elapsed_hours" | "tenant_working_days";

export interface SlaCalendarSnapshot {
  mode: SlaCalendarMode;
  timeZone: string | null;
  workingDays: number[] | null;
  preferenceVersion: number | null;
  inheritedDefault: boolean | null;
  excludeWeekends?: boolean | null;
  excludePublicHolidays?: boolean | null;
  holidayDates?: string[] | null;
  holidayCountryCode?: string | null;
  holidayYears?: number[] | null;
  holidaySource?: string | null;
  holidaySourceVersion?: string | null;
  holidaySourceLicense?: string | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/**
 * Adds SLA hours using either absolute elapsed time or the tenant's local
 * working-date calendar. Working-day mode counts wall-clock hours only on ISO
 * weekdays configured as working days; non-working local dates contribute no
 * SLA time. UTC instants remain the persisted result.
 */
export function addSlaCalendarHours(
  instant: number | Date,
  hours: number,
  calendar: SlaCalendarSnapshot,
): number {
  const instantMs = instant instanceof Date ? instant.getTime() : instant;
  if (!Number.isFinite(instantMs))
    throw new TypeError("SLA calendar instant must be finite");
  if (!Number.isFinite(hours))
    throw new TypeError("SLA calendar hours must be finite");
  if (calendar.mode === "elapsed_hours" || hours === 0)
    return instantMs + hours * HOUR_MS;
  const timeZone = requiredTimeZone(calendar);
  const workingDays = requiredWorkingDays(calendar);
  const holidayDates = requiredHolidayDates(calendar);
  const local = localDateTimeAt(instantMs, timeZone);
  const localNaiveMs = localDateTimeToNaiveMs(local);
  const shiftedLocalNaiveMs =
    hours > 0
      ? addPositiveWorkingHours(localNaiveMs, hours * HOUR_MS, workingDays, holidayDates)
      : addNegativeWorkingHours(
          localNaiveMs,
          Math.abs(hours) * HOUR_MS,
          workingDays,
          holidayDates,
        );
  return localNaiveMsToInstant(shiftedLocalNaiveMs, timeZone);
}

function addPositiveWorkingHours(
  cursorStart: number,
  durationMs: number,
  workingDays: ReadonlySet<number>,
  holidayDates: ReadonlySet<string>,
): number {
  let cursor = cursorStart;
  let remaining = durationMs;
  let guard = 0;
  while (remaining > 0) {
    if (guard++ > 40_000)
      throw new RangeError(
        "SLA working-day calendar exceeded the supported range",
      );
    const dayStart = localDayStart(cursor);
    if (!isWorkingDate(dayStart, workingDays, holidayDates)) {
      cursor = nextWorkingDayStart(dayStart, workingDays, holidayDates);
      continue;
    }
    const available = dayStart + DAY_MS - cursor;
    if (remaining < available) return cursor + remaining;
    remaining -= available;
    cursor = nextWorkingDayStart(dayStart + DAY_MS, workingDays, holidayDates);
  }
  return cursor;
}

function addNegativeWorkingHours(
  cursorStart: number,
  durationMs: number,
  workingDays: ReadonlySet<number>,
  holidayDates: ReadonlySet<string>,
): number {
  let cursor = cursorStart;
  let remaining = durationMs;
  let guard = 0;
  while (remaining > 0) {
    if (guard++ > 40_000)
      throw new RangeError(
        "SLA working-day calendar exceeded the supported range",
      );
    const dayStart = localDayStart(cursor);
    if (isWorkingDate(dayStart, workingDays, holidayDates) && cursor > dayStart) {
      const available = cursor - dayStart;
      if (remaining <= available) return cursor - remaining;
      remaining -= available;
      cursor = dayStart;
    }
    const previousStart = previousWorkingDayStart(dayStart, workingDays, holidayDates);
    if (remaining <= DAY_MS) return previousStart + DAY_MS - remaining;
    remaining -= DAY_MS;
    cursor = previousStart;
  }
  return cursor;
}

function nextWorkingDayStart(
  fromDayStart: number,
  workingDays: ReadonlySet<number>,
  holidayDates: ReadonlySet<string>,
): number {
  let candidate = fromDayStart;
  for (let index = 0; index < 400; index += 1) {
    if (isWorkingDate(candidate, workingDays, holidayDates)) return candidate;
    candidate += DAY_MS;
  }
  throw new RangeError("SLA calendar has no reachable working day");
}

function previousWorkingDayStart(
  beforeDayStart: number,
  workingDays: ReadonlySet<number>,
  holidayDates: ReadonlySet<string>,
): number {
  let candidate = beforeDayStart - DAY_MS;
  for (let index = 0; index < 400; index += 1) {
    if (isWorkingDate(candidate, workingDays, holidayDates)) return candidate;
    candidate -= DAY_MS;
  }
  throw new RangeError("SLA calendar has no reachable working day");
}

function localDayStart(localNaiveMs: number): number {
  const date = new Date(localNaiveMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isoWeekday(localDayStartMs: number): number {
  const weekday = new Date(localDayStartMs).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function isWorkingDate(
  localDayStartMs: number,
  workingDays: ReadonlySet<number>,
  holidayDates: ReadonlySet<string>,
): boolean {
  return workingDays.has(isoWeekday(localDayStartMs)) && !holidayDates.has(localDateKey(localDayStartMs));
}

function localDateKey(localDayStartMs: number): string {
  return new Date(localDayStartMs).toISOString().slice(0, 10);
}

function localDateTimeAt(instantMs: number, timeZone: string): LocalDateTime {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: Number(values.fractionalSecond ?? 0),
  };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    timeZone,
    calendar: "iso8601",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, created);
  return created;
}

function localDateTimeToNaiveMs(value: LocalDateTime): number {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
    value.millisecond,
  );
}

function localNaiveMsToInstant(localNaiveMs: number, timeZone: string): number {
  const target = localDateTimeFromNaiveMs(localNaiveMs);
  const possibleOffsets = new Set<number>();
  for (const delta of [
    -36 * HOUR_MS,
    -12 * HOUR_MS,
    0,
    12 * HOUR_MS,
    36 * HOUR_MS,
  ]) {
    const sample = localNaiveMs + delta;
    possibleOffsets.add(
      localDateTimeToNaiveMs(localDateTimeAt(sample, timeZone)) - sample,
    );
  }
  const candidates = [...possibleOffsets].map(
    (offset) => localNaiveMs - offset,
  );
  const exact = candidates.filter((candidate) =>
    sameLocalDateTime(localDateTimeAt(candidate, timeZone), target),
  );
  if (exact.length > 0) return Math.min(...exact);
  // Compatible disambiguation for a DST gap: advance by the gap, matching the
  // behavior users expect from wall-clock calendar arithmetic.
  return Math.max(...candidates);
}

function localDateTimeFromNaiveMs(value: number): LocalDateTime {
  const date = new Date(value);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}

function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second &&
    left.millisecond === right.millisecond
  );
}

function requiredTimeZone(calendar: SlaCalendarSnapshot): string {
  if (!calendar.timeZone)
    throw new TypeError("tenant_working_days requires a time zone");
  try {
    formatter(calendar.timeZone);
  } catch {
    throw new TypeError("tenant_working_days requires a valid IANA time zone");
  }
  return calendar.timeZone;
}

function requiredWorkingDays(
  calendar: SlaCalendarSnapshot,
): ReadonlySet<number> {
  const workingDays = calendar.workingDays;
  if (
    !workingDays ||
    workingDays.length < 1 ||
    workingDays.some((day) => !Number.isSafeInteger(day) || day < 1 || day > 7)
  ) {
    throw new TypeError("tenant_working_days requires ISO working days 1-7");
  }
  return new Set(workingDays);
}

function requiredHolidayDates(calendar: SlaCalendarSnapshot): ReadonlySet<string> {
  if (calendar.holidayDates === undefined || calendar.holidayDates === null) return new Set();
  if (!Array.isArray(calendar.holidayDates) || calendar.holidayDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new TypeError('tenant_working_days requires ISO public holiday dates');
  }
  return new Set(calendar.holidayDates);
}
