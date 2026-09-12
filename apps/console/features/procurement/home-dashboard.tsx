"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  AlertTriangle, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, ClipboardList, Clock3,
  Factory, Globe2, Loader2, Mail, MoreHorizontal, Pencil, Search, ShieldAlert, ShoppingCart, Sparkles, UsersRound, X,
} from "lucide-react";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { cn } from "@/lib/utils";
import { RouteRiskOverview, type RouteRiskBucket, type RouteRiskSummary } from "@/features/procurement/route-risk-overview";
import { procurementCalendarDate, procurementCalendarDateDaysBefore, useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { useProcurementRealtimeRefresh } from "@/features/procurement/realtime-events";
import { READYWORK_PAGE_CONTAINER_CLASS, READYWORK_PAGE_TITLE_CLASS } from "@/features/procurement/visual-tokens";
import {
  overviewMetricSeries,
  type OverviewMetricKey as MetricKey,
  type OverviewMetrics,
  type OverviewTrendFreshness,
  type OverviewTrendPoint as TrendPoint,
} from "@/features/procurement/overview-trend";

type HomeSection = "orders" | "sourcing" | "suppliers" | "payables" | "documents" | "my-work" | "local-procurement" | "import-procurement" | "message-drafts";
export type HomePurchaseOrderIntent = "view" | "edit-rihd" | "mark-at-risk";
type Risk = "high" | "medium" | "low";
type Route = "local" | "import" | "unclassified";
type HighlightCode = "supplier_no_response" | "rihd_overdue" | "approval_pending" | "ready_for_production";
type RiskFactor = { code: string; label: string; score: number; evidence: string };
type PortfolioItem = {
  id: string; number: string; supplierId: string; supplierName: string; route: Route; materialType: string;
  status: string; stage: string; stageLabel: string; requiredInHouseAt: string | null; overdueDays: number;
  risk: Risk; riskScore: number; riskFactors: RiskFactor[]; nextAction: string; currency: string; amountTotal: number;
  supplierPerformanceScore: number | null; active: boolean;
  routeRiskBucket?: "high_risk" | "awaiting_supplier" | "delivery_risk" | "on_track";
};
type RouteSummary = RouteRiskSummary;
type Portfolio = {
  generatedAt: string;
  metrics: OverviewMetrics & { unclassifiedRoute: number; atRiskValueByCurrency: Record<string, number> };
  riskDistribution: Record<Risk, number>;
  routes: Record<Route, RouteSummary>;
  highlights: Array<{ code: HighlightCode; count: number; severity: Risk; message: string }>;
  items: PortfolioItem[];
};
type WorkbenchPayload = { portfolio?: Portfolio };
type RiskHistory = {
  range: { from: string; to: string };
  trend: TrendPoint[];
  snapshotCount: number;
  freshness: OverviewTrendFreshness;
};

const routeLabels: Record<Route, string> = { local: "本地", import: "进口", unclassified: "未分类" };
const riskLabels: Record<Risk, string> = { high: "高", medium: "中", low: "低" };
const riskDot: Record<Risk, string> = { high: "bg-[#f04444]", medium: "bg-[#f5a000]", low: "bg-[#16a34a]" };
const highlightLabels: Record<HighlightCode, string> = {
  supplier_no_response: "等待供应商确认",
  rihd_overdue: "已超过要求日期",
  approval_pending: "需要人工决策",
  ready_for_production: "进度正常",
};
const stageLabels: Record<string, string> = {
  po_sent: "采购订单已发送", supplier_commitment: "供应商承诺", fulfilment_production: "履约 / 生产",
  dispatch_transit: "发运", delivery_grn: "交付完成及 GRN",
};
const nextActionLabels: Record<string, string> = {
  "发送采购订单": "发送采购订单",
  "获取供应商确认": "获取供应商确认",
  "确认生产 / 备货进度": "确认生产 / 备货进度",
  "跟踪发运与在途状态": "跟踪发运与在途状态",
  "核验收货与 ERP GRN": "核验收货与 ERP GRN",
  "查看完整审计": "查看完整审计",
  "检查当前执行状态": "检查当前执行状态",
};
const emptyRoute: RouteSummary = { total: 0, high: 0, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 0 };
const emptyMetrics: Portfolio["metrics"] = {
  highRisk: 0, overdue: 0, requireAttention: 0, activePurchaseOrders: 0, localProcurement: 0,
  importProcurement: 0, unclassifiedRoute: 0, atRiskValueByCurrency: {},
};

function initialRange(timeZone: string) {
  const to = new Date();
  return {
    from: procurementCalendarDateDaysBefore(to, timeZone, 29),
    to: procurementCalendarDate(to, timeZone),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof ReadyworkApiError && error.status === 403) return "当前会话没有读取采购订单组合的权限。";
  return "无法加载采购订单组合，请重试。";
}

function highlightMessage(item: Portfolio["highlights"][number]): string {
  if (item.code === "supplier_no_response") return `${item.count} 张采购订单仍在等待供应商确认。`;
  if (item.code === "rihd_overdue") return `${item.count} 张采购订单已超过要求到货日期。`;
  if (item.code === "approval_pending") return `${item.count} 张采购订单需要人工决策。`;
  return `${item.count} 张采购订单正在按计划推进。`;
}

type FilterOption<T extends string> = { value: T; label: string };

function OverviewFilterMenu<T extends string>({ label, value, options, onChange, preserveOptionLanguage = false }: {
  label: string;
  value: T | "all";
  options: readonly FilterOption<T>[];
  onChange: (value: T) => void;
  preserveOptionLanguage?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (index + 1) % items.length
          : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length
            : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  }

  return <div className="relative">
    <button ref={triggerRef} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)} className={cn("inline-flex h-9 items-center gap-1.5 rounded-xl border bg-white px-3 text-[13px] font-medium transition", open ? "border-blue-300 text-blue-700" : "border-slate-200 text-slate-600 hover:border-slate-300")}><span data-preserve-language={selected && preserveOptionLanguage ? true : undefined}>{selected?.label ?? label}</span><ChevronDown className={cn("size-3.5 transition", open && "rotate-180")} /></button>
    {open && <div ref={menuRef} role="menu" aria-label={label} onKeyDown={handleMenuKeyDown} className="absolute right-0 top-12 z-50 min-w-[150px] overflow-hidden rounded-xl border border-[#dfe4ec] bg-white p-1.5 shadow-[0_14px_36px_rgba(15,23,42,0.14)]">
      {options.map((option) => <button key={option.value} type="button" role="menuitem" onClick={() => { onChange(option.value); setOpen(false); window.requestAnimationFrame(() => triggerRef.current?.focus()); }} className="flex h-9 w-full items-center justify-between gap-4 rounded-lg px-3 text-left text-xs font-medium text-[#4f5a6d] hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"><span data-preserve-language={preserveOptionLanguage ? true : undefined}>{option.label}</span>{value === option.value && <Check className="size-3.5 text-blue-600" />}</button>)}
    </div>}
  </div>;
}

function isoDateInTimeZone(date: Date, timeZone: string): string {
  return procurementCalendarDate(date, timeZone);
}

function calendarDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function beginningOfQuarter(date: Date): Date {
  return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1, 12);
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function trendMeta(series: number[], favorableWhenDecrease: boolean) {
  if (series.length < 2) return { label: "数据不足", className: "bg-slate-100 text-slate-500" };
  const current = series.at(-1) ?? 0;
  const previous = series.at(-2) ?? 0;
  if (current === previous) return { label: "无变化", className: "bg-slate-100 text-slate-500" };
  if (previous === 0) {
    const favorable = favorableWhenDecrease ? current < previous : current > previous;
    return { label: "新增", className: favorable ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500" };
  }
  const percent = Math.round(Math.abs((current - previous) / previous) * 1_000) / 10;
  const rising = current > previous;
  const favorable = favorableWhenDecrease ? !rising : rising;
  return { label: `${rising ? "↗" : "↘"} ${percent}%`, className: favorable ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500" };
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div className="flex h-11 items-center border-b border-dashed border-slate-200 text-[10px] text-slate-400"><svg aria-label="已持久化采购组合快照趋势" className="sr-only" />保存至少 2 个快照后可查看趋势</div>;
  const width = 180;
  const height = 34;
  const min = Math.min(...values);
  const span = Math.max(1, Math.max(...values) - min);
  const points = values.map((value, index) => {
    const x = index / (values.length - 1) * width;
    const y = height - 5 - (value - min) / span * (height - 10);
    return `${x},${y}`;
  }).join(" ");
  return <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-11 w-full" aria-label="已持久化采购组合快照趋势"><polyline points={points} fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function MetricCard({ label, value, helper, icon: Icon, tone, series, favorableWhenDecrease = false }: {
  label: string; value: number; helper: string; icon: typeof AlertTriangle; tone: "red" | "redPlain" | "amber" | "blue" | "green";
  series: number[]; favorableWhenDecrease?: boolean;
}) {
  const palette = {
    red: { card: "border-red-200 bg-gradient-to-br from-red-50 to-white", icon: "bg-red-100 text-red-500", line: "#ef4444" },
    redPlain: { card: "border-slate-200 bg-white", icon: "bg-red-50 text-red-500", line: "#ef4444" },
    amber: { card: "border-slate-200 bg-white", icon: "bg-amber-50 text-amber-500", line: "#f59e0b" },
    blue: { card: "border-slate-200 bg-white", icon: "bg-blue-50 text-blue-600", line: "#3b82f6" },
    green: { card: "border-slate-200 bg-white", icon: "bg-emerald-50 text-emerald-600", line: "#16a34a" },
  }[tone];
  const trend = trendMeta(series, favorableWhenDecrease);
  return <article className={cn("rounded-3xl border p-5 pb-[22.5px] text-left shadow-[0_2px_10px_rgba(15,23,42,0.035)]", palette.card)}>
    <div className="flex items-center justify-between"><span className={cn("flex size-11 items-center justify-center rounded-full", palette.icon)}><Icon className="size-5" /></span><span className={cn("rounded-full px-2.5 py-1 text-[10px] font-semibold", trend.className)}>{trend.label}</span></div>
    <div className="mt-4"><div className="text-[30px] font-bold leading-none tracking-[-0.04em] text-[#111827]">{value}</div><div className="mt-2 text-[13px] font-medium text-[#27344a]">{label}</div><div className="mt-0.5 text-xs text-slate-400">{helper}</div></div>
    <div className="-mx-1 mt-3 h-11"><Sparkline values={series} color={palette.line} /></div>
  </article>;
}

function RiskBadge({ risk }: { risk: Risk }) {
  return <span className="inline-flex items-center gap-2 text-xs font-medium text-slate-600"><span className={cn("size-2 rounded-full", riskDot[risk])} />{riskLabels[risk]}</span>;
}

function RouteEvidenceActionCard({ unclassified, onReview }: { unclassified: number; onReview: () => void }) {
  return <aside className="hidden min-h-[313.875px] flex-col rounded-3xl border border-[#e5e9ef] bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)] xl:flex">
    <div className="relative h-[104px] overflow-hidden rounded-[18px] border border-blue-100 bg-[radial-gradient(circle_at_78%_28%,rgba(37,99,235,0.18),transparent_30%),linear-gradient(135deg,#f7faff_0%,#eef4ff_100%)]">
      <span className="absolute left-5 top-5 flex size-11 items-center justify-center rounded-2xl bg-white text-blue-600 shadow-[0_8px_24px_rgba(37,99,235,0.14)]"><ShoppingCart className="size-5" /></span>
      <span className="absolute bottom-5 left-[88px] flex items-center gap-2 rounded-full bg-white px-3 py-2 text-[11px] font-semibold text-amber-700 shadow-sm"><AlertTriangle className="size-3.5" />{unclassified} 张未分类</span>
      <span className="absolute right-5 top-5 flex size-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200"><ChevronRight className="size-4" /></span>
    </div>
    <h2 className="mt-5 text-base font-bold text-[#1f2937]">提前掌握，立即行动</h2>
    <p className="mt-2 text-xs leading-5 text-[#7c8595]">{unclassified > 0 ? `${unclassified} 张活跃采购订单缺少已持久化的路线证据；Readywork 不会根据供应商、币种或地址猜测本地或进口路线。` : "Readywork 会及早呈现已持久化的风险证据，帮助团队确保每张采购订单按计划推进。"}</p>
    <button type="button" onClick={onReview} className="mt-auto flex h-11 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 text-xs font-semibold text-white shadow-lg shadow-blue-200 hover:bg-blue-700">{unclassified > 0 ? "查看未分类采购订单" : "查看高风险采购订单"}<ChevronRight className="size-4" /></button>
  </aside>;
}

function PurchaseOrderActionMenu({ item, onView, onDraftFollowUp, onEditRihd, onMarkAtRisk }: {
  item: PortfolioItem;
  onView: () => void;
  onDraftFollowUp: () => void;
  onEditRihd: () => void;
  onMarkAtRisk: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    function closeFromOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
    document.addEventListener("mousedown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("mousedown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open]);

  function run(action: () => void) {
    setOpen(false);
    action();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index - 1 + items.length) % items.length : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next]?.focus();
  }

  return <div className="relative flex justify-end" onClick={(event) => event.stopPropagation()}>
    <button ref={triggerRef} type="button" aria-label={`${item.number} 操作`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((current) => !current)} className="flex size-7 items-center justify-center rounded-lg text-[#8a94a3] transition hover:bg-slate-100 hover:text-[#26364f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"><MoreHorizontal className="size-4" /></button>
    {open && <div ref={menuRef} role="menu" aria-label={`${item.number} 操作`} onKeyDown={handleKeyDown} className="absolute right-0 top-9 z-50 w-[176px] overflow-hidden rounded-xl border border-[#dfe4ec] bg-white p-1.5 shadow-[0_14px_36px_rgba(15,23,42,0.16)]">
      <button type="button" role="menuitem" onClick={() => run(onView)} className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-medium text-[#4f5a6d] hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"><ClipboardList className="size-3.5" />查看详情</button>
      <button type="button" role="menuitem" onClick={() => run(onDraftFollowUp)} className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-medium text-[#4f5a6d] hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"><Mail className="size-3.5 text-blue-600" />发送跟进</button>
      <button type="button" role="menuitem" onClick={() => run(onEditRihd)} className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-medium text-[#4f5a6d] hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"><CalendarDays className="size-3.5 text-blue-600" />编辑 RIHD</button>
      <div role="separator" className="my-1 border-t border-slate-100" />
      <button type="button" role="menuitem" onClick={() => run(onMarkAtRisk)} className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-xs font-medium text-red-600 hover:bg-red-50 focus:bg-red-50 focus:outline-none"><Pencil className="size-3.5" />标记为风险</button>
    </div>}
  </div>;
}

function matchesHighlight(item: PortfolioItem, code: HighlightCode | null): boolean {
  if (!code) return true;
  if (code === "supplier_no_response" || code === "approval_pending") return item.riskFactors.some((factor) => factor.code === code);
  if (code === "rihd_overdue") return item.overdueDays > 0;
  return item.stage === "fulfilment_production" && item.risk === "low";
}

export function ProcurementHomeDashboard({ onNavigate }: { onNavigate: (section: HomeSection, poId?: string, intent?: HomePurchaseOrderIntent) => void }) {
  const { preferences, formatDate, formatShortDateTime } = useProcurementLocale();
  const [data, setData] = useState<WorkbenchPayload | null>(null);
  const [history, setHistory] = useState<RiskHistory | null>(null);
  const [range, setRange] = useState(() => initialRange(preferences.timeZone));
  const [appliedRange, setAppliedRange] = useState(() => initialRange(preferences.timeZone));
  const [rangeOpen, setRangeOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => calendarDate(initialRange(preferences.timeZone).to));
  const [selectingRangeEnd, setSelectingRangeEnd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [route, setRoute] = useState<Route | "all">("all");
  const [materialType, setMaterialType] = useState("all");
  const [stage, setStage] = useState("all");
  const [risk, setRisk] = useState<Risk | "all">("all");
  const [supplierId, setSupplierId] = useState("all");
  const [routeRiskBucket, setRouteRiskBucket] = useState<PortfolioItem["routeRiskBucket"] | "all">("all");
  const [highlightCode, setHighlightCode] = useState<HighlightCode | null>(null);
  const [page, setPage] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const dateControlRef = useRef<HTMLDivElement | null>(null);
  const dateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dateDialogRef = useRef<HTMLElement | null>(null);
  const rangeTimeZoneRef = useRef(preferences.timeZone);
  const purchaseOrdersRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const [workbench, trend] = await Promise.all([
        apiRequest<WorkbenchPayload>("/api/procurement/workbench?limit=100", { signal: controller.signal }),
        apiRequest<RiskHistory>(`/api/procurement/risk-dashboard?from=${appliedRange.from}&to=${appliedRange.to}`, { signal: controller.signal }),
      ]);
      if (!controller.signal.aborted) { setData(workbench ?? {}); setHistory(trend); }
    } catch (requestError) {
      if (!controller.signal.aborted) setError(errorMessage(requestError));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [appliedRange.from, appliedRange.to]);

  useProcurementRealtimeRefresh(["pos", "outbox", "messages", "notifications"], () => void load(), 300);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => { window.clearInterval(timer); controllerRef.current?.abort(); };
  }, [load]);

  useEffect(() => {
    if (rangeTimeZoneRef.current === preferences.timeZone) return;
    rangeTimeZoneRef.current = preferences.timeZone;
    const nextRange = initialRange(preferences.timeZone);
    setRange(nextRange);
    setAppliedRange(nextRange);
    setCalendarMonth(calendarDate(nextRange.to));
    setSelectingRangeEnd(false);
    setRangeOpen(false);
  }, [preferences.timeZone]);

  useEffect(() => {
    function closeDateRange(event: MouseEvent) {
      if (dateControlRef.current?.contains(event.target as Node)) return;
      setRangeOpen(false);
    }
    function closeDateRangeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !dateDialogRef.current) return;
      event.preventDefault();
      setRange({ ...appliedRange });
      setRangeOpen(false);
      window.requestAnimationFrame(() => dateTriggerRef.current?.focus());
    }
    document.addEventListener("mousedown", closeDateRange);
    document.addEventListener("keydown", closeDateRangeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeDateRange);
      document.removeEventListener("keydown", closeDateRangeOnEscape);
    };
  }, [appliedRange]);

  useEffect(() => {
    if (!rangeOpen) return;
    dateDialogRef.current?.querySelector<HTMLButtonElement>('[data-quick-range]')?.focus();
  }, [rangeOpen]);

  function toggleDateRange() {
    setRangeOpen((current) => {
      if (!current) {
        setRange({ ...appliedRange });
        setCalendarMonth(calendarDate(appliedRange.to));
        setSelectingRangeEnd(false);
      }
      return !current;
    });
  }

  function closeDateRange() {
    setRange({ ...appliedRange });
    setRangeOpen(false);
    setSelectingRangeEnd(false);
    window.requestAnimationFrame(() => dateTriggerRef.current?.focus());
  }

  function chooseQuickRange(kind: "today" | "last7" | "last30" | "quarter" | "year") {
    const today = new Date();
    const to = isoDateInTimeZone(today, preferences.timeZone);
    const fromDate = kind === "today" ? today
      : kind === "last7" ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6, 12)
        : kind === "last30" ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29, 12)
          : kind === "quarter" ? beginningOfQuarter(today)
            : new Date(today.getFullYear(), 0, 1, 12);
    setRange({ from: isoDateInTimeZone(fromDate, preferences.timeZone), to });
    setCalendarMonth(new Date(today.getFullYear(), today.getMonth(), 1, 12));
    setSelectingRangeEnd(false);
  }

  function chooseCalendarDay(day: number) {
    const selectedDate = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day, 12);
    const value = isoDateInTimeZone(selectedDate, preferences.timeZone);
    if (!selectingRangeEnd) {
      setRange({ from: value, to: value });
      setSelectingRangeEnd(true);
      return;
    }
    setRange((current) => value < current.from ? { from: value, to: current.from } : { from: current.from, to: value });
    setSelectingRangeEnd(false);
  }

  function applyDateRange() {
    if (!range.from || !range.to) { setError("请选择完整的日期范围。"); return; }
    if (range.from > range.to) { setError("开始日期不能晚于结束日期。"); return; }
    setError(null);
    setAppliedRange({ ...range });
    setRangeOpen(false);
    setSelectingRangeEnd(false);
    window.requestAnimationFrame(() => dateTriggerRef.current?.focus());
  }

  const portfolio = data?.portfolio;
  const activeItems = useMemo(() => (portfolio?.items ?? []).filter((item) => item.active), [portfolio]);
  const suppliers = useMemo(() => [...new Map(activeItems.map((item) => [item.supplierId, item.supplierName])).entries()].sort((left, right) => left[1].localeCompare(right[1], "en")), [activeItems]);
  const materialTypes = useMemo(() => [...new Set(activeItems.map((item) => item.materialType))].sort((left, right) => left.localeCompare(right, "en")), [activeItems]);
  const routeOptions = useMemo<FilterOption<Route>[]>(() => [{ value: "local", label: "本地" }, { value: "import", label: "进口" }, { value: "unclassified", label: "未分类" }], []);
  const materialTypeOptions = useMemo<FilterOption<string>[]>(() => materialTypes.map((value) => ({ value, label: value })), [materialTypes]);
  const stageOptions = useMemo<FilterOption<string>[]>(() => Object.entries(stageLabels).map(([value, label]) => ({ value, label })), []);
  const riskOptions = useMemo<FilterOption<Risk>[]>(() => [{ value: "high", label: "高风险" }, { value: "medium", label: "中风险" }, { value: "low", label: "低风险" }], []);
  const supplierOptions = useMemo<FilterOption<string>[]>(() => suppliers.map(([value, label]) => ({ value, label })), [suppliers]);
  const filtersActive = route !== "all" || materialType !== "all" || stage !== "all" || risk !== "all" || supplierId !== "all" || routeRiskBucket !== "all" || highlightCode !== null;
  const filtered = useMemo(() => activeItems.filter((item) => {
    if (route !== "all" && item.route !== route) return false;
    if (materialType !== "all" && item.materialType !== materialType) return false;
    if (stage !== "all" && item.stage !== stage) return false;
    if (risk !== "all" && item.risk !== risk) return false;
    if (supplierId !== "all" && item.supplierId !== supplierId) return false;
    if (routeRiskBucket !== "all" && item.routeRiskBucket !== routeRiskBucket) return false;
    if (!matchesHighlight(item, highlightCode)) return false;
    const query = search.trim().toLowerCase();
    return !query || [item.number, item.supplierName, item.materialType].some((value) => value.toLowerCase().includes(query));
  }), [activeItems, highlightCode, materialType, risk, route, routeRiskBucket, search, stage, supplierId]);

  const metrics = portfolio?.metrics ?? emptyMetrics;
  const routes = portfolio?.routes ?? { local: emptyRoute, import: emptyRoute, unclassified: emptyRoute };
  const seriesFor = useCallback((key: MetricKey) => overviewMetricSeries({
    key,
    trend: history?.trend,
    freshness: history?.freshness,
    current: portfolio ? metrics : null,
  }), [history, metrics, portfolio]);

  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const paginationPages = pageCount <= 3
    ? Array.from({ length: pageCount }, (_, index) => index)
    : safePage <= 1
      ? [0, 1, pageCount - 1]
      : safePage >= pageCount - 2
        ? [0, pageCount - 2, pageCount - 1]
        : [0, safePage, pageCount - 1];
  useEffect(() => { setPage(0); }, [highlightCode, materialType, risk, route, routeRiskBucket, search, stage, supplierId]);

  function focusHighlight(code: HighlightCode) {
    setHighlightCode(code);
    window.requestAnimationFrame(() => {
      purchaseOrdersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      purchaseOrdersRef.current?.focus({ preventScroll: true });
    });
  }

  function focusHighRiskPurchaseOrders() {
    setHighlightCode(null);
    setRisk("high");
    window.requestAnimationFrame(() => {
      purchaseOrdersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      purchaseOrdersRef.current?.focus({ preventScroll: true });
    });
  }

  function focusUnclassifiedPurchaseOrders() {
    if (metrics.unclassifiedRoute <= 0) { focusHighRiskPurchaseOrders(); return; }
    setHighlightCode(null);
    setRoute("unclassified");
    window.requestAnimationFrame(() => {
      purchaseOrdersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      purchaseOrdersRef.current?.focus({ preventScroll: true });
    });
  }

  function openPurchaseOrder(purchaseOrderId: string) {
    onNavigate("orders", purchaseOrderId, "view");
  }

  function focusRouteRiskBucket(routeValue: Exclude<Route, "unclassified">, bucket: RouteRiskBucket) {
    setRoute(routeValue);
    setMaterialType("all");
    setStage("all");
    setRisk("all");
    setSupplierId("all");
    setRouteRiskBucket("all");
    setHighlightCode(null);
    const routeBucket = bucket === "high" ? "high_risk" : bucket === "awaitingSupplier" ? "awaiting_supplier" : bucket === "deliveryRisk" ? "delivery_risk" : "on_track";
    setRouteRiskBucket(routeBucket);
    window.requestAnimationFrame(() => {
      purchaseOrdersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      purchaseOrdersRef.current?.focus({ preventScroll: true });
    });
  }

  function clearFilters() {
    setRoute("all");
    setMaterialType("all");
    setStage("all");
    setRisk("all");
    setSupplierId("all");
    setRouteRiskBucket("all");
    setHighlightCode(null);
  }

  const monthStartOffset = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1, 12).getDay();
  const monthDayCount = daysInMonth(calendarMonth);
  const monthLabel = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", timeZone: preferences.timeZone }).format(calendarMonth);

  return <div className={cn(READYWORK_PAGE_CONTAINER_CLASS, "-mx-7 -mt-6 w-auto pb-12")}>
    <header className="relative z-30 flex h-[126.5px] flex-col justify-between gap-4 border-b border-[#e5e9ef] px-7 py-5 xl:flex-row xl:items-start">
      <div><h1 className={READYWORK_PAGE_TITLE_CLASS}>总览</h1><p className="mt-1.5 text-sm text-slate-500">跟踪和管理所有采购路线中的采购订单。</p></div>
      <div ref={dateControlRef} className="relative flex flex-wrap items-center gap-2 xl:mt-12">
        <button ref={dateTriggerRef} type="button" aria-expanded={rangeOpen} aria-haspopup="dialog" aria-label="选择总览趋势日期范围" disabled={!portfolio} onClick={toggleDateRange} className={cn("flex h-10 items-center gap-2 rounded-xl border bg-white px-3 text-xs font-semibold shadow-sm disabled:cursor-not-allowed disabled:opacity-60 xl:h-[38px] xl:w-[249px] xl:justify-center", rangeOpen ? "border-blue-300 text-blue-700" : "border-slate-200 text-slate-600")}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <CalendarDays className="size-4" />}
          <span className="whitespace-nowrap">{formatDate(appliedRange.from)} — {formatDate(appliedRange.to)}</span>
          <ChevronDown className={cn("size-3.5 transition-transform", rangeOpen && "rotate-180")} />
        </button>
        {rangeOpen && <section ref={dateDialogRef} role="dialog" aria-label="总览趋势日期范围" className="absolute right-0 top-[calc(100%+8px)] z-50 w-[620px] rounded-[16px] border border-[#dfe4ec] bg-white p-4 shadow-[0_18px_50px_rgba(31,42,68,0.16)]">
          <span className="sr-only">仅读取已持久化的快照趋势，不会创建新快照。</span>
          <div className="flex items-start gap-5">
            <div className="w-[150px] shrink-0 border-r border-[#edf0f4] pr-4"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#98a1af]">快捷范围</p><div className="space-y-1">
              {([{ key: "today", label: "今天" }, { key: "last7", label: "最近 7 天" }, { key: "last30", label: "最近 30 天" }, { key: "quarter", label: "本季度" }, { key: "year", label: "今年至今" }] as const).map((item) => <button data-quick-range type="button" key={item.key} onClick={() => chooseQuickRange(item.key)} className="h-9 w-full rounded-lg px-3 text-left text-xs font-medium text-[#566174] hover:bg-[#f3f6fb] focus:bg-blue-50 focus:text-blue-700 focus:outline-none">{item.label}</button>)}
            </div></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between"><button type="button" aria-label="上个月" onClick={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1, 12))} className="flex size-8 items-center justify-center rounded-lg text-[#748094] hover:bg-slate-100"><ChevronLeft className="size-4" /></button><div className="text-sm font-bold text-[#263146]">{monthLabel}</div><button type="button" aria-label="下个月" onClick={() => setCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1, 12))} className="flex size-8 items-center justify-center rounded-lg text-[#748094] hover:bg-slate-100"><ChevronRight className="size-4" /></button></div>
              <div className="mt-3 grid grid-cols-7 text-center text-[10px] font-semibold text-[#9aa3b1]">{["日", "一", "二", "三", "四", "五", "六"].map((day) => <span data-calendar-weekday key={day}>{day}</span>)}</div>
              <div role="grid" aria-label="月历" className="mt-2 grid grid-cols-7 gap-1">{Array.from({ length: monthStartOffset }, (_, index) => <span key={`blank-${index}`} />)}{Array.from({ length: monthDayCount }, (_, index) => {
                const day = index + 1;
                const value = isoDateInTimeZone(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day, 12), preferences.timeZone);
                const inRange = value >= range.from && value <= range.to;
                const edge = value === range.from || value === range.to;
                return <button key={day} type="button" role="gridcell" aria-label={`${monthLabel} ${day}`} aria-selected={inRange} onClick={() => chooseCalendarDay(day)} className={cn("flex size-9 items-center justify-center rounded-lg text-xs transition", edge ? "bg-blue-600 font-semibold text-white" : inRange ? "bg-blue-50 text-blue-700" : "text-[#526075] hover:bg-slate-100")}>{day}</button>;
              })}</div>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-[#edf0f4] pt-3"><div><div className="text-xs font-semibold text-[#4e5a6d]">{formatDate(range.from)} — {formatDate(range.to)}</div><div className="mt-1 text-[10px] text-[#8c96a5]">{history?.snapshotCount ?? 0} 个已保存快照 · PO 事实水位 {!portfolio?.generatedAt || portfolio.generatedAt === "1970-01-01T00:00:00.000Z" ? "不可用" : formatShortDateTime(portfolio.generatedAt)} · 风险评估 {history?.freshness.evaluatedAt ? formatShortDateTime(history.freshness.evaluatedAt) : "不可用"}</div></div><div className="flex gap-2"><button type="button" onClick={closeDateRange} className="h-9 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#657083]">取消</button><button type="button" onClick={applyDateRange} className="h-9 rounded-xl bg-[#2563eb] px-4 text-xs font-semibold text-white">应用</button></div></div>
        </section>}
      </div>
    </header>

    <div className="px-7 pt-6">

    {error && <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

    {!portfolio ? <section aria-label={loading ? "总览加载中" : "总览暂不可用"} aria-busy={loading} className="space-y-5">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => <div key={index} data-overview-loading-kpi className="h-[118px] animate-pulse rounded-3xl border border-[#e5e9ef] bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)]"><div className="h-3 w-20 rounded bg-slate-200" /><div className="mt-5 h-8 w-14 rounded bg-slate-200" /><div className="mt-3 h-2.5 w-24 rounded bg-slate-100" /></div>)}
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_336px]">
        <div data-overview-loading-panel className="h-[430px] animate-pulse rounded-3xl border border-[#e5e9ef] bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)]"><div className="h-4 w-28 rounded bg-slate-200" /><div className="mt-6 h-9 rounded-xl bg-slate-100" /><div className="mt-5 space-y-3">{Array.from({ length: 5 }, (_, index) => <div key={index} className="h-12 rounded-xl bg-slate-100" />)}</div></div>
        <div data-overview-loading-panel className="h-[430px] animate-pulse rounded-3xl border border-[#e5e9ef] bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)]"><div className="h-4 w-32 rounded bg-slate-200" /><div className="mt-8 space-y-4">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-16 rounded-2xl bg-slate-100" />)}</div></div>
      </div>
      <p className="sr-only">{loading ? "正在计算已持久化的采购订单组合。" : "总览数据暂不可用，请根据上方错误提示重试。"}</p>
    </section> : <>
    <section className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      <MetricCard label="高风险" value={metrics.highRisk} helper="需立即处理" icon={ShieldAlert} tone="red" series={seriesFor("highRisk")} favorableWhenDecrease />
      <MetricCard label="逾期采购订单" value={metrics.overdue} helper="已超过要求日期" icon={CalendarDays} tone="redPlain" series={seriesFor("overdue")} favorableWhenDecrease />
      <MetricCard label="需要关注" value={metrics.requireAttention} helper="需要采取行动" icon={Clock3} tone="amber" series={seriesFor("requireAttention")} favorableWhenDecrease />
      <MetricCard label="活跃采购订单" value={metrics.activePurchaseOrders} helper="覆盖所有路线" icon={ClipboardList} tone="blue" series={seriesFor("activePurchaseOrders")} />
      <MetricCard label="本地采购" value={metrics.localProcurement} helper="活跃采购订单" icon={ShoppingCart} tone="blue" series={seriesFor("localProcurement")} />
      <MetricCard label="进口采购" value={metrics.importProcurement} helper="活跃采购订单" icon={Globe2} tone="green" series={seriesFor("importProcurement")} />
    </section>

    <section className="mt-5 grid grid-cols-1 items-stretch gap-5 xl:grid-cols-[minmax(0,1fr)_336px]">
      <section ref={purchaseOrdersRef} tabIndex={-1} aria-label="采购订单筛选结果" className="min-w-0 overflow-hidden rounded-3xl border border-[#e5e9ef] bg-white shadow-[0_2px_10px_rgba(15,23,42,0.03)] outline-none">
        <div className="flex flex-col gap-3 p-5 pb-4 xl:flex-row xl:items-center xl:justify-between">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#1f2937]">采购订单</h2>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative w-[230px]"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 PO 编号、供应商…" className="h-9 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-[13px] outline-none focus:border-blue-400" /></label>
            <OverviewFilterMenu label="路线" value={route} options={routeOptions} onChange={setRoute} />
            <OverviewFilterMenu label="物料类型" value={materialType} options={materialTypeOptions} onChange={setMaterialType} preserveOptionLanguage />
            <OverviewFilterMenu label="阶段" value={stage} options={stageOptions} onChange={setStage} />
            <OverviewFilterMenu label="风险" value={risk} options={riskOptions} onChange={setRisk} />
            <OverviewFilterMenu label="供应商" value={supplierId} options={supplierOptions} onChange={setSupplierId} preserveOptionLanguage />
            {filtersActive && <button type="button" onClick={clearFilters} className="h-9 rounded-xl px-2 text-[13px] font-semibold text-blue-600 hover:bg-blue-50">清除</button>}
            {highlightCode && <button type="button" onClick={() => setHighlightCode(null)} className="flex h-9 items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 text-[13px] font-semibold text-blue-700 hover:bg-blue-100"><span>摘要筛选：{highlightLabels[highlightCode]}</span><span aria-hidden="true">×</span><span className="sr-only">清除摘要筛选</span></button>}
          </div>
        </div>
        <div className="overflow-x-auto"><table className="w-full min-w-[960px] border-collapse text-left"><thead><tr className="border-y border-slate-200 bg-[#fafbfc] text-[11px] font-semibold uppercase leading-[16.5px] tracking-[0.08em] text-slate-400"><th className="whitespace-nowrap px-5 py-3">PO 编号</th><th className="whitespace-nowrap px-5 py-3">供应商</th><th className="whitespace-nowrap px-5 py-3">路线</th><th className="whitespace-nowrap px-5 py-3">物料类型</th><th className="whitespace-nowrap px-5 py-3">当前阶段</th><th className="whitespace-nowrap px-5 py-3">要求到货日期（RIHD）</th><th className="whitespace-nowrap px-5 py-3">风险</th><th className="whitespace-nowrap px-5 py-3">下一步操作</th><th className="w-[52px] px-3 py-3"><span className="sr-only">操作</span></th></tr></thead><tbody>{visible.map((item, index) => <tr key={item.id} onClick={() => openPurchaseOrder(item.id)} className={cn("cursor-pointer border-b border-slate-100 text-[13px] leading-[19.5px] text-slate-600 hover:bg-blue-50/30", index % 2 === 1 && "bg-slate-50/40")}><td className="whitespace-nowrap px-5 py-[14px] font-semibold text-[#1f2937]"><button type="button" onClick={(event) => { event.stopPropagation(); openPurchaseOrder(item.id); }} aria-label={`打开采购订单 ${item.number} 的执行上下文`} className="rounded-sm text-left font-semibold text-[#1f2937] underline-offset-4 hover:text-blue-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">{item.number}</button></td><td data-preserve-language className="max-w-[210px] truncate px-5 py-[14px]">{item.supplierName}</td><td className="px-5 py-[14px]"><span className={cn("inline-flex whitespace-nowrap rounded-full px-2.5 py-1 font-medium", item.route === "local" ? "bg-blue-50 text-blue-600" : item.route === "import" ? "bg-violet-50 text-violet-600" : "bg-slate-100 text-slate-500")}>{routeLabels[item.route]}</span></td><td data-preserve-language className="max-w-[180px] truncate px-5 py-[14px]">{item.materialType}</td><td className="px-5 py-[14px]"><span data-preserve-language={stageLabels[item.stage] ? undefined : true} className="inline-flex whitespace-nowrap rounded-full bg-sky-50 px-2.5 py-1 font-medium text-sky-600">{stageLabels[item.stage] ?? item.stageLabel}</span></td><td className={cn("whitespace-nowrap px-5 py-[14px]", item.overdueDays > 0 && "font-semibold text-red-500")}>{formatDate(item.requiredInHouseAt, "未设置")}{item.overdueDays > 0 && <span className="ml-2 rounded-full bg-red-50 px-2 py-1 text-[10px]">逾期 {item.overdueDays} 天</span>}</td><td className="px-5 py-[14px]"><RiskBadge risk={item.risk} /></td><td className="whitespace-nowrap px-5 py-[14px] text-slate-500"><span data-preserve-language={nextActionLabels[item.nextAction] ? undefined : true}>{nextActionLabels[item.nextAction] ?? item.nextAction}</span></td><td className="px-3 py-[14px]"><PurchaseOrderActionMenu item={item} onView={() => openPurchaseOrder(item.id)} onDraftFollowUp={() => onNavigate("message-drafts", item.id)} onEditRihd={() => onNavigate("orders", item.id, "edit-rihd")} onMarkAtRisk={() => onNavigate("orders", item.id, "mark-at-risk")} /></td></tr>)}{!visible.length && <tr><td colSpan={9} className="px-6 py-16 text-center text-sm text-slate-400">没有符合当前筛选条件的已持久化采购订单。</td></tr>}</tbody></table></div>
        <div className="flex flex-col gap-3 px-5 py-4 text-[13px] text-slate-400 sm:flex-row sm:items-center sm:justify-between"><span>显示第 {filtered.length ? safePage * pageSize + 1 : 0} 至 {Math.min((safePage + 1) * pageSize, filtered.length)} 条，共 {filtered.length} 条记录</span><div className="flex items-center gap-2"><button type="button" aria-label="上一页" disabled={safePage <= 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="flex h-8 min-w-8 items-center justify-center rounded-lg border border-slate-200 px-2.5 disabled:pointer-events-none disabled:opacity-40"><ChevronLeft className="size-4" /></button>{paginationPages.map((pageIndex, index) => <span key={pageIndex} className="contents">{index > 0 && pageIndex - paginationPages[index - 1]! > 1 && <span aria-hidden="true" className="px-0.5">…</span>}<button data-overview-page type="button" aria-current={pageIndex === safePage ? "page" : undefined} onClick={() => setPage(pageIndex)} className={cn("flex h-8 min-w-8 items-center justify-center rounded-lg px-2.5 font-medium", pageIndex === safePage ? "bg-blue-600 text-white" : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}>{pageIndex + 1}</button></span>)}<button type="button" aria-label="下一页" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} className="flex h-8 min-w-8 items-center justify-center rounded-lg border border-slate-200 px-2.5 disabled:pointer-events-none disabled:opacity-40"><ChevronRight className="size-4" /></button></div></div>
      </section>

      <aside className="flex h-full flex-col rounded-3xl border border-[#e5e9ef] bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)]"><div className="flex items-center gap-2.5"><span className="flex size-8 items-center justify-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200"><Sparkles className="size-4" /></span><h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#1f2937]">AI 采购摘要</h2></div><div className="mt-6 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">今日重点</div><div className="mt-4 space-y-3">{(portfolio?.highlights ?? []).slice(0, 5).map((item) => <button type="button" key={item.code} onClick={() => focusHighlight(item.code)} aria-pressed={highlightCode === item.code} className={cn("flex w-full items-start gap-3 rounded-2xl border p-3 text-left", highlightCode === item.code ? "border-blue-300 bg-blue-50" : "border-slate-100 bg-[#fbfcfe] hover:border-blue-200")}><span className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full", item.severity === "high" ? "bg-red-50 text-red-500" : item.severity === "medium" ? "bg-amber-50 text-amber-500" : "bg-emerald-50 text-emerald-600")}>{item.severity === "high" ? <CircleAlert className="size-4" /> : item.severity === "medium" ? <UsersRound className="size-4" /> : <Factory className="size-4" />}</span><span className="text-xs font-medium leading-5 text-slate-700">{highlightMessage(item)}</span></button>)}{!portfolio?.highlights?.length && <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-10 text-center text-xs text-slate-400">没有需要汇总的已持久化采购组合风险。</div>}</div><button type="button" onClick={focusHighRiskPurchaseOrders} className="mt-auto flex h-12 items-center justify-center gap-2 rounded-2xl bg-blue-600 text-sm font-semibold text-white shadow-lg shadow-blue-200 hover:bg-blue-700">查看高风险采购订单 <ChevronRight className="size-4" /></button></aside>

      <section className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2"><RouteRiskOverview label="本地采购" summary={routes.local} density="compact" onSelectBucket={(bucket) => focusRouteRiskBucket("local", bucket)} /><RouteRiskOverview label="进口采购" summary={routes.import} density="compact" onSelectBucket={(bucket) => focusRouteRiskBucket("import", bucket)} /></section>
      <RouteEvidenceActionCard unclassified={metrics.unclassifiedRoute} onReview={focusUnclassifiedPurchaseOrders} />
    </section>

    {metrics.unclassifiedRoute > 0 && <div className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800 xl:hidden"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{metrics.unclassifiedRoute} 张活跃采购订单缺少已持久化的路线证据。Readywork 不会猜测本地或进口路线；请在 ERP 映射或配置中补全路线字段。</span></div>}
    </>}
    </div>
  </div>;
}
