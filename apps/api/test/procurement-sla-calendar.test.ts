import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addSlaCalendarHours,
  type SlaCalendarSnapshot,
} from "../src/procurement-sla-calendar.js";

const elapsed: SlaCalendarSnapshot = {
  mode: "elapsed_hours",
  timeZone: null,
  workingDays: null,
  preferenceVersion: null,
  inheritedDefault: null,
};

const shanghaiWorkingDays: SlaCalendarSnapshot = {
  mode: "tenant_working_days",
  timeZone: "Asia/Shanghai",
  workingDays: [1, 2, 3, 4, 5],
  preferenceVersion: 7,
  inheritedDefault: false,
};

test("elapsed-hours mode preserves legacy absolute-hour semantics across a weekend", () => {
  const friday = Date.parse("2026-08-21T02:00:00.000Z");
  assert.equal(
    new Date(addSlaCalendarHours(friday, 24, elapsed)).toISOString(),
    "2026-08-22T02:00:00.000Z",
  );
  assert.equal(
    new Date(addSlaCalendarHours(friday, -4.5, elapsed)).toISOString(),
    "2026-08-20T21:30:00.000Z",
  );
});

test("tenant working-day hours skip weekends in both directions and preserve local wall time", () => {
  const fridayTenShanghai = Date.parse("2026-08-21T02:00:00.000Z");
  const mondayTenShanghai = Date.parse("2026-08-24T02:00:00.000Z");
  assert.equal(
    addSlaCalendarHours(fridayTenShanghai, 24, shanghaiWorkingDays),
    mondayTenShanghai,
  );
  assert.equal(
    addSlaCalendarHours(mondayTenShanghai, -24, shanghaiWorkingDays),
    fridayTenShanghai,
  );

  const fridayTwentyTwoShanghai = Date.parse("2026-08-21T14:00:00.000Z");
  assert.equal(
    new Date(
      addSlaCalendarHours(fridayTwentyTwoShanghai, 4, shanghaiWorkingDays),
    ).toISOString(),
    "2026-08-23T18:00:00.000Z",
    "two Friday hours plus two Monday hours must end at Monday 02:00 Asia/Shanghai",
  );
  assert.equal(
    new Date(
      addSlaCalendarHours(
        Date.parse("2026-08-23T18:00:00.000Z"),
        -4,
        shanghaiWorkingDays,
      ),
    ).toISOString(),
    "2026-08-21T14:00:00.000Z",
  );
});

test("tenant working-day hours skip the public-holiday dates frozen in the evaluation snapshot", () => {
  const calendar: SlaCalendarSnapshot = {
    ...shanghaiWorkingDays,
    holidayDates: ["2026-08-24"],
    holidayCountryCode: "CN",
    holidayYears: [2026],
    holidaySource: "date-holidays",
    holidaySourceVersion: "3.36.0",
  };
  const fridayTenShanghai = Date.parse("2026-08-21T02:00:00.000Z");
  assert.equal(
    new Date(addSlaCalendarHours(fridayTenShanghai, 24, calendar)).toISOString(),
    "2026-08-25T02:00:00.000Z",
    "the frozen Monday public holiday must push the deadline to Tuesday at the same local time",
  );
  assert.equal(
    new Date(addSlaCalendarHours(Date.parse("2026-08-25T02:00:00.000Z"), -24, calendar)).toISOString(),
    "2026-08-21T02:00:00.000Z",
  );
});

test("working-day mode normalizes positive work from a non-working date but leaves a zero offset unchanged", () => {
  const saturdayNoonShanghai = Date.parse("2026-08-22T04:00:00.000Z");
  assert.equal(
    addSlaCalendarHours(saturdayNoonShanghai, 0, shanghaiWorkingDays),
    saturdayNoonShanghai,
  );
  assert.equal(
    new Date(
      addSlaCalendarHours(saturdayNoonShanghai, 2, shanghaiWorkingDays),
    ).toISOString(),
    "2026-08-23T18:00:00.000Z",
    "positive business time starts at Monday 00:00 local when the basis is on Saturday",
  );
});

test("working-day arithmetic preserves New York wall time across a weekend DST transition", () => {
  const newYork: SlaCalendarSnapshot = {
    mode: "tenant_working_days",
    timeZone: "America/New_York",
    workingDays: [1, 2, 3, 4, 5],
    preferenceVersion: 3,
    inheritedDefault: false,
  };
  const fridayTen = Date.parse("2026-03-06T15:00:00.000Z");
  assert.equal(
    new Date(addSlaCalendarHours(fridayTen, 24, newYork)).toISOString(),
    "2026-03-09T14:00:00.000Z",
    "Monday remains 10:00 local even though New York enters DST on Sunday",
  );
  assert.equal(
    new Date(
      addSlaCalendarHours(Date.parse("2026-03-09T14:00:00.000Z"), -24, newYork),
    ).toISOString(),
    "2026-03-06T15:00:00.000Z",
  );
});

test("working-day arithmetic uses compatible DST gap and overlap disambiguation", () => {
  const newYorkEveryDay: SlaCalendarSnapshot = {
    mode: "tenant_working_days",
    timeZone: "America/New_York",
    workingDays: [1, 2, 3, 4, 5, 6, 7],
    preferenceVersion: null,
    inheritedDefault: true,
  };
  assert.equal(
    new Date(
      addSlaCalendarHours(
        Date.parse("2026-03-08T05:00:00.000Z"),
        2,
        newYorkEveryDay,
      ),
    ).toISOString(),
    "2026-03-08T07:00:00.000Z",
    "the nonexistent 02:00 local deadline advances to 03:00 after the DST gap",
  );
  assert.equal(
    new Date(
      addSlaCalendarHours(
        Date.parse("2026-11-01T04:30:00.000Z"),
        1,
        newYorkEveryDay,
      ),
    ).toISOString(),
    "2026-11-01T05:30:00.000Z",
    "an ambiguous 01:30 local deadline chooses the earlier occurrence",
  );
});

test("tenant working-day mode fails closed for an incomplete calendar snapshot", () => {
  assert.throws(
    () =>
      addSlaCalendarHours(Date.now(), 1, {
        ...shanghaiWorkingDays,
        timeZone: null,
      }),
    /time zone/,
  );
  assert.throws(
    () =>
      addSlaCalendarHours(Date.now(), 1, {
        ...shanghaiWorkingDays,
        workingDays: [],
      }),
    /working days/,
  );
});
