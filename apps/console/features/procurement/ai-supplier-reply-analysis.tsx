"use client";

import { useState } from "react";
import { apiRequest } from "@/features/shared/api-client";

export function AiSupplierReplyAnalysis({ analysis, communicationId, subject, canOperate = false }: { analysis: unknown; communicationId?: string; subject?: string; canOperate?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const incoming = analysis && typeof analysis === "object" ? analysis as Record<string, unknown> : null;
  const value = latest && (!incoming || String(latest.updatedAt ?? "") >= String(incoming.updatedAt ?? "")) ? latest : incoming ?? {};
  const labels: Record<string, string> = { processing: "解析中", parsed: "已解析，正在核验", applied: "已更新订单", partially_applied: "部分更新", approval_required: "差异待审批", review_required: "待人工核验", failed: "解析失败", already_confirmed: "已解析，订单此前已确认" };
  const status = String(value.status ?? "");
  const lines = Array.isArray(value.lines) ? value.lines as Array<Record<string, unknown>> : [];
  const route = record(value.verifiedRoute);
  const productionLines = Array.isArray(value.verifiedProductionLines) ? value.verifiedProductionLines as Array<Record<string, unknown>> : [];
  const shipment = record(value.verifiedShipment);
  const shipmentLines = Array.isArray(shipment?.lines) ? shipment.lines as Array<Record<string, unknown>> : [];
  const blockResults = record(value.blockResults) ?? {};
  const hasSupplierEmailFacts = Boolean(route || productionLines.length || shipment);
  async function parse() {
    if (!communicationId || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await apiRequest<{ analysis: Record<string, unknown> }>(`/api/procurement/communications/${encodeURIComponent(communicationId)}/ai-analysis`, { method: "POST", body: {}, timeoutMs: 45_000 });
      setLatest(result.analysis);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "解析请求失败"); }
    finally { setBusy(false); }
  }
  return <section aria-label="AI 回信解析" className="mt-3 rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-xs text-slate-700">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold text-blue-900">AI 回信解析</h3><span>{busy ? "解析中" : labels[status] ?? "尚未解析"}</span></div>
    {subject && <p className="mt-1 truncate text-slate-500">{subject}</p>}
    {typeof value.summary === "string" && <p className="mt-2 leading-5">{value.summary}</p>}
    {lines.map((line, index) => <div key={String(line.poLineId ?? index)} className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      <span>确认数量：{String(line.quantity ?? "未明确")}</span><span>确认单价：{String(line.unitPrice ?? "未明确")}</span><span>承诺交期：{typeof line.promisedAt === "string" ? line.promisedAt.slice(0, 10) : "未明确"}</span>
    </div>)}
    {hasSupplierEmailFacts && <p className="mt-2 font-medium text-blue-800">来源：供应商邮件 + AI 原文校验</p>}
    {route && <div className="mt-2 rounded border border-blue-100 bg-white/70 px-2.5 py-2">
      <span className="font-medium">采购路线：</span>{route.value === "local" ? "本地采购" : route.value === "import" ? "进口采购" : "未核验"}
      {typeof route.quote === "string" && <span className="ml-2 text-slate-500">原文：{route.quote}</span>}
    </div>}
    {productionLines.length > 0 && <div className="mt-2 rounded border border-blue-100 bg-white/70 px-2.5 py-2">
      <p className="font-medium">生产/备货</p>
      {productionLines.map((line, index) => <div key={String(line.poLineId ?? index)} className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <span>状态：{progressLabel(String(line.progressStatus ?? ""))}</span>
        <span>完成度：{numberText(line.completionPercent)}%</span>
        <span>完成数量：{numberText(line.quantity)}</span>
        {typeof line.expectedReadyAt === "string" && <span>预计可发运：{line.expectedReadyAt.slice(0, 10)}</span>}
        {typeof line.note === "string" && <span>说明：{line.note}</span>}
      </div>)}
    </div>}
    {shipment && <div className="mt-2 rounded border border-blue-100 bg-white/70 px-2.5 py-2">
      <p className="font-medium">ASN / 发运</p>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <span>ASN：{String(shipment.supplierReference ?? "未明确")}</span>
        <span>承运商：{String(shipment.carrier ?? "未明确")}</span>
        <span>运单号：{String(shipment.trackingNumber ?? "未明确")}</span>
        <span>预计到货：{typeof shipment.estimatedArrivalAt === "string" ? shipment.estimatedArrivalAt.slice(0, 10) : "未明确"}</span>
      </div>
      {shipmentLines.map((line, index) => <p key={String(line.poLineId ?? index)} className="mt-1 text-slate-600">发运数量：{numberText(line.quantity)}</p>)}
    </div>}
    {Object.entries(blockResults).map(([fact, outcome]) => {
      const item = record(outcome); const reason = item && typeof item.reason === "string" ? item.reason : "";
      return reason ? <p key={fact} className="mt-2 text-amber-700">{factLabel(fact)}：{reason}</p> : null;
    })}
    {typeof value.reason === "string" && <p className="mt-2 leading-5 text-slate-500">{value.reason}</p>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
    {canOperate && communicationId && ["", "failed", "review_required"].includes(status) && <button type="button" onClick={() => void parse()} disabled={busy} className="mt-3 rounded border border-blue-200 bg-white px-3 py-1.5 text-blue-700 disabled:opacity-50">{busy ? "解析中…" : status ? "重新解析" : "使用 AI 解析"}</button>}
  </section>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "未明确";
}

function progressLabel(value: string): string {
  return ({ materials_ready: "物料齐套", in_production: "生产中", quality_check: "质检中", ready_to_ship: "待发运", delayed: "延期", blocked: "受阻" } as Record<string, string>)[value] ?? "未明确";
}

function factLabel(value: string): string {
  return ({ route: "采购路线", confirmation: "供应商承诺", production: "生产/备货", shipment: "ASN/发运" } as Record<string, string>)[value] ?? value;
}
