"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Inbox, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { procurementCalendarDate, useProcurementLocale } from "@/features/procurement/tenant-preferences-context";

type IntakeStatus = "received" | "scanning" | "parsing" | "needs_review" | "rejected" | "accepted";
type Intake = {
  id: string; sender: string; subject: string; receivedAt: string; status: IntakeStatus; version: number; acceptedPoId?: string | null; rejectionReason?: string | null;
  attachment: null | { id: string; fileName: string; contentType: string; sizeBytes: number; securityStatus: string; processingStatus: string; scanError?: string | null; parseError?: string | null; extractedTextPreview?: string | null; contentUrl: string };
};
type SupplierOption = { id: string; name: string; currency: string };
type Payload = { items: Intake[]; suppliers: SupplierOption[]; permissions: { operate: boolean; approve: boolean } };
type DraftLine = { lineNumber: string; itemId: string; description: string; orderedQty: string; uom: string; unitPrice: string; requestedAt: string };

const statusLabel: Record<IntakeStatus, string> = { received: "已接收", scanning: "安全扫描中", parsing: "解析中", needs_review: "待人工核验", rejected: "已阻断", accepted: "已生成 PO" };
const statusClass: Record<IntakeStatus, string> = {
  received: "bg-slate-100 text-slate-600", scanning: "bg-amber-50 text-amber-700", parsing: "bg-blue-50 text-blue-700",
  needs_review: "bg-violet-50 text-violet-700", rejected: "bg-red-50 text-red-700", accepted: "bg-emerald-50 text-emerald-700",
};
const emptyLine = (index: number): DraftLine => ({ lineNumber: String((index + 1) * 10), itemId: "", description: "", orderedQty: "", uom: "件", unitPrice: "", requestedAt: "" });

export function ProcurementPoIntake({ onOpenOrder }: { onOpenOrder: (poId?: string | null) => void }) {
  const { preferences, formatShortDateTime, formatDateTime } = useProcurementLocale();
  const orderedAtDefaultRef = useRef(procurementCalendarDate(new Date(), preferences.timeZone));
  const orderedAtTimeZoneRef = useRef(preferences.timeZone);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [purchaseOrderNumber, setPurchaseOrderNumber] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [currency, setCurrency] = useState("CNY");
  const [orderedAt, setOrderedAt] = useState(orderedAtDefaultRef.current);
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(0)]);

  useEffect(() => {
    if (orderedAtTimeZoneRef.current === preferences.timeZone) return;
    const nextDefault = procurementCalendarDate(new Date(), preferences.timeZone);
    setOrderedAt((current) => current === orderedAtDefaultRef.current ? nextDefault : current);
    orderedAtDefaultRef.current = nextDefault;
    orderedAtTimeZoneRef.current = preferences.timeZone;
  }, [preferences.timeZone]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await apiRequest<Payload>("/api/procurement/po-intake");
      setPayload(result);
      setSelectedId((current) => current && result.items.some((item) => item.id === current) ? current : result.items.find((item) => item.status === "needs_review")?.id ?? result.items[0]?.id ?? null);
    } catch (value) { setError(value instanceof Error ? value.message : "无法读取邮箱 PO 待核验队列"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const selected = payload?.items.find((item) => item.id === selectedId) ?? null;
  const counts = useMemo(() => ({ total: payload?.items.length ?? 0, review: payload?.items.filter((item) => item.status === "needs_review").length ?? 0, processing: payload?.items.filter((item) => ["received", "scanning", "parsing"].includes(item.status)).length ?? 0, blocked: payload?.items.filter((item) => item.status === "rejected").length ?? 0 }), [payload]);

  const chooseSupplier = (value: string) => {
    setSupplierId(value);
    const supplier = payload?.suppliers.find((item) => item.id === value);
    if (supplier?.currency) setCurrency(supplier.currency);
  };
  const accept = async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const result = await apiRequest<{ purchaseOrder: { id: string } }>(`/api/procurement/po-intake/${encodeURIComponent(selected.id)}/accept`, {
        method: "POST",
        body: { expectedVersion: selected.version, purchaseOrderNumber, supplierId, currency, orderedAt, lines: lines.map((line) => ({ lineNumber: line.lineNumber, itemId: line.itemId, description: line.description || undefined, orderedQty: Number(line.orderedQty), uom: line.uom, unitPrice: Number(line.unitPrice), requestedAt: line.requestedAt })) },
      });
      await load(); onOpenOrder(result.purchaseOrder.id);
    } catch (value) { setError(value instanceof ReadyworkApiError || value instanceof Error ? value.message : "生成 PO 失败"); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    if (!selected) return;
    const reason = window.prompt("请填写阻断原因。该操作会保留原邮件与审计证据。", selected.rejectionReason ?? "不是采购订单或内容无法核验");
    if (!reason?.trim()) return;
    setBusy(true); setError(null);
    try { await apiRequest(`/api/procurement/po-intake/${encodeURIComponent(selected.id)}/reject`, { method: "POST", body: { expectedVersion: selected.version, reason: reason.trim() } }); await load(); }
    catch (value) { setError(value instanceof Error ? value.message : "阻断失败"); }
    finally { setBusy(false); }
  };
  const canAccept = Boolean(selected?.status === "needs_review" && payload?.permissions.approve && purchaseOrderNumber.trim() && supplierId && orderedAt && lines.length && lines.every((line) => line.itemId.trim() && Number(line.orderedQty) > 0 && line.uom.trim() && Number(line.unitPrice) >= 0 && line.requestedAt));

  return <div className="space-y-6">
    <section className="rounded-2xl border border-slate-200 bg-white px-6 py-5 shadow-sm shadow-slate-100/70">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-blue-600"><Inbox className="size-4" /> Email-only PO intake</div><h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">邮箱 PO 待核验</h1><p className="mt-1 max-w-3xl text-sm text-slate-500">从真实邮箱接收 PO 附件，依次完成 MIME 安全处理、ClamAV、文档解析和人工逐行核验。生成的只是 PO 草稿，不会发邮件或回写 ERP。</p></div>
        <button onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />刷新</button>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-4">{[["全部邮件附件", counts.total], ["待人工核验", counts.review], ["处理中", counts.processing], ["安全阻断", counts.blocked]].map(([label, value]) => <div key={label} className="rounded-xl border border-slate-100 bg-slate-50/70 px-4 py-3"><div className="text-2xl font-semibold text-slate-950">{value}</div><div className="mt-1 text-xs text-slate-500">{label}</div></div>)}</div>
    </section>

    {error && <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{error}</div>}

    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-100/70">
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(180px,.7fr)_150px_140px_28px] gap-4 border-b border-slate-100 bg-slate-50/70 px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400"><span>邮件 / 附件</span><span>发件人</span><span>接收时间</span><span>处理状态</span><span /></div>
      {loading ? <div className="flex h-36 items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" />正在读取真实邮箱记录</div> : !payload?.items.length ? <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center"><Inbox className="size-9 text-slate-300" /><div className="mt-3 text-sm font-medium text-slate-700">当前没有 PO 附件待核验</div><div className="mt-1 text-xs text-slate-400">未匹配现有 PO 的真实邮件附件会在安全接收后进入这里；系统不会注入演示记录。</div></div> : payload.items.map((item) => <button key={item.id} onClick={() => setSelectedId(item.id)} className={`grid w-full grid-cols-[minmax(0,1.4fr)_minmax(180px,.7fr)_150px_140px_28px] gap-4 border-b border-slate-100 px-5 py-4 text-left transition last:border-b-0 ${selectedId === item.id ? "bg-blue-50/60" : "hover:bg-slate-50"}`}>
        <span className="min-w-0"><span className="block truncate text-sm font-medium text-slate-900">{item.subject || "（无主题）"}</span><span className="mt-1 block truncate text-xs text-slate-400">{item.attachment?.fileName ?? "附件不可用"}</span></span><span className="truncate text-sm text-slate-600">{item.sender}</span><span className="text-xs text-slate-500">{formatShortDateTime(item.receivedAt)}</span><span><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusClass[item.status]}`}>{statusLabel[item.status]}</span></span><span className={`mt-2 size-2 rounded-full ${selectedId === item.id ? "bg-blue-600" : "bg-slate-200"}`} />
      </button>)}
    </section>

    {selected && <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm shadow-slate-100/70">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="text-xs font-medium text-slate-400">任务详情</div><h2 className="mt-1 text-lg font-semibold text-slate-950">{selected.subject}</h2><div className="mt-1 text-xs text-slate-500">{selected.sender} · {formatDateTime(selected.receivedAt)}</div></div><span className={`rounded-full px-3 py-1.5 text-xs font-medium ${statusClass[selected.status]}`}>{statusLabel[selected.status]}</span></div>
      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 p-4"><div className="flex items-center gap-2 text-sm font-medium text-slate-800"><FileText className="size-4 text-blue-600" />原始附件</div><div className="mt-3 truncate text-sm text-slate-700">{selected.attachment?.fileName ?? "不可用"}</div><div className="mt-1 text-xs text-slate-400">{selected.attachment ? `${(selected.attachment.sizeBytes / 1024).toFixed(1)} KB · ${selected.attachment.contentType}` : ""}</div>{selected.attachment && <a href={selected.attachment.contentUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex text-xs font-medium text-blue-600 hover:text-blue-700">打开原文件</a>}</div>
        <div className="rounded-xl border border-slate-200 p-4"><div className="flex items-center gap-2 text-sm font-medium text-slate-800"><ShieldCheck className="size-4 text-emerald-600" />安全与解析</div><div className="mt-3 space-y-2 text-xs"><div className="flex justify-between"><span className="text-slate-400">ClamAV</span><span className="font-medium text-slate-700">{selected.attachment?.securityStatus ?? "未知"}</span></div><div className="flex justify-between"><span className="text-slate-400">文档解析</span><span className="font-medium text-slate-700">{selected.attachment?.processingStatus ?? "未知"}</span></div></div>{(selected.attachment?.scanError || selected.attachment?.parseError) && <p className="mt-3 text-xs text-red-600">{selected.attachment.scanError || selected.attachment.parseError}</p>}</div>
        <div className="rounded-xl border border-slate-200 p-4"><div className="text-sm font-medium text-slate-800">解析预览</div><p className="mt-3 line-clamp-5 text-xs leading-5 text-slate-500">{selected.attachment?.extractedTextPreview || "文档解析完成后会显示提取文字；结果仅作核验辅助，不会自动写入 PO。"}</p></div>
      </div>

      {selected.status === "needs_review" && <div className="mt-6 border-t border-slate-100 pt-6"><div className="flex items-center gap-2"><CheckCircle2 className="size-5 text-violet-600" /><h3 className="text-base font-semibold text-slate-900">人工核验并生成 PO 草稿</h3></div><p className="mt-1 text-xs text-slate-500">请以原文件为准确认所有字段。每一行都必须保留 RIHD（要求到货日）；批准后只写入 Readywork SQLite，并进入 PO Sent 阶段的待发送状态。</p>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4"><Field label="PO 编号"><input value={purchaseOrderNumber} onChange={(event) => setPurchaseOrderNumber(event.target.value)} className="input" placeholder="例如 PO-2026-0828" /></Field><Field label="供应商"><select value={supplierId} onChange={(event) => chooseSupplier(event.target.value)} className="input"><option value="">选择已登记供应商</option>{payload?.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></Field><Field label="币种"><input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} className="input" maxLength={8} /></Field><Field label="下单日期"><input type="date" value={orderedAt} onChange={(event) => setOrderedAt(event.target.value)} className="input" /></Field></div>
        <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{["行号", "物料编码", "说明", "数量", "单位", "单价", "RIHD / 要求到货 *", ""].map((label) => <th key={label} className="px-3 py-3 font-medium">{label}</th>)}</tr></thead><tbody>{lines.map((line, index) => <tr key={index} className="border-t border-slate-100"><td className="p-2"><input value={line.lineNumber} onChange={(event) => setLines((items) => items.map((item, i) => i === index ? { ...item, lineNumber: event.target.value } : item))} className="cell" /></td><td className="p-2"><input value={line.itemId} onChange={(event) => setLines((items) => items.map((item, i) => i === index ? { ...item, itemId: event.target.value } : item))} className="cell" /></td><td className="p-2"><input value={line.description} onChange={(event) => setLines((items) => items.map((item, i) => i === index ? { ...item, description: event.target.value } : item))} className="cell" /></td><td className="p-2"><input type="number" min="0" value={line.orderedQty} onChange={(event) => setLines((items) => items.map((item, i) => i === index ? { ...item, orderedQty: event.target.value } : item))} className="cell" /></td><td className="p-2"><input value={line.uom} onChange={(event) => setLines((items) => items.map((item, i) => i === index ? { ...item, uom: event.target.value } : item))} className="cell" /></td><td className="p-2"><input type="number" min="0" step="0.01" value={line.unitPrice} onChange={(event) => setLines((items) => items.map((item, i) => i === index ? { ...item, unitPrice: event.target.value } : item))} className="cell" /></td><td className="p-2"><input required aria-label={`第 ${index + 1} 行 RIHD`} type="date" value={line.requestedAt} onChange={(event) => setLines((items) => items.map((item, i) => i === index ? { ...item, requestedAt: event.target.value } : item))} className="cell" /></td><td className="p-2"><button onClick={() => setLines((items) => items.length === 1 ? items : items.filter((_, i) => i !== index))} className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="size-4" /></button></td></tr>)}</tbody></table></div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><button onClick={() => setLines((items) => [...items, emptyLine(items.length)])} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"><Plus className="size-4" />添加 PO 行</button><div className="flex gap-2"><button onClick={() => void reject()} disabled={busy || !payload?.permissions.operate} className="h-10 rounded-xl border border-slate-200 px-4 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">阻断记录</button><button onClick={() => void accept()} disabled={busy || !canAccept} className="inline-flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-medium text-white shadow-sm shadow-blue-200 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40">{busy && <Loader2 className="size-4 animate-spin" />}核验通过，生成 PO 草稿</button></div></div>
      </div>}
      {selected.status === "accepted" && selected.acceptedPoId && <div className="mt-6 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3"><div className="text-sm text-emerald-800">该附件已经人工核验，并生成真实 PO 草稿。</div><button onClick={() => onOpenOrder(selected.acceptedPoId)} className="text-sm font-medium text-emerald-700 hover:text-emerald-900">打开采购订单</button></div>}
    </section>}
    <style jsx>{`.input{height:40px;width:100%;border:1px solid #e2e8f0;border-radius:10px;background:white;padding:0 12px;font-size:13px;outline:none}.input:focus,.cell:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.1)}.cell{height:36px;width:100%;min-width:76px;border:1px solid #e2e8f0;border-radius:8px;padding:0 9px;font-size:12px;outline:none}`}</style>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-1.5 block text-xs font-medium text-slate-600">{label}</span>{children}</label>; }
