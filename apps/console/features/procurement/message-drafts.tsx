"use client";

import { uiConfirm } from "@/features/localization/ui-dialogs";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Edit3, Loader2, Mail, Send, Trash2, X } from "lucide-react";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { cn } from "@/lib/utils";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { READYWORK_PAGE_CONTAINER_CLASS, READYWORK_PAGE_TITLE_CLASS } from "@/features/procurement/visual-tokens";
import { useProcurementRealtimeRefresh } from "@/features/procurement/realtime-events";

type DraftStatus = "draft" | "approved_queued" | "sent" | "discarded";
type DraftCapabilities = { edit: boolean; discard: boolean; approve: boolean };
type Delivery = { status: string; error: string | null; attempts: number; dispatchedAt: string | null; failedAt: string | null; updatedAt: string };
type Draft = {
  id: string; purchaseOrderId: string; purchaseOrderNumber: string; supplierId: string; supplierName: string;
  channel: "email" | "whatsapp"; recipient: string; subject: string; body: string; category: string;
  triggerEvidence: Record<string, unknown>; status: DraftStatus; version: number; outboxId: string | null;
  delivery: Delivery | null; providerDelivery: unknown; amountTotal: number | null; currency: string | null; promisedAt: string | null;
  createdBy: string; reviewedBy: string | null; createdAt: string; updatedAt: string; reviewedAt: string | null; sentAt: string | null;
  senderIdentity: { displayName: string; title: string; organizationName: string } | null;
  decisionContext: { source: string; label: string; summary: string; ruleId: string | null; dueAt: string | null; missingFields: string[]; sourceCommunication: unknown };
};
type DraftList = {
  items: Draft[];
  counts: Partial<Record<DraftStatus, number>>;
  generationReadiness: { status: "ready" | "sla_policy_missing" | "communication_identity_missing"; publishedPolicyId: string | null; publishedPolicyVersion: number | null; communicationIdentityVersion?: number | null };
  capabilities: DraftCapabilities;
};
type EventItem = { id: string; actorId: string; action: string; detail: Record<string, unknown>; createdAt: string };

const categoryLabel: Record<string, string> = {
  acknowledgement_followup: "确认回执跟进", production_progress_followup: "生产进度跟进", dispatch_followup: "发运跟进",
  delivery_status_escalation: "交付状态升级", grn_followup: "收货跟进",
};

const NO_DRAFT_CAPABILITIES: DraftCapabilities = { edit: false, discard: false, approve: false };
function normalizeCapabilities(value: Partial<DraftCapabilities> | null | undefined): DraftCapabilities {
  return { edit: value?.edit === true, discard: value?.discard === true, approve: value?.approve === true };
}

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) { const value = minutes || 1; return `${value} 分钟前`; }
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}
function errorText(error: unknown): string {
  if (error instanceof ReadyworkApiError) return error.message;
  return error instanceof Error ? error.message : "沟通草稿请求失败";
}
function deliveryStatusLabel(draft: Draft): "草稿" | "已排队" | "等待连接器回执" | "已发送" | "发送失败" | "需要处理" | "已丢弃" {
  if (draft.status === "sent" && draft.delivery?.status === "dispatched") return "已发送";
  if (draft.delivery?.status === "failed") return "发送失败";
  if (draft.delivery?.status === "blocked") return "需要处理";
  if (draft.delivery?.status === "processing") return "等待连接器回执";
  if (draft.status === "approved_queued" && draft.delivery?.status === "pending") return "已排队";
  if (draft.status === "approved_queued") return "需要处理";
  if (draft.status === "discarded") return "已丢弃";
  return "草稿";
}
function deliveryStatusClass(draft: Draft): string {
  const label = deliveryStatusLabel(draft);
  if (label === "已发送") return "bg-emerald-100 text-emerald-700";
  if (label === "发送失败") return "bg-red-100 text-red-700";
  if (label === "需要处理") return "bg-amber-100 text-amber-800";
  if (label === "已排队" || label === "等待连接器回执") return "bg-blue-100 text-blue-700";
  if (label === "草稿") return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

export function ProcurementMessageDrafts({ onOpenSla, onOpenSettings }: {
  onOpenSla?: () => void; onOpenSettings?: () => void; onOpenPurchaseOrder?: (purchaseOrderId: string) => void;
}) {
  const { formatShortDateTime: formatTime } = useProcurementLocale();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [data, setData] = useState<DraftList>({ items: [], counts: {}, generationReadiness: { status: "sla_policy_missing", publishedPolicyId: null, publishedPolicyVersion: null }, capabilities: NO_DRAFT_CAPABILITIES });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [editReason, setEditReason] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const visible = useMemo(() => filter === "pending" ? data.items.filter((item) => item.status === "draft" || item.status === "approved_queued") : data.items, [data.items, filter]);
  const selected = data.items.find((item) => item.id === selectedId) ?? null;

  const applySelected = useCallback((item: Draft) => {
    setRecipient(item.recipient); setSubject(item.subject); setBody(item.body); setEditReason("");
  }, []);
  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    const result = await apiRequest<{ item: Draft; events: EventItem[]; capabilities?: Partial<DraftCapabilities> }>(`/api/procurement/message-drafts/${encodeURIComponent(id)}`, { signal });
    setData((current) => ({ ...current, capabilities: normalizeCapabilities(result.capabilities), items: current.items.map((item) => item.id === result.item.id ? result.item : item) }));
    applySelected(result.item);
  }, [applySelected]);
  const load = useCallback(async () => {
    abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller; setLoading(true); setError(null);
    try {
      const result = await apiRequest<Omit<DraftList, "capabilities"> & { capabilities?: Partial<DraftCapabilities> }>("/api/procurement/message-drafts?status=all", { signal: controller.signal });
      if (controller.signal.aborted) return;
      setData({ ...result, capabilities: normalizeCapabilities(result.capabilities) });
      if (selectedId && result.items.some((item) => item.id === selectedId)) await loadDetail(selectedId, controller.signal); else setSelectedId(null);
    } catch (requestError) { if (!controller.signal.aborted) setError(errorText(requestError)); }
    finally { if (!controller.signal.aborted) setLoading(false); if (abortRef.current === controller) abortRef.current = null; }
  }, [loadDetail, selectedId]);
  useProcurementRealtimeRefresh(["messages", "outbox", "pos"], () => void load(), 300);
  useEffect(() => { void load(); return () => abortRef.current?.abort(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function select(item: Draft) {
    setSelectedId(item.id); setEditing(false); setError(null); applySelected(item);
    try { await loadDetail(item.id); } catch (requestError) { setError(errorText(requestError)); }
  }
  function cancelEdit() { setEditing(false); if (selected) applySelected(selected); }
  async function saveEdit() {
    if (!selected || !data.capabilities.edit) return; setBusy("edit"); setError(null); setNotice(null);
    try {
      const result = await apiRequest<{ item: Draft; events: EventItem[] }>(`/api/procurement/message-drafts/${encodeURIComponent(selected.id)}`, { method: "PATCH", body: { expectedVersion: selected.version, recipient, subject, body, reason: editReason } });
      setData((current) => ({ ...current, items: current.items.map((item) => item.id === result.item.id ? result.item : item) }));
      applySelected(result.item); setEditing(false); setNotice("修改已保存，并已记录到审计轨迹");
    } catch (requestError) { setError(errorText(requestError)); } finally { setBusy(null); }
  }
  async function approveAndSend() {
    if (!selected || !data.capabilities.approve) return; setBusy("approve"); setError(null); setNotice(null);
    try {
      const result = await apiRequest<{ item: Draft; outbox: { status: string } }>(`/api/procurement/message-drafts/${encodeURIComponent(selected.id)}/approve`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedVersion: selected.version } });
      setData((current) => ({ ...current, items: current.items.map((item) => item.id === result.item.id ? result.item : item) }));
      setNotice(result.outbox.status === "blocked" ? "需要处理：连接器不可用，发送已被安全阻断" : "已排队，正在等待连接器回执"); await loadDetail(selected.id);
    } catch (requestError) { setError(errorText(requestError)); } finally { setBusy(null); }
  }
  async function discard() {
    if (!selected || !data.capabilities.discard || !uiConfirm("确定丢弃这封邮件草稿吗？此操作将记录到审计轨迹。")) return;
    setBusy("discard"); setError(null); setNotice(null);
    try {
      const result = await apiRequest<{ item: Draft; events: EventItem[] }>(`/api/procurement/message-drafts/${encodeURIComponent(selected.id)}/discard`, { method: "POST", body: { expectedVersion: selected.version, reason: "Discarded by a procurement user in the Web workbench" } });
      setData((current) => ({ ...current, items: current.items.map((item) => item.id === result.item.id ? result.item : item) })); setNotice("邮件草稿已丢弃，并已记录到审计轨迹");
    } catch (requestError) { setError(errorText(requestError)); } finally { setBusy(null); }
  }

  const pendingCount = (data.counts.draft ?? 0) + (data.counts.approved_queued ?? 0);
  const filterClass = "flex items-center rounded-[16px] border px-3.5 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2";
  const activeFilterClass = "border-[rgba(36,99,235,0.4)] bg-[rgba(36,99,235,0.05)] text-[#0f1729]";
  const idleFilterClass = "border-[#eef2f6] bg-white text-[#65758b] hover:bg-[rgba(241,245,249,0.5)]";

  return <div className={cn(READYWORK_PAGE_CONTAINER_CLASS, "-mx-7 -mt-6 w-auto pb-12")}>
    <header className="sticky top-0 z-20 h-[124.25px] border-b border-[#eef2f6] bg-[rgba(248,250,252,0.8)] backdrop-blur-xl"><div className="flex items-start justify-between gap-4 px-7 pb-5 pt-3"><div><nav className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[#65758b]" aria-label="面包屑导航"><span className="text-[#0f1729]">邮件草稿</span></nav><h1 className={cn(READYWORK_PAGE_TITLE_CLASS, "leading-[1.5] text-[#0f1729]")}>邮件草稿</h1><p className="mt-0.5 text-[13.5px] text-[#65758b]">智能体起草的跟进与升级邮件，可在发送前审核和编辑。</p></div></div></header>
    <div className="px-7 py-6 pb-12">
      <div className="mb-4 flex items-center gap-2"><button type="button" onClick={() => setFilter("pending")} className={cn(filterClass, filter === "pending" ? activeFilterClass : idleFilterClass)}>待处理<span className="ml-1.5 rounded-full bg-[#f5a000] px-1.5 text-[10px] font-bold text-white">{pendingCount}</span></button><button type="button" onClick={() => setFilter("all")} className={cn(filterClass, filter === "all" ? activeFilterClass : idleFilterClass)}>全部</button></div>
      {error && <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}
      {notice && <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</div>}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <div className="draft-list overflow-hidden rounded-3xl border border-[#eef2f6] bg-white shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
          {loading && !data.items.length ? <div className="flex min-h-[266px] items-center justify-center text-sm text-[#65758b]"><Loader2 className="mr-2 size-5 animate-spin" />正在加载…</div> : visible.map((item) => <button type="button" key={item.id} onClick={() => void select(item)} className={cn("flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-[rgba(241,245,249,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/60", selected?.id === item.id && "bg-[rgba(36,99,235,0.05)]")}><span className="flex items-center justify-between gap-2"><span data-preserve-language className="truncate text-[13.5px] font-semibold text-[#0f1729]">{item.subject}</span><span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", deliveryStatusClass(item))}>{deliveryStatusLabel(item)}</span></span><span className="truncate text-[12px] text-[#65758b]">收件人：<span data-preserve-language>{item.recipient}</span> · {relativeTime(item.updatedAt)}</span></button>)}
          {!loading && !visible.length && <div className="flex flex-col items-center gap-2 py-20 text-center"><Mail className="size-7 text-slate-300" /><div className="text-[13px] text-[#65758b]">暂无需要审核的邮件草稿。</div></div>}
        </div>
        <div className="min-w-0 rounded-3xl border border-[#eef2f6] bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
          {selected ? editing && selected.status === "draft" && data.capabilities.edit ? <form aria-labelledby="edit-draft-title" onSubmit={(event) => { event.preventDefault(); void saveEdit(); }} className="space-y-4"><h2 id="edit-draft-title" className="text-[15px] font-semibold text-[#111827]">编辑邮件草稿</h2><label className="block"><span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">收件人</span><input aria-label="收件人" placeholder="supplier@example.com" value={recipient} onChange={(event) => setRecipient(event.target.value)} autoComplete="off" spellCheck={false} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label><label className="block"><span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">主题</span><input aria-label="主题" value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label><label className="block"><span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">正文</span><textarea aria-label="正文" value={body} onChange={(event) => setBody(event.target.value)} className="mt-1.5 min-h-[280px] w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 outline-none focus:border-blue-400" /></label><label className="block"><span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">编辑原因</span><textarea aria-label="编辑原因" value={editReason} onChange={(event) => setEditReason(event.target.value)} placeholder="说明修改收件人或邮件内容的原因，该内容将进入审计轨迹" className="mt-1.5 min-h-24 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm leading-6 outline-none focus:border-blue-400" /></label><div className="flex flex-wrap items-center gap-2 pt-1"><button type="submit" disabled={busy === "edit" || !recipient.trim() || !subject.trim() || !body.trim() || !editReason.trim()} className="flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-100 disabled:opacity-50">{busy === "edit" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}{busy === "edit" ? "正在保存…" : "保存修改"}</button><button type="button" onClick={cancelEdit} disabled={busy === "edit"} className="flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm disabled:opacity-50"><X className="size-4" />取消</button></div></form> : <div className="space-y-5"><div><div className="flex flex-wrap items-center gap-2"><span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", deliveryStatusClass(selected))}>{deliveryStatusLabel(selected)}</span><span data-preserve-language className="rounded-md bg-[#f1f5f9] px-1.5 py-0.5 text-[10px] font-medium text-[#65758b]">{selected.decisionContext?.label ?? categoryLabel[selected.category] ?? selected.category}</span><span className="text-[12px] text-[rgba(101,117,139,0.8)]">{formatTime(selected.updatedAt)}</span></div><h2 data-preserve-language className="mt-2 text-[17px] font-bold tracking-[-0.02em] text-[#0f1729]">{selected.subject}</h2><p className="mt-0.5 text-[13px] text-[#65758b]">收件人：<span data-preserve-language>{selected.recipient}</span></p></div><p data-preserve-language className="whitespace-pre-wrap text-[13px] leading-relaxed text-[#65758b]">{selected.body}</p><div className="flex flex-wrap gap-2">{selected.status === "draft" && <>{data.capabilities.approve && <button type="button" onClick={() => void approveAndSend()} disabled={Boolean(busy) || !selected.senderIdentity} title={!selected.senderIdentity ? "请先配置面向供应商的发件人身份" : "批准并加入真实发送队列"} className="inline-flex h-9 items-center justify-center gap-2 rounded-[16px] bg-[#2463eb] px-4 py-2 text-sm font-medium text-white disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2">{busy === "approve" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}批准并加入发送队列</button>}{data.capabilities.edit && <button type="button" onClick={() => setEditing(true)} disabled={Boolean(busy)} className="inline-flex h-9 items-center justify-center gap-2 rounded-[16px] border border-[#eef2f6] bg-white px-4 py-2 text-sm font-medium text-[#0f1729] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2"><Edit3 className="size-4" />编辑</button>}{data.capabilities.discard && <button type="button" onClick={() => void discard()} disabled={Boolean(busy)} className="inline-flex h-9 items-center justify-center gap-2 rounded-[16px] border border-[#eef2f6] bg-white px-4 py-2 text-sm font-medium text-[#0f1729] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2"><Trash2 className="size-4" />丢弃</button>}</>}</div></div> : <div className="flex flex-col items-center gap-2 py-20 text-center"><Mail className="size-7 text-slate-300" /><div className="text-[13px] text-[#65758b]">{visible.length ? "选择一封邮件草稿进行审核。" : data.generationReadiness.status === "sla_policy_missing" ? "当前没有已发布的 SLA 策略。" : data.generationReadiness.status === "communication_identity_missing" ? "尚未配置专业发件人身份。" : "暂无可用的邮件草稿。"}</div>{!visible.length && data.generationReadiness.status === "sla_policy_missing" && onOpenSla && <button type="button" onClick={onOpenSla} className="mt-3 h-9 rounded-[16px] bg-[#2463eb] px-4 text-sm font-medium text-white">配置 SLA</button>}{!visible.length && data.generationReadiness.status === "communication_identity_missing" && onOpenSettings && <button type="button" onClick={onOpenSettings} className="mt-3 h-9 rounded-[16px] bg-amber-600 px-4 text-sm font-medium text-white">打开配置</button>}</div>}
        </div>
      </section>
    </div>
  </div>;
}
