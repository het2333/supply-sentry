import { cn } from "@/lib/utils";

export type RouteRiskSummary = {
  total: number;
  high: number;
  awaitingSupplier: number;
  deliveryRisk: number;
  onTrack: number;
};

type RouteRiskOverviewProps = {
  label: string;
  summary: RouteRiskSummary;
  density?: "compact" | "comfortable";
  className?: string;
  onSelectBucket?: (bucket: RouteRiskBucket) => void;
};

export type RouteRiskBucket = "high" | "awaitingSupplier" | "deliveryRisk" | "onTrack";

const buckets = [
  { key: "high", label: "高风险", color: "#f04444" },
  { key: "awaitingSupplier", label: "等待供应商", color: "#f5a000" },
  { key: "deliveryRisk", label: "交付风险", color: "#fbbf24" },
  { key: "onTrack", label: "进度正常", color: "#16a34a" },
] as const;

function percentage(value: number, total: number): string {
  return total > 0 ? `${(value / total * 100).toFixed(1)}%` : "0.0%";
}

function SegmentedDonut({ summary, compact }: { summary: RouteRiskSummary; compact: boolean }) {
  const total = Math.max(0, summary.total);
  let offset = 0;
  const segments = buckets.map((bucket) => {
    const value = summary[bucket.key];
    const share = total > 0 ? value / total * 100 : 0;
    const segment = { ...bucket, value, share, offset };
    offset += share;
    return segment;
  });

  return <div className={cn("relative shrink-0", compact ? "size-[150px]" : "size-[200px]")}>
    <svg viewBox="0 0 200 200" aria-hidden="true" className="size-full -rotate-90 overflow-visible">
      <circle cx="100" cy="100" r="73" fill="none" stroke="#eef1f5" strokeWidth="28" />
      {total > 0 && segments.filter((segment) => segment.value > 0).map((segment) => {
        const gap = Math.min(1.8, segment.share * 0.18);
        const length = Math.max(0.45, segment.share - gap);
        return <circle
          key={segment.key}
          cx="100"
          cy="100"
          r="73"
          pathLength="100"
          fill="none"
          stroke={segment.color}
          strokeWidth="28"
          strokeLinecap="round"
          strokeDasharray={`${length} ${100 - length}`}
          strokeDashoffset={-(segment.offset + gap / 2)}
        />;
      })}
    </svg>
    <div className="absolute inset-0 flex flex-col items-center justify-center">
      <span className={cn("font-bold leading-none tracking-[-0.045em] text-[#111827]", compact ? "text-[30px]" : "text-[40px]")}>{summary.onTrack}</span>
      <span className={cn("text-[#7a8597]", compact ? "mt-1 text-xs" : "mt-2 text-sm")}>进度正常</span>
    </div>
  </div>;
}

export function RouteRiskOverview({ label, summary, density = "comfortable", className, onSelectBucket }: RouteRiskOverviewProps) {
  const compact = density === "compact";
  return <section className={cn("rounded-[22px] border border-[#e5e9ef] bg-white shadow-[0_2px_10px_rgba(15,23,42,0.03)]", compact ? "p-6" : "p-7", className)}>
    <h2 className={cn("font-bold text-[#1f2937]", compact ? "text-base" : "text-[18px]")}>{label}<span className="ml-2 font-normal text-[#7c8595]">— 风险概览</span></h2>
    <div className={cn("flex flex-col items-center sm:flex-row", compact ? "mt-6 gap-7" : "mt-8 gap-7 xl:gap-9")}>
      <SegmentedDonut summary={summary} compact={compact} />
      <div className={cn("w-full min-w-0", compact ? "space-y-3.5" : "space-y-6")}>
        {buckets.map((bucket) => {
          const value = summary[bucket.key];
          return <button type="button" key={bucket.key} aria-label={`${label}：${bucket.label}`} onClick={() => onSelectBucket?.(bucket.key)} className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-lg text-left outline-none transition hover:bg-[#f7f9fc] focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
            <span className={cn("rounded-full", compact ? "size-2.5" : "size-3.5")} style={{ backgroundColor: bucket.color }} />
            <span className={cn("truncate font-medium text-[#4f596b]", compact ? "text-xs" : "text-sm")}>{bucket.label}</span>
            <span className={cn("font-bold tabular-nums text-[#182236]", compact ? "text-sm" : "text-base")}>{value}</span>
            <span className={cn("text-right tabular-nums text-[#7d8798]", compact ? "w-[54px] text-xs" : "w-[62px] text-sm")}>({percentage(value, summary.total)})</span>
          </button>;
        })}
      </div>
    </div>
  </section>;
}
