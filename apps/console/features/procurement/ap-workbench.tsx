"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Check, ChevronRight, Clock3, FileCheck2, FileText,
  Loader2, MoreHorizontal, PackageCheck, ReceiptText, RefreshCw, Search,
  ShieldAlert, UserRound, X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { READYWORK_PAGE_CONTAINER_CLASS, READYWORK_PAGE_TITLE_CLASS } from "@/features/procurement/visual-tokens";

type Source = "task" | "approval" | "exception" | "invoice";
type Action = "approve" | "reject" | "reassign";
type Row = Record<string, unknown>;
type WorkItem = Row & {
  id: string;
  /** ID supplied by the API; display fallbacks must never drive an API request. */
  stableId?: string;
  source: Source;
  payload?: Row;
  taskId?: string;
  approvalId?: string;
  objectId?: string;
  objectType?: string;
  status?: string;
  title?: string;
  name?: string;
  message?: string;
  aiJudgment?: string;
  recommendedAction?: string;
};
type ContextDetail = {
  root?: Row;
  purchaseOrders?: Row[]; invoices?: Row[]; receipts?: Row[]; matches?: Row[];
  suppliers?: Row[]; activities?: Row[]; outbox?: Row[]; attachments?: Row[];
  tasks?: Row[]; approvals?: Row[]; exceptions?: Row[]; linesByDocument?: Record<string, Row[]>;
};
type Workbench = {
  documents?: {
    invoices?: { items?: Row[]; total?: number };
    matches?: { items?: Row[]; total?: number };
    purchaseOrders?: { items?: Row[]; total?: number };
    suppliers?: { items?: Row[]; total?: number };
  };
  permissions?: { operate?: boolean; approve?: boolean };
};

const terminalTaskStatuses = new Set(["completed", "failed", "cancelled"]);
const unwrap = (payload: unknown): Row[] => Array.isArray(payload)
  ? payload.filter((item): item is Row => Boolean(item && typeof item === "object"))
  : payload && typeof payload === "object" && Array.isArray((payload as { items?: unknown[] }).items)
    ? unwrap((payload as { items: unknown[] }).items) : [];
const record = (value: unknown): Row | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const records = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item && typeof item === "object")) : record(value) ? [record(value)!] : [];
const text = (value: unknown, fallback = "—") => typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
/** SQLite Decimal values can arrive as strings. Only accept a complete finite decimal. */
const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll(",", "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const amount = (item?: Row) => {
  if (!item) return undefined;
  for (const key of ["amountTotal", "totalAmount", "total", "amount", "grandTotal"]) {
    const value = finiteNumber(item[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};
const currencyCode = (value: unknown) => {
  const candidate = text(value, "CNY").toUpperCase();
  return /^[A-Z]{3}$/.test(candidate) ? candidate : "CNY";
};
const money = (value: number | undefined, currency?: unknown) => value === undefined ? "金额未提供" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: currencyCode(currency), maximumFractionDigits: 2 }).format(value);
const sourcePayload = (item: WorkItem, key: string) => records(item.payload?.[key]);
const titleOf = (item: WorkItem) => text(item.title ?? item.name ?? item.message ?? item.invoiceNumber ?? item.externalId ?? item.objectId ?? item.id, "未命名事项");
const statusName = (value: unknown) => {
  const raw = text(value, "待处理");
  const map: Record<string, string> = { received: "已收票", matched: "匹配通过", exact_match: "完全匹配", within_tolerance: "容差内匹配", approval_required: "待审批", severe_exception: "严重异常", amount_variance: "金额差异待核对", awaiting_receipt: "待收货单", amounts_aligned: "金额一致，待三单匹配", open: "待处理", pending: "待处理", waiting_approval: "待审批", assigned: "处理中", rejected: "已拒绝", approved: "已批准" };
  return map[raw] ?? raw;
};
const statusTone = (value: unknown): "red" | "amber" | "blue" | "green" | "violet" | "neutral" => {
  const raw = text(value, "").toLowerCase();
  if (/severe|failed|open|reject|异常|风险|variance/.test(raw)) return "red";
  if (/approval|pending|waiting|待/.test(raw)) return "amber";
  if (/exact|matched|approved|payable|complete|通过/.test(raw)) return "green";
  if (/assigned|running|process/.test(raw)) return "blue";
  return "neutral";
};
const actionLabel: Record<Action, string> = { approve: "批准并继续", reject: "驳回", reassign: "转交给我" };

function normalize(source: Source, raw: Row, index: number): WorkItem {
  const payload = record(raw.payload);
  const stableId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const explicitTaskId = typeof raw.taskId === "string" && raw.taskId.trim() ? raw.taskId.trim() : undefined;
  const rawObjectId = raw.objectId ?? raw.businessObjectId ?? raw.invoiceId;
  const objectId = typeof rawObjectId === "string" && rawObjectId.trim() ? rawObjectId.trim() : undefined;
  const id = stableId ?? `${source}-${index}`;
  return {
    ...raw, id, stableId, source, payload,
    approvalId: source === "approval" ? id : text(raw.approvalId, "") || undefined,
    taskId: source === "task" ? stableId : explicitTaskId,
    objectId,
    objectType: text(raw.objectType ?? raw.businessObjectType ?? raw.kind, "") || undefined,
  };
}

/** Classification is based on typed workflow/object relationships, never prose. */
function isApItem(item: WorkItem, invoiceIds: Set<string>, matchIds: Set<string>, apTaskIds: Set<string>): boolean {
  if (item.source === "invoice") return Boolean(item.objectId && invoiceIds.has(item.objectId));
  if (item.source === "task") return Boolean(item.taskId && apTaskIds.has(item.taskId));
  if (item.source === "approval") return Boolean(item.taskId && apTaskIds.has(item.taskId));
  const type = text(item.objectType ?? item.type, "").toLowerCase();
  return type === "invoice" || type === "three_way_match" || type === "match" || Boolean(item.objectId && (invoiceIds.has(item.objectId) || matchIds.has(item.objectId)));
}

function contextIdFor(item: WorkItem): string | undefined {
  if (item.source === "approval") return item.taskId;
  if (item.objectId) return item.objectId;
  if (item.source === "task") return item.taskId;
  if (item.source === "exception") return item.stableId;
  return undefined;
}

export function ProcurementApWorkbench() {
  const { formatDate, formatShortDateTime } = useProcurementLocale();
  const dateOnly = (value: unknown) => formatDate(typeof value === "string" ? value : null);
  const dateTime = (value: unknown) => formatShortDateTime(typeof value === "string" ? value : null);
  const [queue, setQueue] = useState<WorkItem[]>([]);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [canApprove, setCanApprove] = useState(false);
  const [tab, setTab] = useState<"po" | "invoice" | "receipt" | "audit">("po");
  const [confirming, setConfirming] = useState<{ item: WorkItem; action: Action } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError(null);
    try {
      const [tasks, approvals, exceptions, workbench] = await Promise.allSettled([
        apiRequest<unknown>("/api/tasks", { signal: controller.signal }),
        apiRequest<unknown>("/api/approvals/pending", { signal: controller.signal }),
        apiRequest<unknown>("/api/exceptions", { signal: controller.signal }),
        apiRequest<Workbench>("/api/procurement/workbench?limit=100", { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      const invoiceIds = new Set((workbench.status === "fulfilled" ? workbench.value.documents?.invoices?.items ?? [] : [])
        .map((invoice) => typeof invoice.id === "string" ? invoice.id : undefined)
        .filter((id): id is string => Boolean(id)));
      const matchIds = new Set((workbench.status === "fulfilled" ? workbench.value.documents?.matches?.items ?? [] : [])
        .map((match) => typeof match.id === "string" ? match.id : undefined)
        .filter((id): id is string => Boolean(id)));
      const normalizedTasks = tasks.status === "fulfilled" ? unwrap(tasks.value).map((raw, index) => normalize("task", raw, index)) : [];
      const apTaskIds = new Set(normalizedTasks
        .filter((item) => text(item.workflowId, "") === "invoice-match" || text(item.objectType, "").toLowerCase() === "invoice")
        .map((item) => item.taskId)
        .filter((id): id is string => Boolean(id)));
      setCanApprove(workbench.status === "fulfilled" && workbench.value.permissions?.approve === true);
      const all: WorkItem[] = [];
      normalizedTasks.filter((item) => !terminalTaskStatuses.has(text(item.status, "").toLowerCase()) && isApItem(item, invoiceIds, matchIds, apTaskIds)).forEach((item) => all.push(item));
      if (approvals.status === "fulfilled") unwrap(approvals.value).map((raw, index) => normalize("approval", raw, index)).filter((item) => isApItem(item, invoiceIds, matchIds, apTaskIds)).forEach((item) => all.push(item));
      if (exceptions.status === "fulfilled") unwrap(exceptions.value).map((raw, index) => normalize("exception", raw, index)).filter((item) => isApItem(item, invoiceIds, matchIds, apTaskIds)).forEach((item) => all.push(item));
      if (workbench.status === "fulfilled") {
        const invoices = workbench.value.documents?.invoices?.items ?? [];
        const purchaseOrders = workbench.value.documents?.purchaseOrders?.items ?? [];
        const suppliers = workbench.value.documents?.suppliers?.items ?? [];
        const poById = new Map(purchaseOrders.map((po) => [text(po.id, ""), po]));
        const supplierNames = new Map(suppliers.map((supplier) => [text(supplier.id, ""), text(supplier.name, "供应商未命名")]));
        invoices.forEach((invoice, index) => {
          const po = poById.get(text(invoice.poId, ""));
          const invoiceAmount = amount(invoice);
          const poAmount = amount(po);
          const variance = invoiceAmount !== undefined && poAmount !== undefined ? invoiceAmount - poAmount : undefined;
          const hasVariance = variance !== undefined && Math.abs(variance) >= 0.01;
          const invoiceNumber = text(invoice.invoiceNumber ?? invoice.externalId ?? invoice.id, "未命名发票");
          const poNumber = text(po?.displayNumber ?? po?.number ?? invoice.poReference ?? invoice.poId, "未关联 PO");
          all.push(normalize("invoice", {
            ...invoice,
            objectId: invoice.id,
            objectType: "invoice",
            supplierName: supplierNames.get(text(invoice.supplierId, "")),
            poAmount,
            amountVariance: variance,
            comparisonStatus: hasVariance ? "amount_variance" : po ? "amounts_aligned" : "awaiting_receipt",
            title: `${invoiceNumber} / ${hasVariance ? "金额差异待核对" : "待三单匹配"}`,
            message: hasVariance
              ? `已关联 ${poNumber}；PO 与发票金额差异 ${money(Math.abs(variance), invoice.currency ?? po?.currency)}，尚未形成三单匹配结论。`
              : `已关联 ${poNumber}；金额一致，仍需收货单完成三单匹配。`,
          }, index));
        });
      }
      const priority: Record<Source, number> = { exception: 0, approval: 1, task: 2, invoice: 3 };
      const unique = Array.from(new Map(all.map((item) => {
        const key = item.source === "invoice" ? `invoice:${item.objectId ?? item.id}` : `${item.source}:${item.id}`;
        return [key, item];
      })).values()).sort((a, b) => priority[a.source] - priority[b.source]);
      // An exception and its pending approval are one business decision.  Keep
      // the approval row as the only writable representation of that decision.
      const approvalIds = new Set(unique.filter((item) => item.source === "approval" && item.stableId).map((item) => item.stableId!));
      const approvalTaskIds = new Set(unique.filter((item) => item.source === "approval" && item.taskId).map((item) => item.taskId!));
      const safeQueue = unique.filter((item) => !(item.source === "exception" && item.approvalId && approvalIds.has(item.approvalId)))
        .filter((item) => !(item.source === "task" && approvalTaskIds.has(item.id)));
      setQueue(safeQueue);
      setSelected((current) => current && safeQueue.some((item) => item.source === current.source && item.id === current.id) ? safeQueue.find((item) => item.source === current.source && item.id === current.id) ?? current : safeQueue[0] ?? null);
      const failed = [tasks, approvals, exceptions, workbench].filter((result) => result.status === "rejected" && !(result.reason instanceof ReadyworkApiError && result.reason.status === 499));
      if (failed.length === 4) setError("真实业务接口暂时不可用，请稍后刷新。");
      else if (failed.length) setError("部分数据暂时无法读取；页面仅展示已成功返回的真实记录。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  }, []);
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);

  const active = selected && queue.some((item) => item.source === selected.source && item.id === selected.id) ? selected : queue[0] ?? null;
  useEffect(() => {
    detailRequest.current?.abort(); setDetail(null); setDetailError(null);
    if (!active) return;
    const contextId = contextIdFor(active);
    if (!contextId) {
      setDetailLoading(false);
      setDetailError("该队列项没有经 API 确认的业务对象关联，已阻止上下文查询。");
      return;
    }
    const controller = new AbortController(); detailRequest.current = controller; setDetailLoading(true);
    void apiRequest<ContextDetail>(`/api/procurement/workbench/context/${encodeURIComponent(contextId)}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setDetail(value); })
      .catch((cause) => { if (!controller.signal.aborted && !(cause instanceof ReadyworkApiError && cause.status === 499)) setDetailError(cause instanceof ReadyworkApiError && cause.status === 404 ? "该事项尚未关联可展示的采购上下文。" : "业务上下文读取失败，请刷新重试。"); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [active]);

  const filtered = useMemo(() => queue.filter((item) => !query.trim() || `${titleOf(item)} ${text(item.objectId, "")} ${text(item.status, "")}`.toLowerCase().includes(query.trim().toLowerCase())), [queue, query]);
  const document = detail?.root;
  const purchaseOrder = detail?.purchaseOrders?.[0] ?? sourcePayload(active ?? {} as WorkItem, "purchaseOrder")[0];
  const invoice = detail?.invoices?.[0] ?? (active?.source === "invoice" ? active : undefined) ?? sourcePayload(active ?? {} as WorkItem, "invoice")[0];
  const receipt = detail?.receipts?.[0] ?? sourcePayload(active ?? {} as WorkItem, "receipt")[0];
  const match = detail?.matches?.[0];
  const supplier = detail?.suppliers?.[0];
  // PO 页的视觉验收活动不属于应付处理事实，不能混入 AP 审计轨迹。
  const activities = (detail?.activities ?? []).filter((activity) => activity.actor !== "visual-test" && activity.action !== "visual.acceptance_created");
  const outbox = detail?.outbox ?? [];
  const currentStatus = match?.result ?? match?.status ?? active?.status ?? invoice?.status;
  const poAmount = amount(purchaseOrder);
  const invoiceAmount = amount(invoice);
  const variance = poAmount !== undefined && invoiceAmount !== undefined ? invoiceAmount - poAmount : undefined;
  const comparisonStatus = match?.result ?? match?.status
    ?? (variance !== undefined && Math.abs(variance) >= 0.01 ? "amount_variance" : purchaseOrder && invoice ? receipt ? "amounts_aligned" : "awaiting_receipt" : currentStatus);
  const linkedDocuments = [purchaseOrder, invoice, receipt].filter(Boolean).length;
  const variancePercent = poAmount && variance !== undefined ? Math.abs(variance / poAmount) * 100 : undefined;
  const analysisTitle = comparisonStatus === "amount_variance"
    ? `发票金额与采购订单 ${text(purchaseOrder?.displayNumber ?? purchaseOrder?.number ?? invoice?.poReference, "") || ""} 不匹配`.trim()
    : comparisonStatus === "awaiting_receipt" ? "已关联 PO 与发票，等待收货单完成三单匹配" : "三单事实已更新";
  const computedAnalysisMessage = comparisonStatus === "amount_variance"
    ? `系统按已导入的 PO 和发票金额计算出 ${money(Math.abs(variance ?? 0), invoice?.currency ?? purchaseOrder?.currency)} 的差异；收货单尚未同步，因此不能标记为可付款。`
    : comparisonStatus === "awaiting_receipt" ? "已读取关联采购订单与供应商发票；本地 Odoo 尚无对应完成收货记录。"
      : "已读取当前业务对象，等待后续匹配或审批事件。";
  const analysisMessage = active?.source === "invoice" ? computedAnalysisMessage
    : active?.aiJudgment ?? active?.message ?? computedAnalysisMessage;
  // Exception rows are read-only here.  If one needs a decision, its pending
  // approval is the single writable row; this avoids a second, ambiguous
  // exception endpoint and preserves the task-engine CAS/idempotency contract.
  const actionFor = (item?: WorkItem): Action[] => !item || !canApprove ? [] : item.source === "approval" && item.taskId && item.stableId ? ["approve", "reject"] : [];
  const runAction = useCallback(async () => {
    if (!confirming || submitting) return;
    const { item, action } = confirming; setSubmitting(true); setActionError(null);
    try {
      if (item.source === "approval" && item.taskId && item.stableId && (action === "approve" || action === "reject")) {
        await apiRequest(`/api/tasks/${encodeURIComponent(item.taskId)}/${action}`, { method: "POST", body: { approvalId: item.stableId } });
      }
      else return;
      setConfirming(null); await load();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "操作提交失败，请稍后重试。"); }
    finally { setSubmitting(false); }
  }, [confirming, load, submitting]);

  const syncOdoo = useCallback(async () => {
    if (syncing) return;
    setSyncing(true); setError(null);
    try {
      await apiRequest("/api/procurement/odoo/sync", { method: "POST" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "同步 Odoo 失败，请稍后重试。");
    } finally { setSyncing(false); }
  }, [load, syncing]);

  return <div className={READYWORK_PAGE_CONTAINER_CLASS}>
    <header className="flex min-h-[88px] flex-wrap items-center justify-between gap-4 border-b border-[#e4eaf2] py-4">
      <div><h1 className={READYWORK_PAGE_TITLE_CLASS}>发票与应付</h1><p className="mt-1 text-sm text-[#52627a]">处理发票识别、三单匹配、差异审批与应付确认。</p></div>
      <div className="flex items-center gap-2"><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />刷新</Button><Button variant="outline" size="sm" onClick={() => void syncOdoo()} disabled={syncing}><RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />{syncing ? "同步中…" : "同步 ERP"}</Button></div>
    </header>
    {error && <div role="alert" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</div>}
    {loading && !queue.length ? <div className="flex min-h-[650px] items-center justify-center text-sm text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />正在读取真实应付事项…</div> : <div className="grid min-h-[760px] gap-3 pt-5 xl:grid-cols-[280px_minmax(0,1fr)_390px]">
      <section className="flex min-h-0 flex-col overflow-hidden rounded-[12px] border border-[#e4eaf2] bg-white shadow-[0_1px_3px_rgba(15,23,42,.04)]"><div className="flex items-center justify-between border-b border-[#edf1f6] px-4 py-4"><div className="flex items-baseline gap-3"><h2 className="text-[15px] font-semibold text-[#13203a]">待处理队列</h2><span className="text-xs text-[#718198]">{filtered.length}</span></div><MoreHorizontal className="size-4 text-[#718198]" /></div><label className="m-3 flex h-9 items-center gap-2 rounded-lg border border-[#d9e1ec] px-3"><Search className="size-4 text-[#718198]" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索订单号、供应商或问题" className="min-w-0 flex-1 bg-transparent text-xs text-[#26364f] outline-none placeholder:text-[#8795a9]" /></label><div className="min-h-0 flex-1 overflow-auto px-2 pb-2">{filtered.length ? <div className="space-y-2">{filtered.map((item) => { const itemStatus = item.comparisonStatus ?? item.status; return <button type="button" key={`${item.source}:${item.id}`} onClick={() => { setSelected(item); setActionError(null); }} className={`w-full rounded-lg border p-3 text-left transition ${active?.source === item.source && active.id === item.id ? "border-[#5598ff] bg-[#f4f8ff] ring-1 ring-inset ring-[#bcd7ff]" : "border-[#edf1f6] hover:border-[#cdd8e6] hover:bg-slate-50"}`}><div className="flex items-start gap-2"><span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${statusTone(itemStatus) === "red" ? "bg-red-500" : "bg-[#2878ff]"}`} /><div className="min-w-0 flex-1"><div className="truncate text-[13px] font-semibold text-[#13203a]">{titleOf(item)}</div><div className="mt-2 truncate text-[11px] text-[#718198]">供应商：{text(item.supplierName, "未提供")}</div><div className="mt-2 flex items-center justify-between gap-2"><span className="rounded bg-[#eef2f7] px-1.5 py-0.5 text-[10px] text-[#64748b]">{statusName(itemStatus)}</span><span className="text-[10px] text-[#8795a9]">{dateTime(item.updatedAt ?? item.requestedAt ?? item.createdAt)}</span></div></div></div></button>; })}</div> : <div className="px-5 py-16 text-center text-sm text-slate-400">暂无符合条件的真实应付事项</div>}</div><button type="button" onClick={() => void load()} className="m-3 flex h-10 w-[calc(100%-1.5rem)] items-center justify-center gap-1 rounded-lg border border-[#d9e1ec] text-xs font-medium text-[#52627a] hover:bg-slate-50">查看全部任务 <ChevronRight className="size-3.5" /></button></section>
      <section className="min-w-0 rounded-[12px] border border-[#e4eaf2] bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,.04)]"><div className="flex items-center gap-2"><FileCheck2 className="size-4 text-[#2563eb]" /><h2 className="text-[15px] font-semibold text-[#13203a]">AI 结论与确认</h2><span className="rounded bg-[#eef5ff] px-2 py-0.5 text-[10px] font-medium text-[#2878ff]">由 Readywork 规则计算</span></div>{active ? <><div className="mt-5"><div className="flex items-start gap-2"><ShieldAlert className={statusTone(comparisonStatus) === "red" ? "mt-0.5 size-5 shrink-0 text-[#f59e0b]" : "mt-0.5 size-5 shrink-0 text-[#2878ff]"} /><div><h3 className="text-[18px] font-semibold tracking-[-0.015em] text-[#13203a]">{analysisTitle}</h3><p className="mt-2 text-[12px] leading-5 text-[#64748b]">{analysisMessage}</p></div></div></div><div className="mt-5 overflow-hidden rounded-xl border border-[#e4eaf2]"><FactRow label="PO 金额" value={money(poAmount, purchaseOrder?.currency ?? invoice?.currency)} /><FactRow label="发票金额" value={money(invoiceAmount, invoice?.currency ?? purchaseOrder?.currency)} /><FactRow label="差异金额" value={variance === undefined ? "无法根据当前真实单据计算" : `${variance >= 0 ? "+" : "-"}${money(Math.abs(variance), invoice?.currency ?? purchaseOrder?.currency)}${variancePercent === undefined ? "" : ` (${variancePercent.toFixed(2)}%)`}`} emphasized={variance !== undefined && variance !== 0} /><FactRow label="三单匹配状态" value={statusName(comparisonStatus)} tone={statusTone(comparisonStatus)} /><FactRow label="已关联业务对象" value={`${linkedDocuments}/3（PO / 收货 / 发票）`} last /></div><div className="mt-5"><h3 className="text-[14px] font-semibold text-[#13203a]">可查看的下一步</h3><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><ViewActionCard icon={FileText} title="查看 PO" detail="核对订单金额和行项目" onClick={() => setTab("po")} /><ViewActionCard icon={ReceiptText} title="查看发票" detail="核对原始发票字段" onClick={() => setTab("invoice")} /><ViewActionCard icon={PackageCheck} title="收货状态" detail={receipt ? "查看已关联收货单" : "Odoo 尚无完成收货单"} onClick={() => setTab("receipt")} /><ViewActionCard icon={Clock3} title="审计记录" detail="查看已发生的业务活动" onClick={() => setTab("audit")} /></div>{actionFor(active).length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{actionFor(active).map((action) => <ActionCard key={action} icon={action === "approve" ? Check : action === "reassign" ? UserRound : X} title={actionLabel[action]} detail={action === "approve" ? "提交真实审批决策并由工作流继续执行。" : "驳回当前建议，保留完整审计记录。"} primary={action === "approve"} disabled={submitting} onClick={() => setConfirming({ item: active, action })} />)}</div> : null}</div>{actionError && <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{actionError}</div>}<div className="mt-5 border-t border-[#edf1f6] pt-4"><div className="flex items-center justify-between"><h3 className="text-[14px] font-semibold text-[#13203a]">最近活动</h3><span className="text-[11px] text-[#8795a9]">真实审计轨迹</span></div><ActivityList activities={[...activities, ...outbox]} /></div></> : <EmptyDetail text="选择一条真实应付事项查看 AI 结论和三单事实。" />}</section>
      <section className="min-w-0 rounded-[12px] border border-[#e4eaf2] bg-white shadow-[0_1px_3px_rgba(15,23,42,.04)]"><div className="border-b border-[#edf1f6] px-4 py-4"><h2 className="text-[15px] font-semibold text-[#13203a]">业务对象与文档</h2><p className="mt-1 text-xs text-[#8795a9]">采购订单、发票、收货与审计上下文</p></div><div className="flex gap-4 overflow-x-auto border-b border-[#edf1f6] px-4"><DocumentTab active={tab === "po"} onClick={() => setTab("po")}>采购订单</DocumentTab><DocumentTab active={tab === "invoice"} onClick={() => setTab("invoice")}>发票</DocumentTab><DocumentTab active={tab === "receipt"} onClick={() => setTab("receipt")}>收货单</DocumentTab><DocumentTab active={tab === "audit"} onClick={() => setTab("audit")}>审计</DocumentTab></div><div className="space-y-4 p-4">{detailLoading ? <div className="flex min-h-80 items-center justify-center text-sm text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />正在读取关联单据…</div> : detailError ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{detailError}</div> : tab === "po" ? <DocumentCard title="采购订单" data={purchaseOrder} supplier={supplier} lines={purchaseOrder ? detail?.linesByDocument?.[text(purchaseOrder.id, "")] : undefined} /> : tab === "invoice" ? <DocumentCard title="发票" data={invoice ?? document} supplier={supplier} lines={invoice ? detail?.linesByDocument?.[text(invoice.id, "")] : undefined} /> : tab === "receipt" ? <DocumentCard title="收货单" data={receipt} supplier={supplier} lines={receipt ? detail?.linesByDocument?.[text(receipt.id, "")] : undefined} /> : <AuditCard detail={detail} />}<div className="rounded-xl border border-[#e4eaf2] p-3"><div className="text-xs font-semibold text-[#26364f]">关键信息</div><div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3"><MiniFact label="供应商" value={supplier?.name ?? active?.supplierName} /><MiniFact label="应付状态" value={text(invoice?.paymentState, "未提供")} /><MiniFact label="发票号码" value={invoice?.invoiceNumber ?? invoice?.externalId} /><MiniFact label="发票金额" value={money(invoiceAmount, invoice?.currency)} /><MiniFact label="发票日期" value={dateOnly(invoice?.invoiceDate)} /><MiniFact label="匹配状态" value={statusName(comparisonStatus)} /></div></div></div></section>
    </div>}
    <p className="mt-3 flex items-center gap-2 text-xs text-[#8795a9]"><AlertTriangle className="size-3.5" />全部字段均来自统一 API；外部写入操作会二次确认，并在成功后刷新真实状态。</p>
    {confirming && <ConfirmDialog confirming={confirming} submitting={submitting} onClose={() => !submitting && setConfirming(null)} onConfirm={() => void runAction()} />}
  </div>;
}

function FactRow({ label, value, emphasized, tone, last }: { label: string; value: string; emphasized?: boolean; tone?: ReturnType<typeof statusTone>; last?: boolean }) { const color = tone === "red" || emphasized ? "text-red-600" : tone === "green" ? "text-emerald-600" : "text-slate-800"; return <div className={`flex items-center justify-between gap-4 px-4 py-3 text-sm ${last ? "" : "border-b border-slate-100"}`}><span className="text-slate-500">{label}</span><span className={`text-right font-medium ${color}`}>{value}</span></div>; }
function ViewActionCard({ icon: Icon, title, detail, onClick }: { icon: typeof FileText; title: string; detail: string; onClick: () => void }) { return <button type="button" onClick={onClick} className="min-h-[132px] rounded-xl border border-[#e4eaf2] p-3 text-left transition hover:border-[#a9caff] hover:bg-[#f7faff]"><Icon className="size-5 text-[#2878ff]" /><div className="mt-3 text-[12px] font-semibold text-[#26364f]">{title}</div><p className="mt-1 text-[10px] leading-4 text-[#718198]">{detail}</p></button>; }
function MiniFact({ label, value }: { label: string; value: unknown }) { return <div className="min-w-0"><div className="text-[10px] text-[#8795a9]">{label}</div><div className="mt-1 truncate text-xs font-medium text-[#26364f]">{text(value, "未提供")}</div></div>; }
function ActionCard({ icon: Icon, title, detail, primary, disabled, onClick }: { icon: typeof Check; title: string; detail: string; primary?: boolean; disabled: boolean; onClick: () => void }) { return <button type="button" disabled={disabled} onClick={onClick} className={`rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${primary ? "border-slate-900 bg-slate-950 text-white hover:bg-slate-800" : "border-slate-200 hover:border-slate-400 hover:bg-slate-50"}`}><Icon className={`size-4 ${primary ? "text-white" : "text-blue-600"}`} /><div className="mt-3 text-sm font-semibold">{title}</div><p className={`mt-1 text-[11px] leading-5 ${primary ? "text-slate-300" : "text-slate-500"}`}>{detail}</p></button>; }
function ActivityList({ activities }: { activities: Row[] }) { const { formatShortDateTime } = useProcurementLocale(); const dateTime = (value: unknown) => formatShortDateTime(typeof value === "string" ? value : null); if (!activities.length) return <div className="mt-3 rounded-xl border border-dashed border-slate-200 px-3 py-5 text-xs text-slate-400">当前上下文尚无可展示的真实活动。</div>; return <div className="mt-3 space-y-0">{activities.slice(0, 6).map((activity, index) => <div key={text(activity.id, `activity-${index}`)} className="relative border-l border-slate-200 pb-4 pl-4 last:pb-0"><span className="absolute -left-[4px] top-1 size-2 rounded-full bg-blue-500 ring-4 ring-blue-50" /><div className="text-xs font-medium text-slate-700">{text(activity.action ?? activity.summary ?? activity.message ?? activity.status, "活动记录")}</div><div className="mt-1 text-[11px] text-slate-400">{dateTime(activity.at ?? activity.updatedAt ?? activity.createdAt ?? activity.dispatchedAt)}</div></div>)}</div>; }
function DocumentTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button type="button" onClick={onClick} className={`shrink-0 border-b-2 py-3 text-xs font-medium transition ${active ? "border-slate-950 text-slate-950" : "border-transparent text-slate-500 hover:text-slate-800"}`}>{children}</button>; }
function DocumentCard({ title, data, supplier, lines }: { title: string; data?: Row; supplier?: Row; lines?: Row[] }) { const { formatDate } = useProcurementLocale(); const dateOnly = (value: unknown) => formatDate(typeof value === "string" ? value : null); if (!data) return <EmptyDetail text={`当前真实上下文中没有关联${title}。`} />; const fields: Array<[string, unknown]> = [["单据编号", data.externalId ?? data.invoiceNumber ?? data.id], ["状态", statusName(data.status)], ["供应商", supplier?.name ?? data.supplierName ?? data.supplierId], ["币种", data.currency], ["单据日期", data.invoiceDate ?? data.orderedAt ?? data.receivedAt ?? data.createdAt], ["金额", amount(data) === undefined ? undefined : money(amount(data), data.currency)]]; return <div className="space-y-3"><div className="rounded-xl border border-slate-200 p-4"><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2"><FileText className="size-4 text-slate-500" /><h3 className="text-sm font-semibold text-slate-900">{title}</h3></div><Badge tone={statusTone(data.status)}>{statusName(data.status)}</Badge></div><div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">{fields.map(([label, value]) => <div key={label} className="min-w-0"><div className="text-[11px] text-slate-400">{label}</div><div className="mt-1 truncate text-xs font-medium text-slate-700">{label === "单据日期" ? dateOnly(value) : text(value, "未提供")}</div></div>)}</div></div>{lines?.length ? <div className="overflow-hidden rounded-xl border border-slate-200"><div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold text-slate-700">单据行</div><div className="divide-y divide-slate-100">{lines.slice(0, 8).map((line, index) => <div key={text(line.id, `line-${index}`)} className="grid grid-cols-[minmax(0,1fr)_70px_90px] gap-2 px-3 py-2 text-xs"><span className="truncate text-slate-700">{text(line.itemName ?? line.description ?? line.itemId, `第 ${index + 1} 行`)}</span><span className="text-right text-slate-500">{text(line.quantity ?? line.orderedQty ?? line.receivedQty, "—")}</span><span className="text-right text-slate-700">{amount(line) === undefined ? "—" : money(amount(line), data.currency)}</span></div>)}</div></div> : <div className="rounded-xl border border-dashed border-slate-200 px-4 py-5 text-xs text-slate-400">未提供可展示的结构化单据行。</div>}</div>; }
function AuditCard({ detail }: { detail: ContextDetail | null }) { const entries = [...(detail?.activities ?? []), ...(detail?.outbox ?? [])]; return <div><h3 className="text-sm font-semibold text-slate-900">审计与执行轨迹</h3><ActivityList activities={entries} /><div className="mt-4 rounded-xl border border-slate-200 p-3"><div className="text-xs font-semibold text-slate-700">关联附件</div>{detail?.attachments?.length ? <div className="mt-2 space-y-2">{detail.attachments.slice(0, 6).map((attachment, index) => <div key={text(attachment.id, `attachment-${index}`)} className="flex items-center gap-2 text-xs"><FileText className="size-3.5 text-slate-400" /><span className="truncate text-slate-600">{text(attachment.fileName ?? attachment.id)}</span></div>)}</div> : <div className="mt-2 text-xs text-slate-400">暂无可展示附件。</div>}</div></div>; }
function EmptyDetail({ text }: { text: string }) { return <div className="flex min-h-80 flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 px-6 text-center text-sm text-slate-400"><ReceiptText className="mb-3 size-7 text-slate-300" />{text}</div>; }
function ConfirmDialog({ confirming, submitting, onClose, onConfirm }: { confirming: { item: WorkItem; action: Action }; submitting: boolean; onClose: () => void; onConfirm: () => void }) { return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4"><div role="dialog" aria-modal="true" aria-labelledby="ap-confirm-title" className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"><div className="flex items-start justify-between gap-4"><div><h2 id="ap-confirm-title" className="text-base font-semibold text-slate-900">确认{actionLabel[confirming.action]}</h2><p className="mt-2 text-sm leading-6 text-slate-600">将对“{titleOf(confirming.item)}”提交真实业务操作。操作成功后会刷新审批与异常状态。</p></div><button type="button" onClick={onClose} disabled={submitting} aria-label="关闭" className="text-slate-400 hover:text-slate-700"><X className="size-4" /></button></div><div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={onClose} disabled={submitting}>取消</Button><Button onClick={onConfirm} disabled={submitting}>{submitting && <Loader2 className="size-3.5 animate-spin" />}{submitting ? "提交中…" : `确认${actionLabel[confirming.action]}`}</Button></div></div></div>; }
