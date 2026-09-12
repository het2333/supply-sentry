"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, RotateCcw, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";

type ResolutionStatus = "open" | "accepted_risk" | "resolved" | "mixed";
type SecurityIncident = {
  incidentKey: string;
  eventType: string;
  severity: "info" | "warning" | "critical";
  requestId: string;
  method: string;
  path: string;
  actorId?: string;
  message: string;
  rawEventCount: number;
  eventSeqs: number[];
  firstSeenAt: string;
  lastSeenAt: string;
  version: string;
  resolution: {
    status: ResolutionStatus;
    reason?: string;
    actorId?: string;
    updatedAt?: string;
  };
  related?: {
    providerUid: string;
    poNumber: string;
    reasonCode: string;
    attempts: number;
    firstSeenAt: string;
    lastSeenAt: string;
    nextAttemptAt?: string;
    supplierId?: string;
    supplierName?: string;
    expectedEmails: string[];
    observedSender?: string;
    observedSenderAvailable: boolean;
  };
};

const statusMeta: Record<ResolutionStatus, { label: string; tone: "red" | "amber" | "green" }> = {
  open: { label: "未处置", tone: "red" },
  accepted_risk: { label: "已接受风险", tone: "amber" },
  resolved: { label: "已修复", tone: "green" },
  mixed: { label: "部分处置", tone: "amber" },
};

const eventTypeLabel: Record<string, string> = {
  supplier_email_identity_rejected: "供应商邮件身份拒绝",
  origin_denied: "来源域名拒绝",
  authentication_failed: "认证失败",
  authorization_denied: "权限拒绝",
  invalid_webhook_signature: "Webhook 签名无效",
  internal_callback_denied: "内部回调拒绝",
};

function errorMessage(error: unknown): string {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 403) return "当前账号没有安全告警管理权限。";
    if (error.status === 409) return "该告警已被其他管理员更新，请刷新后重试。";
    return error.message || "安全告警接口暂时不可用。";
  }
  return error instanceof Error ? error.message : "安全告警接口暂时不可用。";
}

export function ProcurementSecurityEventsPanel() {
  const { formatDateTime: formatDate } = useProcurementLocale();
  const [items, setItems] = useState<SecurityIncident[]>([]);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [decision, setDecision] = useState<{ item: SecurityIncident; status: Exclude<ResolutionStatus, "mixed"> } | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await apiRequest<{ items: SecurityIncident[] }>("/api/operations/security-incidents?limit=200");
      setItems(response.items ?? []);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => ({
    open: items.filter((item) => item.resolution.status === "open" || item.resolution.status === "mixed").length,
    accepted: items.filter((item) => item.resolution.status === "accepted_risk").length,
    resolved: items.filter((item) => item.resolution.status === "resolved").length,
    raw: items.reduce((total, item) => total + item.rawEventCount, 0),
  }), [items]);
  const visible = filter === "open" ? items.filter((item) => item.resolution.status === "open" || item.resolution.status === "mixed") : items;

  const openDecision = (item: SecurityIncident, status: Exclude<ResolutionStatus, "mixed">) => {
    setDecision({ item, status }); setReason(""); setError(null); setNotice(null);
  };
  const saveDecision = async () => {
    if (!decision || saving || reason.trim().length < 5) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await apiRequest<{ item: SecurityIncident; replayed: boolean; updatedEvents: number }>(`/api/operations/security-incidents/${decision.item.incidentKey}/resolution`, {
        method: "POST",
        body: { status: decision.status, reason: reason.trim(), expectedVersion: decision.item.version },
      });
      const updated = response.item;
      setItems((current) => current.map((item) => item.incidentKey === updated.incidentKey ? updated : item));
      setNotice(response.replayed ? "该事故处置已安全重放，未重复写入审计。" : decision.status === "resolved" ? `已为该事故的 ${response.updatedEvents} 条原始事件记录修复结论和管理员审计。` : decision.status === "accepted_risk" ? `已为该事故的 ${response.updatedEvents} 条原始事件记录风险接受依据和管理员审计。` : `已重新打开该事故的 ${response.updatedEvents} 条原始事件。`);
      setDecision(null); setReason("");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  };

  return <>
    <Card>
      <CardHeader>
        <div><CardTitle>安全事故与风险接受</CardTitle><CardDescription>相同请求的重复记录聚合为一个事故；原始事件保持不可变，处置只追加管理员依据、版本和审计。</CardDescription></div>
        <div className="flex items-center gap-2">
          <Badge tone={counts.open ? "red" : "green"}>{counts.open ? `${counts.open} 个事故未处置` : "全部已处置"}</Badge>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />刷新</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">{error}</div>}
        {notice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-700">{notice}</div>}
        <div className="grid grid-cols-3 gap-2">
          {[["未处置事故", counts.open, "text-red-600"], ["接受风险", counts.accepted, "text-amber-600"], ["已修复", counts.resolved, "text-emerald-600"]].map(([label, value, color]) => <div key={String(label)} className="rounded-xl bg-slate-50 px-3 py-3"><div className="text-[10px] text-slate-400">{label}</div><div className={`mt-1 text-xl font-semibold ${color}`}>{value}</div></div>)}
        </div>
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
          {([['open', `未处置 ${counts.open}`], ['all', `全部 ${items.length}`]] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setFilter(value)} className={`h-8 flex-1 rounded-lg text-xs font-semibold transition ${filter === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>{label}</button>)}
        </div>
        {loading && !items.length ? <div className="flex items-center justify-center py-12 text-xs text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />读取安全事故…</div> : visible.length ? <div className="max-h-[680px] space-y-2 overflow-y-auto pr-1">{visible.map((item) => {
          const meta = statusMeta[item.resolution.status];
          return <div key={item.incidentKey} className="rounded-2xl border border-slate-200 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 gap-3"><span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${item.severity === 'critical' ? 'bg-red-100 text-red-700' : item.severity === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}><ShieldAlert className="size-4" /></span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-slate-900">{eventTypeLabel[item.eventType] ?? item.eventType}</span><Badge tone={meta.tone}>{meta.label}</Badge><Badge tone="neutral">{item.rawEventCount} 条原始事件</Badge><span className="font-mono text-[10px] text-slate-400">#{item.incidentKey.slice(0, 8)}</span></div><p className="mt-1 text-xs leading-5 text-slate-600">{item.message}</p><div className="mt-1 text-[10px] text-slate-400">{formatDate(item.firstSeenAt)}–{formatDate(item.lastSeenAt)} · {item.method} {item.path} · 请求 {item.requestId}</div></div></div>
              <div className="flex shrink-0 gap-2">{item.resolution.status === "open" || item.resolution.status === "mixed" ? <><Button size="sm" variant="outline" onClick={() => openDecision(item, "accepted_risk")}><AlertTriangle className="size-3.5" />接受风险</Button><Button size="sm" onClick={() => openDecision(item, "resolved")}><CheckCircle2 className="size-3.5" />标记已修复</Button></> : <Button size="sm" variant="outline" onClick={() => openDecision(item, "open")}><RotateCcw className="size-3.5" />重新打开</Button>}</div>
            </div>
            {item.related && <div className="mt-3 grid gap-2 rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3 text-[11px] leading-5 text-slate-600 sm:grid-cols-2 xl:grid-cols-5"><div><div className="text-[10px] text-slate-400">关联采购订单</div><div className="font-semibold text-slate-800">{item.related.poNumber}</div></div><div><div className="text-[10px] text-slate-400">供应商</div><div className="font-semibold text-slate-800">{item.related.supplierName ?? item.related.supplierId ?? "未匹配"}</div></div><div><div className="text-[10px] text-slate-400">实际发件邮箱</div><div className="break-all font-medium text-slate-700">{item.related.observedSender ?? "历史记录未保留"}</div></div><div><div className="text-[10px] text-slate-400">主数据允许邮箱</div><div className="break-all font-medium text-slate-700">{item.related.expectedEmails.length ? item.related.expectedEmails.join("、") : "未登记"}</div></div><div><div className="text-[10px] text-slate-400">同一邮件处理</div><div className="font-semibold text-slate-800">尝试 {item.related.attempts} 次</div></div><div className="sm:col-span-2 xl:col-span-5 text-[10px] text-slate-400">{item.related.observedSenderAvailable ? "请对照实际发件邮箱与供应商主数据；修复后同一邮件校验成功会自动追加已修复审计。" : "该历史拒绝发生在发件地址证据持久化上线前；请从原始邮件头核验后修复供应商主数据。处置事故不会重放邮件。"}</div></div>}
            {item.resolution.status !== "open" && item.resolution.status !== "mixed" && <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600"><div className="font-medium text-slate-700">处置依据</div><div>{item.resolution.reason}</div><div className="mt-1 text-[10px] text-slate-400">{item.resolution.actorId} · {formatDate(item.resolution.updatedAt)} · 事故版本 {item.version.slice(0, 8)}</div></div>}
          </div>;
        })}</div> : <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-12 text-center"><ShieldCheck className="size-7 text-emerald-500" /><div className="mt-2 text-sm font-semibold text-slate-700">当前没有未处置安全事故</div><div className="mt-1 text-xs text-slate-400">接受风险和已修复记录仍可在“全部”中审计。</div></div>}
        <div className="text-[10px] leading-4 text-slate-400">当前 {items.length} 个真实事故对应 {counts.raw} 条不可变原始事件。接受风险不会修改供应商身份、重放邮件或关闭安全校验；根因仍需在主数据或连接器配置中修复。</div>
      </CardContent>
    </Card>

    {decision && <div role="presentation" className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="security-decision-title" className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4"><div><h2 id="security-decision-title" className="text-base font-semibold text-slate-900">{decision.status === "resolved" ? "确认事故已修复" : decision.status === "accepted_risk" ? "确认接受风险" : "重新打开安全事故"}</h2><p className="mt-1 text-xs text-slate-500">#{decision.item.incidentKey.slice(0, 8)} · {decision.item.rawEventCount} 条原始事件 · {eventTypeLabel[decision.item.eventType] ?? decision.item.eventType}</p></div><button type="button" aria-label="关闭" onClick={() => !saving && setDecision(null)} disabled={saving} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X className="size-4" /></button></div>
        <div className="mt-4 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">此操作会为该事故包含的 {decision.item.rawEventCount} 条原始事件追加同一处置结论与审计；不会删除原始证据、修改供应商联系人、重放邮件或执行外部写入。</div>
        <label className="mt-4 block text-xs font-semibold text-slate-700">处置依据 <span className="text-red-500">*</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder={decision.status === "resolved" ? "说明修复了什么、如何验证" : decision.status === "accepted_risk" ? "说明风险范围、接受期限和补偿控制" : "说明为何需要重新调查"} className="mt-2 min-h-28 w-full resize-none rounded-xl border border-slate-200 p-3 text-sm font-normal outline-none focus:border-blue-400" /></label>
        <div className="mt-1 text-right text-[10px] text-slate-400">{reason.trim().length}/500，至少 5 个字符</div>
        <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setDecision(null)} disabled={saving}>取消</Button><Button onClick={() => void saveDecision()} disabled={saving || reason.trim().length < 5}>{saving && <Loader2 className="size-3.5 animate-spin" />}{saving ? "保存中…" : "保存处置与审计"}</Button></div>
      </div>
    </div>}
  </>;
}
