"use client";

import { Line, LineChart } from "recharts";

export function RiskSparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  return <div className="h-[26px] w-[72px] shrink-0" aria-label="高风险 PO 占比趋势"><LineChart width={72} height={26} data={values.map((value, index) => ({ index, value }))}><Line type="monotone" dataKey="value" stroke="#ef4444" strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart></div>;
}
