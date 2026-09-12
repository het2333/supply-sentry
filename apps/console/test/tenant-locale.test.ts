import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatProcurementDate,
  procurementCalendarDate,
  procurementCalendarDateDaysBefore,
  type ProcurementTenantPreferences,
} from "../features/procurement/tenant-locale.js";

const preference = (
  timeZone: string,
  dateFormat: ProcurementTenantPreferences["dateFormat"],
): ProcurementTenantPreferences => ({
  countryCode: "CN",
  workingDays: [1, 2, 3, 4, 5],
  timeZone,
  dateFormat,
  slaEscalationsEnabled: true,
  excludeWeekends: true,
  excludePublicHolidays: true,
  autoCalculateLeadTime: true,
});

const crossDayInstant = "2026-08-30T00:30:00.000Z";

test("采购日期格式：上海时区使用 YYYY-MM-DD", () => {
  assert.equal(
    formatProcurementDate(crossDayInstant, preference("Asia/Shanghai", "YYYY-MM-DD"), "date-time"),
    "2026-08-30 08:30",
  );
});

test("采购日期格式：默认 DD MMM YYYY 偏好在中文界面按中文年月日显示", () => {
  assert.equal(
    formatProcurementDate(crossDayInstant, preference("Asia/Shanghai", "DD MMM YYYY"), "date-time"),
    "2026年8月30日 08:30",
  );
});

test("采购日期格式：伦敦时区使用 DD/MM/YYYY", () => {
  assert.equal(
    formatProcurementDate(crossDayInstant, preference("Europe/London", "DD/MM/YYYY"), "date-time"),
    "30/08/2026 01:30",
  );
});

test("采购日期格式：纽约时区使用 MM/DD/YYYY 并正确跨 UTC 日期", () => {
  assert.equal(
    formatProcurementDate(crossDayInstant, preference("America/New_York", "MM/DD/YYYY"), "date-time"),
    "08/29/2026 20:30",
  );
});

test("采购日期格式：date-only 字段不因时区偏移到前一天", () => {
  assert.equal(
    formatProcurementDate("2026-01-01", preference("America/New_York", "MM/DD/YYYY"), "date"),
    "01/01/2026",
  );
});

test("采购日期格式：无效输入与无效时区使用明确回退", () => {
  const preferences = preference("Mars/Olympus", "YYYY-MM-DD");
  assert.equal(formatProcurementDate(new Date(Number.NaN), preferences, "date-time", "不可用"), "不可用");
  assert.equal(formatProcurementDate(crossDayInstant, preferences, "date-time", "不可用"), "不可用");
  assert.equal(formatProcurementDate("原始日期文本", preference("UTC", "YYYY-MM-DD"), "date-time"), "原始日期文本");
  assert.equal(procurementCalendarDate(new Date(Number.NaN), "UTC"), "");
});

test("采购日历日期：按租户时区生成范围且不受 DST 小时数影响", () => {
  const instant = new Date(crossDayInstant);
  assert.equal(procurementCalendarDate(instant, "Asia/Shanghai"), "2026-08-30");
  assert.equal(procurementCalendarDate(instant, "America/New_York"), "2026-08-29");
  assert.equal(procurementCalendarDateDaysBefore(new Date("2026-03-09T12:00:00.000Z"), "America/New_York", 1), "2026-03-08");
});
