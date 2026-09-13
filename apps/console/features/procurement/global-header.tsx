"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell, Building2, CheckCircle2, ChevronDown, FileText, Loader2, LogOut, Mail, PackageSearch,
  Search, ShoppingCart, UserRound, UsersRound, X,
} from "lucide-react";
import { CommandMenu } from "@/components/ui/command-menu";
import { apiRequest, notifyAuthenticationRequired } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { useProcurementRealtimeRefresh, useProcurementRealtimeStatus } from "@/features/procurement/realtime-events";
import { cn } from "@/lib/utils";
import { LanguageSwitcher } from "@/features/localization/ui-language";
import { usePublicDemo } from "@/features/public-demo/public-demo-context";

export type ProcurementHeaderTarget = "home" | "orders" | "suppliers" | "notifications" | "message-drafts";

type SearchResult = {
  id: string;
  kind: "purchase_order" | "supplier" | "item" | "message_draft" | "notification" | "communication";
  title: string;
  subtitle: string;
  meta: string;
  targetSection: ProcurementHeaderTarget;
  objectId: string | null;
  updatedAt: string;
};
type SearchPayload = { query: string; items: SearchResult[]; minimumLength: number };
type NotificationItem = {
  id: string; severity: "critical" | "high" | "warning" | "info" | "success"; title: string; message: string;
  tag: string; status: "unread" | "read"; version: number; createdAt: string; objectId: string | null;
  targetSection: "orders" | "message-drafts" | "notifications";
};
type NotificationPayload = { items: NotificationItem[]; counts: { all: number; unread: number; read: number } };
type AccountPayload = { ok: true; account: { username: string; name: string; role: string; humanId: string } };

const kindMeta: Record<SearchResult["kind"], { label: string; icon: typeof Search; tone: string }> = {
  purchase_order: { label: "采购订单", icon: ShoppingCart, tone: "bg-blue-50 text-blue-600" },
  supplier: { label: "供应商", icon: UsersRound, tone: "bg-violet-50 text-violet-600" },
  item: { label: "物料", icon: PackageSearch, tone: "bg-emerald-50 text-emerald-600" },
  message_draft: { label: "沟通草稿", icon: Mail, tone: "bg-amber-50 text-amber-600" },
  notification: { label: "通知", icon: Bell, tone: "bg-red-50 text-red-500" },
  communication: { label: "供应商沟通", icon: FileText, tone: "bg-sky-50 text-sky-600" },
};
const severityDot: Record<NotificationItem["severity"], string> = {
  critical: "bg-red-600", high: "bg-red-500", warning: "bg-amber-500", info: "bg-blue-500", success: "bg-emerald-500",
};

function initials(name?: string): string {
  const value = name?.trim() || "用户";
  return value.length <= 2 ? value : value.slice(-2);
}
export function ProcurementGlobalHeader({
  title,
  onNavigate,
  integrated = false,
  showSearch = true,
}: {
  title: string;
  onNavigate: (destination: ProcurementHeaderTarget, objectId?: string | null) => void;
  integrated?: boolean;
  showSearch?: boolean;
}) {
  const { formatShortDateTime } = useProcurementLocale();
  const publicDemo = usePublicDemo();
  const realtime = useProcurementRealtimeStatus();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountPayload["account"] | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const searchSequence = useRef(0);

  const loadNotifications = useCallback(async () => {
    try {
      const payload = await apiRequest<NotificationPayload>("/api/procurement/notifications?filter=unread");
      setNotifications(payload.items);
      setUnreadCount(payload.counts.unread);
      setNotificationError(null);
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "通知读取失败");
    }
  }, []);

  useProcurementRealtimeRefresh(["notifications"], () => void loadNotifications());

  useEffect(() => {
    void loadNotifications();
    void apiRequest<AccountPayload>("/api/auth/me").then((payload) => setAccount(payload.account)).catch(() => setAccount(null));
    const timer = window.setInterval(() => void loadNotifications(), 60_000);
    return () => window.clearInterval(timer);
  }, [loadNotifications]);

  useEffect(() => {
    const normalized = query.trim();
    const sequence = ++searchSequence.current;
    setSearchError(null);
    if (normalized.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void apiRequest<SearchPayload>(`/api/procurement/search?q=${encodeURIComponent(normalized)}`, { signal: controller.signal })
        .then((payload) => { if (sequence === searchSequence.current) setResults(payload.items); })
        .catch((error) => { if (!controller.signal.aborted && sequence === searchSequence.current) setSearchError(error instanceof Error ? error.message : "搜索失败"); })
        .finally(() => { if (sequence === searchSequence.current) setSearching(false); });
    }, 260);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  function openResult(result: SearchResult) {
    setSearchOpen(false);
    onNavigate(result.targetSection, result.objectId);
  }

  async function openNotification(item: NotificationItem) {
    try {
      if (item.status === "unread") {
        await apiRequest(`/api/procurement/notifications/${encodeURIComponent(item.id)}/read`, { method: "POST", body: { expectedVersion: item.version } });
        setNotifications((current) => current.filter((entry) => entry.id !== item.id));
        setUnreadCount((current) => Math.max(0, current - 1));
      }
      setNotificationOpen(false);
      onNavigate(item.targetSection, item.objectId);
    } catch (error) {
      setNotificationError(error instanceof Error ? error.message : "通知状态更新失败");
      void loadNotifications();
    }
  }

  async function signOut() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await apiRequest("/api/auth/logout", { method: "POST", body: {} });
    } finally {
      setAccount(null);
      setAccountOpen(false);
      setLoggingOut(false);
      notifyAuthenticationRequired("signed_out");
    }
  }

  return <header className={cn(
    "z-40 flex h-[76px] items-center gap-4",
    integrated
      ? "sticky top-0 border-b border-[#e5e9ef] bg-white/95 px-4 backdrop-blur-xl md:px-7 xl:pointer-events-none xl:absolute xl:right-7 xl:top-0 xl:w-auto xl:justify-end xl:gap-2.5 xl:border-0 xl:bg-transparent xl:px-0 xl:backdrop-blur-none"
      : "sticky top-0 border-b border-[#e5e9ef] bg-white/95 px-4 backdrop-blur-xl md:px-7",
  )}>
    <LanguageSwitcher className={integrated ? "xl:pointer-events-auto" : ""} />
    {publicDemo.demoMode && <span data-preserve-language className={cn("hidden shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-mono text-[10px] font-bold text-amber-800 sm:inline-flex", integrated && "xl:pointer-events-auto")}>DEMO G{publicDemo.generation ?? "…"}</span>}
    <div className={cn("min-w-0 flex-1 lg:max-w-[340px]", integrated && "xl:hidden")}>
      <div className="truncate text-[17px] font-bold tracking-[-0.02em] text-[#182033]">{title}</div>
      <div className="mt-0.5 hidden text-[11px] text-[#939aa7] sm:block">PO 发出至交付收货 · 采购执行 V1</div>
    </div>

    {showSearch && <div className={cn("relative ml-auto w-full max-w-[390px]", integrated && "xl:pointer-events-auto xl:w-[200px] xl:max-w-[200px] xl:flex-none")}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 z-10 size-4 -translate-y-1/2 text-[#98a1b1]" />
      {searchOpen && query.trim().length >= 2 ? <button type="button" aria-label="关闭搜索结果" className="fixed inset-0 z-40 cursor-default" onClick={() => setSearchOpen(false)} /> : null}
      <CommandMenu
        ariaLabel="全局采购搜索"
        inputAriaLabel="全局采购搜索"
        query={query}
        onQueryChange={(value) => { setQuery(value); setSearchOpen(true); }}
        onInputFocus={() => setSearchOpen(true)}
        onInputKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setSearchOpen(false); } }}
        items={results.map((result) => ({ id: result.id, label: result.title, keywords: [result.subtitle, result.meta] }))}
        onSelect={(id) => { const result = results.find((item) => item.id === id); if (result) openResult(result); }}
        shouldFilter={false}
        open={searchOpen && query.trim().length >= 2}
        loading={searching}
        error={searchError}
        placeholder="搜索 PO、供应商、物料…"
        empty={<div className="py-1"><PackageSearch className="mx-auto size-7 text-[#c2c8d1]" /><div className="mt-2 font-medium text-[#677184]">没有找到匹配的真实记录</div><div className="mt-1 text-[11px] text-[#a0a7b2]">可搜索 PO 编号、供应商、物料、通知或沟通主题</div></div>}
        className="overflow-visible rounded-none border-0 bg-transparent shadow-none"
        inputClassName={cn("h-10 rounded-xl border border-[#dfe4eb] bg-[#fbfcfd] pl-10 pr-9 text-xs text-[#334056] transition placeholder:text-[#9da5b2] focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-50", integrated && "xl:h-9")}
        listClassName="absolute right-0 top-12 z-50 w-[min(440px,calc(100vw-32px))] max-h-[430px] overflow-y-auto rounded-2xl border border-[#dfe4eb] bg-white p-1.5 shadow-[0_20px_55px_rgba(30,42,65,0.18)]"
        renderItem={(item) => { const result = results.find((entry) => entry.id === item.id)!; const meta = kindMeta[result.kind]; const Icon = meta.icon; return <div className="flex w-full items-center gap-3 py-1"><span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", meta.tone)}><Icon className="size-4" /></span><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span data-preserve-language className="truncate text-xs font-semibold text-[#273248]">{result.title}</span><span className="shrink-0 text-[9px] font-semibold text-[#98a1ae]">{meta.label}</span></span><span data-preserve-language className="mt-1 block truncate text-[11px] text-[#7f8999]">{result.subtitle}</span></span><span data-preserve-language className="shrink-0 rounded-full bg-[#f1f3f6] px-2 py-1 text-[9px] font-medium text-[#758093]">{result.meta}</span></div>; }}
      />
      {query ? <button type="button" aria-label="清空搜索" onClick={() => { setQuery(""); setResults([]); }} className="absolute right-2.5 top-2.5 z-10 text-[#a0a7b2] hover:text-[#596273]"><X className="size-4" /></button> : <span className="pointer-events-none absolute right-3 top-2.5 z-10 hidden rounded border border-[#e4e7ec] px-1.5 py-0.5 text-[9px] text-[#a0a7b2] sm:block">⌘K</span>}
    </div>}

    <div className={cn("relative", integrated && "xl:pointer-events-auto")}>
      <button type="button" aria-label="打开通知" title={realtime.status === "live" ? "采购事件实时连接正常" : realtime.status === "retrying" ? "实时连接正在自动恢复" : "正在连接采购事件流"} onClick={() => { setNotificationOpen((open) => !open); setAccountOpen(false); }} className={cn("relative flex size-10 items-center justify-center rounded-xl border border-[#e1e5eb] bg-white text-[#6d7788] shadow-sm transition hover:bg-[#f7f9fb]", integrated && "xl:size-9")}>
        <Bell className="size-[18px]" />
        <span className={cn("absolute bottom-1 right-1 size-1.5 rounded-full ring-2 ring-white", realtime.status === "live" ? "bg-emerald-500" : realtime.status === "retrying" ? "animate-pulse bg-amber-500" : "animate-pulse bg-blue-500")} />
        {unreadCount > 0 && <span className="absolute -right-1.5 -top-1.5 flex min-w-5 items-center justify-center rounded-full border-2 border-white bg-[#ef4444] px-1 text-[9px] font-bold leading-4 text-white">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
      {notificationOpen && <>
        <button type="button" aria-label="关闭通知" className="fixed inset-0 z-40 cursor-default" onClick={() => setNotificationOpen(false)} />
        <div className="absolute right-0 top-12 z-50 w-[min(390px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-[#dfe4eb] bg-white shadow-[0_20px_55px_rgba(30,42,65,0.18)]">
          <div className="flex items-center justify-between border-b border-[#edf0f4] px-4 py-3"><div><div className="text-sm font-bold text-[#273248]">未读通知</div><div className="mt-0.5 text-[10px] text-[#929ba9]">{unreadCount} 项需要查看</div></div><button type="button" onClick={() => { setNotificationOpen(false); onNavigate("notifications"); }} className="text-[11px] font-semibold text-blue-600">查看全部</button></div>
          {notificationError && <div role="alert" className="border-b border-red-100 bg-red-50 px-4 py-2 text-[11px] text-red-600">{notificationError}</div>}
          <div className="max-h-[420px] overflow-y-auto p-1.5">{notifications.length === 0 ? <div className="px-5 py-10 text-center"><CheckCircle2 className="mx-auto size-8 text-emerald-500" /><div className="mt-2 text-xs font-semibold text-[#596476]">没有未读通知</div><div className="mt-1 text-[11px] text-[#9aa2ae]">状态来自持久化通知中心</div></div> : notifications.slice(0, 12).map((item) => <button type="button" key={item.id} onClick={() => void openNotification(item)} className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left hover:bg-[#f7f9fb]"><span className={cn("mt-1.5 size-2 shrink-0 rounded-full", severityDot[item.severity])} /><span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-[#334056]">{item.title}</span><span className="mt-1 line-clamp-2 block text-[11px] leading-5 text-[#7e8898]">{item.message}</span><span className="mt-1.5 block text-[10px] text-[#a0a7b2]">{item.tag} · {formatShortDateTime(item.createdAt)}</span></span></button>)}</div>
        </div>
      </>}
    </div>

    <div className={cn("relative hidden sm:block", integrated && "xl:pointer-events-auto")}>
      <button type="button" aria-label="打开当前用户菜单" onClick={() => { setAccountOpen((open) => !open); setNotificationOpen(false); }} className={cn("flex h-10 items-center gap-2 rounded-xl border border-[#e1e5eb] bg-white px-2.5 shadow-sm hover:bg-[#f7f9fb]", integrated && "xl:h-[38px] xl:w-[146px]")}>
        <span data-preserve-language={account ? true : undefined} className="flex size-7 items-center justify-center rounded-full bg-[#172033] text-[10px] font-bold text-white">{initials(account?.name)}</span>
        <span data-preserve-language={account ? true : undefined} className="hidden max-w-[110px] truncate text-xs font-semibold text-[#364156] xl:block">{account?.name ?? "读取身份…"}</span>
        <ChevronDown className="size-3.5 text-[#929baa]" />
      </button>
      {accountOpen && <>
        <button type="button" aria-label="关闭用户菜单" className="fixed inset-0 z-40 cursor-default" onClick={() => setAccountOpen(false)} />
        <div className="absolute right-0 top-12 z-50 w-64 rounded-2xl border border-[#dfe4eb] bg-white p-4 shadow-[0_20px_55px_rgba(30,42,65,0.18)]"><div className="flex items-center gap-3"><span data-preserve-language={account ? true : undefined} className="flex size-10 items-center justify-center rounded-full bg-[#172033] text-xs font-bold text-white">{initials(account?.name)}</span><div className="min-w-0"><div data-preserve-language={account ? true : undefined} className="truncate text-sm font-bold text-[#273248]">{account?.name ?? "身份不可用"}</div><div data-preserve-language={account ? true : undefined} className="mt-0.5 truncate text-[11px] text-[#8993a2]">{account?.username ?? "未登录"}</div></div></div><div className="mt-4 space-y-2 border-t border-[#edf0f4] pt-3"><div className="flex items-center gap-2 text-[11px] text-[#6e7889]"><UserRound className="size-3.5" />角色：{account?.role ?? "未知"}</div><div className="flex items-center gap-2 text-[11px] text-[#6e7889]"><Building2 className="size-3.5" />采购执行工作区</div></div><button type="button" onClick={() => void signOut()} disabled={loggingOut} className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-[#e2e6ec] text-xs font-semibold text-[#667184] hover:bg-[#f7f9fb] disabled:opacity-50">{loggingOut ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}退出登录</button></div>
      </>}
    </div>
  </header>;
}
