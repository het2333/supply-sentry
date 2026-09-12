"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, FileText, History, Loader2, RefreshCw, ShoppingCart, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";

export type ProcurementDomainMode = "orders" | "suppliers" | "documents" | "ai-records";

type WorkbenchItem = {
  id?: string; externalId?: string; name?: string; title?: string; status?: string; version?: number;
  supplierId?: string; supplierReference?: string; poId?: string; shipmentId?: string; invoiceId?: string;
  currency?: string; performanceScore?: number | null; contactCount?: number; carrier?: string | null;
  trackingNumber?: string | null; warehouseId?: string; invoiceNumber?: string; result?: string;
  businessObjectId?: string; businessObjectType?: string; channel?: string; direction?: string;
  messageId?: string; subject?: string | null; attachmentCount?: number; occurredAt?: string;
  action?: string; actor?: string; summary?: string; objectId?: string | null; createdAt?: string;
  updatedAt?: string; orderedAt?: string; confirmedAt?: string; shippedAt?: string; receivedAt?: string;
  invoiceDate?: string; at?: string;
};
type DocumentSection = { total?: number; byStatus?: Record<string, number>; items?: WorkbenchItem[] };
type WorkbenchPayload = {
  documents?: {
    suppliers?: DocumentSection; requisitions?: DocumentSection; rfqs?: DocumentSection; quotes?: DocumentSection;
    awards?: DocumentSection; purchaseOrders?: DocumentSection; confirmations?: DocumentSection; shipments?: DocumentSection;
    receipts?: DocumentSection; invoices?: DocumentSection; matches?: DocumentSection; communications?: DocumentSection;
  };
  recentActivities?: { total?: number; items?: WorkbenchItem[] };
};

const MODE_COPY: Record<ProcurementDomainMode, { title: string; description: string; empty: string; icon: typeof ShoppingCart }> = {
  orders: { title: "采购订单", description: "查看订单、供应商确认、发运与收货的真实记录。", empty: "暂无采购订单或交付记录", icon: ShoppingCart },
  suppliers: { title: "供应商", description: "查看供应商档案摘要与可关联的报价数量。", empty: "暂无供应商档案", icon: Users },
  documents: { title: "文档", description: "查看通信元数据、发票、匹配与采购订单；不展示通信正文。", empty: "暂无可展示的采购文档", icon: FileText },
  "ai-records": { title: "AI 工作记录", description: "查看采购流程留下的审计活动时间线。", empty: "暂无采购流程活动记录", icon: History },
};

const statusLabel = (status?: string) => ({ draft: "草稿", sent: "已发送", received: "已接收", confirmed: "已确认", shipped: "已发运", completed: "已完成", matched: "已匹配", posted: "已入账", active: "启用", inactive: "停用" }[status ?? ""] ?? status ?? "状态未提供");
const activityLabel = (action?: string) => ({ "task.completed": "任务已完成", "task.approved": "审批已通过", "task.resumed": "任务已恢复", "task.waiting": "任务等待中", "tool.called": "已调用业务工具", "context.event": "收到业务事件", "employee.status_changed": "采购员工状态已更新", "budget.recorded": "执行成本已记录" }[action ?? ""] ?? action ?? "流程活动");
const text = (value: unknown, fallback = "未提供") => typeof value === "string" && value.trim() ? value : fallback;
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
const time = (item: WorkbenchItem) => [item.at, item.occurredAt, item.updatedAt, item.receivedAt, item.shippedAt, item.confirmedAt, item.orderedAt, item.createdAt, item.invoiceDate].find((value) => typeof value === "string" && value) as string | undefined;
const displayTime = (value?: string) => value ? value.slice(0, 16).replace("T", " ") : "时间未提供";
const identity = (item: WorkbenchItem, prefix: string, index: number) => item.id ?? item.externalId ?? `${prefix}-${index}`;

function apiMessage(error: unknown): string {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 401) return "登录已过期，请重新登录后再读取采购数据。";
    if (error.status === 403) return "当前会话没有读取采购数据的权限。";
    if (error.status === 408) return "读取采购数据超时，请稍后重试。";
    if (error.status === 503) return "采购数据暂时不可用，请稍后重试。";
  }
  return error instanceof Error ? error.message : "读取采购数据失败，请稍后重试。";
}

function Status({ status }: { status?: string }) {
  if (!status) return null;
  const tone: "red" | "amber" | "blue" = /fail|exception|cancel/i.test(status) ? "red" : /pending|draft/i.test(status) ? "amber" : "blue";
  return <Badge tone={tone}>{statusLabel(status)}</Badge>;
}

function RecordCard({ title, detail, status, date, children }: { title: string; detail: string; status?: string; date?: string; children?: ReactNode }) {
  return <div className="rounded-xl border border-slate-200 p-3.5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm font-medium text-slate-800">{title}</div><div className="mt-1 break-words text-xs leading-5 text-slate-500">{detail}</div></div><Status status={status} /></div>{children}{date && <div className="mt-2 text-[11px] text-slate-400">{displayTime(date)}</div>}</div>;
}

function SectionCard({ title, description, total, children }: { title: string; description: string; total?: number; children: React.ReactNode }) {
  return <Card className="min-w-0"><CardHeader><div><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></div><Badge tone="neutral">{count(total)}</Badge></CardHeader><CardContent className="space-y-2.5 pt-4">{children}</CardContent></Card>;
}

export function ProcurementDomainSection({ mode }: { mode: ProcurementDomainMode }) {
  const [data, setData] = useState<WorkbenchPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const copy = MODE_COPY[mode];

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++sequenceRef.current;
    setLoading(true); setError(null);
    try {
      const payload = await apiRequest<WorkbenchPayload>("/api/procurement/workbench", { signal: controller.signal });
      if (!controller.signal.aborted && sequence === sequenceRef.current) setData(payload ?? {});
    } catch (requestError) {
      if (!controller.signal.aborted && sequence === sequenceRef.current) setError(apiMessage(requestError));
    } finally {
      if (sequence === sequenceRef.current) setLoading(false);
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { sequenceRef.current += 1; requestRef.current?.abort(); };
  }, [load]);

  const documents = data?.documents ?? {};
  const suppliers = documents.suppliers?.items ?? [];
  const quotes = documents.quotes?.items ?? [];
  const orders = documents.purchaseOrders?.items ?? [];
  const confirmations = documents.confirmations?.items ?? [];
  const shipments = documents.shipments?.items ?? [];
  const receipts = documents.receipts?.items ?? [];
  const communications = documents.communications?.items ?? [];
  const invoices = documents.invoices?.items ?? [];
  const matches = documents.matches?.items ?? [];
  const activities = data?.recentActivities?.items ?? [];
  const hasContent = mode === "orders" ? orders.length + confirmations.length + shipments.length + receipts.length > 0 : mode === "suppliers" ? suppliers.length > 0 : mode === "documents" ? communications.length + invoices.length + matches.length + orders.length > 0 : activities.length > 0;
  const Icon = copy.icon;

  return <div className="space-y-5">
    <div className="rounded-2xl bg-[#0f3d32] px-5 py-5 text-white shadow-sm md:px-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="mb-2 flex items-center gap-2 text-xs font-medium text-emerald-200"><Icon className="size-3.5" />采购执行</div><h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1><p className="mt-1 max-w-2xl text-sm text-emerald-100/75">{copy.description}</p></div><Button variant="outline" size="sm" className="border-white/20 bg-white/10 text-white hover:bg-white/20" onClick={() => void load()} disabled={loading}><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />刷新</Button></div></div>
    {error && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>重试</Button></div>}
    {loading && !data ? <div className="flex items-center justify-center rounded-2xl border border-slate-200 bg-white py-24 text-sm text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />正在读取采购数据…</div> : !hasContent ? <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-5 py-20 text-center"><AlertTriangle className="mx-auto size-5 text-slate-300" /><p className="mt-3 text-sm text-slate-500">{copy.empty}</p><p className="mt-1 text-xs text-slate-400">这里仅展示采购工作台已返回的真实记录。</p></div> : <>
      {mode === "orders" && <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard title="采购订单" description="来自订单记录" total={documents.purchaseOrders?.total}>{orders.map((item, index) => <RecordCard key={identity(item, "po", index)} title={text(item.externalId ?? item.id, "订单编号未提供")} detail={`供应商：${text(item.supplierId)} · 币种：${text(item.currency)}`} status={item.status} date={time(item)} />)}</SectionCard>
        <SectionCard title="供应商确认" description="订单确认记录" total={documents.confirmations?.total}>{confirmations.map((item, index) => <RecordCard key={identity(item, "confirmation", index)} title={text(item.supplierReference ?? item.id, "确认记录未提供")} detail={`关联订单：${text(item.poId)} · 供应商：${text(item.supplierId)}`} status={item.status} date={time(item)} />)}</SectionCard>
        <SectionCard title="发运" description="物流状态与承运信息" total={documents.shipments?.total}>{shipments.map((item, index) => <RecordCard key={identity(item, "shipment", index)} title={text(item.trackingNumber ?? item.id, "发运记录未提供")} detail={`关联订单：${text(item.poId)} · 承运商：${text(item.carrier)}`} status={item.status} date={time(item)} />)}</SectionCard>
        <SectionCard title="收货" description="仓库收货记录" total={documents.receipts?.total}>{receipts.map((item, index) => <RecordCard key={identity(item, "receipt", index)} title={text(item.externalId ?? item.id, "收货记录未提供")} detail={`关联订单：${text(item.poId)} · 仓库：${text(item.warehouseId)}`} status={item.status} date={time(item)} />)}</SectionCard>
      </div>}
      {mode === "suppliers" && <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{suppliers.map((item, index) => { const quoteCount = item.id ? quotes.filter((quote) => quote.supplierId === item.id).length : 0; return <RecordCard key={identity(item, "supplier", index)} title={text(item.name, "供应商名称未提供")} detail={`联系人：${count(item.contactCount)} · 绩效评分：${item.performanceScore ?? "未提供"}`} status={item.status} date={time(item)}><div className="mt-3 flex flex-wrap gap-2"><Badge tone="neutral">币种：{text(item.currency)}</Badge><Badge tone="neutral">当前返回报价：{quoteCount}</Badge></div></RecordCard>; })}</div>}
      {mode === "documents" && <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard title="业务通信" description="仅展示渠道、方向、主题和附件数" total={documents.communications?.total}>{communications.map((item, index) => <RecordCard key={identity(item, "communication", index)} title={text(item.subject ?? item.messageId, "通信记录未提供主题")} detail={`渠道：${text(item.channel)} · ${text(item.direction)} · 附件：${count(item.attachmentCount)}`} status={item.status} date={time(item)} />)}</SectionCard>
        <SectionCard title="发票" description="供应商发票摘要" total={documents.invoices?.total}>{invoices.map((item, index) => <RecordCard key={identity(item, "invoice", index)} title={text(item.invoiceNumber ?? item.id, "发票编号未提供")} detail={`供应商：${text(item.supplierId)} · 币种：${text(item.currency)}`} status={item.status} date={time(item)} />)}</SectionCard>
        <SectionCard title="三单匹配" description="订单与发票的匹配结果" total={documents.matches?.total}>{matches.map((item, index) => <RecordCard key={identity(item, "match", index)} title={text(item.id, "匹配记录未提供")} detail={`订单：${text(item.poId)} · 发票：${text(item.invoiceId)} · 结果：${text(item.result)}`} status={item.status} date={time(item)} />)}</SectionCard>
        <SectionCard title="采购订单" description="可关联的订单摘要" total={documents.purchaseOrders?.total}>{orders.map((item, index) => <RecordCard key={identity(item, "document-po", index)} title={text(item.externalId ?? item.id, "订单编号未提供")} detail={`供应商：${text(item.supplierId)} · 币种：${text(item.currency)}`} status={item.status} date={time(item)} />)}</SectionCard>
      </div>}
      {mode === "ai-records" && <Card><CardHeader><div><CardTitle>活动时间线</CardTitle><CardDescription>记录由采购流程产生，按工作台返回的顺序展示。</CardDescription></div><Badge tone="neutral">{count(data?.recentActivities?.total)}</Badge></CardHeader><CardContent className="space-y-3 pt-4">{activities.map((item, index) => <div key={identity(item, "activity", index)} className="flex gap-3"><div className="mt-1.5 size-2 shrink-0 rounded-full bg-emerald-500" /><div className="min-w-0 flex-1 border-b border-slate-100 pb-3"><div className="text-sm font-medium text-slate-800">{activityLabel(item.action)}</div><div className="mt-1 break-words text-xs leading-5 text-slate-500">{text(item.summary, "未提供活动摘要")} · 执行者：{text(item.actor)} · 对象：{text(item.objectId ?? item.businessObjectId)}</div><div className="mt-1 text-[11px] text-slate-400">{displayTime(time(item))}</div></div></div>)}</CardContent></Card>}
    </>}
  </div>;
}
