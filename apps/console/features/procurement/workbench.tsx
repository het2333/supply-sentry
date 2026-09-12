"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, BriefcaseBusiness, ClipboardList, FileCheck2, Loader2, RefreshCw, ShoppingCart, Workflow, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";

type ProcurementSection = "requisitions" | "rfq" | "tasks" | "approvals" | "suppliers" | "documents" | "org" | "settings";
type WorkbenchItem = {
  id?: string; title?: string; name?: string; summary?: string; message?: string; type?: string; severity?: string;
  status?: string; supplierName?: string; supplierId?: string; invoiceNumber?: string; workflowId?: string;
  businessObjectId?: string; objectId?: string; action?: string; actor?: string; amount?: number; currency?: string;
  at?: string; createdAt?: string; requestedAt?: string; _navigateTo?: ProcurementSection; _category?: string;
};
interface WorkbenchPayload {
  counts?: { requisitions?: number; rfqs?: number; purchaseOrders?: number; invoices?: number; pendingTasks?: number; pendingApprovals?: number; openExceptions?: number };
  documents?: { requisitions?: { total?: number; items?: WorkbenchItem[] }; rfqs?: { total?: number; items?: WorkbenchItem[] }; purchaseOrders?: { total?: number; items?: WorkbenchItem[] }; invoices?: { total?: number; items?: WorkbenchItem[] } };
  tasks?: { items?: WorkbenchItem[] }; approvals?: { items?: WorkbenchItem[] }; exceptions?: { items?: WorkbenchItem[] }; recentActivities?: { items?: WorkbenchItem[] };
  views?: {
    contacts?: { total?: number; items?: WorkbenchItem[] };
    items?: { total?: number; items?: WorkbenchItem[] };
    inbox?: { total?: number; items?: WorkbenchItem[] };
    alerts?: { total?: number; items?: WorkbenchItem[] };
    news?: { total?: number; items?: WorkbenchItem[]; status?: "connected" | "unconfigured" | "error"; message?: string };
  };
}

const statusLabel = (status?: string) => ({
  open: "进行中", assigned: "已分配", submitted: "已提交", draft: "草稿", sent: "已发送", received: "已接收",
  posted: "已过账", waiting_approval: "待审批", pending: "待处理", running: "执行中", waiting_external: "等待外部",
  failed: "异常", completed: "已完成", matched: "已匹配", pending_approval: "待审批", exception: "异常",
}[status ?? ""] ?? status ?? "待处理");

const activityLabel: Record<string, string> = {
  "task.completed": "任务已完成", "task.approved": "任务审批通过", "task.resumed": "任务已恢复", "task.waiting": "任务正在等待",
  "tool.called": "已调用业务工具", "context.event": "收到业务事件", "employee.status_changed": "采购员工状态已更新", "budget.recorded": "执行成本已记录",
};
const itemLabel = (item: WorkbenchItem) => item.title ?? item.name ?? (item.action ? activityLabel[item.action] : undefined) ?? item.summary ?? item.invoiceNumber ?? item.type ?? item.workflowId ?? item.id ?? "未命名记录";
const itemMeta = (item: WorkbenchItem) => {
  const detail = item.message ?? item.supplierName ?? item.supplierId ?? item.businessObjectId ?? item.objectId ?? item.actor ?? item.currency ?? "真实业务记录";
  return item._category ? `${item._category} · ${detail}` : detail;
};
const itemTime = (item: WorkbenchItem) => item.at ?? item.requestedAt ?? item.createdAt;

function apiMessage(error: unknown): string {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 403) return "当前会话没有读取采购工作台的权限。";
    if (error.status === 401) return "登录已过期，请重新登录后再读取采购数据。";
    if (error.status === 408) return "采购工作台请求超时，请稍后重试。";
    if (error.status === 409) return "采购工作台数据暂时不可用（409），请稍后重试。";
    if (error.status === 503) {
      const code = error.payload && typeof error.payload === "object" && "code" in error.payload ? String((error.payload as { code?: unknown }).code) : "";
      return code === "WORKBENCH_READ_TIMEOUT" ? "工作台数据读取超时，请稍后重试。" : "工作台数据暂时不可用，请稍后重试。";
    }
  }
  return error instanceof Error ? error.message : "采购工作台请求失败，请稍后重试。";
}

function Metric({ label, value, hint, icon: Icon }: { label: string; value: string; hint: string; icon: typeof BriefcaseBusiness }) {
  return <Card><CardContent className="p-4"><div className="flex items-center justify-between"><span className="text-xs text-slate-500">{label}</span><Icon className="size-4 text-slate-400" /></div><div className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">{value}</div><div className="mt-1 text-[11px] text-slate-400">{hint}</div></CardContent></Card>;
}

function ItemList({ items, empty, onOpen }: { items: WorkbenchItem[]; empty: string; onOpen?: (item: WorkbenchItem) => void }) {
  if (items.length === 0) return <div className="rounded-xl border border-dashed border-slate-200 px-3 py-7 text-center text-xs text-slate-400">{empty}</div>;
  return <div className="space-y-2">{items.slice(0, 5).map((item, index) => {
    const time = itemTime(item);
    const content = <><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-slate-800">{itemLabel(item)}</div><div className="mt-1 truncate text-xs text-slate-400">{itemMeta(item)}{time ? ` · ${time.slice(0, 16).replace("T", " ")}` : ""}</div></div>{item.status && <Badge tone={item.status === "failed" || item.status === "exception" ? "red" : item.status.includes("approval") || item.status === "pending" ? "violet" : "blue"}>{statusLabel(item.status)}</Badge>}{onOpen && <ArrowRight className="size-3.5 text-slate-300" />}</>;
    const classes = "flex w-full items-center gap-3 rounded-xl border border-slate-100 px-3 py-2.5 text-left";
    return onOpen
      ? <button type="button" key={item.id ?? `${itemLabel(item)}-${index}`} onClick={() => onOpen(item)} className={`${classes} hover:border-[#b8d8cd] hover:bg-[#f3faf7]`}>{content}</button>
      : <div key={item.id ?? `${itemLabel(item)}-${index}`} className={classes}>{content}</div>;
  })}</div>;
}

function Queue({ title, description, items, empty, icon: Icon, onOpen, total }: { title: string; description: string; items: WorkbenchItem[]; empty: string; icon: typeof ClipboardList; onOpen?: (item?: WorkbenchItem) => void; total?: number }) {
  return <Card className="min-w-0"><CardHeader><div className="flex min-w-0 items-center gap-2"><Icon className="size-4 shrink-0 text-slate-500" /><div className="min-w-0"><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></div></div>{onOpen ? <button type="button" onClick={() => onOpen()} className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-slate-400 hover:text-[#0f3d32]">查看<ArrowRight className="size-3.5" /></button> : <Badge tone="neutral">{total ?? items.length}</Badge>}</CardHeader><CardContent className="pt-4"><ItemList items={items} empty={empty} onOpen={onOpen ? (item) => onOpen(item) : undefined} /></CardContent></Card>;
}

export function ProcurementWorkbench({ onNavigate }: { onNavigate?: (section: ProcurementSection) => void }) {
  const [data, setData] = useState<WorkbenchPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++sequenceRef.current;
    setLoading(true); setError(null);
    try {
      const payload = await apiRequest<WorkbenchPayload>("/api/procurement/workbench", { signal: controller.signal });
      if (controller.signal.aborted || sequence !== sequenceRef.current) return;
      setData(payload ?? {});
    } catch (requestError) {
      if (!controller.signal.aborted && sequence === sequenceRef.current) setError(apiMessage(requestError));
    } finally {
      if (sequence === sequenceRef.current) setLoading(false);
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      sequenceRef.current += 1;
      requestRef.current?.abort();
    };
  }, [load]);
  const counts = data?.counts ?? {};
  const requisitions = data?.documents?.requisitions?.items ?? [];
  const rfqs = data?.documents?.rfqs?.items ?? [];
  const orders = data?.documents?.purchaseOrders?.items ?? [];
  const invoices = data?.documents?.invoices?.items ?? [];
  const tasks = data?.tasks?.items ?? [];
  const approvals = data?.approvals?.items ?? [];
  const exceptions = data?.exceptions?.items ?? [];
  const todayItems: WorkbenchItem[] = [
    ...exceptions.map((item) => ({ ...item, _navigateTo: "approvals" as const, _category: "异常" })),
    ...approvals.map((item) => ({ ...item, _navigateTo: "approvals" as const, _category: "审批" })),
    ...tasks.map((item) => ({ ...item, _navigateTo: "tasks" as const, _category: "任务" })),
  ];
  const activities = data?.recentActivities?.items ?? [];
  const views = data?.views ?? {};
  const contacts = views.contacts?.items ?? [];
  const catalogItems = views.items?.items ?? [];
  const inbox = views.inbox?.items ?? [];
  const alerts = views.alerts?.items ?? [];
  const news = views.news?.items ?? [];
  const searchPool = [
    ...requisitions, ...rfqs, ...orders, ...invoices, ...tasks, ...approvals, ...exceptions, ...activities,
    ...contacts.map((item) => ({ ...item, _category: "联系人" })),
    ...catalogItems.map((item) => ({ ...item, _category: "物料" })),
    ...inbox.map((item) => ({ ...item, _category: "收件箱" })),
    ...alerts.map((item) => ({ ...item, _category: "提醒" })),
    ...news.map((item) => ({ ...item, _category: "新闻" })),
  ];
  const newsStatus = views.news?.status ?? (views.news ? "connected" : "unconfigured");
  const newsEmpty = newsStatus === "unconfigured" ? "新闻源尚未配置" : newsStatus === "error" ? (views.news?.message ?? "新闻源暂时不可用") : "暂无真实新闻";
  const searchResults = search.trim() ? searchPool.filter((item) => JSON.stringify(item).toLowerCase().includes(search.trim().toLowerCase())).slice(0, 12) : [];

  return <div className="space-y-5">
    <div className="overflow-hidden rounded-2xl bg-[#0f3d32] px-5 py-5 text-white shadow-sm md:px-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="mb-2 flex items-center gap-2 text-xs font-medium text-emerald-200"><BriefcaseBusiness className="size-3.5" />采购执行</div><h1 className="text-2xl font-semibold tracking-tight">采购执行工作台</h1><p className="mt-1 max-w-2xl text-sm text-emerald-100/75">从采购需求到询价、订单、三单匹配和异常处理的真实业务概览。</p></div><Button variant="outline" size="sm" className="border-white/20 bg-white/10 text-white hover:bg-white/20" onClick={() => void load()} disabled={loading}><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />刷新</Button></div></div>
    {error && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>重试</Button></div>}
    {loading && !data ? <div className="flex items-center justify-center rounded-2xl border border-slate-200 bg-white py-24 text-sm text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />正在读取真实采购数据…</div> : <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Metric label="待处理任务" value={counts.pendingTasks === undefined ? "—" : String(counts.pendingTasks)} hint="统一 API 数据" icon={Workflow} /><Metric label="采购订单" value={counts.purchaseOrders === undefined ? "—" : String(counts.purchaseOrders)} hint="真实单据总数" icon={ShoppingCart} /><Metric label="采购需求 / RFQ" value={counts.requisitions !== undefined || counts.rfqs !== undefined ? `${counts.requisitions ?? 0} / ${counts.rfqs ?? 0}` : "—"} hint="真实单据总数" icon={ClipboardList} /><Metric label="发票 / 待审批异常" value={counts.invoices !== undefined || counts.pendingApprovals !== undefined || counts.openExceptions !== undefined ? `${counts.invoices ?? 0} / ${(counts.pendingApprovals ?? 0) + (counts.openExceptions ?? 0)}` : "—"} hint="三单与人工判断" icon={FileCheck2} /></div>
      <Card><CardContent className="p-4"><div className="flex items-center gap-2"><Search className="size-4 text-slate-400" /><input aria-label="全局搜索采购记录" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索需求、RFQ、订单、发票、任务或异常" className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-[#78ad99]" /></div>{search.trim() ? <div className="mt-3 space-y-2">{searchResults.length ? searchResults.map((item, index) => <div key={`${item.type ?? item._category ?? "record"}:${item.id ?? itemLabel(item)}:${index}`} className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 p-2 text-sm"><span className="min-w-0 truncate text-slate-800">{itemLabel(item)}</span><span className="shrink-0 text-xs text-slate-400">{item.status ?? item.type ?? "真实记录"}</span></div>) : <div className="py-5 text-center text-xs text-slate-400">没有匹配的真实记录</div>}</div> : null}</CardContent></Card>
      <div className="grid gap-4 xl:grid-cols-2"><Queue title="今天先处理什么" description="来自任务、审批和异常接口的聚合队列。" items={todayItems} empty="暂无需要人工处理的真实事项" icon={AlertTriangle} onOpen={(item) => onNavigate?.(item?._navigateTo ?? "tasks")} /><Queue title="最近活动" description="采购执行链路的真实活动记录。" items={activities} empty="暂无真实活动记录" icon={Workflow} /></div>
      <Card><CardHeader><div><CardTitle>快捷入口</CardTitle><CardDescription>进入采购执行模块，数据以各模块真实接口为准。</CardDescription></div></CardHeader><CardContent className="grid grid-cols-2 gap-2 pt-3 md:grid-cols-4">{[["采购需求", "requisitions"], ["询价与报价", "rfq"], ["任务", "tasks"], ["审批", "approvals"], ["供应商", "suppliers"], ["文档", "documents"], ["组织 / 团队", "org"], ["设置与连接", "settings"]].map(([label, section]) => <button type="button" key={section} onClick={() => onNavigate?.(section as ProcurementSection)} className="flex items-center justify-between rounded-xl border border-slate-200 px-3 py-3 text-left text-sm font-medium text-slate-700 hover:border-[#b8d8cd] hover:bg-[#f3faf7]"><span>{label}</span><ArrowRight className="size-3.5 text-slate-400" /></button>)}</CardContent></Card>
      <div className="grid gap-4 xl:grid-cols-2"><Queue title="采购需求" description="需求进入执行链路" items={requisitions} empty="暂无真实采购需求" icon={ClipboardList} onOpen={() => onNavigate?.("requisitions")} /><Queue title="询价与报价" description="RFQ 草稿和结构化报价" items={rfqs} empty="暂无真实询价记录" icon={Workflow} onOpen={() => onNavigate?.("rfq")} /><Queue title="采购订单" description="订单确认与交付状态" items={orders} empty="暂无真实采购订单" icon={ShoppingCart} /><Queue title="发票 / 三单匹配" description="发票、收货与采购订单" items={invoices} empty="暂无真实发票记录" icon={FileCheck2} /><Queue title="异常队列" description="需要人工判断的业务事项" items={exceptions} empty="暂无真实异常记录" icon={AlertTriangle} /></div>
      <div className="grid gap-4 xl:grid-cols-2"><Queue title="联系人" description="供应商与业务联系人真实记录" items={contacts} total={views.contacts?.total} empty="暂无真实联系人记录" icon={BriefcaseBusiness} onOpen={() => onNavigate?.("suppliers")} /><Queue title="物料" description="采购物料与目录记录" items={catalogItems} total={views.items?.total} empty="暂无真实物料记录" icon={ClipboardList} /><Queue title="收件箱" description="已接入渠道的业务通信" items={inbox} total={views.inbox?.total} empty="暂无真实收件箱记录" icon={Workflow} onOpen={() => onNavigate?.("documents")} /><Queue title="提醒" description="采购执行提醒与告警" items={alerts} total={views.alerts?.total} empty="暂无真实提醒" icon={AlertTriangle} /><Queue title="新闻" description={newsStatus === "connected" ? "已接入新闻源的真实内容" : "外部新闻源连接状态"} items={news} total={views.news?.total} empty={newsEmpty} icon={Workflow} /></div>
    </>}
  </div>;
}
