"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleSlash2,
  Loader2,
  RefreshCw,
  Rocket,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";

type GateTarget = "communication-identity" | "sla" | "connector-email" | "connector-erp" | "po-intake" | "document-gate" | "runtime" | "security-events" | "local-procurement";
type ReadinessGate = {
  id: string;
  label: string;
  status: "ready" | "blocked";
  summary: string;
  detail: string;
  target: GateTarget;
};
type ReadinessView = {
  status: "ready" | "blocked";
  checkedAt: string;
  deploymentMode: "odoo_connected" | "email_only";
  readyGates: number;
  totalGates: number;
  gates: ReadinessGate[];
  portfolio: {
    totalPurchaseOrders: number;
    activePurchaseOrders: number;
    local: number;
    import: number;
    unclassified: number;
    byStage: Record<string, number>;
    fiveStageClosedLoop: number;
  };
};

const actionLabels: Record<GateTarget, string> = {
  "communication-identity": "配置联系人",
  sla: "前往 SLA",
  "connector-email": "查看邮箱连接",
  "connector-erp": "查看 Odoo 连接",
  "po-intake": "核验邮箱 PO",
  "document-gate": "查看文档门禁",
  runtime: "查看运行记录",
  "security-events": "处置安全告警",
  "local-procurement": "查看本地采购",
};
const administratorOnlyTargets = new Set<GateTarget>(["document-gate", "runtime", "security-events"]);

function errorText(error: unknown): string {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 403) return "当前账号没有读取 V1 发布就绪状态的权限。";
    return error.message || "V1 发布就绪接口暂时不可用。";
  }
  return error instanceof Error ? error.message : "V1 发布就绪接口暂时不可用。";
}

export function ProcurementV1ReadinessPanel({
  onNavigate,
  operationsManageable,
}: {
  onNavigate: (target: "sla" | "local-procurement" | "po-intake" | "ai-records") => void;
  operationsManageable: boolean;
}) {
  const { formatDateTime: formatTime } = useProcurementLocale();
  const [data, setData] = useState<ReadinessView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiRequest<ReadinessView>("/api/operations/v1-readiness"));
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const blocked = useMemo(() => data?.gates.filter((gate) => gate.status === "blocked") ?? [], [data]);
  const completion = data?.totalGates ? Math.round((data.readyGates / data.totalGates) * 100) : 0;

  function openTarget(target: GateTarget) {
    if (!operationsManageable && administratorOnlyTargets.has(target)) return;
    if (target === "sla" || target === "local-procurement" || target === "po-intake") {
      onNavigate(target);
      return;
    }
    if (target === "runtime") {
      onNavigate("ai-records");
      return;
    }
    const anchor = target === "connector-email" || target === "connector-erp"
      ? operationsManageable ? "connector-control-plane" : "agent-setup"
      : target;
    const element = document.getElementById(anchor);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <Card className="overflow-hidden border-slate-200 shadow-sm">
      <CardHeader className="border-b border-slate-100 bg-white px-5 py-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`flex size-9 items-center justify-center rounded-full ${data?.status === "ready" ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}>
              {data?.status === "ready" ? <ShieldCheck className="size-[18px]" /> : <Rocket className="size-[18px]" />}
            </span>
            <div>
              <CardTitle>Readywork V1 发布就绪</CardTitle>
              <CardDescription>后端统一核验身份、SLA、连接器、可靠队列、安全状态和真实五阶段证据。</CardDescription>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={data?.status === "ready" ? "green" : data ? "amber" : "neutral"}>
            {loading && !data ? "核验中…" : data?.status === "ready" ? "可以发布" : data ? "发布阻断" : "尚未读取"}
          </Badge>
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />重新核验
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 px-5 py-5">
        {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}
        {loading && !data ? (
          <div className="flex items-center justify-center py-12 text-sm text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />正在读取真实发布门槛…</div>
        ) : data ? (
          <>
            {!operationsManageable && <div role="note" className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2.5 text-xs leading-5 text-blue-800"><ShieldCheck className="mt-0.5 size-4 shrink-0" /><span>当前角色读取的是同一持久化事实生成的脱敏发布摘要；详细队列、文档运维和安全事故证据仍由管理员治理。</span></div>}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {[
                [data.deploymentMode === "email_only" ? "纯邮箱模式" : "Odoo 模式", `${data.readyGates}/${data.totalGates}`],
                ["活跃 PO", data.portfolio.activePurchaseOrders],
                ["本地采购", data.portfolio.local],
                ["路线未分类", data.portfolio.unclassified],
                ["真实五阶段闭环", data.portfolio.fiveStageClosedLoop],
              ].map(([label, value]) => <div key={String(label)} className="rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3.5"><div className="text-[11px] text-slate-400">{label}</div><div className="mt-1 text-[22px] font-semibold tracking-tight text-slate-900">{value}</div></div>)}
            </div>

            <div className="rounded-2xl border border-slate-100 px-4 py-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div><div className="text-sm font-semibold text-slate-900">发布门槛完成度 {completion}%</div><div className="mt-1 text-xs text-slate-500">只有全部门槛获得真实证据后，状态才会变为“可以发布”。</div></div>
                <div className="text-[11px] text-slate-400">核验时间：{formatTime(data.checkedAt)}</div>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-all ${data.status === "ready" ? "bg-emerald-500" : "bg-blue-600"}`} style={{ width: `${completion}%` }} /></div>
            </div>

            {blocked.length > 0 && <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800"><div className="flex items-center gap-2 font-semibold"><CircleSlash2 className="size-4" />还有 {blocked.length} 个真实发布阻断项</div><div className="mt-1 text-amber-700">系统不会自动发布 SLA、猜测采购路线、接受安全风险或制造业务阶段证据。</div></div>}

            <div className="grid gap-3 xl:grid-cols-2">
              {data.gates.map((gate) => {
                const ready = gate.status === "ready";
                return <div key={gate.id} className={`rounded-2xl border p-4 ${ready ? "border-slate-100 bg-white" : "border-amber-200 bg-amber-50/40"}`}>
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${ready ? "bg-emerald-50 text-emerald-600" : "bg-amber-100 text-amber-700"}`}>
                      {ready ? <Check className="size-4" /> : <AlertCircle className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-xs font-semibold text-slate-900">{gate.label}</div><Badge tone={ready ? "green" : "amber"}>{ready ? "已就绪" : "阻断"}</Badge></div>
                      <div className="mt-1.5 text-xs font-medium leading-5 text-slate-700">{gate.summary}</div>
                      <div className="mt-1 text-[11px] leading-5 text-slate-500">{gate.detail}</div>
                      {!ready && (!operationsManageable && administratorOnlyTargets.has(gate.target)
                        ? <span className="mt-3 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-slate-500"><ShieldCheck className="size-3" />管理员治理</span>
                        : <button type="button" onClick={() => openTarget(gate.target)} className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:text-blue-700">{!operationsManageable && (gate.target === "connector-email" || gate.target === "connector-erp") ? "查看连接状态" : actionLabels[gate.target]}<ArrowRight className="size-3" /></button>)}
                    </div>
                  </div>
                </div>;
              })}
            </div>

            {data.status === "ready" && <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800"><CheckCircle2 className="size-4" />全部门槛都有真实证据，可以进入正式 V1 发布验收。</div>}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
