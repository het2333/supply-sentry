export type OverviewMetricKey =
  | "highRisk"
  | "overdue"
  | "requireAttention"
  | "activePurchaseOrders"
  | "localProcurement"
  | "importProcurement";

export type OverviewMetrics = Record<OverviewMetricKey, number>;

export type OverviewTrendPoint = {
  snapshotId: string;
  sourceWatermark: string;
  asOf: string;
  overviewMetrics: OverviewMetrics;
};

export type OverviewTrendFreshness = {
  state: "missing" | "current" | "stale";
  reason: "calendar_day_changed" | "configuration_changed" | "portfolio_facts_changed" | null;
  evaluatedAt: string;
  currentSourceWatermark: string;
  latestSnapshotSourceWatermark: string | null;
  latestSnapshotAt: string | null;
};

/**
 * Immutable snapshots supply the historical points, while the KPI number is a
 * live read of the current portfolio.  When the API says the last snapshot is
 * stale (or absent), append that live number so the badge and sparkline end at
 * the same value the user is looking at.  Comparing only a prefix of the
 * watermark is unsafe because calendar-driven overdue and no-response risks
 * can change even when no persisted PO fact changes.
 */
export function overviewMetricSeries(input: {
  key: OverviewMetricKey;
  trend: readonly OverviewTrendPoint[] | null | undefined;
  freshness: OverviewTrendFreshness | null | undefined;
  current: OverviewMetrics | null | undefined;
}): number[] {
  const values = (input.trend ?? []).map((point) => point.overviewMetrics[input.key]);
  if (input.current && input.freshness?.state !== "current") values.push(input.current[input.key]);
  return values;
}
