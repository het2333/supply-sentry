"use client";

import { ArrowRight, BrainCircuit, CheckCircle2, CircleAlert, Database, Loader2, Mail, MessageCircle, Unplug } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import {
  buildChannelConnectionViews,
  type ChannelConnectionCategory,
  type ChannelConnectionState,
  type ChannelConnectionSummary,
  type ConfigurationConnectionId,
} from "@/features/procurement/channel-connections-view-model";

const iconByConnector = { email: Mail, whatsapp: MessageCircle, wechat: MessageCircle, deepseek: BrainCircuit, erp: Database } as const;
const stateStyles: Record<ChannelConnectionState, { badge: string; icon: string }> = {
  connected: { badge: "bg-emerald-50 text-emerald-700 ring-emerald-200", icon: "bg-emerald-50 text-emerald-600" },
  test_required: { badge: "bg-blue-50 text-blue-700 ring-blue-200", icon: "bg-blue-50 text-blue-600" },
  setup_required: { badge: "bg-amber-50 text-amber-700 ring-amber-200", icon: "bg-amber-50 text-amber-600" },
  attention: { badge: "bg-red-50 text-red-700 ring-red-200", icon: "bg-red-50 text-red-600" },
  disabled: { badge: "bg-slate-100 text-slate-600 ring-slate-200", icon: "bg-slate-100 text-slate-500" },
  unavailable: { badge: "bg-slate-100 text-slate-500 ring-slate-200", icon: "bg-slate-100 text-slate-400" },
};

function truthLabel(value: boolean, ready = "已就绪", blocked = "已阻塞") {
  return value ? ready : blocked;
}

export function ProcurementChannelConnectionsPanel({ connections, category, manageable, loading, error, sourceLoaded, onOpen, onDisconnect }: {
  connections: readonly ChannelConnectionSummary[];
  category: ChannelConnectionCategory;
  manageable: boolean;
  loading: boolean;
  error?: string | null;
  sourceLoaded: boolean;
  onOpen: (connectorId: Exclude<ConfigurationConnectionId, "wechat">) => void;
  onDisconnect: (connectorId: Exclude<ConfigurationConnectionId, "wechat">) => void;
}) {
  const { formatShortDateTime } = useProcurementLocale();
  const views = buildChannelConnectionViews(connections).filter((item) => item.category === category);
  const firstLoadPending = loading && !sourceLoaded;
  const firstLoadFailed = Boolean(error) && !sourceLoaded;
  const canManage = manageable && sourceLoaded && !loading && !error;

  return <section aria-label={category === "communication" ? "通信连接" : category === "ai" ? "AI 解析服务连接" : "业务系统连接"}>
    {firstLoadFailed ? <div role="alert" className="flex min-h-36 items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-4 text-xs leading-5 text-red-700"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>连接摘要读取失败，未展示任何推测状态：<span data-preserve-language>{error}</span></span></div> : null}
    {sourceLoaded && error ? <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>最新连接摘要读取失败，正在显示上次成功读取的状态；所有管理动作已停用：<span data-preserve-language>{error}</span></span></div> : null}
    {sourceLoaded && !loading && !error && !canManage ? <div className="mb-4 flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2.5 text-xs leading-5 text-blue-800"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>当前角色可查看真实连接状态；保存凭据、运行外部测试和断开连接仍需要管理员权限。</span></div> : null}
    {firstLoadPending ? <div className="flex min-h-48 items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm text-slate-500 shadow-sm"><Loader2 className="mr-2 size-4 animate-spin" />正在读取脱敏连接状态…</div> : !sourceLoaded ? (firstLoadFailed ? null : <div className="flex min-h-36 items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm text-slate-500 shadow-sm">连接摘要尚未读取。</div>) : <div className={cn("grid items-start gap-5", category === "communication" ? "lg:grid-cols-2" : "lg:grid-cols-1")}>
      {views.map((item) => {
        const Icon = iconByConnector[item.connectorId];
        const style = stateStyles[item.state];
        const unavailable = item.connectorId === "wechat" || item.state === "unavailable";
        const actionableConnector = item.connectorId === "wechat" ? null : item.connectorId;
        return <article key={item.connectorId} data-connection-id={item.connectorId} aria-label={`${item.title}连接`} className="flex min-h-[276px] flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(16,24,40,0.04)]">
          <div className="flex items-start gap-3"><span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", style.icon)}><Icon className="size-[18px]" /></span><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><h3 className="pt-0.5 text-[13px] font-semibold text-slate-900">{item.title}</h3>{category === "communication" ? <button type="button" role="switch" aria-label={`启用${item.title}`} aria-checked={item.state === "connected" || item.state === "test_required"} disabled={unavailable || !canManage || !actionableConnector} onClick={() => { if (!actionableConnector) return; if (item.state === "connected") onDisconnect(actionableConnector); else onOpen(actionableConnector); }} className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", item.state === "connected" || item.state === "test_required" ? "bg-[#3567e9]" : "bg-[#d8dee8]", (unavailable || !canManage) && "cursor-not-allowed opacity-50")}><span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform", item.state === "connected" || item.state === "test_required" ? "translate-x-5" : "translate-x-0.5")} /></button> : <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold ring-1 ring-inset", style.badge)}>{item.state === "connected" ? <CheckCircle2 className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}{item.stateLabel}</span>}</div><p className="mt-1 text-[11.5px] leading-5 text-slate-500">{item.description}</p><p data-preserve-language className="mt-1 text-[10px] font-semibold text-slate-400">{item.connectorId === "whatsapp" ? "Meta WhatsApp Cloud API" : item.connectorId === "wechat" ? "暂不可用 / 未配置" : item.connectionType}</p></div></div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-3 text-[10.5px]">
            <div><dt className="text-slate-400">运行状态</dt><dd className="mt-0.5 font-semibold text-slate-700">{truthLabel(item.runtimeHealthy, "正常")}</dd></div>
            <div><dt className="text-slate-400">凭据</dt><dd className="mt-0.5 font-semibold text-slate-700">{truthLabel(item.credentialReady && item.credentialCount > 0, "已就绪", item.credentialCount > 0 ? "待测试" : "未配置")}</dd></div>
            <div><dt className="text-slate-400">外部验证</dt><dd className="mt-0.5 font-semibold text-slate-700">{truthLabel(item.externalVerified, "已验证", "未验证")}</dd></div>
            <div><dt className="text-slate-400">最近测试</dt><dd className="mt-0.5 font-semibold text-slate-700">{item.lastTestedAt ? formatShortDateTime(item.lastTestedAt) : "从未测试"}</dd></div>
          </dl>
          <div className={cn("mt-3 rounded-xl border px-3 py-2.5 text-xs leading-5", item.state === "attention" ? "border-red-100 bg-red-50 text-red-700" : item.state === "connected" ? "border-emerald-100 bg-emerald-50/60 text-emerald-800" : "border-slate-100 bg-slate-50 text-slate-600")}><span className="mr-1 font-semibold">健康状况：</span><span data-preserve-language>{item.detail}</span></div>
          <div className="mt-auto flex gap-2 pt-4">{unavailable || !actionableConnector ? <button type="button" disabled className="inline-flex h-9 w-full cursor-not-allowed items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs font-semibold text-slate-500">暂不可配置</button> : !canManage ? <button type="button" disabled className="inline-flex h-9 w-full cursor-not-allowed items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-3 text-xs font-semibold text-slate-500">{item.state === "connected" ? "已验证 · 由管理员管理" : "联系管理员配置"}</button> : item.state === "connected" ? <><button type="button" onClick={() => onDisconnect(actionableConnector)} className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"><Unplug className="size-3.5" />{item.connectorId === "whatsapp" ? "断开账号" : "断开连接"}</button><button type="button" onClick={() => onOpen(actionableConnector)} className="inline-flex h-9 items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-blue-600 transition hover:bg-blue-50">详情<ArrowRight className="size-3.5" /></button></> : <button type="button" onClick={() => onOpen(actionableConnector)} className="inline-flex h-9 w-full items-center justify-center gap-1 rounded-xl bg-slate-950 px-3 text-xs font-semibold text-white transition hover:bg-slate-800">{item.actionLabel}<ArrowRight className="size-3.5" /></button>}</div>
        </article>;
      })}
    </div>}
  </section>;
}
