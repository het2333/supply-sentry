import assert from "node:assert/strict";
import { test } from "node:test";
import {
  overviewMetricSeries,
  type OverviewMetrics,
  type OverviewTrendFreshness,
  type OverviewTrendPoint,
} from "../features/procurement/overview-trend";

const current: OverviewMetrics = {
  highRisk: 14,
  overdue: 12,
  requireAttention: 14,
  activePurchaseOrders: 26,
  localProcurement: 0,
  importProcurement: 0,
};

const trend: OverviewTrendPoint[] = [
  { snapshotId: "s:1", sourceWatermark: "facts|config|2026-08-27", asOf: "2026-08-27T02:00:00.000Z", overviewMetrics: { ...current, highRisk: 8 } },
  { snapshotId: "s:2", sourceWatermark: "facts|config|2026-08-28", asOf: "2026-08-28T02:00:00.000Z", overviewMetrics: { ...current, highRisk: 9 } },
];

function freshness(state: OverviewTrendFreshness["state"]): OverviewTrendFreshness {
  return {
    state,
    reason: state === "stale" ? "calendar_day_changed" : null,
    evaluatedAt: "2026-09-01T03:00:00.000Z",
    currentSourceWatermark: "facts|config|2026-09-01",
    latestSnapshotSourceWatermark: state === "missing" ? null : "facts|config|2026-08-28",
    latestSnapshotAt: state === "missing" ? null : "2026-08-28T02:00:00.000Z",
  };
}

test("Overview trend: stale immutable history ends at the live KPI value", () => {
  assert.deepEqual(overviewMetricSeries({ key: "highRisk", trend, freshness: freshness("stale"), current }), [8, 9, 14]);
});

test("Overview trend: current snapshot is not duplicated", () => {
  assert.deepEqual(overviewMetricSeries({ key: "highRisk", trend: [{ ...trend[1]!, overviewMetrics: current }], freshness: freshness("current"), current }), [14]);
});

test("Overview trend: no snapshot remains honest and produces one live point", () => {
  assert.deepEqual(overviewMetricSeries({ key: "overdue", trend: [], freshness: freshness("missing"), current }), [12]);
  assert.deepEqual(overviewMetricSeries({ key: "overdue", trend: [], freshness: null, current: null }), []);
});
