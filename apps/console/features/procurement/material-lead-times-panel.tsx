"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";

type RouteValue = "local" | "import";
type Criticality = "low" | "medium" | "high";
type LeadTimeItem = {
  id: string;
  supplier_id: string;
  supplier_name: string;
  material: string;
  item_code: string;
  material_type: string;
  procurement_route: RouteValue;
  standard_lead_time_days: number;
  criticality: Criticality;
  remarks: string;
  status: "active" | "retired";
  version: number;
  updated_by: string;
  updated_at: string;
};
type LeadTimeResponse = {
  items: LeadTimeItem[];
  suppliers: Array<{ id: string; name: string; status: string; version: number }>;
  permissions: { read: boolean; configure: boolean };
  events: Array<{ id: string; leadTimeId: string; actorId: string; action: string; createdAt: string }>;
};
type FormValue = {
  supplier_id: string;
  material: string;
  item_code: string;
  material_type: string;
  procurement_route: RouteValue;
  standard_lead_time_days: string;
  criticality: Criticality;
  remarks: string;
  reason: string;
};
type LeadTimeMutationKind = "save" | "retire";
type LeadTimeRefreshRequirement = {
  reason: "conflict" | "uncertain" | "reload";
  action: LeadTimeMutationKind;
  currentVersion: number | null;
};

const emptyForm: FormValue = {
  supplier_id: "",
  material: "",
  item_code: "",
  material_type: "",
  procurement_route: "local",
  standard_lead_time_days: "",
  criticality: "medium",
  remarks: "",
  reason: "",
};

function errorText(error: unknown): string {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 409) return "记录已被其他人更新；已保留当前输入，请重新读取最新版本后核对。";
    if (error.status === 403) return "当前账号没有配置制造交期的权限。";
    return error.message;
  }
  return error instanceof Error ? error.message : "制造交期请求失败";
}
function refreshText(requirement: LeadTimeRefreshRequirement): string {
  if (requirement.reason === "conflict") {
    return requirement.currentVersion === null
      ? "服务端交期版本已变化；重试前必须重新读取。"
      : `服务端当前交期版本 v${requirement.currentVersion}；重试前必须重新读取。`;
  }
  return requirement.reason === "uncertain"
    ? "上次请求结果未知；重试前必须先重新读取权威交期状态。"
    : "写入已接受，但权威交期状态尚未读回；重新读取前不会再次提交。";
}

function routeLabel(value: RouteValue): string { return value === "import" ? "进口" : "本地"; }

function matchesReviewedLeadTime(item: LeadTimeItem, form: FormValue): boolean {
  return item.status === "active"
    && item.supplier_id === form.supplier_id
    && item.material === form.material.trim()
    && item.item_code === form.item_code.trim()
    && item.material_type === form.material_type.trim()
    && item.procurement_route === form.procurement_route
    && item.standard_lead_time_days === Number(form.standard_lead_time_days)
    && item.criticality === form.criticality
    && item.remarks === form.remarks.trim();
}

export function ProcurementMaterialLeadTimesPanel({ manageSupplierId = null, onManageHandled }: { manageSupplierId?: string | null; onManageHandled?: () => void } = {}) {
  const [data, setData] = useState<LeadTimeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState<LeadTimeRefreshRequirement | null>(null);
  const [editing, setEditing] = useState<LeadTimeItem | null | "new">(null);
  const [retiring, setRetiring] = useState<LeadTimeItem | null>(null);
  const [form, setForm] = useState<FormValue>(emptyForm);
  const [retireReason, setRetireReason] = useState("");
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const mutationInFlight = useRef(false);
  const restoreFocusAfterMutation = useRef(false);

  const load = useCallback(async (): Promise<LeadTimeResponse | null> => {
    setLoading(true); setError(null);
    try {
      const result = await apiRequest<LeadTimeResponse>("/api/po/lead-times");
      setData(result);
      return result;
    }
    catch (requestError) { setError(requestError); }
    finally { setLoading(false); }
    return null;
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (editing || retiring || !restoreFocusAfterMutation.current) return;
    restoreFocusAfterMutation.current = false;
    const frame = requestAnimationFrame(() => {
      const target = returnFocusRef.current?.isConnected
        ? returnFocusRef.current
        : document.querySelector<HTMLButtonElement>("[data-lead-time-add]");
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, retiring]);

  function openCreate(trigger: HTMLElement | null = null) {
    returnFocusRef.current = trigger;
    setEditing("new");
    setForm({ ...emptyForm, supplier_id: data?.suppliers.find((supplier) => supplier.status === "active")?.id ?? data?.suppliers[0]?.id ?? "" });
    setError(null); setNotice(null); setRefreshRequired(null);
  }
  function openEdit(item: LeadTimeItem, trigger: HTMLElement) {
    returnFocusRef.current = trigger;
    setEditing(item);
    setForm({
      supplier_id: item.supplier_id,
      material: item.material,
      item_code: item.item_code,
      material_type: item.material_type,
      procurement_route: item.procurement_route,
      standard_lead_time_days: String(item.standard_lead_time_days),
      criticality: item.criticality,
      remarks: item.remarks,
      reason: "",
    });
    setError(null); setNotice(null); setRefreshRequired(null);
  }

  useEffect(() => {
    if (!manageSupplierId || !data) return;
    const supplier = data.suppliers.find((item) => item.id === manageSupplierId);
    if (!supplier) return;
    returnFocusRef.current = null;
    setEditing("new");
    setForm({ ...emptyForm, supplier_id: supplier.id });
    setError(null); setNotice(null); setRefreshRequired(null);
    document.getElementById("material-lead-times")?.scrollIntoView({ behavior: "smooth", block: "start" });
    onManageHandled?.();
  }, [data, manageSupplierId, onManageHandled]);

  const valid = Boolean(
    form.supplier_id
    && Number.isSafeInteger(Number(form.standard_lead_time_days))
    && Number(form.standard_lead_time_days) >= 1
    && Number(form.standard_lead_time_days) <= 3650
    && form.reason.trim().length >= 10,
  );
  const writable = data?.permissions.configure === true;
  const writeLocked = busy || !writable;

  function currentVersion(requestError: ReadyworkApiError): number | null {
    if (!requestError.payload || typeof requestError.payload !== "object") return null;
    const payload = requestError.payload as Record<string, unknown>;
    const version = payload["current_version"] ?? payload["currentVersion"];
    return typeof version === "number" && Number.isSafeInteger(version) ? version : null;
  }

  function recordMutationFailure(requestError: unknown, action: LeadTimeMutationKind): void {
    setError(requestError);
    if (!(requestError instanceof ReadyworkApiError)) return;
    if (requestError.status === 403) {
      setData((current) => current ? { ...current, permissions: { ...current.permissions, configure: false } } : current);
      return;
    }
    if (requestError.status === 409 || requestError.status === 404) {
      setRefreshRequired({ reason: "conflict", action, currentVersion: currentVersion(requestError) });
    } else if (requestError.status === 0 || requestError.status === 408) {
      setRefreshRequired({ reason: "uncertain", action, currentVersion: null });
    }
  }

  async function reloadAfterMutation(action: LeadTimeMutationKind, version: number | null): Promise<boolean> {
    if (await load()) return true;
    const requestError = new Error("写入已由服务端接受，但最新权威交期状态尚未读回。");
    setError(requestError);
    setRefreshRequired({ reason: "reload", action, currentVersion: version });
    return false;
  }

  async function rereadMutationAuthority(): Promise<void> {
    if (!refreshRequired || loading) return;
    const requirement = refreshRequired;
    const result = await load();
    if (!result) return;
    const reviewedEdit = editing;
    const reviewedRetire = retiring;
    const currentEdit = reviewedEdit && reviewedEdit !== "new"
      ? result.items.find((item) => item.id === reviewedEdit.id)
      : null;
    const currentRetire = reviewedRetire
      ? result.items.find((item) => item.id === reviewedRetire.id)
      : null;
    if (currentEdit) setEditing(currentEdit);
    if (currentRetire) setRetiring(currentRetire);
    setRefreshRequired(null);
    setError(null);
    if (requirement.reason === "uncertain") {
      const acceptedSave = requirement.action !== "save"
        ? false
        : reviewedEdit === "new"
          ? result.items.some((item) => matchesReviewedLeadTime(item, form))
          : Boolean(reviewedEdit && currentEdit && currentEdit.version > reviewedEdit.version && matchesReviewedLeadTime(currentEdit, form));
      const acceptedRetire = requirement.action === "retire" && Boolean(reviewedRetire && !currentRetire);
      if (acceptedSave || acceptedRetire) {
        restoreFocusAfterMutation.current = true;
        if (acceptedSave) setEditing(null);
        else { setRetiring(null); setRetireReason(""); }
        setNotice(acceptedSave ? "制造交期已从服务端确认保存。" : "制造交期已从服务端确认退役。");
        return;
      }
      setNotice(result.permissions.configure
        ? "已重新读取服务端状态；原请求未落库，已审核输入仍保留，现在可以安全重试。"
        : "已重新读取服务端状态；当前账号没有配置权限，已审核输入仍保留。");
      return;
    }
    if (requirement.reason !== "reload") {
      setNotice("已重新读取服务端版本；已审核输入仍保留，现在可以重新提交。");
      return;
    }
    if (requirement.action === "save") {
      restoreFocusAfterMutation.current = true;
      setEditing(null);
      setNotice("制造交期已从服务端确认保存。");
    } else {
      restoreFocusAfterMutation.current = true;
      setRetiring(null); setRetireReason("");
      setNotice("制造交期已从服务端确认退役。");
    }
  }

  async function save() {
    if (refreshRequired || !editing || mutationInFlight.current || busy || !valid || data?.permissions.configure !== true) return;
    mutationInFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    const operation = editing;
    const supplier = data?.suppliers.find((item) => item.id === form.supplier_id);
    const body = {
      supplier_id: form.supplier_id,
      supplier_name: supplier?.name,
      material: form.material.trim(),
      item_code: form.item_code.trim(),
      material_type: form.material_type.trim(),
      procurement_route: form.procurement_route,
      standard_lead_time_days: Number(form.standard_lead_time_days),
      criticality: form.criticality,
      remarks: form.remarks.trim(),
      reason: form.reason.trim(),
    };
    try {
      const response = operation === "new"
        ? await apiRequest<{ item?: LeadTimeItem }>("/api/po/lead-times", { method: "POST", body })
        : await apiRequest<{ item?: LeadTimeItem }>(`/api/po/lead-times/${encodeURIComponent(operation.id)}`, { method: "PATCH", body: { ...body, expected_version: operation.version } });
      if (!(await reloadAfterMutation("save", response.item?.version ?? null))) return;
      restoreFocusAfterMutation.current = true;
      setEditing(null);
      setNotice(operation === "new" ? "制造交期已保存，并会作为后续 PO 风险判断的版本化证据。" : "制造交期已更新；新的风险/SLA 计算会冻结本次版本。" );
    } catch (requestError) {
      recordMutationFailure(requestError, "save");
    } finally { mutationInFlight.current = false; setBusy(false); }
  }

  async function retire() {
    if (refreshRequired || !retiring || mutationInFlight.current || busy || data?.permissions.configure !== true || retireReason.trim().length < 10) return;
    mutationInFlight.current = true;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await apiRequest<{ item?: LeadTimeItem }>(`/api/po/lead-times/${encodeURIComponent(retiring.id)}`, {
        method: "DELETE",
        body: { expected_version: retiring.version, reason: retireReason.trim() },
      });
      if (!(await reloadAfterMutation("retire", response.item?.version ?? null))) return;
      restoreFocusAfterMutation.current = true;
      setRetiring(null); setRetireReason("");
      setNotice("制造交期已退役；历史审计和旧风险快照仍保留，新的风险计算不再命中该记录。" );
    } catch (requestError) {
      recordMutationFailure(requestError, "retire");
    } finally { mutationInFlight.current = false; setBusy(false); }
  }

  return <>
    <section id="material-lead-times" className="scroll-mt-24">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-950">制造交期（SLA）</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">按供应商和物料维护制造交期；创建采购订单时，风险引擎会立即查询这些主数据。同一供应商的不同物料可以设置不同周期。</p>
        </div>
        {data?.permissions.configure && <Button data-lead-time-add size="sm" onClick={(event) => openCreate(event.currentTarget)} className="h-9 shrink-0 px-4"><Plus className="size-3.5" />添加交期</Button>}
      </div>
      <div className="mt-4 space-y-4">
        {error !== null && <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700"><span className="flex items-start gap-2"><AlertCircle className="mt-0.5 size-4 shrink-0" />{errorText(error)}</span><button type="button" onClick={() => void (refreshRequired ? rereadMutationAuthority() : load())} className="flex shrink-0 items-center gap-1 font-semibold hover:underline"><RefreshCw className="size-3.5" />重新读取</button></div>}
        {refreshRequired && <LeadTimeRefreshAlert requirement={refreshRequired} loading={loading} onReread={() => void rereadMutationAuthority()} />}
        {notice && <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs leading-5 text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</div>}
        <div className="overflow-x-auto rounded-2xl border border-slate-200">
          <table className="min-w-[960px] w-full text-left text-xs">
            <thead className="bg-slate-50/80 text-[11px] font-medium text-slate-500"><tr><th className="px-4 py-3">供应商</th><th className="px-4 py-3">物料</th><th className="px-4 py-3">物料编码</th><th className="px-4 py-3">采购路线</th><th className="px-4 py-3 text-right">交期</th><th className="px-4 py-3">关键程度</th><th className="px-4 py-3">备注</th><th className="px-4 py-3 text-right">操作</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-400"><span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在加载制造交期…</span></td></tr> : data?.items.length ? data.items.map((item) => <tr key={item.id} className={item.status === "retired" ? "bg-slate-50/50 text-slate-400" : "text-slate-700"}>
                <td data-preserve-language className="px-4 py-3 font-medium text-slate-800">{item.supplier_name}</td>
                <td data-preserve-language className="px-4 py-3">{item.material || "—"}</td>
                <td data-preserve-language className="px-4 py-3">{item.item_code || "—"}</td>
                <td className="px-4 py-3"><Badge tone={item.procurement_route === "import" ? "violet" : "blue"}>{routeLabel(item.procurement_route)}</Badge></td>
                <td className="px-4 py-3 text-right font-semibold text-slate-900">{item.standard_lead_time_days} 天</td>
                <td className="px-4 py-3"><CriticalityLabel value={item.criticality} /></td>
                <td className="max-w-[260px] px-4 py-3"><div data-preserve-language className="line-clamp-2 leading-5">{item.remarks || "—"}</div></td>
                <td className="px-4 py-3"><div className="flex justify-end gap-1">{item.status === "retired" ? <Badge tone="neutral">已停用</Badge> : data.permissions.configure ? <><button type="button" aria-label="编辑交期" onClick={(event) => openEdit(item, event.currentTarget)} className="flex size-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Pencil className="size-3.5" /></button><button type="button" aria-label="退役交期" onClick={(event) => { returnFocusRef.current = event.currentTarget; setRetiring(item); setRetireReason(""); setError(null); setNotice(null); setRefreshRequired(null); }} className="flex size-8 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="size-3.5" /></button></> : <Badge tone="neutral">只读</Badge>}</div></td>
              </tr>) : <tr><td colSpan={8} className="px-4 py-14 text-center"><Clock3 className="mx-auto size-7 text-slate-300" /><div className="mt-3 text-sm font-medium text-slate-600">暂无制造交期记录。</div><div className="mt-1 text-xs text-slate-400">按供应商和物料添加记录，以便 Readywork 在采购订单发送时评估要求日期。</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    {editing && <Modal title={editing === "new" ? "添加制造交期" : "编辑制造交期"} description="供应商身份来自当前租户主数据；留空物料和编码可创建供应商/路线默认周期。" returnFocusElement={returnFocusRef.current} onClose={() => !busy && setEditing(null)}>
      {error !== null && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700">{errorText(error)}</div>}
      {refreshRequired && <LeadTimeRefreshAlert requirement={refreshRequired} loading={loading} onReread={() => void rereadMutationAuthority()} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="供应商名称 *"><select aria-label="交期供应商" value={form.supplier_id} onChange={(event) => setForm({ ...form, supplier_id: event.target.value })} disabled={writeLocked}>{data?.suppliers.map((supplier) => <option data-preserve-language key={supplier.id} value={supplier.id}>{supplier.name}{supplier.status !== "active" ? "（已停用）" : ""}</option>)}</select></Field>
        <Field label="采购路线 *"><select value={form.procurement_route} onChange={(event) => setForm({ ...form, procurement_route: event.target.value as RouteValue })} disabled={writeLocked}><option value="local">本地</option><option value="import">进口</option></select></Field>
        <Field label="物料"><input value={form.material} disabled={writeLocked} onChange={(event) => setForm({ ...form, material: event.target.value })} maxLength={240} placeholder="例：气动真空阀" /></Field>
        <Field label="物料编码"><input value={form.item_code} disabled={writeLocked} onChange={(event) => setForm({ ...form, item_code: event.target.value })} maxLength={160} placeholder="例：PV-30" /></Field>
        <Field label="物料类型"><input value={form.material_type} disabled={writeLocked} onChange={(event) => setForm({ ...form, material_type: event.target.value })} maxLength={160} placeholder="例：工业阀门" /></Field>
        <Field label="交期（天） *"><input aria-label="交期（天）" type="number" min={1} max={3650} value={form.standard_lead_time_days} disabled={writeLocked} onChange={(event) => setForm({ ...form, standard_lead_time_days: event.target.value })} placeholder="例：63" /></Field>
        <Field label="备注" wide><textarea value={form.remarks} disabled={writeLocked} onChange={(event) => setForm({ ...form, remarks: event.target.value })} maxLength={1000} placeholder="供应商协议、适用范围或制造周期说明" /></Field>
        <div className="sm:col-span-2">
          <h4 className="text-sm font-semibold text-slate-900">产品关键程度评分</h4>
          <p className="mt-0.5 text-xs text-slate-500">设置该供应商所供产品的关键程度。</p>
          <p className="mb-1 mt-3 text-xs font-medium text-slate-700">产品关键程度 <span className="text-red-600">*</span></p>
          <div className="grid grid-cols-3 gap-3">{(["low", "medium", "high"] as const).map((value) => <CriticalityButton key={value} value={value} selected={form.criticality === value} disabled={writeLocked} onSelect={() => setForm({ ...form, criticality: value })} />)}</div>
          <p className="mt-2.5 text-[11px] text-slate-500">用于计算该供应商采购订单的风险评分。</p>
        </div>
        <Field label={editing === "new" ? "配置依据 *" : "变更依据 *"} wide><textarea aria-label={editing === "new" ? "配置依据" : "变更依据"} value={form.reason} disabled={writeLocked} onChange={(event) => setForm({ ...form, reason: event.target.value })} maxLength={500} placeholder="说明可追溯的业务依据（至少 10 个字符）" /></Field>
      </div>
      <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setEditing(null)} disabled={busy}>取消</Button><Button onClick={() => void save()} aria-busy={busy} disabled={!writable || busy || Boolean(refreshRequired) || !valid}>{busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}{busy ? "正在保存…" : editing === "new" ? "添加交期" : "保存更改"}</Button></div>
    </Modal>}

    {retiring && <Modal title="退役制造交期" description={`${retiring.supplier_name} · ${retiring.item_code || retiring.material || "默认所有物料"} · ${routeLabel(retiring.procurement_route)}`} returnFocusElement={returnFocusRef.current} onClose={() => !busy && setRetiring(null)}>
      {error !== null && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700">{errorText(error)}</div>}
      {refreshRequired && <LeadTimeRefreshAlert requirement={refreshRequired} loading={loading} onReread={() => void rereadMutationAuthority()} />}
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800">退役不会删除历史。旧风险快照和审计仍保留此版本，新的 PO 风险计算将不再命中。</div>
      <Field label="退役依据 *" wide><textarea value={retireReason} disabled={writeLocked} onChange={(event) => setRetireReason(event.target.value)} maxLength={500} placeholder="说明退役原因（至少 10 个字符）" /></Field>
      <div className="mt-5 flex justify-end gap-2"><Button variant="outline" onClick={() => setRetiring(null)} disabled={busy}>取消</Button><Button variant="danger" onClick={() => void retire()} aria-busy={busy} disabled={!writable || busy || Boolean(refreshRequired) || retireReason.trim().length < 10}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{busy ? "退役中…" : "确认退役"}</Button></div>
    </Modal>}
  </>;
}

function LeadTimeRefreshAlert({ requirement, loading, onReread }: { requirement: LeadTimeRefreshRequirement; loading: boolean; onReread: () => void }) {
  return <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><span>{refreshText(requirement)}</span><button type="button" onClick={onReread} disabled={loading} className="shrink-0 font-semibold text-amber-900 hover:underline disabled:opacity-50">重新读取</button></div>;
}

function Modal({ title, description, returnFocusElement, onClose, children }: { title: string; description: string; returnFocusElement: HTMLElement | null; onClose: () => void; children: React.ReactNode }) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent closeLabel="关闭" className="max-w-2xl p-5" aria-label={title} onCloseAutoFocus={(event) => { if (!returnFocusElement) return; event.preventDefault(); returnFocusElement.focus(); }}><div className="pr-10"><DialogTitle className="text-lg font-semibold text-slate-950">{title}</DialogTitle><DialogDescription className="mt-1 text-sm leading-6 text-slate-500">{description}</DialogDescription></div><div className="mt-5 space-y-3">{children}</div></DialogContent></Dialog>;
}

const criticalityMeta = {
  low: { label: "低", hint: "延迟影响较低", dot: "#16a34a" },
  medium: { label: "中", hint: "延迟影响中等", dot: "#f59e0b" },
  high: { label: "高", hint: "延迟影响较高", dot: "#ef4444" },
} as const;

function CriticalityLabel({ value }: { value: Criticality }) {
  const meta = criticalityMeta[value];
  return <span className="flex items-center gap-2"><span aria-hidden="true" data-criticality={value} className="size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.dot }} />{meta.label}</span>;
}

function CriticalityButton({ value, selected, disabled = false, onSelect }: { value: Criticality; selected: boolean; disabled?: boolean; onSelect: () => void }) {
  const meta = criticalityMeta[value];
  return <button type="button" aria-label={`关键程度：${meta.label}`} aria-pressed={selected} disabled={disabled} onClick={onSelect} className={`rounded-xl border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${selected ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500" : "border-slate-200 hover:border-slate-300"}`}><span className="flex items-center gap-2 text-sm font-semibold text-slate-900"><span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: meta.dot }} />{meta.label}</span><span className="mt-1 block text-[10px] leading-4 text-slate-500">{meta.hint}</span></button>;
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={`block text-xs font-medium text-slate-600 ${wide ? "sm:col-span-2" : ""}`}><span>{label}</span><span className="mt-1.5 block [&_input]:h-10 [&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:border-slate-200 [&_input]:px-3 [&_input]:text-sm [&_input]:outline-none [&_input]:focus:border-blue-400 [&_select]:h-10 [&_select]:w-full [&_select]:rounded-xl [&_select]:border [&_select]:border-slate-200 [&_select]:bg-white [&_select]:px-3 [&_select]:text-sm [&_select]:outline-none [&_select]:focus:border-blue-400 [&_textarea]:min-h-20 [&_textarea]:w-full [&_textarea]:resize-none [&_textarea]:rounded-xl [&_textarea]:border [&_textarea]:border-slate-200 [&_textarea]:p-3 [&_textarea]:text-sm [&_textarea]:outline-none [&_textarea]:focus:border-blue-400">{children}</span></label>;
}
