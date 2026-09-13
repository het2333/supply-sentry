"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, ChevronRight, ClipboardCheck, FileText, Hourglass, Loader2, RefreshCw, ShieldAlert, UserRound, X, PackageCheck, ReceiptText, Clock3, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { READYWORK_PAGE_TITLE_CLASS } from "@/features/procurement/visual-tokens";

type Mode = "my-work" | "payables" | "logistics";
type Source = "task" | "approval" | "exception" | "odoo";
type Action = "approve" | "reject" | "reassign";
type DecisionFilter = "all" | "approval" | "exception" | "urgent";
type WorkItem = {
  id: string; source: Source; title?: string; name?: string; status?: string; message?: string;
  aiJudgment?: string; recommendedAction?: string; objectId?: string; objectType?: string;
  requestedAt?: string; createdAt?: string; taskId?: string; approvalId?: string;
  updatedAt?: string; actor?: string; severity?: string; risk?: string; waitHours?: number;
  workflowId?: string; businessObjectId?: string; aiAction?: string;
  trajectory?: Array<Record<string, unknown>>;
  payload?: Record<string, unknown>; [key: string]: unknown;
};
type ContextDetail = {
  requisitions?: Record<string, unknown>[]; rfqs?: Record<string, unknown>[]; quotes?: Record<string, unknown>[];
  awards?: Record<string, unknown>[]; comparisons?: Record<string, unknown>[]; suppliers?: Record<string, unknown>[];
  purchaseOrders?: Record<string, unknown>[]; confirmations?: Record<string, unknown>[]; shipments?: Record<string, unknown>[];
  receipts?: Record<string, unknown>[]; invoices?: Record<string, unknown>[]; matches?: Record<string, unknown>[];
  communications?: Record<string, unknown>[]; activities?: Record<string, unknown>[];
  attachments?: Attachment[];
};
type Attachment = { id?: string; fileName?: string; contentType?: string; sizeBytes?: number; url?: string; sourceDocumentId?: string };

const values = (payload: unknown): Record<string, unknown>[] => {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  if (payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown[] }).items)) return values((payload as { items: unknown[] }).items);
  return [];
};
const textOf = (item: WorkItem) => Object.entries(item).filter(([key]) => key !== "payload").map(([key, value]) => `${key} ${String(value)}`).join(" ").toLowerCase();
const label = (item: WorkItem) => item.title ?? item.name ?? item.message ?? item.id ?? "未命名事项";
const payloadRecord = (item: WorkItem, key: string): Record<string, unknown> | undefined => { const value = item.payload?.[key]; return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; };
const payloadItems = (item: WorkItem, key: string): Record<string, unknown>[] => { const value = item.payload?.[key]; if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object")); const record = payloadRecord(item, key); return record ? [record] : []; };
const itemText = (value: unknown, fallback = "未提供") => typeof value === "string" && value.trim() ? value : fallback;
function BusinessText({ value, fallback = "未提供", localize = false }: { value: unknown; fallback?: string; localize?: boolean }) {
  return <span data-preserve-language={!localize && typeof value === "string" && value.trim() ? true : undefined}>{itemText(value, fallback)}</span>;
}
const safeAttachmentUrl = (value?: string) => {
  const url = value?.trim();
  if (!url) return undefined;
  if (url.startsWith("/") && !url.startsWith("//")) return { href: url, inline: true } as const;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (parsed.username || parsed.password) return undefined;
    return { href: parsed.href, inline: false } as const;
  } catch { return undefined; }
};
const formatBytes = (value?: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB` : "大小未提供";
const tone = (status?: string): "red" | "amber" | "blue" | "violet" | "neutral" => status === "failed" || status === "open" ? "red" : status === "waiting_approval" || status === "pending" ? "violet" : status === "assigned" ? "amber" : status ? "blue" : "neutral";
const terminalTaskStatuses = new Set(["completed", "failed", "cancelled"]);
const humanDecisionTaskStatuses = new Set(["waiting_approval", "waiting_human"]);
const isVisualAcceptance = (item: WorkItem) => item.id.startsWith("visual-test:") || String(item.actor ?? "") === "visual-test";
const needsHumanDecision = (item: WorkItem) => !isVisualAcceptance(item) && (item.source === "approval" || item.source === "exception" || item.source === "odoo" || humanDecisionTaskStatuses.has(String(item.status ?? "")));
const isUrgent = (item: WorkItem) => String(item.severity ?? item.risk ?? "").toLowerCase() === "high" || Number(item.waitHours ?? 0) >= 24;
const completedAt = (item: WorkItem): string | undefined => {
  const trajectory = Array.isArray(item.trajectory) ? item.trajectory : [];
  const completed = trajectory.findLast((event) => event && typeof event === "object" && (event as Record<string, unknown>).type === "task.completed") as Record<string, unknown> | undefined;
  return typeof completed?.at === "string" ? completed.at : typeof item.updatedAt === "string" ? item.updatedAt : item.createdAt;
};
const category = (item: WorkItem): "payables" | "logistics" | "unknown" => {
  const text = `${textOf(item)} ${JSON.stringify(item.payload ?? {})}`.toLowerCase();
  const type = String(item.objectType ?? item.type ?? "").toLowerCase();
  if (/invoice|发票|three.?way|三单|ap\b|payable|应付|vendor.?bill|bill|price.?variance|quantity.?variance/.test(`${type} ${text}`)) return "payables";
  if (/purchase.?order|\bpo\b|采购订单|shipment|物流|receipt|收货|delivery|交付|交期|delay/.test(`${type} ${text}`)) return "logistics";
  return "unknown";
};

function normalize(source: Source, raw: Record<string, unknown>, index: number): WorkItem {
  const id = String(raw.id ?? `${source}-${index}`);
  const payload = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload as Record<string, unknown> : undefined;
  return { ...raw, id, source, payload, approvalId: source === "approval" ? id : String(raw.approvalId ?? "") || undefined, taskId: String(raw.taskId ?? "") || undefined };
}

function Preview({ title, icon: Icon, items, empty }: { title: string; icon: typeof PackageCheck; items: Record<string, unknown>[]; empty: string }) {
  return <div className="rounded-xl border border-slate-200 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-slate-700"><Icon className="size-3.5 text-slate-400" />{title}</div>{items.length ? <div className="mt-2 space-y-2">{items.slice(0, 3).map((item, index) => <div key={String(item.id ?? index)} className="rounded-lg bg-slate-50 p-2 text-xs"><div className="truncate font-medium text-slate-800"><BusinessText value={item.title ?? item.name ?? item.displayNumber ?? item.number ?? item.invoiceNumber ?? item.externalId ?? item.id} /></div><div className="mt-1 truncate text-slate-500"><BusinessText localize={typeof item.status === "string" && ["pending", "open", "assigned", "approved", "rejected", "completed", "failed", "cancelled", "waiting_approval", "waiting_human", "running", "sent", "confirmed", "received"].includes(item.status)} value={item.status ?? item.supplierName ?? item.supplierId ?? item.currency} /></div></div>)}</div> : <div className="mt-2 text-xs text-slate-400">{empty}</div>}</div>;
}

function AttachmentPreview({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return <div className="mt-2 text-xs text-slate-400">暂无真实附件</div>;
  return <div className="mt-3 space-y-3">{attachments.map((attachment, index) => {
    const link = safeAttachmentUrl(attachment.url);
    const url = link?.href;
    const contentType = attachment.contentType?.toLowerCase() ?? "";
    const isImage = contentType.startsWith("image/");
    const isPdf = contentType === "application/pdf";
    return <div key={attachment.id ?? `${attachment.fileName ?? "attachment"}-${index}`} className="rounded-lg border border-slate-200 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0"><div className="truncate text-xs font-medium text-slate-800"><BusinessText value={attachment.fileName} fallback="未命名附件" /></div><div className="mt-1 text-[11px] text-slate-500">{itemText(attachment.contentType, "类型未提供")} · {formatBytes(attachment.sizeBytes)}</div></div>{url && (!link.inline || (!isImage && !isPdf)) && <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="shrink-0 text-xs text-emerald-700 underline">安全打开</a>}</div>{url && link.inline && isImage ? <Image data-preserve-language={attachment.fileName ? true : undefined} src={url} alt={itemText(attachment.fileName, "附件预览")} width={960} height={640} unoptimized referrerPolicy="no-referrer" className="mt-3 max-h-64 w-full rounded-lg border border-slate-100 object-contain" /> : url && link.inline && isPdf ? <iframe data-preserve-language={attachment.fileName ? true : undefined} title={itemText(attachment.fileName, "PDF 附件")} src={url} sandbox="allow-same-origin" referrerPolicy="no-referrer" className="mt-3 h-64 w-full rounded-lg border border-slate-200" /> : <div className="mt-2 text-xs text-slate-400">{!attachment.url ? "暂无可访问 URL，无法预览。" : !url ? "附件 URL 不安全，已阻止打开。" : !link.inline ? "外部附件不会自动加载，以避免跨域泄露；请显式安全打开。" : "附件类型不支持内嵌预览，已提供安全打开链接。"}</div>}</div>;
  })}</div>;
}

export function ProcurementOperations({ mode, onNavigate }: { mode: Mode; onNavigate?: (section: "ai-records" | "orders" | "payables") => void }) {
  const { formatShortDateTime: timeLabel } = useProcurementLocale();
  const [queue, setQueue] = useState<WorkItem[]>([]);
  const [taskHistory, setTaskHistory] = useState<WorkItem[]>([]);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [confirming, setConfirming] = useState<{ item: WorkItem; action: Action } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const detailRequestRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++sequenceRef.current;
    setLoading(true); setError(null);
    const paths = ["/api/tasks", "/api/approvals/pending", "/api/exceptions", "/api/odoo/exceptions", "/api/odoo/invoices"] as const;
    try {
      const results = await Promise.allSettled(paths.map((path) => apiRequest<unknown>(path, { signal: controller.signal })));
      if (controller.signal.aborted || sequence !== sequenceRef.current) return;
      const merged: WorkItem[] = []; const allTasks: WorkItem[] = []; const successful: string[] = []; const failed: unknown[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          successful.push(paths[index]);
          const payload = result.value && typeof result.value === "object" ? result.value as Record<string, unknown> : {};
          const rawItems = index === 3 ? values(payload.exceptions) : index === 4 ? values(payload.invoices).filter((item) => String(item.match ?? "").toLowerCase() === "variance") : values(result.value);
          rawItems.forEach((raw, itemIndex) => {
            const sourceType: Source = index === 0 ? "task" : index === 1 ? "approval" : index === 2 ? "exception" : "odoo";
            const normalizedRaw = index === 3 ? {
              ...raw,
              id: `odoo-delivery:${String(raw.title ?? itemIndex).replace(/^交期已逾期\s*/, "")}`,
              status: "open",
              severity: String(raw.priority ?? "").toLowerCase() === "high" ? "high" : "medium",
              objectId: String(raw.title ?? "").replace(/^交期已逾期\s*/, "") || undefined,
              objectType: "purchase_order",
              aiJudgment: raw.note,
              recommendedAction: "核对实际到货状态；未到货时进入采购订单工作台发起催交。",
              payload: { supplier: raw.supplier, promisedDelivery: raw.due, sourceSystem: "Odoo", sourceStatus: raw.status },
            } : index === 4 ? {
              ...raw,
              id: `odoo-invoice-variance:${String(raw.id ?? itemIndex)}`,
              title: `发票 ${String(raw.id ?? "")} 金额差异`,
              status: "open",
              severity: "medium",
              objectId: raw.id,
              objectType: "invoice",
              aiJudgment: `${String(raw.reason ?? "发现发票金额差异")}；关联采购订单 ${String(raw.po ?? "未提供")}。`,
              recommendedAction: "进入发票与应付工作台，核对 PO、收货和发票金额后再决定。",
              payload: { supplier: raw.supplier, purchaseOrder: raw.po, invoiceAmount: raw.amount, invoiceDate: raw.date, sourceSystem: "Odoo" },
            } : raw;
            const item = normalize(sourceType, normalizedRaw, itemIndex);
            if (item.source === "task") allTasks.push(item);
            if (item.source === "task" && terminalTaskStatuses.has(String(item.status ?? ""))) return;
            merged.push(item);
          });
        } else if (!(result.reason instanceof ReadyworkApiError && result.reason.status === 499)) failed.push(result.reason);
      });
      const exceptionApprovalIds = new Set(merged.filter((item) => item.source === "exception" && item.approvalId).map((item) => item.approvalId!));
      const approvalTaskIds = new Set(merged.filter((item) => item.source === "approval" && item.taskId).map((item) => item.taskId!));
      const deduped = Array.from(new Map(merged
        .filter((item) => !(item.source === "approval" && exceptionApprovalIds.has(item.id)))
        .filter((item) => !(item.source === "task" && approvalTaskIds.has(item.id)))
        .map((item) => [`${item.source}:${item.id}`, item])).values());
      setQueue(deduped); setTaskHistory(allTasks); setSource(successful.join("、"));
      if (!successful.length) {
        const first = failed[0];
        setError(first instanceof ReadyworkApiError && first.status === 403 ? "当前会话没有读取该工作区的权限。" : first instanceof ReadyworkApiError && first.status === 408 ? "请求超时，请稍后重试。" : "真实业务接口暂时不可用，请稍后重试。");
      } else if (failed.length) setError("部分业务接口暂时不可用，以下仅显示已成功读取的真实事项。");
      setSelected((current) => current && deduped.some((item) => item.source === current.source && item.id === current.id) ? deduped.find((item) => item.source === current.source && item.id === current.id) ?? current : null);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted && sequence === sequenceRef.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load]);

  const decisionQueue = useMemo(() => queue.filter(needsHumanDecision), [queue]);
  const visible = useMemo(() => mode === "my-work"
    ? decisionQueue.filter((item) => decisionFilter === "all" ? true : decisionFilter === "approval" ? item.source === "approval" || item.status === "waiting_approval" : decisionFilter === "exception" ? item.source === "exception" || item.source === "odoo" : isUrgent(item))
    : queue.filter((item) => category(item) === mode), [decisionFilter, decisionQueue, mode, queue]);
  const selectedInView = selected && visible.some((item) => item.source === selected.source && item.id === selected.id) ? selected : null;
  const activeSelected = mode === "my-work" ? selectedInView : selectedInView ?? visible[0] ?? null;
  useEffect(() => {
    detailRequestRef.current?.abort();
    setDetail(null); setDetailError(null);
    if (!activeSelected) return;
    const controller = new AbortController();
    detailRequestRef.current = controller;
    setDetailLoading(true);
    void apiRequest<ContextDetail>(`/api/procurement/workbench/context/${encodeURIComponent(activeSelected.objectId ?? activeSelected.taskId ?? activeSelected.id)}`, { signal: controller.signal })
      .then((payload) => { if (!controller.signal.aborted) setDetail(payload); })
      .catch((cause) => { if (!controller.signal.aborted && !(cause instanceof ReadyworkApiError && cause.status === 499)) setDetailError(cause instanceof ReadyworkApiError && cause.status === 404 ? "该事项尚未关联采购单据上下文。" : "业务上下文读取失败，请刷新重试。"); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [activeSelected]);
  const actionFor = (item: WorkItem): Action[] => item.source === "approval" && item.taskId ? ["approve", "reject"] : item.source === "exception" ? item.approvalId ? ["approve", "reject", "reassign"] : ["reassign"] : [];
  const actionLabel: Record<Action, string> = { approve: "批准", reject: "驳回", reassign: "转交给我" };
  const runAction = useCallback(async () => {
    if (!confirming || submitting) return;
    const { item, action } = confirming;
    setSubmitting(true); setActionError(null);
    try {
      if (item.source === "approval" && item.taskId) await apiRequest(`/api/tasks/${encodeURIComponent(item.taskId)}/${action}`, { method: "POST", body: { approvalId: item.approvalId ?? item.id } });
      else if (item.source === "exception") await apiRequest(`/api/exceptions/${encodeURIComponent(item.id)}/${action}`, { method: "POST", body: {} });
      else return;
      setConfirming(null); await load();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "操作提交失败，请稍后重试"); }
    finally { setSubmitting(false); }
  }, [confirming, load, submitting]);

  const heading = mode === "payables" ? "发票与应付" : mode === "logistics" ? "物流与交付" : "待我处理";
  const subheading = mode === "payables" ? "仅显示有发票、三单或应付类型标识的事项" : mode === "logistics" ? "仅显示有 PO、物流、收货或交付类型标识的事项" : "需要人工确认的采购事项；无法归类的事项仍保留在这里";
  const context = useMemo(() => activeSelected?.payload ? Object.entries(activeSelected.payload).filter(([, value]) => value !== null && value !== undefined && typeof value !== "object").slice(0, 8) : [], [activeSelected]);
  const requisitions = detail?.requisitions ?? [];
  const rfqs = detail?.rfqs ?? [];
  const quotes = detail?.quotes ?? [];
  const awards = detail?.awards ?? [];
  const suppliers = detail?.suppliers ?? [];
  const purchaseOrders = activeSelected ? payloadItems(activeSelected, "purchaseOrders").concat(payloadItems(activeSelected, "purchaseOrder"), detail?.purchaseOrders ?? []) : [];
  const receipts = activeSelected ? payloadItems(activeSelected, "receipts").concat(payloadItems(activeSelected, "receipt"), detail?.receipts ?? []) : [];
  const invoices = activeSelected ? payloadItems(activeSelected, "invoices").concat(payloadItems(activeSelected, "invoice"), detail?.invoices ?? []) : [];
  const activities = activeSelected ? payloadItems(activeSelected, "activities").concat(payloadItems(activeSelected, "timeline"), detail?.activities ?? []).filter((activity) => !String(activity.id ?? "").startsWith("activity:visual-test:") && String(activity.actor ?? "") !== "visual-test") : [];
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  const recentCompleted = taskHistory
    .filter((item) => item.status === "completed" && new Date(completedAt(item) ?? 0).getTime() >= sevenDaysAgo)
    .sort((left, right) => new Date(completedAt(right) ?? 0).getTime() - new Date(completedAt(left) ?? 0).getTime());
  const waitingExternal = taskHistory.filter((item) => item.status === "waiting_external");
  const runningTasks = taskHistory.filter((item) => item.status === "running" || item.status === "queued");
  const decisionFilters: Array<{ id: DecisionFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: decisionQueue.length },
    { id: "approval", label: "待审批", count: decisionQueue.filter((item) => item.source === "approval" || item.status === "waiting_approval").length },
    { id: "exception", label: "异常", count: decisionQueue.filter((item) => item.source === "exception" || item.source === "odoo").length },
    { id: "urgent", label: "即将超时", count: decisionQueue.filter(isUrgent).length },
  ];

  if (mode === "my-work") return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><div className="text-xs font-medium text-[#4d7969]">采购执行 · 人工决策中心</div><h1 className={`mt-1 ${READYWORK_PAGE_TITLE_CLASS}`}>待我处理</h1><p className="mt-1 text-sm text-slate-500">这里只显示需要你判断或批准的采购事项。</p></div>
      <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />{loading ? "检查中" : "刷新"}</Button>
    </div>
    {error && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">{error}</div>}
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {[
        { label: "需要我决策", value: decisionQueue.length, icon: ShieldAlert, color: "bg-rose-50 text-rose-600" },
        { label: "即将超时", value: decisionQueue.filter(isUrgent).length, icon: Clock3, color: "bg-amber-50 text-amber-600" },
        { label: "近 7 日已处理", value: recentCompleted.length, icon: CheckCircle2, color: "bg-emerald-50 text-emerald-600" },
        { label: "AI 正在执行", value: runningTasks.length, icon: Zap, color: "bg-sky-50 text-sky-600" },
      ].map(({ label: metricLabel, value, icon: Icon, color }) => <div key={metricLabel} className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]"><div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-500">{metricLabel}</span><span className={`flex size-8 items-center justify-center rounded-xl ${color}`}><Icon className="size-4" /></span></div><div className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950">{value}</div></div>)}
    </div>
    <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3">
      {decisionFilters.map((filter) => <button type="button" key={filter.id} onClick={() => setDecisionFilter(filter.id)} className={`rounded-lg px-3 py-2 text-xs font-medium transition ${decisionFilter === filter.id ? "bg-slate-950 text-white" : "bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-900"}`}>{filter.label}<span className={`ml-1.5 ${decisionFilter === filter.id ? "text-white/60" : "text-slate-400"}`}>{filter.count}</span></button>)}
    </div>
    {loading && !taskHistory.length && !queue.length ? <div className="flex min-h-[420px] items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />正在检查需要人工决策的事项…</div> : visible.length === 0 ? <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white px-6 py-10 text-center shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><CheckCircle2 className="size-7" /></div>
        <h2 className="mt-4 text-xl font-semibold tracking-tight text-slate-900">当前没有需要你决定的事项</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">AI 会继续处理订单、询价和应付任务；出现超权限或高风险情况时，会在这里通知你。</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2"><Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />重新检查</Button>{onNavigate && <Button variant="outline" onClick={() => onNavigate("ai-records")}>查看 AI 工作记录<ArrowRight className="size-4" /></Button>}</div>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,0.8fr)]">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><h2 className="text-sm font-semibold text-slate-900">最近完成</h2><p className="mt-1 text-xs text-slate-400">真实任务完成记录</p></div><span className="text-xs text-slate-400">近 7 日 {recentCompleted.length} 项</span></div>
          {recentCompleted.length ? <div>{recentCompleted.slice(0, 5).map((item, index) => <div key={item.id} className={`flex items-start gap-3 px-5 py-4 ${index > 0 ? "border-t border-slate-100" : ""}`}><span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><Check className="size-4" /></span><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold text-slate-800">{item.aiJudgment ?? item.aiAction ?? label(item)}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400"><span>{item.businessObjectId ? `关联 ${String(item.businessObjectId)}` : item.workflowId ? String(item.workflowId) : "采购任务"}</span><span>{timeLabel(completedAt(item))}</span></div></div><Badge tone="blue">已完成</Badge></div>)}</div> : <div className="px-5 py-10 text-center text-sm text-slate-400">近 7 日暂无真实完成记录</div>}
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]"><h2 className="text-sm font-semibold text-slate-900">系统仍在关注</h2><div className="mt-4 space-y-3"><div className="flex items-center justify-between rounded-xl bg-amber-50 px-4 py-3"><div className="flex items-center gap-2 text-sm text-amber-800"><Hourglass className="size-4" />等待外部回复</div><span className="font-semibold text-amber-800">{waitingExternal.length}</span></div><div className="flex items-center justify-between rounded-xl bg-sky-50 px-4 py-3"><div className="flex items-center gap-2 text-sm text-sky-800"><Zap className="size-4" />AI 正在执行</div><span className="font-semibold text-sky-800">{runningTasks.length}</span></div></div><p className="mt-4 text-xs leading-5 text-slate-400">状态变化会自动进入真实任务、异常或审批队列。</p></div>
      </div>
    </div> : <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><div><div className="text-sm font-semibold text-slate-900">决策队列</div><div className="mt-1 text-xs text-slate-400">每个事项独占一行，点击后在行内查看完整上下文</div></div><span className="text-xs text-slate-400">共 {visible.length} 项</span></div>
      <div className="hidden grid-cols-[minmax(0,1fr)_150px_110px_190px] gap-4 border-b border-slate-100 bg-slate-50/70 px-5 py-2.5 text-[11px] font-medium text-slate-400 md:grid"><span>待处理事项</span><span>关联对象</span><span>状态</span><span className="text-right">操作</span></div>
      <div>{visible.map((item, index) => {
        const isActive = activeSelected?.source === item.source && activeSelected.id === item.id;
        const supplier = itemText(item.payload?.supplier, "");
        const businessObject = String(item.objectId ?? item.taskId ?? "采购事项");
        return <div key={`${item.source}:${item.id}`} className={index > 0 ? "border-t border-slate-100" : ""}>
          <div className={`grid gap-3 px-5 py-4 transition md:grid-cols-[minmax(0,1fr)_150px_110px_190px] md:items-center md:gap-4 ${isActive ? "bg-[#f4fbf7]" : "hover:bg-slate-50/70"}`}>
            <button type="button" onClick={() => { setSelected(isActive ? null : item); setActionError(null); }} className="min-w-0 text-left">
              <div className="flex items-center gap-2"><span className={`size-2 shrink-0 rounded-full ${isUrgent(item) ? "bg-red-500" : "bg-amber-400"}`} /><span className="truncate text-sm font-semibold text-slate-900">{label(item)}</span>{isUrgent(item) && <span className="shrink-0 text-[11px] font-medium text-red-600">优先</span>}</div>
              <p className="mt-1 line-clamp-1 pl-4 text-xs text-slate-500">{item.aiJudgment ?? item.message ?? item.recommendedAction ?? "等待人工核对"}</p>
              {supplier && <div className="mt-1 pl-4 text-[11px] text-slate-400">供应商：{supplier}</div>}
            </button>
            <div className="pl-4 md:pl-0"><div className="text-xs font-medium text-slate-700">{businessObject}</div><div className="mt-1 text-[11px] text-slate-400">{item.source === "odoo" ? "本地 Odoo" : item.objectType ?? "真实业务对象"}</div></div>
            <div className="pl-4 md:pl-0"><Badge tone={tone(item.status)}>{item.source === "approval" ? "待审批" : item.source === "odoo" ? "异常" : item.source === "exception" ? "异常" : "待确认"}</Badge></div>
            <div className="flex flex-wrap justify-start gap-2 pl-4 md:justify-end md:pl-0">
              {actionFor(item).length ? actionFor(item).map((action) => <Button key={action} size="sm" variant={action === "approve" ? "default" : "outline"} disabled={submitting} onClick={() => setConfirming({ item, action })}>{action === "approve" ? <Check className="size-3.5" /> : action === "reassign" ? <UserRound className="size-3.5" /> : <X className="size-3.5" />}{action === "approve" ? "批准" : actionLabel[action]}</Button>) : item.source === "odoo" && onNavigate ? <Button size="sm" onClick={() => onNavigate(category(item) === "payables" ? "payables" : "orders")}>去核对<ArrowRight className="size-3.5" /></Button> : null}
              <Button size="sm" variant="outline" onClick={() => { setSelected(isActive ? null : item); setActionError(null); }}>{isActive ? "收起" : "查看详情"}<ChevronRight className={`size-3.5 transition ${isActive ? "rotate-90" : ""}`} /></Button>
            </div>
          </div>
          {isActive && <div className="border-t border-[#dcece5] bg-[#f8fcfa] px-5 py-5">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
              <div className="space-y-4"><div className="rounded-xl border border-[#cfe7dc] bg-white p-4"><div className="flex items-center gap-2 text-xs font-semibold text-[#0f3d32]"><ShieldAlert className="size-4" />AI 结论</div><p className="mt-2 text-sm leading-6 text-slate-700">{item.aiJudgment ?? item.message ?? "系统尚未提供结构化判断，请结合业务证据处理。"}</p><div className="mt-4 border-t border-slate-100 pt-3"><div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">建议动作</div><p className="mt-1 text-sm font-medium leading-6 text-slate-900">{item.recommendedAction ?? "请核对关联单据后做出判断"}</p></div></div>{context.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{context.slice(0, 6).map(([key, value]) => <div key={key} className="rounded-xl border border-slate-200 bg-white px-3 py-3"><div className="text-[11px] text-slate-400">{key}</div><div className="mt-1 truncate text-sm font-medium text-slate-700">{String(value)}</div></div>)}</div>}{actionError && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{actionError}</div>}</div>
              <div className="space-y-3"><div className="text-xs font-semibold text-slate-500">业务证据</div>{item.source === "odoo" && <div className="rounded-xl border border-sky-200 bg-sky-50 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-sky-800"><CheckCircle2 className="size-3.5" />本地 Odoo 实时事实</div><div className="mt-2 text-sm font-medium text-sky-950">{businessObject}</div></div>}{detailLoading && <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="size-3.5 animate-spin" />正在读取关联单据…</div>}{detailError && <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">{detailError}</div>}<div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1"><Preview title="RFQ / 报价" icon={ClipboardCheck} items={rfqs.length ? rfqs : quotes} empty="暂无询价与报价记录" /><Preview title="采购订单" icon={PackageCheck} items={purchaseOrders} empty="暂无 PO 记录" /><Preview title="发票" icon={ReceiptText} items={invoices} empty="暂无发票记录" /></div>{activities.length > 0 && <div className="rounded-xl border border-slate-200 bg-white p-3"><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700"><Clock3 className="size-3.5" />最近活动</div>{activities.slice(0, 3).map((activity, activityIndex) => <div key={String(activity.id ?? activityIndex)} className="border-l-2 border-slate-200 py-1 pl-3 text-xs text-slate-600">{itemText(activity.action ?? activity.summary ?? activity.message)}<div className="mt-1 text-[10px] text-slate-400">{itemText(activity.at ?? activity.createdAt, "时间未提供")}</div></div>)}</div>}</div>
            </div>
          </div>}
        </div>;
      })}</div>
    </div>}
    {confirming && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4" role="presentation"><div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="decision-confirm-title"><div className="flex items-start justify-between gap-4"><div><h2 id="decision-confirm-title" className="text-base font-semibold text-slate-900">确认{confirming.action === "approve" ? "批准并继续" : actionLabel[confirming.action]}</h2><p className="mt-2 text-sm leading-6 text-slate-600">将对“{label(confirming.item)}”提交真实业务操作，并更新相关状态。</p></div><button type="button" aria-label="关闭" onClick={() => !submitting && setConfirming(null)} disabled={submitting} className="text-slate-400 hover:text-slate-700"><X className="size-4" /></button></div><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirming(null)} disabled={submitting}>暂不处理</Button><Button onClick={() => void runAction()} disabled={submitting}>{submitting && <Loader2 className="size-3.5 animate-spin" />}{submitting ? "提交中…" : confirming.action === "approve" ? "确认批准并继续" : `确认${actionLabel[confirming.action]}`}</Button></div></div></div>}
  </div>;

  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-medium text-[#4d7969]">采购执行 · 上下文决策工作区</div><h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">{heading}</h1><p className="mt-1 text-sm text-slate-500">{subheading}</p></div><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />刷新</Button></div>
    {error && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">{error}</div>}
    {loading && !queue.length ? <div className="flex items-center justify-center rounded-2xl border border-slate-200 bg-white py-20 text-sm text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />读取真实工作项…</div> : <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
      <Card className="min-w-0"><CardHeader><CardTitle>队列 <span className="ml-1 text-xs font-normal text-slate-400">{visible.length}</span></CardTitle></CardHeader><CardContent className="space-y-2 pt-3">{visible.length === 0 ? <div className="py-10 text-center text-xs text-slate-400">暂无符合条件的真实事项</div> : visible.map((item) => <button type="button" key={`${item.source}:${item.id}`} onClick={() => { setSelected(item); setActionError(null); }} className={`w-full rounded-xl border p-3 text-left ${activeSelected?.source === item.source && activeSelected.id === item.id ? "border-[#78ad99] bg-[#f1faf6]" : "border-slate-100 hover:border-slate-300"}`}><div className="truncate text-sm font-medium text-slate-800">{label(item)}</div><div className="mt-1 flex items-center justify-between gap-2"><Badge tone={tone(item.status)}>{item.status ?? "待处理"}</Badge><span className="truncate text-[11px] text-slate-400">{item.objectId ?? item.taskId ?? ""}</span></div></button>)}</CardContent></Card>
      <Card className="min-w-0"><CardHeader><CardTitle>AI 结论与确认</CardTitle></CardHeader><CardContent className="space-y-5 pt-4">{activeSelected ? <><div className="rounded-xl border border-[#cfe7dc] bg-[#f4fbf7] p-4"><div className="flex items-center gap-2 text-xs font-semibold text-[#0f3d32]"><ShieldAlert className="size-4" />当前事项</div><div className="mt-2 text-base font-semibold text-slate-900">{label(activeSelected)}</div><p className="mt-2 text-sm leading-6 text-slate-600">{activeSelected.aiJudgment ?? activeSelected.message ?? "系统尚未提供 AI 结论，请依据右侧业务上下文判断。"}</p></div><div><div className="text-xs font-semibold uppercase tracking-wider text-slate-400">建议</div><p className="mt-2 text-sm text-slate-700">{activeSelected.recommendedAction ?? "暂无结构化建议"}</p></div>{actionError && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">{actionError}</div>}<div className="rounded-xl border border-slate-200 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-slate-700"><ClipboardCheck className="size-3.5" />可用操作</div><div className="mt-3 flex flex-wrap gap-2">{actionFor(activeSelected).length ? actionFor(activeSelected).map((action) => <Button key={action} size="sm" variant={action === "approve" ? "default" : "outline"} disabled={submitting} onClick={() => setConfirming({ item: activeSelected, action })}>{action === "approve" ? <Check className="size-3.5" /> : action === "reassign" ? <UserRound className="size-3.5" /> : <X className="size-3.5" />}{actionLabel[action]}</Button>) : <span className="text-xs text-slate-500">该来源没有已接入的写入操作。</span>}</div></div></> : <div className="py-20 text-center text-sm text-slate-400">选择左侧事项查看结论</div>}</CardContent></Card>
      <Card className="min-w-0"><CardHeader><CardTitle>业务对象与审计</CardTitle></CardHeader><CardContent className="space-y-4 pt-4">{activeSelected ? <><div className="rounded-xl bg-slate-50 p-3 text-sm"><div className="text-xs text-slate-400">关联对象</div><div className="mt-1 font-medium text-slate-800">{activeSelected.objectType ?? "业务对象"}</div><div className="mt-1 font-mono text-xs text-slate-500">{activeSelected.objectId ?? activeSelected.taskId ?? "暂无对象 ID"}</div></div>{detailLoading && <div className="flex items-center gap-2 text-xs text-slate-400"><Loader2 className="size-3.5 animate-spin" />正在读取关联单据…</div>}{detailError && <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700">{detailError}</div>}<div><div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">完整采购上下文</div><div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1"><Preview title="采购需求" icon={FileText} items={requisitions} empty="暂无需求记录" /><Preview title="RFQ" icon={FileText} items={rfqs} empty="暂无 RFQ 记录" /><Preview title={`报价 / 定标 ${quotes.length}/${awards.length}`} icon={ClipboardCheck} items={quotes.length ? quotes : awards} empty="暂无报价与定标记录" /><Preview title="供应商" icon={UserRound} items={suppliers} empty="暂无供应商记录" /><Preview title="PO" icon={PackageCheck} items={purchaseOrders} empty="暂无 PO 记录" /><Preview title="收货" icon={PackageCheck} items={receipts} empty="暂无收货记录" /><Preview title="发票" icon={ReceiptText} items={invoices} empty="暂无发票记录" /></div></div><div className="rounded-xl border border-slate-200 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-slate-700"><FileText className="size-3.5" />原始文档 / 附件</div><AttachmentPreview attachments={detail?.attachments ?? []} /></div><div><div className="mb-2 text-xs font-semibold text-slate-500">结构化字段</div>{context.length ? context.map(([key, value]) => <div key={key} className="flex justify-between gap-3 border-b border-slate-100 py-2 text-xs"><span className="text-slate-400">{key}</span><span className="max-w-[170px] truncate text-slate-700">{String(value)}</span></div>) : <div className="text-xs text-slate-400">暂无结构化对象字段</div>}</div><div><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-500"><Clock3 className="size-3.5" />活动时间线</div>{activities.length ? activities.map((activity, index) => <div key={String(activity.id ?? index)} className="border-l-2 border-slate-200 py-1 pl-3 text-xs text-slate-600">{itemText(activity.action ?? activity.summary ?? activity.message)}<div className="mt-1 text-[10px] text-slate-400">{itemText(activity.at ?? activity.createdAt, "时间未提供")}</div></div>) : <div className="text-xs text-slate-400">暂无活动时间线</div>}</div><div className="flex items-center gap-2 text-xs text-slate-400"><FileText className="size-3.5" />来源：{source || "真实 API"}</div></> : <div className="py-20 text-center text-sm text-slate-400">暂无选中事项</div>}</CardContent></Card>
    </div>}
    <div className="flex items-center gap-2 text-xs text-slate-400"><AlertTriangle className="size-3.5" />当前页面数据只来自真实 API；所有写入操作均需确认，并在成功后刷新。</div>
    {confirming && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4" role="presentation"><div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="operation-confirm-title"><div className="flex items-start justify-between gap-4"><div><h2 id="operation-confirm-title" className="text-base font-semibold text-slate-900">确认{actionLabel[confirming.action]}</h2><p className="mt-2 text-sm leading-6 text-slate-600">将对“{label(confirming.item)}”提交真实业务操作。此操作可能改变审批或异常状态。</p></div><button type="button" aria-label="关闭" onClick={() => !submitting && setConfirming(null)} disabled={submitting} className="text-slate-400 hover:text-slate-700"><X className="size-4" /></button></div><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirming(null)} disabled={submitting}>取消</Button><Button onClick={() => void runAction()} disabled={submitting}>{submitting && <Loader2 className="size-3.5 animate-spin" />}{submitting ? "提交中…" : `确认${actionLabel[confirming.action]}`}</Button></div></div></div>}
  </div>;
}

export function ProcurementUnavailable({ title }: { title: string }) {
  return <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-16 text-center"><FileText className="mx-auto size-7 text-slate-300" /><h1 className="mt-3 text-lg font-semibold text-slate-800">{title}</h1><p className="mt-2 text-sm text-slate-500">该模块的真实 API 尚未提供，当前不会展示演示数据或执行假操作。</p></div>;
}
