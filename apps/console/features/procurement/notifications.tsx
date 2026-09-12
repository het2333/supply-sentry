"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bell, CheckCheck, CheckCircle2, Loader2 } from "lucide-react";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { cn } from "@/lib/utils";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { READYWORK_PAGE_CONTAINER_CLASS, READYWORK_PAGE_TITLE_CLASS } from "@/features/procurement/visual-tokens";
import { useProcurementRealtimeRefresh } from "@/features/procurement/realtime-events";

type NotificationStatus = "unread" | "read";
type NotificationFilter = "all" | "unread";
type NotificationSeverity = "critical" | "high" | "warning" | "info" | "success";
type NotificationItem = {
  id: string; type: string; severity: NotificationSeverity; title: string; message: string; tag: string;
  objectType: string | null; objectId: string | null; evidence: Record<string, unknown>;
  status: NotificationStatus; version: number; readBy: string | null; readAt: string | null;
  createdAt: string; updatedAt: string; targetSection: "orders" | "message-drafts" | "notifications";
};
type NotificationList = { items: NotificationItem[]; counts: { all: number; unread: number; read: number }; generatedAt: string | null; capabilities?: { markRead: boolean } };

const emptyData: NotificationList = { items: [], counts: { all: 0, unread: 0, read: 0 }, generatedAt: null, capabilities: { markRead: false } };
const severityDot: Record<NotificationSeverity, string> = {
  critical: "bg-[#ef4444]", high: "bg-[#ef4444]", warning: "bg-[#f59e0b]", info: "bg-[#3b82f6]", success: "bg-[#16a34a]",
};

function relativeTime(value: string, absoluteDate: (value: string) => string): string {
  const timestamp = new Date(value).getTime(); if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚"; const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`; const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`; const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`; return absoluteDate(value);
}
function errorText(error: unknown): string {
  if (error instanceof ReadyworkApiError) return error.message;
  return error instanceof Error ? error.message : "通知请求失败";
}
export function ProcurementNotifications({ onNavigate }: { onNavigate: (destination: "orders" | "message-drafts", objectId?: string | null) => void }) {
  const { formatDate } = useProcurementLocale();
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [data, setData] = useState<NotificationList>(emptyData);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (activeFilter: NotificationFilter) => {
    abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller;
    if (!data.items.length) setLoading(true); setError(null);
    try {
      const result = await apiRequest<NotificationList>(`/api/procurement/notifications?filter=${activeFilter}`, { signal: controller.signal });
      if (!controller.signal.aborted) setData({ ...result, capabilities: { markRead: result.capabilities?.markRead === true } });
    } catch (requestError) { if (!controller.signal.aborted) setError(errorText(requestError)); }
    finally {
      if (!controller.signal.aborted) setLoading(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [data.items.length]);

  useProcurementRealtimeRefresh(["notifications"], () => void load(filter), 250);

  useEffect(() => { void load("all"); return () => abortRef.current?.abort(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function changeFilter(next: NotificationFilter) { setFilter(next); await load(next); }
  async function openNotification(item: NotificationItem) {
    if (busyId) return;
    if (item.status === "unread" && data.capabilities?.markRead === true) {
      setBusyId(item.id); setError(null);
      try {
        const result = await apiRequest<{ item: NotificationItem }>(`/api/procurement/notifications/${encodeURIComponent(item.id)}/read`, { method: "POST", body: { expectedVersion: item.version } });
        setData((current) => ({
          ...current,
          items: filter === "unread" ? current.items.filter((entry) => entry.id !== item.id) : current.items.map((entry) => entry.id === item.id ? result.item : entry),
          counts: { ...current.counts, unread: Math.max(0, current.counts.unread - 1), read: current.counts.read + 1 },
        }));
      } catch (requestError) { setError(errorText(requestError)); setBusyId(null); return; }
      finally { setBusyId(null); }
    }
    if (item.targetSection === "orders" || item.targetSection === "message-drafts") onNavigate(item.targetSection, item.objectId);
  }
  async function markAllRead() {
    if (!data.counts.unread || busyId) return;
    setBusyId("all"); setError(null);
    try {
      const result = await apiRequest<NotificationList & { updated: number }>("/api/procurement/notifications/read-all", { method: "POST" });
      if (filter === "unread") setData({ ...result, items: [], capabilities: { markRead: result.capabilities?.markRead === true } }); else await load(filter);
    } catch (requestError) { setError(errorText(requestError)); } finally { setBusyId(null); }
  }

  const visibleItems = useMemo(() => data.items, [data.items]);
  return <div className={cn(READYWORK_PAGE_CONTAINER_CLASS, "-mx-7 -mt-6 w-auto pb-12")}>
    <header className="sticky top-0 z-20 h-[124.25px] border-b border-[#eef2f6] bg-[rgba(248,250,252,0.8)] backdrop-blur-xl">
      <div className="flex items-start justify-between gap-4 px-7 pb-5 pt-3">
        <div>
          <nav className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[#65758b]" aria-label="面包屑导航"><span>收件箱</span><span className="text-[rgba(101,117,139,0.5)]">/</span><span className="text-[#0f1729]">通知</span></nav>
          <h1 className={cn(READYWORK_PAGE_TITLE_CLASS, "leading-[1.5] text-[#0f1729]")}>通知</h1>
          <p className="mt-0.5 text-[13.5px] text-[#65758b]">升级事项、采购订单事件、SLA 提醒和系统消息。</p>
        </div>
      </div>
    </header>

    <div className="space-y-5 px-7 py-6 pb-12">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {([['all', '全部'], ['unread', '未读']] as Array<[NotificationFilter, string]>).map(([id, label]) => <button key={id} type="button" onClick={() => void changeFilter(id)} disabled={loading} className={cn("flex items-center rounded-[16px] border px-3.5 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2", filter === id ? "border-[rgba(36,99,235,0.4)] bg-[rgba(36,99,235,0.05)] text-[#0f1729]" : "border-[#eef2f6] bg-white text-[#65758b] hover:bg-[rgba(241,245,249,0.5)]")}>{label}{id === 'unread' && data.counts.unread > 0 && <span className="ml-1.5 rounded-full bg-[#ef4444] px-1.5 text-[10px] font-bold text-white">{data.counts.unread}</span>}</button>)}
        </div>
        {data.capabilities?.markRead === true && <div className="flex items-center gap-2">
          <button type="button" onClick={() => void markAllRead()} disabled={!data.counts.unread || Boolean(busyId)} className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-[16px] border border-[#eef2f6] bg-white px-4 py-2 text-sm font-medium text-[#0f1729] shadow-[0_1px_2px_rgba(16,24,40,0.05)] transition-all duration-200 hover:bg-[rgba(241,245,249,0.6)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 focus-visible:ring-offset-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50">{busyId === "all" ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}全部标为已读</button>
        </div>}
      </div>

      {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}

      <section className="notifications-list rounded-3xl border border-[#eef2f6] bg-white p-0 text-[#0f1729] shadow-[0_1px_2px_rgba(16,24,40,0.05)]">
        {loading && !visibleItems.length ? <div className="flex min-h-[440px] items-center justify-center text-sm text-[#969ba8]"><Loader2 className="mr-2 size-5 animate-spin" />正在加载…</div> : visibleItems.map((item) => <button type="button" key={item.id} onClick={() => void openNotification(item)} className={cn("flex w-full items-start gap-3.5 px-5 py-4 text-left transition-colors hover:bg-[rgba(241,245,249,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400/60", item.status === "unread" && "bg-[rgba(241,245,249,0.2)]")}>
          <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", severityDot[item.severity])} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span data-preserve-language className="text-[14px] font-semibold text-[#0f1729]">{item.title}</span>
              <span data-preserve-language className="rounded-md bg-[#f1f5f9] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#65758b]">{item.tag}</span>
            </span>
            <span data-preserve-language className="mt-1 block text-[12.5px] leading-snug text-[#65758b]">{item.message}</span>
            <span className="mt-1 block text-[11.5px] text-[rgba(101,117,139,0.8)]">{relativeTime(item.createdAt, formatDate)}</span>
          </span>
          {busyId === item.id ? <Loader2 className="mt-1.5 size-3.5 shrink-0 animate-spin text-[#2463eb]" /> : item.status === "unread" && <span aria-label="未读" className="mt-1.5 size-2 shrink-0 rounded-full bg-[#2463eb]" />}
        </button>)}
        {!loading && !visibleItems.length && <div className="flex min-h-[440px] flex-col items-center justify-center px-6 text-center"><span className="flex size-14 items-center justify-center rounded-2xl bg-[#f0f4ff] text-[#4b78df]">{filter === "unread" ? <CheckCircle2 className="size-6" /> : <Bell className="size-6" />}</span><div className="mt-4 text-sm font-semibold text-[#3e424c]">{filter === "unread" ? "所有通知均已处理" : "暂无采购通知"}</div><div className="mt-1.5 max-w-sm text-xs leading-5 text-[#8a909d]">{filter === "unread" ? "所有采购活动通知都已查看。" : "采购订单、SLA、连接器或收货状态发生变化时，通知会显示在这里。"}</div></div>}
      </section>
    </div>
  </div>;
}
