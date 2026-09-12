"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ClipboardList,
  Database,
  Download,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";

type RequisitionSource = "manual" | "erp" | "excel";
interface RequisitionAttachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  url?: string;
  sha256?: string;
  version?: number;
  storageBackend?: "sqlite" | "s3";
  requisitionLineId?: string;
  uploadedBy?: string;
  uploadedAt?: string;
  extractionStatus?: "text_extracted" | "ready_for_document_agent";
  extractedTextPreview?: string;
  securityStatus?: string;
  processingStatus?: string;
  detectedContentType?: string;
  scanError?: string;
  parseError?: string;
  parsedAt?: string;
  parsedSummary?: string;
  structuredData?: unknown;
}
interface AttachmentEvent {
  id?: string;
  attachmentId?: string;
  actorId?: string;
  action?: string;
  detail?: Record<string, unknown>;
  createdAt?: string;
}
interface RequisitionLine {
  id?: string;
  itemCode: string;
  itemName: string;
  quantity: string;
  unit: string;
  targetDate: string;
  technicalRequirements: string;
}
interface RequisitionSummary {
  id: string;
  title: string;
  status?: string;
  source: RequisitionSource;
  requestingDepartment: string;
  requesterName: string;
  currency: string;
  targetDeliveryDate?: string;
  lines?: RequisitionLine[];
  attachments?: RequisitionAttachment[];
  attachmentCount?: number;
  attachmentEvents?: AttachmentEvent[];
  createdAt?: string;
}
interface RequisitionForm {
  source: RequisitionSource;
  title: string;
  requestingDepartment: string;
  requesterName: string;
  currency: string;
  targetDeliveryDate: string;
  lines: RequisitionLine[];
}

const SOURCE_LABEL: Record<RequisitionSource, string> = {
  manual: "人工",
  erp: "ERP",
  excel: "Excel",
};
const STATUS_LABEL: Record<string, string> = {
  submitted: "已提交",
  draft: "草稿",
  approved: "已批准",
  rejected: "已驳回",
};
const EMPTY_LINE = (): RequisitionLine => ({
  itemCode: "",
  itemName: "",
  quantity: "",
  unit: "件",
  targetDate: "",
  technicalRequirements: "",
});
const EMPTY_FORM = (): RequisitionForm => ({
  source: "manual",
  title: "",
  requestingDepartment: "",
  requesterName: "",
  currency: "CNY",
  targetDeliveryDate: "",
  lines: [EMPTY_LINE()],
});
const formatBytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
const SECURITY_STATUS: Record<string, { label: string; tone: "neutral" | "green" | "amber" | "red" }> = {
  pending_scan: { label: "待恶意软件扫描", tone: "amber" },
  clean: { label: "安全扫描通过", tone: "green" },
  scan_failed: { label: "安全扫描失败", tone: "red" },
  quarantined: { label: "已隔离", tone: "red" },
};
const PROCESSING_STATUS: Record<string, { label: string; tone: "neutral" | "green" | "amber" | "red" | "blue" }> = {
  queued: { label: "排队", tone: "amber" },
  processing: { label: "解析中", tone: "blue" },
  parsed: { label: "已解析", tone: "green" },
  parse_failed: { label: "解析失败", tone: "red" },
  needs_ocr: { label: "需要 OCR", tone: "amber" },
  needs_specialist: { label: "需要专用解析器", tone: "amber" },
};
const attachmentStatus = (attachment: RequisitionAttachment) => {
  const security = attachment.securityStatus
    ? SECURITY_STATUS[attachment.securityStatus] ?? { label: attachment.securityStatus, tone: "neutral" as const }
    : undefined;
  let processing = attachment.processingStatus
    ? PROCESSING_STATUS[attachment.processingStatus] ?? { label: attachment.processingStatus, tone: "neutral" as const }
    : undefined;
  // Older API responses only expose extractionStatus; preserve that meaning.
  if (!processing && attachment.extractionStatus) {
    processing = attachment.extractionStatus === "text_extracted"
      ? { label: "已解析", tone: "green" }
      : { label: "排队", tone: "amber" };
  }
  return { security, processing };
};
const ATTACHMENT_ACTION_LABEL: Record<string, string> = {
  uploaded: "上传并保存版本",
  selected_for_rfq: "选入 RFQ 冻结版本",
  downloaded: "下载文件",
  document_retry_requested: "人工重试文档解析",
  malware_scan_pending: "等待恶意软件扫描",
  malware_scan_clean: "恶意软件扫描通过",
  malware_scan_failed: "恶意软件扫描失败",
  malware_quarantined: "检测到威胁并隔离",
  security_quarantined: "文件格式异常并隔离",
  document_parsed: "文档结构化解析完成",
  needs_ocr: "文档需要 OCR",
  needs_specialist: "文档需要专用解析器",
};
const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

function normalizeList(payload: unknown): RequisitionSummary[] {
  const raw = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { items?: unknown[] }).items)
      ? (payload as { items: unknown[] }).items
      : [];
  return raw.filter((item): item is RequisitionSummary =>
    Boolean(
      item &&
        typeof item === "object" &&
        typeof (item as RequisitionSummary).id === "string",
    ),
  );
}

function apiMessage(error: unknown): string {
  if (error instanceof ReadyworkApiError && error.status === 404)
    return "采购需求接口尚未启用（/api/procurement/requisitions）。";
  return error instanceof Error
    ? error.message
    : "采购需求请求失败，请稍后重试。";
}

export function ProcurementRequisitions({
  onNavigateToSourcing,
}: {
  onNavigateToSourcing?: () => void;
}) {
  const { formatDate: displayDate, formatShortDateTime: displayDateTime } = useProcurementLocale();
  const [items, setItems] = useState<RequisitionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<RequisitionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<RequisitionForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [attachmentLineId, setAttachmentLineId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [retryingAttachmentId, setRetryingAttachmentId] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await apiRequest<unknown>(
        "/api/procurement/requisitions",
      );
      const next = normalizeList(payload);
      setItems(next);
      if (selectedId && !next.some((item) => item.id === selectedId))
        setSelectedId(null);
    } catch (requestError) {
      setError(apiMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    void apiRequest<RequisitionSummary>(
      `/api/procurement/requisitions/${encodeURIComponent(selectedId)}`,
    )
      .then((value) => {
        if (!cancelled) setSelected(value);
      })
      .catch((requestError) => {
        if (!cancelled) setDetailError(apiMessage(requestError));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !(selected?.attachments ?? []).some((item) => item.processingStatus === "queued" || item.processingStatus === "processing")) return;
    const timer = window.setInterval(() => {
      void apiRequest<RequisitionSummary>(`/api/procurement/requisitions/${encodeURIComponent(selectedId)}`)
        .then(setSelected)
        .catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [selectedId, selected?.attachments]);

  const updateLine = (index: number, patch: Partial<RequisitionLine>) =>
    setForm((current) => ({
      ...current,
      lines: current.lines.map((line, lineIndex) =>
        lineIndex === index ? { ...line, ...patch } : line,
      ),
    }));
  const canSubmit = useMemo(
    () =>
      Boolean(
        form.title.trim() &&
          form.requestingDepartment.trim() &&
          form.requesterName.trim() &&
          form.lines.length > 0 &&
          (form.targetDeliveryDate ||
            form.lines.every((line) => line.targetDate)) &&
          form.lines.every(
            (line) =>
              line.itemName.trim() &&
              Number(line.quantity) > 0 &&
              line.unit.trim(),
          ),
      ),
    [form],
  );

  const create = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload = {
        idempotencyKey: crypto.randomUUID(),
        source: form.source,
        title: form.title.trim(),
        requestingDepartment: form.requestingDepartment.trim(),
        requesterName: form.requesterName.trim(),
        currency: form.currency,
        ...(form.targetDeliveryDate
          ? { targetDeliveryDate: form.targetDeliveryDate }
          : {}),
        lines: form.lines.map((line) => ({
          itemCode: line.itemCode.trim(),
          itemName: line.itemName.trim(),
          quantity: Number(line.quantity),
          unit: line.unit.trim(),
          ...(line.targetDate ? { targetDate: line.targetDate } : {}),
          ...(line.technicalRequirements.trim()
            ? { technicalRequirements: line.technicalRequirements.trim() }
            : {}),
        })),
      };
      const created = await apiRequest<RequisitionSummary>(
        "/api/procurement/requisitions",
        { method: "POST", body: payload },
      );
      setForm(EMPTY_FORM());
      setShowCreate(false);
      setSuccess(`采购需求 ${created.id ?? ""} 已创建`);
      await load();
      if (created.id) setSelectedId(created.id);
    } catch (requestError) {
      setError(apiMessage(requestError));
    } finally {
      setSaving(false);
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!selectedId || !files?.length || uploading) return;
    setUploading(true);
    setUploadError(null);
    setSuccess(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size === 0) throw new Error(`${file.name} 是空文件。`);
        if (file.size > 8 * 1024 * 1024)
          throw new Error(`${file.name} 超过 8 MB 限制。`);
        await apiRequest<{ attachment: RequisitionAttachment }>(
          `/api/procurement/requisitions/${encodeURIComponent(selectedId)}/attachments`,
          {
            method: "POST",
            timeoutMs: 45_000,
            body: {
              idempotencyKey: crypto.randomUUID(),
              fileName: file.name,
              contentType: file.type || "application/octet-stream",
              sizeBytes: file.size,
              dataBase64: arrayBufferToBase64(await file.arrayBuffer()),
              ...(attachmentLineId
                ? { requisitionLineId: attachmentLineId }
                : {}),
            },
          },
        );
      }
      const refreshed = await apiRequest<RequisitionSummary>(
        `/api/procurement/requisitions/${encodeURIComponent(selectedId)}`,
      );
      setSelected(refreshed);
      setSuccess(`已上传 ${files.length} 个附件，并保存版本、哈希和关联范围。`);
    } catch (requestError) {
      setUploadError(apiMessage(requestError));
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const retryAttachment = async (attachmentId: string) => {
    if (!selectedId || retryingAttachmentId) return;
    setRetryingAttachmentId(attachmentId);
    setUploadError(null);
    try {
      await apiRequest(`/api/procurement/attachments/${encodeURIComponent(attachmentId)}/retry`, { method: "POST", body: {} });
      const refreshed = await apiRequest<RequisitionSummary>(`/api/procurement/requisitions/${encodeURIComponent(selectedId)}`);
      setSelected(refreshed);
    } catch (requestError) {
      setUploadError(apiMessage(requestError));
    } finally {
      setRetryingAttachmentId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-blue-700">
            需求登记 · 物料与交期 · 进入寻源
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            采购需求
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            登记买什么、买多少、什么时候需要；保存后再进入寻源与询价。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className="size-3.5" />
            刷新
          </Button>
          {onNavigateToSourcing && (
            <Button variant="outline" size="sm" onClick={onNavigateToSourcing}>
              进入寻源与询价
              <ArrowRight className="size-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => {
              setShowCreate(true);
              setSuccess(null);
            }}
          >
            <Plus className="size-3.5" />
            新建采购需求
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-blue-50 p-2 text-blue-700">
            <Database className="size-4" />
          </div>
          <div>
            <div className="text-sm font-medium text-slate-800">
              当前入口：人工登记
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              数据会保存到采购数据库；Odoo
              采购需求同步尚未接入，不会将人工记录标记为 ERP 来源。
            </div>
          </div>
        </div>
        <div className="text-xs font-medium text-slate-500">
          已登记 {items.length} 条
        </div>
      </div>
      {success && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
          role="status"
        >
          <span>{success}</span>
          {onNavigateToSourcing && (
            <Button variant="outline" size="sm" onClick={onNavigateToSourcing}>
              前往寻源与询价
              <ArrowRight className="size-3.5" />
            </Button>
          )}
        </div>
      )}
      {error && (
        <div
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
        >
          {error}
        </div>
      )}
      {showCreate && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle>新建采购需求</CardTitle>
                <CardDescription>
                  当前为人工登记；提交后会真实写入采购数据库，不会写回 Odoo
                  或直接发起询价。
                </CardDescription>
              </div>
              <button
                type="button"
                aria-label="关闭创建表单"
                onClick={() => setShowCreate(false)}
              >
                <X className="size-4 text-slate-400" />
              </button>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-xs font-medium text-slate-600">
                需求部门
                <input
                  value={form.requestingDepartment}
                  onChange={(e) =>
                    setForm({ ...form, requestingDepartment: e.target.value })
                  }
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-2 text-sm"
                  placeholder="如：生产部"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                需求人
                <input
                  value={form.requesterName}
                  onChange={(e) =>
                    setForm({ ...form, requesterName: e.target.value })
                  }
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-2 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                币种
                <select
                  value={form.currency}
                  onChange={(e) =>
                    setForm({ ...form, currency: e.target.value })
                  }
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm"
                >
                  <option value="CNY">CNY</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600 md:col-span-2">
                需求标题
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-2 text-sm"
                  placeholder="如：生产线 M6 紧固件采购"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                目标交期（或逐行填写）*
                <input
                  type="date"
                  value={form.targetDeliveryDate}
                  onChange={(e) =>
                    setForm({ ...form, targetDeliveryDate: e.target.value })
                  }
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-2 text-sm"
                />
              </label>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-800">
                  物料行
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm({ ...form, lines: [...form.lines, EMPTY_LINE()] })
                  }
                >
                  <Plus className="size-3.5" />
                  添加物料行
                </Button>
              </div>
              <div className="space-y-3">
                {form.lines.map((line, index) => (
                  <div
                    key={index}
                    className="rounded-xl border border-slate-200 p-3"
                  >
                    <div className="grid gap-2 md:grid-cols-[1fr_1.5fr_110px_90px_150px_auto]">
                      <input
                        value={line.itemCode}
                        onChange={(e) =>
                          updateLine(index, { itemCode: e.target.value })
                        }
                        className="h-8 rounded-lg border border-slate-200 px-2 text-xs"
                        placeholder="物料编码"
                      />
                      <input
                        value={line.itemName}
                        onChange={(e) =>
                          updateLine(index, { itemName: e.target.value })
                        }
                        className="h-8 rounded-lg border border-slate-200 px-2 text-xs"
                        placeholder="物料名称 *"
                      />
                      <input
                        type="number"
                        min="0"
                        value={line.quantity}
                        onChange={(e) =>
                          updateLine(index, { quantity: e.target.value })
                        }
                        className="h-8 rounded-lg border border-slate-200 px-2 text-xs"
                        placeholder="数量 *"
                      />
                      <input
                        value={line.unit}
                        onChange={(e) =>
                          updateLine(index, { unit: e.target.value })
                        }
                        className="h-8 rounded-lg border border-slate-200 px-2 text-xs"
                        placeholder="单位 *"
                      />
                      <input
                        type="date"
                        value={line.targetDate}
                        onChange={(e) =>
                          updateLine(index, { targetDate: e.target.value })
                        }
                        className="h-8 rounded-lg border border-slate-200 px-2 text-xs"
                        title="行目标日期"
                      />
                      <button
                        type="button"
                        aria-label={`删除第 ${index + 1} 行`}
                        disabled={form.lines.length === 1}
                        onClick={() =>
                          setForm({
                            ...form,
                            lines: form.lines.filter(
                              (_, lineIndex) => lineIndex !== index,
                            ),
                          })
                        }
                        className="flex h-8 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                    <textarea
                      value={line.technicalRequirements}
                      onChange={(e) =>
                        updateLine(index, {
                          technicalRequirements: e.target.value,
                        })
                      }
                      className="mt-2 min-h-14 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
                      placeholder="技术要求（可选）"
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2.5 text-xs text-blue-800">
              先保存采购需求，再在需求详情中上传图纸、BOM
              或规格书，并选择关联整张需求或具体物料行。
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreate(false)}>
                取消
              </Button>
              <Button
                disabled={!canSubmit || saving}
                onClick={() => void create()}
              >
                {saving && <Loader2 className="size-3.5 animate-spin" />}
                {saving ? "提交中…" : "创建采购需求"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_460px]">
        <Card>
          <CardHeader>
            <CardTitle>需求列表</CardTitle>
            <CardDescription>
              {loading ? "正在读取真实采购需求…" : `${items.length} 条需求`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-16 text-sm text-slate-400">
                <Loader2 className="mr-2 size-4 animate-spin" />
                加载中…
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 px-4 py-16 text-center text-sm text-slate-400">
                <ClipboardList className="mx-auto mb-2 size-6" />
                暂无采购需求
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => {
                      setSelectedId(item.id);
                      setAttachmentLineId("");
                      setUploadError(null);
                    }}
                    className={`w-full rounded-xl border p-3 text-left transition ${selectedId === item.id ? "border-blue-300 bg-blue-50/50" : "border-slate-200 hover:border-slate-300"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-slate-800">
                        {item.title}
                      </span>
                      <div className="flex items-center gap-2">
                        {Boolean(item.attachmentCount) && (
                          <span className="text-[11px] text-slate-400">
                            {item.attachmentCount} 个附件
                          </span>
                        )}
                        <Badge tone="blue">
                          {SOURCE_LABEL[item.source] ?? item.source}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {item.requestingDepartment} · {item.requesterName} ·{" "}
                      {item.currency}
                      {item.targetDeliveryDate
                        ? ` · 交期 ${displayDate(item.targetDeliveryDate)}`
                        : ""}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>需求详情与文件</CardTitle>
            <CardDescription>
              {selectedId ?? "选择一条需求查看物料和附件"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {detailLoading ? (
              <div className="flex items-center py-10 text-sm text-slate-400">
                <Loader2 className="mr-2 size-4 animate-spin" />
                加载详情…
              </div>
            ) : detailError ? (
              <div
                className="rounded-lg bg-red-50 p-3 text-xs text-red-700"
                role="alert"
              >
                {detailError}
              </div>
            ) : selected ? (
              <div className="space-y-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">状态</span>
                  <Badge tone="blue">
                    {STATUS_LABEL[selected.status ?? "submitted"] ??
                      selected.status ??
                      "已提交"}
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">来源</span>
                  <span>
                    {SOURCE_LABEL[selected.source] ?? selected.source}
                  </span>
                </div>
                <div className="border-t border-slate-100 pt-3">
                  <div className="mb-2 text-xs font-semibold text-slate-500">
                    物料行
                  </div>
                  {(selected.lines ?? []).length ? (
                    (selected.lines ?? []).map((line, index) => (
                      <div
                        key={line.id ?? `${line.itemCode}-${index}`}
                        className="mb-2 rounded-lg bg-slate-50 p-2 text-xs"
                      >
                        <div className="font-medium text-slate-800">
                          {line.itemName} · {line.quantity} {line.unit}
                        </div>
                        {line.itemCode && (
                          <div className="mt-1 text-slate-400">
                            {line.itemCode}
                          </div>
                        )}
                        {line.technicalRequirements && (
                          <div className="mt-1 text-slate-500">
                            {line.technicalRequirements}
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-slate-400">暂无物料行</div>
                  )}
                </div>
                <section className="border-t border-slate-100 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-slate-700">
                        需求附件
                      </div>
                      <div className="mt-1 text-[11px] text-slate-400">
                        PDF、DOCX、XLSX、文本与图片；CAD 当前仅记录元数据；单文件最大 8 MB
                      </div>
                    </div>
                    <FileText className="size-4 text-slate-400" />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <select
                      aria-label="附件关联范围"
                      value={attachmentLineId}
                      onChange={(event) =>
                        setAttachmentLineId(event.target.value)
                      }
                      className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-xs"
                    >
                      <option value="">关联整张需求</option>
                      {(selected.lines ?? []).map(
                        (line, index) =>
                          line.id && (
                            <option key={line.id} value={line.id}>
                              关联物料 {index + 1}：{line.itemName}
                            </option>
                          ),
                      )}
                    </select>
                    <input
                      ref={uploadInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      accept=".pdf,.docx,.xlsx,.csv,.txt,.json,.png,.jpg,.jpeg,.gif,.dwg,.dxf,.step,.stp"
                      onChange={(event) => void uploadFiles(event.target.files)}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={uploading}
                      onClick={() => uploadInputRef.current?.click()}
                    >
                      {uploading ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Upload className="size-3.5" />
                      )}
                      {uploading ? "上传中…" : "上传文件"}
                    </Button>
                  </div>
                  {uploadError && (
                    <div
                      className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700"
                      role="alert"
                    >
                      {uploadError}
                    </div>
                  )}
                  <div className="mt-3 space-y-2">
                    {(selected.attachments ?? []).length ? (
                      selected.attachments!.map((attachment) => {
                        const lineIndex = (selected.lines ?? []).findIndex(
                          (line) => line.id === attachment.requisitionLineId,
                        );
                        const { security, processing } = attachmentStatus(attachment);
                        const failure = attachment.scanError ?? attachment.parseError;
                        return (
                          <div
                            key={attachment.id}
                            className="rounded-lg border border-slate-200 p-2.5"
                          >
                            <div className="flex items-start gap-2">
                              <div className="rounded-md bg-slate-50 p-1.5">
                                <FileText className="size-3.5 text-slate-500" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-xs font-medium text-slate-800">
                                  {attachment.fileName}
                                </div>
                                <div className="mt-1 text-[10px] text-slate-400">
                                  v{attachment.version ?? 1} ·{" "}
                                  {formatBytes(attachment.sizeBytes)} ·{" "}
                                  {lineIndex >= 0
                                    ? `物料 ${lineIndex + 1}`
                                    : "整张需求"} ·{" "}
                                  {attachment.storageBackend === "s3" ? "S3 / MinIO" : "本地存储"}
                                </div>
                                <div className="mt-1 truncate font-mono text-[9px] text-slate-300">
                                  SHA-256 {attachment.sha256 ?? "待生成"}
                                </div>
                                {(security || processing) && (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {security && <Badge tone={security.tone}>{security.label}</Badge>}
                                    {processing && <Badge tone={processing.tone}>{processing.label}</Badge>}
                                  </div>
                                )}
                                {attachment.detectedContentType && (
                                  <div className="mt-1 text-[10px] text-slate-400">
                                    已识别类型：{attachment.detectedContentType}
                                  </div>
                                )}
                                {failure && (
                                  <div className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[10px] leading-4 text-red-700">
                                    {failure}
                                    {attachment.processingStatus === "parse_failed" && "；可重试文档解析"}
                                  </div>
                                )}
                                {attachment.parsedAt && processing?.label === "已解析" && (
                                  <div className="mt-1 text-[10px] text-slate-400">
                                    解析完成：{displayDateTime(attachment.parsedAt)}
                                  </div>
                                )}
                                {attachment.extractedTextPreview && (
                                  <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-slate-500">
                                    {attachment.extractedTextPreview}
                                  </div>
                                )}
                                {attachment.parsedSummary && (
                                  <div className="mt-1 line-clamp-3 rounded-md bg-slate-50 px-2 py-1.5 text-[10px] leading-4 text-slate-600">
                                    {attachment.parsedSummary}
                                  </div>
                                )}
                                {attachment.processingStatus === "parse_failed" && attachment.securityStatus !== "quarantined" && (
                                  <button
                                    type="button"
                                    disabled={Boolean(retryingAttachmentId)}
                                    onClick={() => void retryAttachment(attachment.id)}
                                    className="mt-2 text-[10px] font-medium text-blue-700 hover:underline disabled:text-slate-400"
                                  >
                                    {retryingAttachmentId === attachment.id ? "重新入队中…" : "重试文档解析"}
                                  </button>
                                )}
                              </div>
                              {attachment.url && (
                                <a
                                  href={attachment.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-50 hover:text-slate-700"
                                  aria-label={`下载 ${attachment.fileName}`}
                                >
                                  <Download className="size-3.5" />
                                </a>
                              )}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded-lg border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-400">
                        尚未上传需求文件
                      </div>
                    )}
                  </div>
                  <div className="mt-3 rounded-lg bg-amber-50 px-2.5 py-2 text-[10px] leading-4 text-amber-800">
                    RFQ 不会自动外发全部附件；必须在创建询价时逐个勾选。
                  </div>
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <div className="text-xs font-semibold text-slate-700">文件活动</div>
                    <div className="mt-2 space-y-2">
                      {(selected.attachmentEvents ?? []).length ? (
                        selected.attachmentEvents!.slice().reverse().slice(0, 8).map((event) => {
                          const attachment = (selected.attachments ?? []).find((item) => item.id === event.attachmentId);
                          const version = typeof event.detail?.version === "number"
                            ? event.detail.version
                            : typeof event.detail?.attachmentVersion === "number"
                              ? event.detail.attachmentVersion
                              : attachment?.version;
                          return (
                            <div key={event.id ?? `${event.action}-${event.createdAt}`} className="flex gap-2 text-[10px] leading-4">
                              <span className="mt-1 size-1.5 shrink-0 rounded-full bg-blue-500" />
                              <div className="min-w-0 flex-1">
                                <div className="text-slate-700">
                                  {ATTACHMENT_ACTION_LABEL[event.action ?? ""] ?? event.action ?? "文件活动"}
                                  {attachment?.fileName ? ` · ${attachment.fileName}` : ""}
                                  {version ? ` · v${version}` : ""}
                                </div>
                                <div className="text-slate-400">
                                  {event.actorId ?? "系统"} · {displayDateTime(event.createdAt)}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div className="text-[10px] text-slate-400">尚无文件审计记录</div>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            ) : (
              <div className="py-10 text-center text-sm text-slate-400">
                选择列表中的需求查看详情
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
