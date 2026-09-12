"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ColumnDef } from "@tanstack/react-table";
import { Activity, AlertCircle, ArrowUpRight, CalendarDays, ChevronDown, Download, Filter, Info, Loader2, MoreHorizontal, RefreshCw, ShieldAlert, X } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { DateRangePicker } from "@/components/ui/date-range";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { cn } from "@/lib/utils";
import { procurementCalendarDate, procurementCalendarDateDaysBefore, useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { READYWORK_PAGE_CONTAINER_CLASS, READYWORK_PAGE_TITLE_CLASS } from "@/features/procurement/visual-tokens";
import { currencyMetricDeltas, isHighRiskListItem, riskMetricDelta, riskScorePresentation, supplierRiskPresentation, type RiskMetricDelta } from "@/features/procurement/risk-dashboard-view-model";

type Risk = "high" | "medium" | "low";
type Route = "local" | "import" | "unclassified";
type CurrencyValues = Record<string, number>;
type RiskFactor = { code: string; label: string; score: number; evidence: string };
type DashboardFilters = { risk: Risk | null; route: Route | null; supplierId: string | null; materialType: string | null };
type FilterOptions = { risks: Risk[]; routes: Route[]; suppliers: Array<{ id: string; name: string }>; materialTypes: string[] };
type Metrics = { total: number; high: number; medium: number; low: number; provisional: number; unpublished: number; highRiskPercent: number; atRiskValueByCurrency: CurrencyValues; averageRiskScore: number };
type RiskModelSummary = { modelVersion?: "risk-model-v2" | "legacy-risk-v1"; evidenceCoverage: number | null; totalScore: number | null; provisionalScore: number | null; provisionalBand: Risk | null };
type Snapshot = {
  id: string; asOf: string; sourceWatermark: string; modelVersion: "risk-model-v2" | "legacy-risk-v1"; metrics: Metrics;
  riskDistribution: Array<{ risk: Risk; count: number }>;
  riskBreakdown: Array<{ code: string; label: string; score: number; weight?: number; evidenceCoverage?: number; affectedPurchaseOrders: number }>;
  suppliers: Array<{ supplierId: string; supplierName: string; purchaseOrders: number; riskScore: number; atRiskValueByCurrency: CurrencyValues }>;
  aging: Array<{ code: string; label: string; purchaseOrders: number; atRiskValueByCurrency: CurrencyValues }>;
  products: Array<{ materialType: string; delayedPurchaseOrders: number; averageRiskScore: number; atRiskValueByCurrency: CurrencyValues }>;
  items: Array<{ purchaseOrderId: string; number: string; supplierId: string; supplierName: string; materialType: string; route: Route; risk: Risk; riskScore: number; riskFactors: RiskFactor[]; riskPublicationState: "published" | "provisional" | "not_published" | "legacy"; riskModel: RiskModelSummary; missingRiskComponents: string[]; requiredInHouseAt?: string | null; overdueDays: number; currency: string; amountTotal: number; nextAction?: string }>;
};
type SnapshotFreshness = {
  state: "current" | "stale" | "missing";
  reason: "calendar_day_changed" | "portfolio_facts_changed" | "configuration_changed" | null;
  evaluatedAt: string;
  currentSourceWatermark: string;
  latestSnapshotSourceWatermark: string | null;
  latestSnapshotAt: string | null;
  liveMetrics: { total: number; high: number; medium: number; low: number; overdue: number; highRiskPercent: number };
};
type Dashboard = { range: { from: string; to: string }; capabilities?: { refresh: boolean }; latest: Snapshot | null; previous: Snapshot | null; trend: Array<{ snapshotId: string; asOf: string; averageRiskScore: number; highRiskPercent: number; high: number; medium: number; low: number; atRiskValueByCurrency: CurrencyValues }>; snapshotCount: number; appliedFilters: DashboardFilters; filterOptions: FilterOptions; unfilteredItemCount: number; filteredItemCount: number; freshness: SnapshotFreshness };

const riskTone: Record<Risk, string> = { high: "#ef4444", medium: "#f59e0b", low: "#22c55e" };
const riskLabel: Record<Risk, string> = { high: "高风险（70–100）", medium: "中风险（40–69）", low: "低风险（0–39）" };
const routeLabel: Record<Route, string> = { local: "本地", import: "进口", unclassified: "未分类" };
const breakdownLabel: Record<string, string> = {
  supplier_performance: "供应商绩效", delivery_delay: "交付延误", po_value: "订单金额",
  product_criticality: "产品关键程度", compliance_approval: "合规与审批",
};
const agingLabel: Record<string, string> = { "1_7": "1–7 天", "8_14": "8–14 天", "15_30": "15–30 天", "31_60": "31–60 天", over_60: "超过 60 天" };
const RISK_ANALYTICAL_HEADING_CLASS = "text-[15px] font-semibold text-[#242b38]";
const emptyFilters = (): DashboardFilters => ({ risk: null, route: null, supplierId: null, materialType: null });
const RiskSparkline = dynamic(() => import("@/features/procurement/risk-recharts").then((module) => module.RiskSparkline), { ssr: false });

function initialRange(timeZone: string) {
  const to = new Date();
  return { from: procurementCalendarDateDaysBefore(to, timeZone, 29), to: procurementCalendarDate(to, timeZone) };
}
function errorText(error: unknown): string { return error instanceof ReadyworkApiError ? error.message : error instanceof Error ? error.message : "风险看板请求失败"; }
function readFailureDetails(error: unknown) {
  const apiError = error instanceof ReadyworkApiError ? error : null;
  const payload = apiError?.payload;
  const id = payload && typeof payload === "object" && "requestId" in payload ? payload.requestId : null;
  const requestId = typeof id === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(id) ? id : null;
  return { status: apiError?.status ?? 0, requestId };
}
function dashboardQuery(range: { from: string; to: string }, filters: DashboardFilters): string {
  const query = new URLSearchParams({ from: range.from, to: range.to });
  if (filters.risk) query.set("risk", filters.risk);
  if (filters.route) query.set("route", filters.route);
  if (filters.supplierId) query.set("supplierId", filters.supplierId);
  if (filters.materialType) query.set("materialType", filters.materialType);
  return query.toString();
}
function formatMoney(value: number, currency: string): string {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, notation: Math.abs(value) >= 1_000_000 ? "compact" : "standard", maximumFractionDigits: Math.abs(value) >= 1_000_000 ? 2 : 0 }).format(value); }
  catch { return `${currency} ${Math.round(value).toLocaleString("en-US")}`; }
}
function CurrencyList({ values, compact = false }: { values: CurrencyValues; compact?: boolean }) {
  const entries = Object.entries(values);
  if (!entries.length) return <span className="text-[#9aa1ad]">—</span>;
  return <div className={cn("flex flex-wrap gap-x-2 gap-y-1", compact ? "justify-end" : "")}>{entries.map(([currency, value]) => <span key={currency} className={cn("whitespace-nowrap font-semibold", compact ? "text-[11px] text-[#49546a]" : "text-sm text-[#242f44]")}>{formatMoney(value, currency)}</span>)}</div>;
}
function deltaTone(delta: RiskMetricDelta): string {
  if (delta.favorable === true) return "text-emerald-600";
  if (delta.favorable === false) return "text-red-500";
  return "text-[#7d8593]";
}

function MetricHelp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <Tooltip open={open} onOpenChange={setOpen}><TooltipTrigger asChild><button type="button" aria-label={text} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} className="inline-flex rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><Info className="size-3.5 text-[#a1a8b4]" /></button></TooltipTrigger><TooltipContent>{text}</TooltipContent></Tooltip>;
}

function DistributionDonut({ snapshot }: { snapshot: Snapshot }) {
  const { total } = snapshot.metrics;
  const distribution = snapshot.riskDistribution.map((item, index, items) => ({
    ...item,
    percent: total ? item.count / total * 100 : 0,
    start: total ? items.slice(0, index).reduce((sum, entry) => sum + entry.count / total * 100, 0) : 0,
  }));
  return <section className="rounded-[22px] border border-[#e2e6ed] bg-white p-6 shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
    <h2 className={RISK_ANALYTICAL_HEADING_CLASS}>风险评分分布</h2>
    <div className="mt-9 flex flex-col items-center gap-8 min-[1800px]:flex-row min-[1800px]:justify-center">
      <div className="relative size-[215px] shrink-0">
        <svg viewBox="0 0 120 120" className="size-full -rotate-90" aria-label={`${total} 张采购订单的风险评分分布`}>
          <circle cx="60" cy="60" r="45" pathLength="100" fill="none" stroke="#edf0f4" strokeWidth="18" />
          {distribution.map((item) => {
            if (!item.count || !total) return null;
            const visible = Math.max(0, item.percent - Math.min(1.6, item.percent * 0.18));
            return <circle key={item.risk} cx="60" cy="60" r="45" pathLength="100" fill="none" stroke={riskTone[item.risk]} strokeWidth="18" strokeLinecap="round" strokeDasharray={`${visible} ${100 - visible}`} strokeDashoffset={-item.start} />;
          })}
        </svg>
        <div className="absolute inset-[37px] flex flex-col items-center justify-center rounded-full bg-white"><span className="text-[38px] font-bold tracking-[-0.04em] text-[#151e31]">{total}</span><span className="mt-1 text-xs text-[#7c8594]">订单总数</span></div>
      </div>
      <div className="w-full max-w-[230px] space-y-5">{snapshot.riskDistribution.map((item) => <div key={item.risk} className="flex items-center gap-3"><span className="size-3 rounded-full" style={{ background: riskTone[item.risk] }} /><div className="flex-1"><div className="text-xs font-semibold text-[#4f596b]">{riskLabel[item.risk]}</div><div className="mt-1 text-xs text-[#8b93a0]">{item.count} ({total ? (item.count / total * 100).toFixed(1) : "0.0"}%)</div></div></div>)}</div>
    </div>
  </section>;
}

function RiskRadar({ snapshot, previous }: { snapshot: Snapshot; previous: Snapshot | null | undefined }) {
  const size = 320; const center = 160; const radius = 92; const count = Math.max(3, snapshot.riskBreakdown.length);
  const pointTuple = (index: number, value: number, offset = 0) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / count; const r = radius * value / 100 + offset; return { x: center + Math.cos(angle) * r, y: center + Math.sin(angle) * r, angle }; };
  const point = (index: number, value: number) => { const coordinate = pointTuple(index, value); return `${coordinate.x},${coordinate.y}`; };
  const grid = [25, 50, 75, 100].map((value) => ({ value, points: snapshot.riskBreakdown.map((_, index) => point(index, value)).join(" ") }));
  const polygon = snapshot.riskBreakdown.map((item, index) => point(index, item.score)).join(" ");
  const previousByCode = new Map(previous?.riskBreakdown.map((item) => [item.code, item.score]) ?? []);
  const previousPolygon = previous && snapshot.riskBreakdown.every((item) => previousByCode.has(item.code)) ? snapshot.riskBreakdown.map((item, index) => point(index, previousByCode.get(item.code) ?? 0)).join(" ") : null;
  return <section className="rounded-[22px] border border-[#e2e6ed] bg-white p-6 shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className={RISK_ANALYTICAL_HEADING_CLASS}>风险构成</h2><div className="flex flex-wrap items-center gap-4 text-[10px] text-[#7e8796]"><span className="flex items-center gap-2"><span className="size-2 rounded-full bg-blue-600" />本期</span>{previousPolygon ? <span className="flex items-center gap-2"><span className="w-4 border-t border-dashed border-slate-400" />上期</span> : null}</div></div>
    <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto mt-5 h-[300px] w-full max-w-[380px] overflow-visible" aria-label="风险构成雷达图">{grid.map((ring) => <polygon key={ring.value} points={ring.points} fill="none" stroke="#e5e9ef" strokeWidth="1" />)}{snapshot.riskBreakdown.map((_, index) => { const end = pointTuple(index, 100); return <line key={index} x1={center} y1={center} x2={end.x} y2={end.y} stroke="#e5e9ef" />; })}{previousPolygon ? <polygon points={previousPolygon} fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="5 4" /> : null}<polygon points={polygon} fill="rgba(37,99,235,0.2)" stroke="#2563eb" strokeWidth="2" />{snapshot.riskBreakdown.map((item, index) => { const coordinate = pointTuple(index, item.score); const label = pointTuple(index, 100, 34); const anchor = Math.cos(label.angle) > 0.25 ? "start" : Math.cos(label.angle) < -0.25 ? "end" : "middle"; const detail = item.weight === undefined ? `${item.score} · ${item.affectedPurchaseOrders} PO` : `${Math.round(item.weight * 100)}% · 证据覆盖率 ${Math.round((item.evidenceCoverage ?? 0) * 100)}%`; return <g key={item.code}><circle cx={coordinate.x} cy={coordinate.y} r="3" fill="#2563eb" /><text data-preserve-language x={label.x} y={label.y - 2} textAnchor={anchor} fontSize="10" fontWeight="600" fill="#596375">{breakdownLabel[item.code] ?? item.label}</text><text x={label.x} y={label.y + 11} textAnchor={anchor} fontSize="9" fill="#9aa1ad">{detail}</text></g>; })}</svg>
  </section>;
}

function SupplierRisk({ snapshot, onOpenPurchaseOrder, onViewAllSuppliers }: { snapshot: Snapshot; onOpenPurchaseOrder?: (purchaseOrderId: string) => void; onViewAllSuppliers?: () => void }) {
  return <section className="min-w-0 rounded-[22px] border border-[#e2e6ed] bg-white p-6 shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
    <h2 className={RISK_ANALYTICAL_HEADING_CLASS}>供应商风险（前 10）</h2>
    <div className="mt-5"><table className="w-full table-fixed text-left"><thead><tr className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#959ca9]"><th className="w-[32%] pb-3 pr-2">供应商</th><th className="w-[42%] pb-3 pr-2">风险评分（0–100）</th><th className="w-[26%] pb-3 text-right">风险金额</th></tr></thead><tbody>{snapshot.suppliers.map((supplier) => {
      const supplierOrders = snapshot.items.filter((item) => item.supplierId === supplier.supplierId).sort((left, right) => right.riskScore - left.riskScore);
      const purchaseOrder = supplierOrders[0];
      const presentation = supplierRiskPresentation(supplier.riskScore, supplier.purchaseOrders, supplierOrders);
      const barScore = presentation.barScore;
      return <tr key={supplier.supplierId} className="border-t border-[#edf0f4] align-top">
        <td className="min-w-0 py-3 pr-2 text-xs font-medium text-[#465064]">{purchaseOrder && onOpenPurchaseOrder ? <button type="button" onClick={() => onOpenPurchaseOrder(purchaseOrder.purchaseOrderId)} title={`打开 ${purchaseOrder.number}`} className="group flex w-full min-w-0 items-center gap-1 text-left hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><span data-preserve-language className="truncate">{supplier.supplierName}</span><ArrowUpRight className="size-3 shrink-0 opacity-0 transition group-hover:opacity-100" /></button> : <span data-preserve-language className="block truncate">{supplier.supplierName}</span>}</td>
        <td className="py-3 pr-2">{presentation ? <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-xs font-bold text-[#303a4c]">{presentation.score}</span>{barScore !== null && <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#edf0f4]"><span data-risk-score-bar className="block h-full rounded-full" style={{ width: `${barScore}%`, background: presentation.tone === "high" ? riskTone.high : presentation.tone === "medium" || presentation.tone === "provisional" ? riskTone.medium : presentation.tone === "low" ? riskTone.low : "#94a3b8" }} /></span>}</div>
          <div className={cn("mt-1 text-[9px] font-semibold", presentation.tone === "provisional" ? "text-amber-700" : presentation.tone === "unpublished" ? "text-slate-500" : "text-[#7c8594]")}>{presentation.stateLabel}</div>
          {presentation.missingLabel ? <div data-preserve-language className="mt-0.5 truncate text-[9px] text-[#8b94a2]" title={`缺少：${presentation.missingLabel}`}>缺少：{presentation.missingLabel}</div> : null}
          {presentation.provisionalEvidence.map((evidence) => <div key={supplierOrders[evidence.itemIndex]!.purchaseOrderId} data-risk-provisional-evidence className="mt-1 break-words text-[9px] leading-4 text-amber-800"><span data-preserve-language>{supplierOrders[evidence.itemIndex]!.number}</span> · {evidence.score} · {evidence.stateLabel}{evidence.missingLabel && <div data-preserve-language>缺少：{evidence.missingLabel}</div>}<div>含暂定评分，非正式风险等级</div></div>)}
        </div> : <span className="text-[#9aa1ad]">—</span>}</td>
        <td className="overflow-hidden py-3 text-right"><CurrencyList values={supplier.atRiskValueByCurrency} compact /></td>
      </tr>;
    })}{!snapshot.suppliers.length && <tr><td colSpan={3} className="py-14 text-center text-xs text-[#9aa1ad]">此快照中没有供应商风险记录</td></tr>}</tbody></table></div>
    {onViewAllSuppliers ? <button type="button" onClick={onViewAllSuppliers} className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-[#2563eb] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">查看全部供应商 <ArrowUpRight className="size-3" /></button> : null}
  </section>;
}

function AgingChart({ snapshot }: { snapshot: Snapshot }) {
  const max = Math.max(1, ...snapshot.aging.map((item) => item.purchaseOrders));
  return <section className="rounded-[22px] border border-[#e2e6ed] bg-white p-6 shadow-[0_2px_12px_rgba(20,31,48,0.025)]"><h2 className={RISK_ANALYTICAL_HEADING_CLASS}>逾期未结订单账龄分布</h2><p className="mt-1 text-xs text-[#9299a5]">订单数量</p><div className="mt-7 flex h-[210px] items-end justify-around gap-3 border-b border-[#e8ebf0] px-2">{snapshot.aging.map((item) => <div key={item.code} className="flex h-full flex-1 flex-col items-center justify-end"><span className="mb-2 text-xs font-bold text-[#4d5769]">{item.purchaseOrders}</span><div className="w-full max-w-[50px] rounded-t-md bg-[#ef4444]" style={{ height: `${Math.max(item.purchaseOrders ? 8 : 0, item.purchaseOrders / max * 165)}px` }} /></div>)}</div><div className="mt-3 flex justify-around gap-3 px-2">{snapshot.aging.map((item) => <div key={item.code} className="flex-1 text-center text-[10px] text-[#858d9a]">{agingLabel[item.code] ?? item.label}</div>)}</div></section>;
}

function ProductRisk({ snapshot, onOpenPurchaseOrder }: { snapshot: Snapshot; onOpenPurchaseOrder?: (purchaseOrderId: string) => void }) {
  const max = Math.max(1, ...snapshot.products.map((item) => item.delayedPurchaseOrders));
  return <section className="min-w-0 rounded-[22px] border border-[#e2e6ed] bg-white p-6 shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
    <h2 className={RISK_ANALYTICAL_HEADING_CLASS}>受延期订单影响的产品（前 10）</h2>
    <div className="mt-5"><table aria-label="受延期订单影响的产品" className="w-full table-fixed text-left">
      <thead><tr className="text-[10px] font-semibold text-[#959ca9]">
        <th scope="col" className="w-[42%] pb-3 pr-3">产品</th>
        <th scope="col" className="w-[22%] pb-3 pr-3 text-right">延期订单数</th>
        <th scope="col" className="w-[36%] pb-3 text-right">风险金额</th>
      </tr></thead>
      <tbody>{snapshot.products.map((product) => {
        const purchaseOrder = snapshot.items.filter((item) => item.materialType === product.materialType && item.overdueDays > 0).sort((left, right) => right.riskScore - left.riskScore)[0];
        return <tr key={product.materialType} className="border-t border-[#edf0f4]">
          <td className="min-w-0 py-3 pr-3">
            {purchaseOrder && onOpenPurchaseOrder
              ? <button type="button" onClick={() => onOpenPurchaseOrder(purchaseOrder.purchaseOrderId)} title={`打开 ${purchaseOrder.number}`} className="group flex max-w-full items-center gap-1.5 text-left text-xs font-medium text-[#465064] hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><span data-preserve-language className="truncate">{product.materialType}</span><ArrowUpRight className="size-3 shrink-0 opacity-0 transition group-hover:opacity-100" /></button>
              : <div data-preserve-language className="truncate text-xs font-medium text-[#465064]">{product.materialType}</div>}
            <div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#edf0f4]"><div className="h-full rounded-full bg-red-400" style={{ width: `${product.delayedPurchaseOrders / max * 100}%` }} /></div>
          </td>
          <td className="py-3 pr-3 text-right text-sm font-bold text-[#303a4c]">{product.delayedPurchaseOrders}</td>
          <td className="py-3 text-right"><CurrencyList values={product.atRiskValueByCurrency} compact /></td>
        </tr>;
      })}{!snapshot.products.length && <tr><td colSpan={3} className="border-t border-[#edf0f4] py-14 text-center text-xs text-[#9aa1ad]">没有受逾期订单影响的产品</td></tr>}</tbody>
    </table></div>
  </section>;
}

function TrendChart({ trend }: { trend: Dashboard["trend"] }) {
  const title = <h2 className={RISK_ANALYTICAL_HEADING_CLASS}>风险趋势（平均风险评分）</h2>;
  if (trend.length < 2) {
    const latest = trend[0];
    return <section className="rounded-[22px] border border-[#e2e6ed] bg-white p-6 shadow-[0_2px_12px_rgba(20,31,48,0.025)]">{title}<p className="mt-1 text-xs text-[#9299a5]">风险评分（0–100） · 仅使用已保存快照</p><div className="mt-5 flex min-h-[210px] flex-col items-center justify-center rounded-xl border border-dashed border-[#dfe4ec] bg-[#fafbfc] px-6 text-center"><p className="text-sm font-semibold text-[#596375]">至少保存两份真实快照后才显示风险趋势</p>{latest && <p className="mt-2 text-xs text-[#8992a1]">当前平均风险评分： <span className="font-bold text-[#2563eb]">{latest.averageRiskScore}</span> ({latest.asOf.slice(0, 10)})</p>}</div></section>;
  }
  const points = trend;
  const width = 520; const height = 185; const px = 24; const py = 24;
  const x = (index: number) => points.length === 1 ? width / 2 : px + index * (width - px * 2) / (points.length - 1);
  const y = (value: number) => height - py - value / 100 * (height - py * 2);
  const path = points.map((item, index) => `${index ? "L" : "M"}${x(index)},${y(item.averageRiskScore)}`).join(" ");
  return <section className="rounded-[22px] border border-[#e2e6ed] bg-white p-6 shadow-[0_2px_12px_rgba(20,31,48,0.025)]">{title}<p className="mt-1 text-xs text-[#9299a5]">风险评分（0–100） · 仅使用已保存快照</p><svg viewBox={`0 0 ${width} ${height}`} className="mt-5 h-[210px] w-full" aria-label="风险趋势折线图">{[0, 25, 50, 75, 100].map((value) => <g key={value}><line x1={px} x2={width - px} y1={y(value)} y2={y(value)} stroke="#e8ebf0" /><text x="0" y={y(value) + 4} fontSize="9" fill="#9aa1ad">{value}</text></g>)}<path d={path} fill="none" stroke="#2563eb" strokeWidth="2.5" />{points.map((item, index) => <g key={item.snapshotId}><circle cx={x(index)} cy={y(item.averageRiskScore)} r="3.5" fill="#2563eb" /><text x={x(index)} y={y(item.averageRiskScore) - 9} textAnchor="middle" fontSize="10" fontWeight="700" fill="#2563eb">{item.averageRiskScore}</text></g>)}</svg><div className="mt-1 flex justify-between text-[10px] text-[#9299a5]"><span>{points[0]?.asOf.slice(0, 10)}</span><span>{points.at(-1)?.asOf.slice(0, 10)}</span></div></section>;
}

function HighRiskPurchaseOrders({ snapshot, formatDate, onOpenPurchaseOrder, onViewAllHighRiskPurchaseOrders }: {
  snapshot: Snapshot;
  formatDate: (value: string | null | undefined, fallback?: string) => string;
  onOpenPurchaseOrder?: (purchaseOrderId: string) => void;
  onViewAllHighRiskPurchaseOrders?: () => void;
}) {
  const rows = snapshot.items
    .filter(isHighRiskListItem)
    .sort((left, right) => right.riskScore - left.riskScore || right.overdueDays - left.overdueDays || left.number.localeCompare(right.number))
    .slice(0, 10);
  type HighRiskRow = Snapshot["items"][number];
  const columns: ColumnDef<HighRiskRow, unknown>[] = [
    { id: "number", header: "PO 编号", cell: ({ row }) => onOpenPurchaseOrder ? <button type="button" onClick={() => onOpenPurchaseOrder(row.original.purchaseOrderId)} data-preserve-language className="font-semibold text-[#2563eb] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">{row.original.number}</button> : <span data-preserve-language className="font-semibold text-[#2563eb]">{row.original.number}</span> },
    { id: "supplier", header: "供应商", cell: ({ row }) => <span data-preserve-language className="block max-w-[180px] truncate" title={row.original.supplierName}>{row.original.supplierName}</span> },
    { id: "risk", header: "风险等级", cell: ({ row }) => { const presentation = riskScorePresentation(row.original); return <><span className="inline-flex rounded-full bg-red-50 px-2.5 py-1 text-[10px] font-bold text-red-600">{presentation.label}</span><div className="mt-1 text-[9px] text-slate-400">{presentation.stateLabel}</div></>; } },
    { id: "score", header: "风险评分", cell: ({ row }) => <span className="whitespace-nowrap font-bold text-red-600">{riskScorePresentation(row.original).score}</span> },
    { id: "factors", header: "风险因素", cell: ({ row }) => { const factors = row.original.riskFactors ?? []; const label = (factor: RiskFactor) => breakdownLabel[factor.code] ?? factor.label; const text = factors.slice(0, 2).map(label).join(", ") || "未记录风险因素"; const evidence = factors.slice(0, 3).map((factor) => `${label(factor)}: ${factor.evidence}`).join("\n"); return <span data-preserve-language className="line-clamp-2 max-w-[220px]" title={evidence || text}>{text}</span>; } },
    { id: "rihd", header: "要求到货日期（RIHD）", cell: ({ row }) => <div className="whitespace-nowrap"><div>{row.original.requiredInHouseAt ? formatDate(row.original.requiredInHouseAt, "—") : "—"}</div>{row.original.overdueDays > 0 ? <div className="mt-0.5 text-[10px] font-semibold text-red-600">已逾期 {row.original.overdueDays} 天</div> : null}</div> },
    { id: "amount", header: "订单金额", cell: ({ row }) => <span className="block whitespace-nowrap text-right font-semibold text-[#303a4c]">{formatMoney(row.original.amountTotal, row.original.currency)}</span> },
    { id: "next", header: "下一步操作", cell: ({ row }) => <span data-preserve-language className="line-clamp-2 max-w-[190px]" title={row.original.nextAction || "此历史快照未记录下一步操作"}>{row.original.nextAction || "—"}</span> },
    { id: "actions", header: () => <span className="sr-only">操作</span>, cell: ({ row }) => onOpenPurchaseOrder ? <button type="button" onClick={() => onOpenPurchaseOrder(row.original.purchaseOrderId)} aria-label={`打开 ${row.original.number} 的完整采购详情`} title="打开采购订单" className="flex size-7 items-center justify-center rounded-lg text-[#8a93a1] hover:bg-[#edf1f6] hover:text-[#374151] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><MoreHorizontal className="size-4" /></button> : null },
  ];
  return <section className="mt-5 overflow-hidden rounded-[22px] border border-[#e2e6ed] bg-white shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
    <div className="p-5 pb-4"><h2 className={RISK_ANALYTICAL_HEADING_CLASS}>高风险采购订单</h2></div>
    <DataTable ariaLabel="高风险采购订单" columns={columns} rows={rows} empty="此快照中没有高风险采购订单" className="rounded-none border-x-0 border-b-0" tableClassName="min-w-[1120px] border-collapse text-left" />
    {onViewAllHighRiskPurchaseOrders ? <div className="px-5 py-4"><button type="button" onClick={onViewAllHighRiskPurchaseOrders} className="text-xs font-semibold text-[#2563eb] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">查看全部高风险订单</button></div> : null}
  </section>;
}

export function ProcurementRiskDashboard({ onOpenPurchaseOrder, onViewAllSuppliers, onViewAllHighRiskPurchaseOrders }: { onOpenPurchaseOrder?: (purchaseOrderId: string) => void; onViewAllSuppliers?: () => void; onViewAllHighRiskPurchaseOrders?: () => void }) {
  const { preferences, formatDate: formatCalendarDate, formatDateTime: formatDate } = useProcurementLocale();
  const [range, setRange] = useState(() => initialRange(preferences.timeZone));
  const rangeTimeZone = useRef(preferences.timeZone);
  const [appliedRange, setAppliedRange] = useState(() => initialRange(preferences.timeZone));
  const [filters, setFilters] = useState<DashboardFilters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<DashboardFilters>(emptyFilters);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<{ status: number; requestId: string | null } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (rangeTimeZone.current === preferences.timeZone) return;
    rangeTimeZone.current = preferences.timeZone;
    const nextRange = initialRange(preferences.timeZone);
    setRange(nextRange);
    setAppliedRange(nextRange);
  }, [preferences.timeZone]);
  const load = useCallback(async (nextRange: { from: string; to: string }, nextFilters: DashboardFilters) => {
    abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller; setLoading(true); setError(null);
    try { const response = await apiRequest<Dashboard>(`/api/procurement/risk-dashboard?${dashboardQuery(nextRange, nextFilters)}`, { signal: controller.signal }); if (!controller.signal.aborted) { setData(response); setReadError(null); } }
    catch (cause) { if (!controller.signal.aborted) { setError(errorText(cause)); setReadError(readFailureDetails(cause)); } }
    finally { if (!controller.signal.aborted) setLoading(false); if (abortRef.current === controller) abortRef.current = null; }
  }, []);
  useEffect(() => { void load(appliedRange, appliedFilters); return () => abortRef.current?.abort(); }, [appliedFilters, appliedRange, load]);
  async function refreshSnapshot() { if (data?.capabilities?.refresh !== true) return; setRefreshing(true); setError(null); try { await apiRequest("/api/procurement/risk-dashboard/refresh", { method: "POST" }); await load(appliedRange, appliedFilters); } catch (cause) { setError(errorText(cause)); } finally { setRefreshing(false); } }
  function applyDateRange() {
    if (range.from > range.to) { setError("开始日期不能晚于结束日期"); return; }
    setError(null); setAppliedRange({ ...range }); setRangeOpen(false);
  }
  function applyFilters() {
    setError(null); setAppliedFilters({ ...filters }); setFiltersOpen(false);
  }
  function setFiltersPanelOpen(open: boolean) {
    setRangeOpen(false);
    if (open) setFilters({ ...appliedFilters });
    setFiltersOpen(open);
  }
  function clearFilters() { const cleared = emptyFilters(); setFilters(cleared); setAppliedFilters(cleared); setFiltersOpen(false); }
  async function exportCsv() {
    setExporting(true); setError(null);
    try {
      const response = await fetch(`/api/procurement/risk-dashboard/export?${dashboardQuery(appliedRange, appliedFilters)}`, { credentials: "same-origin", headers: { accept: "text/csv" } });
      if (!response.ok) {
        let message = `导出失败（${response.status}）`;
        try { const payload = await response.json() as { error?: string }; if (payload.error) message = payload.error; } catch { /* Keep the HTTP status when the body is not JSON. */ }
        throw new ReadyworkApiError(message, response.status);
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? `readywork-risk-${appliedRange.to}.csv`;
      const href = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = href; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(href);
    } catch (cause) { setError(errorText(cause)); } finally { setExporting(false); }
  }
  const activeFilterCount = Object.values(appliedFilters).filter(Boolean).length;
  const canRefreshSnapshot = data?.capabilities?.refresh === true;
  const snapshot = data?.latest;
  const previous = data?.previous;
  const metrics = snapshot?.metrics;
  const highRiskTrend = data?.trend.map((item) => item.highRiskPercent) ?? [];
  const legacySnapshot = snapshot?.modelVersion === "legacy-risk-v1";
  const cards = useMemo(() => metrics ? [
    { label: "高风险订单占比", value: `${metrics.highRiskPercent.toFixed(1)}%`, note: `${metrics.high} / ${metrics.total} 张订单`, delta: riskMetricDelta(metrics.highRiskPercent, previous?.metrics.highRiskPercent, { suffix: "%" }), tone: "text-red-500", help: legacySnapshot ? "旧模型快照中的高风险订单占比，不代表 V2 正式评分。" : "已发布高风险评分的活跃采购订单占比。" },
    { label: "高风险订单", value: String(metrics.high), note: `${metrics.total} 张活跃订单`, delta: riskMetricDelta(metrics.high, previous?.metrics.high), tone: "text-[#1a2233]", help: legacySnapshot ? "旧模型快照中归类为高风险的订单数量。" : "已发布风险评分在 70–100 的活跃采购订单。" },
    { label: "中风险订单", value: String(metrics.medium), note: "风险评分 40–69", delta: riskMetricDelta(metrics.medium, previous?.metrics.medium), tone: "text-amber-500", help: legacySnapshot ? "旧模型快照中归类为中风险的订单数量。" : "已发布风险评分在 40–69 的活跃采购订单。" },
    { label: "低风险订单", value: String(metrics.low), note: "风险评分 0–39", delta: riskMetricDelta(metrics.low, previous?.metrics.low, { increaseIsFavorable: true }), tone: "text-emerald-600", help: legacySnapshot ? "旧模型快照中归类为低风险的订单数量；缺少 V2 证据覆盖率。" : "已发布风险评分在 0–39 的活跃采购订单；数量增加通常意味着整体采购风险降低。" },
  ] : [], [metrics, previous, legacySnapshot]);
  const atRiskValueDeltas = metrics ? currencyMetricDeltas(metrics.atRiskValueByCurrency, previous?.metrics.atRiskValueByCurrency) : [];

  return <div className={cn(READYWORK_PAGE_CONTAINER_CLASS, "pb-16")}>
    <header className="relative z-30 flex flex-col justify-between gap-5 border-b border-[#e1e5eb] pb-6 xl:flex-row xl:items-start">
      <div><div className="text-xs font-medium text-[#98a0ad]">总览 <span className="px-1.5">›</span> 报表 <span className="px-1.5">›</span> 风险看板</div><h1 className={cn("mt-[30px]", READYWORK_PAGE_TITLE_CLASS)}>风险看板</h1><p className="mt-1.5 text-sm text-[#70798a]">监控采购风险及其潜在影响</p></div>
      <div className="flex max-w-[820px] flex-wrap items-center justify-end gap-2 xl:mt-[46px]">
        <Popover open={rangeOpen} onOpenChange={(nextOpen) => { setFiltersOpen(false); if (nextOpen) setRange({ ...appliedRange }); setRangeOpen(nextOpen); }}>
          <PopoverTrigger asChild><button type="button" aria-label="选择风险快照日期范围" className={cn("flex h-9 items-center gap-2 rounded-xl border bg-white px-3 text-xs font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2", rangeOpen ? "border-blue-300 text-blue-700" : "border-[#dfe3ea] text-[#596273]")}><CalendarDays className="size-4" /><span>{formatCalendarDate(appliedRange.from)} — {formatCalendarDate(appliedRange.to)}</span><ChevronDown className={cn("size-3.5 transition-transform", rangeOpen && "rotate-180")} /></button></PopoverTrigger>
          <PopoverContent align="end" aria-label="选择风险快照日期范围" className="w-auto max-w-[calc(100vw-32px)] p-4">
            <div><h2 className="text-sm font-bold text-[#263146]">日期范围</h2><p className="mt-1 text-[11px] text-[#8992a1]">读取所选日期范围内已保存的快照。</p></div>
            <DateRangePicker ariaLabel="风险快照日期范围日历" value={range} onChange={setRange} />
            <div className="mt-2 text-center text-[11px] font-medium text-[#657083]">{formatCalendarDate(range.from)} — {formatCalendarDate(range.to)}</div>
            <div className="mt-4 flex justify-end gap-2 border-t border-[#edf0f4] pt-3"><button type="button" onClick={() => { setRange({ ...appliedRange }); setRangeOpen(false); }} className="h-9 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#657083]">取消</button><button type="button" onClick={applyDateRange} className="h-9 rounded-xl bg-[#2563eb] px-4 text-xs font-semibold text-white">应用日期</button></div>
          </PopoverContent>
        </Popover>
        <Popover open={filtersOpen} onOpenChange={setFiltersPanelOpen}>
          <PopoverTrigger asChild><button type="button" disabled={loading && !data} className={cn("relative flex h-9 items-center gap-2 rounded-xl border bg-white px-4 text-xs font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50", activeFilterCount || filtersOpen ? "border-blue-300 text-blue-700" : "border-[#dfe3ea] text-[#596273]")}><Filter className="size-4" />筛选{activeFilterCount > 0 && <span className="flex size-5 items-center justify-center rounded-full bg-blue-600 text-[10px] text-white">{activeFilterCount}</span>}</button></PopoverTrigger>
          <PopoverContent align="end" aria-label="风险快照筛选" className="z-50 w-[660px] max-w-[calc(100vw-32px)] rounded-[16px] border border-[#dfe4ec] bg-white p-4 shadow-[0_18px_50px_rgba(31,42,68,0.16)]">
            <div className="flex items-center justify-between"><div><h2 className="text-sm font-bold text-[#263146]">风险快照筛选</h2><p className="mt-1 text-[11px] text-[#8992a1]">筛选同步应用于指标、图表、趋势和 CSV 导出。</p></div><button type="button" aria-label="关闭筛选" onClick={() => { setFilters({ ...appliedFilters }); setFiltersOpen(false); }} className="flex size-8 items-center justify-center rounded-lg text-[#7f8897] hover:bg-[#f3f5f8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"><X className="size-4" /></button></div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="space-y-1.5"><span className="text-[11px] font-semibold text-[#6d7788]">风险等级</span><select aria-label="风险等级" value={filters.risk ?? ""} onChange={(event) => setFilters((current) => ({ ...current, risk: (event.target.value || null) as Risk | null }))} className="h-10 w-full rounded-xl border border-[#dfe3ea] bg-white px-3 text-xs text-[#445066] outline-none focus:border-blue-400"><option value="">全部风险等级</option>{data?.filterOptions.risks.map((risk) => <option key={risk} value={risk}>{riskLabel[risk]}</option>)}</select></label>
              <label className="space-y-1.5"><span className="text-[11px] font-semibold text-[#6d7788]">采购路线</span><select aria-label="采购路线" value={filters.route ?? ""} onChange={(event) => setFilters((current) => ({ ...current, route: (event.target.value || null) as Route | null }))} className="h-10 w-full rounded-xl border border-[#dfe3ea] bg-white px-3 text-xs text-[#445066] outline-none focus:border-blue-400"><option value="">全部路线</option>{data?.filterOptions.routes.map((route) => <option key={route} value={route}>{routeLabel[route]}</option>)}</select></label>
              <label className="space-y-1.5"><span className="text-[11px] font-semibold text-[#6d7788]">供应商</span><select aria-label="供应商" value={filters.supplierId ?? ""} onChange={(event) => setFilters((current) => ({ ...current, supplierId: event.target.value || null }))} className="h-10 w-full rounded-xl border border-[#dfe3ea] bg-white px-3 text-xs text-[#445066] outline-none focus:border-blue-400"><option value="">全部供应商</option>{data?.filterOptions.suppliers.map((supplier) => <option data-preserve-language key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
              <label className="space-y-1.5"><span className="text-[11px] font-semibold text-[#6d7788]">物料类型</span><select aria-label="物料类型" value={filters.materialType ?? ""} onChange={(event) => setFilters((current) => ({ ...current, materialType: event.target.value || null }))} className="h-10 w-full rounded-xl border border-[#dfe3ea] bg-white px-3 text-xs text-[#445066] outline-none focus:border-blue-400"><option value="">全部物料类型</option>{data?.filterOptions.materialTypes.map((materialType) => <option data-preserve-language key={materialType} value={materialType}>{materialType}</option>)}</select></label>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-[#edf0f4] pt-3"><span className="text-[11px] text-[#8b94a2]">显示 {data?.filteredItemCount ?? 0} / {data?.unfilteredItemCount ?? 0} 张订单</span><div className="flex gap-2"><button type="button" onClick={clearFilters} className="h-9 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#657083]">清除筛选</button><button type="button" onClick={applyFilters} className="h-9 rounded-xl bg-[#2563eb] px-4 text-xs font-semibold text-white">应用筛选</button></div></div>
          </PopoverContent>
        </Popover>
        <button type="button" onClick={() => void exportCsv()} disabled={exporting || loading || Boolean(readError) || !data?.latest} className="flex h-9 items-center gap-2 rounded-xl border border-[#dfe3ea] bg-white px-4 text-xs font-semibold text-[#596273] shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2 disabled:opacity-50">{exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}{exporting ? "正在导出…" : "导出"}</button>
      </div>
    </header>
    {error && <div role="alert" className="mt-4 flex flex-wrap items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span data-preserve-language className="min-w-0 flex-1 break-words">{error}</span>{readError?.status === 403 && <span className="w-full">没有读取风险快照的权限，请联系管理员。</span>}{readError?.requestId && <span className="w-full text-xs">请求编号：<span data-preserve-language>{readError.requestId}</span></span>}{readError && <button type="button" disabled={loading} onClick={() => void load(appliedRange, appliedFilters)} className="rounded-lg px-2 font-semibold underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50">重试读取</button>}</div>}
    {data && (loading || readError) && <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">{loading ? "正在重新读取风险快照。" : "风险快照读取失败。"}显示的是上次成功读取的快照{snapshot ? `（${formatDate(snapshot.asOf)}）` : ""}，并非最新读取结果。</p>}
    {snapshot && data?.freshness.state === "stale" && <section role="status" className="mt-5 flex flex-col gap-4 rounded-[20px] border border-amber-200 bg-amber-50/80 px-5 py-4 shadow-[0_2px_10px_rgba(120,83,20,0.04)] lg:flex-row lg:items-center">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700"><AlertCircle className="size-5" /></span>
      <div className="min-w-0 flex-1"><h2 className="text-sm font-bold text-amber-950">快照生成后，采购数据已发生变化</h2><p className="mt-1 text-xs leading-5 text-amber-800">此快照记录了 <strong>{snapshot.metrics.high}</strong> 张高风险订单；当前订单的只读计算结果为 <strong>{data.freshness.liveMetrics.high}</strong> 张。{data.freshness.reason === "calendar_day_changed" ? "跨日后，账龄和风险等级可能发生变化。" : data.freshness.reason === "configuration_changed" ? "快照生成后，采购配置已发生变化。" : "快照生成后出现了新的采购事实。"}主动更新快照前，图表和导出仍使用此不可变快照。</p></div>
      {canRefreshSnapshot ? <button type="button" onClick={() => void refreshSnapshot()} disabled={refreshing} className="flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-amber-700 px-4 text-xs font-semibold text-white hover:bg-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-50">{refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}更新风险快照</button> : <span className="text-xs font-semibold text-amber-900">需要具备操作权限的用户更新风险快照。</span>}
    </section>}
    {loading && !data ? <section aria-label="风险看板加载中" aria-busy="true" className="mt-6">
      <p role="status" className="flex items-center text-sm font-medium text-[#7f8794]"><Loader2 className="mr-2 size-5 animate-spin" />正在读取已保存的风险快照…</p>
      <div aria-hidden="true" className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <div key={index} data-risk-loading-kpi className="h-44 animate-pulse rounded-[20px] border border-[#e2e6ed] bg-white"><div className="m-5 h-3 w-24 rounded bg-slate-100" /><div className="mx-5 mt-7 h-9 w-20 rounded bg-slate-100" /><div className="mx-5 mt-10 h-px bg-slate-100" /></div>)}</div>
      <div aria-hidden="true" className="mt-5 grid gap-5 xl:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <div key={index} data-risk-loading-panel className="h-[360px] animate-pulse rounded-[22px] border border-[#e2e6ed] bg-white"><div className="m-6 h-4 w-36 rounded bg-slate-100" /><div className="mx-auto mt-16 size-36 rounded-full bg-slate-100" /></div>)}</div>
    </section> : !snapshot ? data && !readError ? <section className="mt-6 flex min-h-[460px] flex-col items-center justify-center rounded-[24px] border border-dashed border-[#d9dee7] bg-white px-6 text-center"><span className="flex size-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><ShieldAlert className="size-8" /></span><h2 className="mt-5 text-xl font-bold text-[#20293a]">所选日期范围内没有风险快照</h2><p className="mt-2 max-w-lg text-sm leading-6 text-[#7c8595]">创建快照会读取真实订单、异常、供应商回复、连接器结果及要求到货日期，不修改订单，也不触发外部动作。</p>{canRefreshSnapshot ? <button type="button" onClick={() => void refreshSnapshot()} disabled={refreshing} className="mt-6 flex h-11 items-center gap-2 rounded-xl bg-[#2563eb] px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50">{refreshing ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}创建首个快照</button> : <p className="mt-5 rounded-xl bg-slate-50 px-4 py-3 text-xs font-semibold text-[#596375]">当前为只读访问；需要具备操作权限的用户创建风险快照。</p>}</section> : null : <>
      <TooltipProvider delayDuration={150}><section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{cards.map((card, index) => <div key={card.label} className="flex min-h-[176px] min-w-0 flex-col rounded-[20px] border border-[#e2e6ed] bg-white p-5 shadow-[0_2px_10px_rgba(20,31,48,0.025)]"><div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-[#747e90]"><span>{card.label}</span><MetricHelp text={card.help} /></div><div className="mt-4 flex items-end justify-between gap-2"><div className={cn("text-[34px] font-bold tracking-[-0.045em]", card.tone)}>{card.value}</div>{index === 0 ? <RiskSparkline values={highRiskTrend} /> : null}</div><div className="mt-1 text-xs text-[#8a92a1]">{card.note}</div><div className="mt-auto flex items-center justify-between border-t border-[#edf0f4] pt-3 text-[11px]"><span className="text-[#8f96a2]">较上一份快照</span><span className={deltaTone(card.delta)}>{card.delta.text}</span></div></div>)}<div className="flex min-h-[176px] min-w-0 flex-col rounded-[20px] border border-[#e2e6ed] bg-white p-5 shadow-[0_2px_10px_rgba(20,31,48,0.025)]"><div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-[#747e90]"><span>风险金额</span><MetricHelp text="存在风险的订单金额；未配置汇率时按币种分别显示。" /></div><div className="mt-4"><CurrencyList values={metrics!.atRiskValueByCurrency} /></div><div className="mt-3 text-xs text-[#8a92a1]">未配置汇率时，各币种分别统计</div><div className="mt-auto border-t border-[#edf0f4] pt-3 text-[11px]">{!previous ? <span className="text-[#8f96a2]">无上一份快照</span> : atRiskValueDeltas.length ? <div className="flex items-center justify-between gap-2"><span className="shrink-0 text-[#8f96a2]">较上一份快照</span><div className="flex min-w-0 flex-wrap justify-end gap-x-2">{atRiskValueDeltas.slice(0, 2).map((item) => <span key={item.currency} className={cn("whitespace-nowrap font-semibold", deltaTone(item))}>{item.direction === "flat" ? `${item.currency} 无变化` : `${item.direction === "up" ? "↗" : "↘"} ${formatMoney(item.absoluteDelta, item.currency)}`}</span>)}{atRiskValueDeltas.length > 2 && <span className="text-[#8f96a2]">+{atRiskValueDeltas.length - 2}</span>}</div></div> : <span className="text-[#8f96a2]">金额较上一份快照无变化</span>}</div></div></section></TooltipProvider>
      <section aria-label="风险评分发布状态" className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-[#e4e8ef] bg-white px-4 py-3 text-[11px] text-[#657083]">
        <span className="font-bold text-[#334155]">{snapshot.modelVersion === "risk-model-v2" ? "RiskModelV2 · 30/25/20/15/10" : "旧模型风险快照 · 只读"}</span>
        {snapshot.modelVersion === "risk-model-v2" ? <><span>已发布 <strong className="text-[#334155]">{metrics!.high + metrics!.medium + metrics!.low}</strong></span><span>暂定评分 <strong className="text-amber-700">{metrics!.provisional ?? 0}</strong></span><span>评分未发布 <strong className="text-slate-600">{metrics!.unpublished ?? 0}</strong></span><span>高风险 ≥ 70 · 中风险 ≥ 40</span></> : <span>按原始快照展示历史算法结果，不使用 V2 回填。</span>}
      </section>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11px] text-[#989faa]">{activeFilterCount > 0 && <span className="font-semibold text-blue-700">已筛选 {data?.filteredItemCount ?? 0} / {data?.unfilteredItemCount ?? 0} 张订单</span>}{!readError && !loading && data?.freshness.state === "current" && <span className="font-semibold text-emerald-700">与当前采购数据一致</span>}<span>快照 {formatDate(snapshot.asOf)} · {data?.snapshotCount ?? 0} 个历史记录点</span>{canRefreshSnapshot ? <button type="button" onClick={() => void refreshSnapshot()} disabled={refreshing} className="flex items-center gap-1 font-semibold text-[#657083] hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50"><RefreshCw className={cn("size-3", refreshing && "animate-spin")} />更新快照</button> : null}</div>
      <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)_minmax(0,1fr)]"><DistributionDonut snapshot={snapshot} /><RiskRadar snapshot={snapshot} previous={previous} /><SupplierRisk snapshot={snapshot} onOpenPurchaseOrder={onOpenPurchaseOrder} onViewAllSuppliers={onViewAllSuppliers} /></section>
      <section className="mt-5 grid gap-5 xl:grid-cols-3 [&>section]:min-w-0"><AgingChart snapshot={snapshot} /><ProductRisk snapshot={snapshot} onOpenPurchaseOrder={onOpenPurchaseOrder} /><TrendChart trend={data?.trend ?? []} /></section>
      <HighRiskPurchaseOrders snapshot={snapshot} formatDate={formatCalendarDate} onOpenPurchaseOrder={onOpenPurchaseOrder} onViewAllHighRiskPurchaseOrders={onViewAllHighRiskPurchaseOrders} />
      <p className="mt-5 flex items-start gap-1.5 text-xs leading-5 text-[#7d8694]"><Info className="mt-0.5 size-3.5 shrink-0" /><span>{legacySnapshot ? "旧模型风险快照仅按冻结的历史算法结果展示；不使用 V2 回填。原快照未记录的证据保持空缺，不推断为零风险。" : "RiskModelV2 使用冻结在快照中的真实订单证据，权重分别为供应商绩效（30%）、交付延误（25%）、订单金额（20%）、产品关键程度（15%）、合规与审批（10%）。证据不足时保留“暂定评分”或“评分未发布”；缺少证据绝不等于零风险。"}</span></p>
    </>}
  </div>;
}
