"use client";

import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, PencilLine } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { cn } from "@/lib/utils";
import { beginManufacturingContextLoad, manufacturingContextExpandedState, type ManufacturingContextPanelState } from "./manufacturing-context-panel-state";
import { contextValue, manufacturingContextViewModel, type ContextRecord, type ManufacturingContextEnvelope } from "./manufacturing-context-view-model";

type CorrectionDraft = { entityId: string; entityLabel: string; factPath: string; oldValue: string; newValue: string; reason: string; evidenceReference: string };

function errorText(error: unknown): string {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 401) return "登录已过期，请重新登录后读取制造上下文。";
    if (error.status === 403) return "当前身份无权读取或提交制造上下文纠正。";
    if (error.status === 404) return "该采购订单尚无可读取的制造上下文。";
    if (error.status === 409) return "制造上下文在提交期间已变化；请刷新后核对最新事实。";
    if (error.status === 0 || error.status === 408) return "制造上下文服务暂时不可达；请稍后重试。";
    return error.message || "制造上下文请求失败。";
  }
  return error instanceof Error ? error.message : "制造上下文请求失败。";
}

function asObject(value: unknown): ContextRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ContextRecord : null;
}

function scalar(value: string): unknown {
  const normalized = value.trim();
  if (normalized === "null") return null;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  return normalized;
}

export function ManufacturingContextPanel({ purchaseOrderId, permissions }: { purchaseOrderId: string; permissions: { operate?: boolean } }) {
  const { formatShortDateTime } = useProcurementLocale();
  const date = (value: unknown) => formatShortDateTime(typeof value === "string" ? value : null, "时间未记录");
  const [panelState, setPanelState] = useState<ManufacturingContextPanelState<ManufacturingContextEnvelope>>({ envelope: null, error: null, loading: true, notice: null });
  const [loadedPurchaseOrderId, setLoadedPurchaseOrderId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CorrectionDraft | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async ({ objectChanged = false, preserveNotice = false }: { objectChanged?: boolean; preserveNotice?: boolean } = {}) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPanelState((current) => beginManufacturingContextLoad(current, { objectChanged, preserveNotice }));
    if (objectChanged) setLoadedPurchaseOrderId(null);
    try {
      const result = await apiRequest<ManufacturingContextEnvelope>(`/api/context/v1/objects/${encodeURIComponent(purchaseOrderId)}`, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setPanelState((current) => ({ ...current, envelope: result, error: null, loading: false }));
        setLoadedPurchaseOrderId(purchaseOrderId);
      }
    } catch (cause) {
      if (!controller.signal.aborted && !(cause instanceof ReadyworkApiError && cause.status === 499)) setPanelState((current) => ({ ...current, error: errorText(cause), loading: false }));
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [purchaseOrderId]);

  useEffect(() => {
    setExpanded((current) => manufacturingContextExpandedState(current, "object_changed"));
    setDraft(null);
    setCorrectionError(null);
    void load({ objectChanged: true });
    return () => request.current?.abort();
  }, [load]);

  const submitCorrection = async () => {
    if (!draft) return;
    setSubmitting(true);
    setCorrectionError(null);
    try {
      const result = await apiRequest<{ data?: ContextRecord }>(`/api/context/v1/entities/${encodeURIComponent(draft.entityId)}/corrections`, {
        method: "POST",
        body: { factPath: draft.factPath.trim(), oldValue: scalar(draft.oldValue), newValue: scalar(draft.newValue), reason: draft.reason.trim(), evidenceReference: draft.evidenceReference.trim() },
      });
      const approval = asObject(result.data);
      if (!approval || approval.kind !== "twin_fact_correction" || approval.status !== "pending") throw new Error("服务未返回已持久化的纠正审批，未显示提交成功。");
      setDraft(null);
      setPanelState((current) => ({ ...current, notice: "纠正请求已保存为待审批记录；采购事实尚未改变。" }));
      await load({ preserveNotice: true });
    } catch (cause) {
      setCorrectionError(errorText(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const envelope = loadedPurchaseOrderId === purchaseOrderId ? panelState.envelope : null;
  if (panelState.loading && !envelope) return <div className="flex min-h-24 items-center justify-center rounded-xl border border-slate-200 bg-slate-50/60 text-sm text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />读取制造上下文摘要…</div>;
  if (panelState.error && !envelope) return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs leading-5 text-red-700"><div className="font-semibold">无法读取制造上下文</div><div className="mt-1">{panelState.error}</div><button type="button" onClick={() => void load()} className="mt-3 font-semibold underline underline-offset-4">重试</button></div>;
  if (!envelope) return null;
  const model = manufacturingContextViewModel(envelope);
  const root = model.root;
  const rootFacts = asObject(root?.facts);
  const correctionEntities = root ? [root, ...model.entities] : model.entities;
  const beginCorrection = (entity: ContextRecord, evidence?: ContextRecord) => setDraft({
    entityId: String(entity.id ?? ""), entityLabel: String(entity.label ?? entity.id ?? "实体"), factPath: String(evidence?.factPath ?? ""), oldValue: evidence ? contextValue(evidence.value) : "", newValue: "", reason: "", evidenceReference: "",
  });

  return <div className="space-y-4">
    {panelState.error ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">刷新失败：{panelState.error}</div> : null}
    {panelState.notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800"><CheckCircle2 className="mr-1 inline size-3.5" />{panelState.notice}</div> : null}
    {model.projection.warning ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800"><AlertTriangle className="mr-1 inline size-3.5" />{model.projection.warning}</div> : null}

    <div className="overflow-hidden rounded-xl border border-[#dfe6ef] bg-[#f8fafc]">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="manufacturing-context-evidence"
        onClick={() => setExpanded((current) => manufacturingContextExpandedState(current, "toggle"))}
        className="flex w-full items-center justify-between gap-4 px-4 py-4 text-left hover:bg-slate-100/70"
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-[#26364f]">订单证据图谱</span>
          <span className="mt-1 block text-[11px] leading-5 text-[#718198]">来自 Context API 的持久化实体、事实证据与投影状态</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs font-semibold text-[#315f9d]">
          {expanded ? "收起证据" : "展开制造上下文"}
          <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
        </span>
      </button>
      <div className="grid grid-cols-2 border-t border-[#e4eaf2] bg-white sm:grid-cols-5">
        <SummaryMetric label="实体" value={model.summary.entityCount} />
        <SummaryMetric label="证据" value={model.summary.evidenceCount} />
        <SummaryMetric label="缺失事实" value={model.summary.missingFactCount} tone={model.summary.missingFactCount > 0 ? "warning" : "neutral"} />
        <SummaryMetric label="冲突" value={model.summary.conflictCount} tone={model.summary.conflictCount > 0 ? "danger" : "neutral"} />
        <SummaryMetric label="投影" value={model.projection.label} className="col-span-2 sm:col-span-1" tone={model.projection.status === "current" ? "success" : "warning"} />
      </div>
    </div>

    {expanded ? <div id="manufacturing-context-evidence" className="space-y-4 border-l-2 border-[#dce7f6] pl-4">

    <Section title="实体摘要">
      {root ? <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-semibold text-slate-900">{contextValue(root.label)}</div><div className="mt-1 text-[11px] text-slate-500">{root.typeLabel} · {contextValue(root.lifecycleState)}</div></div>{permissions.operate === true ? <CorrectionButton onClick={() => beginCorrection(root)} /> : null}</div>{rootFacts && Object.keys(rootFacts).length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{Object.entries(rootFacts).map(([path, item]) => { const fact = asObject(item); return <Fact key={path} label={path} value={fact ? contextValue(fact.value) : contextValue(item)} />; })}</div> : null}</div> : <Empty text="没有返回根实体。" />}
      {model.entities.filter((entity) => entity.id !== root?.id).length ? <div className="mt-2 space-y-2">{model.entities.filter((entity) => entity.id !== root?.id).map((entity) => <div key={String(entity.id)} className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 p-3"><div className="min-w-0"><div className="truncate text-xs font-semibold text-slate-800">{contextValue(entity.label)}</div><div className="mt-1 text-[11px] text-slate-500">{String(entity.typeLabel)} · {contextValue(entity.lifecycleState)}</div></div>{permissions.operate === true ? <CorrectionButton onClick={() => beginCorrection(entity)} /> : null}</div>)}</div> : null}
    </Section>

    <Section title="关系与上游来源">{model.relations.length ? <div className="space-y-2">{model.relations.map((relation) => <div key={String(relation.id)} className="rounded-xl border border-slate-200 p-3 text-xs"><div className="font-semibold text-slate-800">{String(relation.fromLabel)} <span className="font-normal text-slate-400">— {String(relation.typeLabel)} →</span> {String(relation.toLabel)}</div><div className="mt-1 text-[11px] text-slate-500">{contextValue(relation.status)} · 生效于 {date(relation.validFrom)} · 来源证据 {contextValue(relation.sourceEvidenceId)}</div></div>)}</div> : <Empty text="尚无关联上游实体或关系。" />}</Section>

    <Section title="事实与证据">{model.evidence.length ? <div className="space-y-2">{model.evidence.map((evidence) => <div key={String(evidence.id)} className="rounded-xl border border-slate-200 p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-xs font-semibold text-slate-800">{contextValue(evidence.factPath)}</div><div className="mt-1 break-words text-xs text-slate-600">{contextValue(evidence.value)}</div><div className="mt-2 text-[11px] text-slate-500">{String(evidence.sourceLabel)} · {contextValue(evidence.sourceKind)} · 观察于 {date(evidence.observedAt)}</div></div>{permissions.operate === true && evidence.entityId ? <CorrectionButton onClick={() => { const entity = correctionEntities.find((item) => item.id === evidence.entityId); if (entity) beginCorrection(entity, evidence); }} /> : null}</div></div>)}</div> : <Empty text="尚未投影可展示的事实与证据。" />}</Section>

    <Section title="缺失事实">{model.missingFacts.length ? <div className="flex flex-wrap gap-2">{model.missingFacts.map((item) => <span key={item.code} className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">{item.label}</span>)}</div> : <Empty text="当前投影未标记缺失事实；这不等同于采购完成。" />}</Section>

    <Section title="冲突与人工纠正">{model.conflicts.length ? <div className="space-y-2">{model.conflicts.map((conflict) => <div key={`${conflict.factPath}:${conflict.selectedEvidenceId}`} className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800"><div className="font-semibold">{conflict.factPath}</div><div className="mt-1">已选择证据 {conflict.selectedEvidenceId}，另有 {conflict.conflictingEvidenceIds.length} 条冲突证据。</div></div>)}</div> : <div className="text-xs text-slate-500">当前没有已识别的事实冲突。</div>}{permissions.operate !== true ? <div className="mt-3 text-[11px] text-slate-400">当前身份没有提交事实纠正的 operate 权限。</div> : null}</Section>

    <Section title="Agent 记录">{model.agentEvents.length ? <div className="space-y-2">{model.agentEvents.map((event) => <div key={String(event.id)} className="rounded-xl border border-slate-200 p-3 text-xs"><div className="font-semibold text-slate-800">{contextValue(event.eventType)} · {contextValue(event.status)}</div><div className="mt-1 text-[11px] text-slate-500">{typeof event.actionName === "string" && event.actionName ? event.actionName : "无动作名称"} · {date(event.createdAt)}</div></div>)}</div> : <Empty text="尚无可展示的 Agent 记录。" />}</Section>

    <Section title="投影状态与水位"><div className="grid gap-2 text-xs sm:grid-cols-2"><Fact label="投影状态" value={model.projection.status === "current" ? "当前" : model.projection.status} /><Fact label="来源水位" value={model.projection.sourceWatermark || "未提供"} /><Fact label="截断" value={model.projection.truncated ? "是；列表可能不完整" : "否"} /><Fact label="下一游标" value={model.projection.nextCursor ?? "无"} /></div></Section>

    {draft ? <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4"><div className="text-sm font-semibold text-slate-900">提交事实纠正</div><p className="mt-1 text-xs leading-5 text-slate-600">仅创建待审批记录，不会直接修改 Twin 或采购事实。</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-medium text-slate-700">实体<input disabled value={draft.entityLabel} className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-slate-100 px-2 text-sm" /></label><label className="text-xs font-medium text-slate-700">事实路径<input value={draft.factPath} onChange={(event) => setDraft({ ...draft, factPath: event.target.value })} placeholder="purchase_order.status" className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm" /></label><label className="text-xs font-medium text-slate-700">当前值<input value={draft.oldValue} onChange={(event) => setDraft({ ...draft, oldValue: event.target.value })} className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm" /></label><label className="text-xs font-medium text-slate-700">建议值<input value={draft.newValue} onChange={(event) => setDraft({ ...draft, newValue: event.target.value })} className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm" /></label><label className="text-xs font-medium text-slate-700 sm:col-span-2">证据引用<input value={draft.evidenceReference} onChange={(event) => setDraft({ ...draft, evidenceReference: event.target.value })} placeholder="例如 attachment:PO-20260830-01" className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm" /></label><label className="text-xs font-medium text-slate-700 sm:col-span-2">纠正原因<textarea value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} className="mt-1.5 min-h-20 w-full rounded-lg border border-slate-200 bg-white p-2 text-sm" /></label></div>{correctionError ? <div className="mt-3 text-xs text-red-700">{correctionError}</div> : null}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={submitting} onClick={() => setDraft(null)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700">取消</button><button type="button" disabled={submitting || !draft.entityId || !draft.factPath.trim() || !draft.oldValue.trim() || !draft.newValue.trim() || !draft.reason.trim() || !draft.evidenceReference.trim()} onClick={() => void submitCorrection()} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{submitting ? "正在提交…" : "提交待审批纠正"}</button></div></div> : null}
    </div> : null}
  </div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <section><div className="mb-2 text-xs font-semibold text-slate-800">{title}</div>{children}</section>; }
function Empty({ text }: { text: string }) { return <div className="rounded-xl border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-400">{text}</div>; }
function Fact({ label, value }: { label: string; value: unknown }) { return <div className="rounded-lg bg-slate-50 p-2"><div className="text-[10px] font-medium text-slate-400">{label}</div><div className="mt-1 break-words text-xs text-slate-700">{contextValue(value)}</div></div>; }
function CorrectionButton({ onClick }: { onClick: () => void }) { return <button type="button" onClick={onClick} className={cn("shrink-0 rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:border-blue-200 hover:text-blue-600")} aria-label="提交事实纠正"><PencilLine className="size-3.5" /></button>; }
function SummaryMetric({ label, value, tone = "neutral", className }: { label: string; value: string | number; tone?: "neutral" | "success" | "warning" | "danger"; className?: string }) {
  return <div className={cn("border-r border-[#edf1f6] px-3 py-3 last:border-r-0", className)}><div className="text-[10px] font-medium text-[#94a3b8]">{label}</div><div className={cn("mt-1 truncate text-xs font-semibold", tone === "success" ? "text-emerald-600" : tone === "warning" ? "text-amber-600" : tone === "danger" ? "text-red-500" : "text-[#26364f]")}>{value}</div></div>;
}
