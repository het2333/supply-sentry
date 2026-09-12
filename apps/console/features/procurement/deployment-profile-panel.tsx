"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Database, History, Loader2, Mail, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { cn } from "@/lib/utils";

type DeploymentMode = "odoo_connected" | "email_only";
type DeploymentProfile = {
  mode: DeploymentMode;
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};
type DeploymentResponse = {
  item: DeploymentProfile | null;
  effectiveMode: DeploymentMode;
  inheritedDefault: boolean;
  evidence: { acceptedEmailPurchaseOrders: number; odooPurchaseOrders: number };
  permissions: { read: boolean; configure: boolean };
  events: Array<{ id: string; actorId: string; action: string; detail: Record<string, unknown>; createdAt: string }>;
};

const modes: Array<{
  id: DeploymentMode;
  title: string;
  subtitle: string;
  description: string;
  facts: string[];
  icon: typeof Database;
}> = [
  {
    id: "odoo_connected",
    title: "Odoo 连接模式",
    subtitle: "当前部署推荐",
    description: "Odoo 是采购记录系统；邮箱负责供应商沟通，最终收货必须以 Odoo/WMS GRN 回执闭环。",
    facts: ["真实 PO 从 Odoo 同步", "邮件回信推进供应商承诺", "最终 GRN 由 ERP / WMS 交叉核验"],
    icon: Database,
  },
  {
    id: "email_only",
    title: "纯邮箱模式",
    subtitle: "Readywork 官方支持",
    description: "不依赖 ERP；采购订单附件从企业邮箱进入，经过安全扫描、解析和人工核验后开始五阶段执行。",
    facts: ["ClamAV 通过后才解析附件", "人工核验后生成真实 PO", "仓库 GRN 依据由有权限人员核验"],
    icon: Mail,
  },
];

function errorText(error: unknown): string {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 409) return "部署模式已被其他人更新，已重新读取最新版本。";
    if (error.status === 403) return "当前账号没有切换采购部署模式的权限。";
    return error.message;
  }
  return error instanceof Error ? error.message : "采购部署模式请求失败";
}

export function ProcurementDeploymentProfilePanel() {
  const { formatDateTime: formatTime } = useProcurementLocale();
  const [data, setData] = useState<DeploymentResponse | null>(null);
  const [mode, setMode] = useState<DeploymentMode>("odoo_connected");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<DeploymentResponse>("/api/procurement/deployment-profile");
      setData(response);
      setMode(response.effectiveMode);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!data?.permissions.configure || saving || reason.trim().length < 10) return;
    const selected = modes.find((item) => item.id === mode)!;
    if (!window.confirm(`确认采用“${selected.title}”？\n\n该变更会写入租户级审计，但不会自动同步 Odoo、接受邮件 PO 或生成业务事实。`)) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await apiRequest<DeploymentResponse>("/api/procurement/deployment-profile", {
        method: "PUT",
        body: { expectedVersion: data.item?.version ?? 0, mode, reason },
      });
      setData(response);
      setMode(response.effectiveMode);
      setReason("");
      setNotice(`部署模式已保存为“${selected.title}”；V1 就绪门槛会按该模式重新核验。`);
    } catch (requestError) {
      setError(errorText(requestError));
      if (requestError instanceof ReadyworkApiError && requestError.status === 409) await load();
    } finally {
      setSaving(false);
    }
  }

  const effective = data?.effectiveMode ?? "odoo_connected";
  const dirty = mode !== effective || data?.inheritedDefault === true;
  return <Card id="deployment-profile" className="scroll-mt-24 overflow-hidden">
    <CardHeader>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><CardTitle>采购部署模式</CardTitle><Badge tone={!data ? "neutral" : data.inheritedDefault ? "amber" : "green"}>{loading ? "读取中…" : !data ? "未读取" : data.inheritedDefault ? "沿用默认" : "已明确配置"}</Badge></div>
        <CardDescription>选择 Odoo 连接或纯邮箱运行；模式影响发布门槛，但不会制造连接器回执或业务阶段证据。</CardDescription>
      </div>
      <ShieldCheck className="size-5 shrink-0 text-slate-400" />
    </CardHeader>
    <CardContent className="space-y-4 pt-4">
      {loading ? <div className="flex items-center gap-2 py-6 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" />正在读取真实部署配置…</div> : <>
        {error && <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700"><span className="flex items-start gap-2"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</span><button type="button" onClick={() => void load()} className="flex shrink-0 items-center gap-1 font-semibold text-red-700 hover:underline"><RefreshCw className="size-3.5" />重新读取</button></div>}
        {notice && <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs leading-5 text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</div>}
        {data?.inheritedDefault && <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><AlertCircle className="mt-0.5 size-4 shrink-0" />当前为兼容性默认的 Odoo 连接模式；保存后才形成版本化、可审计的租户配置。</div>}
        <div className="grid gap-3 lg:grid-cols-2">
          {modes.map((item) => {
            const Icon = item.icon;
            const selected = mode === item.id;
            return <button key={item.id} type="button" disabled={!data?.permissions.configure || saving} onClick={() => { setMode(item.id); setNotice(null); }} className={cn("rounded-2xl border p-4 text-left transition", selected ? "border-blue-300 bg-blue-50/55 ring-1 ring-inset ring-blue-100" : "border-slate-200 bg-white hover:border-slate-300", (!data?.permissions.configure || saving) && "cursor-not-allowed opacity-70")}>
              <div className="flex items-start gap-3"><span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", selected && data ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500")}><Icon className="size-5" /></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold text-slate-900">{item.title}</span><Badge tone={selected && data ? "blue" : "neutral"}>{data && effective === item.id ? "当前生效" : item.subtitle}</Badge></span><span className="mt-1.5 block text-xs leading-5 text-slate-500">{item.description}</span></span></div>
              <span className="mt-3 grid gap-1.5 border-t border-slate-100 pt-3">{item.facts.map((fact) => <span key={fact} className="flex items-center gap-2 text-[11px] text-slate-500"><CheckCircle2 className="size-3.5 text-emerald-500" />{fact}</span>)}</span>
            </button>;
          })}
        </div>
        <div className="grid gap-3 rounded-2xl border border-slate-100 bg-slate-50/60 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <label className="text-xs font-medium text-slate-600">配置或切换依据<textarea value={reason} onChange={(event) => setReason(event.target.value)} disabled={!data?.permissions.configure || saving} maxLength={500} placeholder="说明为什么该租户采用此部署模式（至少 10 个字符）" className="mt-1.5 min-h-20 w-full resize-none rounded-xl border border-slate-200 bg-white p-3 text-sm font-normal text-slate-900 outline-none focus:border-blue-400 disabled:bg-slate-50" /></label>
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs"><div className="text-[10px] text-slate-400">已核验邮箱 PO</div><div className="mt-1 text-lg font-semibold text-slate-900">{data ? data.evidence.acceptedEmailPurchaseOrders : "—"}</div></div>
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs"><div className="text-[10px] text-slate-400">Odoo PO</div><div className="mt-1 text-lg font-semibold text-slate-900">{data ? data.evidence.odooPurchaseOrders : "—"}</div></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <div className="text-[11px] leading-5 text-slate-400">{data?.item ? <span className="flex items-center gap-1.5"><History className="size-3.5" />{data.item.updatedBy} · {formatTime(data.item.updatedAt)} · v{data.item.version}</span> : "尚无显式配置记录"}</div>
          {data?.permissions.configure && <button type="button" onClick={() => void save()} disabled={saving || !dirty || reason.trim().length < 10} className="flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-semibold text-white shadow-sm shadow-blue-100 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"><Save className="size-4" />{saving ? "保存中…" : "保存部署模式"}</button>}
        </div>
        {data?.events?.length ? <div className="text-[11px] text-slate-400">最近审计：{data.events[0]?.action === "created" ? "首次明确配置" : "切换模式"} · {formatTime(data.events[0]?.createdAt)}</div> : null}
      </>}
    </CardContent>
  </Card>;
}
